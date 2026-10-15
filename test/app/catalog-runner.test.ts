import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { executeRecipe, runProcess, verifyExecutable } from '../../src/app/catalog-runner';

test('runner preserves argv boundaries rather than executing shell input',async()=>{
  const text=await runProcess('/usr/bin/printf',['%s','$(touch /tmp/not-executed); literal'],{PATH:'/usr/bin:/bin'},'/tmp',3000);
  expect(text).toBe('$(touch /tmp/not-executed); literal');
});
test('installer refuses an existing target before starting a package manager',async()=>{
  const root=realpathSync(mkdtempSync('/tmp/catalog-runner-'));
  try{await expect(executeRecipe({kind:'npm',package:'never-install-fixture',bin:'bin/fixture'},{home:root,path:'',target:root},()=>{})).rejects.toThrow('install_target_exists');}
  finally{rmSync(root,{recursive:true,force:true});}
});
test('verification requires a real executable and an actual version response',async()=>{
  const root=realpathSync(mkdtempSync('/tmp/catalog-verify-'));
  try{
    const binary=join(root,'bun');copyFileSync(process.execPath,binary);
    expect(await verifyExecutable(binary,{home:root,path:'/usr/bin:/bin',target:root})).toMatch(/^\d+\.\d+/);
    await expect(verifyExecutable(process.execPath,{home:root,path:'/usr/bin:/bin',target:root})).rejects.toThrow('installed_executable_outside_target');
    await expect(verifyExecutable(join(root,'missing'),{home:root,path:'',target:root})).rejects.toThrow('installed_executable_missing');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('official script target arguments remain one argv value and HOME stays isolated',async()=>{
  const root=realpathSync(mkdtempSync('/tmp/catalog-script-'));
  const target=join(root,'install with spaces');
  const events:string[]=[];
  const fetcher=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async()=>{
    const response=new Response('printf "%s\\n%s" "$1" "$HOME" > "$1/result"\nprintf "Authorization: secret-test-token\\nchecksum_verified\\n"');
    Object.defineProperty(response,'url',{value:'https://official.example/install.sh'});return response;
  },{preconnect:fetch.preconnect}));
  try{
    await executeRecipe({kind:'script',url:'https://official.example/install.sh',bin:'result',env:{},args:['$TARGET']},{home:root,path:'/usr/bin:/bin',target},event=>events.push(event));
    expect(readFileSync(join(target,'result'),'utf8')).toBe(`${target}\n${join(target,'.installer-home')}`);
    expect(events.slice(0,3)).toEqual(['download_started','download_complete','installer_started']);
    expect(events.length).toBeGreaterThan(3);
    expect(events.slice(3).every(event=>event==='installer_output_received')).toBe(true);
  }finally{fetcher.mockRestore();rmSync(root,{recursive:true,force:true});}
});

test('Devin bundle checksum failure prevents extraction and setup',async()=>{
  const root=realpathSync(mkdtempSync('/tmp/catalog-bundle-'));
  const target=join(root,'install');
  const platform=`${process.arch==='arm64'?'aarch64':'x86_64'}-${process.platform==='darwin'?'apple-darwin':'unknown-linux'}`;
  const fetcher=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async(url:Parameters<typeof fetch>[0])=>String(url).endsWith('manifest.json')
    ?Response.json({platforms:{[platform]:{url:'https://static.devin.ai/cli/test.tar.gz',sha256:'0'.repeat(64)}}})
    :new Response('wrong archive'),{preconnect:fetch.preconnect}));
  try{
    await expect(executeRecipe({kind:'devin-bundle',bin:'bundle/bin/devin'},{home:root,path:'/usr/bin:/bin',target},()=>{})).rejects.toThrow('installer_checksum_mismatch');
    expect(existsSync(join(target,'bundle'))).toBe(false);
  }finally{fetcher.mockRestore();rmSync(root,{recursive:true,force:true});}
});
