import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { catalogDefinitions } from '../../src/app/catalog-registry';
import { discoverUpdate, executeUpdate } from '../../src/app/catalog-update-target';
import type { CatalogId, InstallJob } from '../../src/app/catalog-types';
import { bunOmoEntry } from '../../src/app/omo-installation';
import { AppStore } from '../../src/app/store';
import { createCatalogUpdates } from '../../src/app/catalog-updates';
import { updateIdentity } from '../../src/app/catalog-update-proof';

function fixture() {
  const home=realpathSync(mkdtempSync('/tmp/catalog-update-'));
  function file(path:string,text:string) {mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
  function binary(path:string,version='1.0.0') {file(path,`#!/bin/sh\nprintf '%s\\n' '${version}'\n`);chmodSync(path,0o755);}
  function pkg(container:string,name:string,bin:string) {
    const root=join(container,'node_modules',name);
    file(join(root,'package.json'),JSON.stringify({name,version:'1.0.0',bin:{[bin]:'cli.js'}}));binary(join(root,'cli.js'));return root;
  }
  // Real child processes model only the outer package-manager/network boundary.
  // They require the intended destination arguments before replacing the payload.
  function manager(kind:'npm'|'bun',packageName='@openai/codex') {
    const entry=kind==='npm'?join(home,'manager/npm/bin/npm-cli.js'):join(home,'managers/bun');
    if(kind==='npm')file(join(home,'manager/npm/package.json'),JSON.stringify({name:'npm'}));
    file(entry,`#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const args=process.argv.slice(2), kind=${JSON.stringify(kind)};
const packageName=${JSON.stringify(packageName)};
const value=(name)=>args[args.indexOf(name)+1];
if(args[0]==='root') { console.log(join(value('--prefix'),'lib/node_modules')); process.exit(0); }
if(args[0]==='pm') { console.log(join(process.env.BUN_INSTALL,'bin')); process.exit(0); }
if(args[0]!== (kind==='npm'?'install':'add') || !args.includes('--global') || !args.includes(packageName+'@latest'))process.exit(31);
const container=kind==='npm'?join(value('--prefix'),'lib'):value('--global-dir');
if(kind==='bun'&&value('--global-bin-dir')!==join(process.env.BUN_INSTALL,'bin'))process.exit(32);
const root=join(container,'node_modules',packageName);
const metadata=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
metadata.version='2.0.0';writeFileSync(join(root,'package.json'),JSON.stringify(metadata));
writeFileSync(join(root,'cli.js'),"#!/bin/sh\\nprintf '%s\\\\n' '"+(packageName==='@gajae-code/coding-agent'?'gjc/2.0.0':'2.0.0')+"'\\n");
if(kind==='bun') {
  writeFileSync(join(container,'package.json'),JSON.stringify({dependencies:{[packageName]:'2.0.0'}}));
  writeFileSync(join(container,'bun.lock'),JSON.stringify({workspaces:{'':{dependencies:{[packageName]:'2.0.0'}}},packages:{[packageName]:[packageName+'@2.0.0']}}));
}
writeFileSync(join(container,'command.json'),JSON.stringify({args,home:process.env.HOME,bunInstall:process.env.BUN_INSTALL}));
console.log('Authorization: private-fixture-token');
`);
    chmodSync(entry,0o755);
    if(kind==='npm'){mkdirSync(join(home,'managers'),{recursive:true});symlinkSync(entry,join(home,'managers/npm'));}
    return `${join(home,'managers')}:/usr/bin:/bin`;
  }
  return {home,file,binary,pkg,manager,close:()=>rmSync(home,{recursive:true,force:true})};
}
test.each(['internal','outside'] as const)('verifies a Pi package bin relocation only inside its package (%s)',async(location)=>{
  const f=fixture(),name='@earendil-works/pi-coding-agent',path=f.manager('npm',name);
  const container=join(f.home,'prefix/lib'),root=f.pkg(container,name,'pi'),executable=join(f.home,'prefix/bin/pi');
  mkdirSync(dirname(executable),{recursive:true});symlinkSync(join(root,'cli.js'),executable);
  const options={catalogId:'pi' as const,directory:join(f.home,'state'),home:f.home,path,executable,receipt:null};
  try{
    const target=await discoverUpdate(options);if(!target)throw new Error('missing_target');
    const manager=join(f.home,'manager/npm/bin/npm-cli.js');
    const destination=location==='internal'?join(root,'dist/bundle/cli.js'):join(f.home,'outside.js');
    const script=readFileSync(manager,'utf8');
    writeFileSync(manager,script+`\nconst fs=await import('node:fs');\nfs.mkdirSync(${JSON.stringify(dirname(destination))},{recursive:true});\nfs.renameSync(join(root,'cli.js'),${JSON.stringify(destination)});\nmetadata.bin.pi=${JSON.stringify(location==='internal'?'dist/bundle/cli.js':'../../../../outside.js')};\nfs.writeFileSync(join(root,'package.json'),JSON.stringify(metadata));\nfs.unlinkSync(${JSON.stringify(executable)});\nfs.symlinkSync(${JSON.stringify(destination)},${JSON.stringify(executable)});\n`);
    // Rediscover after preparing the manager, then exercise the real executor boundary.
    const prepared=await discoverUpdate(options);if(!prepared)throw new Error('missing_target');
    if(location==='internal'){
      const identity=updateIdentity(prepared,f.home);
      expect(await executeUpdate(prepared,options)).toBe('2.0.0');
      const store=new AppStore(options.directory);
      try{
        const jobId='11111111-1111-4111-8111-111111111111';
        store.putCatalogUpdate({id:jobId,requestId:'fixture',catalogId:'pi',revision:1,stage:'uncertain',target:prepared,
          identity,execution:'started',executionTarget:null,expectedVersion:null,checkedVersion:'2.0.0',
          createdAt:1,updatedAt:2,beforeVersion:'1.0.0',installedVersion:null,failure:'update_target_changed'});
        const updates=createCatalogUpdates({...options,store,entries:()=>[],changed:()=>{},installedChanged:()=>{},guard:()=>{}},{processes:()=>[]});
        await updates.recover(jobId,1,'reconcile');
        const checked=store.catalogUpdates()[0];
        expect(checked).toMatchObject({stage:'uncertain',reconciliation:{version:'2.0.0'},installedVersion:null});
        if(!checked)throw new Error('missing_job');
        await updates.recover(jobId,checked.revision,'archive-unverified');
        expect(store.catalogUpdates()[0]?.stage).toBe('archived-unverified');
      }finally{store.close();}
    }
    else await expect(executeUpdate(prepared,options)).rejects.toMatchObject({mutationStarted:true});
  }finally{f.close();}
});

test('official Bun OmO shim resolves to one package and supports a verified in-place update',async()=>{
  const f=fixture();
  const container=join(f.home,'.bun/install/global'),root=join(container,'node_modules/omo-ai');
  const entry=join(root,'bin/omo.js'),launcher=join(f.home,'.bun/bin/omo'),manager=join(f.home,'managers/bun');
  const metadata=(version:string)=>JSON.stringify({name:'omo-ai',version,bin:{omo:'bin/omo.js'}});
  const lock=(version:string)=>JSON.stringify({workspaces:{'':{dependencies:{'omo-ai':version}}},packages:{'omo-ai':[`omo-ai@${version}`]}});
  try{
    f.binary(entry);
    f.file(join(root,'package.json'),metadata('1.0.0'));
    f.file(join(container,'package.json'),JSON.stringify({dependencies:{'omo-ai':'1.0.0'}}));
    f.file(join(container,'bun.lock'),lock('1.0.0'));
    const shim=`#!/bin/sh\n# omo-ai bun launcher shim v1 - generated by omo-ai; safe to delete, the next launch recreates it\n# entry: ${entry}\nif [ "$OMO_RUNTIME" != "node" ] && [ -x '${manager}' ]; then exec '${manager}' '${entry}' "$@"; fi\nexec '${entry}' "$@"\n`;
    f.file(launcher,shim);chmodSync(launcher,0o755);
    f.file(manager,`#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='pm'){console.log(${JSON.stringify(dirname(launcher))});process.exit(0);}
if(args[0]!=='add'||!args.includes('omo-ai@latest')||args[args.indexOf('--global-dir')+1]!==${JSON.stringify(container)})process.exit(32);
writeFileSync(${JSON.stringify(join(root,'package.json'))},${JSON.stringify(metadata('2.0.0'))});
writeFileSync(${JSON.stringify(entry)},"#!/bin/sh\\necho 2.0.0\\n");
writeFileSync(${JSON.stringify(join(container,'package.json'))},JSON.stringify({dependencies:{'omo-ai':'2.0.0'}}));
writeFileSync(${JSON.stringify(join(container,'bun.lock'))},${JSON.stringify(lock('2.0.0'))});
`);
    chmodSync(manager,0o755);
    const options={catalogId:'omo' as const,executable:launcher,receipt:null,directory:join(f.home,'state'),home:f.home,path:dirname(manager)+':/usr/bin:/bin'};
    expect(bunOmoEntry(launcher,f.home)).toBe(entry);
    const target=await discoverUpdate(options);if(!target)throw new Error('Bun shim not discovered');
    expect(target.kind).toBe('bun');
    expect(await executeUpdate(target,options)).toBe('2.0.0');
    expect(readFileSync(launcher,'utf8')).toBe(shim);
    expect(await discoverUpdate({...options,executable:entry})).not.toBeNull();
    f.file(launcher,shim+'echo untrusted\n');
    expect(bunOmoEntry(launcher,f.home)).toBeNull();
    expect(await discoverUpdate(options)).toBeNull();
  }finally{f.close();}
});
function owned(f:ReturnType<typeof fixture>,catalogId:CatalogId='maki') {
  const definition=catalogDefinitions.find(row=>row.id===catalogId);if(!definition?.recipe)throw new Error('fixture_recipe_missing');
  const id='11111111-1111-4111-8111-111111111111',directory=join(f.home,'state');
  const target=join(directory,'cli-installs',`${catalogId}-${id}`),executable=join(target,definition.recipe.bin);
  f.binary(executable);
  if(definition.recipe.kind==='npm') {
    unlinkSync(executable);const root=f.pkg(join(target,'lib'),definition.recipe.package,definition.executable);symlinkSync(join(root,'cli.js'),executable);
  }
  f.file(join(f.home,'.config/auth'),'user credential');f.file(join(f.home,'.senpi/conversation'),'user conversation');
  f.file(join(target,'.installer-home/.config/auth'),'installer credential');f.file(join(target,'notes'),'user notes');
  const receipt:InstallJob={id,requestId:'fixture',catalogId,revision:1,stage:'completed',sourceUrl:definition.sourceUrl,method:definition.method,
    target,recipeHash:createHash('sha256').update(JSON.stringify(definition.recipe)).digest('hex'),createdAt:0,updatedAt:0,installedVersion:'1.0.0',executablePath:executable,failure:null,log:[]};
  return {catalogId,directory,target,executable,receipt,home:f.home,path:'/usr/bin:/bin'};
}
function officialScript(text:string,before?:()=>void) {
  return spyOn(globalThis,'fetch').mockImplementation(Object.assign(async()=>{
    before?.();
    const response=new Response(text);Object.defineProperty(response,'url',{value:'https://maki.sh/install.sh'});return response;
  },{preconnect:fetch.preconnect}));
}
const replacement=`printf '#!/bin/sh\\nprintf "2.0.0\\\\n"\\n' > "$MAKI_INSTALL_DIR/maki"\nchmod +x "$MAKI_INSTALL_DIR/maki"\nprintf 'private-fixture-token\\n'\n`;

test('discovers exactly update-capable owned recipes and rejects missing or altered receipts',async()=>{
  // Given an app receipt for every catalog identity, including unsupported layouts.
  const f=fixture();try {
    for(const definition of catalogDefinitions) {
      const options=owned(f,definition.id);
      // When provenance is checked, support follows the host and upgrade contract.
      const supported=!['agy','cursor','grok','hermes'].includes(definition.id)&&(definition.id!=='kiro'||process.platform==='darwin');
      expect((await discoverUpdate(options))?.kind??null).toBe(supported?'owned':null);
    }
    const options=owned(f);
    // Then neither a missing receipt nor another recipe authorizes native updates.
    expect(await discoverUpdate({...options,receipt:null})).toBeNull();
    expect(await discoverUpdate({...options,receipt:{...options.receipt,recipeHash:'changed'}})).toBeNull();
    expect(await discoverUpdate({...options,receipt:{...options.receipt,target:f.home}})).toBeNull();
  }finally{f.close();}
});

test('updates an existing owned executable, verifies the new version and preserves user files',async()=>{
  const f=fixture(),options=owned(f),events:string[]=[];
  const target=await discoverUpdate(options);if(!target)throw new Error('missing_target');
  const before=lstatSync(options.target),fetcher=officialScript(replacement);
  try {
    // When the official network boundary supplies a real replacement script.
    expect(await executeUpdate(target,options,event=>events.push(event))).toBe('2.0.0');
    // Then the same installation is used and only trusted progress is exposed.
    expect(lstatSync(options.target).ino).toBe(before.ino);
    expect(events.at(-1)).toBe('update_verified');expect(events.join(' ')).not.toContain('private-fixture-token');
    expect(readFileSync(join(f.home,'.config/auth'),'utf8')).toBe('user credential');
    expect(readFileSync(join(f.home,'.senpi/conversation'),'utf8')).toBe('user conversation');
    expect(readFileSync(join(options.target,'.installer-home/.config/auth'),'utf8')).toBe('installer credential');
    expect(readFileSync(join(options.target,'notes'),'utf8')).toBe('user notes');
    expect(await discoverUpdate(options)).not.toBeNull();
  }finally{fetcher.mockRestore();f.close();}
});

for(const duringDownload of [false,true])test(`refuses changed source ${duringDownload?'after download':'before execution'} without running the installer`,async()=>{
  const f=fixture(),options=owned(f),target=await discoverUpdate(options);if(!target)throw new Error('missing_target');
  const marker=join(options.target,'executed');
  const mutate=()=>f.binary(options.executable,'9.0.0');
  if(!duringDownload)mutate();
  const fetcher=officialScript(`touch "${marker}"`,duringDownload?mutate:undefined);
  try {
    // When the previously proven payload is replaced.
    await expect(executeUpdate(target,options)).rejects.toMatchObject({detail:'removal_target_changed',mutationStarted:duringDownload});
    // Then the installer never crosses the write boundary.
    expect(existsSync(marker)).toBe(false);
  }finally{fetcher.mockRestore();f.close();}
});

for(const action of ['bad-version','redirect','installer-failure'] as const)test(`does not report success after ${action}`,async()=>{
  const f=fixture(),options=owned(f),events:string[]=[],target=await discoverUpdate(options);if(!target)throw new Error('missing_target');
  const other=join(options.target,'other');f.binary(other,'8.0.0');
  const script=action==='bad-version'?`printf '#!/bin/sh\\necho unknown\\n' > "$MAKI_INSTALL_DIR/maki"`
    :action==='redirect'?`rm "$MAKI_INSTALL_DIR/maki"; ln -s "${other}" "$MAKI_INSTALL_DIR/maki"`:'exit 23';
  const fetcher=officialScript(script);
  try {
    // When a script exits successfully without a valid version or replaces the identity.
    await expect(executeUpdate(target,options,event=>events.push(event))).rejects.toMatchObject({mutationStarted:true});
    // Then completion is withheld, including for a nonzero installer exit.
    expect(events).not.toContain('update_verified');
  }finally{fetcher.mockRestore();f.close();}
});

test('rejects a writable installer home redirected into user configuration',async()=>{
  const f=fixture(),options=owned(f),target=await discoverUpdate(options);if(!target)throw new Error('missing_target');
  rmSync(join(options.target,'.installer-home'),{recursive:true});symlinkSync(f.home,join(options.target,'.installer-home'));
  try {
    // When un-fingerprinted installer state redirects writes outside the prefix.
    await expect(executeUpdate(target,options)).rejects.toThrow('update_target_changed');
    // Then user configuration is untouched.
    expect(readFileSync(join(f.home,'.config/auth'),'utf8')).toBe('user credential');
  }finally{f.close();}
});

for(const kind of ['npm','bun','owned'] as const)test(`updates proven ${kind} source using the exact manager destination`,async()=>{
  const f=fixture(),path=f.manager(kind==='bun'?'bun':'npm');
  const options=kind==='owned'?{...owned(f,'codex'),path}:(()=>{
    const container=kind==='bun'?join(f.home,'.bun/install/global'):join(f.home,'prefix/lib');
    const root=f.pkg(container,'@openai/codex','codex');f.pkg(container,'unrelated','other');
    const executable=join(kind==='bun'?join(f.home,'.bun'):dirname(container),'bin/codex');
    mkdirSync(dirname(executable),{recursive:true});symlinkSync(join(root,'cli.js'),executable);
    if(kind==='bun') {
      f.file(join(container,'package.json'),JSON.stringify({dependencies:{'@openai/codex':'1.0.0'}}));
      f.file(join(container,'bun.lock'),JSON.stringify({workspaces:{'':{dependencies:{'@openai/codex':'1.0.0'}}},packages:{'@openai/codex':['@openai/codex@1.0.0']}}));
    }
    return {catalogId:'codex' as const,directory:join(f.home,'state'),home:f.home,path,executable,receipt:null};
  })();
  f.file(join(f.home,'.npmrc'),'user credential');
  try {
    const target=await discoverUpdate(options);expect(target?.kind).toBe(kind);if(!target)throw new Error('missing_target');
    // When the package manager replaces a real executable in its proven prefix.
    expect(await executeUpdate(target,options)).toBe('2.0.0');
    // Then neither ambient HOME nor another installation is used.
    const container=kind==='owned'?join(target.target,'lib'):target.target;
    const record:unknown=JSON.parse(readFileSync(join(container,'command.json'),'utf8'));
    expect(record).toMatchObject({home:expect.not.stringMatching(new RegExp(`^${f.home}$`))});
    expect(readFileSync(join(f.home,'.npmrc'),'utf8')).toBe('user credential');
    expect(existsSync(join(container,'node_modules/unrelated/package.json'))).toBe(kind!=='owned');
  }finally{f.close();}
});

for(const kind of ['npm','bun'] as const)test(`updates the ${kind} installation while an already loaded consumer keeps running`,async()=>{
  const f=fixture(),path=f.manager(kind),container=kind==='bun'?join(f.home,'.bun/install/global'):join(f.home,'prefix/lib');
  const root=f.pkg(container,'@openai/codex','codex');
  const executable=join(kind==='bun'?join(f.home,'.bun'):dirname(container),'bin/codex');
  let child:ReturnType<typeof Bun.spawn>|undefined;
  try{
    // Given a real process that captures its launch version before the install changes.
    mkdirSync(dirname(executable),{recursive:true});symlinkSync(join(root,'cli.js'),executable);
    f.file(join(root,'cli.js'),`#!${process.execPath}\nconst version='1.0.0';if(process.argv.includes('--version')){console.log(version);}else{process.stdin.resume();process.stdin.on('data',()=>console.log(version));console.log(version);}\n`);
    if(kind==='bun'){
      f.file(join(container,'package.json'),JSON.stringify({dependencies:{'@openai/codex':'1.0.0'}}));
      f.file(join(container,'bun.lock'),JSON.stringify({workspaces:{'':{dependencies:{'@openai/codex':'1.0.0'}}},packages:{'@openai/codex':['@openai/codex@1.0.0']}}));
    }
    const options={catalogId:'codex' as const,directory:join(f.home,'state'),home:f.home,path,executable,receipt:null};
    const consumer=Bun.spawn([process.execPath,realpathSync(executable)],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});child=consumer;
    const reader=consumer.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('1.0.0\n');
    const target=await discoverUpdate(options);if(!target)throw new Error('missing_target');
    // When the real isolated manager replaces the package and verifies a fresh launch.
    expect(await executeUpdate(target,options)).toBe('2.0.0');
    const reply=reader.read();consumer.stdin.write('version\n');consumer.stdin.flush();
    // Then the old process still answers from its launch state, without a restart.
    expect(new TextDecoder().decode((await reply).value)).toBe('1.0.0\n');
    expect(consumer.exitCode).toBeNull();reader.releaseLock();
  }finally{if(child){child.kill();await child.exited;}f.close();}
});

