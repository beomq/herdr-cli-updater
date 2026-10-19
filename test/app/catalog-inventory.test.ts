import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { catalogDefinitions } from '../../src/app/catalog-registry';
import { discoverCatalogInstallations, installationId } from '../../src/app/catalog-inventory';
import type { InstallJob } from '../../src/app/catalog-types';
import type { runProcess } from '../../src/app/catalog-runner';
import { AppError } from '../../src/app/types';

function fixture() {
  const root=realpathSync(mkdtempSync('/tmp/catalog-inventory-'));
  const home=join(root,'home'),directory=join(root,'app');mkdirSync(home);mkdirSync(directory);
  function file(path:string,text='#!/bin/sh\nexit 99\n'):string {
    mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);chmodSync(path,0o755);return path;
  }
  function link(target:string,path:string):string {mkdirSync(dirname(path),{recursive:true});symlinkSync(target,path);return path;}
  function pkg(prefix:string,name='@openai/codex',bin='codex',version='1.0.0',payload?:string):string {
    const packageRoot=join(prefix,'lib/node_modules',name);
    file(join(packageRoot,'package.json'),JSON.stringify({name,version,bin:{[bin]:'cli.js'}}));
    const entry=payload?link(payload,join(packageRoot,'cli.js')):file(join(packageRoot,'cli.js'));
    return link(entry,join(prefix,'bin',bin));
  }
  const noRun:typeof runProcess=async()=>{throw new Error('unexpected package-manager process');};
  return {root,home,directory,file,link,pkg,noRun,close:()=>rmSync(root,{recursive:true,force:true})};
}

test('Pi inventory excludes Senpi even when its pi alias wins PATH and keeps upstream distinct',async()=>{
  const f=fixture();try {
    const senpi=join(f.root,'senpi'),upstream=join(f.root,'upstream');
    f.pkg(senpi,'@code-yeongyu/senpi','pi');
    f.pkg(upstream,'@earendil-works/pi-coding-agent','pi','1.2.0');
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:`${senpi}/bin:${upstream}/bin`,receipts:[]},{run:f.noRun});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({catalogId:'pi',packageName:'@earendil-works/pi-coding-agent',version:'1.2.0',isDefault:false});
  }finally{f.close();}
});

test('collects distinct npm prefixes and nvm versions while collapsing proven PATH aliases',async()=>{
  // Given: two roots share payload, a third nvm installation is not on PATH.
  const f=fixture();try {
    const a=join(f.root,'a'),b=join(f.root,'b'),nvm=join(f.home,'.nvm/versions/node/v22.0.0');
    const payload=f.file(join(f.root,'payload/codex'));
    const aBin=f.pkg(a,'@openai/codex','codex','1.0.0',payload);f.pkg(b,'@openai/codex','codex','1.0.0',payload);f.pkg(nvm);
    f.link(aBin,join(f.root,'aliases/codex'));
    f.link(a,join(f.root,'prefix-alias'));
    // When
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:`${b}/bin:${a}/bin:${f.root}/aliases`,receipts:[],prefixes:[a,b,a,join(f.root,'prefix-alias')]}, {run:f.noRun});
    // Then
    expect(rows).toHaveLength(3);expect(rows.every(row=>row.manager==='npm')).toBe(true);
    expect(new Set(rows.map(row=>row.root))).toEqual(new Set([a,b,nvm]));
    expect(rows.filter(row=>row.isDefault).map(row=>row.root)).toEqual([b]);
    // Every copy reachable through PATH is marked, not only the first one.
    expect(rows.filter(row=>row.onPath).map(row=>row.root).sort()).toEqual([a,b].sort());
    expect(rows.find(row=>row.root===nvm)?.onPath).toBe(false);
  }finally{f.close();}
});
test('multiple entry scripts from one package remain one installation',async()=>{
  const f=fixture();
  try{
    const root=join(f.home,'.bun/install/global/node_modules/@gajae-code/coding-agent');
    f.file(join(root,'package.json'),JSON.stringify({name:'@gajae-code/coding-agent',version:'1.0.0',bin:{가재씨:'alias.js',gjc:'cli.js'}}));
    f.link(f.file(join(root,'alias.js')),join(f.home,'.bun/bin/가재씨'));
    f.link(f.file(join(root,'cli.js')),join(f.home,'.bun/bin/gjc'));
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:join(f.home,'.bun/bin'),receipts:[]},{run:f.noRun});
    expect(rows).toHaveLength(1);expect(rows[0]?.path).toBe(join(f.home,'.bun/bin/gjc'));
  }finally{f.close();}
});
test('reads large installed Brew metadata through a real bounded child process',async()=>{
  const f=fixture();
  try{
    const prefix=join(f.root,'brew');
    f.link(f.file(join(prefix,'Cellar/codex/1.0.0/bin/codex')),join(prefix,'bin/codex'));
    const metadata={formulae:[{name:'codex',full_name:'codex',installed:[{version:'1.0.0'}]}],casks:[],padding:'x'.repeat(300000)};
    f.file(join(prefix,'bin/brew'),`#!${process.execPath}\nconsole.log(process.argv[2]==='--prefix'?${JSON.stringify(prefix)}:JSON.stringify(${JSON.stringify(metadata)}));\n`);
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:join(prefix,'bin'),receipts:[]});
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({manager:'brew',catalogId:'codex',version:'1.0.0'});
  }finally{f.close();}
});

