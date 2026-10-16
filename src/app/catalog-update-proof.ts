import { lstatSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import type { UpdateTarget } from './catalog-update-target';
import { bunOmoEntry } from './omo-installation';
import { AppError } from './types';

const stamp=z.object({dev:z.number(),ino:z.number(),size:z.number(),mtime:z.number(),ctime:z.number()}).strict();
export const updateIdentitySchema=z.object({
  root:z.object({dev:z.number(),ino:z.number()}).strict(),canonical:z.string(),file:stamp,launcher:stamp,
}).strict();
export type UpdateIdentity=z.infer<typeof updateIdentitySchema>;
export function updateIdentity(target:UpdateTarget,home:string):UpdateIdentity {
  const root=lstatSync(target.target);
  const canonical=target.kind==='bun'?bunOmoEntry(target.executable,home)??realpathSync(target.executable):realpathSync(target.executable);
  const file=lstatSync(canonical),launcher=lstatSync(target.executable);
  if(!root.isDirectory()||root.isSymbolicLink()||realpathSync(target.target)!==target.target||!file.isFile())
    throw new AppError('source_changed','recovery_target_unsafe');
  const fields=(stat:typeof file)=>({dev:stat.dev,ino:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs});
  return {root:{dev:root.dev,ino:root.ino},canonical,file:fields(file),launcher:fields(launcher)};
}
export function sameUpdateIdentity(before:UpdateIdentity,after:UpdateIdentity):boolean {
  return before.root.dev===after.root.dev&&before.root.ino===after.root.ino&&before.canonical===after.canonical
    &&before.file.dev===after.file.dev&&before.file.ino===after.file.ino
    &&before.launcher.dev===after.launcher.dev&&before.launcher.ino===after.launcher.ino;
}
