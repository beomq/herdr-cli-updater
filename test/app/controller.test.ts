import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createController } from "../../src/app/controller";
import { createManagedSessions } from "../../src/app/managed";
import type { createEngine, Preparation } from "../../src/app/engine";
import type { createNativeRestarts } from "../../src/app/native-restarts";
import type { AppCommand, AppSnapshot, UpdatePolicy } from "../../src/app/types";
import { AppStore } from '../../src/app/store';
import { AppError } from "../../src/app/types";
import type { createCatalog } from '../../src/app/catalog';
import type { CatalogEntry } from '../../src/app/catalog-types';
import { createCatalogUpdates } from '../../src/app/catalog-updates';
import type { latestCatalogVersion } from '../../src/app/catalog-latest';
import type { CheckResult, Installation, Job, SelectionMetadata, TargetSelection } from "../../src/protocol";
import { screenLooksIdle } from "../../src/app/observations";

async function nativeControllerFixture(uncertain = false) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const installation: Installation = { installationId: "native-install", family: "codex", channel: "latest",
    executableRealpath: "/fixture/codex", resourcesFingerprint: "fingerprint", resources: [],
    owner: { kind: "package", manager: "npm", packageName: "@openai/codex", prefix: "/fixture" },
    installedVersion: { kind: "known", version: "2.0.0" }, lastCheck: null };
  const target: TargetSelection = { targetId: "target", runtimeId: "runtime", installationId: installation.installationId,
    expectedBinding: { socketId: "socket", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
      rootIncarnation: { pid: 1, startIdentity: "first", executableRealpath: "/fixture/codex" },
      session: { kind: "conversation", fullId: "conversation", storagePathHash: "storage" }, cwd: "/fixture",
      optionsRef: "options", turnGeneration: 1, resourcesFingerprint: "fingerprint" } };
  const capability = { kind: "supported", reason: "verified", evidenceRef: "fixture" } as const;
  const selection = { installationId: installation.installationId, resourcesFingerprint: installation.resourcesFingerprint,
    owner: installation.owner, installedVersion: installation.installedVersion };
  let jobs: readonly Job[] = [];
  const snapshot = () => ({ selections: [{ installation, update: capability, readiness: capability, targets: [{
    target, runningVersion: { kind: "known" as const, version: "1.0.0" }, readiness: capability,
    completion: capability, gracefulExit: capability, resume: capability,
  }] }], jobs, failure: null });
  const native: typeof createNativeRestarts = () => ({ snapshot, refresh: async () => snapshot(),
    restart: async (received, selected, requestId) => {
      expect(received).toEqual(selection); expect(selected).toEqual(target);
      entered.resolve(); await release.promise;
      if (uncertain) throw new AppError("uncertain", "response_lost");
      const job: Job = { jobId: "native-job", requestId, revision: 7, mode: "restart-only", status: "completed", failure: null,
        selectedTargets: [target], installTxn: { selection, state: "not_required", receipt: null, failure: null },
        targetTxns: [{ ...target, state: "completed", failure: null, receipt: { kind: "completed", operationId: "started", effect: "started",
          identity: { ...target.expectedBinding, paneGeneration: 2,
            rootIncarnation: { ...target.expectedBinding.rootIncarnation, pid: 2, startIdentity: "second" } } } }] };
      jobs = [job]; return job;
    } });
  return { ...await fixture(false, undefined, "OmO", 0, undefined, undefined, undefined, native),
    nativeSelection: selection, target, entered: entered.promise, release: release.resolve };
}
test('shared session choice applies to existing and newly enabled automation without restarting sessions',async()=>{
  const f=await fixture();try{
    await f.command({kind:'policy',installationId:'fixture',mode:'off',intervalMinutes:60,paneSessions:'keep'});
    await f.command({kind:'automation-settings',paneSessions:'restart-all'});
    expect(f.controller.snapshot().automationSettings).toEqual({paneSessions:'restart-all'});
    expect(f.controller.snapshot().policies.find(row=>row.installationId==='fixture')?.paneSessions).toBe('restart-all');
    await f.command({kind:'automation',installationId:'fixture',enabled:true});
    expect(f.controller.snapshot().policies.find(row=>row.installationId==='fixture')).toMatchObject({mode:'update',paneSessions:'restart-all'});
    expect(f.effects).toEqual({stops:0,restarts:0});
  }finally{await f.close();}
});

test('unsupported persisted automation cannot fire and engine commands reject its family',async()=>{
  const saved:UpdatePolicy={installationId:'catalog:qwen',mode:'update',intervalMinutes:60,firstCheck:'now',lastCheckedAt:null,nextCheckAt:1000,waitingReason:null,catalogBinding:'old'};
  const f=await fixture(false,undefined,'OmO',0,undefined,undefined,saved);
  try{
    f.setFamily('grok');await f.command({kind:'refresh'});
    await expect(f.command({kind:'check',installationId:'fixture'})).rejects.toThrow('cli_not_supported');
    await expect(f.command({kind:'prepare',installationId:'fixture'})).rejects.toThrow('cli_not_supported');
    await expect(f.command({kind:'automation',installationId:'fixture',enabled:true})).rejects.toThrow('cli_not_supported');
    await expect(f.command({kind:'automation',installationId:'catalog:qwen',enabled:true})).rejects.toThrow('cli_not_supported');
    await expect(f.command({kind:'catalog-check',catalogId:'qwen'})).rejects.toThrow('cli_not_supported');
    f.fire(3_600_000);await f.controller.settled();
    expect(f.calls.checks).toBe(0);expect(f.calls.preparations).toBe(0);expect(f.calls.updates).toBe(0);
    expect(f.controller.snapshot().policies[0]?.installationId).toBe('catalog:qwen');
    expect(f.controller.snapshot().installations[0]?.family).toBe('grok');
    expect(f.effects).toEqual({stops:0,restarts:0});
  }finally{await f.close();}
});
test("native controller restarts separately and blocks installation mutation while pending", async () => {
  const f = await nativeControllerFixture();
  try {
    const pending = f.command({ kind: "native-restart", installation: f.nativeSelection, target: f.target });
    await f.entered;
    await expect(f.command({ kind: "catalog-update-plan", catalogId: "codex" })).rejects.toThrow("native_restart_in_progress");
    f.release(); const result = await pending;
    expect(result.operations.find(row => row.kind === "native-restart")).toMatchObject({
      stage: "completed", installedAt: null, installedVersion: null, jobId: "native-job",
    });
    expect(f.effects).toEqual({ stops: 0, restarts: 0 });
    expect(f.calls.updates).toBe(0);
  } finally { f.release(); await f.close(); }
});
test("native lost acknowledgement remains uncertain and cannot authorize another update", async () => {
  const f = await nativeControllerFixture(true);
  try {
    const pending = f.command({ kind: "native-restart", installation: f.nativeSelection, target: f.target });
    const failed = pending.catch((error: unknown) => error);
    await f.entered; f.release();
    expect(await failed).toMatchObject({ code: "uncertain", detail: "response_lost" });
    expect(f.controller.snapshot().operations.find(row => row.kind === "native-restart")?.stage).toBe("uncertain");
    await expect(f.command({ kind: "catalog-update-plan", catalogId: "codex" })).rejects.toThrow("native_restart_in_progress");
  } finally { f.release(); await f.close(); }
});

