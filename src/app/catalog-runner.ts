import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './types';

export type InstallRecipe =
  | { readonly kind: 'npm'; readonly package: string; readonly bin: string }
  | { readonly kind: 'script'; readonly url: string; readonly bin: string; readonly env: Readonly<Record<string,string>>; readonly args: readonly string[] }
  | { readonly kind: 'uv'; readonly package: string; readonly bin: string }
  | { readonly kind: 'kiro-dmg'; readonly bin: string }
  | { readonly kind: 'devin-bundle'; readonly bin: string };
export type RunOptions = {
  readonly home:string; readonly path:string; readonly target:string;
  /** Existing, proven installation only. Rechecked after downloads, before payload writes. */
  readonly beforeUpdate?:()=>void;
};
export type InstallProgress='download_started'|'download_complete'|'checksum_verified'|'installer_started'|'installer_output_received';
export function parseCliVersion(output:string):string|null {
  return /(?:^|\s|\()(?:[A-Za-z][A-Za-z0-9_-]*\/)?v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)(?=\s|$|\))/.exec(output)?.[1]??null;
}
export function findExecutable(name:string,path:string):string|null {
  for(const directory of path.split(':').filter(part=>part.startsWith('/'))) {
    const file=join(directory,name);
    try { accessSync(file,constants.X_OK); if(lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())return realpathSync(file); }
    catch(error){if(!(error instanceof Error&&'code' in error&&['ENOENT','EACCES','ENOTDIR'].includes(String(error.code))))throw error;}
  }
  return null;
}
/** argv only; no caller-provided shell text. Process groups bound installer descendants. */
export async function runProcess(executable:string,args:readonly string[],env:NodeJS.ProcessEnv,cwd:string,
  timeout:number,onOutput:(line:string)=>void=()=>{},maxOutput=256_000):Promise<string> {
  const child=spawn(executable,[...args],{cwd,env,stdio:['ignore','pipe','pipe'],detached:true});
  let output='',timedOut=false,overflow=false;
  let terminationFailed=false;
  const terminate=()=>{if(!terminationFailed&&child.pid&&child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error instanceof Error&&'code' in error&&error.code==='ESRCH')return;terminationFailed=true;}}};
  const timer=setTimeout(()=>{timedOut=true;terminate();},timeout);
  const consume=(data:Buffer)=>{if(overflow)return;const text=data.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');if(output.length+text.length>maxOutput){overflow=true;terminate();return;}output+=text;for(const line of text.split(/\r?\n/).filter(Boolean))onOutput(line.slice(0,1000));};
  child.stdout.on('data',consume);child.stderr.on('data',consume);
  try {
    await new Promise<void>((resolve,reject)=>{child.once('error',()=>reject(new AppError('unavailable','installer_start_failed')));child.once('close',code=>{
      if(terminationFailed)reject(new AppError('uncertain','process_termination_failed'));
      else if(timedOut)reject(new AppError('timeout','installer_timeout'));
      else if(overflow)reject(new AppError('unavailable','installer_output_limit'));
      else if(code!==0)reject(new AppError('unavailable',`installer_exit_${code}`));else resolve();
    });});return output.trim();
  } finally {clearTimeout(timer);}
}
export function recipeExecutable(recipe:InstallRecipe,target:string):string{return join(target,recipe.bin);}
export async function executeRecipe(recipe:InstallRecipe,options:RunOptions,onOutput:(event:InstallProgress)=>void):Promise<void> {
  if(process.platform!=='darwin'&&process.platform!=='linux')throw new AppError('unsupported','install_platform_unsupported');
  if(process.arch!=='arm64'&&process.arch!=='x64')throw new AppError('unsupported','install_architecture_unsupported');
  if(recipe.kind==='kiro-dmg'&&process.platform!=='darwin')throw new AppError('unsupported','macos_required');
  if(options.beforeUpdate)options.beforeUpdate();
  else {
    if(existsSync(options.target))throw new AppError('conflict','install_target_exists');
    mkdirSync(options.target,{mode:0o700});
  }
  const installHome=join(options.target,'.installer-home');mkdirSync(installHome,{recursive:!!options.beforeUpdate,mode:0o700});
  const env:NodeJS.ProcessEnv={HOME:installHome,PATH:options.path,LANG:'en_US.UTF-8',CI:'1',NO_COLOR:'1',XDG_CONFIG_HOME:join(installHome,'.config'),XDG_CACHE_HOME:join(installHome,'.cache'),XDG_DATA_HOME:join(installHome,'.local/share')};
  // Installer stdout may contain tokens, URLs with credentials, or user content.
  // Emit only trusted lifecycle events; never persist raw package-manager output.
  const activity=()=>onOutput('installer_output_received');
  switch(recipe.kind){
    case 'devin-bundle':{
      onOutput('download_started');
      const platform=process.platform==='darwin'?'apple-darwin':process.platform==='linux'?'unknown-linux':null;
      const arch=process.arch==='arm64'?'aarch64':process.arch==='x64'?'x86_64':null;
      if(!platform||!arch)throw new AppError('unavailable','unsupported_platform');
      const response=await fetch('https://static.devin.ai/cli/current/manifest.json',{signal:AbortSignal.timeout(30_000)});
      if(!response.ok)throw new AppError('unavailable','installer_download_failed');
      const manifest=await response.json() as {platforms?:Record<string,{url:string;sha256:string}>};
      const artifact=manifest.platforms?.[`${arch}-${platform}`];
      if(!artifact||!artifact.url.startsWith('https://static.devin.ai/cli/')||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new AppError('unavailable','invalid_installer_manifest');
      const download=await fetch(artifact.url,{signal:AbortSignal.timeout(300_000)});
      if(!download.ok)throw new AppError('unavailable','installer_download_failed');
      const archive=join(options.target,'devin.tar.gz');await Bun.write(archive,download);
      onOutput('download_complete');
      if(new Bun.CryptoHasher('sha256').update(await Bun.file(archive).arrayBuffer()).digest('hex')!==artifact.sha256)throw new AppError('unavailable','installer_checksum_mismatch');
      onOutput('checksum_verified');
      const tar=findExecutable('tar',options.path);if(!tar)throw new AppError('unavailable','tar_required');
      const listing=await runProcess(tar,['-tzf',archive],env,options.target,60_000);
      if(listing.split('\n').some(path=>path.startsWith('/')||path.split('/').includes('..')))throw new AppError('unavailable','unsafe_archive_path');
      const bundle=join(options.target,'bundle');mkdirSync(bundle,{recursive:!!options.beforeUpdate});
      onOutput('installer_started');
      options.beforeUpdate?.();
      await runProcess(tar,['-xzf',archive,'-C',bundle],env,options.target,120_000,activity);
      break;
    }
    case 'kiro-dmg':{
      onOutput('download_started');
      if(process.platform!=='darwin')throw new AppError('unavailable','macos_required');
      const base='https://prod.download.cli.kiro.dev/stable/';
      const manifestResponse=await fetch(base+'latest/manifest.json',{signal:AbortSignal.timeout(30_000)});
      if(!manifestResponse.ok)throw new AppError('unavailable','installer_download_failed');
      const manifest=await manifestResponse.json() as {packages?:{os:string;fileType:string;download:string;sha256:string}[]};
      const artifact=manifest.packages?.find(row=>row.os==='macos'&&row.fileType==='dmg');
      if(!artifact||!/^\d+[\w.-]*\/Kiro CLI\.dmg$/.test(artifact.download)||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new AppError('unavailable','invalid_installer_manifest');
      const dmg=join(options.target,'kiro.dmg');
      const response=await fetch(new URL(artifact.download,base),{signal:AbortSignal.timeout(300_000)});
      if(!response.ok)throw new AppError('unavailable','installer_download_failed');
      await Bun.write(dmg,response);
      onOutput('download_complete');
      const digest=new Bun.CryptoHasher('sha256').update(await Bun.file(dmg).arrayBuffer()).digest('hex');
      if(digest!==artifact.sha256)throw new AppError('unavailable','installer_checksum_mismatch');
      onOutput('checksum_verified');
      const mount=join(options.target,'.mount');mkdirSync(mount,{recursive:!!options.beforeUpdate});
      onOutput('installer_started');
      await runProcess('/usr/bin/hdiutil',['attach',dmg,'-nobrowse','-readonly','-owners','off','-mountpoint',mount],env,options.target,60_000,activity);
      try{
        const app=readdirSync(mount).filter(name=>name.endsWith('.app'));
        if(app.length!==1)throw new AppError('unavailable','installer_app_missing');
        options.beforeUpdate?.();
        await runProcess('/usr/bin/ditto',[join(mount,app[0]!),join(options.target,'Kiro CLI.app')],env,options.target,120_000,activity);
      }finally{await runProcess('/usr/bin/hdiutil',['detach',mount],env,options.target,60_000,activity);}
      break;
    }
    case 'npm':{
      const npm=findExecutable('npm',options.path);if(!npm)throw new AppError('unavailable','npm_required');
      onOutput('installer_started');
      options.beforeUpdate?.();
      await runProcess(npm,['install','--global','--prefix',options.target,'--registry=https://registry.npmjs.org','--no-audit','--no-fund',options.beforeUpdate?`${recipe.package}@latest`:recipe.package],
        {...env,npm_config_cache:join(options.target,'.npm-cache'),npm_config_userconfig:join(installHome,'user.npmrc'),npm_config_globalconfig:join(installHome,'global.npmrc')},options.target,900_000,activity);break;
    }
    case 'uv':{
      const uv=findExecutable('uv',options.path);if(!uv)throw new AppError('unavailable','uv_required');
      onOutput('installer_started');
      options.beforeUpdate?.();
      await runProcess(uv,['tool',options.beforeUpdate?'upgrade':'install',recipe.package],{...env,UV_TOOL_DIR:join(options.target,'tools'),UV_TOOL_BIN_DIR:join(options.target,'bin'),UV_CACHE_DIR:join(options.target,'.uv-cache')},options.target,900_000,activity);break;
    }
    case 'script':{
      onOutput('download_started');
      const response=await fetch(recipe.url,{signal:AbortSignal.timeout(30_000)});
      if(!response.ok||new URL(response.url).protocol!=='https:')throw new AppError('unavailable','installer_download_failed');
      const text=await response.text();if(text.length>2_000_000)throw new AppError('unavailable','installer_too_large');
      const file=join(options.target,'.official-installer.sh');await Bun.write(file,text,{mode:0o600});
      onOutput('download_complete');
      const overrides=Object.fromEntries(Object.entries(recipe.env).map(([key,value])=>[key,value.replaceAll('$TARGET',options.target)]));
      const args=recipe.args.map(value=>value.replaceAll('$TARGET',options.target));
      onOutput('installer_started');
      options.beforeUpdate?.();
      await runProcess('/bin/bash',[file,...args],{...env,...overrides},options.target,900_000,activity);break;
    }
  }
}
export async function verifyExecutable(executable:string,options:RunOptions):Promise<string> {
  if(!existsSync(executable))throw new AppError('unavailable','installed_executable_missing');
  if(!realpathSync(executable).startsWith(realpathSync(options.target)+'/'))throw new AppError('unavailable','installed_executable_outside_target');
  const home=join(options.target,'.verification-home');mkdirSync(home,{recursive:true,mode:0o700});
  const output=await runProcess(executable,['--version'],{HOME:home,PATH:options.path,LANG:'C',NO_COLOR:'1',CI:'1',MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0'},options.target,15_000);
  const version=parseCliVersion(output);
  if(!version)throw new AppError('unavailable','installed_version_unverified');return version;
}