for(const kind of ['npm','bun'] as const)test(`updates GJC through its existing ${kind} package rather than the standalone installer`,async()=>{
  const f=fixture(),packageName='@gajae-code/coding-agent',path=f.manager(kind,packageName);
  const container=kind==='bun'?join(f.home,'.bun/install/global'):join(f.home,'prefix/lib');
  const root=f.pkg(container,packageName,'gjc');
  const executable=join(kind==='bun'?join(f.home,'.bun'):dirname(container),'bin/gjc');
  mkdirSync(dirname(executable),{recursive:true});symlinkSync(join(root,'cli.js'),executable);
  if(kind==='bun'){
    f.file(join(container,'package.json'),JSON.stringify({dependencies:{[packageName]:'1.0.0'}}));
    f.file(join(container,'bun.lock'),JSON.stringify({workspaces:{'':{dependencies:{[packageName]:'1.0.0'}}},packages:{[packageName]:[packageName+'@1.0.0']}}));
  }
  f.file(join(f.home,'.gajae/session'),'preserve');
  const options={catalogId:'gjc' as const,directory:join(f.home,'state'),home:f.home,path,executable,receipt:null};
  try{
    const target=await discoverUpdate(options);if(!target)throw new Error('missing GJC target');
    expect(target.kind).toBe(kind);
    expect(await executeUpdate(target,options)).toBe('2.0.0');
    expect(readFileSync(join(f.home,'.gajae/session'),'utf8')).toBe('preserve');
    expect(realpathSync(executable)).toBe(join(root,'cli.js'));
  }finally{f.close();}
});
test('rejects mismatched catalog identity before a package update',async()=>{
  const f=fixture(),options={...owned(f,'codex'),path:f.manager('npm')};
  try {
    const target=await discoverUpdate(options);if(!target)throw new Error('missing_target');
    // When the caller supplies another family for a proven installation.
    await expect(executeUpdate(target,{...options,catalogId:'claude'})).rejects.toThrow('update_target_changed');
    // Then no package-manager command ran.
    expect(existsSync(join(options.target,'lib/command.json'))).toBe(false);
  }finally{f.close();}
});

test('rejects manager mutation at the final execution boundary',async()=>{
  const f=fixture(),options={...owned(f,'codex'),path:f.manager('npm')};
  try {
    const target=await discoverUpdate(options);if(!target)throw new Error('missing_target');
    // When the manager changes after validation but before the write boundary.
    await expect(executeUpdate(target,options,event=>{
      if(event==='installer_started')f.file(join(f.home,'manager/npm/bin/npm-cli.js'),'changed manager');
    })).rejects.toThrow('update_target_changed');
    // Then the replacement manager never executes.
    expect(existsSync(join(options.target,'lib/command.json'))).toBe(false);
  }finally{f.close();}
});

test('rejects unsupported host platforms before execution',async()=>{
  const f=fixture(),options=owned(f),target=await discoverUpdate(options);if(!target)throw new Error('missing_target');
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform');if(!descriptor)throw new Error('platform_descriptor');
  try {
    // When a persisted target is executed on a different, unsupported host.
    Object.defineProperty(process,'platform',{value:'win32'});
    expect(await discoverUpdate(options)).toBeNull();
    await expect(executeUpdate(target,options)).rejects.toThrow('manual_update_required');
  }finally{Object.defineProperty(process,'platform',descriptor);f.close();}
});
