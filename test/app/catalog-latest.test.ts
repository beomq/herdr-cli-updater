import { expect, spyOn, test } from 'bun:test';
import { latestCatalogVersion } from '../../src/app/catalog-latest';
import { catalogDefinitions } from '../../src/app/catalog-registry';
import type { CatalogId } from '../../src/app/catalog-types';
import { AppError } from '../../src/app/types';
import type { OfficialUpdateTarget } from '../../src/app/catalog-official-update';

const opencodeTarget:OfficialUpdateTarget={kind:'official',catalogId:'opencode',target:'/fixture/.opencode/bin',executable:'/fixture/.opencode/bin/opencode',sourceUrl:'https://opencode.ai/install',fingerprint:'a'.repeat(64),preserve:['/fixture']};
const opencodeRelease={tag_name:'v1.2.3',draft:false,prerelease:false,html_url:'https://github.com/anomalyco/opencode/releases/tag/v1.2.3',assets:
  ['darwin-arm64.zip','darwin-x64.zip','darwin-x64-baseline.zip','linux-arm64.tar.gz','linux-arm64-musl.tar.gz','linux-x64.tar.gz','linux-x64-baseline.tar.gz','linux-x64-musl.tar.gz','linux-x64-baseline-musl.tar.gz'].map(platform=>({name:`opencode-${platform}`,browser_download_url:`https://github.com/anomalyco/opencode/releases/download/v1.2.3/opencode-${platform}`}))};

test('official OpenCode reads the stable standalone release instead of npm',async()=>{
  const fetcher=mockFetch(url=>{
    expect(url).toBe('https://api.github.com/repos/anomalyco/opencode/releases/latest');
    return Response.json(opencodeRelease);
  });
  try{expect(await latestCatalogVersion('opencode',opencodeTarget)).toBe('1.2.3');expect(fetcher).toHaveBeenCalledTimes(1);}
  finally{fetcher.mockRestore();}
});

test('OpenCode package installations keep their npm channel',async()=>{
  const fetcher=mockFetch(url=>{
    expect(url).toBe('https://registry.npmjs.org/opencode-ai/latest');
    return Response.json({name:'opencode-ai',version:'9.8.7'});
  });
  try{
    for(const kind of ['npm','bun'] as const)
      expect(await latestCatalogVersion('opencode',{kind,target:'/fixture/global',executable:'/fixture/bin/opencode',manager:'/fixture/bin/'+kind,packageName:'opencode-ai',fingerprint:'a'.repeat(64),preserve:[]})).toBe('9.8.7');
  }finally{fetcher.mockRestore();}
});

test('OpenCode rejects stale target identity and source before requesting metadata',async()=>{
  const fetcher=mockFetch(()=>Response.json(opencodeRelease));
  try{
    for(const target of [{...opencodeTarget,catalogId:'gjc' as const},{...opencodeTarget,sourceUrl:'https://opencode.ai/install?channel=nightly'}])
      await expect(latestCatalogVersion('opencode',target)).rejects.toMatchObject({code:'unsupported',detail:'latest_source_unverified'});
    await expect(latestCatalogVersion('gjc',opencodeTarget)).rejects.toMatchObject({code:'unsupported',detail:'latest_source_unverified'});
    expect(fetcher).not.toHaveBeenCalled();
  }finally{fetcher.mockRestore();}
});

test('OpenCode rejects malformed, unstable and unrelated release metadata',async()=>{
  for(const body of ['{',JSON.stringify({success:true,version:'1.2.3'}),...[
    {...opencodeRelease,tag_name:'v1.2.3\n'},
    {...opencodeRelease,tag_name:'v1.2.3-beta.1'},
    {...opencodeRelease,tag_name:'v01.2.3'},
    {...opencodeRelease,draft:true},
    {...opencodeRelease,prerelease:true},
    {...opencodeRelease,html_url:'https://github.com/other/opencode/releases/tag/v1.2.3'},
    {...opencodeRelease,assets:null},
  ].map(value=>JSON.stringify(value))]){
    const fetcher=mockFetch(()=>new Response(body));
    try{await expect(latestCatalogVersion('opencode',opencodeTarget)).rejects.toMatchObject({code:'unavailable',detail:'latest_response_invalid'});}
    finally{fetcher.mockRestore();}
  }
});

