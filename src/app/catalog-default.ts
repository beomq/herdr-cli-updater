import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { absolutePath, changed, directoryState, fileState, hash, linkState, profileBytes, publish, stamp } from './catalog-default-files';
import { catalogDefinitions } from './catalog-registry';
import { findExecutable, parseCliVersion, runProcess } from './catalog-runner';
import { catalogIds } from './catalog-types';
import type { CatalogInstallation } from './catalog-types';
import { AppError } from './types';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const searchPath=z.string().max(32768).refine(value=>value.split(':').every(part=>absolutePath.safeParse(part).success));
export const defaultSwitchPlanSchema=z.object({
  id:z.string().uuid(),catalogId:z.enum(catalogIds),installationId:z.string().min(1),
  directory:absolutePath,home:absolutePath,path:searchPath,shell:z.literal('/bin/zsh'),
  executable:absolutePath,identityPath:absolutePath,launcher:absolutePath,profile:absolutePath,
  strategy:z.enum(['official-directory-path-v2','dispatch-links-v3']).optional(),
  fingerprints:z.object({
    target:digest,profile:digest.nullable(),launcher:digest.nullable(),
    home:digest,directory:digest,launchers:digest.nullable(),
    zshenv:digest.nullable(),zprofile:digest.nullable(),zlogin:digest.nullable(),
  }).strict(),
  description:z.string(),applicability:z.literal('new-interactive-zsh-shells'),
  limitations:z.array(z.string()).readonly(),
}).strict();
export type DefaultSwitchPlan=z.infer<typeof defaultSwitchPlanSchema>;
type PlanOptions={
  readonly directory:string;readonly home:string;readonly path:string;readonly shell:string;
  readonly installation:CatalogInstallation;
};
const fingerprintKeys=['target','profile','launcher','home','directory','launchers','zshenv','zprofile','zlogin'] as const;
const sameFingerprints=(left:DefaultSwitchPlan['fingerprints'],right:DefaultSwitchPlan['fingerprints'])=>
  fingerprintKeys.every(key=>left[key]===right[key]);
