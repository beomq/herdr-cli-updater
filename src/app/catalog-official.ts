import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { z } from 'zod';
import { catalogDefinitions, catalogPackage } from './catalog-registry';
import { findExecutable, parseCliVersion, runProcess } from './catalog-runner';
import type { InstallProgress } from './catalog-runner';
import { catalogIds } from './catalog-types';
import type { CatalogId } from './catalog-types';
import { AppError } from './types';

const absolute=z.string().startsWith('/').max(4096).regex(/^[^\x00-\x1f\x7f:]+$/).refine(p=>normalize(p)===p&&p!=='/');
export const officialMethodSchema=z.enum(['npm','bun','brew','official']);
export type OfficialMethod=z.infer<typeof officialMethodSchema>;
export const officialPlanSchema=z.object({
  catalogId:z.enum(catalogIds),method:officialMethodSchema,sourceUrl:z.url().startsWith('https://'),
  executable:absolute,target:absolute,manager:absolute,args:z.array(z.string()).readonly(),
  env:z.record(z.string(),z.string()),recipeHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type OfficialInstallPlan=Readonly<z.infer<typeof officialPlanSchema>>;
type Context={readonly home:string;readonly path:string;readonly directory:string};
type Dependencies={readonly run?:typeof runProcess;readonly download?:(url:string)=>Promise<string>};
type Options=Context&Dependencies&{readonly catalogId:CatalogId;readonly method?:OfficialMethod;readonly platform?:NodeJS.Platform;readonly arch?:string};
type Choice={readonly method:OfficialMethod;readonly label:string;readonly sourceUrl:string;readonly recommended:boolean};
type Script={readonly url:string;readonly root:string;readonly args:readonly string[];readonly env:Readonly<Record<string,string>>};
const scripts:Partial<Record<CatalogId,Script>>={
  cursor:{url:'https://cursor.com/install',root:'.local/bin',args:[],env:{}},
  gjc:{url:'https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh',root:'.local/bin',args:['--binary'],env:{GJC_NO_COMMUNITY_APP:'1',GJC_NONINTERACTIVE:'1'}},
  maki:{url:'https://maki.sh/install.sh',root:'.local/bin',args:[],env:{}},
  kimi:{url:'https://code.kimi.com/kimi-code/install.sh',root:'.kimi-code/bin',args:[],env:{KIMI_NO_MODIFY_PATH:'1'}},
  muse:{url:'https://dev.meta.ai/install.sh',root:'.local/bin',args:[],env:{MUSE_NO_MODIFY_PATH:'1',MUSE_LOGIN:'0'}},
  omp:{url:'https://omp.sh/install',root:'.local/bin',args:['--binary'],env:{}},
  opencode:{url:'https://opencode.ai/install',root:'.opencode/bin',args:['--no-modify-path'],env:{}},
};
function definition(id:CatalogId){const row=catalogDefinitions.find(row=>row.id===id);if(!row)throw new AppError('invalid_request');return row;}
/** Only proven unattended choices; callers retain entry.sourceUrl as the manual guide. */
export function officialChoices(catalogId:CatalogId,platform:NodeJS.Platform=process.platform,arch:string=process.arch):readonly Choice[] {
  const row=definition(catalogId);
  if(!['darwin','linux'].includes(platform)||!['arm64','x64'].includes(arch))return [];
  const standalone=!!scripts[catalogId],choices:Choice[]=[];
  if(standalone)choices.push({method:'official',label:'Official standalone',sourceUrl:row.sourceUrl,recommended:true});
  if(catalogPackage(catalogId))for(const method of ['npm','bun'] as const)choices.push({method,label:method==='npm'?'npm global':'Bun global',sourceUrl:row.sourceUrl,recommended:method==='npm'&&!standalone&&catalogId!=='claude'});
  if(platform==='darwin'&&catalogId==='devin')choices.push({method:'brew',label:'Homebrew cask',sourceUrl:'https://docs.devin.ai/cli',recommended:true});
  return choices;
}
function changed():never {throw new AppError('source_changed','official_install_plan_stale');}
function guardPath(path:string):void {
  absolute.parse(path);
  for(let current=path;current!=='/';current=dirname(current)){
    const stat=lstatSync(current,{throwIfNoEntry:false});
    if(stat&&(!stat.isDirectory()||realpathSync(current)!==current))changed();
  }
}
function stamp(path:string):unknown {
  const stat=lstatSync(path,{throwIfNoEntry:false});if(!stat)return null;
  return [path,stat.dev,stat.ino,stat.mode,stat.isSymbolicLink()?readlinkSync(path):null,
    stat.isFile()?createHash('sha256').update(readFileSync(path)).digest('hex'):null];
}
function digest(base:Omit<OfficialInstallPlan,'recipeHash'>,context:Context,roots:readonly string[]):string {
  const paths=new Set<string>([base.manager,realpathSync(base.manager)]);
  for(const start of [base.target,dirname(base.executable),context.home,context.directory,base.manager,...roots])
    for(let p=start;p!=='/';p=dirname(p))paths.add(p);
  // Manager configuration is input too; credentials are hashed, never published.
  for(const p of [join(context.home,'.npmrc'),join(context.home,'.bunfig.toml'),join(context.home,'.config/bunfig.toml'),join(base.target,'etc/npmrc')])paths.add(p);
  return createHash('sha256').update(JSON.stringify([base,context,[...paths].sort().map(stamp)])).digest('hex');
}
function unoccupied(executable:string,roots:readonly string[]):void {
  if([executable,...roots].some(p=>lstatSync(p,{throwIfNoEntry:false})))throw new AppError('conflict','official_destination_exists');
  guardPath(dirname(executable));for(const root of roots)guardPath(dirname(root));
}
function manager(name:string,path:string):string {
  const result=findExecutable(name,path);if(!result)throw new AppError('unavailable',`${name}_required`);
  accessSync(result,constants.X_OK);return absolute.parse(result);
}
function scriptRoots(id:CatalogId,home:string,target:string):readonly string[] {
  switch(id){
    case 'cursor':return [join(target,'cursor-agent'),join(home,'.local/share/cursor-agent')];
    case 'kimi':return [join(home,'.kimi-code'),join(home,'.local/bin/kimi')];
    case 'opencode':return [join(home,'.opencode')];
    default:return [];
  }
}
export async function planOfficialInstall(options:Options):Promise<OfficialInstallPlan> {
  const row=definition(options.catalogId),platform=options.platform??process.platform,arch=options.arch??process.arch;
  if(!['darwin','linux'].includes(platform)||!['arm64','x64'].includes(arch))throw new AppError('unsupported','official_platform_unsupported');
  const context={home:absolute.parse(options.home),path:options.path,directory:absolute.parse(options.directory)};
  guardPath(context.home);guardPath(context.directory);
  if(!lstatSync(context.home)?.isDirectory()||!lstatSync(context.directory)?.isDirectory())changed();
  const choices=officialChoices(row.id,platform,arch);
  const method=options.method??choices.find(c=>c.recommended)?.method;
  if(!method||!choices.some(c=>c.method===method))throw new AppError('unsupported','official_manual_install_required');
  const env:Record<string,string>={HOME:context.home,PATH:context.path,LANG:'C',CI:'1',NO_COLOR:'1',SHELL:'/bin/bash'};
  const run=options.run??runProcess;
  let target:string,executable:string,selectedManager:string,args:readonly string[],sourceUrl=row.sourceUrl;
  let roots:readonly string[];
  if(method==='npm'||method==='bun'){
    const pkg=catalogPackage(row.id);if(!pkg)throw new AppError('unsupported','official_package_unverified');
    selectedManager=manager(method,context.path);
    if(method==='npm'){
      target=absolute.parse((await run(selectedManager,['prefix','--global'],env,context.home,15_000)).trim());
      const root=absolute.parse((await run(selectedManager,['root','--global'],env,context.home,15_000)).trim());
      if(root!==join(target,'lib/node_modules'))throw new AppError('unsupported','npm_global_root_unverified');
      executable=join(target,'bin',row.executable);roots=[join(root,pkg)];
      args=['install','--global',pkg,'--no-audit','--no-fund'];
    }else{
      const bin=absolute.parse((await run(selectedManager,['pm','bin','-g'],env,context.home,15_000)).trim());
      // pm ls -g reports the actual global install root (including bunfig overrides).
      const listing=await run(selectedManager,['pm','ls','-g'],env,context.home,15_000);
      const match=/^(\/[^\r\n]+) node_modules(?:\s|$)/.exec(listing);
      if(!match?.[1])throw new AppError('unsupported','bun_global_root_unverified');
      target=absolute.parse(match[1]);
      executable=join(bin,row.executable);roots=[join(target,'node_modules',pkg)];args=['add','--global',pkg];
    }
  }else if(method==='brew'){
    selectedManager=manager('brew',context.path);
    Object.assign(env,{HOMEBREW_NO_AUTO_UPDATE:'1',HOMEBREW_NO_ANALYTICS:'1',HOMEBREW_NO_INSTALL_CLEANUP:'1',HOMEBREW_NO_ENV_HINTS:'1',HOMEBREW_NO_ASK:'1',HOMEBREW_NO_SUDO:'1'});
    target=absolute.parse((await run(selectedManager,['--prefix'],env,context.home,15_000)).trim());
    const room=absolute.parse((await run(selectedManager,['--caskroom'],env,context.home,15_000)).trim());
    if(room!==join(target,'Caskroom'))changed();
    executable=join(target,'bin',row.executable);roots=[join(room,'devin-cli')];args=['install','--cask','devin-cli'];
    for(const p of ['/etc/homebrew/brew.env',join(target,'etc/homebrew/brew.env'),join(context.home,'.homebrew/brew.env')])
      if(lstatSync(p,{throwIfNoEntry:false}))throw new AppError('unsupported','brew_environment_unverified');
  }else{
    const script=scripts[row.id];if(!script)throw new AppError('unsupported','official_manual_install_required');
    target=join(context.home,script.root);executable=join(target,row.executable);
    selectedManager=realpathSync('/bin/bash');sourceUrl=script.url;args=script.args;Object.assign(env,script.env);
    roots=scriptRoots(row.id,context.home,target);
    if(row.id==='kimi')env['PATH']=context.path.split(':').filter(p=>p!==target).join(':');
    if(row.id==='maki'){
      try{accessSync(target,constants.W_OK);}catch{throw new AppError('unavailable','maki_writable_local_bin_required');}
    }
  }
  guardPath(target);
  if([target,dirname(executable),...roots].some(p=>p===context.directory||p.startsWith(context.directory+'/')))
    throw new AppError('unsupported','updater_owned_destination_forbidden');
  unoccupied(executable,roots);
  const bins=context.path.split(':');
  const destinationIndex=bins.indexOf(dirname(executable));
  const currentIndex=bins.findIndex(bin=>findExecutable(row.executable,bin)!==null);
  if(currentIndex>=0&&destinationIndex>=0&&destinationIndex<currentIndex)
    throw new AppError('conflict','official_destination_shadows_default');
  const base={catalogId:row.id,method,sourceUrl,executable,target,manager:selectedManager,args,env};
  return officialPlanSchema.parse({...base,recipeHash:digest(base,context,roots)});
}
async function download(url:string):Promise<string> {
  const response=await fetch(url,{signal:AbortSignal.timeout(30_000),redirect:'error',headers:{'User-Agent':'curl/8.0'}});
  if(!response.ok||response.url!==url)throw new AppError('unavailable','official_download_failed');
  const text=await response.text();if(!text||text.length>2_000_000)throw new AppError('unavailable','official_download_invalid');return text;
}
export async function executeOfficialInstall(input:OfficialInstallPlan,options:Context&Dependencies,onProgress:(event:InstallProgress)=>void):Promise<string> {
  const parsed=officialPlanSchema.safeParse(input);if(!parsed.success)changed();const plan=parsed.data;
  const run=options.run??runProcess;
  const check=async()=>{
    const current=await planOfficialInstall({...options,catalogId:plan.catalogId,method:plan.method});
    if(JSON.stringify(current)!==JSON.stringify(plan))changed();
  };
  let temporary:string|undefined,verification:string|undefined;
  try {
    await check();let args=plan.args;
    if(plan.method==='official'){
      onProgress('download_started');const text=await (options.download??download)(plan.sourceUrl);
      temporary=mkdtempSync(join(tmpdir(),'official-cli-'));const file=join(temporary,'install.sh');
      writeFileSync(file,text,{mode:0o600,flag:'wx'});args=[file,...args];onProgress('download_complete');
    }
    await check();onProgress('installer_started');
    await run(plan.manager,args,plan.env,options.home,900_000,()=>onProgress('installer_output_received'));
    const stat=lstatSync(plan.executable,{throwIfNoEntry:false});
    if(!stat||!stat.isFile()&&!stat.isSymbolicLink())throw new AppError('unavailable','installed_executable_missing');
    accessSync(plan.executable,constants.X_OK);
    const physical=realpathSync(plan.executable),root=realpathSync(plan.target),pkg=catalogPackage(plan.catalogId);
    const payload=plan.method==='brew'?join(root,'Caskroom/devin-cli'):
      plan.method==='bun'?join(root,'node_modules',pkg??''):
      plan.method==='npm'?join(root,'lib/node_modules',pkg??''):
      plan.catalogId==='cursor'?join(options.home,'.local/share/cursor-agent'):root;
    guardPath(payload);
    if(!physical.startsWith(payload+'/'))throw new AppError('unavailable','installed_executable_outside_target');
    verification=mkdtempSync(join(tmpdir(),'official-version-'));
    const output=await run(plan.executable,['--version'],{...plan.env,HOME:verification,
      XDG_CONFIG_HOME:join(verification,'.config'),XDG_CACHE_HOME:join(verification,'.cache'),XDG_DATA_HOME:join(verification,'.local/share'),
      MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0',DISABLE_AUTOUPDATER:'1',OPENCODE_DISABLE_AUTOUPDATE:'1'},verification,15_000);
    const version=parseCliVersion(output);if(!version)throw new AppError('unavailable','installed_version_unverified');return version;
  }catch(error){
    // Only trusted errors and lifecycle events leave the worker; never installer text or credentials.
    if(error instanceof AppError)throw error;
    throw new AppError('unavailable','official_install_failed_check_destination');
  }finally{
    if(temporary)rmSync(temporary,{recursive:true,force:true});
    if(verification)rmSync(verification,{recursive:true,force:true});
  }
}
