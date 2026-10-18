import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { discoverOfficialUpdate, executeOfficialUpdate } from '../../src/app/catalog-official-update';
import type { OfficialUpdateTarget } from '../../src/app/catalog-official-update';
import { latestCatalogVersion } from '../../src/app/catalog-latest';
import type { runProcess } from '../../src/app/catalog-runner';

const base='https://downloads.claude.ai/claude-code-releases';
function fixture(channel='latest') {
  const root=realpathSync(mkdtempSync('/tmp/claude-update-test-')),home=join(root,'home'),directory=join(root,'updater');
  const target=join(home,'.local/share/claude'),executable=join(home,'.local/bin/claude');
  mkdirSync(join(target,'versions'),{recursive:true});mkdirSync(join(home,'.local/bin'),{recursive:true});mkdirSync(directory);
  mkdirSync(join(home,'.claude'));writeFileSync(join(home,'.claude/settings.json'),JSON.stringify({autoUpdatesChannel:channel}));
  const publish=(version:string)=>{
    const binary=join(target,'versions',version);
    writeFileSync(binary,Buffer.concat([Buffer.from(process.platform==='darwin'?'cffaedfe':'7f454c46','hex'),Buffer.from('Claude Code '+version)]),{mode:0o755});
    rmSync(executable,{force:true});symlinkSync(binary,executable);
  };
  publish('2.1.296');let updates=0;
  const state={channel,doctorOverride:null as string|null,update:'success'};
  const calls:{file:string;args:readonly string[]}[]=[];
  const run:typeof runProcess=async(file,args,env,cwd)=>{
    calls.push({file,args});expect(cwd).toBe(home);expect(env['HOME']).toBe(home);
    expect(env['DISABLE_AUTOUPDATER']).toBe('1');expect(file).toBe(realpathSync(executable));
    const version=basename(file);
    if(args[0]==='--version'){expect(env['DISABLE_UPDATES']).toBe('1');return `${version} (Claude Code)`;}
    if(args[0]==='doctor'){
      expect(env['DISABLE_UPDATES']).toBe('1');
      return state.doctorOverride??`Running: native (${version})\nPath: ${file}\nConfig install method: native\nAuto-update channel: ${state.channel}`;
    }
    expect(args).toEqual(['update']);expect(env['DISABLE_UPDATES']).toBeUndefined();updates++;
    if(state.update==='success'){publish('2.1.301');return `Successfully updated from ${version} to version 2.1.301`;}
    if(state.update==='noop')return `Claude Code is up to date (${version})`;
    if(state.update==='lie')return `Successfully updated from ${version} to version 2.1.301`;
    throw new Error('unexpected update mode');
  };
  return {root,home,directory,target,executable,publish,state,calls,updates:()=>updates,
    options:{home,directory,path:'/usr/bin:/bin',catalogId:'claude' as const,executable,run},close:()=>rmSync(root,{recursive:true,force:true})};
}
async function discovered(f:ReturnType<typeof fixture>):Promise<OfficialUpdateTarget> {
  const target=await discoverOfficialUpdate(f.options);if(!target)throw new Error('missing native target');return target;
}

for(const channel of ['latest','stable'])test(`native discovery binds the effective ${channel} channel and canonical inventory path`,async()=>{
  const f=fixture(channel);try{
    const target=await discoverOfficialUpdate({...f.options,executable:realpathSync(f.executable)});
    expect(target).toMatchObject({kind:'official',catalogId:'claude',target:f.target,executable:f.executable,sourceUrl:`${base}/${channel}`});
    expect(f.updates()).toBe(0);
  }finally{f.close();}
});

