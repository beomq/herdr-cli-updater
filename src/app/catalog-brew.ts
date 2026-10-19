import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { catalogDefinitions } from './catalog-registry';
import { findExecutable, parseCliVersion, runProcess } from './catalog-runner';
import type { CatalogId } from './catalog-types';
import { AppError } from './types';

const pathSchema=z.string().startsWith('/').max(4096).regex(/^[^\x00-\x1f\x7f]*$/).refine(p=>normalize(p)===p);
const token=z.string().regex(/^[a-z0-9][a-z0-9+_.@-]*$/);
const tapSchema=z.string().regex(/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/);
const versionSchema=z.string().max(128).regex(/^\d[0-9A-Za-z.+,_-]*$/);
export const brewTargetSchema=z.object({
  kind:z.literal('brew'),target:pathSchema,executable:pathSchema,manager:pathSchema,
  packageName:z.string().regex(/^(?:[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9+_.@-]*$/),
  packageKind:z.enum(['formula','cask']),payloadRoot:pathSchema,
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),preserve:z.array(pathSchema).min(1).max(256).readonly(),
  receiptPaths:z.array(pathSchema).min(1).max(8).readonly(),
}).strict();
export type BrewTarget=Readonly<z.infer<typeof brewTargetSchema>>;
type Base=Omit<BrewTarget,'fingerprint'>;
type Options={readonly home:string;readonly path:string;readonly beforeMutation?:()=>void};
const sourceSchema=z.object({tap:tapSchema,path:z.string(),spec:z.string().optional(),
  versions:z.object({stable:versionSchema,version_scheme:z.number().int().nonnegative().optional()}).optional(),version:versionSchema.optional()});
const artifactsSchema=z.array(z.record(z.string(),z.unknown())).max(128);
const variationsSchema=z.record(z.string(),z.object({version:versionSchema.optional(),
  versions:z.object({stable:versionSchema}).optional(),revision:z.number().int().nonnegative().optional(),
  version_scheme:z.number().int().nonnegative().optional()})).optional();
const receiptSchema=z.object({homebrew_version:z.string().min(1),source:sourceSchema,
  uninstall_flight_blocks:z.boolean().optional(),uninstall_artifacts:artifactsSchema.optional()});
