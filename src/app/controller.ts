import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Installation, Job } from "../protocol";
import { createEngine } from "./engine";
import { createManagedSessions } from "./managed";
import { createNativeRestarts } from "./native-restarts";
import { createCatalog } from "./catalog";
import { createRemoval } from './catalog-removal';
import { createCatalogUpdates, updateBinding } from './catalog-updates';
import { createCatalogBulk } from './catalog-bulk';
import { catalogIds, isSupportedCli } from './catalog-types';
import { latestCatalogVersion } from './catalog-latest';
import { createDefaultJobs } from './catalog-default-jobs';
import { isDefaultSwitchConfigured, planDefaultSwitch, applyDefaultSwitch } from './catalog-default';
import type { CatalogCheck, CatalogEntry, CatalogId, CatalogInstallation } from './catalog-types';
import { guardRemoval } from './catalog-removal-guard';
import { AppStore, privateDirectory } from "./store";
import { externalCatalogId, externalSessions } from "./observations";
import { readOmoThreads, readOmoState, omoActivity } from "./omo-threads";
import type { OmoThread } from "./omo-threads";
import { parseBinding, rebaselineRow } from "./catalog-rebaseline";
import { catalogRegistryDirectory } from "../service/catalog-provider";
import { rename } from "node:fs/promises";
import type { CurrentConversationContext } from "./observations";
import { createHerdrPaneClient } from "./herdr-panes";
import type { HerdrPaneAgent, HerdrPaneClient } from "./herdr-panes";
import { restartInPane, trustScreenCpuLimit } from "./pane-restart";
import type { PaneRestartJob } from "./pane-restart";
import { AppError } from "./types";
import type { AppCommand, AppOperation, AppSnapshot, CommandEnvelope, ManagedSession, PaneRestartResult, PaneSessionPolicy, UpdatePolicy } from "./types";

type Clock = { readonly now: () => number; readonly schedule: (at: number, callback: () => void) => () => void };
type Options = {
  readonly directory: string;
  readonly home: string;
  readonly path: string;
  readonly prefixes: readonly string[];
  readonly managedEnv?: Readonly<Record<string, string>>;
  readonly shell?:string;
  readonly clock?: Clock;
  readonly currentConversation?: CurrentConversationContext | null;
  readonly herdrSocket?: string | null;
};
const active = (operation: AppOperation) => !["completed", "failed", "cancelled"].includes(operation.stage);
const version = (installation: Installation) => installation.installedVersion.kind === "known" ? installation.installedVersion.version : null;
const runtimeActive = (session: ManagedSession) => session.state !== "stopped" && session.state !== "failed";
const errorText = (error: unknown) => error instanceof AppError ? error.detail : "unavailable";

