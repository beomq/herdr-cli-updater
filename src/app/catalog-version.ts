import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CatalogId } from './catalog-types';
import { catalogPackage } from './catalog-registry';
import { runProcess, parseCliVersion } from './catalog-runner';
import { AppError } from './types';
import { bunOmoEntry } from './omo-installation';

export type VersionState = {
  readonly version:string|null;
  readonly status:'checking'|'known'|'unsupported'|'timeout'|'failed'|'unrecognized';
  readonly checkedAt:number|null;
};
type Options = {readonly home:string;readonly path:string;readonly changed:()=>void};
// Explicit noninteractive version invocations only; unsupported CLIs do not run.
const versionArgs = {
  agy:['--version'],amp:['--version'],claude:['--version'],cline:['--version'],codex:['--version'],
  cursor:['--version'],devin:['--version'],droid:['--version'],gjc:['--version'],
  copilot:['--version'],grok:['--version'],hermes:['--version'],kilo:['--version'],kimi:['--version'],kiro:['--version'],
  letta:['--version'],maki:['--version'],muse:['--version'],omp:['--version'],omo:['--version'],
  opencode:['--version'],pi:['--version'],qodercli:['--version'],qwen:['--version'],
} as const satisfies Record<CatalogId,readonly string[]|null>;
type Probe = {readonly key:string;readonly executable:string;readonly args:readonly string[];state:VersionState};

export function createVersionProbe(options:Options,dependencies:{readonly run?:typeof runProcess}={}) {
  const cache=new Map<string,Probe>();
  const queue:Probe[]=[];
  const waiters:Array<()=>void>=[];
  let active=0;
  async function execute(probe:Probe):Promise<void> {
    let home:string|undefined;
    let state:VersionState;
    try {
      home=realpathSync(mkdtempSync(join(tmpdir(),'cli-version-')));
      const output=await (dependencies.run??runProcess)(probe.executable,probe.args,{
        HOME:home,PATH:options.path,LANG:'C',CI:'1',NO_COLOR:'1',TMPDIR:home,MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0',
        XDG_CONFIG_HOME:join(home,'.config'),XDG_CACHE_HOME:join(home,'.cache'),
        XDG_DATA_HOME:join(home,'.local/share'),XDG_STATE_HOME:join(home,'.local/state'),
      },home,5_000);
      const version=parseCliVersion(output);
      state={version,status:version?'known':'unrecognized',checkedAt:Date.now()};
    } catch(error) { // Process boundary: even non-Error rejections become a failed probe.
      state={version:null,status:error instanceof AppError&&error.code==='timeout'?'timeout':'failed',checkedAt:Date.now()};
    }
    try {if(home)rmSync(home,{recursive:true,force:true});}
    catch(error){ // Cleanup is part of probe success, not an unhandled background rejection.
      state={version:null,status:'failed',checkedAt:Date.now()};
    }
    // Refresh or a replacement probe may have taken ownership while this process ran.
    if(cache.get(probe.key)===probe){probe.state=state;options.changed();}
  }
  function pump():void {
    while(active<3&&queue.length){
      const probe=queue.shift();if(!probe)break;
      active++;
      void execute(probe).finally(()=>{
        active--;pump();
        if(active===0&&queue.length===0)for(const resolve of waiters.splice(0))resolve();
      });
    }
  }
  function read(id:CatalogId,executable:string):VersionState {
    const args=versionArgs[id];
    if(!args)return {version:null,status:'unsupported',checkedAt:null};
    let physical:string,key:string;
    try {
      physical=id==='omo'?(bunOmoEntry(executable,options.home)??realpathSync(executable)):realpathSync(executable);
      const stat=statSync(physical,{bigint:true});
      if(!stat.isFile())return {version:null,status:'failed',checkedAt:Date.now()};
      key=[physical,stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.mode,args.join('\0')].join(':');
      const packageName=catalogPackage(id);
      if(packageName){
        for(let directory=dirname(physical);;directory=dirname(directory)){
          const manifest=join(directory,'package.json');
          if(existsSync(manifest)){
            const metadata:unknown=JSON.parse(readFileSync(manifest,'utf8'));
            if(typeof metadata==='object'&&metadata!==null&&'name' in metadata&&metadata.name===packageName){
              const manifestStat=statSync(manifest,{bigint:true});
              key+=':'+ [manifest,manifestStat.dev,manifestStat.ino,manifestStat.size,manifestStat.mtimeNs,manifestStat.ctimeNs].join(':');
              break;
            }
          }
          if(dirname(directory)===directory)break;
        }
      }
    } catch(error) {
      if(!(error instanceof Error))throw error;
      return {version:null,status:'failed',checkedAt:Date.now()};
    }
    const cached=cache.get(key);if(cached)return cached.state;
    const probe:Probe={key,executable:physical,args,state:{version:null,status:'checking',checkedAt:null}};
    cache.set(key,probe);queue.push(probe);
    // Keep read synchronous even when a test runner completes immediately.
    queueMicrotask(pump);
    return probe.state;
  }
  return {
    read,
    refresh():void {
      cache.clear();queue.length=0;
      if(active===0)for(const resolve of waiters.splice(0))resolve();
      options.changed();
    },
    settled():Promise<void> {
      return active===0&&queue.length===0?Promise.resolve():new Promise(resolve=>waiters.push(resolve));
    },
  };
}
