import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { catalogIds, isSupportedCli } from './catalog-types';
import type { CatalogCheck, CatalogEntry, CatalogId } from './catalog-types';
import type { createCatalogUpdates } from './catalog-updates';
import type { AppStore } from './store';
import { AppError } from './types';

export const catalogBulkSchema=z.object({
  id:z.string().uuid(),revision:z.number().int().nonnegative(),
  stage:z.enum(['checking','planning','ready','updating','completed']),
  items:z.array(z.object({catalogId:z.enum(catalogIds),name:z.string(),beforeVersion:z.string().nullable(),latestVersion:z.string().nullable(),
    status:z.enum(['checking','available','current','ahead','unknown','unsupported','failed','ready','updating','completed','skipped','uncertain']),
    reason:z.string().nullable(),jobId:z.string().nullable(),jobRevision:z.number().int().nonnegative().nullable(),
  }).strict()).max(catalogIds.length),
}).strict();
export type CatalogBulk=z.infer<typeof catalogBulkSchema>;
type Options={readonly store:AppStore;readonly entries:()=>readonly CatalogEntry[];readonly settled:()=>Promise<void>;
  readonly check:(id:CatalogId)=>Promise<CatalogCheck>;readonly updates:ReturnType<typeof createCatalogUpdates>;
  readonly changed:()=>void;readonly guard:()=>void;readonly updated:(catalogId:CatalogId,version:string)=>void;};

/** One durable, revision-bound batch; service restart never resumes a mutation. */
export function createCatalogBulk(options:Options){
  let current=options.store.catalogBulk();
  let running=false;
  if(current&&['checking','planning','updating'].includes(current.stage)){
    current={...current,revision:current.revision+1,stage:'completed',items:current.items.map(item=>{
      if(!['checking','ready','updating'].includes(item.status))return item;
      const job=options.store.catalogUpdates().find(job=>job.id===item.jobId);
      return {...item,status:job?.stage==='completed'?'completed':item.status==='updating'?'uncertain':'skipped',reason:'service_restarted'};
    })};
    options.store.putCatalogBulk(current);
  }
  function save(next:CatalogBulk):void{current=next;options.store.putCatalogBulk(next);options.changed();}
  function changeItem(id:CatalogId,fields:Partial<CatalogBulk['items'][number]>):void{
    if(!current)throw new AppError('not_found','bulk_missing');
    save({...current,revision:current.revision+1,items:current.items.map(item=>item.catalogId===id?{...item,...fields}:item)});
  }
  function stage(value:CatalogBulk['stage']):void{
    if(!current)throw new AppError('not_found','bulk_missing');
    save({...current,revision:current.revision+1,stage:value});
  }
  function plan(update:boolean):Promise<void>{
    if(running)throw new AppError('busy','bulk_in_progress');
    options.guard();running=true;
    return (async()=>{
    try{
      await options.settled();
      const entries=options.entries().filter(entry=>isSupportedCli(entry.id)&&entry.installed);
      save({id:randomUUID(),revision:0,stage:update?'planning':'checking',items:entries.map(entry=>({
        catalogId:entry.id,name:entry.name,beforeVersion:entry.installed?.version??null,latestVersion:null,
        status:'checking',reason:null,jobId:null,jobRevision:null,
      }))});
      for(const entry of entries){
        try{
          const check=await options.check(entry.id);
          if(check.status==='checking')throw new AppError('busy','check_in_progress');
          changeItem(entry.id,{status:check.status,latestVersion:check.latestVersion,reason:check.failure});
          if(update&&check.status==='available'){
            const job=await options.updates.plan(entry.id,`bulk:${current?.id}`);
            const selected=options.entries().find(row=>row.id===entry.id);
            if(!selected||job.beforeVersion!==entry.installed?.version||selected.selectedInstallationId!==entry.selectedInstallationId
              ||selected.installed?.path!==entry.installed?.path)throw new AppError('source_changed','installation_selection_changed');
            changeItem(entry.id,{status:'ready',beforeVersion:job.beforeVersion,jobId:job.id,jobRevision:job.revision});
          }
        }catch(error){
          if(!(error instanceof Error))throw error;
          changeItem(entry.id,{status:'failed',reason:error instanceof AppError?error.detail:'bulk_check_failed'});
        }
      }
      stage(update?'ready':'completed');
    }finally{running=false;options.changed();}
    })();
  }
  function confirm(id:string,revision:number):Promise<void>{
    if(running)throw new AppError('busy','bulk_in_progress');
    if(!current||current.id!==id||current.revision!==revision||current.stage!=='ready')throw new AppError('conflict','stale_bulk_plan');
    options.guard();
    const items=current.items.filter(item=>item.status==='ready');
    if(!items.length)throw new AppError('conflict','bulk_no_updates');
    // Check every approval before the first write, including selected-installation identity.
    for(const item of items){
      if(!isSupportedCli(item.catalogId))throw new AppError('unsupported','cli_not_supported');
      const job=options.store.catalogUpdates().find(job=>job.id===item.jobId);
      const entry=options.entries().find(entry=>entry.id===item.catalogId);
      if(!job||job.stage!=='ready'||job.revision!==item.jobRevision||!entry
        ||(entry.selectedInstallationId??null)!==(job.installationId??null)
        ||entry.installed?.version!==item.beforeVersion||entry.installed.path!==job.target.executable)
        throw new AppError('conflict','stale_bulk_plan');
    }
    running=true;stage('updating');
    return (async()=>{
    try{
      for(const item of items){
        try{
          if(item.jobId===null||item.jobRevision===null)throw new AppError('conflict','stale_bulk_plan');
          const permitted=()=>{
            const selected=options.entries().find(entry=>entry.id===item.catalogId);
            const planned=options.store.catalogUpdates().find(job=>job.id===item.jobId);
            return !!planned&&!!selected&&(selected.selectedInstallationId??null)===(planned.installationId??null)
              &&selected.installed?.version===item.beforeVersion&&selected.installed.path===planned.target.executable;
          };
          if(!permitted())throw new AppError('source_changed','installation_selection_changed');
          changeItem(item.catalogId,{status:'updating'});
          await options.updates.confirm(item.jobId,item.jobRevision,permitted,'keep');
          await options.updates.settled();
          const job=options.store.catalogUpdates().find(job=>job.id===item.jobId);
          if(!job||!['completed','failed','uncertain'].includes(job.stage))throw new AppError('uncertain','bulk_result_missing');
          changeItem(item.catalogId,{status:job.stage==='completed'?'completed':job.stage==='uncertain'?'uncertain':'failed',reason:job.failure});
          if(job.stage==='completed'&&job.installedVersion)options.updated(item.catalogId,job.installedVersion);
        }catch(error){
          if(!(error instanceof Error))throw error;
          changeItem(item.catalogId,{status:'failed',reason:error instanceof AppError?error.detail:'bulk_update_failed'});
        }
        await options.settled();
      }
      stage('completed');
    }finally{running=false;options.changed();}
    })();
  }
  return {plan,confirm,busy:()=>running,snapshot:()=>current};
}
