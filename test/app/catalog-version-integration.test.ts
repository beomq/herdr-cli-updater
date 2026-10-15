import { expect,test } from 'bun:test';
import { chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppStore } from '../../src/app/store';
import { createCatalog } from '../../src/app/catalog';
test('native PATH installation reports its current disk version without an install recipe',async()=>{
  const root=realpathSync(mkdtempSync('/tmp/catalog-native-version-'));
  const bin=join(root,'bin');mkdirSync(bin);const executable=join(bin,'codex');
  writeFileSync(executable,'#!/bin/sh\nprintf "1.2.12\\n"\n');chmodSync(executable,0o755);
  const store=new AppStore(root);const catalog=createCatalog({directory:root,home:root,path:bin,store,changed:()=>{}});
  try{
    expect(catalog.entries().find(row=>row.id==='codex')?.inventoryStatus).toBe('checking');
    await catalog.settled();
    expect(catalog.entries().find(row=>row.id==='codex')?.installed).toMatchObject({version:'1.2.12',versionStatus:'known',managed:false,lastVerifiedVersion:null});
  }finally{await catalog.settled();store.close();rmSync(root,{recursive:true,force:true});}
});