async function catalogUpdateFixture(sharedInstallation=false,targetKind:'owned'|'npm'='owned'){
  let installedVersion:string|null='1.0.0',executions=0,moved=false,blocked=false,latestVersion='2.0.0';
  let rows:CatalogEntry['installations']|undefined;
  let selectedId:string|undefined;
  let latestCalls=0,latestFails=false,holdLatest=false;
  const latestEntered=Promise.withResolvers<void>(),latestRelease=Promise.withResolvers<void>();
  const discovery=Promise.withResolvers<void>(),discovering=Promise.withResolvers<void>();
  const execution=Promise.withResolvers<void>(),executing=Promise.withResolvers<void>();
  let holdDiscovery=false,holdExecution=false;
  const executable=(directory:string)=>sharedInstallation?join(import.meta.dir,'fixtures/managed-rpc.ts'):join(directory,'owned/bin/fixture-cli');
  let sourceStore:AppStore|undefined;
  const catalog:typeof createCatalog=options=>{sourceStore=options.store;
    mkdirSync(join(options.directory,'owned/bin'),{recursive:true});
    if(!sharedInstallation)writeFileSync(executable(options.directory),'#!/bin/sh\necho 1.0.0\n',{mode:0o755});
    return {
    entries:()=>[{id:'codex',name:'Qwen',description:{ko:'',en:''},executable:'fixture-cli',
      sourceUrl:'https://example.com',method:'npm',availability:'installable',reason:null,
      installed:{path:executable(options.directory),version:installedVersion,managed:true},
      ...(rows?{installations:rows,inventoryStatus:'ready' as const,selectedInstallationId:options.store.catalogSelection('codex')??selectedId??null}: {})}],
    plan:async()=>{},confirm:async()=>{},recover:async()=>{},select:async()=>{},refresh:()=>{},busy:()=>false,settled:async()=>{},
  };};
  const updates:typeof createCatalogUpdates=options=>createCatalogUpdates({...options,guard:target=>{
    if(blocked)throw new AppError('busy','running_sessions');return options.guard(target);
  }},{
    discover:async()=>{
      if(holdDiscovery){discovering.resolve();await discovery.promise;}
      return targetKind==='npm'
        ?{kind:'npm',target:join(options.directory,moved?'changed':'owned'),executable:executable(options.directory),manager:join(options.directory,'npm'),packageName:'codex-pkg',fingerprint:'0'.repeat(64),preserve:[]}
        :{kind:'owned',target:join(options.directory,moved?'changed':'owned'),
        executable:executable(options.directory),fingerprint:'0'.repeat(64),preserve:[]};
    },
    execute:async()=>{executions++;if(holdExecution){executing.resolve();await execution.promise;}installedVersion='2.0.0';return installedVersion;},
  });
  const f=await fixture(false,catalog,'OmO',0,updates,async()=>{
    latestCalls++;
    if(holdLatest){latestEntered.resolve();await latestRelease.promise;}
    if(latestFails)throw new AppError('unavailable','latest_check_failed');
    return latestVersion;
  });
  return {...f,executions:()=>executions,move:()=>{moved=true;},block:()=>{blocked=true;},
    holdDiscovery:()=>{holdDiscovery=true;return {entered:discovering.promise,release:discovery.resolve};},
    holdExecution:()=>{holdExecution=true;return {entered:executing.promise,release:execution.resolve};},
    latestCalls:()=>latestCalls,failLatest:()=>{latestFails=true;},
    setInstalled:(version:string|null)=>{installedVersion=version;},setLatest:(version:string)=>{latestVersion=version;},
    setRows:(value:CatalogEntry['installations'])=>{rows=value;selectedId=value?.[0]?.id;},store:()=>{if(!sourceStore)throw new Error('missing store');return sourceStore;},executable:()=>executable(f.root),
    holdLatest:()=>{holdLatest=true;return {entered:latestEntered.promise,release:latestRelease.resolve};}};
}
test('selecting another installation transfers the sole automatic policy without touching sessions',async()=>{
  const f=await catalogUpdateFixture();try{
    const rows=['first','second'].map(id=>({id,catalogId:'codex' as const,manager:'npm' as const,root:f.root,packageName:'codex-pkg',path:f.executable(),identityPath:f.executable(),isDefault:id==='first',receiptId:null,version:'1.0.0'}));
    f.setRows(rows);
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});
    await f.command({kind:'catalog-select',catalogId:'codex',installationId:'second'});
    expect(f.controller.snapshot().catalog?.[0]?.selectedInstallationId).toBe('second');
    expect(f.executableSelections.get('codex')).toBe(f.executable());
    await f.command({kind:'refresh'});
    expect(f.controller.snapshot().catalog?.[0]?.herdrLaunch).toEqual({status:'applied',executable:f.executable()});
    expect(f.controller.snapshot().policies.filter(p=>p.mode!=='off')).toHaveLength(1);
    expect(f.controller.snapshot().policies[0]?.lastInstalledVersion).toBe('1.0.0');
    expect(f.executions()).toBe(0);expect(f.effects).toEqual({stops:0,restarts:0});
  }finally{await f.close();}
});
test('a herdr without executable selection still switches the update target without claiming a herdr launch',async()=>{
  const f=await catalogUpdateFixture();try{
    const rows=['first','second'].map(id=>({id,catalogId:'codex' as const,manager:'npm' as const,root:f.root,packageName:'codex-pkg',path:f.executable(),identityPath:f.executable(),isDefault:id==='first',receiptId:null,version:'1.0.0'}));
    f.setRows(rows);
    // Given: released herdr 0.9.3 rejects the unknown method as invalid_request.
    f.failHerdrExecutable(new AppError('unavailable','herdr_invalid_request'));
    await f.command({kind:'catalog-select',catalogId:'codex',installationId:'second'});
    expect(f.controller.snapshot().catalog?.[0]?.selectedInstallationId).toBe('second');
    expect(f.executableSelections.has('codex')).toBe(false);
    expect(f.controller.snapshot().catalog?.[0]?.herdrLaunch).toEqual({status:'unavailable',executable:null});
  }finally{await f.close();}
});
test('a failed policy switch restores the previous herdr executable selection',async()=>{
  const f=await catalogUpdateFixture();try{
    const rows=['first','second'].map(id=>({id,catalogId:'codex' as const,manager:'npm' as const,root:f.root,packageName:'codex-pkg',path:f.executable(),identityPath:f.executable(),isDefault:id==='first',receiptId:null,version:'1.0.0'}));
    f.setRows(rows);
    f.executableSelections.set('codex','/previous/codex');
    const store=f.store();
    store.switchCatalogPolicy=()=>{throw new AppError('unavailable','store_write_failed');};
    await expect(f.command({kind:'catalog-select',catalogId:'codex',installationId:'second'})).rejects.toThrow('store_write_failed');
    expect(f.executableSelections.get('codex')).toBe('/previous/codex');
  }finally{await f.close();}
});
test('controller reconciliation and acknowledgement unlock without installer or session effects',async()=>{
  const f=await catalogUpdateFixture();
  try{
    await f.command({kind:'catalog-check',catalogId:'codex'});await f.controller.settled();
    const planned=await f.command({kind:'catalog-update-plan',catalogId:'codex'});
    const job=planned.catalogUpdates?.[0];if(!job)throw new Error('missing_job');
    f.store().putCatalogUpdate({...job,stage:'uncertain',failure:'service_restarted'});
    await f.command({kind:'catalog-update-recover',jobId:job.id,revision:job.revision,action:'reconcile'});
    const reconciled=f.store().catalogUpdates()[0];if(!reconciled)throw new Error('missing_job');
    expect(reconciled).toMatchObject({stage:'uncertain',expectedVersion:null,reconciliation:{version:'1.0.0'}});
    await expect(f.command({kind:'catalog-update-recover',jobId:job.id,revision:job.revision,action:'archive-unverified'})).rejects.toThrow('stale_update_plan');
    await f.command({kind:'catalog-update-recover',jobId:job.id,revision:reconciled.revision,action:'archive-unverified'});
    expect(f.store().catalogUpdates()[0]?.stage).toBe('archived-unverified');
    await f.command({kind:'catalog-update-plan',catalogId:'codex'});
    expect(f.executions()).toBe(0);expect(f.effects).toEqual({stops:0,restarts:0});
  }finally{await f.close();}
});
test('failed target verification retains selection and enabled policy',async()=>{
  const f=await catalogUpdateFixture();try{
    f.setRows(['first','second'].map(id=>({id,catalogId:'codex' as const,manager:'npm' as const,root:f.root,packageName:'codex-pkg',path:f.executable(),identityPath:f.executable(),isDefault:id==='first',receiptId:null,version:id==='second'?null:'1.0.0'})));
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});const before=f.controller.snapshot().policies;
    await expect(f.command({kind:'catalog-select',catalogId:'codex',installationId:'second'})).rejects.toThrow('installed_version_unverified');
    expect(f.controller.snapshot().catalog?.[0]?.selectedInstallationId).toBe('first');
    expect(f.controller.snapshot().policies).toEqual(before);
  }finally{await f.close();}
});
test('enabling a catalog policy disables the competing legacy policy of that CLI',async()=>{
  const catalog:typeof createCatalog=options=>({entries:()=>[{id:'omo',name:'OmO',description:{ko:'',en:''},executable:'omo',sourceUrl:'https://example.test',method:'npm',availability:'installable',reason:null,installed:{path:join(options.directory,'omo'),version:'1.0.0',managed:false}}],
    plan:async()=>{},confirm:async()=>{},recover:async()=>{},select:async()=>{},refresh:()=>{},busy:()=>false,settled:async()=>{}});
  const updates:typeof createCatalogUpdates=options=>createCatalogUpdates(options,{discover:async o=>({kind:'owned',target:options.directory,executable:o.executable,fingerprint:'a'.repeat(64),preserve:[]}),execute:async()=> '2.0.0'});
  const f=await fixture(false,catalog,'OmO',0,updates);try{
    const pendingLegacy:UpdatePolicy={installationId:'fixture',mode:'update',intervalMinutes:60,firstCheck:'after-interval',paneSessions:'keep',lastCheckedAt:null,nextCheckAt:99999999,waitingReason:null};
    const oldStore=new AppStore(f.root);oldStore.putPolicy(pendingLegacy);oldStore.close();
    await f.command({kind:'policy',installationId:'catalog:omo',mode:'update',intervalMinutes:60,firstCheck:'after-interval'});
    expect(f.controller.snapshot().policies.filter(row=>row.mode!=='off').map(row=>row.installationId)).toEqual(['catalog:omo']);
    await expect(f.command({kind:'policy',installationId:'fixture',mode:'update',intervalMinutes:60,firstCheck:'after-interval'})).rejects.toThrow('select_management_target_first');
    expect(f.controller.snapshot().policies.filter(row=>row.mode!=='off').map(row=>row.installationId)).toEqual(['catalog:omo']);
    expect(f.effects).toEqual({stops:0,restarts:0});
  }finally{await f.close();}
});
test('manual catalog checks report newer versions without enabling automation or changing installs',async()=>{
  const f=await catalogUpdateFixture();
  try{
    await f.command({kind:'catalog-check',catalogId:'codex'});await f.controller.settled();
    expect(f.controller.snapshot().catalog?.[0]?.lastCheck).toMatchObject({status:'available',latestVersion:'2.0.0',failure:null});
    expect(f.executions()).toBe(0);expect(f.latestCalls()).toBe(1);
    expect(f.controller.snapshot().policies).toHaveLength(0);expect(f.controller.snapshot().catalogUpdates).toHaveLength(0);
  }finally{await f.close();}
});
test('whole catalog workflow checks first, serializes commands and preserves active sessions and automation baseline',async()=>{
  const f=await catalogUpdateFixture(true);
  const held=f.holdLatest();
  try{
    const session=(await f.command({kind:'launch',installationId:'fixture',cwd:f.root})).managed[0];
    await f.command({kind:'automation-settings',paneSessions:'restart-idle'});
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});
    await f.command({kind:'catalog-update-all-plan'});await held.entered;
    await expect(f.command({kind:'catalog-update-plan',catalogId:'codex'})).rejects.toThrow('bulk_in_progress');
    await expect(f.controller.close()).rejects.toThrow('operation_in_progress');
    held.release();await f.controller.settled();
    const batch=f.controller.snapshot().catalogBulk;if(!batch)throw new Error('missing batch');
    expect(batch.stage).toBe('ready');expect(f.executions()).toBe(0);
    await f.command({kind:'catalog-update-all-confirm',batchId:batch.id,revision:batch.revision});await f.controller.settled();
    expect(f.controller.snapshot().catalogBulk?.items[0]?.status).toBe('completed');
    expect(f.controller.snapshot().catalogUpdates?.[0]?.paneSessions).toBe('keep');
    expect(f.controller.snapshot().policies[0]?.lastInstalledVersion).toBe('2.0.0');
    expect(f.controller.snapshot().managed[0]?.pid).toBe(session?.pid);
    expect(f.effects).toEqual({stops:0,restarts:0});
  }finally{held.release();await f.close();}
});
test('catalog checks keep installed-ahead and lookup-failed states distinct',async()=>{
  const f=await catalogUpdateFixture();
  try{
    f.setInstalled('3.0.0');
    await f.command({kind:'catalog-check',catalogId:'codex'});await f.controller.settled();
    expect(f.controller.snapshot().catalog?.[0]?.lastCheck?.status).toBe('ahead');
    f.failLatest();await f.command({kind:'catalog-check',catalogId:'codex'});await f.controller.settled();
    expect(f.controller.snapshot().catalog?.[0]?.lastCheck).toMatchObject({status:'failed',latestVersion:null,failure:'latest_check_failed'});
    expect(f.executions()).toBe(0);
  }finally{await f.close();}
});
test('catalog results cannot attach to a changed installation during a pending lookup',async()=>{
  const f=await catalogUpdateFixture(),hold=f.holdLatest();
  try{
    await f.command({kind:'catalog-check',catalogId:'codex'});await hold.entered;
    expect(f.controller.snapshot().catalog?.[0]?.lastCheck?.status).toBe('checking');
    f.setInstalled('3.0.0');hold.release();await f.controller.settled();
    expect(f.controller.snapshot().catalog?.[0]?.lastCheck).toBeUndefined();
    expect(f.executions()).toBe(0);
  }finally{hold.release();await f.close();}
});
test('confirmation without a stored policy keeps pane sessions',async()=>{
  const f=await fixture();
  try{
    f.setObservedPid(456,'2026-10-12T09:00:00.000Z','fixture');f.setPane('idle');f.fire(15000);
    await f.command({kind:'check',installationId:'fixture'});
    await f.command({kind:'prepare',installationId:'fixture'});await f.controller.settled();
    const operation=f.controller.snapshot().operations[0];if(!operation)throw new Error('missing_preparation');
    await f.command({kind:'confirm',operationId:operation.id,revision:operation.revision,sessions:[],restart:false});
    await f.controller.settled();
    expect(f.controller.snapshot().operations[0]).toMatchObject({stage:'completed',paneSessions:'keep'});
    expect(f.paneCalls).toEqual([]);
  }finally{await f.close();}
});
test.each([
  ['1.0.0','2.0.0','available',1],
  ['2.0.0','2.0.0','current',0],
  ['3.0.0','2.0.0','ahead',0],
  [null,'2.0.0','unknown',0],
  ['unverified','2.0.0','unknown',0],
  ['1.0.0','malformed','unknown',0],
  ['1.0.0','2.0.0-..','unknown',0],
  ['1.0.0','02.0.0','unknown',0],
  ['1.0.0','2.0.0-01','unknown',0],
  ['1.0.0','2.0.0+..','unknown',0],
  ['2.0.0-..','3.0.0','unknown',0],
  ['02.0.0','3.0.0','unknown',0],
  ['2.0.0-01','3.0.0','unknown',0],
  ['2.0.0+..','3.0.0','unknown',0],
  ['2.0.0-..','2.0.0-..','unknown',0],
  ['02.0.0','02.0.0','unknown',0],
  ['2.0.0-01','2.0.0-01','unknown',0],
  ['2.0.0+..','2.0.0+..','unknown',0],
  ['2.0.0-beta.1','2.0.0','available',1],
  ['2.0.0','2.0.0-beta.1','ahead',0],
  ['1.0.0+build.1','1.0.0+build.2','current',0],
  ['1.0.0','2.0.0-beta.1+build.01','available',1],
  ['1.0.0','2.0.0-0.alpha-1','available',1],
] as const)('automatic eligibility for installed %s and latest %s is %s',async(installed,latest,status,count)=>{
  // Given: real controller/update jobs with fixture discovery and installer effects.
  const f=await catalogUpdateFixture();
  const statuses:string[]=[];
  const dispose=f.controller.subscribe(()=>{const status=f.controller.snapshot().catalog?.[0]?.lastCheck?.status;if(status)statuses.push(status);});
  try{
    f.setInstalled(installed);f.setLatest(latest);
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});
    // When: the injected clock dispatches the scheduled check to completion.
    f.fire();await f.controller.settled();
    // Then: only a verified newer version admits an installer and sessions remain untouched.
    expect(f.executions()).toBe(count);
    expect(statuses).toContain(status);
    expect(f.controller.snapshot().policies[0]?.paneSessions).toBe('keep');
    expect(f.controller.snapshot().catalogUpdates).toHaveLength(count);
    expect(f.effects).toEqual({stops:0,restarts:0});expect(f.paneCalls).toEqual([]);
  }finally{dispose();await f.close();}
});
test('one-toggle automation checks immediately and hourly without reinstalling the latest version',async()=>{
  const f=await catalogUpdateFixture();
  try{
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});
    expect(f.controller.snapshot().policies[0]).toMatchObject({mode:'update',intervalMinutes:60,firstCheck:'now',nextCheckAt:1000});
    f.fire();await f.controller.settled();
    expect(f.executions()).toBe(1);expect(f.latestCalls()).toBe(1);
    f.fire(3_600_000);await f.controller.settled();
    expect(f.latestCalls()).toBe(2);expect(f.executions()).toBe(1);
    expect(f.controller.snapshot().catalogUpdates).toHaveLength(1);
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:false});
    f.fire(3_600_000);await f.controller.settled();
    expect(f.latestCalls()).toBe(2);
  }finally{await f.close();}
});
for(const automatic of [false,true])test(`catalog ${automatic?'automatic':'confirmed'} update leaves the active session on its launched version`,async()=>{
  const f=await catalogUpdateFixture(true);
  try{
    // Given a real managed child using the same executable as the catalog target.
    const before=(await f.command({kind:'launch',installationId:'fixture',cwd:f.root})).managed[0];
    if(!before?.pid)throw new Error('missing_session');
    const pid=before.pid;
    // When installation updating runs before any session restart.
    if(automatic){
      await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});
      f.fire();
    }else{
      await f.command({kind:'catalog-update-plan',catalogId:'codex'});
      const job=f.controller.snapshot().catalogUpdates?.[0];if(!job)throw new Error('missing_update');
      await f.command({kind:'catalog-update-confirm',jobId:job.id,revision:job.revision});
    }
    await f.controller.settled();
    // Then disk success never substitutes for a session restart or version claim.
    expect(f.executions()).toBe(1);
    expect(f.controller.snapshot().catalogUpdates?.[0]).toMatchObject({stage:'completed',installedVersion:'2.0.0'});
    expect(f.controller.snapshot().managed[0]).toMatchObject({pid:before.pid,generation:before.generation,
      durableSessionId:before.durableSessionId,launchedVersion:'1.0.0',state:'ready'});
    expect(f.effects).toEqual({stops:0,restarts:0});
    expect(()=>process.kill(pid,0)).not.toThrow();
  }finally{await f.close();}
});
test('session restart waits for installation updating to settle',async()=>{
  const f=await catalogUpdateFixture(true);
  const execution=f.holdExecution();
  try{
    // Given a live session and an installation replacement held at its effect boundary.
    const session=(await f.command({kind:'launch',installationId:'fixture',cwd:f.root})).managed[0];
    if(!session)throw new Error('missing_session');
    await f.command({kind:'catalog-update-plan',catalogId:'codex'});
    const job=f.controller.snapshot().catalogUpdates?.[0];if(!job)throw new Error('missing_update');
    await f.command({kind:'catalog-update-confirm',jobId:job.id,revision:job.revision});
    await execution.entered;
    // When restarting would launch from a changing installation, preserve the old session.
    await expect(f.command({kind:'restart',sessionId:session.id,generation:session.generation})).rejects.toThrow('update_in_progress');
    expect(f.controller.snapshot().managed[0]).toMatchObject({pid:session.pid,generation:session.generation,state:'ready'});
    // Then the same restart is available after installation verification completes.
    execution.release();await f.controller.settled();
    await f.command({kind:'restart',sessionId:session.id,generation:session.generation});await f.controller.settled();
    expect(f.controller.snapshot().managed[0]).toMatchObject({generation:session.generation+1,
      durableSessionId:session.durableSessionId,state:'ready'});
  }finally{execution.release();await f.close();}
});

