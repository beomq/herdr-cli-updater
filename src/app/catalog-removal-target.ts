import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { z } from 'zod';
import { catalogDefinitions, catalogPackage } from './catalog-registry';
import { findExecutable, runProcess } from './catalog-runner';
import type { CatalogId, InstallJob } from './catalog-types';
import { AppError } from './types';
import { bunOmoEntry } from './omo-installation';
import { brewTargetSchema, discoverBrewTarget, validateBrewTarget, executeBrewRemoval } from './catalog-brew';
import type { BrewTarget } from './catalog-brew';
import { removalFingerprint } from './removal-fingerprint';

export type RemovalTarget =
  | BrewTarget
  | { readonly kind:'owned'; readonly target:string; readonly executable:string; readonly fingerprint:string; readonly preserve:readonly string[] }
  | { readonly kind:'npm'|'bun'; readonly target:string; readonly executable:string; readonly manager:string; readonly packageName:string; readonly fingerprint:string; readonly preserve:readonly string[] };
const pathSchema=z.string().startsWith('/').max(4096).regex(/^[^\x00-\x1f\x7f]*$/).refine(p=>normalize(p)===p);
const common={target:pathSchema,executable:pathSchema,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),preserve:z.array(pathSchema).max(256).readonly()};
export const removalTargetSchema=z.discriminatedUnion('kind',[
  brewTargetSchema,
  z.object({kind:z.literal('owned'),...common}).strict(),
  z.object({kind:z.literal('npm'),...common,manager:pathSchema,packageName:z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/)}).strict(),
  z.object({kind:z.literal('bun'),...common,manager:pathSchema,packageName:z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/)}).strict(),
]) satisfies z.ZodType<RemovalTarget>;
const manifestSchema=z.object({name:z.string().optional(),version:z.string().optional(),bin:z.union([z.string(),z.record(z.string(),z.string())]).optional(),dependencies:z.record(z.string(),z.string()).optional()});
function fail():never {throw new AppError('source_changed','removal_target_changed');}
function physical(path:string):void {if(realpathSync(path)!==path||lstatSync(path).isSymbolicLink())fail();}
function manifest(path:string){return manifestSchema.parse(JSON.parse(readFileSync(join(path,'package.json'),'utf8')));}
function ownedPayload(target:Pick<RemovalTarget,'target'|'executable'>):string {
  const definition=catalogDefinitions.find(row=>row.recipe&&target.executable===join(target.target,row.recipe.bin)&&basename(target.target).startsWith(row.id+'-'));
  if(!definition?.recipe)fail();
  if(definition.recipe.kind==='npm') {
    const root=join(target.target,'lib/node_modules',definition.recipe.package);
    if(!owns(root,target.executable,definition.recipe.package,definition.executable))fail();return root;
  }
  const payload=realpathSync(target.executable);
  if(!payload.startsWith(target.target+'/')||payload.slice(target.target.length+1).split('/').some(part=>part.startsWith('.')))fail();return payload;
}
type FingerprintTarget = Omit<Extract<RemovalTarget,{kind:'owned'}>,'fingerprint'> | Omit<Extract<RemovalTarget,{kind:'npm'|'bun'}>,'fingerprint'>;
function fingerprint(target:FingerprintTarget):string {
  const paths:string[]=[];
  if(target.kind==='owned') {physical(target.target);if(lstatSync(join(target.target,'.removed-payload'),{throwIfNoEntry:false}))fail();paths.push(target.executable);const payload=ownedPayload(target);if(payload!==target.executable)paths.push(payload);}
  else {
    physical(target.target);physical(join(target.target,'node_modules',target.packageName));
    paths.push(join(target.target,'node_modules',target.packageName),target.executable);
    paths.push(target.kind==='npm'?dirname(dirname(target.manager)):target.manager);
    if(target.kind==='bun')paths.push(join(target.target,'package.json'),join(target.target,'bun.lock'));
  }
  return removalFingerprint(paths,JSON.stringify(target));
}
function env(home:string,path:string):NodeJS.ProcessEnv {
  return {HOME:home,PATH:path,LANG:'C',CI:'1',NO_COLOR:'1',BUN_INSTALL:join(home,'.bun'),npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'};
}
function owns(packageRoot:string,executable:string,name:string,binName:string):boolean {
  physical(packageRoot);const parsed=manifest(packageRoot);if(parsed.name!==name)return false;
  const bin=typeof parsed.bin==='string'?parsed.bin:parsed.bin?.[binName];
  if(!bin||bin.startsWith('/')||bin.split('/').includes('..'))return false;
  const payload=join(packageRoot,bin);if(!realpathSync(payload).startsWith(packageRoot+'/'))return false;
  if(lstatSync(executable).isSymbolicLink())return realpathSync(executable)===realpathSync(payload);
  const suffix='/.bun/install/global/node_modules/omo-ai';
  return name==='omo-ai'&&packageRoot.endsWith(suffix)
    &&bunOmoEntry(executable,packageRoot.slice(0,-suffix.length))===realpathSync(payload);
}
export async function discoverRemoval(options:{readonly catalogId:CatalogId;readonly executable:string;readonly receipt:InstallJob|null;readonly directory:string;readonly home:string;readonly path:string;readonly refusal?:(reason:string)=>void}):Promise<RemovalTarget|null> {
  const refuse=(reason:string):null=>{options.refusal?.(reason);return null;};
  try {
    const definition=catalogDefinitions.find(row=>row.id===options.catalogId);if(!definition?.recipe)return null;
    const receipt=options.receipt?.official?null:options.receipt;
    if(receipt) {
      if(receipt.stage!=='completed'||receipt.catalogId!==options.catalogId||!z.string().uuid().safeParse(receipt.id).success)return refuse('removal_receipt_mismatch');
      const root=join(options.directory,'cli-installs');physical(root);
      const target=join(root,`${receipt.catalogId}-${receipt.id}`);physical(target);
      if(receipt.target!==target||receipt.recipeHash!==createHash('sha256').update(JSON.stringify(definition.recipe)).digest('hex'))return refuse('removal_receipt_mismatch');
      const executable=join(target,definition.recipe.bin);
      physical(dirname(executable));
      if(receipt.executablePath!==executable||realpathSync(options.executable)!==realpathSync(executable)||!realpathSync(executable).startsWith(target+'/'))return refuse('removal_receipt_mismatch');
      const base={kind:'owned' as const,target,executable,preserve:[target,join(target,'.removed-payload')]};
      return {...base,fingerprint:fingerprint(base)};
    }
    const brew=await discoverBrewTarget(options);
    if(brew)return brew;
    const packageName=catalogPackage(options.catalogId);
    if(!packageName)return null;
    let packageRoot=dirname(options.catalogId==='omo'?(bunOmoEntry(options.executable,options.home)??realpathSync(options.executable)):realpathSync(options.executable));
    while(packageRoot!==dirname(packageRoot)) {
      if(lstatSync(join(packageRoot,'package.json'),{throwIfNoEntry:false})&&manifest(packageRoot).name===packageName)break;
      packageRoot=dirname(packageRoot);
    }
    const suffix=join('node_modules',packageName);
    if(!packageRoot.endsWith('/'+suffix))return null;
    const container=packageRoot.slice(0,-suffix.length-1);physical(container);
    if(container===join(options.home,'.bun/install/global')) {
      const dependency=manifest(container).dependencies?.[packageName];
      if(!dependency)return refuse('removal_dependency_installation');
      if(!/^[~^]?\d/.test(dependency))return refuse('removal_package_source_unverified');
      const executable=join(options.home,'.bun/bin',definition.executable);
      const identity=(path:string)=>options.catalogId==='omo'?(bunOmoEntry(path,options.home)??realpathSync(path)):realpathSync(path);
      if(!owns(packageRoot,executable,packageName,definition.executable)||identity(options.executable)!==identity(executable))return null;
      const lock=z.object({workspaces:z.record(z.string(),z.object({dependencies:z.record(z.string(),z.string()).optional()})),packages:z.record(z.string(),z.array(z.unknown()))}).parse(Bun.JSON5.parse(readFileSync(join(container,'bun.lock'),'utf8')));
      if(lock.workspaces['']?.dependencies?.[packageName]!==dependency||lock.packages[packageName]?.[0]!==`${packageName}@${manifest(packageRoot).version}`)return refuse('removal_lock_mismatch');
      const manager=findExecutable('bun',options.path);if(!manager)return refuse('removal_manager_missing');physical(manager);
      const bin=await runProcess(manager,['pm','bin','--global'],env(options.home,options.path),options.home,15_000);
      if(bin!==join(options.home,'.bun/bin'))return null;
      const base={kind:'bun' as const,target:container,executable,manager,packageName,preserve:[options.home]};return {...base,fingerprint:fingerprint(base)};
    }
    if(basename(container)!=='lib')return null;
    const prefix=dirname(container);physical(prefix);
    if(prefix.split('/').some(part=>part.endsWith('.app'))||lstatSync(join(prefix,'package.json'),{throwIfNoEntry:false}))return null;
    const executable=join(prefix,'bin',definition.executable);physical(dirname(executable));
    if(!owns(packageRoot,executable,packageName,definition.executable)||realpathSync(options.executable)!==realpathSync(executable))return null;
    const manager=findExecutable('npm',options.path);if(!manager)return refuse('removal_manager_missing');
    if(basename(manager)!=='npm-cli.js'||manifest(dirname(dirname(manager))).name!=='npm')return null;
    const output=await runProcess(manager,['root','--global','--prefix',prefix],env(options.home,options.path),options.home,15_000);
    if(output!==join(container,'node_modules'))return null;
    const base={kind:'npm' as const,target:container,executable,manager,packageName,preserve:[options.home]};return {...base,fingerprint:fingerprint(base)};
  } catch(error) {
    if(error instanceof AppError)return refuse(error.detail);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return refuse('removal_metadata_invalid');
    if(error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(String(error.code)))return refuse(error.code==='EACCES'?'removal_permission_denied':'removal_source_unverified');
    throw error;
  }
}
export function validateRemoval(target:RemovalTarget):void {
  if(target.kind==='brew'){validateBrewTarget(target);return;}
  if(!removalTargetSchema.safeParse(target).success)fail();
  const {fingerprint:expected,...base}=target;
  try {
    if(target.kind==='owned') {
      const definition=catalogDefinitions.find(row=>row.recipe&&target.executable===join(target.target,row.recipe.bin)&&new RegExp(`^${row.id}-[a-f0-9-]{36}$`).test(basename(target.target)));
      if(!definition||basename(dirname(target.target))!=='cli-installs')fail();
      physical(dirname(target.target));physical(dirname(target.executable));
      if(!realpathSync(target.executable).startsWith(target.target+'/'))fail();
    }else {
      const definition=catalogDefinitions.find(row=>catalogPackage(row.id)===target.packageName);
      if(!definition||!owns(join(target.target,'node_modules',target.packageName),target.executable,target.packageName,definition.executable))fail();
      physical(dirname(target.executable));
      if(target.kind==='npm') {
        if(basename(target.target)!=='lib'||target.executable!==join(dirname(target.target),'bin',definition.executable)||basename(target.manager)!=='npm-cli.js'||manifest(dirname(dirname(target.manager))).name!=='npm')fail();
      }else if(!target.target.endsWith('/.bun/install/global')||target.executable!==join(dirname(dirname(target.target)),'bin',definition.executable))fail();
    }
    if(fingerprint(base)!==expected)fail();
  }catch(error){if(error instanceof Error)fail();throw error;}
}
export async function executeRemoval(target:RemovalTarget,options:{readonly home:string;readonly path:string}):Promise<void> {
  if(target.kind==='brew'){await executeBrewRemoval(target,options);return;}
  validateRemoval(target);
  if(target.kind==='owned'){
    // Archive the installation payload because it may contain user-created files.
    // Homes, caches, and every unrelated root entry remain untouched.
    const payload=ownedPayload(target);renameSync(payload,join(target.target,'.removed-payload'));
    if(payload!==target.executable)unlinkSync(target.executable);return;
  }
  if(findExecutable(target.kind,options.path)!==target.manager)fail();
  if(target.kind==='npm') {
    const prefix=dirname(target.target);
    const root=await runProcess(target.manager,['root','--global','--prefix',prefix],env(options.home,options.path),options.home,15_000);
    if(root!==join(target.target,'node_modules'))fail();validateRemoval(target);
    await runProcess(target.manager,['uninstall','--global','--prefix',prefix,'--ignore-scripts','--no-audit','--no-fund',target.packageName],env(options.home,options.path),options.home,60_000);
  } else {
    if(target.target!==join(options.home,'.bun/install/global'))fail();
    const bin=await runProcess(target.manager,['pm','bin','--global'],env(options.home,options.path),options.home,15_000);
    if(bin!==join(options.home,'.bun/bin'))fail();validateRemoval(target);
    await runProcess(target.manager,['remove','--global','--ignore-scripts',target.packageName],env(options.home,options.path),target.target,60_000);
  }
}
