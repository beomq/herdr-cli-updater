import {beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const installer=resolve('site/dist/install.sh');
const archive=resolve('site/dist/downloads/herdr-cli-updater-0.1.0.tgz');
beforeAll(async()=>{
  const build=Bun.spawn(['bun','run','build:site'],{cwd:resolve('.'),stdout:'pipe',stderr:'pipe'});
  const [code,,stderr]=await Promise.all([build.exited,new Response(build.stdout).text(),new Response(build.stderr).text()]);
  expect(code,stderr).toBe(0);
},120_000);
test('seven supported catalog logos comply with the production image CSP',()=>{
  const html=readFileSync(resolve('site/dist/clis/index.html'),'utf8');
  const labels=[...html.matchAll(/<svg[^>]*aria-label="([^"]+)"/g)].map(match=>match[1]);
  expect([...new Set(labels)].sort()).toEqual(['claude','codex','gjc','omo','omp','opencode','pi'].sort());
  const sources=[...html.matchAll(/<image[^>]*href="([^"]+)"/g)].map(match=>match[1]);
  for(const source of sources){
    if(!source)throw new Error('missing image source');
    expect(source).toMatch(/^\/assets\/agent-[a-z]+-[a-f0-9]{12}\.png$/);
    const bytes=readFileSync(resolve('site/dist',source.slice(1)));
    expect([...bytes.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
  }
  const config=JSON.parse(readFileSync(resolve('site/dist/vercel.json'),'utf8'));
  expect(config.headers[0].headers.find((header:{key:string})=>header.key==='Content-Security-Policy').value).toContain("img-src 'self';");
});
test('installer installs the real archive, preserves current on bad checksum and refuses another launcher',async()=>{
  const home=mkdtempSync(join(tmpdir(),'updater-installer-'));
  const tools=join(home,'tools');mkdirSync(tools);
  // Replace transport only; install and entrypoint use real Bun and the real packed app.
  writeFileSync(join(tools,'curl'),'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; cp "$QA_ARCHIVE" "$1"; exit 0; fi; shift; done\nexit 2\n',{mode:0o755});
  const run=async(command:string[],env:Record<string,string|undefined>)=>{
    const child=Bun.spawn(command,{env,cwd:home,stdout:'pipe',stderr:'pipe'});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    return {code,stdout,stderr};
  };
  const env={...process.env,HOME:home,PATH:tools+':'+process.env['PATH'],QA_ARCHIVE:archive};
  try{
    const result=await run(['/bin/sh',installer],env);
    expect(result.code,{...result}.stderr).toBe(0);
    const cli=join(home,'.local/bin/cli-updater');
    expect(await run([cli,'--version'],env)).toMatchObject({code:0,stdout:'0.1.0\n'});
    const status=await run([cli,'status'],env);
    expect(status.code).toBe(0);expect(JSON.parse(status.stdout)).toEqual({running:false});
    const bad=join(home,'bad.tgz');writeFileSync(bad,'not the expected archive');
    expect((await run(['/bin/sh',installer],{...env,QA_ARCHIVE:bad})).code).not.toBe(0);
    expect((await run([cli,'--version'],env)).code).toBe(0);
    expect(readdirSync(join(home,'.local/share/cli-updater-app/releases'))).toHaveLength(1);
    rmSync(cli);writeFileSync(cli,'owned-by-another-tool');
    expect((await run(['/bin/sh',installer],env)).code).not.toBe(0);
    expect(readFileSync(cli,'utf8')).toBe('owned-by-another-tool');
  }finally{rmSync(home,{recursive:true,force:true});}
},120_000);

test.each([['MINGW64_NT','x86_64'],['Linux','i686']])('installer rejects unsupported host %s %s before creating app files',async(os,arch)=>{
  const home=mkdtempSync(join(tmpdir(),'updater-os-'));
  const tools=join(home,'tools');mkdirSync(tools);
  writeFileSync(join(tools,'uname'),`#!/bin/sh\ncase "$1" in -s) printf '%s\\n' '${os}' ;; -m) printf '%s\\n' '${arch}' ;; esac\n`,{mode:0o755});
  try{
    const child=Bun.spawn(['/bin/sh',installer],{env:{HOME:home,PATH:tools},stdout:'pipe',stderr:'pipe'});
    const [code]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(readdirSync(home)).toEqual(['tools']);
  }finally{rmSync(home,{recursive:true,force:true});}
});
