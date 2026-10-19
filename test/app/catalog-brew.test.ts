import { expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { brewTargetSchema, discoverBrewTarget, executeBrewRemoval, executeBrewUpdate, latestBrewVersion, validateBrewTarget } from '../../src/app/catalog-brew';
import type { BrewTarget } from '../../src/app/catalog-brew';
import { AppStore } from '../../src/app/store';
import { createCatalogUpdates } from '../../src/app/catalog-updates';

function fixture(kind:'formula'|'cask'='formula',splitRepository=false,sourceTap?:string) {
  const directory=realpathSync(mkdtempSync('/tmp/catalog-brew-')),home=join(directory,'home'),prefix=join(directory,'brew');
  const repository=splitRepository?join(prefix,'Homebrew'):prefix,manager=join(prefix,'bin/brew'),executable=join(prefix,'bin/codex');
  const control=join(directory,'control.json'),log=join(directory,'commands.jsonl');
  const initial=kind==='formula'?'1.0.0_1':'1.0.0',latest=kind==='formula'?'2.0.0_2':'2.0.0';
  const payloadRoot=join(prefix,kind==='formula'?'Cellar':'Caskroom','codex',initial);
  const receipt=kind==='formula'?join(payloadRoot,'INSTALL_RECEIPT.json'):join(prefix,'Caskroom/codex/.metadata/INSTALL_RECEIPT.json');
  const definition=kind==='formula'?join(payloadRoot,'.brew/codex.rb'):join(prefix,'Caskroom/codex/.metadata',initial,'20261011000000.000/Casks/codex.json');
  const tap=sourceTap??(kind==='formula'?'homebrew/core':'homebrew/cask');
  function file(path:string,text:string){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
  function binary(path:string,text:string){file(path,text);chmodSync(path,0o755);}
  function install(version:string) {
    const root=join(prefix,kind==='formula'?'Cellar':'Caskroom','codex',version);
    binary(join(root,'bin/codex'),'#!/bin/sh\necho '+version.split('_')[0]+'\n');
    if(kind==='formula') {
      file(join(root,'INSTALL_RECEIPT.json'),JSON.stringify({homebrew_version:'5.0.0',source:{tap,path:'/build/Formula/c/codex.rb',spec:'stable',versions:{stable:version.split('_')[0],version_scheme:0}}}));
      file(join(root,'.brew/codex.rb'),`class Codex < Formula\n version "${version.split('_')[0]}"\nend\n`);
      mkdirSync(join(prefix,'opt'),{recursive:true});symlinkSync(root,join(prefix,'opt/codex'));
    } else {
      const metadata=join(prefix,'Caskroom/codex/.metadata'),artifacts=[{binary:['bin/codex']},{zap:[{trash:'~/.codex'}]}];
      file(join(metadata,'INSTALL_RECEIPT.json'),JSON.stringify({homebrew_version:'5.0.0',source:{tap,path:'/build/Casks/c/codex.rb',version},uninstall_flight_blocks:false,uninstall_artifacts:artifacts}));
      file(join(metadata,version,'20261011000000.000/Casks/codex.json'),JSON.stringify({token:'codex',tap,version,artifacts}));
    }
    mkdirSync(dirname(executable),{recursive:true});symlinkSync(join(root,'bin/codex'),executable);
  }
  mkdirSync(home);install(initial);file(control,'{}');
  file(join(home,'.codex/auth.json'),'credential');file(join(home,'.codex/sessions/history'),'conversation');
  file(join(prefix,'unrelated/keep'),'unrelated');file(join(prefix,'etc/user.conf'),'config');
  file(join(repository,'Library/Homebrew/brew.rb'),'# inert fixture Ruby entry\n');
  file(join(repository,'Library/Homebrew/brew.sh'),'# inert fixture shell entry\n');
  // A real inert child process: only the temp fixture can be changed, and argv/env
  // must match the exact package/prefix contract before any payload write.
  file(join(repository,'Library/Homebrew/fixture.js'),`
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,chmodSync,symlinkSync,unlinkSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {dirname,join,basename} from 'node:path';
const prefix=${JSON.stringify(prefix)},repository=${JSON.stringify(repository)},home=${JSON.stringify(home)};
const kind=${JSON.stringify(kind)},control=${JSON.stringify(control)},log=${JSON.stringify(log)},executable=${JSON.stringify(executable)};
const flags=JSON.parse(readFileSync(control,'utf8')),args=process.argv.slice(2);
appendFileSync(log,JSON.stringify({args,entry:process.env.BREW_FIXTURE_ENTRY,env:process.env})+'\\n');
if(process.env.BREW_FIXTURE_ENTRY!==join(prefix,'bin/brew'))process.exit(70);
if(process.env.HOME!==home)process.exit(71);
for(const key of ['HOMEBREW_NO_AUTO_UPDATE','HOMEBREW_NO_ANALYTICS','HOMEBREW_NO_INSTALL_CLEANUP','HOMEBREW_NO_AUTOREMOVE'])
  if(process.env[key]!=='1')process.exit(72);
if(args[0]==='--prefix'){console.log(flags.prefix??prefix);process.exit(0);}
if(args[0]==='--repository'){console.log(flags.repository??repository);process.exit(0);}
if(args[0]==='--cellar'||args[0]==='--caskroom'){console.log(flags.container??join(prefix,kind==='formula'?'Cellar':'Caskroom'));process.exit(0);}
const root=dirname(dirname(realpathSync(executable))),version=basename(root);
const receipt=kind==='formula'?join(root,'INSTALL_RECEIPT.json'):join(prefix,'Caskroom/codex/.metadata/INSTALL_RECEIPT.json');
const tab=JSON.parse(readFileSync(receipt,'utf8')),tap=tab.source.tap;
// A third-party tap that is no longer tapped: brew only knows the keg by its bare name.
const tapped=tap.startsWith('homebrew/')||existsSync(join(prefix,'Library/Taps',tap.split('/')[0],'homebrew-'+tap.split('/')[1]));
const full=tap===(kind==='formula'?'homebrew/core':'homebrew/cask')?'codex':tap+'/codex';
const reference=tapped?full:'codex';
if(args[0]==='info'){
  if(!tapped&&args[3]===full){console.error('Error: No available formula with the name "'+full+'".');process.exit(1);}
  if(JSON.stringify(args)!==JSON.stringify(['info','--json=v2','--'+kind,reference]))process.exit(73);
  if(flags.redirectReceipt){unlinkSync(receipt);symlinkSync(flags.redirectReceipt,receipt);}
  console.log(JSON.stringify(kind==='formula'?{formulae:[{name:'codex',full_name:reference,tap:tapped?tap:'homebrew/core',installed:[{version:flags.infoVersion??version}]}]}:
    {casks:[{token:'codex',full_token:full,tap,installed:flags.infoVersion??version,artifacts:flags.artifacts??tab.uninstall_artifacts}]}));
  process.exit(0);
}
if(!['upgrade','uninstall'].includes(args[0])||JSON.stringify(args.slice(1))!==JSON.stringify(['--'+kind,reference]))process.exit(74);
if(flags.fail)process.exit(23);
if(args[0]==='uninstall'){
  unlinkSync(executable);rmSync(root,{recursive:true});console.log('private-fixture-token');process.exit(0);
}
const next=flags.version??${JSON.stringify(latest)},nextRoot=join(prefix,kind==='formula'?'Cellar':'Caskroom','codex',next);
mkdirSync(join(nextRoot,'bin'),{recursive:true});
writeFileSync(join(nextRoot,'bin/codex'),'#!/bin/sh\\necho '+(flags.binaryVersion??next.split('_')[0])+'\\n');chmodSync(join(nextRoot,'bin/codex'),0o755);
if(flags.sourceTap)tab.source.tap=flags.sourceTap;
if(kind==='formula'){
  tab.source.versions.stable=next.split('_')[0];
  writeFileSync(join(nextRoot,'INSTALL_RECEIPT.json'),JSON.stringify(tab));
  mkdirSync(join(nextRoot,'.brew'));writeFileSync(join(nextRoot,'.brew/codex.rb'),'class Codex < Formula\\nend\\n');
  unlinkSync(join(prefix,'opt/codex'));symlinkSync(nextRoot,join(prefix,'opt/codex'));
}else{
  tab.source.version=next;writeFileSync(receipt,JSON.stringify(tab));
  const casks=join(prefix,'Caskroom/codex/.metadata',next,'20261012000000.000/Casks');
  mkdirSync(casks,{recursive:true});writeFileSync(join(casks,'codex.json'),JSON.stringify({token:'codex',tap:tab.source.tap,version:next,artifacts:tab.uninstall_artifacts}));
}
unlinkSync(executable);symlinkSync(flags.redirectExecutable??join(nextRoot,'bin/codex'),executable);
console.log('private-fixture-token');
`);
  binary(join(repository,'bin/brew'),`#!/bin/sh
export BREW_FIXTURE_ENTRY="$0"
exec "${process.execPath}" "${join(repository,'Library/Homebrew/fixture.js')}" "$@"
`);
  if(splitRepository)symlinkSync(join(repository,'bin/brew'),manager);
  const options={catalogId:'codex' as const,home,path:join(prefix,'bin')+':/usr/bin:/bin',executable};
  const configure=(value:Record<string,unknown>)=>file(control,JSON.stringify(value));
  const latestData=kind==='formula'?{name:'codex',full_name:'codex',tap,versions:{stable:'2.0.0'},revision:2,version_scheme:0}
    :{token:'codex',full_token:'codex',tap,version:'2.0.0',artifacts:[{binary:['bin/codex']},{zap:[{trash:'~/.codex'}]}]};
  const metadata=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
  const commands=():{args:string[];entry:string;env:Record<string,string>}[]=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
  async function target():Promise<BrewTarget>{const result=await discoverBrewTarget(options);if(!result)throw new Error('fixture_not_discovered');return result;}
  return {directory,home,prefix,repository,manager,executable,payloadRoot,receipt,definition,initial,latest,latestData,options,
    file,binary,configure,metadata,commands,target,close:()=>rmSync(directory,{recursive:true,force:true})};
}
function latestResponse(data:unknown,before?:()=>void) {
  const urls:string[]=[];
  const mock=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async(input:string|URL|Request)=>{
    urls.push(String(input));before?.();return new Response(JSON.stringify(data));
  },{preconnect:fetch.preconnect}));
  return {urls,close:()=>mock.mockRestore()};
}

