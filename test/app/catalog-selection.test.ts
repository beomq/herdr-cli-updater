import { expect,test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createController } from '../../src/app/controller';
import { createCatalog } from '../../src/app/catalog';
import { createCatalogUpdates } from '../../src/app/catalog-updates';
import { catalogDefinitions } from '../../src/app/catalog-registry';
import type { CatalogInstallation,InstallJob } from '../../src/app/catalog-types';
import type { createEngine } from '../../src/app/engine';
import type { AppCommand } from '../../src/app/types';
import { AppError } from '../../src/app/types';

async function fixture(secondOfficial=false){
  const root=realpathSync(mkdtempSync('/tmp/catalog-selection-')),home=join(root,'home'),directory=join(root,'state');
  mkdirSync(home,{mode:0o700});mkdirSync(directory,{mode:0o700});
  writeFileSync(join(home,'.zshrc'),'export KEEP_TEST_VALUE=preserved\n');
  const definition=catalogDefinitions.find(row=>row.id==='codex');
  if(definition?.recipe?.kind!=='npm')throw new Error('missing recipe');
  const recipe=definition.recipe;
  const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
  const records=ids.map((id,index)=>{
    const target=secondOfficial&&index===1?join(home,'official-npm'):join(directory,'cli-installs',`codex-${id}`),packageRoot=join(target,'lib/node_modules',recipe.package),path=join(target,'bin/codex'),identityPath=join(packageRoot,'cli.js');
    mkdirSync(packageRoot,{recursive:true,mode:0o700});mkdirSync(join(target,'bin'),{mode:0o700});
    writeFileSync(join(packageRoot,'package.json'),JSON.stringify({name:recipe.package,version:`${index+1}.0.0`,bin:{codex:'cli.js'}}));
    writeFileSync(identityPath,`#!/bin/sh\necho ${index+1}.0.0\n`,{mode:0o755});symlinkSync(identityPath,path);
    writeFileSync(join(target,'notes'),'preserve');
    const receipt:InstallJob={id,requestId:id,catalogId:'codex',revision:0,stage:'completed',sourceUrl:definition.sourceUrl,method:definition.method,target,
      recipeHash:createHash('sha256').update(JSON.stringify(recipe)).digest('hex'),createdAt:index,updatedAt:index,installedVersion:`${index+1}.0.0`,executablePath:path,failure:null,log:[]};
    const instance:CatalogInstallation={id:String(index+1),catalogId:'codex',manager:secondOfficial&&index===1?'npm':'owned',root:target,packageName:recipe.package,path,identityPath,isDefault:index===0,receiptId:secondOfficial&&index===1?null:id,version:`${index+1}.0.0`};
    return {receipt,instance,packageRoot};
  });
  const [a,b]=records;if(!a||!b)throw new Error('missing fixtures');
  let sequence=0;
  const writes:string[]=[];
  let holdDiscovery=false;
  const entered=Promise.withResolvers<void>(),released=Promise.withResolvers<void>();
  const unsupported=async()=>{throw new AppError('unsupported');};
  const engine:typeof createEngine=()=>({directory,connect:async()=>{},close:async()=>{},installations:async()=>[],jobs:async()=>[],
    check:unsupported,targets:unsupported,prepare:unsupported,activate:unsupported,update:unsupported});
  const controller=await createController({directory,home,path:join(a.receipt.target,'bin')+':/usr/bin:/bin',prefixes:[],shell:'/bin/zsh'},{
    engine,observe:()=>[],
    catalog:options=>{
      for(const row of records)options.store.putInstallJob(row.receipt);
      return createCatalog(options,{discover:async()=>records.filter(row=>existsSync(row.instance.path)).map(row=>({...row.instance,version:JSON.parse(readFileSync(join(row.packageRoot,'package.json'),'utf8')).version}))});
    },
    updates:options=>createCatalogUpdates(options,{
      discover:async value=>{
        if(holdDiscovery){entered.resolve();await released.promise;}
        const {discoverUpdate}=await import('../../src/app/catalog-update-target');
        return discoverUpdate(value);
      },
      execute:async target=>{
        if(target.kind!=='owned')throw new Error('unexpected source');
        writes.push(target.executable);
        const packageRoot=join(target.target,'lib/node_modules',recipe.package);
        writeFileSync(join(packageRoot,'package.json'),JSON.stringify({name:recipe.package,version:'3.0.0',bin:{codex:'cli.js'}}));
        writeFileSync(join(packageRoot,'cli.js'),'#!/bin/sh\necho 3.0.0\n',{mode:0o755});
        return '3.0.0';
      },
    }),latest:async()=> '3.0.0',
  });
  await controller.settled();
  return {controller,a,b,home,directory,writes,
    command:(command:AppCommand)=>controller.command({requestId:`request-${++sequence}`,command}),
    entry:()=>controller.snapshot().catalog?.find(row=>row.id==='codex'),
    holdDiscovery:()=>{holdDiscovery=true;return {entered:entered.promise,release:released.resolve};},
    close:async()=>{released.resolve();await controller.settled();await controller.close();rmSync(root,{recursive:true,force:true});},
  };
}
test('selection changes management but not PATH and routes update only to that installation',async()=>{
  const f=await fixture();
  try{
    await f.command({kind:'catalog-select',catalogId:'codex',installationId:f.b.instance.id});
    expect(f.entry()?.selectedInstallationId).toBe(f.b.instance.id);
    expect(f.entry()?.installations?.find(row=>row.id===f.a.instance.id)?.isDefault).toBe(true);
    const planned=await f.command({kind:'catalog-update-plan',catalogId:'codex'});
    const job=planned.catalogUpdates?.[0];if(!job)throw new Error('missing plan');
    await f.command({kind:'catalog-update-confirm',jobId:job.id,revision:job.revision});await f.controller.settled();
    expect(f.writes).toEqual([f.b.instance.path]);
    expect(JSON.parse(readFileSync(join(f.a.packageRoot,'package.json'),'utf8')).version).toBe('1.0.0');
    await f.command({kind:'refresh'});await f.controller.settled();
    expect(f.entry()?.installed?.path).toBe(f.b.instance.path);
  }finally{await f.close();}
});
test('a missing selected installation does not silently fall back to another instance',async()=>{
  const f=await fixture();
  try{
    await f.command({kind:'catalog-select',catalogId:'codex',installationId:f.b.instance.id});
    rmSync(f.b.instance.path);
    await f.command({kind:'refresh'});await f.controller.settled();
    expect(f.entry()?.selectedInstallationId).toBe(f.b.instance.id);expect(f.entry()?.installed).toBeNull();
    await expect(f.command({kind:'catalog-update-plan',catalogId:'codex'})).rejects.toThrow('installation_missing');
    expect(f.writes).toHaveLength(0);
  }finally{await f.close();}
});
test('selection serializes a pending enable and transfers active automation after verification',async()=>{
  const f=await fixture();
  const gate=f.holdDiscovery();
  try{
    const enable=f.command({kind:'automation',installationId:'catalog:codex',enabled:true}).then(()=>null,(error:unknown)=>error);
    await gate.entered;
    await expect(f.command({kind:'catalog-select',catalogId:'codex',installationId:f.b.instance.id})).rejects.toThrow('operation_in_progress');
    gate.release();expect(await enable).toBeNull();
    expect(f.entry()?.selectedInstallationId).toBe(f.a.instance.id);
    await f.command({kind:'policy',installationId:'catalog:codex',mode:'update',intervalMinutes:60,firstCheck:'after-interval'});
    await f.command({kind:'catalog-select',catalogId:'codex',installationId:f.b.instance.id});
    expect(f.entry()?.selectedInstallationId).toBe(f.b.instance.id);
    expect(f.controller.snapshot().policies.filter(row=>row.mode!=='off')).toHaveLength(1);
    expect(f.controller.snapshot().policies[0]?.catalogBinding).toContain(f.b.instance.path);
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:false});
  }finally{gate.release();await f.close();}
});
test('default switch for another installation preserves the update target and manager files',async()=>{
  const f=await fixture(true);
  try{
    const planned=await f.command({kind:'default-plan',catalogId:'codex',installationId:f.b.instance.id});
    const job=planned.defaultJobs?.[0];if(!job)throw new Error('missing plan');
    expect(readFileSync(join(f.home,'.zshrc'),'utf8')).toBe('export KEEP_TEST_VALUE=preserved\n');
    expect(JSON.stringify(job)).not.toContain('KEEP_TEST_VALUE');
    await f.command({kind:'default-confirm',jobId:job.id,revision:job.revision});await f.controller.settled();
    expect(f.controller.snapshot().defaultJobs?.[0]).toMatchObject({stage:'completed',result:{version:'2.0.0'}});
    expect(f.entry()?.configuredDefaultInstallationId).toBe(f.b.instance.id);
    expect(f.entry()?.selectedInstallationId).toBe(f.a.instance.id);
    expect(f.controller.snapshot().policies).toEqual([]);
    expect(existsSync(f.a.instance.path)).toBe(true);expect(existsSync(f.b.instance.path)).toBe(true);
    await f.command({kind:'catalog-select',catalogId:'codex',installationId:f.a.instance.id});
    await expect(f.command({kind:'remove-plan',catalogId:'codex',installationId:f.b.instance.id})).rejects.toThrow('cannot_remove_default_installation');
    await f.command({kind:'catalog-select',catalogId:'codex',installationId:f.b.instance.id});
    const removal=await f.command({kind:'remove-plan',catalogId:'codex',installationId:f.a.instance.id});
    const removing=removal.removalJobs?.[0];if(!removing)throw new Error('missing removal');
    await f.command({kind:'remove-confirm',jobId:removing.id,revision:removing.revision});await f.controller.settled();
    expect(f.controller.snapshot().removalJobs?.[0]?.stage).toBe('completed');
    expect(existsSync(f.a.instance.path)).toBe(false);expect(existsSync(f.b.instance.path)).toBe(true);
    expect(readFileSync(join(f.a.receipt.target,'notes'),'utf8')).toBe('preserve');
  }finally{await f.close();}
});

