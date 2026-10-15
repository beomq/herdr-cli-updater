import { expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVersionProbe } from '../../src/app/catalog-version';
import { runProcess, parseCliVersion } from '../../src/app/catalog-runner';
import { AppError } from '../../src/app/types';

function fixture(){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'version-test-')));
  function executable(name:string,body='printf "tool 1.2.3\\n"'){
    const file=join(directory,name);writeFileSync(file,`#!/bin/sh\n${body}\n`,{mode:0o700});return file;
  }
  return {directory,executable,close:()=>rmSync(directory,{recursive:true,force:true})};
}
test.each([
  ['gjc/0.16.4','0.16.4'],
  ['omp/19.4.0','19.4.0'],
  ['tool (v1.2.3)','1.2.3'],
  ['https://example.com/1.2.3',null],
])('parses CLI version output without treating a URL as a version: %s',(output,version)=>{
  expect(parseCliVersion(output)).toBe(version);
});
test('GJC name/version output becomes a known installed version',async()=>{
  const f=fixture(),file=f.executable('gjc',`printf 'gjc/0.16.4\\n'`);
  const probe=createVersionProbe({home:f.directory,path:'/usr/bin:/bin',changed:()=>{}});
  try{
    probe.read('gjc',file);await probe.settled();
    expect(probe.read('gjc',file)).toMatchObject({version:'0.16.4',status:'known'});
  }finally{await probe.settled();f.close();}
});

test('agy runs --version in an isolated home and cleans it before settled',async()=>{
  // Given a CLI that writes to HOME and records the environment it received.
  const f=fixture();const record=join(f.directory,'environment');
  const executable=f.executable('agy',`[ "$1" = --version ] || exit 2\nprintf '%s\\n' "$HOME" "$XDG_CONFIG_HOME" "$PATH" "$PWD" > '${record}'\nprintf x > "$HOME/probe-write"\nprintf 'agy 2.3.4-beta.1\\n'`);
  let changes=0;
  const probe=createVersionProbe({home:f.directory,path:'/usr/bin:/bin',changed:()=>{changes++;}});
  try{
    // When read starts the real process.
    expect(probe.read('agy',executable)).toEqual({version:null,status:'checking',checkedAt:null});
    await probe.settled();
    // Then only the temporary home was used, and it has been removed.
    const state=probe.read('agy',executable);
    expect(state.version).toBe('2.3.4-beta.1');expect(state.status).toBe('known');expect(state.checkedAt).toBeNumber();
    const [home,config,path,cwd]=readFileSync(record,'utf8').trim().split('\n');
    if(!home)throw new Error('missing isolated HOME');
    expect(home).not.toBe(f.directory);expect(config).toBe(join(home,'.config'));
    expect(path).toBe('/usr/bin:/bin');expect(cwd).toBe(home);
    expect(existsSync(home)).toBe(false);expect(existsSync(join(f.directory,'probe-write'))).toBe(false);expect(changes).toBe(1);
  }finally{await probe.settled();f.close();}
});

test('aliases deduplicate by physical fingerprint and file changes trigger a new probe',async()=>{
  const f=fixture();const file=f.executable('cli');const alias=join(f.directory,'alias');symlinkSync(file,alias);
  let calls=0;
  const probe=createVersionProbe({home:f.directory,path:'/bin',changed:()=>{}},{run:async()=>{calls++;return 'v1.2.3';}});
  try{
    probe.read('agy',file);probe.read('codex',alias);await probe.settled();
    expect(calls).toBe(1);expect(probe.read('codex',alias).version).toBe('1.2.3');
    writeFileSync(file,'#!/bin/sh\nprintf "changed longer content"\n');
    expect(probe.read('agy',file).status).toBe('checking');await probe.settled();expect(calls).toBe(2);
  }finally{await probe.settled();f.close();}
});

test('settled includes queued probes while concurrency remains bounded',async()=>{
  const f=fixture();const files=Array.from({length:8},(_,index)=>f.executable(`cli-${index}`));
  const releases=files.map(()=>Promise.withResolvers<void>());
  const entered=files.map(()=>Promise.withResolvers<void>());
  let calls=0,active=0,maximum=0,finished=false;
  const probe=createVersionProbe({home:f.directory,path:'/bin',changed:()=>{}},{run:async()=>{
    const index=calls++;const release=releases[index],entry=entered[index];
    if(!release||!entry)throw new Error('unexpected execution');
    active++;maximum=Math.max(maximum,active);entry.resolve();await release.promise;active--;return '1.2.3';
  }});
  try{
    for(const file of files)probe.read('agy',file);
    const settled=probe.settled().then(()=>{finished=true;});
    await Promise.all(entered.slice(0,3).map(entry=>entry.promise));
    expect(calls).toBe(3);expect(finished).toBe(false);
    for(let index=0;index<files.length;index++){
      const entry=entered[index],release=releases[index];if(!entry||!release)throw new Error('missing gate');
      await entry.promise;expect(finished).toBe(false);release.resolve();
    }
    await settled;expect(calls).toBe(8);expect(maximum).toBe(3);
    expect(files.every(file=>probe.read('agy',file).status==='known')).toBe(true);
  }finally{for(const release of releases)release.resolve();await probe.settled();f.close();}
});