for(const kind of ['formula','cask'] as const)test(`discovers a receipt-backed ${kind} with stable paths and installed version evidence`,async()=>{
  // Given an explicitly available, inert Homebrew manager and installed receipts.
  const f=fixture(kind);
  try {
    // When discovery follows the physical payload but returns stable logical paths.
    const target=await f.target();
    // Then all public fields and receipt witnesses agree and survive schema parsing.
    expect(brewTargetSchema.parse(target)).toEqual(target);
    expect(target).toMatchObject({kind:'brew',target:f.prefix,executable:f.executable,manager:f.manager,
      packageName:'codex',packageKind:kind,payloadRoot:f.payloadRoot,preserve:[f.home],receiptPaths:[f.receipt,f.definition]});
    expect(()=>validateBrewTarget(target)).not.toThrow();
    expect(f.commands().some(row=>row.args[0]==='info')).toBe(true);
  }finally{f.close();}
});
test('discovers an opt executable and a split repository without canonicalizing the manager invocation',async()=>{
  const f=fixture('formula',true);
  try {
    // Given a stable opt path and prefix/bin/brew linked into prefix/Homebrew.
    const executable=join(f.prefix,'opt/codex/bin/codex');
    // When discovery probes that manager.
    const target=await discoverBrewTarget({...f.options,executable});
    // Then prefix, opt path, and linked manager remain logical identities.
    expect(target).toMatchObject({target:f.prefix,executable,manager:f.manager,payloadRoot:f.payloadRoot});
    expect(f.commands().every(row=>row.entry===f.manager)).toBe(true);
  }finally{f.close();}
});
test('resolves the selected installation manager even when it is absent from PATH',async()=>{
  const f=fixture();
  try {
    // Given an explicitly selected receipt-backed installation outside caller PATH.
    const options={...f.options,path:''};
    // When discovery is requested.
    expect(await discoverBrewTarget(options)).toMatchObject({kind:'brew',manager:f.manager,target:f.prefix});
    expect(f.commands().length).toBeGreaterThan(0);
    expect(f.commands().every(row=>row.entry===f.manager)).toBe(true);
  }finally{f.close();}
});
for(const field of ['prefix','repository','container','infoVersion'] as const)test(`rejects manager ${field} evidence for a different destination`,async()=>{
  const f=fixture();
  try {
    // Given a manager that reports evidence for a different installation.
    f.configure({[field]:field==='infoVersion'?'9.0.0':join(f.directory,'other')});
    // When discovery probes its identity.
    expect(await discoverBrewTarget(f.options)).toBeNull();
    // Then it never attempts a lifecycle write.
    expect(f.commands().some(row=>['upgrade','uninstall'].includes(row.args[0]??''))).toBe(false);
  }finally{f.close();}
});
for(const kind of ['formula','cask'] as const)for(const action of ['missing','redirect','wrong-source'] as const)
test(`rejects a ${action} ${kind} receipt rather than trusting its pathname`,async()=>{
  const f=fixture(kind);
  try {
    // Given absent, redirected, or inconsistent installed metadata.
    if(action==='missing')unlinkSync(f.receipt);
    if(action==='redirect'){renameSync(f.receipt,f.receipt+'.elsewhere');symlinkSync(f.receipt+'.elsewhere',f.receipt);}
    if(action==='wrong-source'){const data=f.metadata(f.receipt);data.source[kind==='formula'?'spec':'version']='wrong';f.file(f.receipt,JSON.stringify(data));}
    // When discovery checks ownership.
    expect(await discoverBrewTarget(f.options)).toBeNull();
  }finally{f.close();}
});
for(const artifact of [{app:['ChatGPT.app']},{app:['Visual Studio Code.app']},{binary:['Editor.app/Contents/Resources/bin/codex']},
  {bash_completion:['completion.sh',{target:'/tmp/user-config'}]},
  {uninstall:[{delete:'~/.codex'}]},{postflight:null}])