test('OpenCode requires a unique matching platform artifact from the same release and source',async()=>{
  for(const assets of [[],opencodeRelease.assets.map(asset=>({...asset,name:'wrong-'+asset.name})),
    opencodeRelease.assets.map(asset=>({...asset,browser_download_url:asset.browser_download_url.replace('/v1.2.3/','/v1.2.2/')})),
    opencodeRelease.assets.map(asset=>({...asset,browser_download_url:asset.browser_download_url.replace('github.com','example.com')})),
    [...opencodeRelease.assets,...opencodeRelease.assets]]){
    const fetcher=mockFetch(()=>Response.json({...opencodeRelease,assets}));
    try{await expect(latestCatalogVersion('opencode',opencodeTarget)).rejects.toMatchObject({code:'unavailable',detail:'latest_artifact_unavailable'});}
    finally{fetcher.mockRestore();}
  }
});

test('OpenCode network failures and misleading HTTP success never return a version',async()=>{
  for(const [response,code,detail] of [[new Response('unavailable',{status:503}),'unavailable','latest_download_failed'],
    [new Response('installed successfully'),'unavailable','latest_response_invalid'],
    [new TypeError('network failed'),'unavailable','latest_download_failed'],
    [new DOMException('timeout','TimeoutError'),'timeout','latest_timeout'],
    [new Response('{}',{headers:{'content-length':'1000001'}}),'unavailable','latest_response_too_large']] as const){
    const fetcher=mockFetch(()=>{if(response instanceof Error)throw response;return response;});
    try{
      await expect(latestCatalogVersion('opencode',opencodeTarget)).rejects.toMatchObject({code,detail});
      expect(fetcher).toHaveBeenCalledTimes(1);
    }finally{fetcher.mockRestore();}
  }
});

const sha256='a'.repeat(64);
const npmRecipes=catalogDefinitions.filter(row=>row.recipe?.kind==='npm');
const devinTarget=`${process.arch==='arm64'?'aarch64':'x86_64'}-${process.platform==='darwin'?'apple-darwin':'unknown-linux'}`;
const ompPlatform=process.platform==='darwin'?'macos':'linux';
const ompArch=process.arch==='arm64'?'arm64':'x86_64';
type Fixture={readonly id:CatalogId;readonly url:string;readonly body:unknown;readonly version:string};
const fixtures:readonly Fixture[]=[
  {id:'gjc',url:'https://api.github.com/repos/Yeachan-Heo/gajae-code/releases/latest',body:{tag_name:'v0.18.9',draft:false,prerelease:false},version:'0.18.9'},
  {id:'maki',url:'https://api.github.com/repos/tontinton/maki/releases/latest',body:{tag_name:'v0.6.2',draft:false,prerelease:false},version:'0.6.2'},
  {id:'kimi',url:'https://code.kimi.com/kimi-code/latest',body:'2.1.1\n',version:'2.1.1'},
  {id:'muse',url:'https://api.meta.ai/muse-code/channels/muse-stable',body:{channel:'muse-stable',version:'1.4.4-R5419.1',manifest_url:'https://lookaside.facebook.com/lookaside/muse/download/?file=manifest.json'},version:'1.4.4-R5419.1'},
  {id:'omp',url:`https://build.stencil.so/api/products/omp/latest/${ompPlatform}-${ompArch}?channel=stable`,body:{build:{product:'omp',channel:'stable',version:'18.9.1'},file:{platform:ompPlatform,arch:ompArch,sha256},download:'https://build.stencil.so/d/omp/build/omp'},version:'18.9.1'},
  {id:'devin',url:'https://static.devin.ai/cli/current/manifest.json',body:{version:'3000.11.3',platforms:{[devinTarget]:{url:'https://static.devin.ai/cli/3000.11.3/devin.tar.gz',sha256}}},version:'3000.11.3'},
  ...(process.platform==='darwin'?[{id:'kiro' as const,url:'https://prod.download.cli.kiro.dev/stable/latest/manifest.json',body:{version:'2.29.1',packages:[{os:'macos',fileType:'dmg',channel:'stable',download:'2.29.1/Kiro CLI.dmg',sha256}]},version:'2.29.1'}]:[]),
];
test('native Kimi retains its two-component version contract',async()=>{
  const fetcher=mockFetch(url=>{
    expect(url).toBe('https://code.kimi.com/kimi-code/latest');
    return new Response('2.0\n');
  });
  try{expect(await latestCatalogVersion('kimi')).toBe('2.0');}
  finally{fetcher.mockRestore();}
});
function mockFetch(respond:(url:string,init:RequestInit|undefined)=>Response|Promise<Response>) {
  const preconnect=fetch.preconnect;
  const fetcher=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>
    respond(String(input),init),{preconnect}));
  Object.assign(fetcher,{preconnect});
  return fetcher;
}
async function refusal(id:CatalogId,response:Response,detail:string) {
  const fetcher=mockFetch(()=>response);
  try {await expect(latestCatalogVersion(id)).rejects.toMatchObject({name:'AppError',code:'unavailable',detail});}
  finally {fetcher.mockRestore();}
}

