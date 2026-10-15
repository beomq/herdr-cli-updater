import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { officialChoices, officialPlanSchema, planOfficialInstall, executeOfficialInstall } from '../../src/app/catalog-official';
import { catalogIds } from '../../src/app/catalog-types';
import { runProcess } from '../../src/app/catalog-runner';

function fixture() {
  const root=realpathSync(mkdtempSync('/tmp/catalog-official-')),home=join(root,'home'),directory=join(root,'updater'),prefix=join(root,'global');
  const bin=join(root,'managers'),log=join(root,'commands.jsonl'),control=join(root,'control.json');
  const bunRoot=join(home,'.bun/install/global'),bunBin=join(home,'.bun/bin');
  const file=(p:string,s:string)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,s);};
  const binary=(p:string,s:string)=>{file(p,s);chmodSync(p,0o755);};
  mkdirSync(home);mkdirSync(directory);mkdirSync(prefix);mkdirSync(bin);file(control,'{}');
  file(join(home,'.zshrc'),'# preserved shell profile\n');
  file(join(root,'manager.ts'),`
import {appendFileSync,readFileSync,writeFileSync,mkdirSync,chmodSync,symlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
const name=process.argv[2],args=process.argv.slice(3),home=${JSON.stringify(home)},prefix=${JSON.stringify(prefix)},bunRoot=${JSON.stringify(bunRoot)},bunBin=${JSON.stringify(bunBin)};
const flags=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
appendFileSync(${JSON.stringify(log)},JSON.stringify({name,args,home:process.env.HOME,path:process.env.PATH})+'\\n');
if(process.env.HOME!==home)process.exit(91);
if(name==='npm'&&args[0]==='prefix'){console.log(flags.prefix??prefix);process.exit(0);}
if(name==='npm'&&args[0]==='root'){console.log(join(flags.prefix??prefix,'lib/node_modules'));process.exit(0);}
if(name==='bun'&&args[1]==='bin'){console.log(bunBin);process.exit(0);}
if(name==='bun'&&args[1]==='ls'){console.log(bunRoot+' node_modules (0 installed)');process.exit(0);}
if(name==='brew'&&args[0]==='--prefix'){console.log(prefix);process.exit(0);}
if(name==='brew'&&args[0]==='--caskroom'){console.log(join(prefix,'Caskroom'));process.exit(0);}
if(flags.fail){console.error('credential=secret-do-not-leak');process.exit(23);}
const pkg=name==='npm'||name==='bun'?args[2]:'devin-cli';
const payload=name==='npm'?join(prefix,'lib/node_modules',pkg):name==='bun'?join(bunRoot,'node_modules',pkg):join(prefix,'Caskroom/devin-cli/1.2.3');
const executable=join(name==='bun'?bunBin:join(prefix,'bin'),name==='brew'?'devin':'codex');
const actual=flags.redirect??join(payload,'bin',name==='brew'?'devin':'codex');
mkdirSync(dirname(actual),{recursive:true});writeFileSync(actual,'#!/bin/sh\\necho '+(flags.version??'codex 1.2.3')+'\\n');chmodSync(actual,0o755);
mkdirSync(dirname(executable),{recursive:true});symlinkSync(actual,executable);
console.log('credential=secret-do-not-leak');
`);
  for(const name of ['npm','bun','brew'])binary(join(bin,name),`#!/bin/sh\nexec "${process.execPath}" "${join(root,'manager.ts')}" ${name} "$@"\n`);
  const options={home,directory,path:bin+':/usr/bin:/bin'};
  const commands=():{name:string;args:string[];home:string}[]=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s)):[];
  return {root,home,directory,prefix,bunRoot,bunBin,bin,file,binary,options,commands,
    configure:(flags:Record<string,string|boolean>)=>file(control,JSON.stringify(flags)),close:()=>rmSync(root,{recursive:true,force:true})};
}