test('native update follows the managed launcher switch and preserves settings and prior binary',async()=>{
  const f=fixture('stable');try{
    const target=await discovered(f),settings=readFileSync(join(f.home,'.claude/settings.json'),'utf8');
    let mutations=0;const events:string[]=[];
    expect(await executeOfficialUpdate(target,{...f.options,beforeMutation:()=>mutations++},event=>events.push(event))).toBe('2.1.301');
    expect(f.updates()).toBe(1);expect(mutations).toBe(1);expect(events.at(-1)).toBe('update_verified');
    expect(realpathSync(f.executable)).toBe(join(f.target,'versions/2.1.301'));
    expect(readFileSync(join(f.home,'.claude/settings.json'),'utf8')).toBe(settings);
    expect(readFileSync(join(f.target,'versions/2.1.296')).length).toBeGreaterThan(4);
  }finally{f.close();}
});
test('native update accepts a verified current-version response without inventing success for a newer release',async()=>{
  const f=fixture();try{const target=await discovered(f);f.state.update='noop';expect(await executeOfficialUpdate(target,f.options)).toBe('2.1.296');}
  finally{f.close();}
});
test('native update refuses reported success when the launcher did not advance',async()=>{
  const f=fixture();try{const target=await discovered(f);f.state.update='lie';await expect(executeOfficialUpdate(target,f.options)).rejects.toThrow('official_update_target_changed');}
  finally{f.close();}
});
test('native update rejects a changed channel before mutation',async()=>{
  const f=fixture();try{const target=await discovered(f);f.state.channel='stable';await expect(executeOfficialUpdate(target,f.options)).rejects.toThrow('official_update_target_changed');expect(f.updates()).toBe(0);}
  finally{f.close();}
});
test('native update rejects changed binary bytes before mutation',async()=>{
  const f=fixture();try{const target=await discovered(f);writeFileSync(realpathSync(f.executable),'replaced');await expect(executeOfficialUpdate(target,f.options)).rejects.toThrow('official_update_target_changed');expect(f.updates()).toBe(0);}
  finally{f.close();}
});
test('native discovery rejects custom launchers and external or redirected payloads before execution',async()=>{
  for(const mode of ['script','outside','directory-link']){
    const f=fixture();try{
      if(mode==='script'){unlinkSync(f.executable);writeFileSync(f.executable,'#!/bin/sh\n', {mode:0o755});}
      if(mode==='outside'){const outside=join(f.root,'2.1.296');writeFileSync(outside,'other');unlinkSync(f.executable);symlinkSync(outside,f.executable);}
      if(mode==='directory-link'){
        const outside=join(f.root,'versions');mkdirSync(outside);writeFileSync(join(outside,'2.1.296'),'other');
        rmSync(join(f.target,'versions'),{recursive:true});symlinkSync(outside,join(f.target,'versions'));
      }
      expect(await discoverOfficialUpdate(f.options)).toBeNull();expect(f.calls).toHaveLength(0);
    }finally{f.close();}
  }
});
test('native discovery requires unambiguous native ownership and effective channel diagnostics',async()=>{
  for(const mode of ['npm','wrong-path','no-channel','unknown-channel','duplicate-channel']){
    const f=fixture();try{
      const path=realpathSync(f.executable);
      f.state.doctorOverride=`Running: ${mode==='npm'?'npm':'native'} (2.1.296)\nPath: ${mode==='wrong-path'?'/other/claude':path}\nConfig install method: native`+
        (mode==='no-channel'?'':`\nAuto-update channel: ${mode==='unknown-channel'?'nightly':'latest'}`)+(mode==='duplicate-channel'?'\nAuto-update channel: stable':'');
      expect(await discoverOfficialUpdate(f.options)).toBeNull();expect(f.updates()).toBe(0);
    }finally{f.close();}
  }
});

function mockFetch(respond:(url:string)=>Response) {
  const preconnect=fetch.preconnect;
  return spyOn(globalThis,'fetch').mockImplementation(Object.assign(async(input:Parameters<typeof fetch>[0])=>respond(String(input)),{preconnect}));
}
function manifest(version='2.1.301') {
  return {version,platforms:Object.fromEntries(['darwin-arm64','darwin-x64','linux-arm64','linux-x64','linux-arm64-musl','linux-x64-musl','win32-x64'].map(platform=>
    [platform,{binary:platform.startsWith('win32')?'claude.exe':'claude',checksum:'a'.repeat(64),size:123}]))};
}
for(const channel of ['latest','stable'])test(`native latest lookup uses the proven ${channel} release and validates its manifest`,async()=>{
  const f=fixture(channel);try{
    const target=await discovered(f),urls:string[]=[];
    const fetcher=mockFetch(url=>{urls.push(url);return url===`${base}/${channel}`?new Response('2.1.301\n'):Response.json(manifest());});
    try{expect(await latestCatalogVersion('claude',target)).toBe('2.1.301');expect(urls).toEqual([`${base}/${channel}`,`${base}/2.1.301/manifest.json`]);}
    finally{fetcher.mockRestore();}
  }finally{f.close();}
});
test('native latest lookup rejects unproven channels without falling back to npm',async()=>{
  const f=fixture();try{
    const target=await discovered(f),fetcher=mockFetch(()=>Response.json(manifest()));
    try{await expect(latestCatalogVersion('claude',{...target,sourceUrl:'https://claude.ai/install.sh'})).rejects.toMatchObject({detail:'latest_source_unverified'});expect(fetcher).not.toHaveBeenCalled();}
    finally{fetcher.mockRestore();}
  }finally{f.close();}
});
test('native latest lookup rejects invalid versions manifests and unavailable artifacts',async()=>{
  const f=fixture();try{
    const target=await discovered(f);
    for(const [channel,body] of [['<html>error</html>',manifest()],['2.1.301',manifest('2.1.300')],['2.1.301',{version:'2.1.301',platforms:{}}],['2.1.301',{...manifest(),platforms:{[`${process.platform}-${process.arch}`]:{binary:'claude',checksum:'bad',size:1}}}]]){
      const fetcher=mockFetch(url=>url===`${base}/latest`?new Response(String(channel)):Response.json(body));
      try{await expect(latestCatalogVersion('claude',target)).rejects.toMatchObject({code:'unavailable'});}finally{fetcher.mockRestore();}
    }
  }finally{f.close();}
});
test('Claude npm installations retain their npm release channel',async()=>{
  const fetcher=mockFetch(url=>{expect(url).toBe('https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest');return Response.json({name:'@anthropic-ai/claude-code',version:'2.1.302'});});
  try{expect(await latestCatalogVersion('claude',{kind:'npm',target:'/fixture/lib',executable:'/fixture/bin/claude',manager:'/fixture/bin/npm',packageName:'@anthropic-ai/claude-code',fingerprint:'a'.repeat(64),preserve:[]})).toBe('2.1.302');}
  finally{fetcher.mockRestore();}
});
