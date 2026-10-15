import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { catalogDefinitions } from '../../src/app/catalog-registry';
import { discoverRemoval, executeRemoval, removalTargetSchema, validateRemoval } from '../../src/app/catalog-removal-target';
import { findExecutable } from '../../src/app/catalog-runner';
import type { InstallJob } from '../../src/app/catalog-types';

function fixture(){
  const home=realpathSync(mkdtempSync('/tmp/catalog-removal-'));
  const path=process.env['PATH']??'/usr/bin:/bin';
  function file(path:string,text:string){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
  function pkg(container:string,name:string,bin:string){const root=join(container,'node_modules',name);file(join(root,'package.json'),JSON.stringify({name,version:'1.0.0',bin:{[bin]:'cli.js'}}));file(join(root,'cli.js'),'#!/usr/bin/env node\n');chmodSync(join(root,'cli.js'),0o755);return root;}
  return {home,path,file,pkg,close:()=>rmSync(home,{recursive:true,force:true})};
}
function owned(f:ReturnType<typeof fixture>,catalogId:'codex'|'maki'='maki') {
  const definition=catalogDefinitions.find(row=>row.id===catalogId);if(!definition?.recipe)throw new Error('fixture_recipe_missing');
  const id='11111111-1111-4111-8111-111111111111';const directory=join(f.home,'state');
  const target=join(directory,'cli-installs',`${catalogId}-${id}`);const executable=join(target,definition.recipe.bin);
  f.file(executable,'binary fixture');
  if(catalogId==='codex'){unlinkSync(executable);const root=f.pkg(join(target,'lib'),'@openai/codex','codex');symlinkSync(join(root,'cli.js'),executable);}
  f.file(join(target,'.installer-home/.config/auth'),'credential');f.file(join(target,'.verification-home/history'),'history');f.file(join(target,'notes'),'user notes');
  const receipt:InstallJob={id,requestId:'fixture',catalogId,revision:1,stage:'completed',sourceUrl:definition.sourceUrl,method:definition.method,target,recipeHash:createHash('sha256').update(JSON.stringify(definition.recipe)).digest('hex'),createdAt:0,updatedAt:0,installedVersion:'1.0.0',executablePath:executable,failure:null,log:[]};
  return {directory,target,executable,receipt,catalogId,home:f.home,path:f.path};
}
test('owned removal archives only payload and preserves both homes and unknown data',async()=>{
  for(const id of ['maki','codex'] as const){const f=fixture();try{const options=owned(f,id);const target=await discoverRemoval(options);expect(target?.kind).toBe('owned');if(!target)throw new Error('missing_target');
    expect(removalTargetSchema.parse(target)).toEqual(target);validateRemoval(target);await executeRemoval(target,options);
    expect(existsSync(options.executable)).toBe(false);expect(existsSync(join(options.target,'.removed-payload'))).toBe(true);
    expect(readFileSync(join(options.target,'.installer-home/.config/auth'),'utf8')).toBe('credential');expect(readFileSync(join(options.target,'.verification-home/history'),'utf8')).toBe('history');expect(readFileSync(join(options.target,'notes'),'utf8')).toBe('user notes');
  }finally{f.close();}}
});
test('owned discovery rejects changed receipts and symlink escapes; execution rejects changed payload',async()=>{
  const f=fixture();try{const options=owned(f);expect(await discoverRemoval({...options,receipt:{...options.receipt,target:f.home}})).toBeNull();
    expect(await discoverRemoval({...options,receipt:{...options.receipt,recipeHash:'changed'}})).toBeNull();const target=await discoverRemoval(options);if(!target)throw new Error('missing_target');
    f.file(options.executable,'changed');expect(()=>validateRemoval(target)).toThrow('removal_target_changed');await expect(executeRemoval(target,options)).rejects.toThrow('removal_target_changed');
    unlinkSync(options.executable);symlinkSync(process.execPath,options.executable);expect(await discoverRemoval(options)).toBeNull();
    unlinkSync(options.executable);symlinkSync(join(options.target,'.installer-home/.config/auth'),options.executable);expect(await discoverRemoval(options)).toBeNull();
  }finally{f.close();}
});
test('actual isolated npm removal preserves other package and credentials and detects package or link changes',async()=>{
  const f=fixture();try{
    const npm=findExecutable('npm',f.path);expect(npm).not.toBeNull();if(!npm)throw new Error('npm_required_for_isolated_test');
    const prefix=join(f.home,'prefix'),container=join(prefix,'lib');const root=f.pkg(container,'@openai/codex','codex');f.pkg(container,'unrelated','unrelated');
    const executable=join(prefix,'bin/codex');mkdirSync(dirname(executable),{recursive:true});symlinkSync(join(root,'cli.js'),executable);f.file(join(f.home,'.npmrc'),'//example.invalid/:_authToken=fixture-secret\n');
    const options={catalogId:'codex' as const,executable,receipt:null,directory:join(f.home,'state'),home:f.home,path:f.path};
    const target=await discoverRemoval(options);expect(target?.kind).toBe('npm');if(!target)throw new Error('missing_target');
    f.file(join(root,'cli.js'),'changed package');expect(()=>validateRemoval(target)).toThrow();
    const changed=await discoverRemoval(options);if(!changed)throw new Error('missing_changed_target');unlinkSync(executable);symlinkSync(join(root,'package.json'),executable);expect(()=>validateRemoval(changed)).toThrow();expect(await discoverRemoval(options)).toBeNull();
    unlinkSync(executable);symlinkSync(join(root,'cli.js'),executable);const current=await discoverRemoval(options);if(!current)throw new Error('missing_current_target');await executeRemoval(current,options);
    expect(existsSync(root)).toBe(false);expect(existsSync(executable)).toBe(false);expect(existsSync(join(container,'node_modules/unrelated/package.json'))).toBe(true);expect(readFileSync(join(f.home,'.npmrc'),'utf8')).toContain('fixture-secret');
  }finally{f.close();}
});
test('rejects workspace/linked package and uncertain npm manager',async()=>{
  const f=fixture();try{const project=join(f.home,'app');const root=f.pkg(project,'@openai/codex','codex');const executable=join(f.home,'bin/codex');mkdirSync(dirname(executable),{recursive:true});symlinkSync(join(root,'cli.js'),executable);
    const options={catalogId:'codex' as const,executable,receipt:null,directory:f.home,home:f.home,path:f.path};expect(await discoverRemoval(options)).toBeNull();
    const lib=join(f.home,'prefix/lib');mkdirSync(join(lib,'node_modules/@openai'),{recursive:true});symlinkSync(root,join(lib,'node_modules/@openai/codex'));expect(await discoverRemoval(options)).toBeNull();
    rmSync(join(lib,'node_modules/@openai/codex'));const real=f.pkg(lib,'@openai/codex','codex');const bin=join(f.home,'prefix/bin/codex');mkdirSync(dirname(bin),{recursive:true});symlinkSync(join(real,'cli.js'),bin);expect(await discoverRemoval({...options,executable:bin,path:''})).toBeNull();
  }finally{f.close();}
});
test('Bun requires known global direct dependency lock and actual bound manager',async()=>{
  const f=fixture();try{const container=join(f.home,'.bun/install/global');const root=f.pkg(container,'@openai/codex','codex');const executable=join(f.home,'.bun/bin/codex'),manager=join(f.home,'.bun/bin/bun');mkdirSync(dirname(executable),{recursive:true});symlinkSync(join(root,'cli.js'),executable);copyFileSync(process.execPath,manager);chmodSync(manager,0o755);
    f.file(join(container,'package.json'),JSON.stringify({dependencies:{'@openai/codex':'1.0.0'}}));f.file(join(container,'bun.lock'),JSON.stringify({workspaces:{'':{dependencies:{'@openai/codex':'1.0.0'}}},packages:{'@openai/codex':['@openai/codex@1.0.0']}}));
    const options={catalogId:'codex' as const,executable,receipt:null,directory:f.home,home:f.home,path:dirname(manager)};const target=await discoverRemoval(options);expect(target?.kind).toBe('bun');if(!target)throw new Error('missing_bun_target');validateRemoval(target);
    f.file(manager,'manager changed');expect(()=>validateRemoval(target)).toThrow();expect(await discoverRemoval({...options,path:''})).toBeNull();
    f.file(join(container,'package.json'),JSON.stringify({dependencies:{'@openai/codex':'link:../workspace'}}));expect(await discoverRemoval(options)).toBeNull();
  }finally{f.close();}
});
test('a transitive Bun dependency reports its ownership limitation rather than generic discovery failure',async()=>{
  const f=fixture();try{
    const container=join(f.home,'.bun/install/global'),root=f.pkg(container,'@code-yeongyu/senpi','pi');
    f.file(join(container,'package.json'),JSON.stringify({dependencies:{'omo-ai':'1.0.0'}}));
    const reasons:string[]=[];
    expect(await discoverRemoval({catalogId:'pi',executable:join(root,'cli.js'),receipt:null,directory:f.home,home:f.home,path:f.path,refusal:value=>{reasons.push(value);}})).toBeNull();
    expect(reasons).toEqual(['removal_dependency_installation']);
  }finally{f.close();}
});
test('actual isolated Bun removal is bound to BUN_INSTALL and preserves other dependencies',async()=>{
  const f=fixture();try{
    const container=join(f.home,'.bun/install/global');const root=f.pkg(container,'@openai/codex','codex');f.pkg(container,'unrelated','unrelated');
    const executable=join(f.home,'.bun/bin/codex');mkdirSync(dirname(executable),{recursive:true});symlinkSync(join(root,'cli.js'),executable);
    f.file(join(container,'package.json'),JSON.stringify({dependencies:{'@openai/codex':'1.0.0',unrelated:'1.0.0'}}));
    f.file(join(container,'bun.lock'),JSON.stringify({lockfileVersion:1,workspaces:{'':{dependencies:{'@openai/codex':'1.0.0',unrelated:'1.0.0'}}},packages:{'@openai/codex':['@openai/codex@1.0.0','',{},''],unrelated:['unrelated@1.0.0','',{},'']}}));
    f.file(join(f.home,'.config/credential'),'secret');const options={catalogId:'codex' as const,executable,receipt:null,directory:f.home,home:f.home,path:dirname(process.execPath)};
    const target=await discoverRemoval(options);expect(target?.kind).toBe('bun');if(!target)throw new Error('missing_actual_bun_target');await executeRemoval(target,options);
    expect(existsSync(root)).toBe(false);expect(existsSync(executable)).toBe(false);expect(existsSync(join(container,'node_modules/unrelated/package.json'))).toBe(true);expect(readFileSync(join(f.home,'.config/credential'),'utf8')).toBe('secret');
  }finally{f.close();}
});
