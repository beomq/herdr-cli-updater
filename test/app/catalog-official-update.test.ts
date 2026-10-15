import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {discoverOfficialUpdate,executeOfficialUpdate} from '../../src/app/catalog-official-update';
import type {runProcess} from '../../src/app/catalog-runner';

function fixture(){
  const root=realpathSync(mkdtempSync('/tmp/official-update-test-')),home=join(root,'home'),directory=join(root,'updater');
  mkdirSync(home);mkdirSync(directory);mkdirSync(join(home,'.local/bin'),{recursive:true});
  const executable=join(home,'.local/bin/gjc');
  const publish=(version:string)=>writeFileSync(executable,Buffer.concat([Buffer.from(process.platform==='darwin'?'cffaedfe':'7f454c46','hex'),Buffer.from('gjc '+version)]),{mode:0o755});
  publish('1.0.0');let version='1.0.0',installs=0;
  const run:typeof runProcess=async(file,args)=>{if(file===executable)return 'gjc '+version;expect(args[1]).toBe('--binary');installs++;version='2.0.0';publish(version);return '';};
  return {root,executable,publish,options:{home,directory,path:'/usr/bin:/bin',catalogId:'gjc' as const,executable,run,download:async()=> '#!/bin/bash\n'},installs:()=>installs,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('official update reuses the verified standalone path without updater payloads',async()=>{
  const f=fixture();try{
    const target=await discoverOfficialUpdate(f.options);if(!target)throw new Error('target missing');
    expect(await executeOfficialUpdate(target,f.options)).toBe('2.0.0');expect(f.installs()).toBe(1);
    expect(target.executable).toBe(f.executable);
  }finally{f.close();}
});
test('target changed after download cannot execute the installer',async()=>{
  const f=fixture();try{
    const target=await discoverOfficialUpdate(f.options);if(!target)throw new Error('target missing');
    await expect(executeOfficialUpdate(target,{...f.options,download:async()=>{f.publish('9.0.0');return '#!/bin/bash\n';}})).rejects.toThrow('official_update_target_changed');
    expect(f.installs()).toBe(0);
  }finally{f.close();}
});
test('a script at a familiar path is not standalone update authority',async()=>{
  const f=fixture();try{
    writeFileSync(f.executable,'#!/bin/sh\necho gjc 1.0.0\n');
    expect(await discoverOfficialUpdate(f.options)).toBeNull();expect(f.installs()).toBe(0);
  }finally{f.close();}
});
