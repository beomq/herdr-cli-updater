import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { z } from 'zod';
import { catalogForPlatform, catalogPackage } from './catalog-registry';
import type { CatalogId } from './catalog-types';
import { AppError } from './types';
import type { UpdateTarget } from './catalog-update-target';
import { latestBrewVersion } from './catalog-brew';

// SemVer numeric components cannot have leading zeros; prerelease identifiers
// cannot be empty or zero-padded numbers. Build identifiers may be numeric.
const npmVersion=z.string().max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$(?![\s\S])/);
// Native channels retain their existing version format, including Kimi's 2.0.
const version=z.string().max(128).regex(/^\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$(?![\s\S])/);
const checksum=z.string().regex(/^[a-f0-9]{64}$/);
const release=z.object({tag_name:z.string().max(129).regex(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$(?![\s\S])/),draft:z.literal(false),prerelease:z.literal(false)});
const maxBytes=1_000_000;

/** Bound the streamed body before JSON parsing, including chunked responses. */
async function document(url:string):Promise<string> {
  const signal=AbortSignal.timeout(30_000);
  try {
    const response=await fetch(url,{signal,headers:{Accept:'application/json', 'User-Agent':'herdr-cli-updater'}});
    if(!response.ok)throw new AppError('unavailable','latest_download_failed');
    if(Number(response.headers.get('content-length'))>maxBytes) {
      await response.body?.cancel();
      throw new AppError('unavailable','latest_response_too_large');
    }
    if(!response.body)throw new AppError('unavailable','latest_response_invalid');
    const reader=response.body.getReader();
    const chunks:Uint8Array[]=[];
    let size=0;
    try {
      for(;;) {
        const {done,value}=await reader.read();
        if(done)break;
        size+=value.byteLength;
        if(size>maxBytes){await reader.cancel();throw new AppError('unavailable','latest_response_too_large');}
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
    const bytes=new Uint8Array(size);
    let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  } catch(error) {
    if(error instanceof AppError)throw error;
    if(signal.aborted||error instanceof DOMException&&['TimeoutError','AbortError'].includes(error.name))
      throw new AppError('timeout','latest_timeout');
    throw new AppError('unavailable','latest_download_failed');
  }
}
async function json<T>(url:string,schema:z.ZodType<T>):Promise<T> {
  const text=await document(url);
  try {return schema.parse(JSON.parse(text));}
  catch(error) {
    if(error instanceof SyntaxError||error instanceof z.ZodError)throw new AppError('unavailable','latest_response_invalid');
    throw error;
  }
}

/** Read the same official default channel as executeUpdate; never run an installer. */
export async function latestCatalogVersion(catalogId:CatalogId,target?:UpdateTarget):Promise<string> {
  if(target?.kind==='official'&&(target.catalogId!==catalogId||catalogId==='opencode'&&target.sourceUrl!=='https://opencode.ai/install'))
    throw new AppError('unsupported','latest_source_unverified');
  if(target?.kind==='brew'){
    if(catalogForPlatform(process.platform).find(row=>row.id===catalogId)?.executable!==basename(target.executable))
      throw new AppError('unsupported','latest_source_unverified');
    return latestBrewVersion(target);
  }
  if(['agy','cursor','grok','hermes'].includes(catalogId))throw new AppError('unsupported','latest_source_unverified');
  const recipe=catalogForPlatform(process.platform).find(row=>row.id===catalogId)?.recipe;
  if(!recipe)throw new AppError('unsupported','install_platform_unsupported');
  const packageName=target?.kind==='official'?null:target&&target.kind!=='owned'?catalogPackage(catalogId):recipe.kind==='npm'?recipe.package:null;
  if(target&&target.kind!=='owned'&&target.kind!=='official'&&target.packageName!==packageName)throw new AppError('unsupported','latest_source_unverified');
  if(packageName) {
    const data=await json(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,z.object({name:z.literal(packageName),version:npmVersion}));
    return data.version;
  }
  switch(catalogId) {
    case 'opencode': {
      // The official installer selects stable anomalyco releases, not opencode-ai on npm.
      let arch:string=process.arch,baseline=false;
      if(arch==='x64') {
        try {
          if(process.platform==='darwin') {
            if(execFileSync('/usr/sbin/sysctl',['-in','sysctl.proc_translated'],{encoding:'utf8',timeout:5_000,stdio:['ignore','pipe','ignore']}).trim()==='1')arch='arm64';
            else baseline=execFileSync('/usr/sbin/sysctl',['-in','hw.optional.avx2_0'],{encoding:'utf8',timeout:5_000}).trim()!=='1';
          }else baseline=!/\bavx2\b/i.test(readFileSync('/proc/cpuinfo','utf8'));
        }catch {throw new AppError('unsupported','latest_platform_unverified');}
      }
      const report=process.platform==='linux'?process.report.getReport():null;
      const glibc=report&&typeof report==='object'&&'header' in report&&report.header&&typeof report.header==='object'&&'glibcVersionRuntime' in report.header;
      const musl=process.platform==='linux'&&(existsSync('/etc/alpine-release')||!glibc);
      const filename=`opencode-${process.platform}-${arch}${baseline?'-baseline':''}${musl?'-musl':''}${process.platform==='linux'?'.tar.gz':'.zip'}`;
      const data=await json('https://api.github.com/repos/anomalyco/opencode/releases/latest',release.extend({
        html_url:z.url(),assets:z.array(z.object({name:z.string().max(256),browser_download_url:z.url()})).max(200),
      }));
      if(data.html_url!==`https://github.com/anomalyco/opencode/releases/tag/${data.tag_name}`)
        throw new AppError('unavailable','latest_response_invalid');
      const artifacts=data.assets.filter(asset=>asset.name===filename);
      if(artifacts.length!==1||artifacts[0]?.browser_download_url!==`https://github.com/anomalyco/opencode/releases/download/${data.tag_name}/${filename}`)
        throw new AppError('unavailable','latest_artifact_unavailable');
      return data.tag_name.slice(1);
    }
    case 'gjc':
    case 'maki': {
      // GJC verifies --version against ${LATEST#v}; Maki's clap version is Cargo's version.
      const repo=catalogId==='gjc'?'Yeachan-Heo/gajae-code':'tontinton/maki';
      const data=await json(`https://api.github.com/repos/${repo}/releases/latest`,release);
      return data.tag_name.slice(1);
    }
    case 'kimi': {
      // install.sh resolves KIMI_DOWNLOAD_BASE/latest as plain text, not PyPI.
      const parsed=version.safeParse((await document('https://code.kimi.com/kimi-code/latest')).trim());
      if(!parsed.success)throw new AppError('unavailable','latest_response_invalid');
      return parsed.data;
    }
    case 'muse': {
      // dev.meta.ai/install.sh delegates to api.meta.ai/muse-launcher.sh.
      const data=await json('https://api.meta.ai/muse-code/channels/muse-stable',z.object({
        channel:z.literal('muse-stable'),version:z.string().max(128).regex(/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$(?![\s\S])/),
        manifest_url:z.url(),
      }));
      return data.version;
    }
    case 'omp': {
      // omp.sh/install --binary uses the Stencil build service, not GitHub latest.
      const report=process.platform==='linux'?process.report.getReport():null;
      const glibc=report&&typeof report==='object'&&'header' in report&&report.header&&typeof report.header==='object'&&'glibcVersionRuntime' in report.header;
      const platform=process.platform==='darwin'?'macos':existsSync('/etc/alpine-release')||!glibc?'linux-musl':'linux';
      const arch=process.arch==='arm64'?'arm64':'x86_64';
      const data=await json(`https://build.stencil.so/api/products/omp/latest/${platform}-${arch}?channel=stable`,z.object({
        build:z.object({product:z.literal('omp'),channel:z.literal('stable'),version}),
        file:z.object({platform:z.literal(platform),arch:z.literal(arch),sha256:checksum}),
        download:z.url(),
      }));
      return data.build.version;
    }
    case 'devin': {
      const data=await json('https://static.devin.ai/cli/current/manifest.json',z.object({version,
        platforms:z.record(z.string().max(128),z.object({url:z.url(),sha256:checksum})),
      }));
      const target=`${process.arch==='arm64'?'aarch64':'x86_64'}-${process.platform==='darwin'?'apple-darwin':'unknown-linux'}`;
      const artifact=data.platforms[target];
      if(!artifact||!artifact.url.startsWith(`https://static.devin.ai/cli/${data.version}/`))
        throw new AppError('unavailable','latest_artifact_unavailable');
      return data.version;
    }
    case 'kiro': {
      const data=await json('https://prod.download.cli.kiro.dev/stable/latest/manifest.json',z.object({version,
        packages:z.array(z.object({os:z.string().max(32),fileType:z.string().max(32),channel:z.string().max(32),download:z.string().max(256),sha256:checksum})).max(100),
      }));
      const artifact=data.packages.find(row=>row.os==='macos'&&row.fileType==='dmg');
      if(!artifact||artifact.channel!=='stable'||artifact.download!==`${data.version}/Kiro CLI.dmg`)
        throw new AppError('unavailable','latest_artifact_unavailable');
      return data.version;
    }
    default:throw new AppError('unsupported','latest_source_unverified');
  }
}
