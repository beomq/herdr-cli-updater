import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { z } from 'zod';
import { AppError } from './types';
import { removalFingerprint } from './removal-fingerprint';

const path=z.string().startsWith('/').max(4096).regex(/^[^\x00-\x1f\x7f]*$/).refine(value=>normalize(value)===value&&value!=='/');
export const standaloneRemovalSchema=z.object({kind:z.literal('standalone'),catalogId:z.enum(['claude','agy','kimi','opencode']),
  home:path,target:path,executable:path,payload:path,archive:path,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),preserve:z.array(path).readonly(),
}).strict();
export type StandaloneRemovalTarget=z.infer<typeof standaloneRemovalSchema>;
const launchers={claude:'.local/bin/claude',agy:'.local/bin/agy',kimi:'.kimi-code/bin/kimi',opencode:'.opencode/bin/opencode'} as const;
function changed():never {throw new AppError('source_changed','removal_target_changed');}

function fingerprint(target:Omit<StandaloneRemovalTarget,'fingerprint'>):string {
  const {home,catalogId,executable,payload,archive}=target;
  if(executable!==join(home,launchers[catalogId])||target.target!==dirname(payload)
    ||archive!==join(dirname(payload),'.cli-updater-removed-'+basename(payload))
    ||JSON.stringify(target.preserve)!==JSON.stringify([home,archive]))changed();
  const file=lstatSync(payload),launcher=lstatSync(executable);
  if(!file.isFile()||file.uid!==process.getuid?.()||file.nlink!==1||(file.mode&0o111)===0||(file.mode&0o022)!==0
    ||launcher.uid!==process.getuid?.()||realpathSync(payload)!==payload)changed();
  if(catalogId==='claude'){
    if(!launcher.isSymbolicLink()||dirname(payload)!==join(home,'.local/share/claude/versions')
      ||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(basename(payload))||realpathSync(executable)!==payload)changed();
  }else if(executable!==payload||launcher.isSymbolicLink())changed();
  if(lstatSync(archive,{throwIfNoEntry:false}))throw new AppError('conflict','removal_archive_exists');
  const ancestors=new Set<string>();
  for(const file of [executable,payload])for(let parent=dirname(file);;parent=dirname(parent)){
    if(parent!==home&&!parent.startsWith(home+'/'))changed();ancestors.add(parent);if(parent===home)break;
  }
  const directories=[...ancestors].sort().map(parent=>{
    const stat=lstatSync(parent);
    if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o022)!==0||realpathSync(parent)!==parent)changed();
    return [parent,stat.dev,stat.ino,stat.mode,stat.uid];
  });
  // Refuse shell wrappers and arbitrary scripts at a familiar pathname.
  const fd=openSync(payload,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),header=Buffer.alloc(4);
  try{
    if(fstatSync(fd).ino!==file.ino||readSync(fd,header,0,4,0)!==4)changed();
    if(!['7f454c46','cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(header.toString('hex')))changed();
  }finally{closeSync(fd);}
  return removalFingerprint([executable,...(payload===executable?[]:[payload])],JSON.stringify([target,directories]));
}
export function discoverStandaloneRemoval(options:{readonly catalogId:string;readonly executable:string;readonly home:string}):StandaloneRemovalTarget|null {
  const parsed=standaloneRemovalSchema.shape.catalogId.safeParse(options.catalogId);
  if(!parsed.success)return null;
  const catalogId=parsed.data,executable=join(options.home,launchers[catalogId]);
  if(options.executable!==executable)return null;
  try{
    const payload=realpathSync(executable),archive=join(dirname(payload),'.cli-updater-removed-'+basename(payload));
    const base={kind:'standalone' as const,catalogId,home:options.home,target:dirname(payload),executable,payload,archive,preserve:[options.home,archive]};
    return {...base,fingerprint:fingerprint(base)};
  }catch(error){
    if(error instanceof AppError)throw error;
    if(error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(String(error.code)))throw new AppError('unsupported','removal_standalone_unverified');
    throw error;
  }
}
export function validateStandaloneRemoval(target:StandaloneRemovalTarget):void {
  if(!standaloneRemovalSchema.safeParse(target).success)changed();
  const {fingerprint:expected,...base}=target;
  if(fingerprint(base)!==expected)changed();
}
export function executeStandaloneRemoval(target:StandaloneRemovalTarget,home:string):void {
  if(target.home!==home)changed();validateStandaloneRemoval(target);
  const link=target.executable!==target.payload?readlinkSync(target.executable):null;
  const before=lstatSync(target.payload);
  // Exclusive hard-link creation preserves the bytes without overwriting an archive.
  // Any partial failure remains uncertain in the job; it is never replayed automatically.
  linkSync(target.payload,target.archive);
  const archived=lstatSync(target.archive),current=lstatSync(target.payload);
  if(archived.dev!==before.dev||archived.ino!==before.ino||current.dev!==before.dev||current.ino!==before.ino
    ||current.size!==before.size||current.mtimeMs!==before.mtimeMs)changed();
  if(link!==null){if(readlinkSync(target.executable)!==link)changed();unlinkSync(target.executable);}
  unlinkSync(target.payload);
}