test('catalog confirmation permits a consumer launched after the plan',async()=>{
  const f=await catalogUpdateFixture(true);
  try{
    // Given an approved installation target with a newly active consumer.
    await f.command({kind:'catalog-update-plan',catalogId:'codex'});
    const job=f.controller.snapshot().catalogUpdates?.[0];if(!job)throw new Error('missing_update');
    await f.command({kind:'launch',installationId:'fixture',cwd:f.root});
    // When the same target is confirmed, the session is not a removal prerequisite.
    await f.command({kind:'catalog-update-confirm',jobId:job.id,revision:job.revision});await f.controller.settled();
    expect(f.executions()).toBe(1);expect(f.effects).toEqual({stops:0,restarts:0});
  }finally{await f.close();}
});
test('catalog update still refuses a concurrent engine operation',async()=>{
  const f=await catalogUpdateFixture();
  try{
    // Given an installation update plan and a later engine preparation.
    await f.command({kind:'catalog-update-plan',catalogId:'codex'});
    const job=f.controller.snapshot().catalogUpdates?.[0];if(!job)throw new Error('missing_update');
    await f.command({kind:'prepare',installationId:'fixture'});await f.controller.settled();
    // When confirmation or a new plan tries to overlap that operation, both stop.
    await expect(f.command({kind:'catalog-update-confirm',jobId:job.id,revision:job.revision})).rejects.toThrow('operation_in_progress');
    await expect(f.command({kind:'catalog-update-plan',catalogId:'codex'})).rejects.toThrow('operation_in_progress');
    expect(f.executions()).toBe(0);
  }finally{await f.close();}
});
test('catalog update permits an external consumer without terminating it',async()=>{
  const f=await catalogUpdateFixture();
  let child:ReturnType<typeof Bun.spawn>|undefined;
  try{
    // Given a real external process whose command names the selected installation.
    const executable=f.controller.snapshot().catalog?.[0]?.installed?.path;if(!executable)throw new Error('missing_target');
    mkdirSync(join(f.root,'owned/bin'),{recursive:true});
    writeFileSync(executable,"process.stdin.resume();console.log('READY');\n");
    const consumer=Bun.spawn([process.execPath,executable],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});child=consumer;
    const reader=consumer.stdout.getReader();
    const first=await reader.read();expect(new TextDecoder().decode(first.value)).toBe('READY\n');reader.releaseLock();
    // When the installation is updated, no stop or restart is requested.
    await f.command({kind:'catalog-update-plan',catalogId:'codex'});
    const job=f.controller.snapshot().catalogUpdates?.[0];if(!job)throw new Error('missing_update');
    await f.command({kind:'catalog-update-confirm',jobId:job.id,revision:job.revision});await f.controller.settled();
    expect(f.executions()).toBe(1);expect(consumer.exitCode).toBeNull();
    expect(f.effects).toEqual({stops:0,restarts:0});
  }finally{if(child){child.kill();await child.exited;}await f.close();}
});
test('saved custom automation is migrated to immediate hourly update-only without enabling off policies',async()=>{
  for(const mode of ['check','off'] as const){
    const f=await fixture(false,undefined,'OmO',0,undefined,undefined,{installationId:'fixture',mode,intervalMinutes:1440,firstCheck:'after-interval',lastCheckedAt:null,nextCheckAt:99_000_000,waitingReason:null});
    try{
      expect(f.controller.snapshot().policies[0]).toMatchObject({mode:mode==='off'?'off':'update',intervalMinutes:60,firstCheck:'now',nextCheckAt:mode==='off'?null:1000});
      expect(f.calls.updates).toBe(0);
    }finally{await f.close();}
  }
});
test('failed latest lookup does not update or create a success history entry',async()=>{
  const f=await catalogUpdateFixture();
  try{
    f.failLatest();await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});
    f.fire();await f.controller.settled();
    expect(f.executions()).toBe(0);expect(f.controller.snapshot().catalogUpdates).toHaveLength(0);
    expect(f.controller.snapshot().policies[0]?.waitingReason).toBe('latest_check_failed');
  }finally{await f.close();}
});
test('switching off during latest lookup prevents the deferred update',async()=>{
  const f=await catalogUpdateFixture(),gate=f.holdLatest();
  try{
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});
    f.fire();await gate.entered;
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:false});
    gate.release();await f.controller.settled();
    expect(f.executions()).toBe(0);expect(f.controller.snapshot().policies[0]?.mode).toBe('off');
  }finally{gate.release();await f.controller.settled();await f.close();}
});
test('automatic latest lookup cannot authorize a changed selection',async()=>{
  const f=await catalogUpdateFixture(),gate=f.holdLatest();
  try{
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});
    f.fire();await gate.entered;
    f.setInstalled('0.5.0');gate.release();await f.controller.settled();
    expect(f.executions()).toBe(0);
    expect(f.controller.snapshot().catalog?.[0]?.lastCheck).toBeUndefined();
    expect(f.controller.snapshot().policies[0]?.waitingReason).toBe('installation_selection_changed');
  }finally{gate.release();await f.controller.settled();await f.close();}
});
test('an off decision supersedes a pending catalog enable even when the stored off policy is unchanged',async()=>{
  const f=await catalogUpdateFixture();
  const off={kind:'policy',installationId:'catalog:codex',mode:'off',intervalMinutes:5} as const;
  const gate=f.holdDiscovery();
  try{
    await f.command(off);
    const enabling=f.command({...off,mode:'update'});
    const outcome=enabling.then(()=>null,(error:unknown)=>error);
    await gate.entered;
    await f.command(off);
    gate.release();expect(await outcome).toMatchObject({detail:'policy_changed'});
    f.fire(300000);await f.controller.settled();
    expect(f.controller.snapshot().policies[0]?.mode).toBe('off');
    expect(f.executions()).toBe(0);
  }finally{gate.release();await f.controller.settled();await f.close();}
});
test('a launch awaiting discovery cannot enter an active catalog update',async()=>{
  const f=await catalogUpdateFixture();
  const lookup=f.pause('installations'),execution=f.holdExecution();
  try{
    const launching=f.command({kind:'launch',installationId:'fixture',cwd:f.root});
    const outcome=launching.then(()=>null,(error:unknown)=>error);
    await lookup.entered;
    const planned=await f.command({kind:'catalog-update-plan',catalogId:'codex'});
    const job=planned.catalogUpdates?.[0];if(!job)throw new Error('missing plan');
    await f.command({kind:'catalog-update-confirm',jobId:job.id,revision:job.revision});
    await execution.entered;
    lookup.release();expect(await outcome).toMatchObject({detail:'update_in_progress'});
    expect(f.controller.snapshot().managed).toHaveLength(0);
    execution.release();await f.controller.settled();
  }finally{lookup.release();execution.release();await f.controller.settled();await f.close();}
});
test('catalog automatic updates run without invoking the OmO engine or restarting sessions',async()=>{
  const f=await catalogUpdateFixture();
  try{
    await f.command({kind:'policy',installationId:'catalog:codex',mode:'update',intervalMinutes:5,firstCheck:'after-interval'});
    expect(f.executions()).toBe(0);
    f.fire(300000);await f.controller.settled();
    expect(f.executions()).toBe(1);
    expect(f.controller.snapshot().catalogUpdates?.[0]).toMatchObject({stage:'completed',installedVersion:'2.0.0'});
    expect(f.calls.updates).toBe(0);expect(f.effects).toEqual({stops:0,restarts:0});
    await f.command({kind:'policy',installationId:'catalog:codex',mode:'off',intervalMinutes:5});
    f.fire(300000);await f.controller.settled();expect(f.executions()).toBe(1);
  }finally{await f.close();}
});
test('automatic catalog consent cannot transfer to a different installation path',async()=>{
  const f=await catalogUpdateFixture();
  try{
    await f.command({kind:'policy',installationId:'catalog:codex',mode:'update',intervalMinutes:5});
    f.move();f.fire();await f.controller.settled();
    expect(f.executions()).toBe(0);
    expect(f.controller.snapshot().policies[0]?.waitingReason).toBe('update_target_changed');
  }finally{await f.close();}
});
test('running catalog consumers wait rather than being stopped by automatic update',async()=>{
  const f=await catalogUpdateFixture();
  try{
    await f.command({kind:'policy',installationId:'catalog:codex',mode:'update',intervalMinutes:5});
    f.block();f.fire();await f.controller.settled();
    expect(f.executions()).toBe(0);expect(f.effects).toEqual({stops:0,restarts:0});
    expect(f.controller.snapshot().policies[0]?.waitingReason).toBe('running_sessions');
  }finally{await f.close();}
});
test('an install made outside the updater is recorded and restarts idle pane sessions on the next check',async()=>{
  const f=await catalogUpdateFixture();
  try{
    await f.command({kind:'automation-settings',paneSessions:'restart-idle'});
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});
    f.fire();await f.controller.settled();
    expect(f.executions()).toBe(1);
    expect(f.controller.snapshot().policies[0]).toMatchObject({lastInstalledVersion:'2.0.0'});
    // Given a herdr-pane session on the catalog and a reinstall this app did not perform.
    f.setObservedPid(4242,'2026-01-01T00:00:00.000Z');f.setPane('idle');
    f.setInstalled('3.0.0');f.setLatest('3.0.0');
    // When the next check runs.
    f.fire(3_600_000);await f.controller.settled();
    // Then nothing is reinstalled, the outside install is recorded, and the idle session is resumed.
    expect(f.executions()).toBe(1);
    const external=f.controller.snapshot().catalogUpdates?.find(job=>job.requestId.startsWith('external:'));
    expect(external).toMatchObject({stage:'completed',beforeVersion:'2.0.0',installedVersion:'3.0.0',paneSessions:'restart-idle'});
    await f.observe(s=>(s.catalogUpdates??[]).some(job=>job.requestId.startsWith('external:')&&(job.paneResults??[]).some(row=>row.outcome==='completed')));
    expect(f.paneCalls).toContain('/exit');
    expect(f.controller.snapshot().policies[0]).toMatchObject({lastInstalledVersion:'3.0.0'});
    // And a later unchanged check does not replay it.
    f.fire(3_600_000);await f.controller.settled();
    expect((f.controller.snapshot().catalogUpdates??[]).filter(job=>job.requestId.startsWith('external:'))).toHaveLength(1);
  }finally{await f.close();}
});
test('a bound catalog install the worker dropped after an outside reinstall gets its pin baseline reset once per hour',async()=>{
  const f=await catalogUpdateFixture(false,'npm');
  try{
    await f.command({kind:'automation',installationId:'catalog:codex',enabled:true});
    f.fire();await f.controller.settled();
    const pinDir=join(f.root,'run','worker.catalog');mkdirSync(pinDir,{recursive:true});
    writeFileSync(join(pinDir,'auto-sources.json'),'{"version":2,"generation":1,"pins":[],"aliases":[]}');
    // Given the worker no longer lists the family while the app inventory still validates the bound install.
    f.hideInstallation();
    f.setRows([{id:'row',catalogId:'codex',manager:'npm',root:join(f.root,'owned'),packageName:'codex-pkg',path:f.executable(),identityPath:f.executable(),receiptId:null,version:'3.0.0',isDefault:true}]);
    f.setInstalled('3.0.0');f.setLatest('3.0.0');
    // When the next check runs.
    f.fire(3_600_000);await f.controller.settled();
    // Then the pin file is archived (not deleted) and the reset is recorded.
    expect(existsSync(join(pinDir,'auto-sources.json'))).toBe(false);
    expect(readdirSync(pinDir).filter(name=>name.startsWith('auto-sources.json.stale-'))).toHaveLength(1);
    expect(f.controller.snapshot().policies[0]?.lastRebaselineAt).toBe(1000+3_600_000);
    // And it does not repeat within the hour even if the worker still lists nothing.
    writeFileSync(join(pinDir,'auto-sources.json'),'{"version":2,"generation":2,"pins":[],"aliases":[]}');
    await f.command({kind:'refresh'});await f.controller.settled();
    expect(existsSync(join(pinDir,'auto-sources.json'))).toBe(true);
  }finally{await f.close();}
});
test('catalog policies reject unsupported restart and check modes',async()=>{
  const f=await catalogUpdateFixture();
  try{
    await expect(f.command({kind:'policy',installationId:'catalog:codex',mode:'update-and-restart',intervalMinutes:5})).rejects.toThrow('catalog_policy_unsupported');
    expect(f.controller.snapshot().policies).toHaveLength(0);
  }finally{await f.close();}
});