test('collects every valid owned receipt separately from external installations and omits stale receipts',async()=>{
  // Given
  const f=fixture();try {
    const definition=catalogDefinitions.find(row=>row.id==='codex');if(!definition?.recipe)throw new Error('missing fixture recipe');
    const receipts:InstallJob[]=[];
    for(const id of ['first','second','missing','stale']) {
      const target=join(f.directory,'cli-installs',`codex-${id}`),path=join(target,definition.recipe.bin);
      if(id!=='missing')f.file(path);
      receipts.push({id,requestId:id,catalogId:'codex',revision:0,stage:'completed',sourceUrl:definition.sourceUrl,method:definition.method,target,
        recipeHash:id==='stale'?'obsolete':createHash('sha256').update(JSON.stringify(definition.recipe)).digest('hex'),createdAt:0,updatedAt:0,
        installedVersion:'1.2.3',executablePath:path,failure:null,log:[]});
    }
    const external=join(f.root,'external');f.pkg(external);
    // When
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:`${external}/bin`,receipts},{run:f.noRun});
    // Then
    expect(rows.filter(row=>row.manager==='owned').map(row=>row.receiptId)).toEqual(['first','second']);
    expect(rows.filter(row=>row.manager==='owned').map(row=>row.version)).toEqual([null,null]);
    expect(rows.filter(row=>row.manager==='npm')).toHaveLength(1);
    expect(rows.filter(row=>row.isDefault).map(row=>row.manager)).toEqual(['npm']);
  }finally{f.close();}
});

test('attributes generic agent to Grok metadata and excludes unproven agents and Gemini',async()=>{
  // Given
  const f=fixture();try {
    const grok=join(f.root,'grok');f.pkg(grok,'@xai-official/grok','agent');
    const gemini=join(f.root,'gemini');f.pkg(gemini,'@google/gemini-cli','codex');
    f.file(join(f.root,'bare/agent'));
    const cursor=f.file(join(f.root,'cursor-agent/versions/1/cursor-agent'));f.link(cursor,join(f.root,'cursor/agent'));
    // When
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:`${grok}/bin:${gemini}/bin:${f.root}/bare:${f.root}/cursor`,receipts:[]},{run:f.noRun});
    // Then
    expect(rows.map(row=>[row.catalogId,row.manager])).toEqual([['grok','npm'],['cursor','unknown']]);
    expect(rows.find(row=>row.catalogId==='cursor')?.version).toBeNull();
    expect(rows.find(row=>row.catalogId==='cursor')?.isDefault).toBe(false);
  }finally{f.close();}
});

test('collapses unknown symlink aliases without claiming package manager ownership',async()=>{
  // Given
  const f=fixture();try {
    const target=f.file(join(f.root,'native/codex'));f.link(target,join(f.root,'first/codex'));f.link(target,join(f.root,'second/codex'));
    // When
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:`${f.root}/first:${f.root}/second`,receipts:[]},{run:f.noRun});
    // Then
    expect(rows).toHaveLength(1);expect(rows[0]?.manager).toBe('unknown');expect(rows[0]?.isDefault).toBe(true);
    expect(rows[0]?.packageName).toBeNull();expect(rows[0]?.version).toBeNull();
  }finally{f.close();}
});