const receiptPath=(launcher:string)=>join(dirname(launcher),`.${basename(launcher)}.target`);
function unsupported():never {throw new AppError('unsupported','default_shell_configuration_unsupported');}
function targetFingerprint(executable:string,identityPath:string):string {
  const values=[executable,identityPath].map(path=>{
    const stat=lstatSync(path),physical=realpathSync(path);
    if(!stat.isFile()&&!stat.isSymbolicLink())changed();
    const file=fileState(physical,512_000_000);
    if(file.bytes===null||(file.mode&0o111)===0&&path===executable)changed();
    return [path,realpathSync(dirname(path)),stamp(stat),stat.isSymbolicLink()?readlinkSync(path):null,physical,file.fingerprint];
  });
  return hash(JSON.stringify(values));
}
function shellConfiguration(home:string,profile:ReturnType<typeof fileState>) {
  if(process.env['ZDOTDIR']!==undefined)unsupported();
  const startup=['.zshenv','.zprofile','.zlogin'].map(name=>fileState(join(home,name)));
  for(const state of [...startup,profile]){
    const active=state.bytes?.toString('utf8').split('\n').filter(line=>!line.trimStart().startsWith('#')).join('\n')??'';
    if(/\b(?:ZDOTDIR|RCS|GLOBAL_RCS|NO_RCS|NO_GLOBAL_RCS)\b/.test(active))unsupported();
  }
  return {zshenv:startup[0]?.fingerprint??null,zprofile:startup[1]?.fingerprint??null,zlogin:startup[2]?.fingerprint??null};
}
function independentTarget(directory:string,executable:string,identityPath:string,name:string):void {
  if(basename(executable)!==name)throw new AppError('unsupported','default_executable_name_unsupported');
  // Never pin a package-manager payload that an upgrade can garbage-collect.
  if(/\/(?:Cellar|Caskroom|node_modules)\/|\/versions\/\d/.test(executable))throw new AppError('unsupported','default_requires_stable_launcher');
  for(const path of [executable,identityPath,realpathSync(executable),realpathSync(identityPath)]){
    if(path===directory||path.startsWith(directory+'/'))throw new AppError('unsupported','default_requires_official_installation');
  }
  const visited=new Set<string>();let path=executable;
  while(lstatSync(path).isSymbolicLink()){
    if(visited.has(path))changed();visited.add(path);
    path=resolve(realpathSync(dirname(path)),readlinkSync(path));
    if(path===directory||path.startsWith(directory+'/'))throw new AppError('unsupported','default_requires_official_installation');
  }
}
function inspect(plan:Pick<DefaultSwitchPlan,'home'|'directory'|'profile'|'executable'|'identityPath'|'launcher'>) {
  const home=directoryState(plan.home),directory=directoryState(plan.directory);
  const dispatch=join(plan.directory,'dispatch'),bin=join(dispatch,'bin');
  const parents=[dispatch,bin].map(path=>lstatSync(path,{throwIfNoEntry:false})?directoryState(path):null);
  const otherLinks=[];
  for(const name of lstatSync(bin,{throwIfNoEntry:false})?readdirSync(bin).sort():[]){
    if(/^\.default-switch-[a-f0-9-]{36}$/.test(name))continue;
    if(name===basename(plan.launcher)||name===basename(receiptPath(plan.launcher)))continue;
    const executable=name.startsWith('.')&&name.endsWith('.target')?name.slice(1,-7):name;
    if(!catalogDefinitions.some(row=>row.executable===executable))throw new AppError('conflict','default_dispatch_directory_modified');
    const path=join(bin,executable),link=linkState(path),receipt=fileState(receiptPath(path));
    if(link.target===null||receipt.bytes?.toString('utf8')!==link.target)throw new AppError('conflict','default_dispatch_link_modified');
    otherLinks.push([name,link.fingerprint,receipt.fingerprint]);
  }
  const link=linkState(plan.launcher),receipt=fileState(receiptPath(plan.launcher));
  const profile=fileState(plan.profile),startup=shellConfiguration(plan.home,profile);
  return {profile,link,receipt,fingerprints:{home,directory,
    launchers:hash(JSON.stringify([directoryState(dirname(plan.executable)),...parents,otherLinks])),profile:profile.fingerprint,
    launcher:hash(JSON.stringify([link.fingerprint,receipt.fingerprint])),
    target:targetFingerprint(plan.executable,plan.identityPath),...startup}};
}
function ownedLink(state:ReturnType<typeof inspect>):void {
  if(state.link.target===null?state.receipt.bytes!==null:state.receipt.bytes?.toString('utf8')!==state.link.target)
    throw new AppError('conflict','default_dispatch_link_modified');
}
/** Read-only. The selected default does not change the managed update target. */
export function planDefaultSwitch(options:PlanOptions):DefaultSwitchPlan {
  if(options.shell!=='/bin/zsh')unsupported();
  const definition=catalogDefinitions.find(row=>row.id===options.installation.catalogId);
  if(!definition)throw new AppError('invalid_request');
  const directory=absolutePath.parse(options.directory),home=absolutePath.parse(options.home);
  const executable=absolutePath.parse(options.installation.path),identityPath=absolutePath.parse(options.installation.identityPath);
  if(options.installation.manager==='owned')throw new AppError('unsupported','default_requires_official_installation');
  independentTarget(directory,executable,identityPath,definition.executable);
  const base={directory,home,executable,identityPath,launcher:join(directory,'dispatch/bin',definition.executable),profile:join(home,'.zshrc')};
  const state=inspect(base);ownedLink(state);profileBytes(state.profile.bytes,directory,definition.id);
  return defaultSwitchPlanSchema.parse({
    ...base,id:randomUUID(),catalogId:definition.id,installationId:options.installation.id,
    strategy:'dispatch-links-v3',path:searchPath.parse(options.path),shell:'/bin/zsh',fingerprints:state.fingerprints,
    description:`Use a dedicated dispatch link to the selected ${definition.name} official launcher.`,
    applicability:'new-interactive-zsh-shells',
    limitations:[
      'Existing sessions and the managed update target are unchanged; the registration applies to newly opened shells.',
      'Only standard executable names and /bin/zsh with ~/.zshrc and no ZDOTDIR or RCS redirection are supported.',
      'Only this CLI is migrated; other CLI v2 blocks remain until explicitly selected. One dispatch directory is registered after them.',
      'Startup files are not executed: aliases, functions, dynamic configuration and later PATH overrides are not verified as actual shell defaults.',
      'Official launchers must remain installed. Removing an official installation can leave a dangling dispatch link; configured status then becomes false.',
      'Uninstalling the updater package alone leaves links working, but deleting its data directory removes dispatch links; the ~/.zshrc entry remains and needs manual removal.',
      'Private backups support manual restoration; concurrent edits prevent automatic rollback. No shared package-manager paths are modified or removed.',
    ],
  });
}
export function isDefaultSwitchConfigured(plan:DefaultSwitchPlan):boolean {
  try{
    const definition=catalogDefinitions.find(row=>row.id===plan.catalogId);
    if(!definition||plan.strategy!=='dispatch-links-v3'||plan.launcher!==join(plan.directory,'dispatch/bin',definition.executable)||plan.profile!==join(plan.home,'.zshrc'))return false;
    // An upgrade can replace the physical payload; the stable launcher is the persistent contract.
    independentTarget(plan.directory,plan.executable,realpathSync(plan.executable),definition.executable);
    const state=inspect({...plan,identityPath:realpathSync(plan.executable)});ownedLink(state);
    if(state.link.target!==plan.executable||!state.profile.bytes?.equals(profileBytes(state.profile.bytes,plan.directory,plan.catalogId)))return false;
    return state.fingerprints.zshenv===plan.fingerprints.zshenv&&state.fingerprints.zprofile===plan.fingerprints.zprofile&&state.fingerprints.zlogin===plan.fingerprints.zlogin;
  }catch(error){if(error instanceof Error)return false;throw error;}
}
export async function applyDefaultSwitch(input:DefaultSwitchPlan,options:{
  readonly home:string;readonly path:string;readonly guard:()=>void|Promise<void>;
}):Promise<{version:string;launcher:string;profile:string;backup:string|null}> {
  const plan=defaultSwitchPlanSchema.parse(input),definition=catalogDefinitions.find(row=>row.id===plan.catalogId);
  if(!definition||plan.strategy!=='dispatch-links-v3'||plan.home!==options.home||plan.path!==options.path
    ||plan.profile!==join(options.home,'.zshrc')||plan.launcher!==join(plan.directory,'dispatch/bin',definition.executable))changed();
  independentTarget(plan.directory,plan.executable,plan.identityPath,definition.executable);
  const initial=inspect(plan);ownedLink(initial);
  if(!sameFingerprints(initial.fingerprints,plan.fingerprints))changed();
  const nextProfile=profileBytes(initial.profile.bytes,plan.directory,plan.catalogId);
  let expected={...plan.fingerprints};
  const backup=join(plan.directory,`default-backup-${plan.id}`),receipt=receiptPath(plan.launcher);
  const check=()=>{if(!sameFingerprints(inspect(plan).fingerprints,expected))changed();};
  const checkpoint=async()=>{await options.guard();check();};
  await checkpoint();
  mkdirSync(backup,{mode:0o700});
  const backupIdentity=directoryState(backup);
  const save=(name:string,bytes:Buffer|string)=>{
    check();if(directoryState(backup)!==backupIdentity)changed();
    const fd=openSync(join(backup,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  };
  if(initial.profile.bytes!==null)save('profile',initial.profile.bytes);
  if(initial.receipt.bytes!==null)save('launcher-target',initial.receipt.bytes);
  save('restore.json',JSON.stringify({profile:{path:plan.profile,existed:initial.profile.bytes!==null,mode:initial.profile.mode},
    launcher:{path:plan.launcher,target:initial.link.target},receipt:{path:receipt,mode:initial.receipt.mode}}));
  const writes:{readonly path:string;readonly before:Buffer|string|null;readonly mode:number;readonly kind:'file'|'link';fingerprint:string|null}[]=[];
  let dispatchIdentity:string|null=null,binIdentity:string|null=null;
  let verificationHome:string|undefined;
  try {
    await checkpoint();
    for(const path of [join(plan.directory,'dispatch'),dirname(plan.launcher)]){
      check();if(!lstatSync(path,{throwIfNoEntry:false})){mkdirSync(path,{mode:0o700});expected={...expected,launchers:inspect(plan).fingerprints.launchers};}
    }
    dispatchIdentity=directoryState(join(plan.directory,'dispatch'));binIdentity=directoryState(dirname(plan.launcher));
    for(const write of [
      {path:plan.launcher,content:plan.executable,before:initial.link.target,mode:0o600,kind:'link' as const},
      {path:receipt,content:Buffer.from(plan.executable),before:initial.receipt.bytes,mode:0o600,kind:'file' as const},
      {path:plan.profile,content:nextProfile,before:initial.profile.bytes,mode:initial.profile.mode,kind:'file' as const},
    ]){
      if(typeof write.content==='string'?write.content===write.before:Buffer.isBuffer(write.before)&&write.content.equals(write.before))continue;
      publish(write.path,write.content,write.mode,check);
      const record:{readonly path:string;readonly before:Buffer|string|null;readonly mode:number;readonly kind:'file'|'link';fingerprint:string|null}={...write,fingerprint:null};writes.push(record);
      if(typeof write.content==='string'){
        const published=linkState(write.path);
        if(published.target!==write.content)throw new AppError('uncertain','default_write_unverified');
        record.fingerprint=published.fingerprint;
      }else{
        const published=fileState(write.path);
        if(!published.bytes?.equals(write.content)||published.mode!==write.mode)throw new AppError('uncertain','default_write_unverified');
        record.fingerprint=published.fingerprint;
      }
      const state=inspect(plan);
      expected=write.path===plan.profile?{...expected,profile:state.fingerprints.profile}:{...expected,launcher:state.fingerprints.launcher};
      check();
    }
    await checkpoint();
    verificationHome=realpathSync(mkdtempSync(join(tmpdir(),'default-switch-verify-')));
    const path=dirname(plan.launcher)+':'+options.path;
    if(findExecutable(definition.executable,path)!==realpathSync(plan.executable))changed();
    const output=await runProcess('/bin/sh',[
      '-c','[ "$(command -v "$1")" = "$2" ] || exit 125; exec "$1" --version',
      'default-switch-verify',definition.executable,plan.launcher,
    ],{HOME:verificationHome,PATH:path,TMPDIR:verificationHome,LANG:'C',CI:'1',NO_COLOR:'1',
      XDG_CONFIG_HOME:join(verificationHome,'.config'),XDG_CACHE_HOME:join(verificationHome,'.cache'),
      XDG_DATA_HOME:join(verificationHome,'.local/share'),XDG_STATE_HOME:join(verificationHome,'.local/state'),
      MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0'},verificationHome,5_000);
    const version=parseCliVersion(output);
    if(!version)throw new AppError('unavailable','default_version_unverified');
    await checkpoint();
    return {version,launcher:plan.launcher,profile:plan.profile,backup};
  }catch(error){
    let uncertain=false;
    for(const write of writes.reverse()){
      try {
        const stillOurs=()=>{
          if(directoryState(plan.home)!==expected.home||directoryState(plan.directory)!==expected.directory||
            directoryState(join(plan.directory,'dispatch'))!==dispatchIdentity||directoryState(dirname(plan.launcher))!==binIdentity||
            write.fingerprint===null||(write.kind==='link'?linkState(write.path).fingerprint:fileState(write.path).fingerprint)!==write.fingerprint)changed();
        };
        if(write.before===null){stillOurs();unlinkSync(write.path);}
        else publish(write.path,write.before,write.mode,stillOurs);
      }catch(rollbackError){if(!(rollbackError instanceof Error))throw rollbackError;uncertain=true;}
    }
    if(uncertain)throw new AppError('uncertain','default_rollback_uncertain');
    throw error;
  }finally{if(verificationHome)rmSync(verificationHome,{recursive:true,force:true});}
}
