import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { CatalogId } from './catalog-types';
import { catalogForPlatform, catalogPackage } from './catalog-registry';
import { discoverRemoval, validateRemoval } from './catalog-removal-target';
import type { RemovalTarget } from './catalog-removal-target';
import { executeRecipe, findExecutable, runProcess, parseCliVersion } from './catalog-runner';
import { AppError } from './types';
import { bunOmoEntry } from './omo-installation';
import { discoverBrewTarget, executeBrewUpdate } from './catalog-brew';
import { removalTargetSchema } from './catalog-removal-target';
import { officialUpdateTargetSchema, discoverOfficialUpdate, executeOfficialUpdate } from './catalog-official-update';
export const updateTargetSchema=z.union([removalTargetSchema,officialUpdateTargetSchema]);
export type UpdateTarget=z.infer<typeof updateTargetSchema>;

type DiscoverOptions = Parameters<typeof discoverRemoval>[0];
type UpdateOptions = {
  readonly catalogId:CatalogId; readonly directory:string; readonly home:string; readonly path:string;
  readonly beforeMutation?:()=>void;
};
export class UpdateExecutionError extends AppError {
  constructor(readonly mutationStarted:boolean, error:Error) {
    super(error instanceof AppError?error.code:'unavailable',error instanceof AppError?error.detail:'update_failed');
  }
}
const packageSchema=z.object({name:z.string(),version:z.string(),bin:z.union([z.string(),z.record(z.string(),z.string())])});
function changed():never {throw new AppError('source_changed','update_target_changed');}
function recipeFor(id:CatalogId,target?:RemovalTarget) {
  // agy exits without updating an existing binary. The other three keep their
  // payload in hidden homes, outside the existing owned-payload proof contract.
  if(['agy','cursor','grok','hermes'].includes(id))return null;
  const definition=catalogForPlatform(process.platform).find(row=>row.id===id);
  if(!definition?.recipe)return null;
  if(target&&target.kind!=='owned'){
    const packageName=catalogPackage(id);
    return packageName?{kind:'npm' as const,package:packageName,bin:`bin/${definition.executable}`}:null;
  }
  return definition.recipe;
}
export function updateSupport(id:CatalogId):{readonly kind:'check-source'|'unsupported';readonly reason:string|null} {
  if(id==='agy')return {kind:'unsupported',reason:'self_update_only'};
  if(['cursor','grok','hermes'].includes(id))return {kind:'unsupported',reason:'update_source_unverified'};
  return recipeFor(id)?{kind:'check-source',reason:null}:{kind:'unsupported',reason:'install_platform_unsupported'};
}

export async function discoverUpdate(options:DiscoverOptions):Promise<UpdateTarget|null> {
  const brew=await discoverBrewTarget(options);
  if(brew)return brew;
  if(!recipeFor(options.catalogId))return null;
  return await discoverRemoval(options)??await discoverOfficialUpdate(options);
}

/** Reject writable-tree redirects before handing an existing prefix to an installer. */
function validateTree(root:string):void {
  let count=0;
  function visit(path:string):void {
    if(++count>100_000)changed();
    const info=lstatSync(path);
    if(info.isSymbolicLink()) {
      if(!realpathSync(path).startsWith(root+'/'))changed();
    }else if(info.isDirectory()) {
      // The runner owns this read-only DMG mount, which may link to /Applications.
      if(path===join(root,'.mount'))return;
      for(const name of readdirSync(path))visit(join(path,name));
    }else if(!info.isFile())changed();
  }
  visit(root);
}

