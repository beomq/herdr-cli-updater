import { expect,test } from 'bun:test';
import { mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { createCatalogBulk } from '../../src/app/catalog-bulk';
import { createCatalogUpdates } from '../../src/app/catalog-updates';
import { AppStore } from '../../src/app/store';
import { AppError } from '../../src/app/types';
import type { CatalogEntry,CatalogCheck,CatalogId } from '../../src/app/catalog-types';
import { parseCommand } from '../../src/app/validation';

test('batch planning omits unsupported installed entries and old ready batches cannot execute them',async()=>{
  const f=fixture();try{
    const first=f.entries[0];if(!first)throw new Error('missing entry');
    f.entries.push({...first,id:'qwen'});
    await f.bulk.plan(true);expect(f.checks).not.toContain('qwen');
    const batch=f.bulk.snapshot(),item=batch?.items[0];if(!batch||!item)throw new Error('missing batch');
    f.store.putCatalogBulk({...batch,items:[{...item,catalogId:'qwen'}]});
    const restored=createCatalogBulk(f.options);
    expect(()=>restored.confirm(batch.id,batch.revision)).toThrow('cli_not_supported');
    expect(f.executions).toEqual([]);expect(f.store.catalogBulk()?.items[0]?.catalogId).toBe('qwen');
  }finally{f.close();}
});

function fixture(){
  const directory=realpathSync(mkdtempSync('/tmp/catalog-bulk-')),store=new AppStore(directory);
  const ids:CatalogId[]=['codex','claude','gjc'];
  for(const id of ids){mkdirSync(directory+'/'+id+'/bin',{recursive:true});writeFileSync(directory+'/'+id+'/bin/'+id,'#!/bin/sh\necho 1.0.0\n',{mode:0o755});}
  const entries:CatalogEntry[]=ids.map(id=>({id,name:id,
    description:{ko:'',en:''},executable:id,sourceUrl:'https://example.test',method:'script',availability:'installable',reason:null,
    installed:{path:directory+'/'+id+'/bin/'+id,version:'1.0.0',managed:true}}));
  const executions:string[]=[],policies:string[]=[];
  let fail=false,hold=false,sibling:'fingerprint'|'binding'|null=null;
  const claude={fingerprint:'a'.repeat(64),target:directory+'/claude'};
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const updates=createCatalogUpdates({directory,home:directory,path:'',store,entries:()=>entries,changed:()=>{},installedChanged:()=>{},guard:()=>{}},{
    discover:async options=>({kind:'owned',target:options.catalogId==='claude'?claude.target:directory+'/'+options.catalogId,executable:options.executable,fingerprint:options.catalogId==='claude'?claude.fingerprint:'a'.repeat(64),preserve:[directory]}),
    execute:async(_target,options)=>{executions.push(options.catalogId);if(hold&&options.catalogId==='codex'){entered.resolve();await release.promise;}if(fail&&options.catalogId==='codex')throw new AppError('uncertain','update_failed');
      if(options.catalogId==='codex'&&sibling==='fingerprint')claude.fingerprint='b'.repeat(64);
      if(options.catalogId==='codex'&&sibling==='binding')claude.target=directory+'/moved';
      return '2.0.0';},
  });
  const checks:CatalogId[]=[];
  const options={store,entries:()=>entries,settled:async()=>{},updates,changed:()=>{},guard:()=>{},updated:(id:CatalogId)=>{policies.push(id);},
    check:async(id:CatalogId):Promise<CatalogCheck>=>{checks.push(id);return {status:id==='gjc'?'unsupported':'available',latestVersion:id==='gjc'?null:'2.0.0',checkedAt:1,failure:id==='gjc'?'manual_update_required':null};}};
  return {store,entries,updates,options,checks,executions,policies,entered,release,bulk:createCatalogBulk(options),hold:()=>{hold=true;},fail:()=>{fail=true;},
    siblingChange:(kind:'fingerprint'|'binding')=>{sibling=kind;},close:()=>{store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('a sibling update that only rewrites a shared manifest re-plans the next item once and completes it',async()=>{
  const f=fixture();f.siblingChange('fingerprint');try{
    await f.bulk.plan(true);const batch=f.bulk.snapshot();if(!batch)throw new Error('missing batch');
    const planned=batch.items.find(item=>item.catalogId==='claude')?.jobId;
    await f.bulk.confirm(batch.id,batch.revision);
    expect(f.executions).toEqual(['codex','claude']);
    expect(f.bulk.snapshot()?.items.map(i=>[i.status,i.reason])).toEqual([['completed',null],['completed',null],['unsupported','manual_update_required']]);
    const item=f.bulk.snapshot()?.items.find(i=>i.catalogId==='claude');
    expect(item?.jobId).not.toBe(planned);
    expect(f.store.catalogUpdates().find(job=>job.id===planned)).toMatchObject({stage:'failed',failure:'update_target_changed'});
    expect(f.store.catalogUpdates().find(job=>job.id===item?.jobId)).toMatchObject({stage:'completed',installedVersion:'2.0.0',target:{fingerprint:'b'.repeat(64)}});
  }finally{await f.updates.settled();f.close();}
});
test('a sibling update that changes the next item\'s binding fails that item without re-planning',async()=>{
  const f=fixture();f.siblingChange('binding');try{
    await f.bulk.plan(true);const batch=f.bulk.snapshot();if(!batch)throw new Error('missing batch');
    await f.bulk.confirm(batch.id,batch.revision);
    expect(f.executions).toEqual(['codex']);
    expect(f.bulk.snapshot()?.items.map(i=>[i.status,i.reason])).toEqual([['completed',null],['failed','update_target_changed'],['unsupported','manual_update_required']]);
    expect(f.store.catalogUpdates().filter(job=>job.catalogId==='claude').map(job=>job.stage)).toEqual(['ready']);
  }finally{await f.updates.settled();f.close();}
});
test('whole check includes unsupported entries without preparing or executing updates',async()=>{
  const f=fixture();try{await f.bulk.plan(false);expect(f.checks).toEqual(['codex','claude','gjc']);expect(f.store.catalogUpdates()).toHaveLength(0);expect(f.executions).toHaveLength(0);expect(f.bulk.snapshot()?.items.map(i=>i.status)).toEqual(['available','available','unsupported']);}finally{f.close();}
});
test('one approval executes sequentially, keeps sessions and continues after an item fails',async()=>{
  const f=fixture();f.hold();f.fail();try{
    await f.bulk.plan(true);const batch=f.bulk.snapshot();if(!batch)throw new Error('missing batch');expect(f.executions).toHaveLength(0);
    const running=f.bulk.confirm(batch.id,batch.revision);await f.entered.promise;
    expect(f.executions).toEqual(['codex']);expect(()=>f.bulk.plan(false)).toThrow('bulk_in_progress');
    f.release.resolve();await running;
    expect(f.executions).toEqual(['codex','claude']);expect(f.bulk.snapshot()?.items.map(i=>i.status)).toEqual(['uncertain','completed','unsupported']);
    expect(f.store.catalogUpdates().every(job=>job.paneSessions==='keep')).toBe(true);expect(f.policies).toEqual(['claude']);
    expect(()=>f.bulk.confirm(batch.id,batch.revision)).toThrow('stale_bulk_plan');
  }finally{f.release.resolve();await f.updates.settled();f.close();}
});
test('a changed selection or stale approval rejects the whole batch before execution',async()=>{
  const f=fixture();try{
    await f.bulk.plan(true);const batch=f.bulk.snapshot();if(!batch)throw new Error('missing batch');
    expect(()=>f.bulk.confirm(batch.id,batch.revision+1)).toThrow('stale_bulk_plan');
    const first=f.entries[0];if(!first)throw new Error('missing entry');f.entries[0]={...first,selectedInstallationId:'replacement'};
    expect(()=>f.bulk.confirm(batch.id,batch.revision)).toThrow('stale_bulk_plan');expect(f.executions).toHaveLength(0);
  }finally{f.close();}
});
test('restart retains results but never replays interrupted batch updates',async()=>{
  const f=fixture();try{
    await f.bulk.plan(true);const batch=f.bulk.snapshot();if(!batch)throw new Error('missing batch');
    f.store.putCatalogBulk({...batch,stage:'updating',items:batch.items.map((item,i)=>i===0?{...item,status:'updating'}:item)});
    const restored=createCatalogBulk(f.options);expect(restored.snapshot()?.stage).toBe('completed');
    expect(restored.snapshot()?.items.map(i=>i.status)).toEqual(['uncertain','skipped','unsupported']);expect(f.executions).toHaveLength(0);
  }finally{f.close();}
});
test('batch approval cannot inject restart choices or paths',()=>{
  expect(()=>parseCommand({requestId:'a',command:{kind:'catalog-update-all-confirm',batchId:'b',revision:0,paneSessions:'restart-all'}})).toThrow();
  expect(()=>parseCommand({requestId:'a',command:{kind:'catalog-check-all',target:'/tmp'}})).toThrow();
});
test('a failed lookup does not prevent remaining CLI checks',async()=>{
  const f=fixture();try{
    const bulk=createCatalogBulk({...f.options,check:async id=>{
      if(id==='codex')throw new AppError('unavailable','latest_timeout');
      return f.options.check(id);
    }});
    await bulk.plan(false);
    expect(bulk.snapshot()?.items.map(i=>i.status)).toEqual(['failed','available','unsupported']);
    expect(f.executions).toHaveLength(0);
  }finally{f.close();}
});
