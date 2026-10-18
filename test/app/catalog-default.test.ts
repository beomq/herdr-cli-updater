import { expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  return {root,home,directory,source,target,options,profile:join(home,'.zshrc'),legacyLauncher:join(directory,'launchers/maki'),dispatch:join(directory,'dispatch/bin/maki'),
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

test('dispatch links preserve sources and private backups and report removed data as unconfigured',async()=>{
  const f=fixture();try{
    const before=readFileSync(f.profile),source=readFileSync(f.target),plan=f.plan();
    expect(existsSync(f.legacyLauncher)).toBe(false);
    expect(existsSync(join(f.directory,'dispatch'))).toBe(false);
    expect(readFileSync(f.profile)).toEqual(before);
    expect(JSON.stringify(plan)).not.toContain('never-publish-this');
    expect(defaultSwitchPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    const result=await applyDefaultSwitch(plan,f.applyOptions);
    expect(result.version).toBe('1.2.3');expect(result.launcher).toBe(f.dispatch);expect(result.profile).toBe(f.profile);
    expect(readFileSync(f.profile).subarray(0,before.length)).toEqual(before);
    expect(readFileSync(f.target)).toEqual(source);expect(lstatSync(f.profile).mode&0o777).toBe(0o640);
    expect(existsSync(join(f.directory,'launchers'))).toBe(false);
    expect(readlinkSync(f.dispatch)).toBe(f.target);
    if(!result.backup)throw new Error('missing backup');
    expect(lstatSync(result.backup).mode&0o777).toBe(0o700);
    expect(lstatSync(join(result.backup,'profile')).mode&0o777).toBe(0o600);
    expect(readFileSync(join(result.backup,'profile'))).toEqual(before);
    expect(isDefaultSwitchConfigured(plan)).toBe(true);
    expect((await f.shell()).split('\n')).toEqual([f.dispatch,'maki 1.2.3']);
    rmSync(f.directory,{recursive:true});
    await expect(f.shell()).rejects.toThrow();
    expect(isDefaultSwitchConfigured(plan)).toBe(false);
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
    expect((await f.shell()).split('\n')).toEqual([f.dispatch,'maki 2.0.0']);
    expect(readlinkSync(f.dispatch)).toBe(other.target);
    if(!result.backup)throw new Error('missing backup');
    expect(readFileSync(join(result.backup,'profile'))).toEqual(profile);
    const updated=readFileSync(f.profile);
    await applyDefaultSwitch(other.plan(),f.applyOptions);
    expect(readFileSync(f.profile)).toEqual(updated);
    expect(existsSync(f.legacyLauncher)).toBe(false);
  }finally{f.close();}
});

test('different CLI defaults retain each dispatch link without promoting shared directories',async()=>{
  const f=fixture(null);try{
    const first=f.plan();await applyDefaultSwitch(first,f.applyOptions);
    const bin=join(f.root,'codex-bin');mkdirSync(bin);const executable=join(bin,'codex');
    writeFileSync(executable,'#!/bin/sh\necho 2.0.0\n',{mode:0o755});
    const secondPlan=planDefaultSwitch({...f.options,installation:{...f.options.installation,catalogId:'codex',id:'codex',path:executable,identityPath:executable}});
    await applyDefaultSwitch(secondPlan,f.applyOptions);
    expect(isDefaultSwitchConfigured(first)).toBe(true);expect(isDefaultSwitchConfigured(secondPlan)).toBe(true);
    expect((await f.shell()).split('\n')).toEqual([f.dispatch,'maki 1.2.3']);
    const output=await runProcess('/bin/zsh',['-d','-i','-c','command -v codex'],{HOME:f.home,PATH:f.options.path,TERM:'dumb'},f.home,5_000);
    expect(output).toBe(join(f.directory,'dispatch/bin/codex'));
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
    expect(lstatSync(f.dispatch,{throwIfNoEntry:false})).toBeUndefined();
    expect(existsSync(join(f.directory,'dispatch/bin/.maki.target'))).toBe(false);
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
    expect((await f.shell()).split('\n')).toEqual([f.dispatch,'maki 1.2.3']);
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
      if(readFileSync(f.profile,'utf8').includes('CLI default dispatch v3'))throw new AppError('busy','cancelled_after_profile');
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
    expect((await f.shell()).split('\n')).toEqual([f.dispatch,'maki 1.2.3']);
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
      if(readFileSync(f.profile,'utf8').includes('CLI default dispatch v3')){
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
      if(readFileSync(f.profile,'utf8').includes('CLI default dispatch v3'))writeFileSync(f.target,'#!/bin/sh\nprintf "maki 9.0.0\\n"\n');
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
    expect(readFileSync(f.profile,'utf8')).not.toContain('herdr-cli-updater PATH');
    if(!result.backup)throw new Error('missing backup');expect(readFileSync(join(result.backup,'profile'))).toEqual(before);
    expect((await f.shell()).split('\n')).toEqual([f.dispatch,'maki 1.2.3']);
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

test('shared directory selection preserves foreign files without creating shared user links',async()=>{
  const f=fixture();try{
    const foreign=join(f.source,'other-cli');writeFileSync(foreign,'foreign bytes');const plan=f.plan();
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

test.each([false,true])('shared prefixes retain independent CLI choices in reverse order %s',async(reverse)=>{
  const f=fixture();try{
    const bin=join(f.root,'other-prefix');mkdirSync(bin);
    const codex=join(bin,'codex'),shadow=join(bin,'maki'),unselected=join(f.source,'codex');
    writeFileSync(codex,'#!/bin/sh\necho codex 2.0.0\n',{mode:0o755});
    writeFileSync(shadow,'#!/bin/sh\necho maki 9.0.0\n',{mode:0o755});
    writeFileSync(unselected,'#!/bin/sh\necho codex 8.0.0\n',{mode:0o755});
    const original=readFileSync(f.profile),foreign=readFileSync(shadow);
    const choices=[f.options,{...f.options,installation:{...f.options.installation,catalogId:'codex' as const,id:'codex',path:codex,identityPath:codex}}];
    if(reverse)choices.reverse();
    for(const choice of choices)await applyDefaultSwitch(planDefaultSwitch(choice),f.applyOptions);
    const output=await runProcess('/bin/zsh',['-d','-i','-c','maki --version; codex --version'],{HOME:f.home,PATH:f.options.path,TERM:'dumb'},f.home,5_000);
    expect(output).toBe('maki 1.2.3\ncodex 2.0.0');
    expect(readFileSync(f.profile).subarray(0,original.length)).toEqual(original);
    expect(readFileSync(f.profile,'utf8').match(/# >>> CLI default dispatch v3 >>>/g)).toHaveLength(1);
    expect(readFileSync(shadow)).toEqual(foreign);
    expect(readlinkSync(f.dispatch)).toBe(f.target);
    expect(readlinkSync(join(f.directory,'dispatch/bin/codex'))).toBe(codex);
  }finally{f.close();}
});

test('stable launcher follows an upgraded canonical payload after old payload deletion',async()=>{
  const f=fixture();try{
    const old=join(f.root,'payload-old'),next=join(f.root,'payload-next');
    renameSync(f.target,old);symlinkSync(old,f.target);
    const plan=f.plan();await applyDefaultSwitch(plan,f.applyOptions);
    writeFileSync(next,'#!/bin/sh\necho maki 2.3.4\n',{mode:0o755});
    rmSync(f.target);symlinkSync(next,f.target);rmSync(old);
    expect(readlinkSync(f.dispatch)).toBe(f.target);
    expect(isDefaultSwitchConfigured(plan)).toBe(true);
    expect((await f.shell()).split('\n')).toEqual([f.dispatch,'maki 2.3.4']);
    rmSync(f.target);
    expect(isDefaultSwitchConfigured(plan)).toBe(false);
  }finally{f.close();}
});

test.each(['CLI default PATH v2','CLI default PATH v2 maki'])('exact %s migrates while foreign suffix bytes survive',async(label)=>{
  const f=fixture();try{
    const quoted=`'${f.source.replaceAll("'",`'\\''`)}'`;
    const foreign=Buffer.from('# prefix\n# suffix\nexport KEEP_ME=1\n');
    writeFileSync(f.profile,`# prefix\n# >>> ${label} >>>\nexport PATH=${quoted}:"$PATH"\n# <<< ${label} <<<\n# suffix\nexport KEEP_ME=1\n`);
    await applyDefaultSwitch(f.plan(),f.applyOptions);
    expect(readFileSync(f.profile).subarray(0,foreign.length)).toEqual(foreign);
    expect(readFileSync(f.profile,'utf8')).not.toContain(label);
    expect((await f.shell()).split('\n')).toEqual([f.dispatch,'maki 1.2.3']);
  }finally{f.close();}
});

test.each([false,true])('remaining other CLI v2 block cannot override dispatch with foreign suffix %s',async(suffix)=>{
  const f=fixture();try{
    const bin=join(f.root,'old-codex-bin');mkdirSync(bin);
    writeFileSync(join(bin,'maki'),'#!/bin/sh\necho maki 9.0.0\n',{mode:0o755});
    writeFileSync(join(bin,'codex'),'#!/bin/sh\necho codex 2.0.0\n',{mode:0o755});
    await applyDefaultSwitch(f.plan(),f.applyOptions);
    const block=`# >>> CLI default PATH v2 codex >>>\nexport PATH='${bin}':"$PATH"\n# <<< CLI default PATH v2 codex <<<\n`;
    const foreign=suffix?'# foreign suffix\nexport FOREIGN_SETTING=1\n':'';
    writeFileSync(f.profile,readFileSync(f.profile,'utf8')+block+foreign);
    await applyDefaultSwitch(f.plan(),f.applyOptions);
    const profile=readFileSync(f.profile,'utf8');
    expect(profile).toContain(block+foreign);
    expect(profile.indexOf('CLI default dispatch v3')).toBeGreaterThan(profile.indexOf('CLI default PATH v2 codex'));
    expect((await f.shell()).split('\n')).toEqual([f.dispatch,'maki 1.2.3']);
  }finally{f.close();}
});

test('later foreign PATH edits are preserved and invalidate configured status',async()=>{
  const f=fixture();try{
    const plan=f.plan();await applyDefaultSwitch(plan,f.applyOptions);
    const edited=readFileSync(f.profile,'utf8')+'export PATH=/foreign:"$PATH"\n';writeFileSync(f.profile,edited);
    expect(isDefaultSwitchConfigured(plan)).toBe(false);expect(readFileSync(f.profile,'utf8')).toBe(edited);
  }finally{f.close();}
});

test.each(['link','receipt','directory','other-command'])('foreign dispatch %s is never overwritten',async(kind)=>{
  const f=fixture();try{
    const plan=f.plan(),profile=readFileSync(f.profile);mkdirSync(join(f.directory,'dispatch'));mkdirSync(join(f.directory,'dispatch/bin'));
    const foreign=join(f.root,'foreign');writeFileSync(foreign,'foreign bytes');
    if(kind==='link')symlinkSync(f.target,f.dispatch);
    if(kind==='receipt')writeFileSync(join(f.directory,'dispatch/bin/.maki.target'),f.target);
    if(kind==='directory'){rmSync(join(f.directory,'dispatch/bin'),{recursive:true});symlinkSync(f.source,join(f.directory,'dispatch/bin'));}
    if(kind==='other-command')writeFileSync(join(f.directory,'dispatch/bin/not-selected'),'foreign bytes');
    await expect(applyDefaultSwitch(plan,f.applyOptions)).rejects.toThrow();
    expect(()=>f.plan()).toThrow();expect(readFileSync(f.profile)).toEqual(profile);expect(readFileSync(foreign,'utf8')).toBe('foreign bytes');
  }finally{f.close();}
});

test('failed selection restores the previous link and ownership receipt',async()=>{
  const f=fixture();try{
    const plan=f.plan();await applyDefaultSwitch(plan,f.applyOptions);
    const other=second(f),receipt=join(f.directory,'dispatch/bin/.maki.target'),before=readFileSync(receipt);
    writeFileSync(other.target,'#!/bin/sh\nexit 19\n');
    await expect(applyDefaultSwitch(other.plan(),f.applyOptions)).rejects.toThrow();
    expect(readlinkSync(f.dispatch)).toBe(f.target);expect(readFileSync(receipt)).toEqual(before);
    expect(isDefaultSwitchConfigured(plan)).toBe(true);
  }finally{f.close();}
});

test('concurrent link edits survive rollback while profile is restored',async()=>{
  const f=fixture();try{
    const profile=readFileSync(f.profile),foreign=second(f);
    const error=await applyDefaultSwitch(f.plan(),{...f.applyOptions,guard:()=>{
      if(readFileSync(f.profile,'utf8').includes('CLI default dispatch v3')){
        rmSync(f.dispatch);symlinkSync(foreign.target,f.dispatch);throw new AppError('busy','cancelled');
      }
    }}).catch((error:unknown)=>error);
    expect(error).toBeInstanceOf(AppError);
    if(!(error instanceof AppError))throw new Error('missing error');expect(error.code).toBe('uncertain');
    expect(readlinkSync(f.dispatch)).toBe(foreign.target);expect(readFileSync(f.profile)).toEqual(profile);
  }finally{f.close();}
});

test('a selected official path redirecting through dispatch is refused before forming a cycle',async()=>{
  const f=fixture();try{
    await applyDefaultSwitch(f.plan(),f.applyOptions);const other=second(f);
    rmSync(other.target);symlinkSync(f.dispatch,other.target);
    expect(other.plan).toThrow('default_requires_official_installation');
    expect(readlinkSync(f.dispatch)).toBe(f.target);
  }finally{f.close();}
});

test('versioned Homebrew payload paths cannot become persistent dispatch targets',()=>{
  const f=fixture();try{
    const bin=join(f.root,'Cellar/maki/1.2.3/bin');mkdirSync(bin,{recursive:true});const executable=join(bin,'maki');
    writeFileSync(executable,readFileSync(f.target),{mode:0o755});
    expect(()=>planDefaultSwitch({...f.options,installation:{...f.options.installation,path:executable,identityPath:executable,manager:'brew'}})).toThrow('default_requires_stable_launcher');
  }finally{f.close();}
});

test('old v2 strategy records stay readable but require a fresh plan',async()=>{
  const f=fixture();try{
    const plan={...f.plan(),strategy:'official-directory-path-v2' as const,launcher:f.target};
    expect(defaultSwitchPlanSchema.safeParse(plan).success).toBe(true);expect(isDefaultSwitchConfigured(plan)).toBe(false);
    await expect(applyDefaultSwitch(plan,f.applyOptions)).rejects.toThrow('default_switch_plan_stale');
  }finally{f.close();}
});

test('target deletion after publication restores profile and removes only owned dispatch files',async()=>{
  const f=fixture();try{
    const before=readFileSync(f.profile);
    await expect(applyDefaultSwitch(f.plan(),{...f.applyOptions,guard:()=>{
      if(readFileSync(f.profile,'utf8').includes('CLI default dispatch v3'))rmSync(f.target);
    }})).rejects.toThrow();
    expect(readFileSync(f.profile)).toEqual(before);
    expect(lstatSync(f.dispatch,{throwIfNoEntry:false})).toBeUndefined();
    expect(existsSync(join(f.directory,'dispatch/bin/.maki.target'))).toBe(false);
  }finally{f.close();}
});
