import { accessSync, closeSync, constants, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { OfficialUpdateTarget } from './catalog-official-update';
import { runProcess } from './catalog-runner';
import { removalFingerprint } from './removal-fingerprint';
import { AppError } from './types';

// https://claude.ai/install.sh resolves these channels before reading manifest.json.
export const claudeReleaseBase='https://downloads.claude.ai/claude-code-releases';
export const claudeNativeVersion=z.string().max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$(?![\s\S])/);
type Context={readonly home:string;readonly path:string;readonly directory:string;readonly run?:typeof runProcess;readonly beforeMutation?:()=>void};
function changed():never {throw new AppError('source_changed','official_update_target_changed');}

export function claudeReleaseChannel(sourceUrl:string):'latest'|'stable' {
  if(sourceUrl===`${claudeReleaseBase}/latest`)return 'latest';
  if(sourceUrl===`${claudeReleaseBase}/stable`)return 'stable';
  throw new AppError('unsupported','latest_source_unverified');
}
function environment(context:Context):NodeJS.ProcessEnv {
  return {HOME:context.home,PATH:context.path,LANG:'C',CI:'1',NO_COLOR:'1',DISABLE_AUTOUPDATER:'1'};
}
function layout(context:Context) {
  const target=join(context.home,'.local/share/claude'),executable=join(context.home,'.local/bin/claude');
  const canonical=realpathSync(executable),version=basename(canonical);
  if(!claudeNativeVersion.safeParse(version).success||canonical!==join(target,'versions',version)||
    target===context.directory||target.startsWith(context.directory+'/'))changed();
  const paths=new Set<string>();
  for(const start of [dirname(executable),dirname(canonical),context.home,context.directory]){
    for(let path=start;path!=='/';path=dirname(path)){
      const stat=lstatSync(path);
      if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path)changed();
      paths.add(path);
    }
  }
  const owner=lstatSync(context.home).uid,link=lstatSync(executable),binary=lstatSync(canonical);
  if(!link.isSymbolicLink()||!binary.isFile()||binary.isSymbolicLink()||link.uid!==owner||binary.uid!==owner||
    lstatSync(target).uid!==owner||lstatSync(dirname(canonical)).uid!==owner)changed();
  accessSync(canonical,constants.X_OK);
  const fd=openSync(canonical,constants.O_RDONLY|constants.O_NOFOLLOW),header=Buffer.alloc(4);
  try {if(readSync(fd,header,0,4,0)!==4)changed();}finally{closeSync(fd);}
  const formats=process.platform==='darwin'?['cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca']:['7f454c46'];
  if(!formats.includes(header.toString('hex')))changed();
  const directories=[...paths].sort().map(path=>{const stat=lstatSync(path);return [path,stat.dev,stat.ino,stat.mode,stat.uid];});
  return {target,executable,canonical,version,directories,link:readlinkSync(executable)};
}
function fingerprint(context:Context,sourceUrl:string):string {
  const current=layout(context);
  return removalFingerprint([current.executable],JSON.stringify([current,sourceUrl,context.home,context.path,context.directory,environment(context)]));
}
function field(output:string,name:string):string {
  const lines=output.split(/\r?\n/).filter(line=>line.startsWith(name+': '));
  if(lines.length!==1)changed();
  return lines[0]?.slice(name.length+2)??changed();
}

/** Ask the native CLI for its effective channel, including managed settings precedence. */
export async function discoverClaudeUpdate(context:Context&{readonly executable:string}):Promise<OfficialUpdateTarget|null> {
  const current=layout(context);
  if(context.executable!==current.executable&&context.executable!==current.canonical)return null;
  const before=fingerprint(context,claudeReleaseBase),run=context.run??runProcess;
  const env={...environment(context),DISABLE_UPDATES:'1'};
  const output=await run(current.canonical,['--version'],env,context.home,15_000);
  if(output.trim()!==`${current.version} (Claude Code)`)changed();
  const doctor=await run(current.canonical,['doctor'],env,context.home,30_000);
  if(field(doctor,'Running')!==`native (${current.version})`||field(doctor,'Path')!==current.canonical||
    field(doctor,'Config install method')!=='native')changed();
  const channel=field(doctor,'Auto-update channel');
  if(channel!=='latest'&&channel!=='stable')changed();
  if(fingerprint(context,claudeReleaseBase)!==before)changed();
  const sourceUrl=`${claudeReleaseBase}/${channel}`;
  return {kind:'official',catalogId:'claude',target:current.target,executable:current.executable,sourceUrl,
    fingerprint:fingerprint(context,sourceUrl),preserve:[context.home]};
}

export async function executeClaudeUpdate(target:OfficialUpdateTarget,context:Context,onProgress:(event:string)=>void):Promise<string> {
  try {
    claudeReleaseChannel(target.sourceUrl);
    const current=await discoverClaudeUpdate({...context,executable:target.executable});
    if(!current||JSON.stringify(current)!==JSON.stringify(target))changed();
    const canonical=layout(context).canonical;
    onProgress('installer_started');context.beforeMutation?.();
    if(fingerprint(context,target.sourceUrl)!==target.fingerprint)changed();
    const output=await (context.run??runProcess)(canonical,['update'],environment(context),context.home,900_000,()=>onProgress('installer_output_received'));
    onProgress('verification_started');
    // A zero exit alone does not prove installation: verify the reported version through the managed launcher.
    const reported=/(?:^|\n)Successfully updated from [^\r\n]+ to version (\d+\.\d+\.\d+)(?:\r?\n|$)/.exec(output)?.[1]
      ??/(?:^|\n)Claude Code is up to date \((\d+\.\d+\.\d+)\)(?:\r?\n|$)/.exec(output)?.[1];
    if(!reported)throw new AppError('unavailable','updated_version_unverified');
    const updated=await discoverClaudeUpdate({...context,executable:target.executable});
    if(!updated||updated.target!==target.target||updated.sourceUrl!==target.sourceUrl||layout(context).version!==reported)changed();
    if(fingerprint(context,target.sourceUrl)!==updated.fingerprint)changed();
    onProgress('update_verified');return reported;
  }catch(error){
    if(error instanceof AppError)throw error;
    throw new AppError('unavailable','official_update_failed_check_destination');
  }
}