function changed():never {throw new AppError('source_changed','brew_target_changed');}
function unsupported():never {throw new AppError('unsupported','brew_source_unverified');}
function physical(path:string):void {if(realpathSync(path)!==path||lstatSync(path).isSymbolicLink())changed();}
function json(path:string):unknown {physical(path);if(!lstatSync(path).isFile()||lstatSync(path).size>1_000_000)changed();return JSON.parse(readFileSync(path,'utf8'));}
function packageName(tap:string,name:string,kind:BrewTarget['packageKind']):string {
  return tap===`homebrew/${kind==='formula'?'core':'cask'}`?name:`${tap}/${name}`;
}
function safeRelative(path:string):boolean {
  return path.length>0&&!path.startsWith('/')&&!path.includes('$')&&!path.includes('~')&&normalize(path)===path&&
    !path.split('/').some(part=>part==='..'||part.endsWith('.app'));
}
function env(options:Options):NodeJS.ProcessEnv {
  return {HOME:options.home,PATH:options.path,LANG:'C',CI:'1',NO_COLOR:'1',
    HOMEBREW_NO_AUTO_UPDATE:'1',HOMEBREW_NO_ANALYTICS:'1',HOMEBREW_NO_INSTALL_CLEANUP:'1',
    HOMEBREW_NO_AUTOREMOVE:'1',HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK:'1',
    HOMEBREW_NO_ENV_HINTS:'1',HOMEBREW_NO_ASK:'1',HOMEBREW_NO_SUDO:'1'};
}
function environmentGuard(target:Base,home:string):void {
  // brew.env is loaded AFTER process env and can defeat cleanup/destination guards.
  for(const path of ['/etc/homebrew/brew.env',join(target.target,'etc/homebrew/brew.env'),join(home,'.homebrew/brew.env')]) {
    if(!lstatSync(path,{throwIfNoEntry:false}))continue;
    physical(path);
    if(lstatSync(path).size>64_000||readFileSync(path,'utf8').split('\n').some(line=>/^\s*(?:HOMEBREW_|SUDO_ASKPASS=|(?:all|no|ftp|https?)_proxy=)/.test(line)))unsupported();
  }
}
function managerFiles(target:Base):readonly string[] {
  physical(target.target);physical(join(target.target,'bin'));
  if(target.manager!==join(target.target,'bin/brew'))changed();
  const manager=realpathSync(target.manager),repository=dirname(dirname(manager));
  if(basename(manager)!=='brew'||![target.target,join(target.target,'Homebrew')].includes(repository))changed();
  physical(repository);accessSync(manager,constants.X_OK);
  return [target.manager,join(repository,'Library/Homebrew/brew.sh'),join(repository,'Library/Homebrew/brew.rb')];
}
/** Only declarative CLI artifacts are accepted; never evaluate installed Ruby casks. */
function cliArtifacts(artifacts:z.infer<typeof artifactsSchema>,target:Base):string {
  const matches:string[]=[];
  for(const artifact of artifacts) {
    const keys=Object.keys(artifact).filter(key=>key!=='target');
    if(keys.length!==1)unsupported();
    const key=keys[0];
    if(key==='zap')continue; // Neither lifecycle command invokes zap.
    if(!key||!['binary','manpage','bash_completion','zsh_completion','fish_completion','generate_completions_from_executable'].includes(key))unsupported();
    const args=z.tuple([z.string()]).rest(z.unknown()).parse(artifact[key]);
    const source=args[0];
    if(!safeRelative(source))unsupported();
    if(key==='generate_completions_from_executable')continue;
    if(args.length>2)unsupported();
    const override=args[1]===undefined?undefined:z.object({target:z.string()}).strict().parse(args[1]).target;
    const destination=override??basename(source);
    const directory=key==='binary'?'bin':key==='manpage'?'share/man':key==='bash_completion'?'etc/bash_completion.d':
      key==='zsh_completion'?'share/zsh/site-functions':'share/fish/vendor_completions.d';
    const base=join(target.target,directory),linked=destination.startsWith('/')?destination:join(base,destination);
    if(!linked.startsWith(base+'/')||normalize(linked)!==linked||key==='binary'&&dirname(linked)!==base)unsupported();
    if(artifact['target']!==undefined) {
      const resolved=z.string().parse(artifact['target']).replace('$HOMEBREW_PREFIX',target.target);
      if(!resolved.startsWith(base+'/')||normalize(resolved)!==resolved||key==='binary'&&resolved!==linked)unsupported();
    }
    if(key==='binary'&&linked===target.executable)matches.push(source);
  }
  if(matches.length!==1)unsupported();
  const match=matches[0];if(!match)unsupported();return match;
}
function receiptState(target:Base):{readonly version:string;readonly tap:string;readonly paths:readonly string[]} {
  const name=token.parse(basename(target.packageName)),container=join(target.target,target.packageKind==='formula'?'Cellar':'Caskroom');
  physical(container);physical(join(container,name));physical(target.payloadRoot);
  if(dirname(target.payloadRoot)!==join(container,name)||!versionSchema.safeParse(basename(target.payloadRoot)).success)changed();
  const canonical=realpathSync(target.executable);
  if(!canonical.startsWith(target.payloadRoot+'/')||canonical.split('/').some(part=>part.endsWith('.app')))changed();
  accessSync(canonical,constants.X_OK);if(!lstatSync(canonical).isFile())changed();
  const version=basename(target.payloadRoot);
  switch(target.packageKind) {
    case 'formula': {
      physical(join(target.target,'opt'));
      const opt=join(target.target,'opt',name);
      if(!lstatSync(opt).isSymbolicLink()||realpathSync(opt)!==target.payloadRoot)changed();
      if(![join(target.target,'bin',basename(target.executable)),join(opt,'bin',basename(target.executable))].includes(target.executable))changed();
      if(target.executable.startsWith(join(target.target,'bin')+'/')&&!lstatSync(target.executable).isSymbolicLink())changed();
      const bin=join(target.payloadRoot,'bin',basename(target.executable));if(realpathSync(bin)!==canonical)changed();
      const receiptPath=join(target.payloadRoot,'INSTALL_RECEIPT.json'),definition=join(target.payloadRoot,'.brew',`${name}.rb`);
      physical(definition);
      const receipt=receiptSchema.parse(json(receiptPath)),source=receipt.source;
      if(source.spec!=='stable'||!source.versions||basename(source.path)!==`${name}.rb`||
        packageName(source.tap,name,'formula')!==target.packageName||
        !new RegExp(`^${source.versions.stable.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:_[1-9][0-9]*)?$`).test(version))changed();
      return {version,tap:source.tap,paths:[receiptPath,definition]};
    }
    case 'cask': {
      if(target.executable!==join(target.target,'bin',basename(target.executable))||!lstatSync(target.executable).isSymbolicLink())changed();
      const metadata=join(container,name,'.metadata'),receiptPath=join(metadata,'INSTALL_RECEIPT.json');
      physical(metadata);
      const receipt=receiptSchema.parse(json(receiptPath));
      if(receipt.source.version!==version||packageName(receipt.source.tap,name,'cask')!==target.packageName||
        ![`${name}.rb`,`${name}.json`].includes(basename(receipt.source.path))||receipt.uninstall_flight_blocks===true)changed();
      // Match Homebrew's latest timestamp across versions, not a stale receipt nearby.
      const installed=readdirSync(metadata).filter(v=>versionSchema.safeParse(v).success).flatMap(v=>{
        const directory=join(metadata,v);physical(directory);
        return readdirSync(directory).filter(stamp=>/^\d{14}\.\d{3}$/.test(stamp)).map(stamp=>({v,stamp}));
      }).sort((a,b)=>a.stamp.localeCompare(b.stamp)).at(-1);
      if(!installed||installed.v!==version)changed();
      const definition=join(metadata,version,installed.stamp,'Casks',`${name}.json`);
      const data=z.object({token:z.string().optional(),tap:z.string().optional(),version:z.string().optional(),
        artifacts:artifactsSchema.optional(),url_specs:z.object({only_path:z.string().optional()}).optional()}).parse(json(definition));
      if(data.token!==undefined&&data.token!==name||data.tap!==undefined&&data.tap!==receipt.source.tap||
        data.version!==undefined&&data.version!==version)changed();
      const artifacts=data.artifacts??receipt.uninstall_artifacts;if(!artifacts)unsupported();
      if(receipt.uninstall_artifacts)cliArtifacts(receipt.uninstall_artifacts,target);
      const binary=cliArtifacts(artifacts,target),onlyPath=data.url_specs?.only_path;
      if(onlyPath!==undefined&&!safeRelative(onlyPath))unsupported();
      if(realpathSync(join(target.payloadRoot,onlyPath??'',binary))!==canonical)changed();
      return {version,tap:receipt.source.tap,paths:[receiptPath,definition]};
    }
  }
}
function snapshot(paths:readonly string[]):string {
  const hash=createHash('sha256');let bytes=0;
  for(const path of [...new Set(paths)].sort()) {
    const info=lstatSync(path);
    hash.update(JSON.stringify([path,info.dev,info.ino,info.mode]));
    if(info.isDirectory())continue;
    hash.update(JSON.stringify([info.size,info.mtimeMs,info.ctimeMs]));
    if(info.isSymbolicLink())hash.update(readlinkSync(path));
    const resolved=realpathSync(path),file=lstatSync(resolved);
    hash.update(resolved);hash.update(JSON.stringify([file.dev,file.ino,file.mode,file.size,file.mtimeMs,file.ctimeMs]));
    if(file.isFile()){bytes+=file.size;if(bytes>512_000_000)changed();hash.update(readFileSync(resolved));}
    else if(!file.isDirectory())changed();
  }
  return hash.digest('hex');
}
function fingerprint(target:Base):string {
  const state=receiptState(target);
  if(JSON.stringify(state.paths)!==JSON.stringify(target.receiptPaths))changed();
  const paths=[...managerFiles(target),target.target,dirname(target.payloadRoot),target.payloadRoot,
    join(target.target,'bin'),target.executable,realpathSync(target.executable),...state.paths];
  if(target.packageKind==='formula')paths.push(join(target.target,'opt',basename(target.packageName)));
  // Pin every ancestor too: replacing a real receipt directory with a link is a change.
  for(const path of [...paths])for(let parent=dirname(path);parent.startsWith(target.target+'/');parent=dirname(parent))paths.push(parent);
  return createHash('sha256').update(JSON.stringify(target)).update(snapshot(paths)).digest('hex');
}
export function validateBrewTarget(target:BrewTarget):void {
  try {
    if(!brewTargetSchema.safeParse(target).success)changed();
    const {fingerprint:expected,...base}=target;
    if(fingerprint(base)!==expected)changed();
  }catch(error){if(error instanceof Error)changed();throw error;}
}
async function probe(target:BrewTarget,options:Options):Promise<void> {
  if(!target.preserve.includes(options.home)||findExecutable('brew',join(target.target,'bin'))!==realpathSync(target.manager))changed();
  const repository=dirname(dirname(realpathSync(target.manager)));
  for(const [flag,expected] of [['--prefix',target.target],['--repository',repository],
    [target.packageKind==='formula'?'--cellar':'--caskroom',join(target.target,target.packageKind==='formula'?'Cellar':'Caskroom')]]) {
    if(!flag||!expected)changed();
    validateBrewTarget(target);environmentGuard(target,options.home);
    if(await runProcess(target.manager,[flag],env(options),options.home,15_000)!==expected)changed();
  }
  validateBrewTarget(target);
}
export async function discoverBrewTarget(options:Options&{readonly catalogId:CatalogId;readonly executable:string}):Promise<BrewTarget|null> {
  try {
    const definition=catalogDefinitions.find(row=>row.id===options.catalogId);if(!definition)return null;
    const canonical=realpathSync(options.executable);
    const match=/^(.*)\/(Cellar|Caskroom)\/([^/]+)\/([^/]+)\//.exec(canonical);
    if(!match)return null;
    const [,prefix,room,name,version]=match;if(!prefix||!name||!version)return null;
    const packageKind=room==='Cellar'?'formula':'cask';
    const payloadRoot=join(prefix,room??'',name,version),manager=join(prefix,'bin/brew');
    if(findExecutable('brew',join(prefix,'bin'))!==realpathSync(manager))return null;
    const linked=join(prefix,'bin',definition.executable),opt=join(prefix,'opt',name,'bin',definition.executable);
    const executable=options.executable===opt?opt:linked;
    if(realpathSync(executable)!==canonical)return null;
    const receiptPath=packageKind==='formula'?join(payloadRoot,'INSTALL_RECEIPT.json'):join(prefix,'Caskroom',name,'.metadata/INSTALL_RECEIPT.json');
    const receipt=receiptSchema.parse(json(receiptPath));
    const draft:Base={kind:'brew',target:prefix,executable,manager,packageName:packageName(receipt.source.tap,token.parse(name),packageKind),
      packageKind,payloadRoot,preserve:[options.home],receiptPaths:[receiptPath]};
    const state=receiptState(draft),base={...draft,receiptPaths:state.paths};
    const target={...base,fingerprint:fingerprint(base)};
    await probe(target,options);await installedInfo(target,options);validateBrewTarget(target);return target;
  }catch(error) {
    if(error instanceof AppError||error instanceof z.ZodError||error instanceof SyntaxError)return null;
    if(error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(String(error.code)))return null;
    throw error;
  }
}
async function latestDocument(url:string):Promise<unknown> {
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Accept:'application/json'}});
  if(!response.ok||!response.body)throw new AppError('unavailable','brew_latest_unavailable');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>1_000_000){await reader.cancel();throw new AppError('unavailable','brew_latest_too_large');}chunks.push(value);}
  }finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function latestBrewVersion(target:BrewTarget):Promise<string> {
  validateBrewTarget(target);
  const state=receiptState(target),name=basename(target.packageName);
  if(state.tap!==`homebrew/${target.packageKind==='formula'?'core':'cask'}`)throw new AppError('unsupported','brew_latest_source_unverified');
  const document=await latestDocument(`https://formulae.brew.sh/api/${target.packageKind}/${encodeURIComponent(name)}.json`);
  validateBrewTarget(target);
  switch(target.packageKind) {
    case 'formula': {
      const data=z.object({name:z.literal(name),full_name:z.literal(name),tap:z.literal(state.tap),
        versions:z.object({stable:versionSchema}),revision:z.number().int().nonnegative(),version_scheme:z.number().int().nonnegative(),
        variations:variationsSchema}).parse(document);
      if(Object.values(data.variations??{}).some(row=>row.versions&&row.versions.stable!==data.versions.stable||
        row.revision!==undefined&&row.revision!==data.revision||row.version_scheme!==undefined&&row.version_scheme!==data.version_scheme))
        throw new AppError('unsupported','brew_latest_platform_unverified');
      const installed=receiptSchema.parse(json(target.receiptPaths[0]??'')).source.versions;
      if(data.version_scheme!==(installed?.version_scheme??0))throw new AppError('unsupported','brew_version_scheme_changed');
      return data.versions.stable+(data.revision?`_${data.revision}`:'');
    }
    case 'cask': {
      const data=z.object({token:z.literal(name),full_token:z.literal(name),tap:z.literal(state.tap),version:versionSchema,
        artifacts:artifactsSchema,variations:variationsSchema}).parse(document);
      if(Object.values(data.variations??{}).some(row=>row.version!==undefined&&row.version!==data.version))
        throw new AppError('unsupported','brew_latest_platform_unverified');
      cliArtifacts(data.artifacts,target);return data.version;
    }
  }
}
/** A third-party tap that has since been untapped (the formula moved taps or the tap was
 * renamed): brew no longer resolves the tap-qualified name, but still addresses the installed
 * keg by its bare name. Official taps and casks keep the strict qualified query. */