test(`rejects GUI or imperative cask artifact ${JSON.stringify(artifact)}`,async()=>{
  const f=fixture('cask');
  try {
    // Given a package that also owns a GUI or arbitrary uninstall behavior.
    const data=f.metadata(f.definition);data.artifacts.push(artifact);f.file(f.definition,JSON.stringify(data));
    // When discovery checks the full installed artifact set.
    expect(await discoverBrewTarget(f.options)).toBeNull();
  }finally{f.close();}
});
for(const mutation of ['receipt','definition','manager','manager-link','payload','link','opt','receipt-parent'] as const)
test(`synchronous validation detects ${mutation} changes before mutation`,async()=>{
  const f=fixture('formula',true);
  try {
    // Given a pinned target.
    const target=await f.target();
    switch(mutation) {
      case 'receipt':f.file(f.receipt,readFileSync(f.receipt,'utf8')+' ');break;
      case 'definition':f.file(f.definition,'class Replacement\nend\n');break;
      case 'manager':f.file(join(f.repository,'bin/brew'),'#!/bin/sh\nexit 0\n');break;
      case 'manager-link':unlinkSync(f.manager);symlinkSync('/bin/echo',f.manager);break;
      case 'payload':f.binary(realpathSync(f.executable),'#!/bin/sh\necho 9.0.0\n');break;
      case 'link':unlinkSync(f.executable);symlinkSync('/bin/echo',f.executable);break;
      case 'opt':unlinkSync(join(f.prefix,'opt/codex'));symlinkSync(f.home,join(f.prefix,'opt/codex'));break;
      case 'receipt-parent':renameSync(f.payloadRoot,f.payloadRoot+'-other');symlinkSync(f.payloadRoot+'-other',f.payloadRoot);break;
    }
    // When the stored proof is synchronously checked, no external process is needed.
    expect(()=>validateBrewTarget(target)).toThrow('brew_target_changed');
  }finally{f.close();}
});
for(const kind of ['formula','cask'] as const)test(`updates ${kind} into a fresh physical payload and preserves user files`,async()=>{
  const f=fixture(kind),http=latestResponse(f.latestData),events:string[]=[];
  try {
    // Given an old installed version and a provider-matching latest response.
    const target=await f.target(),original=realpathSync(f.executable),prefixInode=lstatSync(f.prefix).ino;
    // When the real inert manager installs and links a new version.
    expect(await executeBrewUpdate(target,f.options,event=>events.push(event))).toBe(f.latest);
    // Then verification follows the new receipt rather than old canonical equality.
    expect(realpathSync(f.executable)).not.toBe(original);expect(lstatSync(f.prefix).ino).toBe(prefixInode);
    expect(f.commands().filter(row=>row.args[0]==='upgrade').map(row=>row.args)).toEqual([['upgrade',`--${kind}`,'codex']]);
    expect(http.urls).toEqual([`https://formulae.brew.sh/api/${kind}/codex.json`]);
    expect(events.at(-1)).toBe('update_verified');expect(events.join(' ')).not.toContain('private-fixture-token');
    expect(readFileSync(join(f.home,'.codex/auth.json'),'utf8')).toBe('credential');
    expect(readFileSync(join(f.home,'.codex/sessions/history'),'utf8')).toBe('conversation');
    expect(readFileSync(join(f.prefix,'unrelated/keep'),'utf8')).toBe('unrelated');
    expect(readFileSync(join(f.prefix,'etc/user.conf'),'utf8')).toBe('config');
  }finally{http.close();f.close();}
});
for(const kind of ['formula','cask'] as const)test(`removes only the exact ${kind} and keeps configuration and unrelated packages`,async()=>{
  const f=fixture(kind);
  try {
    // Given a proven target alongside user data and another installation.
    const target=await f.target();
    // When removal invokes the manager with an exact package and explicit kind.
    await executeBrewRemoval(target,f.options);
    // Then no force, zap, dependency removal, or cleanup was requested.
    expect(f.commands().filter(row=>row.args[0]==='uninstall').map(row=>row.args)).toEqual([['uninstall',`--${kind}`,'codex']]);
    expect(existsSync(f.executable)).toBe(false);
    expect(readFileSync(join(f.home,'.codex/auth.json'),'utf8')).toBe('credential');
    expect(readFileSync(join(f.home,'.codex/sessions/history'),'utf8')).toBe('conversation');
    expect(readFileSync(join(f.prefix,'unrelated/keep'),'utf8')).toBe('unrelated');
    expect(readFileSync(join(f.prefix,'etc/user.conf'),'utf8')).toBe('config');
  }finally{f.close();}
});
test('a formula whose third-party tap was untapped is verified and uninstalled by its keg name',async()=>{
  const f=fixture('formula',false,'sst/tap');
  try {
    const target=await f.target();expect(target.packageName).toBe('sst/tap/codex');
    await executeBrewRemoval(target,f.options);
    expect(f.commands().filter(row=>row.args[0]==='info').map(row=>row.args[3])).toEqual(expect.arrayContaining(['codex']));
    expect(f.commands().filter(row=>row.args[0]==='info').some(row=>row.args[3]==='sst/tap/codex')).toBe(false);
    expect(f.commands().find(row=>row.args[0]==='uninstall')?.args).toEqual(['uninstall','--formula','codex']);
    expect(existsSync(f.executable)).toBe(false);
  }finally{f.close();}
});
test('a third-party formula whose tap is still present keeps the strict full-name query',async()=>{
  const f=fixture('formula',false,'sst/tap');
  try {
    mkdirSync(join(f.prefix,'Library/Taps/sst/homebrew-tap'),{recursive:true});
    const target=await f.target();
    await executeBrewRemoval(target,f.options);
    expect(f.commands().filter(row=>row.args[0]==='info').every(row=>row.args[3]==='sst/tap/codex')).toBe(true);
    expect(f.commands().find(row=>row.args[0]==='uninstall')?.args).toEqual(['uninstall','--formula','sst/tap/codex']);
  }finally{f.close();}
});
test('rechecks receipt redirection by the final metadata child before invoking uninstall',async()=>{
  const f=fixture();
  try {
    // Given a receipt that will be redirected during a metadata probe.
    const target=await f.target(),other=join(f.directory,'foreign-receipt.json');
    f.file(other,readFileSync(f.receipt,'utf8'));f.configure({redirectReceipt:other});
    // When the awaited info process creates the redirect before returning.
    await expect(executeBrewRemoval(target,f.options)).rejects.toThrow('brew_target_changed');
    // Then the real uninstall child never starts and the foreign file survives.
    expect(f.commands().some(row=>row.args[0]==='uninstall')).toBe(false);
    expect(readFileSync(other,'utf8')).toContain('"stable"');
  }finally{f.close();}
});
test('reprobes the manager destination after the latest network boundary',async()=>{
  const f=fixture(),http=latestResponse(f.latestData,()=>f.configure({prefix:join(f.directory,'foreign-prefix')}));
  try {
    // Given a proven manager whose destination changes while fetching latest.
    const target=await f.target();
    // When upgrade reaches its final destination probe.
    await expect(executeBrewUpdate(target,f.options)).rejects.toThrow('brew_target_changed');
    // Then it never invokes the write command.
    expect(f.commands().some(row=>row.args[0]==='upgrade')).toBe(false);
  }finally{http.close();f.close();}
});
test('checks provenance after installer_started callbacks and before spawn',async()=>{
  const f=fixture(),http=latestResponse(f.latestData);
  try {
    // Given a progress subscriber that redirects the executable at the boundary.
    const target=await f.target();
    // When progress fires synchronously, the final pinned proof must still apply.
    await expect(executeBrewUpdate(target,f.options,event=>{
      if(event==='installer_started'){unlinkSync(f.executable);symlinkSync('/bin/echo',f.executable);}
    })).rejects.toThrow('brew_target_changed');
    expect(f.commands().some(row=>row.args[0]==='upgrade')).toBe(false);
  }finally{http.close();f.close();}
});
for(const flags of [{sourceTap:'other/tap'},{redirectExecutable:'/bin/echo'},{version:'1.0.0_1'},{binaryVersion:'9.0.0'},{fail:true}])
test(`withholds successful update for ${JSON.stringify(flags)}`,async()=>{
  const f=fixture(),http=latestResponse(f.latestData),events:string[]=[];
  try {
    // Given a manager with an invalid replacement outcome.
    const target=await f.target();f.configure(flags);
    // When an upgrade runs through the actual child process.
    await expect(executeBrewUpdate(target,f.options,event=>events.push(event))).rejects.toThrow();
    // Then success is never announced.
    expect(events).not.toContain('update_verified');
  }finally{http.close();f.close();}
});
test('uses the same formula package version representation including revision',async()=>{
  const f=fixture(),http=latestResponse({...f.latestData,versions:{stable:'1.0.0'},revision:1});
  try {
    // Given the installed package already matches stable plus revision.
    const target=await f.target();
    // When latest is checked, comparison with inventory's installed version is equal.
    expect(await latestBrewVersion(target)).toBe(f.initial);
  }finally{http.close();f.close();}
});
test('retains the complete cask build version while verifying the CLI release version',async()=>{
  const f=fixture('cask'),version='2.0.0,42',http=latestResponse({...f.latestData,version});
  try {
    // Given a provider that records a release and a build in its cask version.
    const target=await f.target();f.configure({version,binaryVersion:'2.0.0'});
    // When the manager installs that build, CLI output proves the release.
    expect(await executeBrewUpdate(target,f.options)).toBe(version);
    // Then inventory/latest compare the unchanged full package version.
    expect(basename(dirname(dirname(realpathSync(f.executable))))).toBe(version);
  }finally{http.close();f.close();}
});
for(const kind of ['formula','cask'] as const)test(`catalog jobs preserve the actual ${kind} executor return through interrupted recovery`,async()=>{
  const f=fixture(kind),version=kind==='formula'?f.latest:'2.0.0,42';
  const http=latestResponse(kind==='formula'?f.latestData:{...f.latestData,version});
  const directory=join(f.directory,'state'),store=new AppStore(directory);
  try{
    // Given real discovery, SQLite, executor and inert Brew child with distinct package/CLI versions.
    if(kind==='cask')f.configure({version,binaryVersion:'2.0.0'});
    const updates=createCatalogUpdates({directory,home:f.home,path:f.options.path,store,guard:()=>{},changed:()=>{},installedChanged:()=>{},
      entries:()=>[{id:'codex',name:'Codex',description:{ko:'',en:''},executable:'codex',sourceUrl:'https://example.test',method:'brew',availability:'installable',reason:null,
        installed:{path:f.executable,version:f.initial,managed:false}}]});
    // When the actual supported executor returns its package version.
    const plan=await updates.plan('codex','brew-contract');await updates.confirm(plan.id,plan.revision);await updates.settled();
    const completed=store.catalogUpdates()[0];if(!completed)throw new Error('missing_job');
    expect(completed).toMatchObject({stage:'completed',installedVersion:version,expectedVersion:version});
    expect(completed.executionTarget).toEqual(await f.target());
    expect(completed.executionTarget?.fingerprint).not.toBe(plan.target.fingerprint);
    // Then losing only the final completion acknowledgement must not lose the package build.
    store.putCatalogUpdate({...completed,stage:'uncertain',installedVersion:null,failure:'response_lost',revision:completed.revision+1});
    await updates.recover(completed.id,completed.revision+1,'reconcile');
    expect(store.catalogUpdates()[0]).toMatchObject({stage:'completed',installedVersion:version,expectedVersion:version,reconciliation:{version:'2.0.0'}});
    expect(f.commands().filter(row=>row.args[0]==='upgrade')).toHaveLength(1);
  }finally{store.close();http.close();f.close();}
});
test('keeps third-party provider identity and explicitly refuses unsupported latest evidence',async()=>{
  const f=fixture(),http=latestResponse(f.latestData);
  try {
    // Given a valid installed formula from a third-party tap.
    const receipt=f.metadata(f.receipt);receipt.source.tap='vendor/tools';f.file(f.receipt,JSON.stringify(receipt));
    const target=await f.target();
    // When latest is requested, core metadata must never be substituted.
    await expect(latestBrewVersion(target)).rejects.toThrow('brew_latest_source_unverified');
    expect(target.packageName).toBe('vendor/tools/codex');expect(http.urls).toEqual([]);
  }finally{http.close();f.close();}
});
for(const changed of [{tap:'vendor/tools'},{name:'different',full_name:'different'},{version_scheme:1},
  {variations:{arm64_linux:{versions:{stable:'8.0.0'}}}}])
