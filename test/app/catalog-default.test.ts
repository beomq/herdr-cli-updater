import { expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyDefaultSwitch, defaultSwitchPlanSchema, isDefaultSwitchConfigured, planDefaultSwitch } from '../../src/app/catalog-default';
import type { CatalogInstallation } from '../../src/app/catalog-types';
import { runProcess } from '../../src/app/catalog-runner';
import { AppError } from '../../src/app/types';

function fixture(profile:Buffer|null=Buffer.from('# unrelated\nexport PRIVATE_TOKEN=never-publish-this\n')) {
  const root=realpathSync(mkdtempSync('/tmp/default-switch-'));
  const home=join(root,'home'),directory=join(root,"updater's space $(false)");
  mkdirSync(home);mkdirSync(directory);
  const source=join(root,"manager's bin");mkdirSync(source);
  const target=join(source,'maki');
  writeFileSync(target,'#!/bin/sh\n[ "$1" = "--version" ] || exit 11\nprintf "maki 1.2.3\\n"\n',{mode:0o755});
  if(profile)writeFileSync(join(home,'.zshrc'),profile,{mode:0o640});
  const installation:CatalogInstallation={id:'source-a',catalogId:'maki',manager:'bun',root:source,packageName:null,
    path:target,identityPath:target,isDefault:false,receiptId:null,version:'1.2.3'};
  const options={home,directory,path:'/usr/bin:/bin',shell:'/bin/zsh',installation};
  return {root,home,directory,source,target,options,profile:join(home,'.zshrc'),legacyLauncher:join(directory,'launchers/maki'),
    plan:()=>planDefaultSwitch(options),applyOptions:{home,path:options.path,guard:()=>{}},
    shell:()=>runProcess('/bin/zsh',['-d','-i','-c','command -v maki; maki --version'],
      {HOME:home,PATH:options.path,TERM:'dumb'},home,5_000),
    close:()=>rmSync(root,{recursive:true,force:true})};
}
function second(f:ReturnType<typeof fixture>,version='2.0.0') {
  const source=join(f.root,'second-manager');mkdirSync(source);
  const target=join(source,'maki');
  writeFileSync(target,`#!/bin/sh\nprintf "maki ${version}\\n"\n`,{mode:0o755});
  return {target,plan:()=>planDefaultSwitch({...f.options,installation:{...f.options.installation,id:'source-b',path:target,identityPath:target}})};
}

