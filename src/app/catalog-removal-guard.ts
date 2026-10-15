import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { executablePosition, readProcesses } from './observations';
import { AppError } from './types';
import type { AppSnapshot } from './types';
import type { CatalogRemovalTarget } from './catalog-removal';

export function guardRemoval(target:CatalogRemovalTarget,snapshot:AppSnapshot,processes=readProcesses(),exactSource=false):void {
  if(snapshot.operations.some(row=>!['completed','failed','cancelled'].includes(row.stage)))throw new AppError('busy','operation_in_progress');
  const ownedRoot=target.kind==='standalone'?target.payload:target.kind==='owned'?target.target:target.kind==='brew'?target.payloadRoot:target.target+'/node_modules/'+target.packageName;
  const contains=(path:string)=>path===target.executable||path===ownedRoot||path.startsWith(ownedRoot+'/');
  const affected=snapshot.installations.filter(row=>contains(row.executableRealpath)||row.resources.some(resource=>contains(resource.realpath)));
  if(snapshot.policies.some(row=>row.mode!=='off'&&affected.some(item=>item.installationId===row.installationId)))
    throw new AppError('busy','disable_automation_before_removal');
  if(snapshot.managed.some(row=>!['stopped','failed'].includes(row.state)&&affected.some(item=>item.installationId===row.installationId)))
    throw new AppError('busy','running_sessions');
  const names=(snapshot.catalog??[]).filter(row=>row.installed?.path===target.executable).map(row=>row.executable);
  for(const process of processes){
    if(process.uid!==globalThis.process.getuid?.())continue;
    // OmO may be a Pi extension rather than argv[0]. Match the exact installation path,
    // even when runtime options prevent argv analysis. Block ambiguous consumers.
    if(process.command.includes(target.executable)||process.command.includes(ownedRoot+'/'))throw new AppError('busy','running_sessions');
    const executable=executablePosition(process.command);if(!executable)continue;
    if(contains(executable)||(names.includes(basename(executable))&&(!exactSource||!executable.startsWith('/'))))
      throw new AppError('busy','running_sessions');
    if(executable.startsWith('/')){
      try{if(contains(realpathSync(executable)))throw new AppError('busy','running_sessions');}
      catch(error){if(error instanceof AppError)throw error;if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;}
    }
  }
}
