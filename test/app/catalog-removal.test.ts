import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { AppStore } from '../../src/app/store';
import { createRemoval } from '../../src/app/catalog-removal';
import { parseCommand } from '../../src/app/validation';
import { AppError } from '../../src/app/types';
import type { RemovalTarget } from '../../src/app/catalog-removal-target';

test('unsupported persisted removal approval cannot delete its installation',async()=>{
  const f=fixture();try{
    await f.removal.plan('codex','old');const job=f.store.removalJobs()[0];if(!job)throw new Error('missing');
    f.store.putRemovalJob({...job,catalogId:'maki'});
    await expect(f.removal.plan('maki','new')).rejects.toThrow('cli_not_supported');
    await expect(f.removal.confirm(job.id,job.revision)).rejects.toThrow('cli_not_supported');
    expect(f.executions()).toBe(0);expect(f.store.removalJobs()[0]?.stage).toBe('ready');
  }finally{f.close();}
});

function fixture(){
  const directory=realpathSync(mkdtempSync('/tmp/removal-job-'));
  const store=new AppStore(directory);let executions=0,blocked=false,identity='a'.repeat(64);
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const target=():RemovalTarget=>({kind:'owned',target:directory+'/owned',executable:directory+'/owned/bin/codex',preserve:[directory+'/home'],fingerprint:identity});
  const options={directory,home:directory,path:'',store,changed:()=>{},installedChanged:()=>{},
    entries:()=>[{id:'codex' as const,name:'Maki',description:{ko:'',en:''},executable:'codex',sourceUrl:'https://codex.sh',method:'script',availability:'installable' as const,reason:null,installed:{path:target().executable,version:'1.0.0',managed:true}}],
    guard:()=>{if(blocked)throw new AppError('busy','running_sessions');}};
  const dependencies={discover:async()=>target(),validate:()=>{},execute:async()=>{executions++;entered.resolve();await release.promise;}};
  const removal=createRemoval(options,dependencies);
  return {store,removal,options,dependencies,entered,release,executions:()=>executions,block:()=>{blocked=true;},replace:()=>{identity='b'.repeat(64);},close:()=>{store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('removal only runs once after fresh explicit confirmation',async()=>{
  const f=fixture();
  try{
    await f.removal.plan('codex','request');const job=f.store.removalJobs()[0];if(!job)throw new Error('missing');
    expect(f.executions()).toBe(0);
    await expect(f.removal.confirm(job.id,1)).rejects.toThrow('stale_removal_plan');
    await f.removal.confirm(job.id,0);await f.entered.promise;
    await expect(f.removal.confirm(job.id,0)).rejects.toThrow('removal_in_progress');
    f.release.resolve();await f.removal.settled();
    expect(f.executions()).toBe(1);expect(f.store.removalJobs()[0]?.stage).toBe('completed');
  }finally{f.release.resolve();await f.removal.settled();f.close();}
});
test('new session after planning prevents removal execution',async()=>{
  const f=fixture();try{
    await f.removal.plan('codex','request');const job=f.store.removalJobs()[0];if(!job)throw new Error('missing');
    f.block();await expect(f.removal.confirm(job.id,0)).rejects.toThrow('running_sessions');expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('a configuration reference added after review prevents removal',async()=>{
  const f=fixture();try{
    await f.removal.plan('codex','request');const job=f.store.removalJobs()[0];if(!job)throw new Error('missing');
    const directory=f.options.home+'/.omo/agent/extensions';mkdirSync(directory,{recursive:true});
    writeFileSync(directory+'/dependent.js',JSON.stringify(job.target.executable));
    await expect(f.removal.confirm(job.id,0)).rejects.toThrow('installation_referenced');
    expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('changed physical installation invalidates approved target',async()=>{
  const f=fixture();try{
    await f.removal.plan('codex','request');const job=f.store.removalJobs()[0];if(!job)throw new Error('missing');
    f.replace();await expect(f.removal.confirm(job.id,0)).rejects.toThrow('removal_target_changed');expect(f.executions()).toBe(0);
  }finally{f.close();}
});
test('interrupted removal cannot replay or bypass another ready plan',async()=>{
  const f=fixture();try{
    await f.removal.plan('codex','a');await f.removal.plan('codex','b');
    const [ready,interrupted]=f.store.removalJobs();if(!ready||!interrupted)throw new Error('missing');
    f.store.putRemovalJob({...interrupted,stage:'removing'});
    const recovered=createRemoval(f.options,f.dependencies);
    await expect(recovered.confirm(ready.id,0)).rejects.toThrow('inspect_interrupted_removal');
    await expect(recovered.plan('codex','c')).rejects.toThrow('inspect_interrupted_removal');
    expect(f.executions()).toBe(0);expect(f.store.removalJobs().find(row=>row.id===interrupted.id)?.stage).toBe('uncertain');
  }finally{f.close();}
});
test('public removal commands cannot supply deletion paths or bypass revisions',()=>{
  expect(()=>parseCommand({requestId:'x',command:{kind:'remove-plan',catalogId:'codex',target:'/etc'}})).toThrow();
  expect(()=>parseCommand({requestId:'x',command:{kind:'remove-confirm',jobId:'x',revision:-1}})).toThrow();
});