test('matching npm manifest changes invalidate unchanged entry scripts but unrelated manifests do not',async()=>{
  const f=fixture();const nested=join(f.directory,'bin');mkdirSync(nested);
  const manifest=join(f.directory,'package.json'),unrelated=join(nested,'package.json');
  writeFileSync(manifest,JSON.stringify({name:'@openai/codex',version:'1.0.0'}));
  writeFileSync(unrelated,JSON.stringify({name:'unrelated',version:'9.0.0'}));
  const file=join(nested,'codex');writeFileSync(file,'#!/bin/sh\n',{mode:0o700});let calls=0;
  const probe=createVersionProbe({home:f.directory,path:'/bin',changed:()=>{}},{run:async()=>{calls++;return `${calls}.0.0`;}});
  try{
    probe.read('codex',file);await probe.settled();
    writeFileSync(unrelated,JSON.stringify({name:'unrelated',version:'99.0.0'}));
    expect(probe.read('codex',file).version).toBe('1.0.0');expect(calls).toBe(1);
    writeFileSync(manifest,JSON.stringify({name:'@openai/codex',version:'22.0.0'}));
    expect(probe.read('codex',file).status).toBe('checking');await probe.settled();
    expect(probe.read('codex',file).version).toBe('2.0.0');expect(calls).toBe(2);
  }finally{await probe.settled();f.close();}
});

test('hardlinked executable paths keep distinct invocation identity',async()=>{
  const f=fixture();const file=f.executable('cli'),hardlink=join(f.directory,'other');linkSync(file,hardlink);
  const calls:string[]=[];
  const probe=createVersionProbe({home:f.directory,path:'/bin',changed:()=>{}},{run:async executable=>{calls.push(executable);return '1.0.0';}});
  try{
    probe.read('agy',file);probe.read('agy',hardlink);await probe.settled();
    expect(calls).toEqual([file,hardlink]);
  }finally{await probe.settled();f.close();}
});

test('refresh rejects stale in-flight completion and retains fresh probe ownership',async()=>{
  const f=fixture();const file=f.executable('cli');
  const first=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let calls=0,changes=0;
  const probe=createVersionProbe({home:f.directory,path:'/bin',changed:()=>{changes++;}},{run:async()=>{
    if(++calls===1){entered.resolve();await first.promise;return '1.0.0';}return '2.0.0';
  }});
  try{
    probe.read('agy',file);await entered.promise;
    probe.refresh();expect(probe.read('agy',file).status).toBe('checking');
    first.resolve();await probe.settled();
    expect(probe.read('agy',file).version).toBe('2.0.0');expect(calls).toBe(2);expect(changes).toBe(2);
  }finally{first.resolve();await probe.settled();f.close();}
});

test('refresh settles a discarded queue even before any process starts',async()=>{
  const f=fixture();let calls=0;
  const probe=createVersionProbe({home:f.directory,path:'/bin',changed:()=>{}},{run:async()=>{calls++;return '1.2.3';}});
  try{
    probe.read('agy',f.executable('cli'));const pending=probe.settled();probe.refresh();await pending;
    expect(calls).toBe(0);
  }finally{await probe.settled();f.close();}
});

test('missing executables never invoke the runner',async()=>{
  const f=fixture();let calls=0;
  const probe=createVersionProbe({home:f.directory,path:'/bin',changed:()=>{}},{run:async()=>{calls++;return '1.2.3';}});
  try{
    expect(probe.read('agy',join(f.directory,'missing')).status).toBe('failed');await probe.settled();expect(calls).toBe(0);
  }finally{f.close();}
});

test.each(['devin','grok','hermes','muse'] as const)('newly supported %s probes version without Muse login or auto-update',async id=>{
  const f=fixture();let calls=0;
  const probe=createVersionProbe({home:f.directory,path:'/bin',changed:()=>{}},{run:async(_file,args,env)=>{
    calls++;expect(args).toEqual(['--version']);expect(env['MUSE_NO_AUTO_UPDATE']).toBe('1');expect(env['MUSE_LOGIN']).toBe('0');return '1.2.3';
  }});
  try{const file=f.executable('cli');probe.read(id,file);await probe.settled();expect(probe.read(id,file).version).toBe('1.2.3');expect(calls).toBe(1);}
  finally{f.close();}
});

test.each([
  ['timeout',new AppError('timeout','installer_timeout')],
  ['failed',new AppError('unavailable','installer_exit_1')],
  ['failed',new Error('spawn failure')],
] as const)('%s maps process failures and cleans temporary HOME',async(status,error)=>{
  const f=fixture();const file=f.executable('cli');let home:string|undefined;
  const probe=createVersionProbe({home:f.directory,path:'/bin',changed:()=>{}},{run:async(_exe,_args,env,_cwd,timeout)=>{
    home=env['HOME'];expect(timeout).toBe(5_000);throw error;
  }});
  try{
    probe.read('agy',file);await probe.settled();
    expect(probe.read('agy',file)).toMatchObject({version:null,status});expect(probe.read('agy',file).checkedAt).toBeNumber();
    if(!home)throw new Error('missing HOME');expect(existsSync(home)).toBe(false);
  }finally{await probe.settled();f.close();}
});

test('successful output without a version is unrecognized and nonzero exit is failed',async()=>{
  const f=fixture();const unknown=f.executable('unknown','printf "welcome\\n"'),failed=f.executable('failed','printf "1.2.3\\n"; exit 1');
  const probe=createVersionProbe({home:f.directory,path:'/bin',changed:()=>{}},{run:runProcess});
  try{
    probe.read('agy',unknown);probe.read('agy',failed);await probe.settled();
    expect(probe.read('agy',unknown)).toMatchObject({version:null,status:'unrecognized'});
    expect(probe.read('agy',failed)).toMatchObject({version:null,status:'failed'});
  }finally{await probe.settled();f.close();}
});
