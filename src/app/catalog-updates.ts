import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { catalogIds, isSupportedCli } from './catalog-types';
import type { CatalogEntry, CatalogId, CatalogInstallation } from './catalog-types';
import { discoverUpdate, executeUpdate, updateTargetSchema, UpdateExecutionError } from './catalog-update-target';
import type { UpdateTarget } from './catalog-update-target';
import { sameUpdateIdentity, updateIdentity, updateIdentitySchema } from './catalog-update-proof';
import { readProcesses } from './observations';
import { parseCliVersion, runProcess } from './catalog-runner';
import { brewVersionEvidence } from './catalog-brew';
import type { AppStore } from './store';
import { AppError } from './types';

export const catalogUpdateSchema=z.object({
  installationId:z.string().nullable().optional(),
  id:z.string().uuid(),requestId:z.string(),catalogId:z.enum(catalogIds),revision:z.number().int().nonnegative(),
  stage:z.enum(['ready','updating','completed','failed','uncertain','archived-unverified']),target:updateTargetSchema,
  checkedVersion:z.string().nullable().default(null),expectedVersion:z.string().nullable().default(null),
  identity:updateIdentitySchema.nullable().default(null),
  executionTarget:updateTargetSchema.nullable().default(null),
  execution:z.enum(['unknown','started','verified','not-started']).default('unknown'),
  executorPid:z.number().int().positive().nullable().default(null),
  reconciliation:z.object({checkedAt:z.number(),version:z.string().nullable(),reason:z.string().nullable(),identity:updateIdentitySchema.nullable(),
    fingerprint:z.string().nullable()}).strict().nullable().default(null),
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
  readonly identity?:typeof updateIdentity;readonly processes?:typeof readProcesses;readonly run?:typeof runProcess;
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
      const entry=options.entries().find(row=>row.id===catalogId);
      const job:CatalogUpdateJob={id:randomUUID(),requestId,catalogId,revision:0,stage:'ready',target,createdAt:now,updatedAt:now,
        checkedVersion:entry?.lastCheck?.latestVersion??null,expectedVersion:null,
        identity:(dependencies.identity??updateIdentity)(target,options.home),
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
      if(!job.identity||JSON.stringify((dependencies.identity??updateIdentity)(target,options.home))!==JSON.stringify(job.identity))
        throw new AppError('source_changed','update_target_changed');
      await options.guard(target);
      if(!permitted())throw new AppError('conflict','policy_changed');
      if(get(id).revision!==revision||get(id).stage!=='ready')throw new AppError('conflict','stale_update_plan');
      const change=(fields:Partial<CatalogUpdateJob>)=>{
        const before=get(id);
        options.store.putCatalogUpdate({...before,...fields,revision:before.revision+1,updatedAt:Date.now()});options.changed();
      };
      change({stage:'updating',paneSessions,executorPid:process.pid});
      running=(async()=>{
        try {
          const installedVersion=await (dependencies.execute??executeUpdate)(target,{...options,catalogId:job.catalogId,
            beforeMutation:()=>change({execution:'started'})});
          const receipt=options.store.installJobs().find(row=>row.catalogId===job.catalogId&&row.stage==='completed'&&row.executablePath===target.executable)??null;
          const executionTarget=await (dependencies.discover??discoverUpdate)({...options,catalogId:job.catalogId,executable:target.executable,receipt});
          if(!executionTarget||updateBinding(executionTarget)!==updateBinding(target))throw new AppError('source_changed','update_target_changed');
          const verifiedVersion=executionTarget.kind==='brew'?brewVersionEvidence(executionTarget).packageVersion:parseCliVersion(installedVersion);
          if(verifiedVersion!==installedVersion)throw new AppError('uncertain','updated_version_unverified');
          // This value comes from the executor's verified result, never a latest lookup.
          change({execution:'verified',expectedVersion:installedVersion,executionTarget,identity:(dependencies.identity??updateIdentity)(executionTarget,options.home)});
          change({stage:'completed',installedVersion,failure:null});
          options.updated?.(get(id));
          for(const receipt of options.store.installJobs())if(receipt.stage==='completed'&&receipt.executablePath===target.executable)
            options.store.putInstallJob({...receipt,installedVersion,updatedAt:Date.now(),revision:receipt.revision+1});
        } catch(error) {
          if(!(error instanceof Error))throw error;
          const rejected=error instanceof UpdateExecutionError&&!error.mutationStarted;
          change({stage:rejected?'failed':'uncertain',...(rejected?{execution:'not-started' as const}:{}),failure:error instanceof AppError?error.detail:'update_failed'});
        } finally {change({executorPid:null});options.installedChanged();}
      })().finally(()=>{running=null;options.changed();});
    } finally {planning=false;}
  }
  async function recover(id:string,revision:number,action:'reconcile'|'archive-unverified'):Promise<void> {
    if(busy())throw new AppError('busy','update_in_progress');
    const job=get(id);
    if(!isSupportedCli(job.catalogId))throw new AppError('unsupported','cli_not_supported');
    if(job.stage!=='uncertain'||job.revision!==revision)throw new AppError('conflict','stale_update_plan');
    planning=true;
    const guard=async()=>{
      const current=get(id);
      if(current.revision!==revision||JSON.stringify(current)!==JSON.stringify(job))throw new AppError('conflict','stale_update_plan');
      if(options.store.catalogUpdates().some(row=>row.stage==='updating'))throw new AppError('busy','update_in_progress');
      if(options.store.installJobs().some(row=>['installing','verifying','uncertain'].includes(row.stage)))throw new AppError('busy','install_in_progress');
      if(options.store.removalJobs().some(row=>row.stage==='removing'||row.catalogId===job.catalogId&&row.stage==='uncertain'))throw new AppError('busy','removal_in_progress');
      await options.guard(job.target);
      let processes:ReturnType<typeof readProcesses>;
      try{processes=(dependencies.processes??readProcesses)();}
      catch(error){if(!(error instanceof Error))throw error;throw new AppError('unavailable','process_observation_unavailable');}
      if(processes.some(row=>row.pid===job.executorPid||row.command.includes(job.target.target)
        ||/^(?:\S*\/)?(?:npm|bun|brew)\s+(?:install|add|upgrade)\b|^(?:\S*\/)?node\s+\S*\/npm-cli\.js\s+(?:install|add|upgrade)\b|^(?:\S*\/)?(?:ba)?sh\s+\S*\/install\.sh\b/.test(row.command)))
        throw new AppError('busy','recovery_executor_active');
      if(JSON.stringify(get(id))!==JSON.stringify(job))throw new AppError('conflict','stale_update_plan');
    };
    let observed:string|null=null;
    try {
      await guard();
      const receipt=options.store.installJobs().find(row=>row.catalogId===job.catalogId&&row.stage==='completed'&&row.executablePath===job.target.executable)??null;
      const discover=()=> (dependencies.discover??discoverUpdate)({...options,catalogId:job.catalogId,executable:job.target.executable,receipt});
      const before=(dependencies.identity??updateIdentity)(job.target,options.home);
      const recorded=job.identity??job.reconciliation?.identity;
      if(recorded&&!sameUpdateIdentity(recorded,before))throw new AppError('source_changed','recovery_target_changed');
      if(action==='archive-unverified'&&(!job.reconciliation?.identity||JSON.stringify(job.reconciliation.identity)!==JSON.stringify(before)))
        throw new AppError('conflict','reconcile_before_archive');
      const target=await discover();
      if(!target||updateBinding(target)!==updateBinding(job.target))throw new AppError('source_changed','recovery_source_changed');
      if(job.executionTarget&&JSON.stringify(updateTargetSchema.parse(target))!==JSON.stringify(job.executionTarget))
        throw new AppError('source_changed','recovery_execution_source_changed');
      if(!recorded&&target.fingerprint!==job.target.fingerprint)throw new AppError('source_changed','recovery_target_changed');
      if(action==='archive-unverified'&&target.fingerprint!==job.reconciliation?.fingerprint)
        throw new AppError('source_changed','recovery_source_changed');
      await guard();
      if(JSON.stringify(before)!==JSON.stringify((dependencies.identity??updateIdentity)(job.target,options.home)))
        throw new AppError('source_changed','recovery_target_changed');
      const output=await (dependencies.run??runProcess)(before.canonical,['--version'],{
        HOME:options.home,PATH:options.path,CI:'1',NO_COLOR:'1',MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0',DISABLE_AUTOUPDATER:'1',OPENCODE_DISABLE_AUTOUPDATE:'1',
      },options.home,15_000);
      observed=parseCliVersion(output);
      if(!observed)throw new AppError('unavailable','installed_version_unverified');
      const fresh=await discover();
      await guard();
      const after=(dependencies.identity??updateIdentity)(job.target,options.home);
      if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(target)!==JSON.stringify(fresh))
        throw new AppError('source_changed','recovery_target_changed');
      const brew=target.kind==='brew'?brewVersionEvidence(target):null;
      const expected=job.expectedVersion??null;
      const proven=job.execution==='verified'&&job.executionTarget!=null&&expected!==null
        &&(brew?brew.packageVersion===expected&&observed===brew.releaseVersion:observed===expected)
        &&JSON.stringify(job.identity)===JSON.stringify(after);
      const reason=proven?null:!job.identity?'recovery_identity_missing':!job.executionTarget?'execution_source_unverified':job.expectedVersion==null?'expected_version_unverified':'executed_version_unverified';
      options.store.putCatalogUpdate({...job,revision:revision+1,updatedAt:Date.now(),
        stage:action==='archive-unverified'?'archived-unverified':proven?'completed':'uncertain',
        installedVersion:proven&&action==='reconcile'?expected:null,failure:action==='archive-unverified'?'update_archived_unverified':reason,
        reconciliation:{checkedAt:Date.now(),version:observed,reason,identity:after,fingerprint:target.fingerprint}});
    } catch(error) {
      if(!(error instanceof Error))throw error;
      const reason=error instanceof AppError?error.detail:'code' in error&&['ENOENT','ENOTDIR'].includes(String(error.code))
        ?'recovery_target_missing':'recovery_verification_failed';
      if(get(id).revision===revision)options.store.putCatalogUpdate({...job,revision:revision+1,updatedAt:Date.now(),
        failure:reason,reconciliation:{checkedAt:Date.now(),version:observed,reason,identity:null,fingerprint:null}});
      if(action==='archive-unverified'||error instanceof AppError&&['busy','conflict'].includes(error.code))throw error;
    } finally {planning=false;options.changed();}
  }
  return {plan,confirm,recover,targetFor,busy,settled:async()=>{await running;}};
}
