import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { catalogIds, isSupportedCli } from './catalog-types';
import type { CatalogEntry, CatalogId, CatalogInstallation } from './catalog-types';
import { discoverUpdate, executeUpdate, updateTargetSchema } from './catalog-update-target';
import type { UpdateTarget } from './catalog-update-target';
import type { AppStore } from './store';
import { AppError } from './types';

export const catalogUpdateSchema=z.object({
  installationId:z.string().nullable().optional(),
  id:z.string().uuid(),requestId:z.string(),catalogId:z.enum(catalogIds),revision:z.number().int().nonnegative(),
  stage:z.enum(['ready','updating','completed','failed','uncertain']),target:updateTargetSchema,
  createdAt:z.number(),updatedAt:z.number(),beforeVersion:z.string().nullable(),installedVersion:z.string().nullable(),failure:z.string().nullable(),
  paneSessions:z.enum(['keep','restart-idle','restart-all']).default('keep'),
  paneResults:z.array(z.object({sessionId:z.string(),paneId:z.string(),
    outcome:z.enum(['pending','completed','failed','skipped-working','skipped-blocked']),
    failure:z.string().nullable(),previousPid:z.number().int(),resumedPid:z.number().int().nullable()}).strict()).default([]),
}).strict();
export type CatalogUpdateJob=z.input<typeof catalogUpdateSchema>&{readonly paneSessions?:'keep'|'restart-idle'|'restart-all'|undefined;readonly paneResults?:readonly z.infer<typeof catalogUpdateSchema>['paneResults'][number][]|undefined};
export function updateBinding(target:UpdateTarget):string {
  if(target.kind==='official')return JSON.stringify([target.kind,target.target,target.executable,target.sourceUrl]);
  if(target.kind==='brew')return JSON.stringify([target.kind,target.target,target.executable,target.manager,target.packageName,target.packageKind]);
  return JSON.stringify(target.kind==='owned'
    ?[target.kind,target.target,target.executable]
    :[target.kind,target.target,target.executable,target.manager,target.packageName]);
}
type Options={
  readonly directory:string;readonly home:string;readonly path:string;readonly store:AppStore;
  readonly entries:()=>readonly CatalogEntry[];readonly changed:()=>void;readonly installedChanged:()=>void;
  readonly guard:(target:UpdateTarget)=>void|Promise<void>;
  readonly updated?:(job:CatalogUpdateJob)=>void;
};
export function createCatalogUpdates(options:Options,dependencies:{
  readonly discover?:typeof discoverUpdate;readonly execute?:typeof executeUpdate;
}={}) {
  let planning=false;
  let running:Promise<void>|null=null;
  for(const job of options.store.catalogUpdates())if(job.stage==='updating')
    options.store.putCatalogUpdate({...job,stage:'uncertain',revision:job.revision+1,failure:'service_restarted',updatedAt:Date.now()});
  const busy=()=>planning||running!==null;
  const get=(id:string)=>{const job=options.store.catalogUpdates().find(row=>row.id===id);if(!job)throw new AppError('not_found');return job;};
  function available(id:CatalogId) {
    if(!isSupportedCli(id))throw new AppError('unsupported','cli_not_supported');
    if(busy())throw new AppError('busy','update_in_progress');
    if(options.store.catalogUpdates().some(row=>row.catalogId===id&&row.stage==='uncertain'))
      throw new AppError('uncertain','inspect_interrupted_update');
    if(options.store.installJobs().some(row=>['installing','verifying','uncertain'].includes(row.stage)))
      throw new AppError('busy','install_in_progress');
    if(options.store.removalJobs().some(row=>row.stage==='removing'||(row.catalogId===id&&row.stage==='uncertain')))
      throw new AppError('busy','removal_in_progress');
  }
  async function targetFor(catalogId:CatalogId,installation?:CatalogInstallation) {
    if(!isSupportedCli(catalogId))throw new AppError('unsupported','cli_not_supported');
    const entry=options.entries().find(row=>row.id===catalogId);
    if(entry?.inventoryStatus==='checking')throw new AppError('busy','inventory_in_progress');
    if(entry?.inventoryStatus==='failed')throw new AppError('unavailable','inventory_unavailable');
    const executable=installation?.path??entry?.installed?.path;
    if(!executable)throw new AppError('not_found','installation_missing');
    if(installation?.catalogId&&installation.catalogId!==catalogId)throw new AppError('invalid_request');
    const receipt=options.store.installJobs().find(row=>row.catalogId===catalogId&&row.stage==='completed'&&row.executablePath===executable)??null;
    const target=await (dependencies.discover??discoverUpdate)({...options,catalogId,executable,receipt});
    if(!target)throw new AppError('unsupported','manual_update_required');
    return target;
  }
  async function plan(catalogId:CatalogId,requestId:string):Promise<CatalogUpdateJob> {
    available(catalogId);planning=true;
    try {
      const target=await targetFor(catalogId);await options.guard(target);
      const now=Date.now();
      const job:CatalogUpdateJob={id:randomUUID(),requestId,catalogId,revision:0,stage:'ready',target,createdAt:now,updatedAt:now,
        installationId:options.entries().find(row=>row.id===catalogId)?.selectedInstallationId??null,
        beforeVersion:options.entries().find(row=>row.id===catalogId)?.installed?.version??null,installedVersion:null,failure:null};
      options.store.putCatalogUpdate(job);options.changed();return job;
    } finally {planning=false;}
  }
  async function confirm(id:string,revision:number,permitted:()=>boolean=()=>true,paneSessions:CatalogUpdateJob['paneSessions']='keep'):Promise<void> {
    const job=get(id);available(job.catalogId);
    if(job.stage!=='ready'||job.revision!==revision)throw new AppError('conflict','stale_update_plan');
    planning=true;
    try {
      const target=await targetFor(job.catalogId);
      if(JSON.stringify(updateTargetSchema.parse(target))!==JSON.stringify(job.target))throw new AppError('source_changed','update_target_changed');
      await options.guard(target);
      if(!permitted())throw new AppError('conflict','policy_changed');
      const change=(fields:Partial<CatalogUpdateJob>)=>{
        const before=get(id);
        options.store.putCatalogUpdate({...before,...fields,revision:before.revision+1,updatedAt:Date.now()});options.changed();
      };
      change({stage:'updating',paneSessions});
      running=(async()=>{
        try {
          const installedVersion=await (dependencies.execute??executeUpdate)(target,{...options,catalogId:job.catalogId});
          change({stage:'completed',installedVersion,failure:null});
          options.updated?.(get(id));
          for(const receipt of options.store.installJobs())if(receipt.stage==='completed'&&receipt.executablePath===target.executable)
            options.store.putInstallJob({...receipt,installedVersion,updatedAt:Date.now(),revision:receipt.revision+1});
        } catch(error) {
          if(!(error instanceof Error))throw error;
          change({stage:'uncertain',failure:error instanceof AppError?error.detail:'update_failed'});
        } finally {options.installedChanged();}
      })().finally(()=>{running=null;options.changed();});
    } finally {planning=false;}
  }
  return {plan,confirm,targetFor,busy,settled:async()=>{await running;}};
}
