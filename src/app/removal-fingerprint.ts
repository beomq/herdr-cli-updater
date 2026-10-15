import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { AppError } from './types';
import type { Stats } from 'node:fs';

/** Bounded memory; retain full content hashes and before/after identity checks. */
export function removalFingerprint(paths:readonly string[],binding:string):string {
  const hash=createHash('sha256').update(binding),buffer=Buffer.allocUnsafe(1024*1024);
  const deadline=performance.now()+30_000;
  let count=0,total=0;
  const changed=():never=>{throw new AppError('source_changed','removal_target_changed');};
  const limit=():never=>{throw new AppError('unavailable','removal_scan_limit');};
  const stamp=(s:Stats)=>JSON.stringify([s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeMs,s.ctimeMs]);
  function content(path:string):void {
    const before=lstatSync(path);
    if(!before.isFile())changed();
    total+=before.size;if(total>8*1024*1024*1024)limit();
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      if(stamp(fstatSync(fd))!==stamp(before))changed();
      let offset=0;
      while(offset<before.size){
        if(performance.now()>deadline)limit();
        const size=readSync(fd,buffer,0,Math.min(buffer.length,before.size-offset),offset);
        if(size===0)changed();hash.update(buffer.subarray(0,size));offset+=size;
      }
      if(stamp(fstatSync(fd))!==stamp(before)||stamp(lstatSync(path))!==stamp(before))changed();
    }finally{closeSync(fd);}
  }
  function visit(path:string):void {
    if(++count>100_000||performance.now()>deadline)limit();
    const before=lstatSync(path);hash.update(path).update(stamp(before));
    if(before.isSymbolicLink()){
      const link=readlinkSync(path),resolved=realpathSync(path);hash.update(link).update(resolved);
      if(lstatSync(resolved).isFile())content(resolved);
      if(readlinkSync(path)!==link||realpathSync(path)!==resolved)changed();
    }else if(before.isDirectory()){for(const name of readdirSync(path).sort())visit(path+'/'+name);}
    else if(before.isFile())content(path);else changed();
    if(stamp(lstatSync(path))!==stamp(before))changed();
  }
  for(const path of paths)visit(path);
  return hash.digest('hex');
}
