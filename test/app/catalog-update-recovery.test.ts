import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { AppStore } from '../../src/app/store';
import { createCatalogUpdates } from '../../src/app/catalog-updates';
import { updateIdentity } from '../../src/app/catalog-update-proof';
import { UpdateExecutionError } from '../../src/app/catalog-update-target';
import { AppError } from '../../src/app/types';
import { parseCommand } from '../../src/app/validation';
import type { CatalogUpdateJob } from '../../src/app/catalog-updates';

function fixture() {
  const directory=realpathSync(mkdtempSync('/tmp/t4r-')),store=new AppStore(directory);
  const executable=directory+'/cli/bin/codex';
  mkdirSync(directory+'/cli/bin',{recursive:true});
  writeFileSync(executable,'#!/bin/sh\necho 2.0.0\n',{mode:0o755});
  const target={kind:'owned' as const,target:directory+'/cli',executable,preserve:[directory],fingerprint:'a'.repeat(64)};
  let source=target,processes:{pid:number;parent:number;uid:number;command:string}[]=[],executions=0;
  let probe=async()=> '2.0.0';
  let execute=async()=> '2.0.0';
  const options={directory,home:directory,path:'/usr/bin:/bin',store,changed:()=>{},installedChanged:()=>{},guard:()=>{},
    entries:()=>[{id:'codex' as const,name:'Codex',description:{ko:'',en:''},executable:'codex',sourceUrl:'https://example.test',method:'npm',availability:'installable' as const,reason:null,
      lastCheck:{status:'available' as const,latestVersion:'9.0.0',checkedAt:1,failure:null},installed:{path:executable,version:'1.0.0',managed:true}}]};
  const dependencies={discover:async()=>source,processes:()=>processes,run:async()=>probe(),execute:async()=>{executions++;return execute();}};
  const updates=createCatalogUpdates(options,dependencies);
  const seed=(fields:Partial<CatalogUpdateJob>={})=>{
    const job:CatalogUpdateJob={id:randomUUID(),requestId:'interrupted',catalogId:'codex',revision:3,stage:'uncertain',target,
      createdAt:1,updatedAt:2,beforeVersion:'1.0.0',installedVersion:null,failure:'response_lost',identity:updateIdentity(target,directory),
      executionTarget:fields.execution==='verified'?target:null,...fields};
    store.putCatalogUpdate(job);return job;
  };
  const current=()=>{const job=store.catalogUpdates()[0];if(!job)throw new Error('missing_job');return job;};
  return {directory,store,target,updates,seed,current,options,dependencies,executions:()=>executions,
    source:(next:typeof target)=>{source=next;},processes:(next:typeof processes)=>{processes=next;},
    probe:(next:typeof probe)=>{probe=next;},execute:(next:typeof execute)=>{execute=next;},
    close:()=>{store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('planning records checked latest separately and execution alone supplies expected version',async()=>{
  const f=fixture();try{
    const job=await f.updates.plan('codex','plan');
    expect(job).toMatchObject({checkedVersion:'9.0.0',expectedVersion:null});
    await f.updates.confirm(job.id,job.revision);await f.updates.settled();
    expect(f.current()).toMatchObject({stage:'completed',checkedVersion:'9.0.0',expectedVersion:'2.0.0',execution:'verified'});
    expect(f.current().executionTarget).toEqual(f.target);
  }finally{f.close();}
});
test('legacy verified rows without execution source evidence cannot claim historical success',async()=>{
  const f=fixture();try{
    const job=f.seed({expectedVersion:'2.0.0',execution:'verified',executionTarget:null});
    await f.updates.recover(job.id,job.revision,'reconcile');
    expect(f.current()).toMatchObject({stage:'uncertain',installedVersion:null,failure:'execution_source_unverified'});
    expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test.each(['missing-identity','replaced-payload','old-execution-source'] as const)('stale %s evidence can be inspected and archived without claiming success',async(mode)=>{
  const f=fixture();try{
    const job=f.seed({execution:mode==='old-execution-source'?'verified':'unknown',expectedVersion:'2.0.0',
      ...(mode==='missing-identity'?{identity:null}:{})});
    if(mode==='replaced-payload'){
      renameSync(f.target.executable,f.target.executable+'.old');writeFileSync(f.target.executable,'new payload');
    }
    f.source({...f.target,fingerprint:'b'.repeat(64)});
    await f.updates.recover(job.id,job.revision,'reconcile');
    expect(f.current()).toMatchObject({stage:'uncertain',installedVersion:null,reconciliation:{version:'2.0.0',fingerprint:'b'.repeat(64)}});
    await expect(f.updates.plan('codex','before-archive')).rejects.toMatchObject({detail:'inspect_interrupted_update'});
    await f.updates.recover(job.id,f.current().revision,'archive-unverified');
    const archived=f.current();
    expect(archived).toMatchObject({stage:'archived-unverified',installedVersion:null,execution:job.execution});
    const fresh=await f.updates.plan('codex','fresh');
    expect(fresh.target.fingerprint).toBe('b'.repeat(64));expect(fresh.expectedVersion).toBeNull();
    expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('a proven installer rejection does not block a fresh plan',async()=>{
  const f=fixture();try{
    f.seed({stage:'failed',execution:'not-started',failure:'installer_exit_1'});
    expect((await f.updates.plan('codex','fresh')).stage).toBe('ready');expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('legacy missing identity cannot archive a changed source or an active installer',async()=>{
  const f=fixture();try{
    const job=f.seed({identity:null,execution:'unknown',failure:'installer_exit_1'});
    await f.updates.recover(job.id,job.revision,'reconcile');
    f.source({...f.target,target:f.directory});
    await expect(f.updates.recover(job.id,f.current().revision,'archive-unverified')).rejects.toMatchObject({detail:'recovery_source_changed'});
    expect(f.current().stage).toBe('uncertain');
    f.source(f.target);await f.updates.recover(job.id,f.current().revision,'reconcile');
    f.processes([{pid:999,parent:1,uid:0,command:'bun add --global @openai/codex'}]);
    await expect(f.updates.recover(job.id,f.current().revision,'archive-unverified')).rejects.toMatchObject({detail:'recovery_executor_active'});
    expect(f.current().stage).toBe('uncertain');expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test.each([false,true])('reconcile never treats disk or checked latest as execution provenance (%s)',async(legacy)=>{
  const f=fixture();try{
    const job=f.seed({checkedVersion:'2.0.0',...(legacy?{identity:null}:{})});
    await f.updates.recover(job.id,job.revision,'reconcile');
    expect(f.current()).toMatchObject({stage:'uncertain',expectedVersion:null,installedVersion:null,reconciliation:{version:'2.0.0'}});
    const reconciled=f.current();
    await f.updates.recover(job.id,reconciled.revision,'archive-unverified');
    expect(f.current()).toMatchObject({stage:'archived-unverified',installedVersion:null,failure:'update_archived_unverified'});
    expect(f.executions()).toBe(0);
    await f.updates.plan('codex','new');expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test.each(['verified','started','unknown'] as const)('only verified execution and unchanged file evidence completes (%s)',async(execution)=>{
  const f=fixture();try{
    const job=f.seed({expectedVersion:'2.0.0',execution});
    await f.updates.recover(job.id,job.revision,'reconcile');
    expect(f.current().stage).toBe(execution==='verified'?'completed':'uncertain');expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test.each(['missing','replaced','source','path','dirty','malformed','before-version'] as const)('recovery stays uncertain for %s',async(mode)=>{
  const f=fixture();try{
    const job=f.seed({expectedVersion:'2.0.0',execution:'verified'});
    switch(mode){
      case 'missing':rmSync(f.target.executable);break;
      case 'replaced':renameSync(f.target.executable,f.target.executable+'.old');writeFileSync(f.target.executable,'replacement');break;
      case 'source':f.source({...f.target,target:f.directory});break;
      case 'path':f.source({...f.target,executable:f.directory+'/other'});break;
      case 'dirty':f.probe(async()=>{writeFileSync(f.target.executable,'changed during probe');return '2.0.0';});break;
      case 'malformed':f.probe(async()=> 'no version');break;
      case 'before-version':f.probe(async()=> '1.0.0');break;
    }
    await f.updates.recover(job.id,job.revision,'reconcile');
    expect(f.current().stage).toBe('uncertain');expect(f.current().installedVersion).toBeNull();expect(f.executions()).toBe(0);
    if(mode==='missing')expect(f.current().failure).toBe('recovery_target_missing');
  }finally{f.close();}
});
test('a running CLI inside the installation is not an installer',async()=>{
  const f=fixture();try{
    const job=f.seed();
    f.processes([{pid:999,parent:1,uid:0,command:f.target.executable+' --session conversation'}]);
    await f.updates.recover(job.id,job.revision,'reconcile');
    expect(f.current().reconciliation?.version).toBe('2.0.0');
    expect(f.current().failure).not.toBe('recovery_executor_active');
    expect(f.executions()).toBe(0);
  }finally{f.close();}
});

test('stale revisions and active executor cannot archive or unlock a job',async()=>{
  const f=fixture();try{
    const job=f.seed();
    await expect(f.updates.recover(job.id,2,'reconcile')).rejects.toMatchObject({detail:'stale_update_plan'});
    await f.updates.recover(job.id,3,'reconcile');
    f.processes([{pid:999,parent:1,uid:0,command:'npm install --global @openai/codex'}]);
    await expect(f.updates.recover(job.id,f.current().revision,'archive-unverified')).rejects.toMatchObject({detail:'recovery_executor_active'});
    expect(f.current().stage).toBe('uncertain');
    await expect(f.updates.plan('codex','retry')).rejects.toMatchObject({detail:'inspect_interrupted_update'});
    expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('archive requires a fresh file-bound reconciliation and rejects intervening dirt',async()=>{
  const f=fixture();try{
    const job=f.seed();
    await expect(f.updates.recover(job.id,job.revision,'archive-unverified')).rejects.toMatchObject({detail:'reconcile_before_archive'});
    await f.updates.recover(job.id,f.current().revision,'reconcile');
    writeFileSync(f.target.executable,'changed after review');
    await expect(f.updates.recover(job.id,f.current().revision,'archive-unverified')).rejects.toMatchObject({detail:'reconcile_before_archive'});
    expect(f.current().stage).toBe('uncertain');expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('revision changed during probe is preserved instead of overwritten',async()=>{
  const f=fixture();try{
    const job=f.seed();
    f.probe(async()=>{f.store.putCatalogUpdate({...f.current(),revision:90,failure:'newer_evidence'});return '2.0.0';});
    await expect(f.updates.recover(job.id,job.revision,'reconcile')).rejects.toMatchObject({detail:'stale_update_plan'});
    expect(f.current()).toMatchObject({revision:90,failure:'newer_evidence'});expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('source metadata drift after reconciliation invalidates acknowledgement',async()=>{
  const f=fixture();try{
    const job=f.seed();await f.updates.recover(job.id,job.revision,'reconcile');
    f.source({...f.target,fingerprint:'b'.repeat(64)});
    await expect(f.updates.recover(job.id,f.current().revision,'archive-unverified')).rejects.toMatchObject({detail:'recovery_source_changed'});
    expect(f.current().stage).toBe('uncertain');expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('repeated service interruptions and repeated reconcile never replay or fabricate success',async()=>{
  const f=fixture();try{
    const job=f.seed({stage:'updating'});
    for(let i=0;i<3;i++){
      const resumed=createCatalogUpdates(f.options,f.dependencies);
      await resumed.recover(job.id,f.current().revision,'reconcile');
      expect(f.current().stage).toBe('uncertain');
    }
    expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('pending reconciliation rejects duplicate acknowledgement and resumes without mutation',async()=>{
  const f=fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  try{
    const job=f.seed();f.probe(async()=>{entered.resolve();await release.promise;return '2.0.0';});
    const pending=f.updates.recover(job.id,job.revision,'reconcile');
    await entered.promise;
    await expect(f.updates.recover(job.id,job.revision,'archive-unverified')).rejects.toMatchObject({detail:'update_in_progress'});
    await expect(f.updates.plan('codex','retry')).rejects.toMatchObject({detail:'update_in_progress'});
    release.resolve();await pending;
    expect(f.current().stage).toBe('uncertain');expect(f.executions()).toBe(0);
  }finally{release.resolve();f.close();}
});
test('lost process observation cannot prove absence of an executor',async()=>{
  const f=fixture();try{
    const job=f.seed();
    const updates=createCatalogUpdates(f.options,{...f.dependencies,processes:()=>{throw new Error('ps_failed');}});
    await updates.recover(job.id,job.revision,'reconcile');
    expect(f.current()).toMatchObject({stage:'uncertain',failure:'process_observation_unavailable'});
    await expect(updates.recover(job.id,f.current().revision,'archive-unverified')).rejects.toMatchObject({detail:'process_observation_unavailable'});
    expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('live recorded executor PID blocks recovery even when its command no longer names the target',async()=>{
  const f=fixture();try{
    const job=f.seed({executorPid:991});f.processes([{pid:991,parent:1,uid:0,command:'worker'}]);
    await expect(f.updates.recover(job.id,job.revision,'reconcile')).rejects.toMatchObject({detail:'recovery_executor_active'});
    expect(f.current().stage).toBe('uncertain');expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test.each(['proven-before','unknown','started','misleading-success'] as const)('execution outcome requires mutation proof for %s',async(mode)=>{
  const f=fixture();try{
    f.execute(async()=>{
      if(mode==='misleading-success')return 'latest';
      if(mode==='unknown')throw new AppError('source_changed','source_changed');
      throw new UpdateExecutionError(mode==='started',new AppError('source_changed','source_changed'));
    });
    const job=await f.updates.plan('codex','plan');await f.updates.confirm(job.id,job.revision);await f.updates.settled();
    expect(f.current().stage).toBe(mode==='proven-before'?'failed':'uncertain');
    expect(f.current().expectedVersion).toBeNull();expect(f.executions()).toBe(1);
  }finally{f.close();}
});
test('recovery command schema accepts only bounded revision and explicit actions',()=>{
  expect(parseCommand({requestId:'r',command:{kind:'catalog-update-recover',jobId:'j',revision:0,action:'reconcile'}}).command.kind).toBe('catalog-update-recover');
  for(const fields of [{revision:-1},{action:'retry'},{action:'cancel'},{target:'/tmp/elsewhere'}])
    expect(()=>parseCommand({requestId:'r',command:{kind:'catalog-update-recover',jobId:'j',revision:0,action:'reconcile',...fields}})).toThrow();
});
