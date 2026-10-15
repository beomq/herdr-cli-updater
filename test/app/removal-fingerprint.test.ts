import { expect,test } from 'bun:test';
import { closeSync, ftruncateSync, mkdtempSync, openSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { removalFingerprint } from '../../src/app/removal-fingerprint';

test('chunked verification hashes beyond the old 512 MB boundary and detects a tail change',()=>{
  const root=realpathSync(mkdtempSync('/tmp/removal-large-')),path=join(root,'payload'),fd=openSync(path,'wx');
  try{
    ftruncateSync(fd,513_000_000);
    const before=removalFingerprint([path],'fixture');
    writeSync(fd,Buffer.from('changed'),0,7,512_900_000);
    expect(removalFingerprint([path],'fixture')).not.toBe(before);
    ftruncateSync(fd,8*1024*1024*1024+1);
    expect(()=>removalFingerprint([path],'fixture')).toThrow('removal_scan_limit');
  }finally{closeSync(fd);rmSync(root,{recursive:true,force:true});}
});