test('only exposes executable choices and preserves platform/architecture gating for all 24 entries',()=>{
  expect(catalogIds).toHaveLength(24);
  for(const id of catalogIds){
    expect(Array.isArray(officialChoices(id,'darwin','arm64'))).toBe(true);
    expect(officialChoices(id,'win32','x64')).toEqual([]);
    expect(officialChoices(id,'linux','riscv64')).toEqual([]);
  }
  expect(officialChoices('devin','darwin','arm64').find(c=>c.recommended)?.method).toBe('brew');
  expect(officialChoices('devin','linux','x64')).toEqual([]);
  expect(officialChoices('gjc','darwin','arm64').find(c=>c.recommended)?.method).toBe('official');
  expect(officialChoices('claude','darwin','arm64').some(c=>c.recommended)).toBe(false);
  for(const id of ['agy','grok','hermes','kiro'] as const)expect(officialChoices(id)).toEqual([]);
});
for(const method of ['npm','bun','brew'] as const)test(`${method} discovers a real manager root, installs globally and verifies the explicit binary`,async()=>{
  const f=fixture();
  try{
    const catalogId=method==='brew'?'devin':'codex';
    const plan=await planOfficialInstall({...f.options,catalogId,method});
    expect(officialPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.target).toBe(method==='bun'?f.bunRoot:f.prefix);
    expect(plan.env['HOME']).toBe(f.home);
    const events:string[]=[];
    expect(await executeOfficialInstall(plan,f.options,event=>events.push(event))).toBe('1.2.3');
    expect(events).toContain('installer_started');expect(events.join(' ')).not.toContain('secret');
    expect(f.commands().filter(c=>['install','add'].includes(c.args[0]??'')).map(c=>c.args)).toEqual([[...plan.args]]);
    expect(readFileSync(join(f.home,'.zshrc'),'utf8')).toBe('# preserved shell profile\n');
    expect(existsSync(join(f.directory,'launchers'))).toBe(false);
  }finally{f.close();}
});
for(const method of ['npm','bun','brew'] as const)test(`${method} refuses an existing package root even if its executable shim is missing`,async()=>{
  const f=fixture();try{
    const destination=method==='npm'?join(f.prefix,'lib/node_modules/@openai/codex'):method==='bun'?join(f.bunRoot,'node_modules/@openai/codex'):join(f.prefix,'Caskroom/devin-cli');
    mkdirSync(destination,{recursive:true});
    await expect(planOfficialInstall({...f.options,catalogId:method==='brew'?'devin':'codex',method})).rejects.toThrow('official_destination_exists');
    expect(f.commands().some(c=>c.args[0]==='install'||c.args[0]==='add')).toBe(false);
  }finally{f.close();}
});
for(const mutation of ['manager','prefix','destination','configuration','plan'] as const)test(`rejects ${mutation} changes before manager mutation`,async()=>{
  const f=fixture();try{
    const plan=await planOfficialInstall({...f.options,catalogId:'codex',method:'npm'});
    if(mutation==='manager')f.binary(join(f.bin,'npm'),readFileSync(join(f.bin,'npm'),'utf8')+'# replacement\n');
    if(mutation==='prefix')f.configure({prefix:join(f.root,'other')});
    if(mutation==='destination')f.file(plan.executable,'existing-install');
    if(mutation==='configuration')f.file(join(f.home,'.npmrc'),'registry=https://registry.npmjs.org\n');
    const input=mutation==='plan'?{...plan,args:['install','--global','untrusted-package']}:plan;
    await expect(executeOfficialInstall(input,f.options,()=>{})).rejects.toThrow();
    expect(f.commands().some(c=>c.args[0]==='install')).toBe(false);
  }finally{f.close();}
});
test('rejects physical parent aliases and updater-owned manager prefixes',async()=>{
  const f=fixture();try{
    const alias=join(f.root,'alias');symlinkSync(f.prefix,alias);f.configure({prefix:alias});
    await expect(planOfficialInstall({...f.options,catalogId:'codex',method:'npm'})).rejects.toThrow('official_install_plan_stale');
    f.configure({prefix:f.directory});
    await expect(planOfficialInstall({...f.options,catalogId:'codex',method:'npm'})).rejects.toThrow('updater_owned_destination_forbidden');
  }finally{f.close();}
});
test('runs GJC from OS temp with genuine install HOME, isolates version HOME and keeps migration source',async()=>{
  const f=fixture();try{
    const source=join(f.root,'previous/bin/gjc');f.binary(source,'#!/bin/sh\necho 0.1.0\n');
    const plan=await planOfficialInstall({...f.options,catalogId:'gjc'});let scriptPath='',versionHome='';
    const run:typeof runProcess=async(executable,args,env,...rest)=>{
      if(executable===plan.manager){scriptPath=args[0]??'';expect(scriptPath.startsWith(f.directory+'/')).toBe(false);expect(args[1]).toBe('--binary');}
      if(executable===plan.executable){versionHome=env['HOME']??'';expect(versionHome).not.toBe(f.home);expect(env['DISABLE_AUTOUPDATER']).toBe('1');}
      return runProcess(executable,args,env,...rest);
    };
    const download=async()=>`#!/bin/bash\n[ "$HOME" = '${f.home}' ] || exit 91\n[ "$GJC_NO_COMMUNITY_APP" = 1 ] || exit 92\nmkdir -p "$HOME/.local/bin"\nprintf '#!/bin/sh\\necho side-effect > "$HOME/version-side-effect"\\necho gjc/2.3.4\\n' > "$HOME/.local/bin/gjc"\nchmod +x "$HOME/.local/bin/gjc"\n`;
    expect(await executeOfficialInstall(plan,{...f.options,run,download},()=>{})).toBe('2.3.4');
    expect(scriptPath).not.toBe('');expect(existsSync(scriptPath)).toBe(false);
    expect(versionHome).not.toBe('');expect(existsSync(versionHome)).toBe(false);
    expect(existsSync(join(f.home,'version-side-effect'))).toBe(false);
    expect(readFileSync(source,'utf8')).toContain('0.1.0');
    expect(readFileSync(join(f.home,'.zshrc'),'utf8')).toBe('# preserved shell profile\n');
  }finally{f.close();}
});
test('rechecks an official script destination after download before any execution',async()=>{
  const f=fixture();try{
    const plan=await planOfficialInstall({...f.options,catalogId:'gjc'});let executed=false;
    const download=async()=>{f.file(plan.executable,'old-install');return '#!/bin/bash\nexit 0\n';};
    const run:typeof runProcess=async()=>{executed=true;return '';};
    await expect(executeOfficialInstall(plan,{...f.options,download,run},()=>{})).rejects.toThrow('official_destination_exists');
    expect(executed).toBe(false);expect(readFileSync(plan.executable,'utf8')).toBe('old-install');
  }finally{f.close();}
});
test('guards cursor alias and payload even without agent shim',async()=>{
  const f=fixture();try{
    f.file(join(f.home,'.local/bin/cursor-agent'),'old-alias');
    await expect(planOfficialInstall({...f.options,catalogId:'cursor'})).rejects.toThrow('official_destination_exists');
  }finally{f.close();}
});
test('a new destination cannot silently shadow an existing default command',async()=>{
  const f=fixture();try{
    const old=join(f.root,'old-bin'),newBin=join(f.home,'.local/bin');
    f.binary(join(old,'gjc'),'#!/bin/sh\necho 1.0.0\n');
    await expect(planOfficialInstall({...f.options,path:newBin+':'+old+':'+f.options.path,catalogId:'gjc'})).rejects.toThrow('official_destination_shadows_default');
    expect(existsSync(join(newBin,'gjc'))).toBe(false);
  }finally{f.close();}
});
test('Kimi uses its official root and excludes that bin from installer PATH',async()=>{
  const f=fixture();try{
    const bin=join(f.home,'.kimi-code/bin');
    const plan=await planOfficialInstall({...f.options,path:bin+':'+f.options.path,catalogId:'kimi'});
    expect(plan.executable).toBe(join(bin,'kimi'));expect(plan.env['KIMI_NO_MODIFY_PATH']).toBe('1');
    expect(plan.env['PATH']?.split(':')).not.toContain(bin);
  }finally{f.close();}
});
for(const id of ['agy','grok','hermes','kiro','devin','claude'] as const)test(`${id} unproven standalone cannot run automatically`,async()=>{
  const f=fixture();try{
    await expect(planOfficialInstall({...f.options,catalogId:id,method:'official'})).rejects.toThrow('official_manual_install_required');
    expect(f.commands()).toEqual([]);
  }finally{f.close();}
});
for(const failure of ['exit','version','outside'] as const)test(`installation ${failure} failure cannot silently report success or leak output`,async()=>{
  const f=fixture();try{
    const plan=await planOfficialInstall({...f.options,catalogId:'codex',method:'npm'});
    f.configure(failure==='exit'?{fail:true}:failure==='version'?{version:'unrecognized'}:{redirect:join(f.root,'outside/codex')});
    const events:string[]=[];
    const error=await executeOfficialInstall(plan,f.options,event=>events.push(event)).then(()=>null,(e:unknown)=>e);
    expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('secret-do-not-leak');
    expect(String(error)).toContain(failure==='exit'?'installer_exit_23':failure==='version'?'installed_version_unverified':'installed_executable_outside_target');
    expect(events.join(' ')).not.toContain('secret');
  }finally{f.close();}
});