test('reads default Bun packages and canonical OmO launcher identity',async()=>{
  // Given
  const f=fixture();try {
    const packageRoot=join(f.home,'.bun/install/global/node_modules/omo-ai');
    f.file(join(packageRoot,'package.json'),JSON.stringify({name:'omo-ai',version:'2.0.0',bin:{omo:'bin/omo.js'}}));
    const entry=f.file(join(packageRoot,'bin/omo.js'));
    const runtime=join(f.root,'bun');
    const shim=`#!/bin/sh\n# omo-ai bun launcher shim v1 - generated by omo-ai; safe to delete, the next launch recreates it\n# entry: ${entry}\nif [ "$OMO_RUNTIME" != "node" ] && [ -x '${runtime}' ]; then exec '${runtime}' '${entry}' "$@"; fi\nexec '${entry}' "$@"\n`;
    f.file(join(f.home,'.bun/bin/omo'),shim);
    // When
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:join(f.home,'.bun/bin'),receipts:[]},{run:f.noRun});
    // Then
    expect(rows).toHaveLength(1);expect(rows[0]?.manager).toBe('bun');expect(rows[0]?.identityPath).toBe(entry);
    expect(rows[0]?.isDefault).toBe(true);expect(rows[0]?.version).toBe('2.0.0');
  }finally{f.close();}
});

test('treats the Bun global node_modules/.bin OmO launcher as the same installation, never an arbitrary script',async()=>{
  // Given
  const f=fixture();try {
    const packageRoot=join(f.home,'.bun/install/global/node_modules/omo-ai');
    f.file(join(packageRoot,'package.json'),JSON.stringify({name:'omo-ai',version:'2.0.0',bin:{omo:'bin/omo.js'}}));
    const entry=f.file(join(packageRoot,'bin/omo.js'));
    const runtime=join(f.root,'bun');
    const shim=`#!/bin/sh\n# omo-ai bun launcher shim v1 - generated by omo-ai; safe to delete, the next launch recreates it\n# entry: ${entry}\nif [ "$OMO_RUNTIME" != "node" ] && [ -x '${runtime}' ]; then exec '${runtime}' '${entry}' "$@"; fi\nexec '${entry}' "$@"\n`;
    const nodeBin=join(f.home,'.bun/install/global/node_modules/.bin');
    f.file(join(f.home,'.bun/bin/omo'),shim);f.file(join(nodeBin,'omo'),shim);
    const path=`${nodeBin}:${join(f.home,'.bun/bin')}`;
    // When
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path,receipts:[]},{run:f.noRun});
    // Then: the PATH-first .bin launcher collapses into the Bun row, which becomes the default.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({manager:'bun',path:join(f.home,'.bun/bin/omo'),identityPath:entry,isDefault:true});
    // Given: a script at the same path that launches something else
    f.file(join(nodeBin,'omo'),`#!/bin/sh\nexec "${join(f.root,'other/omo.js')}" "$@"\n`);
    // When
    const other=await discoverCatalogInstallations({home:f.home,directory:f.directory,path,receipts:[]},{run:f.noRun});
    // Then: it stays a separate unknown PATH candidate
    expect(other.map(row=>row.manager).sort()).toEqual(['bun','unknown']);
    expect(other.find(row=>row.manager==='bun')?.isDefault).toBe(false);
  }finally{f.close();}
});

