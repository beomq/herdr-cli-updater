import type { CatalogEntry, CatalogInstallation } from './catalog-types';
import type { UpdatePolicy } from './types';

/** Numeric-aware "candidate is strictly newer than baseline". A release is newer than its own prerelease. */
export function newerVersion(candidate:string,baseline:string):boolean {
  const parts=(value:string)=>{const [main,pre]=value.replace(/^v/,'').split('-',2);return {nums:(main??'').split('.').map(part=>Number.parseInt(part,10)||0),pre:pre??null};};
  const a=parts(candidate),b=parts(baseline);
  for(let i=0;i<Math.max(a.nums.length,b.nums.length);i++){const d=(a.nums[i]??0)-(b.nums[i]??0);if(d!==0)return d>0;}
  if(a.pre===b.pre)return false;
  if(a.pre===null)return true;
  if(b.pre===null)return false;
  return a.pre>b.pre;
}
export function parseBinding(binding:string):{kind:string;target:string;executable:string;packageName:string|null}|null {
  try{
    const value:unknown=JSON.parse(binding);
    if(!Array.isArray(value)||typeof value[0]!=='string'||typeof value[1]!=='string'||typeof value[2]!=='string')return null;
    return {kind:value[0],target:value[1],executable:value[2],packageName:typeof value[4]==='string'?value[4]:null};
  }catch{return null;}
}
/**
 * The worker pins managed files as a first observation and refuses to rebaseline itself when a
 * pinned file changes (stale_source). A package manager reinstall outside this app changes those
 * files, so the installation silently drops out of the managed list. This decides when the app may
 * reset that baseline instead: automation is on for the catalog, the app's own inventory (which
 * validates the manager, package manifest and bin link independently) still sees a ready
 * installation at the bound path, the worker no longer lists the family, the version is not older
 * than the last one recorded, and no reset happened within minIntervalMs. Returns the inventory row.
 */
export function rebaselineRow(policy:UpdatePolicy,entry:CatalogEntry|undefined,workerSeesFamily:boolean,now:number,minIntervalMs=3_600_000):CatalogInstallation|null {
  if(policy.mode!=='update'||!policy.catalogBinding||!entry||entry.inventoryStatus!=='ready'||workerSeesFamily)return null;
  if(policy.lastRebaselineAt!=null&&now-policy.lastRebaselineAt<minIntervalMs)return null;
  const binding=parseBinding(policy.catalogBinding);
  if(!binding||binding.kind==='owned'||binding.kind==='brew')return null;
  const row=(entry.installations??[]).find(item=>item.manager===binding.kind&&item.root===binding.target&&item.path===binding.executable
    &&(binding.packageName===null||item.packageName===binding.packageName));
  if(!row||!row.version)return null;
  const baseline=policy.lastInstalledVersion??null;
  if(baseline!==null&&row.version!==baseline&&!newerVersion(row.version,baseline))return null;
  return row;
}