/** Installation-only update: recheck provenance, without stopping or restarting consumers. */
export async function executeUpdate(target:UpdateTarget,options:UpdateOptions,
  onProgress:(event:string)=>void=()=>{}):Promise<string> {
  let mutationStarted=false;
  try {
    return await execute(target,{...options,beforeMutation:()=>{options.beforeMutation?.();mutationStarted=true;}},onProgress);
  } catch(error) {
    if(!(error instanceof Error))throw error;
    throw new UpdateExecutionError(mutationStarted,error);
  }
}
async function execute(target:UpdateTarget,options:UpdateOptions,onProgress:(event:string)=>void):Promise<string> {
  if(target.kind==='official'){
    if(target.catalogId!==options.catalogId)changed();
    return executeOfficialUpdate(target,options,onProgress);
  }
  if(target.kind==='brew'){
    if(catalogForPlatform(process.platform).find(row=>row.id===options.catalogId)?.executable!==basename(target.executable))changed();
    return executeBrewUpdate(target,options,onProgress);
  }
  const recipe=recipeFor(options.catalogId,target);
  if(!recipe)throw new AppError('unsupported','manual_update_required');
  validateRemoval(target);
  const definition=catalogForPlatform(process.platform).find(row=>row.id===options.catalogId);
  if(!definition)throw new AppError('unsupported','manual_update_required');
  if(target.kind==='owned') {
    if(dirname(target.target)!==join(options.directory,'cli-installs')||
      !basename(target.target).startsWith(options.catalogId+'-')||
      target.executable!==join(target.target,recipe.bin))changed();
  }else {
    if(recipe.kind!=='npm'||target.packageName!==recipe.package||!target.preserve.includes(options.home))changed();
    if(target.kind==='bun'&&target.target!==join(options.home,'.bun/install/global'))changed();
  }
  const executableIdentity=()=>options.catalogId==='omo'&&target.kind==='bun'
    ?bunOmoEntry(target.executable,options.home)??realpathSync(target.executable):realpathSync(target.executable);
  const canonical=executableIdentity(),rootInfo=lstatSync(target.target);
  const manager=target.kind==='owned'
    ?recipe.kind==='npm'?findExecutable('npm',options.path):null
    :target.manager;
  const managerInfo=manager?lstatSync(manager):null;
  const guard=()=>{
    validateRemoval(target);
    if(manager) {
      const current=lstatSync(manager);
      if(findExecutable(target.kind==='bun'?'bun':'npm',options.path)!==manager||
        !managerInfo||current.dev!==managerInfo.dev||current.ino!==managerInfo.ino||
        current.size!==managerInfo.size||current.mtimeMs!==managerInfo.mtimeMs||current.ctimeMs!==managerInfo.ctimeMs)changed();
    }
    if(target.kind==='owned')validateTree(target.target);
  };
  guard();
  const work=realpathSync(mkdtempSync(join(tmpdir(),'cli-update-')));
  const env:NodeJS.ProcessEnv={
    HOME:work,PATH:options.path,LANG:'C',CI:'1',NO_COLOR:'1',TMPDIR:work,
    XDG_CONFIG_HOME:join(work,'.config'),XDG_CACHE_HOME:join(work,'.cache'),
    XDG_DATA_HOME:join(work,'.local/share'),XDG_STATE_HOME:join(work,'.local/state'),
    npm_config_userconfig:join(work,'user.npmrc'),npm_config_globalconfig:join(work,'global.npmrc'),
    npm_config_cache:join(work,'.npm'),npm_config_update_notifier:'false',
    BUN_INSTALL:join(options.home,'.bun'),BUN_INSTALL_CACHE_DIR:join(work,'.bun-cache'),
  };
  try {
    switch(target.kind) {
      case 'owned': {
        // Kimi's no-profile flag skips legacy shim migration only when its own
        // bin directory is absent from PATH. Never offer other installations to it.
        const path=options.catalogId==='kimi'
          ?options.path.split(':').filter(part=>{
            try{return realpathSync(part)!==dirname(target.executable);}
            catch(error){if(error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR'].includes(String(error.code)))return false;throw error;}
          }).join(':'):options.path;
        // executeRecipe writes installer scratch files inside the owned target before spawning.
        guard();options.beforeMutation?.();
        await executeRecipe(recipe,{...options,path,target:target.target,beforeUpdate:guard},onProgress);
        break;
      }
      case 'npm': {
        const prefix=dirname(target.target);
        const root=await runProcess(target.manager,['root','--global','--prefix',prefix],env,work,15_000);
        if(root!==join(target.target,'node_modules'))changed();
        onProgress('installer_started');guard();options.beforeMutation?.();
        await runProcess(target.manager,['install','--global','--prefix',prefix,
          '--registry=https://registry.npmjs.org','--no-audit','--no-fund',`${target.packageName}@latest`],
        env,work,900_000,()=>onProgress('installer_output_received'));
        break;
      }
      case 'bun': {
        const bin=await runProcess(target.manager,['pm','bin','--global'],env,work,15_000);
        if(bin!==dirname(target.executable))changed();
        onProgress('installer_started');guard();options.beforeMutation?.();
        await runProcess(target.manager,['add','--global','--global-dir',target.target,
          '--global-bin-dir',dirname(target.executable),'--registry','https://registry.npmjs.org',`${target.packageName}@latest`],
        env,work,900_000,()=>onProgress('installer_output_received'));
        break;
      }
    }
    onProgress('verification_started');
    const assertLocation=()=>{
      const current=lstatSync(target.target);
      if(current.isSymbolicLink()||realpathSync(target.target)!==target.target||
        current.dev!==rootInfo.dev||current.ino!==rootInfo.ino||
        executableIdentity()!==canonical||!lstatSync(canonical).isFile())changed();
    };
    assertLocation();
    const updated=target.kind==='owned'?null:await discoverRemoval({
      ...options,executable:target.executable,receipt:null,
    });
    if(target.kind!=='owned'&&(!updated||updated.kind!==target.kind||updated.target!==target.target||
      updated.executable!==target.executable||updated.manager!==target.manager))changed();
    let packageVersion:string|null=null;
    if(recipe.kind==='npm') {
      const packageRoot=join(target.target,target.kind==='owned'?'lib/node_modules':'node_modules',recipe.package);
      if(realpathSync(packageRoot)!==packageRoot)changed();
      const metadata=packageSchema.parse(JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8')));
      const bin=typeof metadata.bin==='string'?metadata.bin:metadata.bin[definition.executable];
      if(metadata.name!==recipe.package||!bin||bin.startsWith('/')||bin.split('/').includes('..')||
        !(lstatSync(target.executable).isSymbolicLink()||(target.kind==='bun'&&options.catalogId==='omo'&&bunOmoEntry(target.executable,options.home)===canonical))||realpathSync(join(packageRoot,bin))!==canonical)changed();
      packageVersion=metadata.version;
    }
    const versionInfo=lstatSync(canonical);
    const output=await runProcess(canonical,['--version'],
      {...env,MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0'},work,15_000);
    assertLocation();
    const verifiedInfo=lstatSync(canonical);
    if(verifiedInfo.dev!==versionInfo.dev||verifiedInfo.ino!==versionInfo.ino||
      verifiedInfo.size!==versionInfo.size||verifiedInfo.mtimeMs!==versionInfo.mtimeMs||
      verifiedInfo.ctimeMs!==versionInfo.ctimeMs)changed();
    if(updated)validateRemoval(updated);
    const version=parseCliVersion(output);
    if(!version||packageVersion!==null&&version!==packageVersion)
      throw new AppError('unavailable','updated_version_unverified');
    onProgress('update_verified');
    return version;
  } finally {rmSync(work,{recursive:true,force:true});}
}