export async function createController(options: Options, dependencies: {
  readonly engine?: typeof createEngine;
  readonly managed?: typeof createManagedSessions;
  readonly observe?: typeof externalSessions;
  readonly catalog?: typeof createCatalog;
  readonly updates?: typeof createCatalogUpdates;
  readonly latest?: typeof latestCatalogVersion;
  readonly native?: typeof createNativeRestarts;
  readonly herdr?: HerdrPaneClient | null;
  readonly panePause?: () => Promise<void>;
  readonly paneAlive?: (pid: number) => boolean;
  readonly omoThreads?: typeof readOmoThreads;
  readonly omoState?: typeof readOmoState;
} = {}) {
  privateDirectory(options.directory);
  const clock: Clock = options.clock ?? {
    now: Date.now,
    schedule: (at, callback) => {
      const timer = setTimeout(callback, Math.max(0, at - Date.now()));
      timer.unref();
      return () => clearTimeout(timer);
    },
  };
  const store = new AppStore(options.directory);
  function senpiPolicy(policy: UpdatePolicy): boolean {
    if (policy.installationId !== 'catalog:pi' || !policy.catalogBinding) return false;
    const binding = parseBinding(policy.catalogBinding);
    if (!binding) return false;
    if (binding.kind === 'npm' || binding.kind === 'bun') return binding.packageName === '@code-yeongyu/senpi';
    if (binding.kind !== 'owned') return false;
    const recipeHash = createHash('sha256').update(JSON.stringify({kind:'npm',package:'@code-yeongyu/senpi',bin:'bin/pi'})).digest('hex');
    return store.installJobs().some(job => job.catalogId === 'pi' && job.target === binding.target
      && job.executablePath === binding.executable && job.recipeHash === recipeHash);
  }
  for(const policy of store.policies()){
    if (senpiPolicy(policy)) {
      if (policy.mode !== 'off') store.putPolicy({...policy,nextCheckAt:null,waitingReason:'pi_source_changed_senpi'});
      continue;
    }
    if(policy.intervalMinutes===60&&policy.firstCheck==='now'&&(policy.mode==='off'||policy.mode==='update'))continue;
    store.putPolicy({...policy,mode:policy.mode==='off'?'off':'update',intervalMinutes:60,firstCheck:'now',
      nextCheckAt:policy.mode==='off'?null:clock.now()});
  }
  const listeners = new Set<() => void>();
  const tasks = new Set<Promise<void>>();
  const preparations = new Map<string, AbortController>();
  const policyIntents = new Map<string, symbol>();
  const catalogChecks = new Map<CatalogId,{readonly binding:string;readonly result:CatalogCheck}>();
  let commands = 0;
  let revision = 0, service: AppSnapshot["service"] = "connecting", failure: string | null = null;
  let installations: readonly Installation[] = [], external: AppSnapshot["external"] = [];
  let refreshingJobs = false, repeatJobs = false, pumping = false, closed = false, closing = false;
  let recoverRestarts=false;
  let initialized=false;
  let initialization:Promise<void>|null=null;
  let ticking = false;
  let switchingCatalog=false;
  let cancelTimer: (() => void) | undefined;
  let cancelObservation: (() => void) | undefined;
  let observedAt: number | null = null, observationFailure: string | null = null;
  const managed = (dependencies.managed ?? createManagedSessions)({ directory: privateDirectory(join(options.directory, "managed")),
    ...(options.managedEnv ? { env: options.managedEnv } : {}),
    onChange: () => { changed(); wakePolicies(); background(pump()); } });
  const engine = (dependencies.engine ?? createEngine)({ ...options, onChange: () => { background(refreshJobs()); } });
  const native = (dependencies.native ?? createNativeRestarts)(engine.directory);
  const catalog = (dependencies.catalog ?? createCatalog)({ ...options, store, changed,
    adoptInstallation:(id,installation,makeDefault)=>switchCatalogTarget(id,installation,makeDefault,true) });
  const updates=(dependencies.updates??createCatalogUpdates)({...options,store,entries:catalogEntries,changed,
    updated:job=>{background(restartCatalogPaneSessions(job.id));},
    guard:()=>{
      if(nativeBusy())throw new AppError('busy','native_restart_in_progress');
      if(defaults.busy())throw new AppError('busy','default_switch_in_progress');
      if(catalog.busy())throw new AppError('busy','install_in_progress');
      if(removal.busy())throw new AppError('busy','removal_in_progress');
      // Catalog updates change the installation only. Session termination and
      // restart belong to separate operations, not removal prerequisites.
      if(store.operations().some(active))throw new AppError('busy','operation_in_progress');
    },
    installedChanged:()=>{catalog.refresh();background(refresh());},
  });
  const removal=createRemoval({...options,store,entries:catalogEntries,changed,guard:async target=>{
    if(nativeBusy())throw new AppError('busy','native_restart_in_progress');
    if(defaults.busy())throw new AppError('busy','default_switch_in_progress');
    if(updates.busy())throw new AppError('busy','update_in_progress');
    if(store.policies().some(row=>row.mode!=='off'&&(target.kind==='standalone'?row.installationId==='catalog:'+target.catalogId:row.catalogBinding===updateBinding(target))))
      throw new AppError('busy','disable_automation_before_removal');
    if(catalog.busy())throw new AppError('busy','install_in_progress');
    await catalog.settled();
    guardRemoval(target,snapshot());
  },
    installedChanged:()=>{background(refresh());}});
  const defaults=createDefaultJobs({...options,shell:options.shell??process.env['SHELL']??'/bin/zsh',store,changed,
    resolve:async(catalogId,installationId):Promise<CatalogInstallation>=>{
      catalog.refresh();await catalog.settled();
      const entry=catalogEntries().find(row=>row.id===catalogId);
      if(entry?.inventoryStatus!=='ready')throw new AppError('unavailable','inventory_unavailable');
      const instance=entry.installations?.find(row=>row.id===installationId);
      if(!instance)throw new AppError('not_found','installation_missing');
      return instance;
    },
    guard:(catalogId,installationId)=>{
      configurationGuard(catalogId,'default');
      const entry=catalogEntries().find(row=>row.id===catalogId);
      if(!entry?.installations?.some(row=>row.id===installationId))throw new AppError('not_found','installation_missing');
      if(entry.configuredDefaultInstallationId===installationId)throw new AppError('conflict','already_default_installation');
    },
    installedChanged:()=>{catalog.refresh();changed();},
  });
  function catalogEntries(){
    const configured=store.defaultJobs().filter(job=>job.stage==='completed'&&job.result&&isDefaultSwitchConfigured(job.plan));
    return catalog.entries().filter(entry=>isSupportedCli(entry.id)).map(entry=>{
      const check=catalogChecks.get(entry.id);
      return {...entry,configuredDefaultInstallationId:configured.find(job=>job.catalogId===entry.id)?.installationId??null,
        ...(check?.binding===catalogCheckBinding(entry)?{lastCheck:check.result}:{})};
    });
  }
  function catalogCheckBinding(entry:CatalogEntry):string {
    return JSON.stringify([entry.selectedInstallationId,entry.installed?.path,entry.installed?.identityPath,entry.installed?.version]);
  }
  function latestResult(entry:CatalogEntry,latestVersion:string):CatalogCheck {
    const installed=entry.installed?.version;
    const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
    const comparable=installed&&semver.test(installed)&&semver.test(latestVersion);
    const order=comparable?Bun.semver.order(latestVersion,installed):null;
    return {status:order===null?'unknown':order>0?'available':order<0?'ahead':'current',latestVersion,checkedAt:clock.now(),failure:null};
  }
  async function checkCatalog(catalogId:CatalogId):Promise<CatalogCheck> {
    if(!isSupportedCli(catalogId))throw new AppError('unsupported','cli_not_supported');
    await catalog.settled();
    const entry=catalog.entries().find(row=>row.id===catalogId);
    if(!entry?.installed)throw new AppError('not_found','installation_missing');
    const binding=catalogCheckBinding(entry),previous=catalogChecks.get(catalogId);
    if(previous?.binding===binding&&previous.result.status==='checking')throw new AppError('busy','check_in_progress');
    const pending={binding,result:{status:'checking',latestVersion:null,checkedAt:clock.now(),failure:null} as const};
    catalogChecks.set(catalogId,pending);changed();
    let result:CatalogCheck;
    try {
      if(entry.updateSupport?.kind==='unsupported')throw new AppError('unsupported',entry.updateSupport.reason??'manual_update_required');
      const target=await updates.targetFor(catalogId);
      const latest=await (dependencies.latest??latestCatalogVersion)(catalogId,target);
      result=latestResult(entry,latest);
    } catch(error) {
      if(!(error instanceof AppError))throw error;
      result={status:error.code==='unsupported'?'unsupported':'failed',latestVersion:null,checkedAt:clock.now(),failure:error.detail};
    }
    if(catalogChecks.get(catalogId)===pending){catalogChecks.set(catalogId,{binding,result});changed();}
    if(catalogCheckBinding(catalog.entries().find(row=>row.id===catalogId)??entry)!==binding)
      throw new AppError('source_changed','installation_selection_changed');
    return result;
  }
  const bulk=createCatalogBulk({store,entries:catalogEntries,settled:()=>catalog.settled(),check:checkCatalog,updates,changed,
    guard:()=>{
      if(ticking||commands>1||catalog.busy()||updates.busy()||defaults.busy()||removal.busy()||nativeBusy()||store.operations().some(active))
        throw new AppError('busy','operation_in_progress');
    },
    updated:(id,version)=>{
      // Keep automation from mistaking this deliberate keep-session update for an external update.
      const policy=store.policies().find(row=>row.installationId===`catalog:${id}`);
      if(policy)store.putPolicy({...policy,lastInstalledVersion:version});
    },
  });
  function configurationGuard(catalogId:CatalogId,lock?:'catalog'|'default'):void{
    if(!isSupportedCli(catalogId))throw new AppError('unsupported','cli_not_supported');
    if(nativeBusy())throw new AppError('busy','native_restart_in_progress');
    if(lock!=='catalog'&&catalog.busy())throw new AppError('busy','install_in_progress');
    if(updates.busy())throw new AppError('busy','update_in_progress');
    if(removal.busy())throw new AppError('busy','removal_in_progress');
    if(lock!=='default'&&defaults.busy())throw new AppError('busy','default_switch_in_progress');
    if(store.operations().some(active))throw new AppError('busy','operation_in_progress');
    if(store.policies().some(policy=>policy.mode!=='off'&&(policy.installationId===`catalog:${catalogId}`
      ||installations.some(item=>item.family===catalogId&&item.installationId===policy.installationId))))
      throw new AppError('busy','disable_automation_before_selection');
    if(store.installJobs().some(job=>job.catalogId===catalogId&&job.stage==='uncertain')
      ||store.catalogUpdates().some(job=>job.catalogId===catalogId&&job.stage==='uncertain')
      ||store.removalJobs().some(job=>job.catalogId===catalogId&&job.stage==='uncertain')
      ||store.defaultJobs().some(job=>job.catalogId===catalogId&&job.stage==='uncertain'))
      throw new AppError('uncertain','inspect_installation_jobs');
  }

  function policyFamily(id:string):string|undefined {
    return id.startsWith('catalog:')?id.slice(8):installations.find(row=>row.installationId===id)?.family;
  }
  function competingPolicies(id:string):readonly UpdatePolicy[] {
    const family=policyFamily(id);
    return family?store.policies().filter(row=>row.installationId!==id&&row.mode!=='off'&&policyFamily(row.installationId)===family):[];
  }
  function mutationGuard():void {
    if(switchingCatalog||ticking||commands>1||bulk.busy()||catalog.busy()||updates.busy()||defaults.busy()||removal.busy()||nativeBusy()||store.operations().some(active))
      throw new AppError('busy','operation_in_progress');
  }
  async function switchCatalogTarget(id:CatalogId,installation:CatalogInstallation,makeDefault=false,fromInstall=false):Promise<void> {
    if(!isSupportedCli(id))throw new AppError('unsupported','cli_not_supported');
    if(!fromInstall)mutationGuard();
    if(switchingCatalog)throw new AppError('busy','operation_in_progress');
    switchingCatalog=true;
    try{
      if(installation.catalogId!==id)throw new AppError('invalid_request');
      const entry=catalog.entries().find(row=>row.id===id);
      if(entry?.inventoryStatus!=='ready')throw new AppError('unavailable','inventory_unavailable');
      if(!entry.installations?.some(row=>row.id===installation.id&&row.path===installation.path&&row.identityPath===installation.identityPath))
        throw new AppError('source_changed','installation_selection_changed');
      if(store.catalogUpdates().some(row=>row.catalogId===id&&row.stage==='uncertain')||store.removalJobs().some(row=>row.catalogId===id&&row.stage==='uncertain')||
        store.installJobs().some(row=>row.catalogId===id&&row.stage==='uncertain')||store.defaultJobs().some(row=>row.catalogId===id&&row.stage==='uncertain'))
        throw new AppError('uncertain','inspect_installation_jobs');
      const before=JSON.stringify(store.policies());
      const activePolicies=store.policies().filter(row=>row.mode!=='off'&&policyFamily(row.installationId)===id);
      const previous=activePolicies.find(row=>row.installationId===`catalog:${id}`)??activePolicies[0];
      if(previous&&senpiPolicy(previous))throw new AppError('source_changed','pi_source_changed_senpi');
      const target=previous?await updates.targetFor(id,installation):null;
      if(!installation.version)throw new AppError('unavailable','installed_version_unverified');
      if(JSON.stringify(store.policies())!==before)throw new AppError('conflict','policy_changed');
      const next=previous&&target?{...previous,installationId:`catalog:${id}`,mode:'update' as const,catalogBinding:updateBinding(target),
        lastInstalledVersion:installation.version,lastCheckedAt:null,waitingReason:null,nextCheckAt:clock.now()+previous.intervalMinutes*60_000}:null;
      // Released herdr builds without executable selection reject the read; the update
      // target still switches and the snapshot reports the herdr launch as unavailable.
      let connectHerdr=false,previousHerdr:string|null=null;
      if(herdr?.executable&&herdr.selectExecutable){
        try{previousHerdr=await herdr.executable(id);connectHerdr=true;}
        catch(error){if(!(error instanceof AppError))throw error;}
      }
      if(connectHerdr)await herdr!.selectExecutable!(id,installation.path);
      try{if(makeDefault){
        const plan=planDefaultSwitch({...options,shell:options.shell??process.env['SHELL']??'/bin/zsh',installation});
        const result=await applyDefaultSwitch(plan,{home:options.home,path:options.path,guard:()=>{
          if(JSON.stringify(store.policies())!==before)throw new AppError('conflict','policy_changed');
        }});
        store.putDefaultJob({id:plan.id,requestId:plan.id,catalogId:id,installationId:installation.id,revision:1,stage:'completed',plan,result,createdAt:clock.now(),updatedAt:clock.now(),failure:null});
      }
      store.switchCatalogPolicy(id,installation.id,[...activePolicies.filter(row=>row.installationId!==next?.installationId)
        .map(row=>({...row,mode:'off' as const,nextCheckAt:null,waitingReason:null})),...(next?[next]:[])]);
      }catch(error){
        if(connectHerdr){
          try{await herdr!.selectExecutable!(id,previousHerdr);}
          catch{throw new AppError('uncertain','herdr_selection_rollback_unverified');}
        }
        throw error;
      }
      if(connectHerdr)herdrLaunches.set(id,installation.path);
      else herdrLaunches.delete(id);
      for(const job of store.catalogUpdates())if(job.catalogId===id&&job.stage==='ready')
        store.putCatalogUpdate({...job,stage:'failed',revision:job.revision+1,failure:'installation_selection_changed',updatedAt:clock.now()});
      catalogChecks.delete(id);changed();schedule();
    }finally{switchingCatalog=false;}
  }

  function changed(): void { revision++; for (const listener of listeners) listener(); }
  function background(promise: Promise<void>): void {
    tasks.add(promise);
    void promise.catch(error => { failure = errorText(error); changed(); }).finally(() => tasks.delete(promise));
  }
  async function settled(): Promise<void> {
    while (tasks.size) await Promise.allSettled([...tasks]);
    await catalog.settled();
    await removal.settled();
    await updates.settled();
    await defaults.settled();
    while (tasks.size) await Promise.allSettled([...tasks]);
  }
  function snapshot(): AppSnapshot {
    const entries = catalogEntries();
    return { revision, service, installations, native: native.snapshot(), managed: managed.list(),
      host:{platform:process.platform,arch:process.arch,wsl:process.platform==='linux'&&!!(process.env['WSL_DISTRO_NAME']||process.env['WSL_INTEROP'])},
      external: external.map(row => ({ ...row, catalogId: externalCatalogId(row.executable, row.family, entries)??(!isSupportedCli(row.family)?row.catalogId??null:null) })),
      catalog: entries.map(entry=>({...entry,herdrLaunch:{status:herdrLaunches.has(entry.id)?'applied' as const:!isSupportedCli(entry.id)?'unsupported' as const:'unavailable' as const,executable:herdrLaunches.get(entry.id)??null}})), installJobs: store.installJobs(), removalJobs:store.removalJobs(),
      catalogUpdates:store.catalogUpdates(),
      catalogBulk:bulk.snapshot(),
      defaultJobs:store.defaultJobs(), paneRestarts: [...paneRestarts.values()],
      observedAt, observationFailure, operations: store.operations(), policies: store.policies(), automationSettings:store.automationSettings(), failure };
  }
  const paneRestarts = new Map<string, PaneRestartJob>();
  let currentConversation = options.currentConversation ?? null;
  const herdr = dependencies.herdr ?? (options.herdrSocket ? createHerdrPaneClient(options.herdrSocket) : null);
  const herdrLaunches=new Map<CatalogId,string>();
  let herdrAgents: readonly HerdrPaneAgent[] | null = null;
  let omoThreads: readonly OmoThread[] = [];
  async function refreshHerdrAgents(): Promise<void> {
    if (!herdr) return;
    try { herdrAgents = await herdr.agents(); }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      herdrAgents = null;
    }
    herdrLaunches.clear();
    if(herdrAgents&&herdr.executable){
      for(const entry of catalog.entries().filter(row=>isSupportedCli(row.id)&&row.installed)){
        try{
          const selected=await herdr.executable(entry.id);
          if(selected&&selected===entry.installed?.path)herdrLaunches.set(entry.id,selected);
        }catch(error){
          if(!(error instanceof AppError))throw error;
          // An old or unavailable server is not evidence of an applied selection.
        }
      }
    }
    omoThreads = [];
    const executable = catalog.entries().find(entry => entry.id === "omo")?.installed?.path;
    if (executable && herdrAgents?.length) {
      try { omoThreads = await (dependencies.omoThreads ?? readOmoThreads)(executable, join(options.home, ".omo", "agent")); }
      catch (error) {
        // A failed endpoint census grants no new session bindings. The process census
        // remains useful, and the next regular refresh can recover a transient failure.
        if (!(error instanceof Error)) throw error;
      }
    }
  }
  let paneScreens: Map<string, string> = new Map();
  async function refreshPaneScreens(): Promise<void> {
    const next = new Map<string, string>();
    if (herdr && herdrAgents) for (const agent of herdrAgents) {
      try { next.set(agent.paneId, await herdr.read(agent.paneId)); }
      catch (error) { if (!(error instanceof AppError)) throw error; }
    }
    paneScreens = next;
  }
  // Cumulative CPU seconds per pid from the previous observation; the delta over wall time is
  // the only honest "is it computing now" signal, since ps %cpu is a lifetime average.
  let cpuSample: { at: number; seconds: Map<number, number> } | null = null;
  const cpuPercent = new Map<number, number>();
  // Consecutive observations with the pid under the quiet limit; one quiet sample can be a
  // model-call pause inside real work, two in a row (30s) is the hint threshold.
  const cpuQuietStreak = new Map<number, number>();
  const cpuQuiet = new Map<number, boolean>();
  function sampleCpu(pids: readonly number[]): void {
    cpuPercent.clear(); cpuQuiet.clear();
    if (!pids.length) { cpuSample = null; cpuQuietStreak.clear(); return; }
    let output = "";
    try { output = execFileSync("/bin/ps", ["-o", "pid=,time=", "-p", pids.join(",")], { encoding: "utf8", timeout: 5_000 }); }
    catch { cpuSample = null; return; }
    const seconds = new Map<number, number>();
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
      if (match) seconds.set(Number(match[1]), Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]));
    }
    const at = clock.now();
    if (cpuSample && at - cpuSample.at >= 1_000) for (const [pid, now] of seconds) {
      const before = cpuSample.seconds.get(pid);
      if (before !== undefined && now >= before) {
        const percent = Math.round((now - before) / ((at - cpuSample.at) / 1_000) * 1000) / 10;
        cpuPercent.set(pid, percent);
        const streak = percent <= trustScreenCpuLimit ? (cpuQuietStreak.get(pid) ?? 0) + 1 : 0;
        cpuQuietStreak.set(pid, streak);
        cpuQuiet.set(pid, streak >= 2);
      }
    }
    for (const pid of [...cpuQuietStreak.keys()]) if (!seconds.has(pid)) cpuQuietStreak.delete(pid);
    cpuSample = { at, seconds };
  }
  function observeProcesses(): void {
    try {
      sampleCpu(external.filter(row => row.processState !== "exited" && row.herdrPane).map(row => row.pid));
      const current = (dependencies.observe ?? externalSessions)(installations,
        managed.list().flatMap(row => row.pid === null ? [] : [row.pid]), undefined, undefined,
        { currentConversation, herdrAgents, paneScreens, cpuPercent, cpuQuiet, omoThreads });
      const now = clock.now();
      // Retain a disappeared observation for one refresh only. A reused PID is
      // a different process when its start time changes.
      const exited = external.filter(old => old.processState !== "exited"
        && !current.some(row => row.pid === old.pid && row.startedAt === old.startedAt))
        .map(row => ({ ...row, processState: "exited" as const, observedAt: now, isCurrentConversation: false }));
      external = [...current.map(row => ({ ...row, processState: "observed" as const, observedAt: now })), ...exited];
      observedAt = clock.now(); observationFailure = null;
    } catch (error) {
      if (!(error instanceof AppError) && !(error instanceof Error)) throw error;
      observationFailure = "process_observation_unavailable";
      external = external.map(row => ({ ...row, processState: "unknown" as const }));
    }
    changed();
  }
  function scheduleObservation(): void {
    cancelObservation?.();
    cancelObservation = clock.schedule(clock.now() + 15_000, () => {
      if (closed || closing) return;
      observeProcesses(); scheduleObservation();
      background(refreshHerdrAgents().then(() => {
        if (!closed && !closing && herdrAgents?.length) observeProcesses();
      }));
    });
  }
  function selected(id: string): Installation {
    const row = installations.find(row => row.installationId === id);
    if (!row) throw new AppError("not_found");
    if (!isSupportedCli(row.family)) throw new AppError('unsupported','cli_not_supported');
    return row;
  }
  function operationChange(id: string, fields: Partial<Omit<AppOperation, "id" | "revision">>): AppOperation {
    const current = store.operation(id);
    const next = store.changeOperation(id, current.revision, { ...fields, updatedAt: clock.now() });
    changed(); return next;
  }
  function busyInstallation(id: string, except?: string): boolean {
    return store.operations().some(row => row.installationId === id && row.id !== except && active(row));
  }
  function nativeBusy(): boolean {
    return store.operations().some(row => row.kind === "native-restart" && active(row))
      || native.snapshot().jobs.some(job => !["completed", "cancelled", "failed"].includes(job.status));
  }
  function permitsAutomatic(installationId: string, restart: boolean): boolean {
    if(!isSupportedCli(policyFamily(installationId)))return false;
    const policy = store.policies().find(row => row.installationId === installationId);
    return restart ? policy?.mode === "update-and-restart"
      : policy?.mode === "update" && !managed.list().some(row => row.installationId === installationId && runtimeActive(row));
  }
  async function refresh(recover = false): Promise<void> {
    catalog.refresh();
    installations = await engine.installations();
    await native.refresh();
    await catalog.settled();
    await rebaselineCatalogs();
    await refreshHerdrAgents();
    await refreshPaneScreens();
    observeProcesses();
    service = "ready"; failure = null; changed();
    await refreshJobs(recover);
  }
  function initialize():Promise<void>{
    if(initialization)return initialization;
    service='connecting';failure=null;changed();
    initialization=Promise.resolve().then(async()=>{
      try{
        await engine.connect();
        await refresh();
        initialized=true;
        schedule();scheduleObservation();
      }catch(error){
        service='unavailable';failure=errorText(error);changed();
        throw error;
      }
    }).finally(()=>{initialization=null;});
    return initialization;
  }
  async function check(id: string): Promise<void> {
    selected(id);
    const result = await engine.check(id);
    installations = installations.map(row => row.installationId === id
      ? { ...row, lastCheck: { checkedAt: result.checkedAt, result } } : row);
    changed();
  }
  function newOperation(installation: Installation, requestId: string, kind: AppOperation["kind"],
    sessionIds: readonly string[] = [], restart = false): AppOperation {
    const operation: AppOperation = {
      id: randomUUID(), requestId, installationId: installation.installationId, kind,
      stage: kind === "prepare" ? "preparing" : "waiting", revision: 0, targetVersion: null,
      beforeVersion: version(installation), installedVersion: null, sessionIds, restart,
      createdAt: clock.now(), updatedAt: clock.now(), failure: null, detail: null, jobId: null,
    };
    store.putOperation(operation); changed(); return operation;
  }
  async function prepare(installationId: string, requestId: string, automatic = false): Promise<void> {
    if(nativeBusy())throw new AppError('busy','native_restart_in_progress');
    if (closed || closing) throw new AppError("unavailable");
    if(updates.busy())throw new AppError('busy','update_in_progress');
    if(defaults.busy())throw new AppError('busy','default_switch_in_progress');
    if(removal.busy())throw new AppError('busy','removal_in_progress');
    const installation = selected(installationId);
    if (busyInstallation(installationId)) throw new AppError("busy", "operation_in_progress");
    if (preparations.size) throw new AppError("busy", "preparation_in_progress");
    const operation = newOperation(installation, requestId, "prepare");
    store.putTerms(operation.id, { sessions: [], automatic, stopped: [] });
    const abort = new AbortController();
    preparations.set(operation.id, abort);
    background((async () => {
      try {
        const prepared = await engine.prepare(installation, abort.signal);
        if (store.operation(operation.id).stage === "cancelled") return;
        await engine.activate(prepared);
        if (store.operation(operation.id).stage !== "preparing") return;
        store.putPrepared(operation.id, prepared.configuration.path);
        installations = await engine.installations();
        if (store.operation(operation.id).stage !== "preparing") return;
        const metadata = await engine.targets(installationId);
        if (store.operation(operation.id).stage !== "preparing") return;
        if (metadata.update.kind !== "supported") throw new AppError("unsupported", "preparation_not_usable");
        operationChange(operation.id, { stage: "ready", targetVersion: prepared.targetVersion,
          beforeVersion: prepared.beforeVersion.kind === "known" ? prepared.beforeVersion.version : null });
        if (automatic) {
          const policy = store.policies().find(row => row.installationId === installationId);
          if (policy?.mode === "update" || policy?.mode === "update-and-restart") {
            const sessions = managed.list().filter(row => row.installationId === installationId && runtimeActive(row));
            await confirm(store.operation(operation.id), sessions.map(row => ({ id: row.id, generation: row.generation })),
              policy.mode === "update-and-restart", true);
          }
        }
      } catch (error) {
        if (store.operation(operation.id).stage !== "cancelled") {
          operationChange(operation.id, { stage: "failed", failure: "preparation_failed", detail: errorText(error) });
          managed.setAdmission(installationId, true);
        }
      } finally { preparations.delete(operation.id); }
    })());
  }
  function paneSessionPolicy(installationId: string): PaneSessionPolicy {
    return store.policies().find(row => row.installationId === installationId)?.paneSessions ?? "keep";
  }
  async function confirm(operation: AppOperation, sessions: readonly { readonly id: string; readonly generation: number }[],
    restart: boolean, automatic = false, paneSessions: PaneSessionPolicy = paneSessionPolicy(operation.installationId)): Promise<void> {
    selected(operation.installationId);
    if(removal.busy())throw new AppError('busy','removal_in_progress');
    if (operation.stage !== "ready") throw new AppError("conflict", "stale_preparation");
    const metadata = await engine.targets(operation.installationId);
    if(!isSupportedCli(metadata.installation.family))throw new AppError('unsupported','cli_not_supported');
    if (closed || closing) throw new AppError("unavailable");
    const latest = metadata.installation.lastCheck?.result;
    if (metadata.update.kind !== "supported" || latest?.kind !== "update-available"
      || latest.availableVersion !== operation.targetVersion || version(metadata.installation) !== operation.beforeVersion)
      throw new AppError("source_changed", "stale_preparation");
    const current = managed.list().filter(row => row.installationId === operation.installationId);
    if (automatic && !permitsAutomatic(operation.installationId, restart))
      throw new AppError("conflict", "automation_conditions_changed");
    for (const target of sessions) {
      const row = current.find(row => row.id === target.id);
      if (!row || row.generation !== target.generation) throw new AppError("conflict", "stale_generation");
    }
    if (current.some(row => runtimeActive(row) && !sessions.some(target => target.id === row.id)))
      throw new AppError("busy", "unselected_sessions");
    // Global-first (2026-10-11): the installation updates first; external sessions keep
    // their launched version and adopt the new one on their own later restart. They are
    // recorded on the operation for display, never stopped here. The update runner's own
    // open-file census still refuses a process holding the files being replaced.
    observeProcesses();
    const outside = external.filter(row => row.installationId === operation.installationId && row.processState !== "exited");
    const currentOperation = store.operation(operation.id);
    if (currentOperation.revision !== operation.revision || currentOperation.stage !== "ready")
      throw new AppError("conflict", "stale_preparation");
    store.putTerms(operation.id, { sessions: [...sessions], automatic, stopped: [] });
    operationChange(operation.id, { kind: "update", stage: "waiting", restart, sessionIds: sessions.map(row => row.id),
      externalSessionIds: outside.map(row => row.id), paneSessions,
      paneResults: paneSessions === "keep" ? [] : outside.flatMap(row => row.herdrPane
        ? [{ sessionId: row.id, paneId: row.herdrPane.paneId, outcome: "pending" as const, failure: null, previousPid: row.pid, resumedPid: null }] : []) });
    managed.setAdmission(operation.installationId, false);
    background(pump());
  }
  async function finishUpdate(operation: AppOperation, job: Job): Promise<void> {
    if (job.status !== "completed" || job.installTxn.state !== "succeeded") return;
    installations = await engine.installations();
    const installation = selected(operation.installationId);
    if (version(installation) !== operation.targetVersion) throw new AppError("uncertain", "installed_version_mismatch");
    operationChange(operation.id, { stage: operation.restart ? "restarting" : "completed",
      installedVersion: version(installation), installedAt: operation.installedAt ?? clock.now(), failure: null, detail: null });
    background(restartPaneSessions(operation.id));
    if (operation.restart) {
      const terms = store.terms(operation.id);
      for (const target of terms.sessions) {
        const current = managed.list().find(row => row.id === target.id);
        const receipt=terms.restarts.find(row=>row.id===target.id);
        if(receipt?.status==='completed'){
          if(!current||current.generation!==receipt.generation||current.durableSessionId!==receipt.durableSessionId
            ||current.launchedVersion!==operation.targetVersion||!['ready','working','waiting'].includes(current.state))
            throw new AppError("uncertain","restart_binding_changed");
          continue;
        }
        const failedAttempt=receipt?.status==='pending'&&current?.state==='failed'&&current.pid===null
          &&current.generation===receipt.generation+1&&current.durableSessionId===receipt.durableSessionId;
        if (!current || !current.durableSessionId || (!failedAttempt&&(current.state !== "stopped"
          || current.generation !== (receipt?.generation??target.generation)))
          ||(receipt&&current.durableSessionId!==receipt.durableSessionId))
          throw new AppError("uncertain", "restart_binding_changed");
        const pending={id:target.id,generation:current.generation,durableSessionId:current.durableSessionId,status:'pending' as const};
        const latest=store.terms(operation.id);
        store.putTerms(operation.id,{...latest,restarts:[...latest.restarts.filter(row=>row.id!==target.id),pending]});
        const restarted=await managed.restart(target.id, current.generation, installation);
        if(restarted.generation!==current.generation+1||restarted.durableSessionId!==pending.durableSessionId
          ||restarted.state!=='ready'||restarted.launchedVersion!==operation.targetVersion)
          throw new AppError("uncertain","restart_result_unverified");
        const completed=store.terms(operation.id);
        store.putTerms(operation.id,{...completed,restarts:[...completed.restarts.filter(row=>row.id!==target.id),
          {...pending,generation:restarted.generation,status:'completed'}]});
      }
      operationChange(operation.id, { stage: "completed" });
    }
    managed.setAdmission(operation.installationId, true);
  }
  const paneRestartOptions = () => ({
    now: () => clock.now(),
    pause: dependencies.panePause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 250))),
    isAlive: dependencies.paneAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } }),
    publish: (job: PaneRestartJob) => { paneRestarts.set(job.id, job); changed(); },
    // Only a pid quiet for two consecutive observations counts as quiet for a trusted restart.
    cpuPercent: (pid: number) => cpuQuiet.get(pid) === true ? cpuPercent.get(pid) ?? null : null,
    omoState: async (session: AppSnapshot["external"][number]) => {
      if (!session.omoSocket || !session.conversation) return "unknown" as const;
      const state = await (dependencies.omoState ?? readOmoState)(session.omoSocket);
      return state?.sessionId === session.conversation.id && state.sessionFile === session.conversation.path
        ? omoActivity(state) : "unknown" as const;
    },
    observePane: async (paneId: string) => {
      await refreshHerdrAgents(); observeProcesses();
      const matches = external.filter(row => row.herdrPane?.paneId === paneId && row.processState === "observed");
      return matches.length === 1 ? matches[0] ?? null : null;
    },
  });
  // A reinstall outside this app (for example `bun add -g`) changes pinned files; the worker then
  // drops the installation rather than rebaseline itself. When the app's own inventory still
  // validates the bound installation and automation is on, archive the pin file so the next
  // worker scan takes a fresh first observation - the same thing a fresh start would do.
  async function rebaselineCatalogs(): Promise<void> {
    let rotated = false;
    for (const policy of store.policies()) {
      const catalogId = catalogIds.find(id => policy.installationId === `catalog:${id}`);
      if (!catalogId||!isSupportedCli(catalogId)) continue;
      const row = rebaselineRow(policy, catalog.entries().find(entry => entry.id === catalogId),
        installations.some(item => item.family === catalogId), clock.now());
      if (!row) continue;
      // The worker's own directory is <app>/run/worker; its pin registry sits beside it.
      const pinFile = join(catalogRegistryDirectory(join(options.directory, "run", "worker")), "auto-sources.json");
      const stamp = new Date(clock.now()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
      try { await rename(pinFile, `${pinFile}.stale-${stamp}`); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      store.putPolicy({ ...policy, lastRebaselineAt: clock.now() });
      rotated = true;
    }
    if (rotated) { installations = await engine.installations(); changed(); }
  }
  async function restartCatalogPaneSessions(jobId: string): Promise<void> {
    const job = store.catalogUpdates().find(row => row.id === jobId);
    if (!herdr || !job || !isSupportedCli(job.catalogId) || job.paneSessions === "keep") return;
    await refreshHerdrAgents(); observeProcesses();
    const targets = external.filter(row => row.catalogId === job.catalogId && row.processState !== "exited" && row.herdrPane);
    if (!targets.length) return;
    const put = (fields: Partial<typeof job>) => {
      const before = store.catalogUpdates().find(row => row.id === jobId);
      if (before) { store.putCatalogUpdate({ ...before, ...fields, revision: before.revision + 1, updatedAt: clock.now() }); changed(); }
    };
    put({ paneResults: targets.map(row => ({ sessionId: row.id, paneId: row.herdrPane!.paneId, outcome: "pending" as const, failure: null, previousPid: row.pid, resumedPid: null })) });
    const record = (sessionId: string, fields: Partial<PaneRestartResult>) => {
      const before = store.catalogUpdates().find(row => row.id === jobId);
      put({ paneResults: (before?.paneResults ?? []).map(row => row.sessionId === sessionId ? { ...row, ...fields } : row) });
    };
    await Promise.all(targets.map(async session => {
      if (session.herdrPane!.status === "blocked") { record(session.id, { outcome: "skipped-blocked" }); return; }
      if (job.paneSessions === "restart-idle" && session.herdrPane!.status !== "idle" && session.herdrPane!.status !== "done") {
        record(session.id, { outcome: "skipped-working" }); return;
      }
      const result = await restartInPane({ ...paneRestartOptions(), herdr, session, initialSeq: session.herdrPane!.stateChangeSeq, idleTimeoutMs: 30 * 60_000 });
      record(session.id, result.stage === "completed" ? { outcome: "completed", resumedPid: result.resumedPid }
        : { outcome: result.failure === "idle_wait_timeout" ? "skipped-working" : "failed", failure: result.failure });
    }));
    await refreshHerdrAgents(); observeProcesses();
  }
  async function restartPaneSessions(operationId: string): Promise<void> {
    const operation = store.operation(operationId);
    if(!isSupportedCli(policyFamily(operation.installationId)))return;
    const pending = (operation.paneResults ?? []).filter(row => row.outcome === "pending");
    if (!herdr || operation.paneSessions === "keep" || !pending.length) return;
    await refreshHerdrAgents(); observeProcesses();
    const record = (sessionId: string, fields: Partial<PaneRestartResult>) => {
      const current = store.operation(operationId);
      operationChange(operationId, { paneResults: (current.paneResults ?? []).map(row => row.sessionId === sessionId ? { ...row, ...fields } : row) });
    };
    await Promise.all(pending.map(async target => {
      const session = external.find(row => row.id === target.sessionId && row.processState !== "exited");
      if (!session?.herdrPane || session.herdrPane.paneId !== target.paneId) { record(target.sessionId, { outcome: "failed", failure: "pane_changed" }); return; }
      if (session.herdrPane.status === "blocked") { record(target.sessionId, { outcome: "skipped-blocked" }); return; }
      if (operation.paneSessions === "restart-idle" && session.herdrPane.status !== "idle" && session.herdrPane.status !== "done") {
        record(target.sessionId, { outcome: "skipped-working" }); return;
      }
      const job = await restartInPane({ ...paneRestartOptions(), herdr, session, initialSeq: session.herdrPane.stateChangeSeq,
        idleTimeoutMs: 30 * 60_000 });
      record(target.sessionId, job.stage === "completed"
        ? { outcome: "completed", resumedPid: job.resumedPid }
        : { outcome: job.failure === "idle_wait_timeout" ? "skipped-working" : "failed", failure: job.failure });
    }));
    await refreshHerdrAgents(); observeProcesses();
  }
  async function refreshJobs(recover = false): Promise<void> {
    if (closed || closing) return;
    recoverRestarts ||= recover;
    if (refreshingJobs) { repeatJobs = true; return; }
    refreshingJobs = true;
    try {
      do {
        repeatJobs = false;
        const retry= recoverRestarts;recoverRestarts=false;
        const jobs = await engine.jobs();
        await native.refresh();
        if (closed || closing) return;
        for(const operation of store.operations().filter(row=>row.kind==="native-restart"&&active(row))){
          const job=native.snapshot().jobs.find(row=>row.requestId===`native:${operation.id}`);
          if(!job)continue;
          const stage=job.status==="completed"?"completed":job.status==="cancelled"?"cancelled"
            :job.status==="recovery_required"?"uncertain":"restarting";
          if(operation.stage!==stage||operation.jobId!==job.jobId)
            operationChange(operation.id,{stage,jobId:job.jobId,failure:job.failure?.code??null});
        }
        changed();
        for (const operation of store.operations().filter(row => row.kind === "update"
          && ["updating", "verifying", "uncertain"].includes(row.stage))) {
          if(operation.stage==='uncertain'&&!retry)continue;
          const job = jobs.find(row => row.requestId === `web:${operation.id}`);
          if (!job) continue;
          if (job.status === "completed" && job.installTxn.state === "succeeded") {
            try { await finishUpdate(operation, job); }
            catch (error) { operationChange(operation.id, { stage: "uncertain", failure: "restart_unverified", detail: errorText(error) }); }
          } else if (job.status === "failed" || job.installTxn.state === "failed") {
            operationChange(operation.id, { stage: "failed", failure: job.failure?.code ?? job.installTxn.failure?.code ?? "update_failed" });
            managed.setAdmission(operation.installationId, true);
          } else {
            const stage = job.status === "recovery_required" ? "uncertain"
              : job.installTxn.state === "verifying" ? "verifying" : "updating";
            if (operation.stage !== stage || operation.jobId !== job.jobId)
              operationChange(operation.id, { stage, jobId: job.jobId });
          }
        }
      } while (repeatJobs && !closed);
    } finally { refreshingJobs = false; }
  }
  async function pump(): Promise<void> {
    if (pumping || closed || closing) return;
    pumping = true;
    try {
      for (const operation of store.operations().filter(row => row.stage === "waiting")) {
        const terms = store.terms(operation.id);
        const current = managed.list();
        if (terms.sessions.some(target => {
          const row = current.find(row => row.id === target.id);
          return row?.state === "working" || row?.state === "waiting" || row?.state === "starting";
        })) continue;
        try {
          if (operation.kind !== "stop") installations = await engine.installations();
          const admitted = store.operation(operation.id);
          if (admitted.stage !== "waiting" || admitted.revision !== operation.revision) continue;
          if (terms.automatic && terms.stopped.length === 0 && !permitsAutomatic(operation.installationId, operation.restart)) {
            operationChange(operation.id, { stage: "cancelled" });
            managed.setAdmission(operation.installationId, true);
            continue;
          }
          const installation = selected(operation.installationId);
          if (operation.kind === "update" && version(installation) !== operation.beforeVersion)
            throw new AppError("source_changed", "stale_preparation");
          for (const target of terms.sessions) {
            const row = managed.list().find(row => row.id === target.id);
            if (!row || row.generation !== target.generation) throw new AppError("conflict", "stale_generation");
            if (row.state !== "stopped") {
              operationChange(operation.id, { stage: "stopping" });
              await managed.stop(target.id, target.generation);
              const latestTerms = store.terms(operation.id);
              store.putTerms(operation.id, { ...latestTerms, stopped: [...latestTerms.stopped, target.id] });
            }
          }
          switch (operation.kind) {
            case "stop":
              operationChange(operation.id, { stage: "completed" });
              managed.setAdmission(operation.installationId, true);
              break;
            case "restart":
              operationChange(operation.id, { stage: "restarting" });
              for (const target of terms.sessions) await managed.restart(target.id, target.generation, installation);
              operationChange(operation.id, { stage: "completed" });
              managed.setAdmission(operation.installationId, true);
              break;
            case "update": {
              operationChange(operation.id, { stage: "updating" });
              const job = await engine.update(installation, `web:${operation.id}`);
              operationChange(operation.id, { jobId: job.jobId });
              await refreshJobs();
              break;
            }
            case "prepare": case "native-restart": throw new AppError("invalid_request");
          }
        } catch (error) {
          if (store.operation(operation.id).stage === "cancelled") continue;
          if (error instanceof AppError && error.code === "busy") {
            const withdrawn = terms.automatic && store.terms(operation.id).stopped.length === 0
              && !permitsAutomatic(operation.installationId, operation.restart);
            operationChange(operation.id, { stage: withdrawn ? "cancelled" : "waiting", failure: null, detail: error.detail });
            if (withdrawn) managed.setAdmission(operation.installationId, true);
          } else if (store.operation(operation.id).stage === "waiting") {
            operationChange(operation.id, { stage: "failed",
              failure: error instanceof AppError ? error.code : "unavailable", detail: errorText(error) });
            managed.setAdmission(operation.installationId, true);
          } else {
            operationChange(operation.id, { stage: "uncertain", failure: "operation_unverified", detail: errorText(error) });
          }
        }
      }
    } finally { pumping = false; }
  }
  function schedule(): void {
    cancelTimer?.(); cancelTimer = undefined;
    if (closed || closing) return;
    const dates = store.policies().flatMap(policy => isSupportedCli(policyFamily(policy.installationId)) && policy.mode !== "off" && policy.nextCheckAt !== null ? [policy.nextCheckAt] : []);
    if (dates.length) cancelTimer = clock.schedule(Math.min(...dates), () => background(tick()));
  }
  function wakePolicies(): void {
    if (closed || closing) return;
    let changedPolicy = false;
    for (const policy of store.policies()) {
      if(!isSupportedCli(policyFamily(policy.installationId)))continue;
      if (!["work_active", "running_sessions"].includes(policy.waitingReason ?? "")
        || busyInstallation(policy.installationId)) continue;
      const sessions = managed.list().filter(row => row.installationId === policy.installationId && runtimeActive(row));
      const eligible = policy.mode === "update" ? sessions.length === 0
        : policy.mode === "update-and-restart" && sessions.every(row => row.state === "ready");
      if (eligible && (policy.nextCheckAt ?? Infinity) > clock.now()) {
        store.putPolicy({ ...policy, nextCheckAt: clock.now() }); changedPolicy = true;
      }
    }
    if (changedPolicy) schedule();
  }
  async function tick(): Promise<void> {
    if (ticking || closed || closing) return;
    if(bulk.busy()||catalog.busy()||switchingCatalog){cancelTimer=clock.schedule(clock.now()+1000,()=>{background(tick());});return;}
    ticking = true;
    try {
      if(store.policies().some(policy=>isSupportedCli(policyFamily(policy.installationId))&&policy.mode!=='off'&&policy.installationId.startsWith('catalog:')&&(policy.nextCheckAt??Infinity)<=clock.now())){
        catalog.refresh();await catalog.settled();
        await rebaselineCatalogs();
      }
      for (const policy of store.policies().filter(row => isSupportedCli(policyFamily(row.installationId)) && row.mode !== "off" && (row.nextCheckAt ?? Infinity) <= clock.now())) {
        if(closed||closing)break;
        const competitors=competingPolicies(policy.installationId);
        if(competitors.length){
          const candidates=[policy,...competitors].sort((a,b)=>Number(b.installationId.startsWith('catalog:'))-Number(a.installationId.startsWith('catalog:'))||a.installationId.localeCompare(b.installationId));
          const winner=candidates[0];
          store.putPolicies(candidates.filter(row=>row!==winner).map(row=>({...row,mode:'off' as const,nextCheckAt:null,waitingReason:'single_update_target'})));
          if(winner?.installationId!==policy.installationId)continue;
        }
        if(store.policies().find(row=>row.installationId===policy.installationId)?.mode==='off')continue;
        const admitted = JSON.stringify(policy);
        const unchanged = () => JSON.stringify(store.policies().find(row => row.installationId === policy.installationId)) === admitted;
        const next: UpdatePolicy = { ...policy, lastCheckedAt: clock.now(),
          nextCheckAt: clock.now() + policy.intervalMinutes * 60_000, waitingReason: null };
        let waitingReason: string | null = null;
        let lastInstalledVersion: string | null | undefined = policy.lastInstalledVersion;
        try {
          const catalogId=catalogIds.find(id=>policy.installationId===`catalog:${id}`);
          if(catalogId){
            if(policy.mode!=='update'||!policy.catalogBinding)throw new AppError('unsupported','catalog_policy_unsupported');
            const target=await updates.targetFor(catalogId);
            if(updateBinding(target)!==policy.catalogBinding)throw new AppError('source_changed','update_target_changed');
            const entry=catalog.entries().find(row=>row.id===catalogId);
            const binding=entry?catalogCheckBinding(entry):null;
            const latest=await (dependencies.latest??latestCatalogVersion)(catalogId,target);
            if(closed||closing||!unchanged())continue;
            await catalog.settled();
            const checkedEntry=catalog.entries().find(entry=>entry.id===catalogId);
            if(!checkedEntry||catalogCheckBinding(checkedEntry)!==binding)
              throw new AppError('source_changed','installation_selection_changed');
            const installed=checkedEntry?.installed?.version??null;
            const checkResult=latestResult(checkedEntry,latest);
            catalogChecks.set(catalogId,{binding:catalogCheckBinding(checkedEntry),result:checkResult});changed();
            // An installed version that differs from the last check means something outside this app
            // installed it. Record it like an update so the pane-session policy runs as it would after ours.
            const previous=policy.lastInstalledVersion??store.catalogUpdates()
              .filter(job=>job.catalogId===catalogId&&job.stage==='completed'&&job.installedVersion)
              .sort((a,b)=>b.updatedAt-a.updatedAt)[0]?.installedVersion??null;
            lastInstalledVersion=installed;
            if(installed&&previous&&previous!==installed&&(policy.paneSessions??'restart-idle')!=='keep'){
              const external={id:randomUUID(),requestId:`external:${randomUUID()}`,catalogId,revision:0,stage:'completed' as const,target,
                createdAt:clock.now(),updatedAt:clock.now(),beforeVersion:previous,installedVersion:installed,failure:null,
                paneSessions:policy.paneSessions??'restart-idle',paneResults:[]};
              store.putCatalogUpdate(external);changed();
              background(restartCatalogPaneSessions(external.id));
            }
            if(checkResult.status!=='available')continue;
            if(closed||closing||!unchanged())continue;
            const job=await updates.plan(catalogId,`auto:${randomUUID()}`);
            await updates.confirm(job.id,job.revision,()=>!closed&&!closing&&unchanged()
              &&updateBinding(job.target)===policy.catalogBinding,policy.paneSessions??'restart-idle');
            await updates.settled();
            const result=store.catalogUpdates().find(row=>row.id===job.id);
            if(result?.stage!=='completed')throw new AppError('uncertain',result?.failure??'update_unverified');
            lastInstalledVersion=result.installedVersion??lastInstalledVersion;
            continue;
          }
          await check(policy.installationId);
          if (closed || closing || !unchanged()) continue;
          const latest = selected(policy.installationId).lastCheck?.result;
          if (latest?.kind === "unavailable") throw new AppError("unavailable", "check_failed");
          if (policy.mode === "check" || latest?.kind !== "update-available") continue;
          const sessions = managed.list().filter(row => row.installationId === policy.installationId && runtimeActive(row));
          if (busyInstallation(policy.installationId)) throw new AppError("busy", "operation_in_progress");
          if (sessions.some(row => row.state !== "ready")) throw new AppError("busy", "work_active");
          if (policy.mode === "update" && sessions.length) throw new AppError("busy", "running_sessions");
          await prepare(policy.installationId, `auto:${randomUUID()}`, true);
        } catch (error) { waitingReason = errorText(error); }
        finally { if (unchanged()) store.putPolicy({ ...next, waitingReason, lastInstalledVersion }); }
      }
    } finally { ticking = false; changed(); schedule(); }
  }
  async function command(request: CommandEnvelope): Promise<AppSnapshot> {
    if (closed || closing) throw new AppError("unavailable");
    if (!store.accept(request)) {
      const outcome = store.outcome(request.requestId);
      if (outcome === "failed") throw new AppError("conflict", "previous_request_failed");
      if (outcome === "uncertain") throw new AppError("uncertain");
      return snapshot();
    }
    const action: Exclude<AppCommand,{kind:'automation'}> = request.command.kind==='automation'
      ?{kind:'policy',installationId:request.command.installationId,mode:request.command.enabled?'update':'off',intervalMinutes:60,firstCheck:'now',
        paneSessions:store.automationSettings().paneSessions}
      :request.command;
    try {
      if(switchingCatalog&&!['refresh','send','respond'].includes(action.kind))throw new AppError('busy','operation_in_progress');
      if(catalog.busy()&&!['refresh','send','respond'].includes(action.kind)&&!(action.kind==='policy'&&action.mode==='off'))throw new AppError('busy','install_in_progress');
      if(bulk.busy()&&!['refresh','send','respond'].includes(action.kind)
        &&!(action.kind==='policy'&&action.mode==='off'))throw new AppError('busy','bulk_in_progress');
      if(nativeBusy()&&!['refresh','send','respond'].includes(action.kind)
        &&!(action.kind==='policy'&&action.mode==='off'))throw new AppError('busy','native_restart_in_progress');
      if(defaults.busy()&&!['refresh','send','respond'].includes(action.kind)
        &&!(action.kind==='policy'&&action.mode==='off'))throw new AppError('busy','default_switch_in_progress');
      if(updates.busy()&&!['refresh','send','respond'].includes(action.kind)
        &&!(action.kind==='policy'&&action.mode==='off'))throw new AppError('busy','update_in_progress');
      if(removal.busy()&&!['refresh','send','respond'].includes(action.kind)
        &&!(action.kind==='policy'&&action.mode==='off'))throw new AppError('busy','removal_in_progress');
      switch (action.kind) {
        case 'automation-settings': {
          if(ticking||store.operations().some(active))throw new AppError('busy','operation_in_progress');
          store.putAutomationSettings(action.paneSessions);changed();break;
        }
        case "native-restart": {
          if(catalog.busy()||store.operations().some(active))throw new AppError("busy","operation_in_progress");
          const metadata=native.snapshot().selections.find(row=>row.installation.installationId===action.installation.installationId);
          if(!metadata)throw new AppError("source_changed","native_selection_unavailable");
          if(!isSupportedCli(metadata.installation.family))throw new AppError('unsupported','cli_not_supported');
          const operation=newOperation(metadata.installation,request.requestId,"native-restart",[action.target.targetId],true);
          operationChange(operation.id,{stage:"restarting"});
          try {
            const job=await native.restart(action.installation,action.target,`native:${operation.id}`);
            operationChange(operation.id,{jobId:job.jobId});
            await refreshJobs();
          } catch(error) {
            operationChange(operation.id,{stage:error instanceof AppError&&["busy","source_changed"].includes(error.code)?"failed":"uncertain",
              failure:errorText(error)});
            throw error;
          }
          break;
        }
        case 'catalog-select': {
          if(!isSupportedCli(action.catalogId))throw new AppError('unsupported','cli_not_supported');
          mutationGuard();catalog.refresh();await catalog.settled();
          const installation=catalog.entries().find(row=>row.id===action.catalogId)?.installations?.find(row=>row.id===action.installationId);
          if(!installation)throw new AppError('not_found','installation_missing');
          const reviewed=action.reviewed;
          if(reviewed&&(reviewed.path!==installation.path||reviewed.identityPath!==installation.identityPath||reviewed.version!==installation.version))
            throw new AppError('source_changed','installation_selection_changed');
          await switchCatalogTarget(action.catalogId,installation,reviewed?.makeDefault??false);break;
        }
        case 'default-plan':await defaults.plan(action.catalogId,action.installationId,request.requestId);break;
        case 'default-confirm':await defaults.confirm(action.jobId,action.revision);break;
        case 'catalog-update-plan':await updates.plan(action.catalogId,request.requestId);break;
        case 'catalog-update-recover':await updates.recover(action.jobId,action.revision,action.action);break;
        case 'catalog-check':if(!isSupportedCli(action.catalogId))throw new AppError('unsupported','cli_not_supported');background(checkCatalog(action.catalogId).then(()=>{}));break;
        case 'catalog-check-all':background(bulk.plan(false));break;
        case 'catalog-update-all-plan':background(bulk.plan(true));break;
        case 'catalog-update-all-confirm':background(bulk.confirm(action.batchId,action.revision));break;
        case 'catalog-update-confirm':{
          const job=store.catalogUpdates().find(row=>row.id===action.jobId);
          await updates.confirm(action.jobId,action.revision,()=>true,action.paneSessions??paneSessionPolicy(`catalog:${job?.catalogId??''}`));break;
        }
        case "refresh": if(!initialized)await initialize();else await refresh(true); break;
        case "install-plan": mutationGuard();await catalog.plan(action.catalogId, request.requestId,action.method,action.makeDefault); break;
        case "install-confirm": mutationGuard();await catalog.confirm(action.jobId, action.revision); break;
        case "install-recover": mutationGuard();await catalog.recover(action.jobId,action.revision,action.action); break;
        case 'remove-plan':catalog.refresh();await catalog.settled();await removal.plan(action.catalogId,request.requestId,action.installationId);break;
        case 'remove-confirm': await removal.confirm(action.jobId,action.revision);break;
        case "check": await check(action.installationId); break;
        case "prepare": await prepare(action.installationId, request.requestId); break;
        case "confirm": {
          const operation = store.operation(action.operationId);
          if (operation.revision !== action.revision) throw new AppError("conflict", "stale_preparation");
          await confirm(operation, action.sessions, action.restart, false, action.paneSessions ?? paneSessionPolicy(operation.installationId)); break;
        }
        case "cancel": {
          const operation = store.operation(action.operationId);
          if (operation.revision !== action.revision || !["preparing", "ready", "waiting"].includes(operation.stage))
            throw new AppError("conflict", "cancel_unsafe");
          if (store.terms(operation.id).stopped.length > 0)
            throw new AppError("conflict", "cancel_unsafe");
          operationChange(operation.id, { stage: "cancelled" });
          preparations.get(operation.id)?.abort();
          managed.setAdmission(operation.installationId, true);
          break;
        }
        case "launch":
          installations = await engine.installations();
          if(updates.busy())throw new AppError('busy','update_in_progress');
          if(defaults.busy())throw new AppError('busy','default_switch_in_progress');
          if(removal.busy())throw new AppError('busy','removal_in_progress');
          if (busyInstallation(action.installationId)) throw new AppError("busy", "operation_in_progress");
          await managed.launch(selected(action.installationId), action.cwd); break;
        case "stop": case "restart": {
          const row = managed.list().find(row => row.id === action.sessionId);
          if (!row || row.generation !== action.generation) throw new AppError("conflict", "stale_generation");
          if (busyInstallation(row.installationId)) throw new AppError("busy", "operation_in_progress");
          const operation = newOperation(selected(row.installationId), request.requestId, action.kind, [row.id], action.kind === "restart");
          store.putTerms(operation.id, { sessions: [{ id: row.id, generation: row.generation }], automatic: false, stopped: [] });
          managed.setAdmission(row.installationId, false); background(pump()); break;
        }
        case "pane-restart": {
          if (!herdr) throw new AppError("unsupported", "herdr_unavailable");
          const session = external.find(row => row.id === action.sessionId && row.processState !== "exited");
          if (!session || !session.herdrPane || session.herdrPane.paneId !== action.paneId) throw new AppError("conflict", "pane_changed");
          if(!isSupportedCli(session.family))throw new AppError('unsupported','cli_not_supported');
          if ([...paneRestarts.values()].some(job => job.paneId === action.paneId && !["completed", "failed"].includes(job.stage)))
            throw new AppError("busy", "pane_restart_in_progress");
          const seq = session.herdrPane.stateChangeSeq;
          background(restartInPane({ ...paneRestartOptions(), herdr, session, initialSeq: seq, trustScreen: action.trustScreen === true })
            .then(async () => { await refreshHerdrAgents(); observeProcesses(); }));
          break;
        }
        case "send": await managed.send(action.sessionId, action.generation, action.message); break;
        case "respond": await managed.respond(action.sessionId, action.generation, action.approvalId, action.value); break;
        case "policy": {
          if(action.mode!=='off'&&!isSupportedCli(policyFamily(action.installationId)))throw new AppError('unsupported','cli_not_supported');
          const intent=Symbol();
          policyIntents.set(action.installationId,intent);
          const catalogId=catalogIds.find(id=>action.installationId===`catalog:${id}`);
          let catalogBinding:string|undefined;
          if(catalogId){
            if(action.mode!=='off'&&action.mode!=='update')throw new AppError('unsupported','catalog_policy_unsupported');
            if(action.mode!=='off'){
              if(catalog.busy())throw new AppError('busy','install_in_progress');
              const selected=catalog.entries().find(row=>row.id===catalogId);
              const identity=JSON.stringify([selected?.selectedInstallationId,selected?.installed?.path]);
              catalogBinding=updateBinding(await updates.targetFor(catalogId));
              const current=catalog.entries().find(row=>row.id===catalogId);
              if(catalog.busy()||JSON.stringify([current?.selectedInstallationId,current?.installed?.path])!==identity)
                throw new AppError('source_changed','installation_selection_changed');
            }
          }else if(action.mode!=='off') {
            const legacy=selected(action.installationId);
            const entry=catalog.entries().find(row=>row.id===legacy.family&&row.installed);
            if(entry&&entry.installed?.path!==legacy.executableRealpath&&entry.installed?.identityPath!==legacy.executableRealpath)
              throw new AppError('conflict','select_management_target_first');
          }
          if(policyIntents.get(action.installationId)!==intent)throw new AppError('conflict','policy_changed');
          if(action.mode!=='off'){
            const competing=competingPolicies(action.installationId);
            if(store.operations().some(row=>active(row)&&competing.some(policy=>policy.installationId===row.installationId)))throw new AppError('busy','operation_in_progress');
            store.putPolicies(competing.map(row=>({...row,mode:'off' as const,nextCheckAt:null,waitingReason:null})));
          }
          const previous = store.policies().find(row => row.installationId === action.installationId);
          const sameSchedule = previous !== undefined && previous.mode === action.mode && previous.intervalMinutes === action.intervalMinutes
            && (previous.firstCheck ?? "now") === (action.firstCheck ?? "now") && action.paneSessions !== undefined && action.paneSessions !== previous.paneSessions;
          store.putPolicy({ installationId: action.installationId, mode: action.mode, intervalMinutes: action.intervalMinutes,
            ...(catalogBinding?{catalogBinding}:{}), paneSessions: action.paneSessions ?? previous?.paneSessions ?? "keep",
            firstCheck: action.firstCheck ?? "now", lastCheckedAt: previous?.lastCheckedAt ?? null,
            nextCheckAt: action.mode === "off" ? null : sameSchedule ? previous.nextCheckAt
              : clock.now() + (action.firstCheck === "after-interval" ? action.intervalMinutes * 60_000 : 0),
            waitingReason: sameSchedule ? previous.waitingReason : null });
          if (action.mode === "off" || action.mode === "check" || previous?.mode !== action.mode) {
            for (const operation of store.operations().filter(row => row.installationId === action.installationId
              && ["preparing", "ready", "waiting"].includes(row.stage))) {
              const terms = store.terms(operation.id);
              if (terms.automatic && terms.stopped.length === 0) {
                operationChange(operation.id, { stage: "cancelled" });
                preparations.get(operation.id)?.abort();
                managed.setAdmission(operation.installationId, true);
              }
            }
          }
          changed(); schedule(); break;
        }
        default: unreachable(action);
      }
      store.finish(request.requestId, "completed");
      return snapshot();
    } catch (error) {
      store.finish(request.requestId, error instanceof AppError && error.code === "uncertain" ? "uncertain" : "failed");
      throw error;
    }
  }
  try {
    for (const operation of store.operations().filter(active)) {
      operationChange(operation.id, {
        stage: operation.kind === "prepare" ? "failed" : "uncertain",
        failure: "service_restarted", detail: "inspect_before_retry",
      });
    }
    await initialize();
  } catch (error) {
    service = "unavailable"; failure = errorText(error); changed();
  }
  return {
    snapshot, settled,
    /** A relaunched CLI (for example `omo -r`) has a new PID; the next `open` re-binds the exact conversation. */
    bindCurrentConversation(context: CurrentConversationContext | null): void {
      if (closed || closing) throw new AppError("busy");
      currentConversation = context; observeProcesses();
    },
    async command(request: CommandEnvelope): Promise<AppSnapshot> {
      commands++;
      try { return await command(request); } finally { commands--; }
    },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    async close(): Promise<void> {
      if (closing || commands || bulk.busy() || catalog.busy() || removal.busy() || updates.busy() || defaults.busy() || store.operations().some(row => ["preparing", "waiting", "stopping", "updating", "verifying", "restarting"].includes(row.stage)))
        throw new AppError("busy", "operation_in_progress");
      closing = true; cancelTimer?.(); cancelObservation?.();
      try {
        await settled();
        await managed.close();
        await engine.close();
        closed = true; listeners.clear(); store.close();
      } catch (error) { closing = false; schedule(); scheduleObservation(); throw error; }
    },
  };
}
function unreachable(_value: never): never { throw new AppError("invalid_request"); }
