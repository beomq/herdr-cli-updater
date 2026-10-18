import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { z } from 'zod';
import { AppError } from './types';

export const absolutePath=z.string().startsWith('/').max(4096).regex(/^[^\x00-\x1f\x7f:]+$/)
  .refine(value=>normalize(value)===value&&value!=='/');
export type FileState={readonly fingerprint:string|null;readonly bytes:Buffer|null;readonly mode:number};
export type LinkState={readonly fingerprint:string|null;readonly target:string|null};
export const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const quote=(value:string)=>`'${value.replaceAll("'",`'\\''`)}'`;
export function changed():never {throw new AppError('source_changed','default_switch_plan_stale');}
export function stamp(stat:ReturnType<typeof fstatSync>):string {
  return JSON.stringify([stat.dev,stat.ino,stat.mode,stat.nlink,stat.uid,stat.size,stat.mtimeMs,stat.ctimeMs]);
}
export function directoryState(path:string):string {
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if(!stat||!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path)changed();
  return hash(JSON.stringify([path,stat.dev,stat.ino,stat.mode,stat.uid]));
}
export function fileState(path:string,maxBytes=1_048_576):FileState {
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if(!stat)return {fingerprint:null,bytes:null,mode:0o600};
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>maxBytes)changed();
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=fstatSync(fd);
    if(stamp(stat)!==stamp(before))changed();
    const bytes=readFileSync(fd),after=fstatSync(fd);
    if(stamp(before)!==stamp(after)||stamp(lstatSync(path))!==stamp(after))changed();
    return {fingerprint:hash(Buffer.concat([Buffer.from(stamp(after)),bytes])),bytes,mode:after.mode&0o777};
  }finally{closeSync(fd);}
}
export function linkState(path:string):LinkState {
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if(!stat)return {fingerprint:null,target:null};
  if(!stat.isSymbolicLink())changed();
  const target=readlinkSync(path);
  if(stamp(stat)!==stamp(lstatSync(path)))changed();
  return {fingerprint:hash(JSON.stringify([stamp(stat),target])),target};
}
export function publish(path:string,content:Buffer|string,mode:number,before:()=>void):void {
  const temporary=join(dirname(path),`.default-switch-${randomUUID()}`);
  try {
    if(typeof content==='string')symlinkSync(content,temporary);
    else {
      const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try {writeFileSync(fd,content);fchmodSync(fd,mode);fsyncSync(fd);}finally{closeSync(fd);}
    }
    before();renameSync(temporary,path);
  }finally{if(lstatSync(temporary,{throwIfNoEntry:false}))unlinkSync(temporary);}
}
function block(directory:string,label:string):Buffer {
  return Buffer.from(`# >>> ${label} >>>\nexport PATH=${quote(directory)}:"$PATH"\n# <<< ${label} <<<\n`);
}
/** Recognize only byte-for-byte generated blocks, never interpret shell text. */
export function profileBytes(original:Buffer|null,directory:string,catalogId:string):Buffer {
  let bytes=original??Buffer.alloc(0);
  for(const label of [`CLI default PATH v2 ${catalogId}`,'CLI default PATH v2','herdr-cli-updater PATH','CLI default dispatch v3']){
    const begin=`# >>> ${label} >>>`,end=`# <<< ${label} <<<`;
    const at=bytes.indexOf(begin),endAt=bytes.indexOf(end);
    if(at===-1&&endAt===-1)continue;
    const conflict=()=>{throw new AppError('conflict','default_path_block_modified');};
    if(at<0||endAt<at||at>0&&bytes[at-1]!==10||bytes.indexOf(begin,at+1)!==-1||bytes.indexOf(end,endAt+1)!==-1)conflict();
    const stop=endAt+Buffer.byteLength(end)+1,actual=bytes.subarray(at,stop);
    const lines=actual.toString('utf8').split('\n'),line=lines[1];
    if(lines.length!==4||!line?.startsWith('export PATH=')||!line.endsWith(':"$PATH"'))conflict();
    const encoded=(line??'').slice('export PATH='.length,-':"$PATH"'.length);
    const previous=encoded.slice(1,-1).replaceAll("'\\''","'");
    if(!absolutePath.safeParse(previous).success||!actual.equals(block(previous,label)))conflict();
    if(label==='herdr-cli-updater PATH'&&previous!==join(directory,'launchers')||
      label==='CLI default dispatch v3'&&previous!==join(directory,'dispatch/bin'))conflict();
    bytes=Buffer.concat([bytes.subarray(0,at),bytes.subarray(stop)]);
  }
  // Keep every foreign byte and unmigrated CLI block; dispatch wins over their prepends.
  return Buffer.concat([bytes,bytes.length&&bytes[bytes.length-1]!==10?Buffer.from('\n'):Buffer.alloc(0),block(join(directory,'dispatch/bin'),'CLI default dispatch v3')]);
}