test('all thirteen npm recipes query the official latest package, preserving comparable versions',async()=>{
  expect(npmRecipes).toHaveLength(13);
  const fetcher=mockFetch((url,init)=>{
    const name=decodeURIComponent(new URL(url).pathname.slice(1,-'/latest'.length));
    expect(url).toBe(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({name,version:'3.4.5-beta.2'});
  });
  try {
    for(const row of npmRecipes)expect(await latestCatalogVersion(row.id)).toBe('3.4.5-beta.2');
    expect(fetcher).toHaveBeenCalledTimes(13);
  } finally {fetcher.mockRestore();}
});
test('GJC package installs query their registry release rather than the standalone release',async()=>{
  const packageName='@gajae-code/coding-agent';
  const fetcher=mockFetch(url=>{
    expect(url).toBe('https://registry.npmjs.org/%40gajae-code%2Fcoding-agent/latest');
    return Response.json({name:packageName,version:'0.17.2'});
  });
  try{
    expect(await latestCatalogVersion('gjc',{kind:'bun',target:'/home/.bun/install/global',executable:'/home/.bun/bin/gjc',manager:'/bin/bun',packageName,fingerprint:'a'.repeat(64),preserve:[]})).toBe('0.17.2');
  }finally{fetcher.mockRestore();}
});

for(const fixture of fixtures) {
  test(`${fixture.id} uses its installer channel and returns the actual comparable version`,async()=>{
    const preconnect=fetch.preconnect;
    const fetcher=mockFetch((url,init)=>{
      expect(url).toBe(fixture.url);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return typeof fixture.body==='string'?new Response(fixture.body):Response.json(fixture.body);
    });
    try {
      expect(fetch.preconnect).toBe(preconnect);
      expect(await latestCatalogVersion(fixture.id)).toBe(fixture.version);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {fetcher.mockRestore();}
  });
  test(`${fixture.id} refuses non-2xx and invalid metadata`,async()=>{
    await refusal(fixture.id,new Response('not found',{status:404}),'latest_download_failed');
    await refusal(fixture.id,new Response('not a version or JSON'),'latest_response_invalid');
    await refusal(fixture.id,Response.json({version:'1.2.3'}),'latest_response_invalid');
  });
}

test('npm refuses HTTP failure, wrong package identity, invalid JSON and arbitrary version prefixes',async()=>{
  await refusal('omo',new Response('rate limited',{status:429}),'latest_download_failed');
  for(const body of [{name:'other',version:'1.2.3'},{name:'omo-ai',version:123},{name:'omo-ai',version:'release-v1.2.3'},{name:'omo-ai',version:'v1.2.3'},{name:'omo-ai',version:'1.2.3\nextra'}])
    await refusal('omo',Response.json(body),'latest_response_invalid');
  await refusal('omo',new Response('{'),'latest_response_invalid');
});

test('latest metadata rejects invalid semver while preserving valid prerelease and build identifiers',async()=>{
  for(const value of ['2.0.0-..','02.0.0','2.0.0-01','2.0.0+...','2.0.0-alpha_1','2.0','2.0.0\n'])
    await refusal('opencode',Response.json({name:'opencode-ai',version:value}),'latest_response_invalid');
  for(const value of ['2.0.0-alpha.1','2.0.0-0','2.0.0+001.build','2.0.0-beta.2+sha.123']){
    const fetcher=mockFetch(()=>Response.json({name:'opencode-ai',version:value}));
    try{expect(await latestCatalogVersion('opencode')).toBe(value);}
    finally{fetcher.mockRestore();}
  }
});

test('GitHub tags must identify stable releases, not arbitrary tag prefixes',async()=>{
  for(const id of ['gjc','maki'] as const) {
    for(const tag_name of ['release-v1.2.3','v1.2.3-nightly.1','nightly','v1.2.3\n'])
      await refusal(id,Response.json({tag_name,draft:false,prerelease:false}),'latest_response_invalid');
    await refusal(id,Response.json({tag_name:'v1.2.3',draft:false,prerelease:true}),'latest_response_invalid');
    await refusal(id,Response.json({tag_name:'v1.2.3',draft:true,prerelease:false}),'latest_response_invalid');
  }
});

test('Muse and OMP reject a different channel instead of triggering an hourly reinstall',async()=>{
  await refusal('muse',Response.json({channel:'muse-canary',version:'1.4.4-R5419.1',manifest_url:'https://example.com/manifest'}),'latest_response_invalid');
  await refusal('muse',Response.json({channel:'muse-stable',version:'3',manifest_url:'https://example.com/manifest'}),'latest_response_invalid');
  await refusal('omp',Response.json({build:{product:'omp',channel:'nightly',version:'18.9.1'},file:{platform:ompPlatform,arch:ompArch,sha256},download:'https://example.com/omp'}),'latest_response_invalid');
});

test('native manifests must contain the same versioned artifact selected by the runner',async()=>{
  await refusal('devin',Response.json({version:'3000.11.3',platforms:{}}),'latest_artifact_unavailable');
  await refusal('devin',Response.json({version:'3000.11.3',platforms:{[devinTarget]:{url:'https://static.devin.ai/cli/3000.11.2/devin.tar.gz',sha256}}}),'latest_artifact_unavailable');
  if(process.platform==='darwin') {
    for(const artifact of [{os:'linux',fileType:'dmg',channel:'stable',download:'2.29.1/Kiro CLI.dmg',sha256},{os:'macos',fileType:'dmg',channel:'nightly',download:'2.29.1/Kiro CLI.dmg',sha256},{os:'macos',fileType:'dmg',channel:'stable',download:'2.29.0/Kiro CLI.dmg',sha256}])
      await refusal('kiro',Response.json({version:'2.29.1',packages:[artifact]}),'latest_artifact_unavailable');
  }
});

test('response limits apply to advertised lengths and streamed bytes before parsing',async()=>{
  await refusal('omo',new Response('{}',{headers:{'content-length':'1000001'}}),'latest_response_too_large');
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(500_000));controller.enqueue(new Uint8Array(500_001));controller.close();}});
  await refusal('omo',new Response(body),'latest_response_too_large');
  await refusal('omo',Response.json({name:'omo-ai',version:'1.2.3-'+ 'a'.repeat(129)}),'latest_response_invalid');
});

test('network and timeout errors are typed, with no retries or installer execution',async()=>{
  for(const [error,code,detail] of [[new TypeError('network failed'),'unavailable','latest_download_failed'],[new DOMException('timed out','TimeoutError'),'timeout','latest_timeout']] as const) {
    const fetcher=mockFetch(()=>{throw error;});
    try {
      await expect(latestCatalogVersion('omo')).rejects.toMatchObject({name:'AppError',code,detail});
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {fetcher.mockRestore();}
  }
});

test('unsupported update recipes fail closed without making a request',async()=>{
  const fetcher=mockFetch(()=>Response.json({version:'1.2.3'}));
  try {
    for(const id of ['agy','cursor','grok','hermes'] as const)
      await expect(latestCatalogVersion(id)).rejects.toBeInstanceOf(AppError);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {fetcher.mockRestore();}
});
