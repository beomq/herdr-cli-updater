import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { catalogDefinitions, catalogPackage } from './catalog-registry';
import { findExecutable, runProcess } from './catalog-runner';
import { bunOmoEntry } from './omo-installation';
import { AppError } from './types';
import type { CatalogId, CatalogInstallation, InstallJob } from './catalog-types';

type Options = {readonly home:string;readonly path:string;readonly directory:string;readonly receipts:readonly InstallJob[];readonly prefixes?:readonly string[]};
const packageSchema=z.object({name:z.string(),version:z.string().optional(),bin:z.union([z.string(),z.record(z.string(),z.string())]).optional()});
const brewSchema=z.object({
  formulae:z.array(z.object({name:z.string(),full_name:z.string(),installed:z.array(z.object({version:z.string(),revision:z.number().int().nonnegative().optional()}))})).default([]),
  casks:z.array(z.object({token:z.string(),installed:z.union([z.string(),z.array(z.string()),z.null()]).optional(),artifacts:z.array(z.unknown()).optional()})).default([]),
});
const packageAliases:Readonly<Record<string,CatalogId>>={'@xai-official/grok':'grok','@oh-my-pi/pi-coding-agent':'omp'};
const commandAliases:Readonly<Record<string,CatalogId>>={'cursor-agent':'cursor',antigravity:'agy',senpi:'pi'};
const caskBinarySchema=z.object({binary:z.tuple([z.string()]).rest(z.unknown())});
function absent(error:unknown):boolean {
  return error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(String(error.code));
}
function physical(path:string):string|null {
  try{return realpathSync(path);}catch(error){if(absent(error))return null;throw error;}
}
function executable(path:string):string|null {
  try {accessSync(path,constants.X_OK);return lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()?physical(path):null;}
  catch(error){if(absent(error))return null;throw error;}
}
function directories(path:string):readonly string[] {
  try{return readdirSync(path,{withFileTypes:true}).filter(row=>row.isDirectory()||row.isSymbolicLink()).map(row=>join(path,row.name)).sort();}
  catch(error){if(absent(error))return [];throw error;}
}
function manifest(path:string):z.infer<typeof packageSchema>|null {
  try {const parsed=packageSchema.safeParse(JSON.parse(readFileSync(join(path,'package.json'),'utf8')));return parsed.success?parsed.data:null;}
  catch(error){if(absent(error)||error instanceof SyntaxError)return null;throw error;}
}
function family(name:string):CatalogId|null {
  return catalogDefinitions.find(row=>catalogPackage(row.id)===name)?.id??packageAliases[name]??null;
}
function command(name:string):CatalogId|null {
  return commandAliases[name]??catalogDefinitions.find(row=>row.executable===name)?.id??null;
}
function brewFamily(name:string):CatalogId|null {
  if(name==='devin-cli')return 'devin';
  return family(name)??command(name)??catalogDefinitions.find(row=>{
    const packageName=catalogPackage(row.id);
    return packageName&& !['cli','coding-agent'].includes(basename(packageName))&&basename(packageName)===name;
  })?.id??null;
}
function nearestPackage(path:string):z.infer<typeof packageSchema>|null {
  for(let root=dirname(path);root!==dirname(root);root=dirname(root)) {
    const found=manifest(root);if(found)return found;
  }
  return null;
}
function identity(path:string,home:string):string|null {return bunOmoEntry(path,home)??executable(path);}

/** Versions and resolved release directories deliberately do not participate in IDs. */
export function installationId(catalogId:CatalogId,manager:CatalogInstallation['manager'],root:string,packageName:string|null,path:string):string {
  return createHash('sha256').update(JSON.stringify([catalogId,manager,root,packageName,manager==='brew'?null:path])).digest('hex');
}

