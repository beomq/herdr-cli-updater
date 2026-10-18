import type { Installation } from '../src/protocol';
import type { AppOperation, AppSnapshot, ExternalSession } from '../src/app/types';
import type { CatalogEntry } from '../src/app/catalog-types';
import { isSupportedCli } from '../src/app/catalog-types';
import type { UpdateAction } from './catalog-dashboard';

/** Keep the complete session census, but expose management only for supported CLIs. */
export function supportedSnapshot(snapshot:AppSnapshot):AppSnapshot {
  const installations=snapshot.installations.filter(row=>isSupportedCli(row.family));
  const ids=new Set(installations.map(row=>row.installationId));
  return {...snapshot,installations,
    ...(snapshot.native?{native:{...snapshot.native,selections:snapshot.native.selections.filter(row=>isSupportedCli(row.installation.family))}}:{}),
    ...(snapshot.catalog?{catalog:snapshot.catalog.filter(row=>isSupportedCli(row.id))}:{}),
    policies:snapshot.policies.filter(row=>ids.has(row.installationId)||isSupportedCli(row.installationId.replace(/^catalog:/,''))),
    operations:snapshot.operations.filter(row=>ids.has(row.installationId)),
    ...(snapshot.installJobs?{installJobs:snapshot.installJobs.filter(row=>isSupportedCli(row.catalogId))}:{}),
    ...(snapshot.catalogUpdates?{catalogUpdates:snapshot.catalogUpdates.filter(row=>isSupportedCli(row.catalogId))}:{}),
    ...(snapshot.removalJobs?{removalJobs:snapshot.removalJobs.filter(row=>isSupportedCli(row.catalogId))}:{}),
    ...(snapshot.defaultJobs?{defaultJobs:snapshot.defaultJobs.filter(row=>isSupportedCli(row.catalogId))}:{}),
  };
}

export function installedCatalog(snapshot:AppSnapshot) {
  return (snapshot.catalog??[]).filter(entry=>isSupportedCli(entry.id)&&(entry.installed||entry.installations?.length));
}
export function catalogContainsInstallation(entry:CatalogEntry,installation:Installation):boolean {
  return entry.id===installation.family&&(entry.installed?.path===installation.executableRealpath
    ||entry.installed?.identityPath===installation.executableRealpath
    ||!!entry.installations?.some(row=>row.path===installation.executableRealpath||row.identityPath===installation.executableRealpath));
}
/** Observation timestamps do not change the installation approved by the user. */
export function engineReviewBinding(installation:Installation|undefined):string {
  return JSON.stringify(installation?[installation.installationId,installation.family,installation.channel,
    installation.executableRealpath,installation.owner,installation.resourcesFingerprint,installation.resources,installation.installedVersion]:null);
}
export function catalogSnapshot(snapshot:AppSnapshot,entry:CatalogEntry):AppSnapshot {
  const installations=snapshot.installations.filter(i=>catalogContainsInstallation(entry,i));
  const ids=new Set(installations.map(i=>i.installationId));
  return {...snapshot,installations,catalog:[entry],
    native:{selections:[],jobs:[],failure:null},
    managed:snapshot.managed.filter(s=>ids.has(s.installationId)),
    external:snapshot.external.filter(s=>s.catalogId===entry.id||s.family===entry.id),
    operations:snapshot.operations.filter(o=>ids.has(o.installationId)),
    policies:snapshot.policies.filter(p=>p.installationId==='catalog:'+entry.id||ids.has(p.installationId)),
    catalogUpdates:(snapshot.catalogUpdates??[]).filter(job=>job.catalogId===entry.id),
    installJobs:(snapshot.installJobs??[]).filter(job=>job.catalogId===entry.id),
    removalJobs:(snapshot.removalJobs??[]).filter(job=>job.catalogId===entry.id),
    defaultJobs:(snapshot.defaultJobs??[]).filter(job=>job.catalogId===entry.id),
  };
}