test('uses bounded read-only manager metadata and stable linked brew paths without bundled app assistants',async()=>{
  // Given
  const f=fixture();try {
    const prefix=join(f.root,'brew');f.file(join(prefix,'bin/brew'));f.file(join(prefix,'bin/npm'));
    const codex=f.file(join(prefix,'Cellar/codex/1.0_2/bin/codex'));f.link(codex,join(prefix,'bin/codex'));
    const opencode=f.file(join(prefix,'Caskroom/opencode/2/bin/opencode'));f.link(opencode,join(prefix,'bin/opencode'));
    f.file(join(prefix,'Caskroom/chatgpt/1/ChatGPT.app/Contents/MacOS/codex'));
    const configured=join(f.root,'configured');f.pkg(configured,'@github/copilot','copilot');
    const observed:string[][]=[];
    const run:typeof runProcess=async(_manager,args,env,_cwd,timeout)=>{
      observed.push([...args]);expect(timeout).toBe(15_000);expect(env['HOMEBREW_NO_AUTO_UPDATE']).toBe('1');expect(env['HOMEBREW_NO_ANALYTICS']).toBe('1');
      if(args[0]==='prefix')return configured;
      if(args[0]==='--prefix')return prefix;
      return JSON.stringify({formulae:[{name:'codex',full_name:'custom/tap/codex',installed:[{version:'1.0',revision:2}]}],
        casks:[{token:'opencode',installed:'2'},{token:'chatgpt',installed:'1'}]});
    };
    // When
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:`${prefix}/bin`,receipts:[]},{run});
    // Then
    expect(rows.map(row=>[row.catalogId,row.manager,row.packageName])).toEqual([
      ['copilot','npm','@github/copilot'],['codex','brew','custom/tap/codex'],['opencode','brew','opencode']]);
    expect(rows.find(row=>row.catalogId==='codex')?.path).toBe(join(prefix,'bin/codex'));
    expect(rows.find(row=>row.catalogId==='codex')?.version).toBe('1.0_2');
    expect(observed).toEqual([['prefix','--global'],['--prefix'],['info','--json=v2','--installed']]);
  }finally{f.close();}
});

test('installation IDs use stable manager roots rather than versioned resolved payloads',()=>{
  // Given
  const root='/prefix',path='/prefix/bin/codex';
  // When
  const id=installationId('codex','brew',root,'codex',path);
  // Then
  expect(id).toBe(installationId('codex','brew',root,'codex',path));
  expect(id).not.toBe(installationId('codex','brew','/other','codex','/other/bin/codex'));
});

test('reads owned current disk package version instead of historical receipt version',async()=>{
  // Given
  const f=fixture();try {
    const definition=catalogDefinitions.find(row=>row.id==='codex');if(!definition?.recipe)throw new Error('missing fixture recipe');
    const target=join(f.directory,'cli-installs/codex-current');const path=f.pkg(target,'@openai/codex','codex','4.0.0');
    const receipt:InstallJob={id:'current',requestId:'current',catalogId:'codex',revision:0,stage:'completed',sourceUrl:definition.sourceUrl,
      method:definition.method,target,recipeHash:createHash('sha256').update(JSON.stringify(definition.recipe)).digest('hex'),createdAt:0,updatedAt:0,
      installedVersion:'1.0.0',executablePath:path,failure:null,log:[]};
    // When
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:join(target,'bin'),receipts:[receipt]},{run:f.noRun});
    // Then
    expect(rows).toHaveLength(1);expect(rows.find(row=>row.manager==='owned')?.version).toBe('4.0.0');
  }finally{f.close();}
});

test('selects the linked installed brew revision and keeps its ID independent of Cellar upgrades',async()=>{
  // Given: old and current versions both appear in installed metadata.
  const f=fixture();try {
    const prefix=join(f.root,'brew');f.file(join(prefix,'bin/brew'));
    const path=join(prefix,'bin/codex');f.link(f.file(join(prefix,'Cellar/codex/2.0_3/bin/codex')),path);
    const previousId=installationId('codex','brew',prefix,'codex',path);
    const run:typeof runProcess=async(_manager,args)=>args[0]==='--prefix'?prefix:JSON.stringify({
      formulae:[{name:'codex',full_name:'codex',installed:[{version:'1.0'},{version:'2.0',revision:3}]}],casks:[]});
    // When
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:join(prefix,'bin'),receipts:[]},{run});
    // Then
    expect(rows).toHaveLength(1);expect(rows[0]?.version).toBe('2.0_3');expect(rows[0]?.id).toBe(previousId);
  }finally{f.close();}
});

test('keeps PATH candidates unknown when brew detection fails rather than inventing identity',async()=>{
  // Given
  const f=fixture();try {
    const prefix=join(f.root,'brew');f.file(join(prefix,'bin/brew'));
    f.link(f.file(join(prefix,'Cellar/codex/1.0/bin/codex')),join(prefix,'bin/codex'));
    const run:typeof runProcess=async()=>{throw new AppError('unavailable','installer_exit_1');};
    // When
    const rows=await discoverCatalogInstallations({home:f.home,directory:f.directory,path:join(prefix,'bin'),receipts:[]},{run});
    // Then
    expect(rows).toHaveLength(1);expect(rows[0]?.manager).toBe('unknown');expect(rows[0]?.version).toBeNull();
  }finally{f.close();}
});
