import { expect,test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { discoverStandaloneRemoval, executeStandaloneRemoval, validateStandaloneRemoval } from '../../src/app/catalog-standalone-removal';
import { discoverUpdate } from '../../src/app/catalog-update-target';
import { createRemoval } from '../../src/app/catalog-removal';
import { AppStore } from '../../src/app/store';
import { AppError } from '../../src/app/types';

function fixture(id:'claude'|'agy'|'kimi'|'opencode'){
  const home=realpathSync(mkdtempSync('/tmp/standalone-removal-'));
  const paths={claude:'.local/bin/claude',agy:'.local/bin/agy',kimi:'.kimi-code/bin/kimi',opencode:'.opencode/bin/opencode'};
  const executable=join(home,paths[id]),payload=id==='claude'?join(home,'.local/share/claude/versions/2.1.296'):executable;
  mkdirSync(dirname(executable),{recursive:true});mkdirSync(dirname(payload),{recursive:true});
  writeFileSync(payload,Buffer.concat([Buffer.from('cffaedfe','hex'),Buffer.from('native-fixture')]),{mode:0o755});
  if(executable!==payload)symlinkSync(payload,executable);
  writeFileSync(join(home,'preserved-config'),'user config');writeFileSync(join(dirname(payload),'another-version'),'other binary');
  return {home,catalogId:id,executable,payload,close:()=>rmSync(home,{recursive:true,force:true})};
}
for(const id of ['claude','agy','kimi','opencode'] as const)test(`${id} removes only the verified launch path and preserves binary bytes and user files`,()=>{
  const f=fixture(id);
  try{
    const target=discoverStandaloneRemoval(f);if(!target)throw new Error('missing_target');
    const original=readFileSync(f.payload);executeStandaloneRemoval(target,f.home);
    expect(existsSync(f.executable)).toBe(false);expect(readFileSync(target.archive)).toEqual(original);
    expect(readFileSync(join(f.home,'preserved-config'),'utf8')).toBe('user config');
    expect(readFileSync(join(dirname(f.payload),'another-version'),'utf8')).toBe('other binary');
    expect(()=>executeStandaloneRemoval(target,f.home)).toThrow();
  }finally{f.close();}
});
test('standalone removal rejects scripts, writable binaries, redirects, changed payload and existing archives',()=>{
  const f=fixture('claude');
  try{
    const target=discoverStandaloneRemoval(f);if(!target)throw new Error('missing');
    writeFileSync(f.payload,'#!/bin/sh\necho fake');expect(()=>validateStandaloneRemoval(target)).toThrow();
    writeFileSync(f.payload,Buffer.from('cffaedfe00000000','hex'));chmodSync(f.payload,0o777);expect(()=>discoverStandaloneRemoval(f)).toThrow();
    chmodSync(f.payload,0o755);writeFileSync(target.archive,'keep');expect(()=>discoverStandaloneRemoval(f)).toThrow('removal_archive_exists');
    unlinkSync(target.archive);unlinkSync(f.executable);symlinkSync(join(f.home,'preserved-config'),f.executable);expect(()=>discoverStandaloneRemoval(f)).toThrow();
  }finally{f.close();}
});
test('standalone removal does not authorize standalone updates or unverified Grok layouts',async()=>{
  const f=fixture('opencode');
  try{
    expect(discoverStandaloneRemoval({...f,catalogId:'grok'})).toBeNull();
    expect(await discoverUpdate({...f,directory:join(f.home,'state'),path:'',receipt:null})).toBeNull();
  }finally{f.close();}
});
test('standalone plan and confirmation recheck consumers and configuration references',async()=>{
  const f=fixture('opencode'),directory=join(f.home,'state');mkdirSync(directory,{mode:0o700});
  const store=new AppStore(directory);let inUse=false;
  const removal=createRemoval({directory,home:f.home,path:'',store,changed:()=>{},installedChanged:()=>{},
    entries:()=>[{id:'opencode',name:'OpenCode',description:{ko:'',en:''},executable:'opencode',sourceUrl:'https://example.test',method:'script',availability:'installable',reason:null,installed:{path:f.executable,version:'1.0.0',managed:false}}],
    guard:()=>{if(inUse)throw new AppError('busy','running_sessions');},
  });
  try{
    await removal.plan('opencode','first');const job=store.removalJobs()[0];if(!job)throw new Error('missing');
    expect(job.target.kind).toBe('standalone');expect(existsSync(f.executable)).toBe(true);
    inUse=true;await expect(removal.confirm(job.id,job.revision)).rejects.toThrow('running_sessions');inUse=false;
    mkdirSync(join(f.home,'.omo/agent'),{recursive:true});const config=join(f.home,'.omo/agent/settings.json');writeFileSync(config,JSON.stringify({tool:f.executable}));
    await expect(removal.confirm(job.id,job.revision)).rejects.toThrow('installation_referenced');
    unlinkSync(config);await removal.confirm(job.id,job.revision);await removal.settled();
    expect(store.removalJobs()[0]?.stage).toBe('completed');expect(existsSync(f.executable)).toBe(false);
  }finally{store.close();f.close();}
});
