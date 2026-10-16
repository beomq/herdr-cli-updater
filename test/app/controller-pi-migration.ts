import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../../src/app/controller';
import type { createEngine } from '../../src/app/engine';
import type { createCatalog } from '../../src/app/catalog';
import { createCatalog as realCatalog } from '../../src/app/catalog';
import { AppStore } from '../../src/app/store';
import { AppError } from '../../src/app/types';
import type { UpdatePolicy } from '../../src/app/types';
import { createCatalogUpdates, updateBinding } from '../../src/app/catalog-updates';
import type { RemovalTarget } from '../../src/app/catalog-removal-target';

export async function migrationScenario(kind:'npm'|'bun'|'owned', mode:UpdatePolicy['mode']='update', present=true) {
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'migration-')));
  const unexpected=async():Promise<never>=>{throw new Error('unexpected_operating_call');};
  const target:RemovalTarget=kind==='owned'
    ?{kind,target:join(directory,'old'),executable:join(directory,'old/bin/pi'),fingerprint:'0'.repeat(64),preserve:[]}
    :{kind,target:join(directory,'old'),executable:join(directory,'old/bin/pi'),manager:join(directory,'npm'),packageName:'@code-yeongyu/senpi',fingerprint:'0'.repeat(64),preserve:[]};
  const initial:UpdatePolicy={installationId:'catalog:pi',mode,intervalMinutes:15,firstCheck:'after-interval',
    nextCheckAt:1000,lastCheckedAt:500,waitingReason:null,paneSessions:'restart-all',lastInstalledVersion:'2026.10.1-3',catalogBinding:updateBinding(target)};
  const store=new AppStore(directory);
  const id=randomUUID();
  store.putPolicy(initial);
  const recipeHash=createHash('sha256').update(JSON.stringify({kind:'npm',package:'@code-yeongyu/senpi',bin:'bin/pi'})).digest('hex');
  store.putInstallJob({id,requestId:'old-install',catalogId:'pi',revision:0,stage:'completed',sourceUrl:'https://www.npmjs.com/package/@code-yeongyu/senpi',
    method:'npm',target:target.target,recipeHash,createdAt:1,updatedAt:2,installedVersion:'2026.10.1-3',executablePath:target.executable,failure:null,log:[]});
  const readyId=randomUUID();
  const receipt=store.installJobs()[0];
  assert(receipt);
  store.putInstallJob({...receipt,id:readyId,requestId:'old-ready',stage:'ready',executablePath:null});
  const updateId=randomUUID(),removalId=randomUUID();
  store.putCatalogUpdate({id:updateId,requestId:'old-update',catalogId:'pi',revision:0,stage:'ready',target,
    createdAt:1,updatedAt:2,beforeVersion:'2026.10.1-3',installedVersion:null,failure:null});
  store.putRemovalJob({id:removalId,requestId:'old-removal',catalogId:'pi',revision:0,stage:'ready',target,
    createdAt:1,updatedAt:2,failure:null});
  const history=JSON.stringify([store.installJobs(),store.catalogUpdates(),store.removalJobs()]);
  let now=1000,sequence=0;
  const timers=new Map<number,{at:number;callback:()=>void}>();
  const engine:typeof createEngine=()=>({directory,connect:async()=>{},close:async()=>{},installations:async()=>[],jobs:async()=>[],
    targets:unexpected,check:unexpected,prepare:unexpected,activate:unexpected,update:unexpected});
  const catalog:typeof createCatalog=options=>{
    // Real catalog guards, but discovery never launches an installed CLI.
    const catalog=realCatalog(options,{discover:async()=>present?[{id:'upstream',catalogId:'pi',manager:'npm',root:join(directory,'new'),
      packageName:'@earendil-works/pi-coding-agent',path:join(directory,'new/bin/pi'),identityPath:join(directory,'new/bin/pi'),
      isDefault:true,receiptId:null,version:'1.2.0'}]:[],execute:unexpected,verify:unexpected,processes:()=>[]});
    return {...catalog,entries:()=>catalog.entries().map(entry=>entry.id==='pi'&&present
      ?{...entry,installed:{path:join(directory,'new/bin/pi'),version:'1.2.0',managed:false}}:entry)};
  };
  const nativeState={selections:[],jobs:[],failure:null};
  let controller:Awaited<ReturnType<typeof createController>>|undefined;
  try {
    controller=await createController({directory,home:directory,path:'',prefixes:[],clock:{now:()=>now,
      schedule:(at,callback)=>{const id=++sequence;timers.set(id,{at,callback});return()=>{timers.delete(id);};}}},
    {engine,catalog,observe:()=>[],herdr:null,latest:unexpected,native:()=>({snapshot:()=>nativeState,refresh:async()=>nativeState,restart:unexpected}),
      updates:options=>createCatalogUpdates(options,{
        discover:async()=>({kind:'npm',target:join(directory,'new'),executable:join(directory,'new/bin/pi'),
          manager:join(directory,'npm'),packageName:'@earendil-works/pi-coding-agent',fingerprint:'1'.repeat(64),preserve:[]}),execute:unexpected,
      })});
    const policy=controller.snapshot().policies[0];
    assert.deepEqual(policy,{...initial,nextCheckAt:mode==='off'?initial.nextCheckAt:null,waitingReason:mode==='off'?null:'pi_source_changed_senpi'});
    now+=3_600_000;
    for(const timer of [...timers.values()])if(timer.at<=now)timer.callback();
    await controller.settled();
    assert.deepEqual(controller.snapshot().policies[0],policy);
    if(present&&mode!=='off')await assert.rejects(controller.command({requestId:randomUUID(),command:{
      kind:'catalog-select',catalogId:'pi',installationId:'upstream',
    }}),{detail:'pi_source_changed_senpi'});
    const failures:string[]=[];
    for(const command of [
      {kind:'install-confirm',jobId:readyId,revision:0},
      {kind:'catalog-update-confirm',jobId:updateId,revision:0},
      {kind:'remove-confirm',jobId:removalId,revision:0},
    ] as const){
      await assert.rejects(controller.command({requestId:randomUUID(),command}),error=>{
        assert(error instanceof AppError);failures.push(error.detail);return true;
      });
    }
    assert.equal(JSON.stringify([store.installJobs(),store.catalogUpdates(),store.removalJobs()]),history);
    assert.equal(controller.snapshot().operations.length,0);
    assert.equal(controller.snapshot().paneRestarts?.length,0);
    assert(failures.includes(present?'update_target_changed':'installation_missing'));
    // Restarting the service must not reinterpret the paused binding either.
    await controller.close();controller=undefined;
    assert.deepEqual(store.policies()[0],policy);
    return {kind,mode,present,pausedReason:policy?.waitingReason,failures,historyPreserved:true,noMutation:true};
  } finally {
    await controller?.close();store.close();rmSync(directory,{recursive:true});
    assert.equal(existsSync(directory),false);
  }
}
if(import.meta.main){
  for(const kind of ['npm','bun','owned'] as const)console.log(JSON.stringify(await migrationScenario(kind)));
  console.log(JSON.stringify(await migrationScenario('npm','update',false)));
  console.log('MIGRATION_QA_CLEANUP_COMPLETE');
}
