import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { AppStore } from '../../src/app/store';
import { createCatalogUpdates, updateBinding } from '../../src/app/catalog-updates';
import { AppError } from '../../src/app/types';
import type { RemovalTarget } from '../../src/app/catalog-removal-target';
import { parseCommand } from '../../src/app/validation';

test('unsupported persisted ready updates remain stored but cannot resolve or execute',async()=>{
  const f=fixture();try{
    const ready=await f.updates.plan('codex','old');const legacy={...ready,catalogId:'maki' as const};f.store.putCatalogUpdate(legacy);
    await expect(f.updates.targetFor('maki')).rejects.toThrow('cli_not_supported');
    await expect(f.updates.plan('maki','new')).rejects.toThrow('cli_not_supported');
    await expect(f.updates.confirm(legacy.id,legacy.revision)).rejects.toThrow('cli_not_supported');
    expect(f.store.catalogUpdates()[0]?.catalogId).toBe('maki');expect(f.executions()).toBe(0);
  }finally{f.close();}
});

function fixture() {
  const directory=realpathSync(mkdtempSync('/tmp/catalog-update-'));
  mkdirSync(directory+'/cli/bin',{recursive:true});writeFileSync(directory+'/cli/bin/codex','#!/bin/sh\necho 1.0.0\n',{mode:0o755});
  const store=new AppStore(directory);
  let executions=0,blocked=false,fingerprint='a'.repeat(64);
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const target=():RemovalTarget=>({kind:'owned',target:directory+'/cli',executable:directory+'/cli/bin/codex',preserve:[directory],fingerprint});
  const options={directory,home:directory,path:'',store,changed:()=>{},installedChanged:()=>{},
    entries:()=>[{id:'codex' as const,name:'Maki',description:{ko:'',en:''},executable:'codex',sourceUrl:'https://codex.sh',method:'script',availability:'installable' as const,reason:null,installed:{path:target().executable,version:'1.0.0',managed:true}}],
    guard:()=>{if(blocked)throw new AppError('busy','running_sessions');}};
  const dependencies={discover:async()=>target(),execute:async()=>{executions++;entered.resolve();await release.promise;return '2.0.0';}};
  const updates=createCatalogUpdates(options,dependencies);
  return {store,updates,options,dependencies,entered,release,target,executions:()=>executions,
    block:()=>{blocked=true;},replace:()=>{fingerprint='b'.repeat(64);},
    close:()=>{store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('catalog update requires confirmation and records the verified version',async()=>{
  const f=fixture();
  try {
    const job=await f.updates.plan('codex','request');
    expect(f.executions()).toBe(0);
    await expect(f.updates.confirm(job.id,1)).rejects.toThrow('stale_update_plan');
    await f.updates.confirm(job.id,0);await f.entered.promise;
    await expect(f.updates.confirm(job.id,0)).rejects.toThrow('update_in_progress');
    f.release.resolve();await f.updates.settled();
    expect(f.store.catalogUpdates()[0]).toMatchObject({stage:'completed',beforeVersion:'1.0.0',installedVersion:'2.0.0'});
    expect(f.executions()).toBe(1);
  } finally {f.release.resolve();await f.updates.settled();f.close();}
});
test('changed ownership or a newly running session blocks an approved update',async()=>{
  const f=fixture();
  try {
    const job=await f.updates.plan('codex','request');f.replace();
    await expect(f.updates.confirm(job.id,0)).rejects.toThrow('update_target_changed');
    const fresh=await f.updates.plan('codex','fresh');f.block();
    await expect(f.updates.confirm(fresh.id,0)).rejects.toThrow('running_sessions');
    expect(f.executions()).toBe(0);
  } finally {f.close();}
});
test('restart marks an interrupted update uncertain and refuses automatic retry',async()=>{
  const f=fixture();
  try {
    const job=await f.updates.plan('codex','request');
    f.store.putCatalogUpdate({...job,stage:'updating'});
    const resumed=createCatalogUpdates(f.options,f.dependencies);
    await expect(resumed.plan('codex','next')).rejects.toThrow('inspect_interrupted_update');
    expect(f.store.catalogUpdates()[0]?.stage).toBe('uncertain');
    expect(f.executions()).toBe(0);
  } finally {f.close();}
});
test('withdrawing automatic consent during target discovery prevents execution',async()=>{
  const f=fixture();
  try {
    const job=await f.updates.plan('codex','request');
    await expect(f.updates.confirm(job.id,0,()=>false)).rejects.toThrow('policy_changed');
    expect(f.executions()).toBe(0);
  } finally {f.close();}
});
test('policy binding follows the installation source rather than mutable version fingerprints',()=>{
  const f=fixture();
  try {
    const original=updateBinding(f.target());f.replace();
    expect(updateBinding(f.target())).toBe(original);
    expect(updateBinding({...f.target(),executable:'/elsewhere/codex'})).not.toBe(original);
  } finally {f.close();}
});
test('catalog update commands reject injected paths and invalid revisions',()=>{
  expect(()=>parseCommand({requestId:'x',command:{kind:'catalog-update-plan',catalogId:'codex',target:'/etc'}})).toThrow();
  expect(()=>parseCommand({requestId:'x',command:{kind:'catalog-update-confirm',jobId:'x',revision:-1}})).toThrow();
});
