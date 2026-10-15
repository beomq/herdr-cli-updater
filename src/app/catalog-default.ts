import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { z } from 'zod';
import { catalogDefinitions } from './catalog-registry';
import { findExecutable, parseCliVersion, runProcess } from './catalog-runner';
import { catalogIds } from './catalog-types';
import type { CatalogInstallation } from './catalog-types';
import { AppError } from './types';

const absolutePath=z.string().startsWith('/').max(4096).regex(/^[^\x00-\x1f\x7f:]+$/)
  .refine(value=>normalize(value)===value&&value!=='/');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const searchPath=z.string().max(32768).refine(value=>value.split(':').every(part=>absolutePath.safeParse(part).success));
export const defaultSwitchPlanSchema=z.object({
  id:z.string().uuid(),catalogId:z.enum(catalogIds),installationId:z.string().min(1),
  directory:absolutePath,home:absolutePath,path:searchPath,shell:z.literal('/bin/zsh'),
  executable:absolutePath,identityPath:absolutePath,launcher:absolutePath,profile:absolutePath,
  strategy:z.literal('official-directory-path-v2').optional(),
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
type FileState={readonly fingerprint:string|null;readonly bytes:Buffer|null;readonly mode:number};
const begin='# >>> CLI default PATH v2 >>>';
const end='# <<< CLI default PATH v2 <<<';
const legacyBegin='# >>> herdr-cli-updater PATH >>>';
const legacyEnd='# <<< herdr-cli-updater PATH <<<';
const startupFiles=['.zshenv','.zprofile','.zlogin'] as const;
const fingerprintKeys=['target','profile','launcher','home','directory','launchers','zshenv','zprofile','zlogin'] as const;
const sameFingerprints=(left:DefaultSwitchPlan['fingerprints'],right:DefaultSwitchPlan['fingerprints'])=>
  fingerprintKeys.every(key=>left[key]===right[key]);
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const quote=(value:string)=>`'${value.replaceAll("'",`'\\''`)}'`;
function changed():never {throw new AppError('source_changed','default_switch_plan_stale');}
function unsupported():never {throw new AppError('unsupported','default_shell_configuration_unsupported');}
function stamp(stat:ReturnType<typeof fstatSync>):string {
  return JSON.stringify([stat.dev,stat.ino,stat.mode,stat.nlink,stat.uid,stat.size,stat.mtimeMs,stat.ctimeMs]);
}
function directoryState(path:string):string {
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if(!stat||!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path)changed();
  return hash(JSON.stringify([path,stat.dev,stat.ino,stat.mode,stat.uid]));
}
function fileState(path:string,maxBytes=1_048_576):FileState {
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if(!stat)return {fingerprint:null,bytes:null,mode:0o600};
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>maxBytes)changed();
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=fstatSync(fd);
    if(stamp(stat)!==stamp(before))changed();
    const bytes=readFileSync(fd),after=fstatSync(fd);
    if(stamp(before)!==stamp(after)||stamp(lstatSync(path))!==stamp(after))changed();
    return {fingerprint:hash(Buffer.concat([Buffer.from(stamp(after)),bytes])),bytes,mode:after.mode&0o777};
  }finally{closeSync(fd);}
}
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
function pathBlock(targetDirectory:string,catalogId?:string):Buffer {
  const start=catalogId?`# >>> CLI default PATH v2 ${catalogId} >>>`:begin;
  const finish=catalogId?`# <<< CLI default PATH v2 ${catalogId} <<<`:end;
  return Buffer.from(`${start}\nexport PATH=${quote(targetDirectory)}:"$PATH"\n${finish}\n`);
}
function profileBytes(original:Buffer|null,directory:string,targetDirectory:string,catalogId:string):Buffer {
  let bytes=original??Buffer.alloc(0);
  const ownBegin=`# >>> CLI default PATH v2 ${catalogId} >>>`,ownEnd=`# <<< CLI default PATH v2 ${catalogId} <<<`;
  const at=bytes.indexOf(ownBegin),endAt=bytes.indexOf(ownEnd);
  if(at!==-1||endAt!==-1){
    if(at<0||endAt<at||at>0&&bytes[at-1]!==10||bytes.indexOf(ownBegin,at+1)!==-1||bytes.indexOf(ownEnd,endAt+1)!==-1)
      throw new AppError('conflict','default_path_block_modified');
    const stop=endAt+Buffer.byteLength(ownEnd)+1;
    const block=bytes.subarray(at,stop).toString('utf8');
    const lines=block.split('\n'),line=lines[1];
    if(lines.length!==4||!line?.startsWith('export PATH=')||!line.endsWith(':"$PATH"')||lines[3]!=='')
      throw new AppError('conflict','default_path_block_modified');
    const encoded=line.slice('export PATH='.length,-':"$PATH"'.length);
    const previous=encoded.slice(1,-1).replaceAll("'\\''","'");
    if(!absolutePath.safeParse(previous).success||block!==pathBlock(previous,catalogId).toString('utf8'))
      throw new AppError('conflict','default_path_block_modified');
    if(previous===targetDirectory)return bytes;
    bytes=Buffer.concat([bytes.subarray(0,at),bytes.subarray(stop)]);
  }
  const legacy=Buffer.from(`${legacyBegin}\nexport PATH=${quote(join(directory,'launchers'))}:"$PATH"\n${legacyEnd}\n`);
  // Only replace the exact generated trailing block. Preserve all foreign bytes.
  for(const [start,finish,expected] of [[legacyBegin,legacyEnd,legacy],[begin,end,null]] as const){
    const first=bytes.indexOf(start);
    if(first===-1&&bytes.indexOf(finish)===-1)continue;
    if(first<0||first>0&&bytes[first-1]!==10||bytes.indexOf(start,first+1)!==-1)throw new AppError('conflict','default_path_block_modified');
    const suffix=bytes.subarray(first);
    if(expected){
      if(!suffix.equals(expected))throw new AppError('conflict','default_path_block_modified');
    }else{
      const text=suffix.toString('utf8');
      const match=/^# >>> CLI default PATH v2 >>>\nexport PATH=('(?:[^']|'\\'')*'):"\$PATH"\n# <<< CLI default PATH v2 <<<\n$/.exec(text);
      if(!match)throw new AppError('conflict','default_path_block_modified');
      const previous=match[1]!.slice(1,-1).replaceAll("'\\''","'");
      if(!absolutePath.safeParse(previous).success||!suffix.equals(pathBlock(previous)))throw new AppError('conflict','default_path_block_modified');
    }
    bytes=bytes.subarray(0,first);
  }
  return Buffer.concat([bytes,bytes.length&&bytes[bytes.length-1]!==10?Buffer.from('\n'):Buffer.alloc(0),pathBlock(targetDirectory,catalogId)]);
}
function shellConfiguration(home:string,profile:FileState):Record<'zshenv'|'zprofile'|'zlogin',string|null> {
  if(process.env['ZDOTDIR']!==undefined)unsupported();
  const startup=startupFiles.map(name=>fileState(join(home,name)));
  for(const state of [...startup,profile]){
    const active=state.bytes?.toString('utf8').split('\n').filter(line=>!line.trimStart().startsWith('#')).join('\n')??'';
    if(/\b(?:ZDOTDIR|RCS|GLOBAL_RCS|NO_RCS|NO_GLOBAL_RCS)\b/.test(active))unsupported();
  }
  return {zshenv:startup[0]?.fingerprint??null,zprofile:startup[1]?.fingerprint??null,zlogin:startup[2]?.fingerprint??null};
}
function independentTarget(directory:string,executable:string,identityPath:string,name:string):void {
  if(basename(executable)!==name)throw new AppError('unsupported','default_executable_name_unsupported');
  for(const path of [executable,identityPath,realpathSync(executable),realpathSync(identityPath)]){
    if(path===directory||path.startsWith(directory+'/'))throw new AppError('unsupported','default_requires_official_installation');
  }
}
function inspect(plan:Pick<DefaultSwitchPlan,'home'|'directory'|'profile'|'executable'|'identityPath'>) {
  const home=directoryState(plan.home),directory=directoryState(plan.directory);
  const launchers=directoryState(dirname(plan.executable));
  const profile=fileState(plan.profile),startup=shellConfiguration(plan.home,profile);
  return {profile,fingerprints:{home,directory,launchers,profile:profile.fingerprint,launcher:null,
    target:targetFingerprint(plan.executable,plan.identityPath),...startup}};
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
  const base={directory,home,executable,identityPath,launcher:executable,profile:join(home,'.zshrc')};
  const state=inspect(base);profileBytes(state.profile.bytes,directory,dirname(executable),definition.id);
  return defaultSwitchPlanSchema.parse({
    ...base,id:randomUUID(),catalogId:definition.id,installationId:options.installation.id,
    strategy:'official-directory-path-v2',path:searchPath.parse(options.path),shell:'/bin/zsh',fingerprints:state.fingerprints,
    description:`Use the selected ${definition.name} official executable directory on PATH.`,
    applicability:'new-interactive-zsh-shells',
    limitations:[
      'Existing sessions and the managed update target are unchanged.',
      'Only standard executable names and /bin/zsh with ~/.zshrc and no ZDOTDIR or RCS redirection are supported.',
      'The whole selected directory precedes PATH, including other commands in a shared directory.',
      'Startup files are not executed: aliases, functions, dynamic configuration and later login PATH overrides are not verified.',
      'Official package-manager links must remain installed; updater deletion does not remove the selected executable or PATH entry.',
      'Private backups support manual restoration; concurrent edits prevent automatic rollback.',
    ],
  });
}
export function isDefaultSwitchConfigured(plan:DefaultSwitchPlan):boolean {
  try{
    if(plan.strategy!=='official-directory-path-v2'||plan.launcher!==plan.executable)return false;
    const definition=catalogDefinitions.find(row=>row.id===plan.catalogId);
    if(!definition||plan.profile!==join(plan.home,'.zshrc'))return false;
    independentTarget(plan.directory,plan.executable,plan.identityPath,definition.executable);
    const profile=fileState(plan.profile);
    if(!profile.bytes||!profile.bytes.equals(profileBytes(profile.bytes,plan.directory,dirname(plan.executable),plan.catalogId)))return false;
    targetFingerprint(plan.executable,plan.identityPath);
    const startup=shellConfiguration(plan.home,profile);
    return startup.zshenv===plan.fingerprints.zshenv&&startup.zprofile===plan.fingerprints.zprofile&&startup.zlogin===plan.fingerprints.zlogin;
  }catch(error){if(error instanceof Error)return false;throw error;}
}
function publish(path:string,bytes:Buffer,mode:number,before:()=>void):FileState {
  const temporary=join(dirname(path),`.default-switch-${randomUUID()}`);
  const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {writeFileSync(fd,bytes);fchmodSync(fd,mode);fsyncSync(fd);}finally{closeSync(fd);}
  try {
    before();renameSync(temporary,path);
    try {
      const state=fileState(path);
      if(state.bytes===null||!state.bytes.equals(bytes)||(state.mode&0o777)!==mode)changed();
      return state;
    }catch(error){if(error instanceof Error)throw new AppError('uncertain','default_write_unverified');throw error;}
  }finally{if(lstatSync(temporary,{throwIfNoEntry:false}))unlinkSync(temporary);}
}
export async function applyDefaultSwitch(input:DefaultSwitchPlan,options:{
  readonly home:string;readonly path:string;readonly guard:()=>void|Promise<void>;
}):Promise<{version:string;launcher:string;profile:string;backup:string|null}> {
  const plan=defaultSwitchPlanSchema.parse(input),definition=catalogDefinitions.find(row=>row.id===plan.catalogId);
  if(!definition||plan.strategy!=='official-directory-path-v2'||plan.home!==options.home||plan.path!==options.path
    ||plan.profile!==join(options.home,'.zshrc')||plan.launcher!==plan.executable)changed();
  independentTarget(plan.directory,plan.executable,plan.identityPath,definition.executable);
  const initial=inspect(plan);
  if(!sameFingerprints(initial.fingerprints,plan.fingerprints))changed();
  const nextProfile=profileBytes(initial.profile.bytes,plan.directory,dirname(plan.executable),plan.catalogId);
  let expected={...plan.fingerprints},writtenProfile:FileState|undefined;
  const backup=join(plan.directory,`default-backup-${plan.id}`);
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
  save('restore.json',JSON.stringify({profile:{path:plan.profile,existed:initial.profile.bytes!==null,mode:initial.profile.mode}}));
  let verificationHome:string|undefined;
  try {
    await checkpoint();
    if(!initial.profile.bytes?.equals(nextProfile)){
      writtenProfile=publish(plan.profile,nextProfile,initial.profile.mode,check);
      expected={...expected,profile:writtenProfile.fingerprint};
    }
    await checkpoint();
    verificationHome=realpathSync(mkdtempSync(join(tmpdir(),'default-switch-verify-')));
    const path=dirname(plan.executable)+':'+options.path;
    if(findExecutable(definition.executable,path)!==realpathSync(plan.executable))changed();
    const output=await runProcess('/bin/sh',[
      '-c','[ "$(command -v "$1")" = "$2" ] || exit 125; exec "$1" --version',
      'default-switch-verify',definition.executable,plan.executable,
    ],{HOME:verificationHome,PATH:path,TMPDIR:verificationHome,LANG:'C',CI:'1',NO_COLOR:'1',
      XDG_CONFIG_HOME:join(verificationHome,'.config'),XDG_CACHE_HOME:join(verificationHome,'.cache'),
      XDG_DATA_HOME:join(verificationHome,'.local/share'),XDG_STATE_HOME:join(verificationHome,'.local/state'),
      MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0'},verificationHome,5_000);
    const version=parseCliVersion(output);
    if(!version)throw new AppError('unavailable','default_version_unverified');
    await checkpoint();
    return {version,launcher:plan.executable,profile:plan.profile,backup};
  }catch(error){
    try {
      if(writtenProfile){
        const stillOurs=()=>{
          if(directoryState(plan.home)!==expected.home||directoryState(plan.directory)!==expected.directory
            ||fileState(plan.profile).fingerprint!==writtenProfile!.fingerprint)changed();
        };
        if(initial.profile.bytes===null){stillOurs();unlinkSync(plan.profile);}
        else publish(plan.profile,initial.profile.bytes,initial.profile.mode,stillOurs);
      }
    }catch(rollbackError){if(rollbackError instanceof Error)throw new AppError('uncertain','default_rollback_uncertain');throw rollbackError;}
    throw error;
  }finally{if(verificationHome)rmSync(verificationHome,{recursive:true,force:true});}
}
