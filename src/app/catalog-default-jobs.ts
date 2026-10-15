import { z } from 'zod';
import { catalogIds, isSupportedCli } from './catalog-types';
import type { CatalogId, CatalogInstallation } from './catalog-types';
import { defaultSwitchPlanSchema, planDefaultSwitch, applyDefaultSwitch } from './catalog-default';
import type { AppStore } from './store';
import { AppError } from './types';

export const catalogDefaultJobSchema=z.object({
  id:z.string().uuid(),requestId:z.string(),catalogId:z.enum(catalogIds),installationId:z.string(),
  revision:z.number().int().nonnegative(),stage:z.enum(['ready','applying','completed','failed','uncertain']),
  plan:defaultSwitchPlanSchema,result:z.object({version:z.string(),launcher:z.string(),profile:z.string(),backup:z.string().nullable()}).nullable(),
  createdAt:z.number(),updatedAt:z.number(),failure:z.string().nullable(),
}).strict();
export type CatalogDefaultJob=z.infer<typeof catalogDefaultJobSchema>;
type Options={
  readonly directory:string;readonly home:string;readonly path:string;readonly shell:string;readonly store:AppStore;
  readonly resolve:(catalogId:CatalogId,installationId:string)=>Promise<CatalogInstallation>;
  readonly guard:(catalogId:CatalogId,installationId:string)=>void|Promise<void>;
  readonly changed:()=>void;readonly installedChanged:()=>void;
};
export function createDefaultJobs(options:Options,dependencies:{readonly plan?:typeof planDefaultSwitch;readonly apply?:typeof applyDefaultSwitch}={}){
  let planning=false,running:Promise<void>|null=null;
  for(const job of options.store.defaultJobs())if(job.stage==='applying')
    options.store.putDefaultJob({...job,stage:'uncertain',revision:job.revision+1,failure:'service_restarted',updatedAt:Date.now()});
  const busy=()=>planning||running!==null;
  const get=(id:string)=>{const job=options.store.defaultJobs().find(row=>row.id===id);if(!job)throw new AppError('not_found');return job;};
  function available(catalogId:CatalogId){
    if(!isSupportedCli(catalogId))throw new AppError('unsupported','cli_not_supported');
    if(busy())throw new AppError('busy','default_switch_in_progress');
    if(options.store.defaultJobs().some(row=>row.catalogId===catalogId&&row.stage==='uncertain'))
      throw new AppError('uncertain','inspect_default_switch');
  }
  async function plan(catalogId:CatalogId,installationId:string,requestId:string){
    available(catalogId);planning=true;
    try{
      const installation=await options.resolve(catalogId,installationId);
      await options.guard(catalogId,installationId);
      if(installation.isDefault)throw new AppError('conflict','already_default_installation');
      const plan=(dependencies.plan??planDefaultSwitch)({...options,installation});
      const now=Date.now();
      options.store.putDefaultJob({id:plan.id,requestId,catalogId,installationId,revision:0,stage:'ready',plan,result:null,createdAt:now,updatedAt:now,failure:null});
      options.changed();
    }finally{planning=false;}
  }
  async function confirm(id:string,revision:number){
    const job=get(id);available(job.catalogId);
    if(job.stage!=='ready'||job.revision!==revision)throw new AppError('conflict','stale_default_plan');
    planning=true;
    try{
      const selected=await options.resolve(job.catalogId,job.installationId);
      if(selected.path!==job.plan.executable||selected.identityPath!==job.plan.identityPath)
        throw new AppError('source_changed','default_switch_plan_stale');
      await options.guard(job.catalogId,job.installationId);
      const change=(fields:Partial<CatalogDefaultJob>)=>{
        const before=get(id);
        options.store.putDefaultJob({...before,...fields,revision:before.revision+1,updatedAt:Date.now()});options.changed();
      };
      change({stage:'applying'});
      running=(async()=>{
        try{
          const result=await (dependencies.apply??applyDefaultSwitch)(job.plan,{home:options.home,path:options.path,
            guard:()=>options.guard(job.catalogId,job.installationId)});
          change({stage:'completed',result,failure:null});
        }catch(error){
          if(!(error instanceof Error))throw error;
          change({stage:error instanceof AppError&&error.code!=='uncertain'?'failed':'uncertain',
            failure:error instanceof AppError?error.detail:'default_switch_failed'});
        }finally{options.installedChanged();}
      })().finally(()=>{running=null;options.changed();});
    }finally{planning=false;}
  }
  return {plan,confirm,busy,settled:async()=>{await running;}};
}
