import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CatalogInstallation } from './catalog-types';

/** A display hint only. Planning still verifies every file and consumer. */
export function removalSupport(row:CatalogInstallation,home:string):{readonly kind:'review'|'unsupported';readonly reason:string|null} {
  if(row.identityPath.startsWith(join(home,'.bun/install/global/node_modules')+'/')){
    const name=row.identityPath.slice(join(home,'.bun/install/global/node_modules').length+1).split('/').slice(0,row.identityPath.includes('/node_modules/@')?2:1).join('/');
    try{
      const metadata=z.object({dependencies:z.record(z.string(),z.string()).optional()}).parse(JSON.parse(readFileSync(join(home,'.bun/install/global/package.json'),'utf8')));
      if(!metadata.dependencies?.[name])return {kind:'unsupported',reason:'removal_dependency_installation'};
    }catch(error){
      if(error instanceof Error)return {kind:'unsupported',reason:'removal_metadata_invalid'};
      throw error;
    }
  }
  if(row.manager!=='unknown')return {kind:'review',reason:null};
  const paths:Readonly<Record<string,string>>={claude:'.local/bin/claude',agy:'.local/bin/agy',kimi:'.kimi-code/bin/kimi',opencode:'.opencode/bin/opencode'};
  const relative=paths[row.catalogId];
  return relative&&row.path===join(home,relative)?{kind:'review',reason:null}
    :{kind:'unsupported',reason:'removal_standalone_unverified'};
}