test('unsupported persisted default approval cannot change the shell profile',async()=>{
  const f=await fixture(true);try{
    const planned=await f.command({kind:'default-plan',catalogId:'codex',installationId:f.b.instance.id});
    const job=planned.defaultJobs?.[0];if(!job)throw new Error('missing plan');
    const {AppStore}=await import('../../src/app/store');const store=new AppStore(f.directory);
    store.putDefaultJob({...job,catalogId:'qwen'});store.close();
    const before=readFileSync(join(f.home,'.zshrc'));
    await expect(f.command({kind:'default-confirm',jobId:job.id,revision:job.revision})).rejects.toThrow('cli_not_supported');
    expect(readFileSync(join(f.home,'.zshrc'))).toEqual(before);
    expect(f.controller.snapshot().defaultJobs?.[0]?.stage).toBe('ready');
  }finally{await f.close();}
});
test('reviewed default plus selection succeeds without deleting either installation',async()=>{
  const f=await fixture(true);
  try{
    await f.command({kind:'catalog-select',catalogId:'codex',installationId:f.b.instance.id,reviewed:{path:f.b.instance.path,identityPath:f.b.instance.identityPath,version:'2.0.0',makeDefault:true}});
    expect(f.entry()?.selectedInstallationId).toBe(f.b.instance.id);
    expect(f.entry()?.configuredDefaultInstallationId).toBe(f.b.instance.id);
    expect(existsSync(f.a.instance.path)).toBe(true);expect(existsSync(f.b.instance.path)).toBe(true);
  }finally{await f.close();}
});
test('stale reviewed identity is rejected and preserves selection and policy',async()=>{
  const f=await fixture(true);
  try{
    await f.command({kind:'policy',installationId:'catalog:codex',mode:'update',intervalMinutes:60,firstCheck:'after-interval'});
    const policies=JSON.stringify(f.controller.snapshot().policies);
    await expect(f.command({kind:'catalog-select',catalogId:'codex',installationId:f.b.instance.id,
      reviewed:{path:f.b.instance.path,identityPath:f.a.instance.identityPath,version:'2.0.0',makeDefault:true}})).rejects.toThrow('installation_selection_changed');
    await expect(f.command({kind:'catalog-select',catalogId:'codex',installationId:f.b.instance.id,
      reviewed:{path:f.b.instance.path,identityPath:f.b.instance.identityPath,version:'9.9.9',makeDefault:false}})).rejects.toThrow('installation_selection_changed');
    expect(f.entry()?.selectedInstallationId).toBe(f.a.instance.id);
    expect(f.entry()?.configuredDefaultInstallationId).not.toBe(f.b.instance.id);
    expect(JSON.stringify(f.controller.snapshot().policies)).toBe(policies);
  }finally{await f.close();}
});
test('failed reviewed default switch preserves the previous selection and profile',async()=>{
  const f=await fixture(true);
  try{
    const before=readFileSync(join(f.home,'.zshrc'),'utf8');
    rmSync(f.b.instance.path);
    await expect(f.command({kind:'catalog-select',catalogId:'codex',installationId:f.b.instance.id,
      reviewed:{path:f.b.instance.path,identityPath:f.b.instance.identityPath,version:'2.0.0',makeDefault:true}})).rejects.toThrow();
    expect(f.entry()?.selectedInstallationId).toBe(f.a.instance.id);
    expect(readFileSync(join(f.home,'.zshrc'),'utf8')).toBe(before);
    expect(existsSync(f.a.instance.path)).toBe(true);
  }finally{await f.close();}
});
