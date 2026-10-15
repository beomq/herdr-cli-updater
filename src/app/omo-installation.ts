import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { bunShimTarget } from '../service/catalog-sources';

/** Resolve only the exact generated Bun launchers, never an arbitrary shell script. Bun links a
 * global bin into both `~/.bun/bin` and the global `node_modules/.bin`, and omo-ai writes its
 * launcher shim to both, so either path is the same installation. */
export function bunOmoEntry(executable:string,home:string):string|null {
  const launchers=[join(home,'.bun/bin/omo'),join(home,'.bun/install/global/node_modules/.bin/omo')];
  const entry=join(home,'.bun/install/global/node_modules/omo-ai/bin/omo.js');
  if(executable!==entry&&!launchers.includes(executable))return null;
  try {
    if(realpathSync(entry)!==entry||!lstatSync(entry).isFile())return null;
    if(executable===entry)return entry;
    const info=lstatSync(executable);
    if(info.isSymbolicLink())return realpathSync(executable)===entry?entry:null;
    if(!info.isFile()||info.size>16384||(info.mode&0o022)!==0)return null;
    return bunShimTarget(readFileSync(executable,'utf8'))===entry?entry:null;
  }catch(error){
    if(error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(String(error.code)))return null;
    throw error;
  }
}