function formulaReference(target:BrewTarget,tap:string):{readonly name:string;readonly tapped:boolean} {
  if(target.packageKind!=='formula'||tap.startsWith('homebrew/'))return {name:target.packageName,tapped:true};
  const [user,repository]=tap.split('/');
  const tapped=existsSync(join(target.target,'Library/Taps',user??'',`homebrew-${repository??''}`));
  return {name:tapped?target.packageName:basename(target.packageName),tapped};
}
async function installedInfo(target:BrewTarget,options:Options):Promise<void> {
  validateBrewTarget(target);environmentGuard(target,options.home);
  const reference=formulaReference(target,receiptState(target).tap);
  const output=await runProcess(target.manager,['info','--json=v2',`--${target.packageKind}`,reference.name],env(options),options.home,30_000);
  validateBrewTarget(target);
  const state=receiptState(target),name=basename(target.packageName);
  switch(target.packageKind) {
    case 'formula': {
      // An untapped third-party formula reports whatever tap brew resolves the keg to now; the
      // keg name, installed version and Cellar fingerprint still bind the target.
      const data=z.object({formulae:z.array(z.object({name:z.literal(name),full_name:reference.tapped?z.literal(target.packageName):z.string(),tap:reference.tapped?z.literal(state.tap):z.string(),
        installed:z.array(z.object({version:versionSchema}))})).length(1)}).parse(JSON.parse(output));
      if(!data.formulae[0]?.installed.some(row=>row.version===state.version))changed();break;
    }
    case 'cask': {
      const data=z.object({casks:z.array(z.object({token:z.literal(name),full_token:z.literal(target.packageName),tap:z.literal(state.tap),
        installed:z.literal(state.version),artifacts:artifactsSchema})).length(1)}).parse(JSON.parse(output));
      const cask=data.casks[0];if(!cask)changed();cliArtifacts(cask.artifacts,target);break;
    }
  }
}
/** The parent owns approval/process guards; recheck the pinned proof immediately before spawn. */
export async function executeBrewRemoval(target:BrewTarget,options:Options):Promise<void> {
  validateBrewTarget(target);await probe(target,options);await installedInfo(target,options);
  await probe(target,options);
  environmentGuard(target,options.home);validateBrewTarget(target);
  await runProcess(target.manager,['uninstall',`--${target.packageKind}`,formulaReference(target,receiptState(target).tap).name],env(options),options.home,60_000);
}
export function brewVersionEvidence(target:BrewTarget):{readonly packageVersion:string;readonly releaseVersion:string} {
  validateBrewTarget(target);
  const packageVersion=receiptState(target).version;
  const releaseVersion=target.packageKind==='formula'
    ?receiptSchema.parse(json(target.receiptPaths[0]??'')).source.versions?.stable:packageVersion.split(',')[0];
  if(!releaseVersion)changed();
  return {packageVersion,releaseVersion};
}
export async function executeBrewUpdate(target:BrewTarget,options:Options,onProgress:(event:string)=>void=()=>{}):Promise<string> {
  validateBrewTarget(target);await probe(target,options);await installedInfo(target,options);
  const latest=await latestBrewVersion(target),managerProof=snapshot(managerFiles(target)),prefixProof=snapshot([target.target]);
  await probe(target,options);
  onProgress('installer_started');environmentGuard(target,options.home);validateBrewTarget(target);
  options.beforeMutation?.();
  await runProcess(target.manager,['upgrade',`--${target.packageKind}`,target.packageName],env(options),options.home,900_000,()=>onProgress('installer_output_received'));
  onProgress('verification_started');
  if(snapshot(managerFiles(target))!==managerProof||snapshot([target.target])!==prefixProof)changed();
  const catalog=catalogDefinitions.find(row=>row.executable===basename(target.executable));if(!catalog)changed();
  const fresh=await discoverBrewTarget({...options,catalogId:catalog.id,executable:target.executable});
  if(!fresh||fresh.target!==target.target||fresh.executable!==target.executable||fresh.manager!==target.manager||
    fresh.packageName!==target.packageName||fresh.packageKind!==target.packageKind)changed();
  await installedInfo(fresh,options);validateBrewTarget(fresh);
  const version=receiptState(fresh).version;
  if(version!==latest)throw new AppError('unavailable','brew_updated_version_unverified');
  // CLI output proves the linked artifact runs; package metadata retains revision/build.
  const work=realpathSync(mkdtempSync(join(tmpdir(),'brew-verify-')));
  try {
    const output=await runProcess(fresh.executable,['--version'],{...env({...options,home:work}),
      XDG_CONFIG_HOME:join(work,'.config'),XDG_CACHE_HOME:join(work,'.cache'),XDG_DATA_HOME:join(work,'.local/share'),
      MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0'},work,15_000);
    validateBrewTarget(fresh);
    if(parseCliVersion(output)!==brewVersionEvidence(fresh).releaseVersion)throw new AppError('unavailable','brew_updated_version_unverified');
  }finally{rmSync(work,{recursive:true,force:true});}
  onProgress('update_verified');return version;
}