async function fixture(holdPreparation = false, catalog?: typeof createCatalog, observedExecutable = "OmO", connectionFailures=0, updates?:typeof createCatalogUpdates, latest?:typeof latestCatalogVersion, savedPolicy?:UpdatePolicy, native?:typeof createNativeRestarts) {
  const root = realpathSync(mkdtempSync("/tmp/app-controller-"));
  if(savedPolicy){const store=new AppStore(root);store.putPolicy(savedPolicy);store.close();}
  let now = 1000, sequence = 0;
  const timers = new Map<number, {at:number;callback:()=>void}>();
  let timerId=0,connectionCalls=0,connected=false;
  const calls = { checks: 0, preparations: 0, updates: 0, cancellations: 0 };
  let observedPid: number | null = null, observationFails = false;
  let observedStart: string | null = null;
  let observedInstallationId: string | null = null;
  let paneStatus: "idle" | "working" | "blocked" | null = null;
  const paneCalls: string[] = [];
  let panePid = 0, screenReads = 0, engineActivity = true, cpuSamples = 0;
  const paneAgent = (pids: number[]) => paneStatus === null ? null : ({ paneId: "w1:p1", workspaceId: "w1", terminalId: "t", agent: "pi",
    status: paneStatus, stateChangeSeq: 1, cwd: null, title: null, foregroundPids: pids });
  const executableSelections=new Map<string,string>();
  let herdrExecutableError:Error|null=null;
  const herdr = {
    executable:async(kind:string)=>{if(herdrExecutableError)throw herdrExecutableError;return executableSelections.get(kind)??null;},
    selectExecutable:async(kind:string,executable:string|null)=>{if(executable===null)executableSelections.delete(kind);else executableSelections.set(kind,executable);},
    socketPath: "/fake",
    agents: async () => { const row = paneAgent([observedPid ?? 0]); return row ? [row] : []; },
    agent: async () => paneAgent(panePid === -1 ? [] : [panePid || (observedPid ?? 0)]),
    foregroundPids: async () => panePid === -1 ? [] : [panePid || (observedPid ?? 0)],
    // Before the exit command the pane shows an idle prompt; after it, the resume hint.
    read: async () => { screenReads++; return panePid === -1 ? "To resume this session: omo --session 01a1300b-f131-7cf3-a037-7bf50e61a5f4" : "done\n──\n❯\n──\nstatus"; },
    sendLine: async (_pane: string, line: string) => { paneCalls.push(line); if (line === "/exit") panePid = -1; else panePid = 999; },
    wait: async (_pane: string, until: readonly string[]) => { paneCalls.push(`wait:${until.join("|")}`); paneStatus = "idle"; return paneAgent([observedPid ?? 0]); },
  };
  let installationVisible = true;
  const effects = { stops: 0, restarts: 0 };
  let failRestartId:string|null=null;
  const gates = new Map<string, { entered: () => void; released: Promise<void> }>();
  async function boundary(name: string) {
    const gate = gates.get(name);
    if (gate) { gates.delete(name); gate.entered(); await gate.released; }
  }
  let installation: Installation = {
    installationId: "fixture", family: "omo", channel: "stable",
    executableRealpath: join(import.meta.dir, "fixtures/managed-rpc.ts"),
    resourcesFingerprint: "fixture", resources: [], owner: { kind: "unknown", reason: "unverified_owner" },
    installedVersion: { kind: "known", version: "1.0.0" }, lastCheck: null,
  };
  let jobs: Job[] = [], holdTargets = false;
  const targetGate = Promise.withResolvers<void>(), targetCalls = Promise.withResolvers<void>();
  let waitingTargets = 0;
  const engine: typeof createEngine = options => ({
    directory: root, connect: async () => {
      connectionCalls++;await boundary('connection');
      if(connectionCalls<=connectionFailures)throw new AppError('unavailable','worker_unavailable');
      connected=true;
    }, close: async () => {},
    installations: async () => { if(!connected)throw new AppError('unavailable','worker_unavailable');await boundary("installations"); return installationVisible ? [installation] : []; },
    check: async (): Promise<CheckResult> => {
      calls.checks++;
      const result: CheckResult = installation.installedVersion.kind === "known" && installation.installedVersion.version === "2.0.0"
        ? { kind: "up-to-date", installedVersion: "2.0.0", checkedAt: now }
        : { kind: "update-available", installedVersion: "1.0.0", availableVersion: "2.0.0", checkedAt: now };
      installation = { ...installation, lastCheck: { checkedAt: now, result } };
      return result;
    },
    targets: async (): Promise<SelectionMetadata> => {
      await boundary("targets");
      const capability = { kind: "supported", reason: "verified", evidenceRef: "unit-fixture" } as const;
      const result: SelectionMetadata = { installation, update: capability, readiness: capability, targets: [] };
      if (holdTargets) {
        if (++waitingTargets === 2) targetCalls.resolve();
        await targetGate.promise;
      }
      return result;
    },
    jobs: async () => jobs,
    prepare: async (_installation, signal): Promise<Preparation> => {
      calls.preparations++;
      await boundary("preparation");
      if (holdPreparation) await new Promise<never>((_resolve, reject) => {
        const cancel = () => { calls.cancellations++; reject(new AppError("conflict")); };
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
      return { kind: "prepared", configuration: { path: join(root, "fixture.json"), sha256: "0".repeat(64) },
        targetVersion: "2.0.0", beforeVersion: { kind: "known", version: "1.0.0" } };
    },
    activate: async () => { await boundary("activation"); },
    update: async (selected, requestId): Promise<Job> => {
      calls.updates++;
      installation = { ...installation, installedVersion: { kind: "known", version: "2.0.0" } };
      const job: Job = { jobId: "job", requestId, revision: 1, mode: "update-only", selectedTargets: [], targetTxns: [],
        failure: null, status: "completed", installTxn: {
          selection: { installationId: selected.installationId, resourcesFingerprint: selected.resourcesFingerprint,
            owner: selected.owner, installedVersion: selected.installedVersion },
          state: "succeeded", failure: null, receipt: { kind: "completed", operationId: "update", effect: "updated", identity: null },
        } };
      jobs = [job]; options.onChange(); return job;
    },
  });
  const controller = await createController({ directory: root, home: root, path: "", prefixes: [],
    managedEnv: { FIXTURE_MODE: "normal",FIXTURE_PROTOCOL_BLOCK:join(root,'protocol-block') },
    clock: { now: () => now, schedule: (at, callback) => {const id=++timerId;timers.set(id,{at,callback});return()=>{timers.delete(id);};} },
  }, { engine, ...(native?{native}:{}), ...(catalog ? { catalog } : {}), ...(updates?{updates}:{}), ...(latest?{latest}:{}), observe: (_installations, _managed, _cwd, _catalog, context) => {
    if (observationFails) throw new AppError("unavailable", "process_observation_unavailable");
    const current = context?.currentConversation ?? null;
    const pid = panePid > 0 ? panePid : observedPid;
    return pid === null ? [] : [{ id: `external:${pid}`, pid,
      family: 'omo', catalogId: 'codex', installationId: observedInstallationId, executable: observedExecutable, cwd: null,
      startedAt: panePid > 0 ? '2026-10-13T12:00:00.000Z' : observedStart, runningVersion: null, control: "observation-only",
      ...(paneStatus ? { conversation: { id: '01a1300b-f131-7cf3-a037-7bf50e61a5f4', path: '/fixture/session.jsonl', title: null },
        omoSocket: '/fixture/tui.sock', runningEngineVersion: '2026.10.12' } : {}),
      isCurrentConversation: current !== null && current.pid === observedPid && current.startedAt === observedStart,
      ...(paneStatus !== null && panePid !== -1 ? { herdrPane: { paneId: "w1:p1", status: paneStatus, stateChangeSeq: 1,
        screenIdle: (() => { const screen = context?.paneScreens?.get("w1:p1"); return screen === undefined ? null : screenLooksIdle(screen); })(),
        cpuPercent: context?.cpuPercent?.get(pid) ?? null, cpuQuiet: context?.cpuQuiet?.get(pid) ?? null }, control: "herdr-pane" as const } : {}) }];
  }, herdr, omoState: async () => ({sessionId:'01a1300b-f131-7cf3-a037-7bf50e61a5f4',sessionFile:'/fixture/session.jsonl',
    isStreaming:paneStatus==='working',isCompacting:false,isBashRunning:false,pendingMessageCount:0,
    ...(engineActivity?{hasSessionWork:false,hasActiveWakeSource:false}:{})}),
  cpuTimes: pids => { cpuSamples++; return pids.map(pid => `${pid} 0:00.10`).join("\n"); }, sessionFileExists: () => true,
  panePause: async () => { now += 250; }, paneAlive: pid => pid !== (observedPid ?? -1) || panePid !== -1, managed: options => {
    const manager = createManagedSessions(options);
    return { ...manager,
      stop: (...args) => { effects.stops++; return manager.stop(...args); },
      restart: async (...args) => {
        effects.restarts++;
        if(args[0]===failRestartId)writeFileSync(join(root,'protocol-block'),'blocked');
        try{return await manager.restart(...args);}
        finally{rmSync(join(root,'protocol-block'),{force:true});}
      },
    };
  } });
  function observe(predicate: (value: AppSnapshot) => boolean): Promise<AppSnapshot> {
    const result = Promise.withResolvers<AppSnapshot>();
    const timer = setTimeout(() => { dispose(); result.reject(new Error("state_timeout")); }, 3000);
    const check = () => {
      const value = controller.snapshot();
      if (predicate(value)) { clearTimeout(timer); dispose(); result.resolve(value); }
    };
    const dispose = controller.subscribe(check); check();
    return result.promise;
  }
  return {
    root, controller, calls, effects, observe, executableSelections,
    connections:()=>connectionCalls,timerCount:()=>timers.size,
    failRestart(id:string|null){failRestartId=id;},
    failHerdrExecutable(error:Error|null){herdrExecutableError=error;},
    setObservedPid(pid: number | null, startedAt: string | null = null, installationId: string | null = null) { observedPid = pid; observedStart = startedAt; observedInstallationId = installationId; observationFails = false; },
    setPane(status: "idle" | "working" | "blocked" | null) { paneStatus = status; panePid = 0; },
    paneCalls, screenReads: () => screenReads, cpuSamples: () => cpuSamples,
    engineWithoutActivity() { engineActivity = false; },
    failObservation() { observationFails = true; },
    pause(name: "installations" | "targets" | "preparation" | "activation" | "connection") {
      const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
      const timeout = setTimeout(() => entered.reject(new Error(`boundary_timeout:${name}`)), 3000);
      gates.set(name, { entered: entered.resolve, released: released.promise });
      return { entered: entered.promise.finally(() => clearTimeout(timeout)), release: released.resolve, reject: released.reject };
    },
    setVersion(value: string) { installation = { ...installation, installedVersion: { kind: "known", version: value } }; },
    hideInstallation() { installationVisible = false; },
    setFamily(family:Installation['family']) { installation={...installation,family}; },
    command: (command: AppCommand, requestId = `request-${++sequence}`) => controller.command({ requestId, command }),
    fire(advance = 0) { now += advance; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
    holdTargets() { holdTargets = true; return { entered: targetCalls.promise, release: () => targetGate.resolve() }; },
    async close() { await controller.close(); rmSync(root, { recursive: true }); },
  };
}

test('explicit concurrent refresh recovers failed initialization with one connection and one observation timer',async()=>{
  const f=await fixture(false,undefined,'OmO',1);
  try{
    expect(f.controller.snapshot().service).toBe('unavailable');
    expect(f.connections()).toBe(1);expect(f.timerCount()).toBe(0);
    const gate=f.pause('connection');
    const first=f.command({kind:'refresh'});
    await gate.entered;
    const second=f.command({kind:'refresh'});
    expect(f.controller.snapshot().service).toBe('connecting');
    expect(f.connections()).toBe(2);
    gate.release();await Promise.all([first,second]);
    expect(f.controller.snapshot().service).toBe('ready');
    expect(f.timerCount()).toBe(1);expect(f.connections()).toBe(2);
    await f.command({kind:'refresh'});
    expect(f.timerCount()).toBe(1);expect(f.connections()).toBe(2);
    await f.command({kind:'policy',installationId:'fixture',mode:'check',intervalMinutes:5,firstCheck:'after-interval'});
    expect(f.timerCount()).toBe(2);
    f.fire(300000);await f.controller.settled();
    expect(f.calls.checks).toBe(1);expect(f.timerCount()).toBe(2);
  }finally{await f.close();}
});
test('after a verified update, an engine that exposes no activity signal still restarts an idle pane through the screen rule',async()=>{
  const f=await fixture();f.engineWithoutActivity();try{
    f.setObservedPid(456,'2026-10-12T09:00:00.000Z','fixture');f.setPane('idle');
    for(let i=0;i<4;i++){f.fire(15000);await f.controller.settled();}
    expect(f.controller.snapshot().external[0]?.herdrPane).toMatchObject({screenIdle:true,cpuQuiet:true});
    await f.command({kind:'policy',installationId:'fixture',mode:'off',intervalMinutes:60,firstCheck:'now',paneSessions:'restart-idle'});
    await f.command({kind:'check',installationId:'fixture'});
    const ready=f.observe(value=>value.operations[0]?.stage==='ready');
    await f.command({kind:'prepare',installationId:'fixture'});
    const operation=(await ready).operations[0];if(!operation)throw new Error('missing_operation');
    const settled=f.observe(value=>value.operations[0]?.stage==='completed'&&(value.operations[0].paneResults??[]).every(row=>row.outcome!=='pending'));
    await f.command({kind:'confirm',operationId:operation.id,revision:operation.revision,sessions:[],restart:false});
    const final=(await settled).operations[0];
    expect(final?.paneResults?.[0]).toMatchObject({outcome:'completed'});
    expect(f.paneCalls).toEqual(['/exit','omo --session 01a1300b-f131-7cf3-a037-7bf50e61a5f4']);
  }finally{await f.close();}
});
test('a batch restart reviews every pane before the first input and then restarts each pane in turn',async()=>{
  const f=await fixture();f.engineWithoutActivity();try{
    f.setObservedPid(456,'2026-10-12T09:00:00.000Z','fixture');f.setPane('idle');
    for(let i=0;i<4;i++){f.fire(15000);await f.controller.settled();}
    const session=f.controller.snapshot().external[0];if(!session?.herdrPane)throw new Error('missing_pane');
    await expect(f.command({kind:'pane-restart-batch',items:[{sessionId:session.id,paneId:session.herdrPane.paneId},{sessionId:'external:999',paneId:'w1:p9'}],trustScreen:true})).rejects.toThrow('pane_changed');
    expect(f.paneCalls).toEqual([]);
    const done=f.observe(value=>(value.paneRestarts??[]).some(job=>job.sessionId===session.id&&['completed','failed'].includes(job.stage)));
    await f.command({kind:'pane-restart-batch',items:[{sessionId:session.id,paneId:session.herdrPane.paneId}],trustScreen:true});
    const job=(await done).paneRestarts?.find(job=>job.sessionId===session.id);
    expect(job).toMatchObject({stage:'completed',previousPid:456});
    expect(f.paneCalls).toEqual(['/exit','omo --session 01a1300b-f131-7cf3-a037-7bf50e61a5f4']);
  }finally{await f.close();}
});
test('an update check re-reads installed versions first so a change made outside the app is not compared stale',async()=>{
  // Given: the disk version changed since the last inventory (an update done outside the app).
  const root=realpathSync(mkdtempSync('/tmp/catalog-recheck-'));const executable=join(root,'omo');writeFileSync(executable,'');
  let diskVersion='1.0.0',refreshes=0;
  const catalog:typeof createCatalog=()=>({entries:()=>[{id:'omo',name:'OmO',description:{ko:'',en:''},executable:'omo',sourceUrl:'https://example.test',method:'npm',availability:'installable',reason:null,
      installed:{path:executable,version:diskVersion,managed:false}}],refresh:()=>{refreshes++;diskVersion='0.9.0';},busy:()=>false,settled:async()=>{},
    recover:async()=>{throw new AppError('unsupported');},select:async()=>{throw new AppError('unsupported');},plan:async()=>{throw new AppError('unsupported');},confirm:async()=>{throw new AppError('unsupported');}});
  const f=await fixture(false,catalog,executable,0,undefined,async()=>'1.0.0');
  try{
    const before=refreshes;
    const checked=f.observe(value=>value.catalogBulk?.stage==='completed');
    await f.command({kind:'catalog-check-all'});
    const item=(await checked).catalogBulk?.items.find(row=>row.catalogId==='omo');
    expect(refreshes).toBeGreaterThan(before);
    // The comparison baseline is the re-read disk version, not the one from service start.
    expect(item).toMatchObject({beforeVersion:'0.9.0'});
  }finally{await f.close();rmSync(root,{recursive:true,force:true});}
});
test('two observations inside one second keep the previous cpu reading instead of clearing it',async()=>{
  const f=await fixture();try{
    f.setObservedPid(456,'2026-10-12T09:00:00.000Z','fixture');f.setPane('idle');
    for(let i=0;i<4;i++){f.fire(15000);await f.controller.settled();}
    expect(f.controller.snapshot().external[0]?.herdrPane).toMatchObject({cpuQuiet:true});
    f.fire(100);await f.controller.settled();
    expect(f.controller.snapshot().external[0]?.herdrPane).toMatchObject({cpuQuiet:true});
  }finally{await f.close();}
});
test('the periodic observation re-reads pane screens so a pane that appears after startup gets its screen hint',async()=>{
  const f=await fixture();try{
    f.setObservedPid(300,'2026-10-13T12:00:00.000Z');f.setPane('idle');
    const before=f.screenReads();
    f.fire(15000);await f.controller.settled();
    expect(f.screenReads()).toBeGreaterThan(before);
  }finally{await f.close();}
});
test('another failed reconnect leaves no timers and a later explicit retry still works',async()=>{
  const f=await fixture(false,undefined,'OmO',2);
  try{
    await expect(f.command({kind:'refresh'})).rejects.toThrow('worker_unavailable');
    expect(f.controller.snapshot()).toMatchObject({service:'unavailable',failure:'worker_unavailable'});
    expect(f.timerCount()).toBe(0);
    await f.command({kind:'refresh'});
    expect(f.controller.snapshot().service).toBe('ready');
    expect(f.connections()).toBe(3);expect(f.timerCount()).toBe(1);
  }finally{await f.close();}
});

test('snapshots refresh catalog-only correlation without recursive notifications or engine control', async () => {
  // Given: fresh catalog discovery can change independently of the process observation timer.
  const root = realpathSync(mkdtempSync('/tmp/catalog-observation-'));
  const executable = join(root, 'omo'); writeFileSync(executable, '');
  let entries: readonly CatalogEntry[] = [], announce = () => {};
  const catalog: typeof createCatalog = options => {
    announce = options.changed;
    return { entries: () => entries, refresh: () => {}, busy: () => false, settled: async () => {},
      recover:async()=>{throw new AppError('unsupported');},
      select:async()=>{throw new AppError('unsupported');},
      plan: async() => { throw new AppError('unsupported'); }, confirm: async() => { throw new AppError('unsupported'); } };
  };
  const f = await fixture(false, catalog, executable);
  try {
    f.setObservedPid(456); f.fire(15000);
    expect(f.controller.snapshot().external[0]?.catalogId).toBeNull();
    let notifications = 0;
    const dispose = f.controller.subscribe(() => { notifications++; f.controller.snapshot(); });
    // When
    entries = [{ id: 'omo', name: 'OmO', description: { ko: 'OmO', en: 'OmO' }, executable: 'omo',
      sourceUrl: 'https://example.test', method: 'manual', availability: 'manual', reason: null,
      installed: { path: executable, version: '99.0.0', managed: false } }];
    announce();
    // Then
    expect(f.controller.snapshot().external[0]).toMatchObject({ catalogId: 'omo', installationId: null,
      runningVersion: null, control: 'observation-only' });
    expect(notifications).toBe(1);
    await expect(f.command({ kind: 'launch', installationId: 'omo', cwd: f.root })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.calls.updates).toBe(0); expect(f.effects).toEqual({ stops: 0, restarts: 0 });
    entries = []; announce();
    expect(f.controller.snapshot().external[0]?.catalogId).toBeNull();
    expect(notifications).toBe(2); dispose();
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("duplicate launch stays single and restart waits for work before preserving the conversation", async () => {
  // Given: a real JSONL child, with only installation lookup stubbed.
  const f = await fixture();
  try {
    const first = await f.command({ kind: "launch", installationId: "fixture", cwd: f.root }, "launch");
    const session = first.managed[0];
    if (!session) throw new Error("missing_session");
    await f.command({ kind: "launch", installationId: "fixture", cwd: f.root }, "launch");
    expect(f.controller.snapshot().managed).toHaveLength(1);
    const waiting = f.observe(value => value.managed[0]?.state === "waiting");
    await f.command({ kind: "send", sessionId: session.id, generation: 1, message: "work" });
    await waiting;
    // When: restart is requested during an outstanding approval.
    await f.command({ kind: "restart", sessionId: session.id, generation: 1 });
    expect(f.controller.snapshot().operations[0]?.stage).toBe("waiting");
    expect(f.controller.snapshot().managed[0]?.pid).toBe(session.pid);
    const completed = f.observe(value => value.operations[0]?.stage === "completed");
    await f.command({ kind: "respond", sessionId: session.id, generation: 1, approvalId: "approval-1", value: false });
    const after = await completed;
    // Then: the same conversation lives in precisely one fresh owned process.
    expect(after.managed[0]).toMatchObject({ durableSessionId: session.durableSessionId, generation: 2, state: "ready" });
    expect(after.managed[0]?.pid).not.toBe(session.pid);
  } finally { await f.close(); }
});

test("fresh launch records the installed version instead of an older page snapshot", async () => {
  const f = await fixture();
  try {
    f.setVersion("2.0.0");
    const after = await f.command({ kind: "launch", installationId: "fixture", cwd: f.root });
    expect(after.managed[0]).toMatchObject({ launchedVersion: "2.0.0", engineVersion: "engine-7" });
  } finally { await f.close(); }
});

test("automatic update resumes a quiet conversation once and later checks do not replay it", async () => {
  const f = await fixture();
  try {
    const before = await f.command({ kind: "launch", installationId: "fixture", cwd: f.root });
    await f.command({ kind: "policy", installationId: "fixture", mode: "update-and-restart", intervalMinutes: 5 });
    const completed = f.observe(value => value.operations[0]?.stage === "completed");
    f.fire();
    const after = await completed;
    expect(after.managed[0]).toMatchObject({ generation: 2, durableSessionId: before.managed[0]?.durableSessionId,
      launchedVersion: "2.0.0", state: "ready" });
    expect(after.operations[0]?.installedAt).toBe(1000);
    expect(after.managed[0]?.pid).not.toBe(before.managed[0]?.pid);
    const checked = f.observe(value => value.policies[0]?.lastCheckedAt === 301000);
    f.fire(300000); await checked;
    expect(f.calls).toMatchObject({ checks: 2, preparations: 1, updates: 1 });
    expect(f.controller.snapshot().operations[0]?.installedAt).toBe(1000);
  } finally { await f.close(); }
});

test("partial multi-session restart resumes only the failed target and preserves successful evidence", async () => {
  const f=await fixture();
  try{
    await f.command({kind:'launch',installationId:'fixture',cwd:f.root});
    const launched=await f.command({kind:'launch',installationId:'fixture',cwd:f.root});
    const [first,second]=launched.managed;if(!first||!second)throw new Error('missing sessions');
    f.failRestart(second.id);
    await f.command({kind:'policy',installationId:'fixture',mode:'update-and-restart',intervalMinutes:5});
    const uncertain=f.observe(value=>value.operations[0]?.stage==='uncertain');
    f.fire();await uncertain;await f.controller.settled();
    const partial=f.controller.snapshot();
    expect(f.effects.restarts).toBe(2);
    const successful=partial.managed.find(row=>row.id===first.id);
    expect(successful).toMatchObject({state:'ready',generation:2,durableSessionId:first.durableSessionId});
    expect(partial.managed.find(row=>row.id===second.id)).toMatchObject({state:'failed',pid:null,generation:2});
    const installedAt=partial.operations[0]?.installedAt;
    f.failRestart(null);
    // When: explicit refresh reconciles the completed install and remaining restart.
    const after=await f.command({kind:'refresh'});await f.controller.settled();
    expect(after.operations[0]?.stage).toBe('completed');
    expect(after.operations[0]?.installedAt).toBe(installedAt);
    expect(after.managed.find(row=>row.id===first.id)).toMatchObject({pid:successful?.pid,generation:2,durableSessionId:first.durableSessionId});
    expect(after.managed.find(row=>row.id===second.id)).toMatchObject({state:'ready',generation:3,durableSessionId:second.durableSessionId});
    expect(f.effects.restarts).toBe(3);expect(f.calls.updates).toBe(1);
    await f.command({kind:'refresh'});
    expect(f.effects.restarts).toBe(3);
    // Completion reopens admission; the already resumed conversation remains usable.
    const waiting=f.observe(value=>value.managed.find(row=>row.id===first.id)?.state==='waiting');
    await f.command({kind:'send',sessionId:first.id,generation:2,message:'continue'});await waiting;
    const ready=f.observe(value=>value.managed.find(row=>row.id===first.id)?.state==='ready');
    await f.command({kind:'respond',sessionId:first.id,generation:2,approvalId:'approval-1',value:false});await ready;
  }finally{await f.close();}
});

test("cancelled waiting restart reopens message admission without ending the session", async () => {
  const f = await fixture();
  try {
    const launched = await f.command({ kind: "launch", installationId: "fixture", cwd: f.root });
    const session = launched.managed[0];
    if (!session) throw new Error("missing_session");
    const waiting = f.observe(value => value.managed[0]?.state === "waiting");
    await f.command({ kind: "send", sessionId: session.id, generation: 1, message: "work" }); await waiting;
    const pending = await f.command({ kind: "restart", sessionId: session.id, generation: 1 });
    const operation = pending.operations[0];
    if (!operation) throw new Error("missing_operation");
    await f.command({ kind: "cancel", operationId: operation.id, revision: operation.revision });
    const quiet = f.observe(value => value.managed[0]?.state === "ready");
    await f.command({ kind: "respond", sessionId: session.id, generation: 1, approvalId: "approval-1", value: false }); await quiet;
    const second = f.observe(value => value.managed[0]?.state === "waiting");
    await f.command({ kind: "send", sessionId: session.id, generation: 1, message: "new work" }); await second;
    expect(f.controller.snapshot().managed[0]?.pid).toBe(session.pid);
    const finished = f.observe(value => value.managed[0]?.state === "ready");
    await f.command({ kind: "respond", sessionId: session.id, generation: 1, approvalId: "approval-1", value: false }); await finished;
  } finally { await f.close(); }
});

test("a failed fresh lookup leaves the running conversation usable without an uncertain stop", async () => {
  const f = await fixture();
  try {
    const launched = await f.command({ kind: "launch", installationId: "fixture", cwd: f.root });
    const session = launched.managed[0];
    if (!session) throw new Error("missing_session");
    const waiting = f.observe(value => value.managed[0]?.state === "waiting");
    await f.command({ kind: "send", sessionId: session.id, generation: 1, message: "work" }); await waiting;
    await f.command({ kind: "restart", sessionId: session.id, generation: 1 });
    f.hideInstallation();
    const failed = f.observe(value => value.operations[0]?.stage === "failed");
    await f.command({ kind: "respond", sessionId: session.id, generation: 1, approvalId: "approval-1", value: false });
    const after = await failed;
    expect(after.managed[0]).toMatchObject({ pid: session.pid, state: "ready", generation: 1 });
    const resumed = f.observe(value => value.managed[0]?.state === "waiting");
    await f.command({ kind: "send", sessionId: session.id, generation: 1, message: "continue" }); await resumed;
    const quiet = f.observe(value => value.managed[0]?.state === "ready");
    await f.command({ kind: "respond", sessionId: session.id, generation: 1, approvalId: "approval-1", value: false }); await quiet;
  } finally { await f.close(); }
});

test("check policy schedules observations but never prepares or updates", async () => {
  const f = await fixture();
  try {
    await f.command({ kind: "policy", installationId: "fixture", mode: "check", intervalMinutes: 5 });
    const checked = f.observe(value => value.policies[0]?.lastCheckedAt === 1000);
    f.fire(); await checked;
    const repeated = f.observe(value => value.policies[0]?.lastCheckedAt === 301000);
    f.fire(300000); await repeated;
    expect(f.calls).toEqual({ checks: 2, preparations: 0, updates: 0, cancellations: 0 });
  } finally { await f.close(); }
});

test("first automatic check waits for the selected interval and off cancels future checks", async () => {
  const f = await fixture();
  try {
    // Given: an explicitly delayed first check.
    const scheduled = await f.command({ kind: "policy", installationId: "fixture", mode: "check",
      intervalMinutes: 5, firstCheck: "after-interval" });
    expect(scheduled.policies[0]?.nextCheckAt).toBe(301000);
    f.fire(299999);
    await f.controller.settled();
    expect(f.calls.checks).toBe(0);
    // When: the deadline arrives, then the user switches automation off.
    const checked = f.observe(value => value.policies[0]?.lastCheckedAt === 301000);
    f.fire(1); await checked;
    const disabled = await f.command({ kind: "policy", installationId: "fixture", mode: "off",
      intervalMinutes: 5, firstCheck: "after-interval" });
    f.fire(600000); await f.controller.settled();
    // Then: the observed check remains visible and no later work is dispatched.
    expect(disabled.policies[0]).toMatchObject({ lastCheckedAt: 301000, nextCheckAt: null, mode: "off" });
    expect(f.calls).toEqual({ checks: 1, preparations: 0, updates: 0, cancellations: 0 });
  } finally { await f.close(); }
});

test("process observation refreshes without clicks and marks stale data on failure", async () => {
  const f = await fixture();
  try {
    // Given: an external terminal appears after service initialization.
    f.setObservedPid(456);
    // When: the read-only observation deadline runs, followed by an unavailable census.
    f.fire(15000);
    expect(f.controller.snapshot()).toMatchObject({ observedAt: 16000, observationFailure: null,
      external: [{ pid: 456, runningVersion: null }] });
    f.failObservation();
    f.fire(15000);
    // Then: old data is explicitly stale, never represented as a fresh empty list.
    expect(f.controller.snapshot()).toMatchObject({ observedAt: 16000,
      observationFailure: "process_observation_unavailable", external: [{ pid: 456, processState: "unknown" }] });
    f.setObservedPid(456, "2026-10-12T12:00:00.000Z");
    f.fire(15000);
    expect(f.controller.snapshot().external.map(row => [row.pid, row.processState])).toEqual([
      [456, "observed"], [456, "exited"],
    ]);
    f.fire(15000);
    expect(f.controller.snapshot().external).toHaveLength(1);
    f.setObservedPid(null);
    f.fire(15000);
    expect(f.controller.snapshot().external).toMatchObject([{ pid: 456, processState: "exited" }]);
    f.fire(15000);
    expect(f.controller.snapshot().external).toEqual([]);
    expect(f.calls.updates).toBe(0);
  } finally { await f.close(); }
});

test("reopening the service rebinds the current conversation to the relaunched CLI PID", async () => {
  const f = await fixture();
  try {
    // Given: the CLI that opened the service was relaunched (omo -r) under a new PID.
    f.setObservedPid(789, "2026-10-12T10:03:44.000Z");
    f.fire(15000);
    expect(f.controller.snapshot().external).toMatchObject([{ pid: 789, isCurrentConversation: false }]);
    // When: the next `open` supplies the freshly captured conversation context.
    f.controller.bindCurrentConversation({ pid: 789, startedAt: "2026-10-12T10:03:44.000Z", id: "conversation", path: "/tmp/conversation.jsonl" });
    // Then: the badge moves without waiting for the periodic observation.
    expect(f.controller.snapshot().external).toMatchObject([{ pid: 789, isCurrentConversation: true }]);
    f.controller.bindCurrentConversation(null);
    expect(f.controller.snapshot().external).toMatchObject([{ pid: 789, isCurrentConversation: false }]);
  } finally { await f.close(); }
});

test("turn completion wakes deferred automation and disabling it aborts preparation", async () => {
  const f = await fixture(true);
  try {
    const launched = await f.command({ kind: "launch", installationId: "fixture", cwd: f.root });
    const session = launched.managed[0];
    if (!session) throw new Error("missing_session");
    const waiting = f.observe(value => value.managed[0]?.state === "waiting");
    await f.command({ kind: "send", sessionId: session.id, generation: 1, message: "work" }); await waiting;
    await f.command({ kind: "policy", installationId: "fixture", mode: "update-and-restart", intervalMinutes: 5 });
    const deferred = f.observe(value => value.policies[0]?.waitingReason === "work_active");
    f.fire(); await deferred;
    expect(f.calls.preparations).toBe(0);
    const quiet = f.observe(value => value.managed[0]?.state === "ready");
    await f.command({ kind: "respond", sessionId: session.id, generation: 1, approvalId: "approval-1", value: false }); await quiet;
    const preparing = f.observe(value => value.operations[0]?.stage === "preparing");
    f.fire(); await preparing;
    await f.command({ kind: "policy", installationId: "fixture", mode: "off", intervalMinutes: 5 });
    expect(f.controller.snapshot().operations[0]?.stage).toBe("cancelled");
    expect(f.calls).toMatchObject({ preparations: 1, cancellations: 1, updates: 0 });
    expect(f.controller.snapshot().managed[0]?.pid).toBe(session.pid);
  } finally { await f.close(); }
});

test("concurrent confirmations cannot overwrite an admitted revision or dispatch another update", async () => {
  const f = await fixture();
  try {
    await f.command({ kind: "check", installationId: "fixture" });
    const ready = f.observe(value => value.operations[0]?.stage === "ready");
    await f.command({ kind: "prepare", installationId: "fixture" });
    const operation = (await ready).operations[0];
    if (!operation) throw new Error("missing_operation");
    const gate = f.holdTargets();
    const completed = f.observe(value => value.operations[0]?.stage === "completed");
    const action = { kind: "confirm", operationId: operation.id, revision: operation.revision, sessions: [], restart: false } as const;
    const first = f.command(action), second = f.command(action);
    const outcomes = Promise.allSettled([first, second]);
    await gate.entered; gate.release();
    const result = await outcomes; await completed;
    expect(result.map(row => row.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.calls.updates).toBe(1);
    expect(f.controller.snapshot().operations[0]?.installedVersion).toBe("2.0.0");
  } finally { await f.close(); }
});

test.each([
  ["restart-idle", "idle", "completed", ["/exit", "omo --session 01a1300b-f131-7cf3-a037-7bf50e61a5f4"]],
  ["restart-idle", "working", "skipped-working", []],
  ["restart-all", "working", "completed", ["wait:idle|done|blocked", "/exit", "omo --session 01a1300b-f131-7cf3-a037-7bf50e61a5f4"]],
  ["restart-idle", "blocked", "skipped-blocked", []],
  ["keep", "idle", null, []],
] as const)("after a verified update, pane sessions follow the %s policy when the agent is %s", async (policy, status, outcome, calls) => {
  const f = await fixture();
  try {
    // Given: a herdr-pane session on the installation, and the installation's pane policy.
    f.setObservedPid(456, "2026-10-12T09:00:00.000Z", "fixture"); f.setPane(status);
    f.fire(15000);
    await f.command({ kind: "policy", installationId: "fixture", mode: "off", intervalMinutes: 60, firstCheck: "now", paneSessions: policy });
    await f.command({ kind: "check", installationId: "fixture" });
    const ready = f.observe(value => value.operations[0]?.stage === "ready");
    await f.command({ kind: "prepare", installationId: "fixture" });
    const operation = (await ready).operations[0];
    if (!operation) throw new Error("missing_operation");
    // When: the update is confirmed without choosing explicitly (installation policy applies) and completes.
    const settled = f.observe(value => value.operations[0]?.stage === "completed"
      && (value.operations[0].paneResults ?? []).every(row => row.outcome !== "pending"));
    await f.command({ kind: "confirm", operationId: operation.id, revision: operation.revision, sessions: [], restart: false });
    const final = (await settled).operations[0];
    // Then
    expect(final).toMatchObject({ installedVersion: "2.0.0", paneSessions: policy });
    expect(final?.paneResults?.map(row => row.outcome) ?? []).toEqual(outcome === null ? [] : [outcome]);
    expect(f.paneCalls).toEqual([...calls]);
    expect(f.effects.stops).toBe(0);
  } finally { await f.close(); }
});

test("global-first: an external session on the installation no longer blocks the update and is recorded, never stopped", async () => {
  const f = await fixture();
  try {
    // Given: a terminal-launched session uses the managed installation.
    f.setObservedPid(456, "2026-10-12T09:00:00.000Z", "fixture");
    f.fire(15000);
    await f.command({ kind: "check", installationId: "fixture" });
    const ready = f.observe(value => value.operations[0]?.stage === "ready");
    await f.command({ kind: "prepare", installationId: "fixture" });
    const operation = (await ready).operations[0];
    if (!operation) throw new Error("missing_operation");
    // When: the update is confirmed with no managed sessions selected.
    const completed = f.observe(value => value.operations[0]?.stage === "completed");
    await f.command({ kind: "confirm", operationId: operation.id, revision: operation.revision, sessions: [], restart: false });
    await completed;
    // Then: the installation updated first; the external session is recorded on the operation and still observed.
    const snapshot = f.controller.snapshot();
    expect(snapshot.operations[0]).toMatchObject({ installedVersion: "2.0.0", externalSessionIds: ["external:456"] });
    expect(snapshot.external).toMatchObject([{ pid: 456, processState: "observed" }]);
    expect(f.effects.stops).toBe(0);
    expect(f.calls.updates).toBe(1);
  } finally { await f.close(); }
});

test.each([
  { kind: "restart", reject: false }, { kind: "restart", reject: true },
  { kind: "update", reject: false }, { kind: "update", reject: true },
] as const)("accepted cancellation remains terminal across fresh lookup: %j", async scenario => {
  const f = await fixture();
  let gate: ReturnType<typeof f.pause> | undefined;
  try {
    const session = (await f.command({ kind: "launch", installationId: "fixture", cwd: f.root })).managed[0];
    if (!session) throw new Error("missing_session");
    if (scenario.kind === "update") {
      await f.command({ kind: "check", installationId: "fixture" });
      await f.command({ kind: "prepare", installationId: "fixture" });
      await f.controller.settled();
    }
    gate = f.pause("installations");
    if (scenario.kind === "restart") await f.command({ kind: "restart", sessionId: session.id, generation: 1 });
    else {
      const prepared = f.controller.snapshot().operations[0];
      if (!prepared) throw new Error("missing_preparation");
      await f.command({ kind: "confirm", operationId: prepared.id, revision: prepared.revision,
        sessions: [{ id: session.id, generation: 1 }], restart: false });
    }
    await gate.entered;
    const operation = f.controller.snapshot().operations[0];
    if (!operation) throw new Error("missing_operation");
    await f.command({ kind: "cancel", operationId: operation.id, revision: operation.revision });
    if (scenario.reject) gate.reject(new AppError("unavailable")); else gate.release();
    await f.controller.settled();
    expect(f.controller.snapshot().operations[0]?.stage).toBe("cancelled");
    expect(f.controller.snapshot().managed[0]).toMatchObject({ pid: session.pid, generation: 1, state: "ready" });
    expect(f.effects).toEqual({ stops: 0, restarts: 0 });
    expect(f.calls.updates).toBe(0);
  } finally { gate?.release(); await f.close(); }
});

test.each(["activation", "installations", "targets"] as const)("cancelled preparation cannot revive after %s", async boundary => {
  const f = await fixture();
  const gate = f.pause(boundary);
  try {
    await f.command({ kind: "check", installationId: "fixture" });
    await f.command({ kind: "prepare", installationId: "fixture" });
    await gate.entered;
    const operation = f.controller.snapshot().operations[0];
    if (!operation) throw new Error("missing_operation");
    await f.command({ kind: "cancel", operationId: operation.id, revision: operation.revision });
    gate.release();
    await f.controller.settled();
    expect(f.controller.snapshot().operations[0]?.stage).toBe("cancelled");
    expect(f.calls.updates).toBe(0);
  } finally { gate.release(); await f.close(); }
});

test("narrower automation cannot inherit permission to stop a running session", async () => {
  const f = await fixture();
  const gate = f.pause("preparation");
  try {
    const session = (await f.command({ kind: "launch", installationId: "fixture", cwd: f.root })).managed[0];
    if (!session) throw new Error("missing_session");
    await f.command({ kind: "policy", installationId: "fixture", mode: "update-and-restart", intervalMinutes: 5 });
    f.fire(); await gate.entered;
    await f.command({ kind: "policy", installationId: "fixture", mode: "update", intervalMinutes: 5 });
    gate.release(); await f.controller.settled();
    expect(f.controller.snapshot().operations[0]?.stage).toBe("cancelled");
    expect(f.controller.snapshot().managed[0]).toMatchObject({ pid: session.pid, generation: 1, state: "ready" });
    expect(f.effects).toEqual({ stops: 0, restarts: 0 });
    expect(f.calls.updates).toBe(0);
  } finally { gate.release(); await f.close(); }
});
