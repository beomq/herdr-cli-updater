import { accessSync, constants, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { z } from 'zod';
import { catalogDefinitions } from './catalog-registry';
import { parseCliVersion, runProcess } from './catalog-runner';
import type { CatalogId } from './catalog-types';
import { AppError } from './types';
import { removalFingerprint } from './removal-fingerprint';
import { discoverClaudeUpdate, executeClaudeUpdate } from './catalog-claude-update';

const absolute=z.string().startsWith('/').max(4096).regex(/^[^\x00-\x1f\x7f:]+$/).refine(p=>normalize(p)===p&&p!=='/');
export const officialUpdateTargetSchema=z.object({
  kind:z.literal('official'),catalogId:z.enum(['gjc','omp','maki','kimi','opencode','claude']),
  target:absolute,executable:absolute,sourceUrl:z.url().startsWith('https://'),
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),preserve:z.array(absolute).readonly(),
}).strict();
export type OfficialUpdateTarget=z.infer<typeof officialUpdateTargetSchema>;
type Context={readonly home:string;readonly path:string;readonly directory:string;readonly beforeMutation?:()=>void};
type Dependencies={readonly run?:typeof runProcess;readonly download?:(url:string)=>Promise<string>};
const contracts={
  gjc:{root:'.local/bin',url:'https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh',args:['--binary'],env:{GJC_NO_COMMUNITY_APP:'1',GJC_NONINTERACTIVE:'1'}},
  omp:{root:'.local/bin',url:'https://omp.sh/install',args:['--binary'],env:{}},
  maki:{root:'.local/bin',url:'https://maki.sh/install.sh',args:[],env:{}},
  kimi:{root:'.kimi-code/bin',url:'https://code.kimi.com/kimi-code/install.sh',args:[],env:{KIMI_NO_MODIFY_PATH:'1'}},
  opencode:{root:'.opencode/bin',url:'https://opencode.ai/install',args:['--no-modify-path'],env:{}},
} as const;
export function officialUpdateSupported(id:CatalogId):id is OfficialUpdateTarget['catalogId'] {return id==='claude'||Object.hasOwn(contracts,id);}
function changed():never {throw new AppError('source_changed','official_update_target_changed');}
function physicalDirectory(path:string):void {
  absolute.parse(path);
  for(let current=path;current!=='/';current=dirname(current)){
    const stat=lstatSync(current);
    if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(current)!==current)changed();
  }
}
function native(executable:string,id:OfficialUpdateTarget['catalogId']):void {
  const stat=lstatSync(executable);if(!stat.isFile()||stat.isSymbolicLink())changed();
  accessSync(executable,constants.X_OK);
  const bytes=readFileSync(executable),magic=bytes.subarray(0,4).toString('hex');
  const formats=process.platform==='darwin'?['cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca']:['7f454c46'];
  if(!formats.includes(magic)||!bytes.includes(Buffer.from(id)))changed();
}
function environment(id:OfficialUpdateTarget['catalogId'],context:Context):Record<string,string> {
  if(id==='claude')changed();
  let path=context.path;
  if(id==='kimi'){
    const own=join(context.home,contracts.kimi.root);
    path=path.split(':').filter(part=>{
      if(!part.startsWith('/'))return false;
      try{return realpathSync(part)!==own;}catch{return false;}
    }).join(':');
  }
  return {HOME:context.home,PATH:path,LANG:'C',CI:'1',NO_COLOR:'1',SHELL:'/bin/bash',...contracts[id].env};
}
function stamp(path:string):unknown {
  const stat=lstatSync(path,{throwIfNoEntry:false});if(!stat)return null;
  return [path,stat.dev,stat.ino,stat.mode,stat.uid,stat.isSymbolicLink()?readlinkSync(path):null];
}
function proof(base:Omit<OfficialUpdateTarget,'fingerprint'>,context:Context):string {
  if(base.catalogId==='claude')changed();
  physicalDirectory(context.home);physicalDirectory(base.target);
  native(base.executable,base.catalogId);
  if(realpathSync(base.executable)!==base.executable||base.target===context.directory||base.target.startsWith(context.directory+'/'))changed();
  const paths=new Set<string>([base.executable,'/bin/bash',realpathSync('/bin/bash')]);
  for(const start of [base.target,context.home,context.directory])
    for(let current=start;current!=='/';current=dirname(current))paths.add(current);
  return removalFingerprint([base.executable,realpathSync('/bin/bash')],JSON.stringify([base,{home:context.home,path:context.path,directory:context.directory},contracts[base.catalogId],environment(base.catalogId,context),[...paths].sort().map(stamp)]));
}
async function identify(target:OfficialUpdateTarget,context:Context,run:typeof runProcess):Promise<string> {
  const output=await run(target.executable,['--version'],{...environment(target.catalogId,context),MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0',DISABLE_AUTOUPDATER:'1',OPENCODE_DISABLE_AUTOUPDATE:'1'},context.home,15_000);
  const version=parseCliVersion(output);
  // Numeric-only clap versions are valid; named output must name this executable.
  if(!version||!new RegExp(`^(?:v?\\d|${target.catalogId}(?:[ /:]|$))`,'i').test(output.trim()))changed();
  return version;
}
export async function discoverOfficialUpdate(options:Context&Dependencies&{readonly catalogId:CatalogId;readonly executable:string}):Promise<OfficialUpdateTarget|null> {
  if(!officialUpdateSupported(options.catalogId)||!['darwin','linux'].includes(process.platform)||!['arm64','x64'].includes(process.arch))return null;
  try {
    if(options.catalogId==='claude')return await discoverClaudeUpdate(options);
    const id=options.catalogId,contract=contracts[id],target=join(options.home,contract.root);
    const executable=join(target,catalogDefinitions.find(row=>row.id===id)!.executable);
    if(options.executable!==executable)return null;
    const base={kind:'official' as const,catalogId:id,target,executable,sourceUrl:contract.url,preserve:[options.home]};
    const result=officialUpdateTargetSchema.parse({...base,fingerprint:proof(base,options)});
    await identify(result,options,options.run??runProcess);
    if(proof(base,options)!==result.fingerprint)changed();
    return result;
  }catch(error){
    if(error instanceof AppError||error instanceof z.ZodError)return null;
    if(error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(String(error.code)))return null;
    throw error;
  }
}
async function download(url:string):Promise<string> {
  const response=await fetch(url,{signal:AbortSignal.timeout(30_000),headers:{'User-Agent':'curl/8.0'}});
  if(!response.ok||new URL(response.url).protocol!=='https:')throw new AppError('unavailable','official_download_failed');
  const text=await response.text();if(!text||text.length>2_000_000)throw new AppError('unavailable','official_download_invalid');return text;
}
export async function executeOfficialUpdate(input:OfficialUpdateTarget,context:Context&Dependencies,onProgress:(event:string)=>void=()=>{}):Promise<string> {
  const parsed=officialUpdateTargetSchema.safeParse(input);if(!parsed.success)changed();const target=parsed.data;
  if(target.catalogId==='claude')return executeClaudeUpdate(target,context,onProgress);
  const run=context.run??runProcess;
  const check=async()=>{
    const current=await discoverOfficialUpdate({...context,catalogId:target.catalogId,executable:target.executable});
    if(!current||JSON.stringify(current)!==JSON.stringify(target))changed();
  };
  let work:string|undefined;
  try {
    await check();onProgress('download_started');
    const text=await (context.download??download)(target.sourceUrl);
    // Fingerprint excludes downloads: existing default paths and real HOME remain authoritative.
    work=realpathSync(mkdtempSync(join(tmpdir(),'official-update-')));
    const script=join(work,'install.sh');writeFileSync(script,text,{mode:0o600,flag:'wx'});
    onProgress('download_complete');await check();onProgress('installer_started');
    context.beforeMutation?.();
    await run(realpathSync('/bin/bash'),[script,...contracts[target.catalogId].args],{...environment(target.catalogId,context),TMPDIR:work},context.home,900_000,()=>onProgress('installer_output_received'));
    onProgress('verification_started');
    const updated=await discoverOfficialUpdate({...context,catalogId:target.catalogId,executable:target.executable});
    if(!updated||updated.target!==target.target||updated.sourceUrl!==target.sourceUrl)changed();
    const version=await identify(updated,context,run);
    const {fingerprint,...base}=updated;if(proof(base,context)!==fingerprint)changed();
    onProgress('update_verified');return version;
  }catch(error){
    if(error instanceof AppError)throw error;
    throw new AppError('unavailable','official_update_failed_check_destination');
  }finally{if(work)rmSync(work,{recursive:true,force:true});}
}
