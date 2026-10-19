import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { catalogDefinitions } from './catalog-registry';
import { catalogIds, isSupportedCli } from './catalog-types';
import { discoverRemoval, executeRemoval, removalTargetSchema, validateRemoval } from './catalog-removal-target';
import type { RemovalTarget } from './catalog-removal-target';
import type { CatalogEntry, CatalogId } from './catalog-types';
import type { AppStore } from './store';
import { AppError } from './types';
import { installationReferences } from './installation-references';
import { discoverStandaloneRemoval, executeStandaloneRemoval, standaloneRemovalSchema, validateStandaloneRemoval } from './catalog-standalone-removal';
import type { StandaloneRemovalTarget } from './catalog-standalone-removal';
export type CatalogRemovalTarget=RemovalTarget|StandaloneRemovalTarget;
const targetSchema=z.union([removalTargetSchema,standaloneRemovalSchema]);

export const removalJobSchema = z.object({
  installationId:z.string().nullable().optional(),
  id:z.string().uuid(),requestId:z.string(),catalogId:z.enum(catalogIds),revision:z.number().int().nonnegative(),
  stage:z.enum(['ready','removing','completed','failed','uncertain']),target:targetSchema,
  createdAt:z.number(),updatedAt:z.number(),failure:z.string().nullable(),
  references:z.array(z.string()).readonly().optional(),
}).strict();
export type RemovalJob = z.infer<typeof removalJobSchema>;
type Options = {
  readonly directory:string;readonly home:string;readonly path:string;readonly store:AppStore;
  readonly entries:()=>readonly CatalogEntry[];readonly changed:()=>void;
  readonly guard:(target:CatalogRemovalTarget)=>void|Promise<void>;readonly installedChanged:()=>void;
};
export function createRemoval(options:Options, dependencies:{readonly discover?:typeof discoverRemoval;readonly execute?:typeof executeRemoval;readonly validate?:typeof validateRemoval}={}) {
  let running:Promise<void>|null=null;
  let planning=false;
  const discover=dependencies.discover??discoverRemoval;
  for(const job of options.store.removalJobs())if(job.stage==='removing')
    options.store.putRemovalJob({...job,revision:job.revision+1,stage:'uncertain',failure:'service_restarted',updatedAt:Date.now()});
  const busy=()=>planning||running!==null;
  const get=(id:string)=>{const job=options.store.removalJobs().find(row=>row.id===id);if(!job)throw new AppError('not_found');return job;};
  function assertAvailable(id:string){
    if(!isSupportedCli(id))throw new AppError('unsupported','cli_not_supported');
    if(busy())throw new AppError('busy','removal_in_progress');
    if(options.store.removalJobs().some(row=>row.catalogId===id&&row.stage==='uncertain'))throw new AppError('uncertain','inspect_interrupted_removal');
    if(options.store.installJobs().some(row=>['installing','verifying','uncertain'].includes(row.stage)))throw new AppError('busy','install_in_progress');
  }
  async function targetFor(catalogId:CatalogId,installationId?:string|null){
    const entry=options.entries().find(row=>row.id===catalogId);
    if(entry?.inventoryStatus==='checking')throw new AppError('busy','inventory_in_progress');
    if(entry?.inventoryStatus==='failed')throw new AppError('unavailable','inventory_unavailable');
    const installed=installationId?entry?.installations?.find(row=>row.id===installationId):entry?.installed;
    if(!installed)throw new AppError('not_found','installation_missing');
    if(installationId&&entry?.selectedInstallationId===installationId)throw new AppError('conflict','cannot_remove_selected_installation');
    // The copy that `name` resolves to today may go only when the kept installation is itself
    // on PATH, so the command keeps working from a new terminal without editing shell files.
    const kept=entry?.installations?.find(row=>row.id===entry.selectedInstallationId);
    const fallbackOnPath=!!kept&&kept.id!==installationId&&kept.onPath===true;
    if(installationId&&(entry?.configuredDefaultInstallationId===installationId
      ||(!entry?.configuredDefaultInstallationId&&entry?.installations?.find(row=>row.id===installationId)?.isDefault&&!fallbackOnPath)))
      throw new AppError('conflict','cannot_remove_default_installation');
    const receipt=options.store.installJobs().find(row=>row.catalogId===catalogId&&row.stage==='completed'&&row.executablePath===installed.path)??null;
    let refusal='removal_source_unverified';
    const target=await discover({...options,catalogId,executable:installed.path,receipt,refusal:reason=>{refusal=reason;}});
    if(target)return target;
    if(refusal==='removal_dependency_installation')throw new AppError('unsupported',refusal);
    const standalone=receipt?null:discoverStandaloneRemoval({catalogId,executable:installed.path,home:options.home});
    if(standalone)return standalone;
    throw new AppError('unsupported',refusal);
  }
  async function plan(catalogId:CatalogId,requestId:string,installationId?:string){
    assertAvailable(catalogId);planning=true;
    try{
      const target=await targetFor(catalogId,installationId);await options.guard(target);
      const now=Date.now();
      const references=installationReferences(options.home,target);
      options.store.putRemovalJob({id:randomUUID(),requestId,catalogId,installationId:installationId??null,revision:0,stage:'ready',target,createdAt:now,updatedAt:now,failure:null,references});
      options.changed();
    }finally{planning=false;}
  }
  async function confirm(id:string,revision:number){
    const job=get(id);assertAvailable(job.catalogId);
    if(job.revision!==revision||job.stage!=='ready')throw new AppError('conflict','stale_removal_plan');
    const definition=catalogDefinitions.find(row=>row.id===job.catalogId);
    if(!definition)throw new AppError('invalid_request');
    planning=true;
    try{
      const current=await targetFor(definition.id,job.installationId);
      if(JSON.stringify(targetSchema.parse(current))!==JSON.stringify(job.target))throw new AppError('source_changed','removal_target_changed');
      await options.guard(current);
      if(current.kind==='standalone')validateStandaloneRemoval(current);else (dependencies.validate??validateRemoval)(current);
      if(installationReferences(options.home,current).length)throw new AppError('conflict','installation_referenced');
      const change=(stage:RemovalJob['stage'],failure:string|null)=>{
        const before=get(id);options.store.putRemovalJob({...before,revision:before.revision+1,stage,failure,updatedAt:Date.now()});options.changed();
      };
      change('removing',null);
      running=(async()=>{
        try{
          if(current.kind==='standalone')executeStandaloneRemoval(current,options.home);else await (dependencies.execute??executeRemoval)(current,options);
          if(existsSync(current.executable))throw new AppError('uncertain','removal_unverified');
          change('completed',null);options.installedChanged();
        }catch(error){
          if(!(error instanceof Error))throw error;
          change('uncertain',error instanceof AppError?error.detail:'removal_failed');
        }
      })().finally(()=>{running=null;options.changed();});
    }finally{planning=false;}
  }
  return {plan,confirm,busy,settled:async()=>{await running;}};
}