/** Display-only observation. Manager labels never authorize an update or removal. */
export async function discoverCatalogInstallations(options:Options,dependencies:{readonly run?:typeof runProcess}={}):Promise<readonly CatalogInstallation[]> {
  const run=dependencies.run??runProcess;
  const env:NodeJS.ProcessEnv={HOME:options.home,PATH:options.path,LANG:'C',CI:'1',NO_COLOR:'1',
    HOMEBREW_NO_AUTO_UPDATE:'1',HOMEBREW_NO_ANALYTICS:'1',HOMEBREW_NO_INSTALL_CLEANUP:'1',
    npm_config_update_notifier:'false',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'};
  async function query(manager:string,args:readonly string[]):Promise<string|null> {
    try{return await run(manager,args,env,options.home,15_000,undefined,8_000_000);}
    catch(error){if(error instanceof AppError||absent(error))return null;throw error;}
  }
  // Accumulators retain manager-root identity; physical equality only collapses PATH aliases.
  const rows:CatalogInstallation[]=[];
  const pathRows:{readonly catalogId:CatalogId;readonly path:string;readonly identityPath:string}[]=[];
  const first=new Map<CatalogId,string>();
  const seenCommands=new Set<string>();
  const bins=options.path.split(delimiter).filter(isAbsolute);
  const names=[...new Set([...catalogDefinitions.map(row=>row.executable),...Object.keys(commandAliases)])];
  for(const bin of bins)for(const name of names) {
    const path=join(bin,name),resolved=identity(path,options.home);if(!resolved)continue;
    const firstCommand=!seenCommands.has(name);seenCommands.add(name);
    // Desktop apps can contain assistants, but those are not installed CLI packages.
    if(resolved.split('/').some(part=>part.endsWith('.app')))continue;
    const pkg=nearestPackage(resolved);
    let catalogId=pkg?family(pkg.name):null;
    if(pkg&&!catalogId)continue; // Includes Gemini and unrelated packages exporting `agent`.
    if(!catalogId&&basename(resolved)!=='agent')catalogId=command(basename(resolved));
    if(!catalogId&&name!=='agent')catalogId=command(name);
    if(!catalogId&&name==='agent'&&resolved.includes('/cursor-agent/'))catalogId='cursor';
    if(!catalogId)continue; // A bare generic agent has no safely attributable catalog family.
    if(firstCommand&&!first.has(catalogId))first.set(catalogId,resolved);
    pathRows.push({catalogId,path,identityPath:resolved});
  }
  function add(row:Omit<CatalogInstallation,'id'|'isDefault'>):void {
    const id=installationId(row.catalogId,row.manager,row.root,row.packageName,row.path);
    if(rows.some(existing=>existing.id===id))return;
    rows.push({...row,id,isDefault:false});
  }
  for(const receipt of options.receipts) {
    if(receipt.official){
      const expected=receipt.official.executable,resolved=identity(expected,options.home);
      if(resolved&&receipt.catalogId===receipt.official.catalogId&&!resolved.startsWith(options.directory+'/'))
        pathRows.push({catalogId:receipt.catalogId,path:expected,identityPath:resolved});
      continue;
    }
    if(receipt.stage!=='completed'||!receipt.executablePath)continue;
    const definition=catalogDefinitions.find(row=>row.id===receipt.catalogId);
    const target=join(options.directory,'cli-installs',`${receipt.catalogId}-${receipt.id}`);
    if(!definition?.recipe||receipt.target!==target||receipt.executablePath!==join(target,definition.recipe.bin)||
      receipt.recipeHash!==createHash('sha256').update(JSON.stringify(definition.recipe)).digest('hex'))continue;
    const resolved=identity(receipt.executablePath,options.home);
    if(!resolved||!resolved.startsWith((physical(target)??target)+'/'))continue;
    const packageName=catalogPackage(receipt.catalogId);
    const pkg=packageName?manifest(join(target,'lib/node_modules',packageName)):null;
    const bins=pkg?.bin;
    const bin=typeof bins==='string'?bins:bins?.[definition.executable];
    const currentVersion=pkg?.name===packageName&&bin&&!isAbsolute(bin)&&!bin.split('/').includes('..')&&
      physical(join(target,'lib/node_modules',packageName??'',bin))===resolved?pkg.version??null:null;
    add({catalogId:receipt.catalogId,manager:'owned',root:target,packageName,
      path:receipt.executablePath,identityPath:resolved,receiptId:receipt.id,version:currentVersion});
  }
  function packages(manager:'npm'|'bun',root:string,modules:string,bin:string):void {
    if(root.split('/').some(part=>part.endsWith('.app')))return;
    if(rows.some(row=>row.manager==='owned'&&physical(row.root)===physical(root)))return;
    const names=[...catalogDefinitions.map(row=>catalogPackage(row.id)).filter((name):name is string=>name!==null),...Object.keys(packageAliases)];
    for(const packageName of names) {
      const packageRoot=join(modules,packageName),pkg=manifest(packageRoot),catalogId=family(packageName);
      if(!pkg||pkg.name!==packageName||!catalogId)continue;
      const definition=catalogDefinitions.find(row=>row.id===catalogId);if(!definition)continue;
      const entries=(typeof pkg.bin==='string'?[[definition.executable,pkg.bin]]:Object.entries(pkg.bin??{}))
        .sort(([left],[right])=>left===definition.executable?-1:right===definition.executable?1:0);
      for(const [name,entry] of entries) {
        if(!name||name!==basename(name)||name==='.'||name==='..'||!entry||isAbsolute(entry)||entry.split('/').includes('..'))continue;
        const path=join(bin,name),resolved=identity(path,options.home),payload=physical(join(packageRoot,entry));
        if(!resolved||resolved!==payload)continue;
        const existing=rows.find(row=>row.manager===manager&&row.root===root&&row.packageName===packageName);
        if(existing)continue;
        add({catalogId,manager,root,packageName,path,identityPath:resolved,receiptId:null,version:pkg.version??null});
      }
    }
  }
  const bunRoot=join(options.home,'.bun/install/global');
  packages('bun',bunRoot,join(bunRoot,'node_modules'),join(options.home,'.bun/bin'));
  const prefixes=new Set((options.prefixes??[]).filter(isAbsolute).map(prefix=>resolve(prefix)));
  for(const bin of bins)if(basename(bin)==='bin')prefixes.add(dirname(bin));
  for(const prefix of directories(join(options.home,'.nvm/versions/node')))prefixes.add(prefix);
  const npm=findExecutable('npm',options.path);
  if(npm) {const prefix=await query(npm,['prefix','--global']);if(prefix&&isAbsolute(prefix)&&!prefix.includes('\n'))prefixes.add(resolve(prefix));}
  for(const prefix of new Set([...prefixes].map(prefix=>physical(prefix)??prefix)))packages('npm',prefix,join(prefix,'lib/node_modules'),join(prefix,'bin'));
  const brews=new Set<string>();
  for(const bin of [...bins,...[...prefixes].map(prefix=>join(prefix,'bin'))]) {
    const brew=executable(join(bin,'brew'));if(brew)brews.add(brew);
  }
  for(const brew of brews) {
    const prefix=await query(brew,['--prefix']);
    const output=await query(brew,['info','--json=v2','--installed']);
    if(prefix&&isAbsolute(prefix)&&!prefix.includes('\n')&&output) {
      let metadata:z.infer<typeof brewSchema>|null=null;
      try {const parsed=brewSchema.safeParse(JSON.parse(output));if(parsed.success)metadata=parsed.data;}
      catch(error){if(!(error instanceof SyntaxError))throw error;}
      if(metadata) {
        const installed=[...metadata.formulae.filter(row=>row.installed.length>0).map(row=>{
          const versions=row.installed.map(installed=>installed.version+(installed.revision&&!/_\d+$/.test(installed.version)?`_${installed.revision}`:''));
          return {name:row.name,packageName:row.full_name,versions,cask:false,binaries:[]};
        }),
          ...metadata.casks.filter(row=>typeof row.installed==='string'?row.installed.length>0:(row.installed?.length??0)>0).map(row=>({name:row.token,packageName:row.token,versions:typeof row.installed==='string'?[row.installed]:row.installed??[],cask:true,
            binaries:(row.artifacts??[]).flatMap(artifact=>{
              const parsed=caskBinarySchema.safeParse(artifact);if(!parsed.success)return [];
              const binary=parsed.data.binary[0];
              return !isAbsolute(binary)&&!binary.split('/').some(part=>part==='..'||part.endsWith('.app'))?[binary]:[];
            })}))];
        for(const item of installed) {
          const catalogId=brewFamily(item.name);if(!catalogId||item.name==='agent')continue;
          const definition=catalogDefinitions.find(row=>row.id===catalogId);if(!definition)continue;
          for(const name of [definition.executable,...Object.keys(commandAliases).filter(name=>commandAliases[name]===catalogId)]) {
            const container=join(prefix,item.cask?'Caskroom':'Cellar',item.name);
            const paths=[join(prefix,'bin',name),...(item.cask?[]:[join(prefix,'opt',item.name,'bin',name)]),...item.versions.flatMap(version=>[
              join(container,version,'bin',name),...item.binaries.filter(binary=>basename(binary)===name).map(binary=>join(container,version,binary)),
            ])];
            for(const path of paths) {
              const resolved=executable(path);if(!resolved||!resolved.startsWith(container+'/'))continue;
              if(resolved.split('/').some(part=>part.endsWith('.app')))continue;
              const version=resolved.slice(container.length+1).split('/')[0];
              if(!version||!item.versions.includes(version))continue;
              add({catalogId,manager:'brew',root:prefix,packageName:item.packageName,path,identityPath:resolved,receiptId:null,version});
            }
          }
        }
      }
    }
  }
  for(const candidate of pathRows) {
    if(rows.some(row=>row.catalogId===candidate.catalogId&&row.identityPath===candidate.identityPath))continue;
    add({...candidate,manager:'unknown',root:dirname(candidate.path),packageName:null,receiptId:null,version:null});
  }
  const defaults=new Set<string>();
  for(const [catalogId,resolved] of first) {
    const candidate=pathRows.find(row=>row.catalogId===catalogId&&row.identityPath===resolved);
    const matches=rows.filter(row=>row.catalogId===catalogId&&row.identityPath===resolved);
    const selected=matches.find(row=>row.path===candidate?.path)??matches[0];
    if(selected)defaults.add(selected.id);
  }
  return rows.map(row=>({...row,isDefault:defaults.has(row.id)}));
}