test('official directory PATH survives updater deletion and preserves sources and private backups',async()=>{
  const f=fixture();try{
    const before=readFileSync(f.profile),source=readFileSync(f.target),plan=f.plan();
    expect(existsSync(f.legacyLauncher)).toBe(false);
    expect(JSON.stringify(plan)).not.toContain('never-publish-this');
    expect(defaultSwitchPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    const result=await applyDefaultSwitch(plan,f.applyOptions);
    expect(result.version).toBe('1.2.3');expect(result.launcher).toBe(f.target);expect(result.profile).toBe(f.profile);
    expect(readFileSync(f.profile).subarray(0,before.length)).toEqual(before);
    expect(readFileSync(f.target)).toEqual(source);expect(lstatSync(f.profile).mode&0o777).toBe(0o640);
    expect(existsSync(join(f.directory,'launchers'))).toBe(false);
    expect(readFileSync(f.profile,'utf8')).not.toContain(f.directory);
    if(!result.backup)throw new Error('missing backup');
    expect(lstatSync(result.backup).mode&0o777).toBe(0o700);
    expect(lstatSync(join(result.backup,'profile')).mode&0o777).toBe(0o600);
    expect(readFileSync(join(result.backup,'profile'))).toEqual(before);
    expect(isDefaultSwitchConfigured(plan)).toBe(true);
    expect((await f.shell()).split('\n')).toEqual([f.target,'maki 1.2.3']);
    rmSync(f.directory,{recursive:true});
    expect((await f.shell()).split('\n')).toEqual([f.target,'maki 1.2.3']);
    expect(isDefaultSwitchConfigured(plan)).toBe(true);
  }finally{f.close();}
});

test('switching among official installs selects the second without changing the managed source',async()=>{
  const f=fixture(null);try{
    const original=readFileSync(f.target);
    const first=f.plan();await applyDefaultSwitch(first,f.applyOptions);
    const profile=readFileSync(f.profile),other=second(f),plan=other.plan();
    const result=await applyDefaultSwitch(plan,f.applyOptions);
    expect(result.version).toBe('2.0.0');expect(readFileSync(f.target)).toEqual(original);
    expect(f.options.installation.id).toBe('source-a');
    expect(isDefaultSwitchConfigured(first)).toBe(false);expect(isDefaultSwitchConfigured(plan)).toBe(true);
    expect((await f.shell()).split('\n')).toEqual([other.target,'maki 2.0.0']);
    if(!result.backup)throw new Error('missing backup');
    expect(readFileSync(join(result.backup,'profile'))).toEqual(profile);
    const updated=readFileSync(f.profile);
    await applyDefaultSwitch(other.plan(),f.applyOptions);
    expect(readFileSync(f.profile)).toEqual(updated);
    expect(existsSync(f.legacyLauncher)).toBe(false);
  }finally{f.close();}
});

test('different CLI defaults retain each directory instead of replacing another CLI block',async()=>{
  const f=fixture(null);try{
    const first=f.plan();await applyDefaultSwitch(first,f.applyOptions);
    const bin=join(f.root,'codex-bin');mkdirSync(bin);const executable=join(bin,'codex');
    writeFileSync(executable,'#!/bin/sh\necho 2.0.0\n',{mode:0o755});
    const secondPlan=planDefaultSwitch({...f.options,installation:{...f.options.installation,catalogId:'codex',id:'codex',path:executable,identityPath:executable}});
    await applyDefaultSwitch(secondPlan,f.applyOptions);
    expect(isDefaultSwitchConfigured(first)).toBe(true);expect(isDefaultSwitchConfigured(secondPlan)).toBe(true);
    expect((await f.shell()).split('\n')).toEqual([f.target,'maki 1.2.3']);
    const output=await runProcess('/bin/zsh',['-d','-i','-c','command -v codex'],{HOME:f.home,PATH:f.options.path,TERM:'dumb'},f.home,5_000);
    expect(output).toBe(executable);
  }finally{f.close();}
});

test.each(['profile','target','source-directory','updater-directory'] as const)('stale %s is rejected before profile writes',async(kind)=>{
  const f=fixture();try{
    const plan=f.plan();
    if(kind==='profile')writeFileSync(f.profile,'# concurrent\n');
    if(kind==='target')writeFileSync(f.target,'#!/bin/sh\nprintf "maki 9.0.0\\n"\n');
    if(kind==='source-directory'){renameSync(f.source,join(f.root,'old-source'));mkdirSync(f.source);writeFileSync(f.target,'#!/bin/sh\nexit 1\n',{mode:0o755});}
    if(kind==='updater-directory'){renameSync(f.directory,join(f.root,'old-updater'));mkdirSync(f.directory);}
    const before=readFileSync(f.profile);
    await expect(applyDefaultSwitch(plan,f.applyOptions)).rejects.toThrow();
    expect(readFileSync(f.profile)).toEqual(before);expect(existsSync(f.legacyLauncher)).toBe(false);
  }finally{f.close();}
});

test.each(['profile','home','target','source-directory'] as const)('redirected %s is rejected without following writes',async(kind)=>{
  const f=fixture();try{
    const plan=f.plan(),foreign=join(f.root,'foreign');writeFileSync(foreign,'foreign bytes',{mode:0o755});
    if(kind==='profile'){rmSync(f.profile);symlinkSync(foreign,f.profile);}
    if(kind==='target'){rmSync(f.target);symlinkSync(foreign,f.target);}
    if(kind==='home'){renameSync(f.home,join(f.root,'old-home'));mkdirSync(join(f.root,'other-home'));symlinkSync(join(f.root,'other-home'),f.home);}
    if(kind==='source-directory'){renameSync(f.source,join(f.root,'old-source'));symlinkSync(join(f.root,'old-source'),f.source);}
    await expect(applyDefaultSwitch(plan,f.applyOptions)).rejects.toThrow();
    expect(readFileSync(foreign,'utf8')).toBe('foreign bytes');
  }finally{f.close();}
});

test('official source symlinks are pinned and remain untouched',async()=>{
  const f=fixture();try{
    const physical=join(f.root,'payload');renameSync(f.target,physical);symlinkSync(physical,f.target);
    const result=await applyDefaultSwitch(f.plan(),f.applyOptions);
    expect(result.version).toBe('1.2.3');expect(lstatSync(f.target).isSymbolicLink()).toBe(true);
    expect((await f.shell()).split('\n')).toEqual([f.target,'maki 1.2.3']);
  }finally{f.close();}
});

test('parent cancellation before activation has no profile effects',async()=>{
  const f=fixture();try{
    const before=readFileSync(f.profile);
    await expect(applyDefaultSwitch(f.plan(),{...f.applyOptions,guard:()=>{throw new AppError('busy','cancelled');}})).rejects.toThrow('cancelled');
    expect(readFileSync(f.profile)).toEqual(before);expect(existsSync(f.legacyLauncher)).toBe(false);
  }finally{f.close();}
});

test('an asynchronous guard cannot resume a now-stale plan',async()=>{
  const f=fixture();const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  try{
    const applying=applyDefaultSwitch(f.plan(),{...f.applyOptions,guard:async()=>{entered.resolve();await release.promise;}});
    const outcome=applying.then(()=>null,(error:unknown)=>error);
    await entered.promise;writeFileSync(f.profile,'# changed while guard waited\n');release.resolve();
    const error=await outcome;expect(error).toBeInstanceOf(AppError);
    if(!(error instanceof AppError))throw new Error('missing error');
    expect(error.detail).toBe('default_switch_plan_stale');
    expect(readFileSync(f.profile,'utf8')).toBe('# changed while guard waited\n');
  }finally{release.resolve();f.close();}
});

test('cancellation after profile publication restores exact original bytes',async()=>{
  const f=fixture();try{
    const before=readFileSync(f.profile);
    await expect(applyDefaultSwitch(f.plan(),{...f.applyOptions,guard:()=>{
      if(readFileSync(f.profile,'utf8').includes('CLI default PATH v2'))throw new AppError('busy','cancelled_after_profile');
    }})).rejects.toThrow('cancelled_after_profile');
    expect(readFileSync(f.profile)).toEqual(before);expect(existsSync(f.legacyLauncher)).toBe(false);
  }finally{f.close();}
});

test('failed verification restores the previous selected directory and shell result',async()=>{
  const f=fixture();try{
    await applyDefaultSwitch(f.plan(),f.applyOptions);const before=readFileSync(f.profile),other=second(f);
    writeFileSync(other.target,'#!/bin/sh\nexit 19\n');
    await expect(applyDefaultSwitch(other.plan(),f.applyOptions)).rejects.toThrow();
    expect(readFileSync(f.profile)).toEqual(before);
    expect((await f.shell()).split('\n')).toEqual([f.target,'maki 1.2.3']);
  }finally{f.close();}
});

test('failed first verification removes the newly created profile',async()=>{
  const f=fixture(null);try{
    writeFileSync(f.target,'#!/bin/sh\nprintf "not-a-version\\n"\n');
    await expect(applyDefaultSwitch(f.plan(),f.applyOptions)).rejects.toThrow();
    expect(existsSync(f.profile)).toBe(false);expect(existsSync(f.legacyLauncher)).toBe(false);
  }finally{f.close();}
});

test('concurrent profile edit during rollback is preserved and reported uncertain',async()=>{
  const f=fixture();try{
    let edited=false;
    const error=await applyDefaultSwitch(f.plan(),{...f.applyOptions,guard:()=>{
      if(readFileSync(f.profile,'utf8').includes('CLI default PATH v2')){
        writeFileSync(f.profile,'# concurrent edit after activation\n');edited=true;throw new AppError('busy','cancelled');
      }
    }}).catch((error:unknown)=>error);
    expect(edited).toBe(true);expect(error).toBeInstanceOf(AppError);
    if(!(error instanceof AppError))throw new Error('missing error');expect(error.code).toBe('uncertain');
    expect(readFileSync(f.profile,'utf8')).toBe('# concurrent edit after activation\n');
  }finally{f.close();}
});

test('profile changed by parent guard is rejected before publication',async()=>{
  const f=fixture();try{
    let calls=0;
    await expect(applyDefaultSwitch(f.plan(),{...f.applyOptions,guard:()=>{
      if(++calls===2)writeFileSync(f.profile,'# external edit\n');
    }})).rejects.toThrow();
    expect(readFileSync(f.profile,'utf8')).toBe('# external edit\n');
  }finally{f.close();}
});

test.each(['.zshenv','.zprofile','.zshrc','.zlogin'])('literal ZDOTDIR redirect in %s is unsupported without executing it',(file)=>{
  const f=fixture();try{
    writeFileSync(join(f.home,file),`export ZDOTDIR=${join(f.root,'elsewhere')}\nexit 99\n`);
    expect(()=>f.plan()).toThrow('default_shell_configuration_unsupported');
  }finally{f.close();}
});

test('unsupported shells, profile symlinks and hardlinks are refused; foreign launchers are untouched',async()=>{
  const f=fixture();try{
    expect(()=>planDefaultSwitch({...f.options,shell:'/bin/bash'})).toThrow();
    mkdirSync(join(f.directory,'launchers'));writeFileSync(f.legacyLauncher,'foreign launcher',{mode:0o755});
    await applyDefaultSwitch(f.plan(),f.applyOptions);
    expect(readFileSync(f.legacyLauncher,'utf8')).toBe('foreign launcher');
    rmSync(f.profile);symlinkSync(f.target,f.profile);expect(()=>f.plan()).toThrow();
    rmSync(f.profile);writeFileSync(f.profile,'original');linkSync(f.profile,join(f.root,'linked-profile'));expect(()=>f.plan()).toThrow();
  }finally{f.close();}
});

test('verification uses isolated HOME and minimal environment without sourcing user startup',async()=>{
  const f=fixture(Buffer.from('export PRIVATE_TOKEN=secret\nprintf "user startup text\\n"\n'));try{
    writeFileSync(f.target,`#!/bin/sh
[ "$1" = "--version" ] || exit 10
[ "$HOME" != '${f.home}' ] || exit 11
[ "\${PRIVATE_TOKEN+x}" != x ] || exit 12
[ "$TMPDIR" = "$HOME" ] || exit 13
[ -d "$HOME" ] || exit 14
case "$PATH" in *:/usr/bin:/bin) ;; *) exit 15 ;; esac
printf 'maki 3.4.5\\n'
`);
    const result=await applyDefaultSwitch(f.plan(),f.applyOptions);expect(result.version).toBe('3.4.5');
    expect(readFileSync(f.profile,'utf8').startsWith('export PRIVATE_TOKEN=secret\n')).toBe(true);
  }finally{f.close();}
});

test('startup redirect added after planning invalidates the plan',async()=>{
  const f=fixture();try{
    const plan=f.plan(),before=readFileSync(f.profile);writeFileSync(join(f.home,'.zshenv'),'export ZDOTDIR=/elsewhere\n');
    await expect(applyDefaultSwitch(plan,f.applyOptions)).rejects.toThrow('default_shell_configuration_unsupported');
    expect(readFileSync(f.profile)).toEqual(before);
  }finally{f.close();}
});

test('target changed after publication rolls back only the profile, not the official installation',async()=>{
  const f=fixture();try{
    const before=readFileSync(f.profile);
    await expect(applyDefaultSwitch(f.plan(),{...f.applyOptions,guard:()=>{
      if(readFileSync(f.profile,'utf8').includes('CLI default PATH v2'))writeFileSync(f.target,'#!/bin/sh\nprintf "maki 9.0.0\\n"\n');
    }})).rejects.toThrow();
    expect(readFileSync(f.profile)).toEqual(before);expect(readFileSync(f.target,'utf8')).toContain('9.0.0');
  }finally{f.close();}
});

test('old stored plans remain readable but cannot execute or claim configured status',async()=>{
  const f=fixture();try{
    const {strategy,...legacy}=f.plan(),before=readFileSync(f.profile);
    const old={...legacy,launcher:f.legacyLauncher};
    expect(defaultSwitchPlanSchema.safeParse(old).success).toBe(true);expect(isDefaultSwitchConfigured(old)).toBe(false);
    await expect(applyDefaultSwitch(old,f.applyOptions)).rejects.toThrow('default_switch_plan_stale');
    expect(readFileSync(f.profile)).toEqual(before);expect(existsSync(f.legacyLauncher)).toBe(false);
  }finally{f.close();}
});

test('legacy launcher PATH migrates only to an official destination without removing legacy files',async()=>{
  const f=fixture();try{
    mkdirSync(join(f.directory,'launchers'));writeFileSync(f.legacyLauncher,'foreign bytes',{mode:0o755});
    const quoted=`'${join(f.directory,'launchers').replaceAll("'",`'\\''`)}'`;
    writeFileSync(f.profile,`# unrelated\n# >>> herdr-cli-updater PATH >>>\nexport PATH=${quoted}:"$PATH"\n# <<< herdr-cli-updater PATH <<<\n`);
    const before=readFileSync(f.profile),result=await applyDefaultSwitch(f.plan(),f.applyOptions);
    expect(readFileSync(f.legacyLauncher,'utf8')).toBe('foreign bytes');
    expect(readFileSync(f.profile,'utf8')).not.toContain(f.directory);
    if(!result.backup)throw new Error('missing backup');expect(readFileSync(join(result.backup,'profile'))).toEqual(before);
    expect((await f.shell()).split('\n')).toEqual([f.target,'maki 1.2.3']);
  }finally{f.close();}
});

test.each(['owned','updater-path','updater-symlink','nonstandard-name'] as const)('%s cannot be selected as a new default',(kind)=>{
  const f=fixture();try{
    let installation=f.options.installation;
    if(kind==='owned')installation={...installation,manager:'owned'};
    if(kind==='updater-path'){
      const target=join(f.directory,'maki');writeFileSync(target,readFileSync(f.target),{mode:0o755});installation={...installation,path:target,identityPath:target};
    }
    if(kind==='updater-symlink'){
      const payload=join(f.directory,'payload');renameSync(f.target,payload);symlinkSync(payload,f.target);
    }
    if(kind==='nonstandard-name'){
      const target=join(f.source,'maki-preview');renameSync(f.target,target);installation={...installation,path:target,identityPath:target};
    }
    const before=readFileSync(f.profile);
    expect(()=>planDefaultSwitch({...f.options,installation})).toThrow();expect(readFileSync(f.profile)).toEqual(before);
    expect(existsSync(join(f.home,'.local/bin'))).toBe(false);
  }finally{f.close();}
});

test('shared directory selection is explicit and preserves foreign files without creating user links',async()=>{
  const f=fixture();try{
    const foreign=join(f.source,'other-cli');writeFileSync(foreign,'foreign bytes');const plan=f.plan();
    expect(plan.limitations.some(value=>value.includes('shared directory'))).toBe(true);
    await applyDefaultSwitch(plan,f.applyOptions);expect(readFileSync(foreign,'utf8')).toBe('foreign bytes');
    expect(existsSync(join(f.home,'.local/bin'))).toBe(false);
  }finally{f.close();}
});

test('modified generated PATH blocks cannot be overwritten',()=>{
  const f=fixture();try{
    writeFileSync(f.profile,'# >>> CLI default PATH v2 >>>\nexport PATH=/foreign:"$PATH"\n# <<< CLI default PATH v2 <<<\n');
    expect(()=>f.plan()).toThrow('default_path_block_modified');
    writeFileSync(f.profile,'# >>> herdr-cli-updater PATH >>>\nexport PATH=/foreign:"$PATH"\n# <<< herdr-cli-updater PATH <<<\n');
    expect(()=>f.plan()).toThrow('default_path_block_modified');
  }finally{f.close();}
});

test('public plans reject profile contents and forged executable aliases',async()=>{
  const f=fixture();try{
    const plan=f.plan();expect(defaultSwitchPlanSchema.safeParse({...plan,profileContents:'secret'}).success).toBe(false);
    await expect(applyDefaultSwitch({...plan,launcher:join(f.directory,'arbitrary')},f.applyOptions)).rejects.toThrow();
    await expect(applyDefaultSwitch({...plan,profile:join(f.home,'other')},f.applyOptions)).rejects.toThrow();
  }finally{f.close();}
});

test('non-executable sources and changed PATH cannot activate',async()=>{
  const f=fixture();try{
    chmodSync(f.target,0o600);expect(()=>f.plan()).toThrow();chmodSync(f.target,0o755);
    await expect(applyDefaultSwitch(f.plan(),{...f.applyOptions,path:'/bin'})).rejects.toThrow();
  }finally{f.close();}
});