test(`rejects incompatible latest formula identity ${JSON.stringify(changed)}`,async()=>{
  const f=fixture(),http=latestResponse({...f.latestData,...changed});
  try {
    // Given latest data for a different provider, formula, or version scheme.
    const target=await f.target();
    // When queried, no guessed version escapes.
    await expect(latestBrewVersion(target)).rejects.toThrow();
  }finally{http.close();f.close();}
});
test('rejects brew.env overrides rather than allowing them to redirect or enable cleanup',async()=>{
  const f=fixture();
  try {
    // Given a pinned target and an env file introduced after planning.
    const target=await f.target();f.file(join(f.prefix,'etc/homebrew/brew.env'),'HOMEBREW_NO_AUTOREMOVE=\n');
    // When mutation is attempted, the env-file override is blocked.
    await expect(executeBrewRemoval(target,f.options)).rejects.toThrow('brew_source_unverified');
    expect(f.commands().some(row=>row.args[0]==='uninstall')).toBe(false);
  }finally{f.close();}
});
test('rejects mismatched HOME and uses the selected manager despite a different PATH manager',async()=>{
  const f=fixture();
  try {
    // Given a valid target but a caller that changed its execution environment.
    const target=await f.target();
    await expect(executeBrewRemoval(target,{...f.options,home:f.directory})).rejects.toThrow('brew_target_changed');
    expect(f.commands().some(row=>row.args[0]==='uninstall')).toBe(false);
    const other=join(f.directory,'other/brew');f.file(other,'#!/bin/sh\nexit 99\n');chmodSync(other,0o755);
    await executeBrewRemoval(target,{...f.options,path:dirname(other)+':/usr/bin:/bin'});
    expect(f.commands().filter(row=>row.args[0]==='uninstall').map(row=>row.entry)).toEqual([f.manager]);
    expect(existsSync(f.executable)).toBe(false);
  }finally{f.close();}
});