export function dashboardAction(installation:Installation, operations:readonly AppOperation[]):'check'|'prepare'|'review'|'progress'|'inspect'|'support' {
  const open=operations.filter(o=>o.installationId===installation.installationId&&!['completed','failed','cancelled'].includes(o.stage));
  if(open.some(o=>o.stage==='uncertain'))return 'inspect';
  if(open.some(o=>o.stage!=='ready'))return 'progress';
  if(open.some(o=>o.stage==='ready'))return 'review';
  if(installation.lastCheck?.result.kind==='update-available')return installation.family==='omo'&&installation.owner.kind!=='unknown'?'prepare':'support';
  return 'check';
}

export function engineUpdateAction(installation:Installation, operations:readonly AppOperation[]):UpdateAction {
  const action=dashboardAction(installation,operations);
  if(action==='inspect'||action==='progress'||action==='review')return {kind:action,reason:null};
  if(installation.family!=='omo')return {kind:'update',reason:'unsupported'};
  if(installation.owner.kind==='unknown')return {kind:'update',reason:'owner_unverified'};
  const result=installation.lastCheck?.result;
  if(!result)return {kind:'update',reason:'not_checked'};
  return result.kind==='update-available'?{kind:'update',reason:null}:result.kind==='up-to-date'?{kind:'update',reason:'current'}:{kind:'update',reason:'check_failed'};
}

/** herdr-pane sessions whose process started on a different version than the one now on disk.
 * Only recorded running versions count; a version inferred from disk cannot be outdated. */
export function outdatedSessions(snapshot:AppSnapshot):ExternalSession[] {
  return snapshot.external.filter(s=>{
    if(s.processState==='exited'||!s.herdrPane)return false;
    const linked=s.installationId?snapshot.installations.find(i=>i.installationId===s.installationId):null;
    const disk=s.diskPackage?.version??(linked?.installedVersion.kind==='known'?linked.installedVersion.version:null);
    return !!disk&&!!s.runningVersion&&s.runningVersionEvidence!=='started-before-install'&&s.runningVersionEvidence!=='started-after-install'&&s.runningVersion!==disk;
  });
}

export function dashboardSummary(snapshot:AppSnapshot) {
  const catalog=installedCatalog(snapshot);
  const other=snapshot.installations.filter(i=>isSupportedCli(i.family)&&!catalog.some(entry=>catalogContainsInstallation(entry,i)));
  return {
    installed:catalog.length+new Set(other.filter(i=>!catalog.some(entry=>entry.id===i.family)).map(i=>i.family)).size,
    updates:catalog.filter(entry=>entry.lastCheck?.status==='available').length+other.filter(i=>i.lastCheck?.result.kind==='update-available').length,
    unchecked:catalog.filter(entry=>!entry.lastCheck||['checking','unknown','failed','unsupported'].includes(entry.lastCheck.status)).length+other.filter(i=>!i.lastCheck||i.lastCheck.result.kind==='unavailable').length,
    operations:snapshot.operations.filter(o=>!['completed','failed','cancelled'].includes(o.stage)).length+(snapshot.catalogUpdates??[]).filter(job=>['ready','updating','uncertain'].includes(job.stage)).length,
    sessions:snapshot.observedAt==null||snapshot.observationFailure?null:snapshot.external.filter(s=>s.processState!=='exited'&&s.herdrPane).length+snapshot.managed.filter(s=>['starting','ready','working','waiting','stopping','restarting'].includes(s.state)).length,
    unknownSessions:snapshot.managed.filter(s=>s.state==='unknown').length,
    outdated:snapshot.observedAt==null||snapshot.observationFailure?null:outdatedSessions(snapshot).length,
  };
}

export function observationGroups(snapshot:AppSnapshot) {
  const groups=new Map<ExternalSession['family'],{family:ExternalSession['family'];count:number;catalogLinked:number;unlinked:number}>();
  for(const session of snapshot.external){
    if(session.processState==='exited')continue;
    if(snapshot.installations.some(i=>i.installationId===session.installationId))continue;
    const group=groups.get(session.family)??{family:session.family,count:0,catalogLinked:0,unlinked:0};
    group.count++;
    if(session.catalogId&&snapshot.catalog?.some(c=>c.id===session.catalogId&&c.installed))group.catalogLinked++;else group.unlinked++;
    groups.set(session.family,group);
  }
  return [...groups.values()];
}
