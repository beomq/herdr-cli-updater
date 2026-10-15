import { expect, test } from "bun:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JobStore } from "../../src/jobs/store";
import { MutationQueue } from "../../src/install/queue";
import { createDomain } from "../../src/service/domain";
import { createUpdateOnlyJobRunner } from "../../src/service/job-runner";
import type { LifecycleClaim, LifecyclePort } from "../../src/service/job-runner";
import { RestartError } from "../../src/service/restart-runner";
import type { RestartSource } from "../../src/service/restart-runner";
import { serveWorker } from "../../src/service/worker";
import { attachAuthenticatedWorker } from "../../src/service/client";
import { requestPrivateSocket } from "../../src/service/socket";
import type { InstallationIdentity } from "../../src/adapters/types";
import type { Job, Receipt, RuntimeBinding, ServiceRequest, TargetSelection } from "../../src/protocol";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function bounded<T>(promise: Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(5000), timeout = Promise.withResolvers<never>();
  const abort = () => timeout.reject(new Error("test_event_timeout"));
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([promise, timeout.promise]); }
  finally { signal.removeEventListener("abort", abort); }
}
async function fixture(options: { working?: boolean; uncertain?: "stop" | "release"; staleObservation?: boolean } = {}) {
  const root = realpathSync(mkdtempSync("/tmp/native-restart-"));
  const executable = join(root, "payload"), session = "same-conversation";
  writeFileSync(executable, "installed-v2", { mode: 0o600 });
  const resources = [{ resourceId: `resource:${hash(executable)}`, realpath: executable, fingerprint: `sha256:${hash("installed-v2")}` }];
  const installation: InstallationIdentity = { installationId: `install:${hash(executable)}`, family: "codex", channel: "latest",
    owner: { kind: "package", manager: "npm", packageName: "@openai/codex", prefix: root },
    executableRealpath: executable, resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}`,
    installedVersion: { kind: "known", version: "2.0.0" } };
  async function spawn(version: string) {
    const child = fork(join(import.meta.dir, "fixtures/restart-child.ts"), [session, version],
      { execPath: process.execPath, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const [ready] = await bounded(once(child, "message"));
    expect(ready).toEqual({ session, version });
    return child;
  }
  let child = await spawn("1.0.0"), generation = 1, reads = 0, sourceValid = true, working = options.working ?? false;
  const children = [child], effects: string[] = [];
  const drained = Promise.withResolvers<{ ok: true; value: RuntimeBinding }>();
  const claimedEvent = Promise.withResolvers<void>(), completed = Promise.withResolvers<Job>(), recovery = Promise.withResolvers<Job>();
  const binding = (): RuntimeBinding => ({ socketId: "socket", socketEpoch: "epoch", paneId: "pane", paneGeneration: generation,
    rootIncarnation: { pid: child.pid ?? 1, startIdentity: `process:${generation}`, executableRealpath: executable },
    session: { kind: "conversation", fullId: session, storagePathHash: "storage" }, cwd: root,
    optionsRef: "options", turnGeneration: 1, resourcesFingerprint: installation.resourcesFingerprint });
  const target = (): TargetSelection => ({ targetId: "target", runtimeId: "runtime", installationId: installation.installationId, expectedBinding: binding() });
  const source: RestartSource = { installationId: installation.installationId, read: async () => {
    reads++;
    const selected = target(), expected = selected.expectedBinding;
    let claimed: LifecycleClaim | undefined;
    const receipts = new Map<string, Receipt>();
    const fence = () => {
      if (!sourceValid || readFileSync(executable, "utf8") !== "installed-v2") throw new RestartError("stale_selection");
    };
    const lifecycle: LifecyclePort = {
      subscribe: () => ({ completed: drained.promise, close: () => {} }),
      inspect: async () => ({ ok: true, value: { binding: binding(), complete: !working } }),
      claim: async () => {
        effects.push("claim"); claimed = { binding: expected, profile: "qualified", handle: {} };
        claimedEvent.resolve(); return { ok: true, value: claimed };
      },
      stop: async (claim, operationId) => {
        expect(claimed).toBe(claim); effects.push("stop");
        if (options.uncertain === "stop") return { ok: true, value: { kind: "uncertain", operationId } };
        const exited = once(child, "exit"); child.send("stop"); await bounded(exited);
        expect(child.exitCode).toBe(0);
        const receipt: Receipt = { kind: "completed", operationId, effect: "stopped", identity: expected };
        receipts.set(operationId, receipt); return { ok: true, value: receipt };
      },
      start: async (claim, operationId, stopId) => {
        expect(claimed).toBe(claim); expect(receipts.get(stopId)?.kind).toBe("completed");
        expect(child.exitCode).toBe(0); effects.push("start");
        child = await spawn("2.0.0"); children.push(child); generation++;
        const receipt: Receipt = { kind: "completed", operationId, effect: "started", identity: binding() };
        receipts.set(operationId, receipt); return { ok: true, value: receipt };
      },
      release: async (claim, identity) => {
        expect(claimed).toBe(claim); expect(identity).toEqual(binding()); effects.push("release");
        return options.uncertain === "release" ? { ok: false, error: { code: "receipt_uncertain" } } : { ok: true, value: null };
      },
      result: async operationId => ({ ok: true, value: receipts.get(operationId) ?? { kind: "uncertain", operationId } }),
    };
    fence();
    return { installation, target: selected, runtime: { runtimeId: "runtime", installationId: installation.installationId,
      binding: expected, runningVersion: { kind: "known", version: generation === 1 ? "1.0.0" : "2.0.0" } },
      lifecycle, evidenceRef: executable, fence, observe: () => { fence(); return installation; } };
  } };
  let domain: ReturnType<typeof createDomain> | undefined;
  let store: JobStore | undefined;
  const queue = new MutationQueue(join(root, "queue"));
  const worker = serveWorker(join(root, "worker"), (request, signal) => {
    if (!domain) throw new Error("fixture_not_ready");
    return domain.handle(request, signal);
  }, async () => { await domain?.close(); queue.close(); });
  const unsupported = { kind: "unsupported", reason: "not_verified" } as const;
  domain = createDomain(worker.owner.directory, { sockets: [],
    ...(options.staleObservation ? { runtimeSources: [{ socketId: "socket",
      read: async () => ({ ok: false as const, error: { code: "stale_binding" as const } }) }] } : {}),
    candidates: [{
    candidateId: "installed", family: "codex", read: async () => ({ ok: true, value: {
      contract: { version: 1, family: "codex", installation, runtime: null,
        capabilities: { check: unsupported, update: unsupported, busySafe: unsupported,
          completion: unsupported, resume: unsupported, gracefulExit: unsupported } }, lastCheck: null,
    } }),
  }] }, undefined, jobStore => {
    store = jobStore;
    return createUpdateOnlyJobRunner({ store: jobStore, queue, owner: worker.owner, receiptRoot: root, restartSources: [source],
      publication: { get sequence() { return worker.transport.sequence; },
        admit: response => { if (!worker.transport.canPublish(response)) throw new Error("publish_refused"); return null; },
        publish: response => {
          worker.transport.publish(response);
          if (response.ok && response.operation === "inspect-job") {
            if (response.result.job.status === "completed") completed.resolve(response.result.job);
            if (response.result.job.targetTxns.some(target => target.state === "recovery_required")) recovery.resolve(response.result.job);
          }
        } } });
  });
  if (!store) throw new Error("fixture_store_missing");
  const client = await attachAuthenticatedWorker(worker.owner.directory, 5000);
  const selection = { installationId: installation.installationId, resourcesFingerprint: installation.resourcesFingerprint,
    owner: installation.owner, installedVersion: installation.installedVersion };
  return { root, store, worker, client, effects, installation, selection, target, source,
    reads: () => reads, invalidate: () => { sourceValid = false; },
    drain: () => { working = false; drained.resolve({ ok: true, value: binding() }); },
    claimed: claimedEvent.promise, completed: completed.promise, recovery: recovery.promise,
    async close() {
      client.close(); await worker.stop();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit"); child.kill(); await bounded(exit);
      }
      rmSync(root, { recursive: true, force: true });
    } };
}

test("authenticated restart stops and starts a real child without updating installation", async () => {
  const f = await fixture();
  try {
    const before = f.target();
    const result = await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [before] }, "restart");
    expect(result.ok).toBe(true);
    const job = await bounded(f.completed);
    expect(job.installTxn).toMatchObject({ state: "not_required", receipt: null, failure: null });
    expect(job.targetTxns[0]).toMatchObject({ state: "completed", receipt: { kind: "completed", effect: "started",
      identity: { paneGeneration: 2, session: before.expectedBinding.session } } });
    expect(f.effects).toEqual(["claim", "stop", "start", "release"]);
    expect(readFileSync(join(f.root, "payload"), "utf8")).toBe("installed-v2");
    const repeats = await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [before] }, "restart");
    expect(repeats.ok && repeats.result.kind).toBe("existing");
    expect(f.effects).toHaveLength(4);
  } finally { await f.close(); }
});
test("fresh targets enable a second restart while stale target selection fails closed", async () => {
  const f = await fixture({ staleObservation: true });
  try {
    const old = f.target();
    await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [old] }, "first");
    await bounded(f.completed);
    const stale = await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [old] }, "stale");
    expect(stale).toMatchObject({ ok: false, error: { code: "stale_binding" } });
    const selected = await f.client.request({ operation: "targets", installationId: f.installation.installationId });
    if (!selected.ok || !selected.result.targets[0]) throw new Error("missing_target");
    expect(selected.result.selection?.targets[0]?.runningVersion).toEqual({ kind: "known", version: "2.0.0" });
    const done = Promise.withResolvers<void>();
    const subscription = await f.client.subscribe({ incarnation: f.client.incarnation, sequence: "current" }, {
      event: event => { if (event.response.ok && event.response.operation === "inspect-job"
        && event.response.result.job.requestId === "second" && event.response.result.job.status === "completed") done.resolve(); },
      error: done.reject,
    });
    try {
      await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection,
        selectedTargets: [selected.result.targets[0]] }, "second");
      await bounded(done.promise);
      expect(f.target().expectedBinding.paneGeneration).toBe(3);
      expect(f.reads()).toBeGreaterThanOrEqual(4);
    } finally { subscription.close(); }
  } finally { await f.close(); }
});
test("natural drain reserves the durable writer and excludes update intent", async () => {
  const f = await fixture({ working: true });
  try {
    await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [f.target()] }, "drain");
    await bounded(f.claimed);
    expect(f.effects).toEqual(["claim"]);
    const update = f.store.create({ jobId: "update", requestId: "update", mode: "update-only", selectedTargets: [], installation: f.selection });
    expect(() => f.store.change({ jobId: update.job.jobId, expectedRevision: 0 },
      { kind: "intent", operationId: "install", effect: "updated", targetId: null })).toThrow("resources_busy");
    f.drain(); await bounded(f.completed);
    expect(f.store.change({ jobId: "update", expectedRevision: 0 },
      { kind: "intent", operationId: "install", effect: "updated", targetId: null }).kind).toBe("authorized");
  } finally { f.drain(); await f.close(); }
});
test("active installation intent refuses restart before native claim", async () => {
  const f = await fixture();
  try {
    f.store.create({ jobId: "update", requestId: "update", mode: "update-only", selectedTargets: [], installation: f.selection });
    f.store.change({ jobId: "update", expectedRevision: 0 }, { kind: "intent", operationId: "install", effect: "updated", targetId: null });
    const result = await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [f.target()] });
    expect(result).toMatchObject({ ok: false, error: { code: "resources_busy" } });
    expect(f.effects).toEqual([]);
  } finally { await f.close(); }
});
for (const uncertain of ["stop", "release"] as const) test(`uncertain ${uncertain} retains ownership without replay or compensation`, async () => {
  const f = await fixture({ uncertain });
  try {
    const selected = f.target();
    await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [selected] }, "unknown");
    const job = await bounded(f.recovery), effects = [...f.effects];
    const current = await f.client.request({ operation: "inspect-job", jobId: job.jobId });
    if (!current.ok) throw new Error("missing_job");
    const inspected = await f.client.request({ operation: "reconcile-job", jobId: job.jobId, expectedRevision: current.result.job.revision });
    expect(inspected.ok && inspected.result.kind).toBe("recovery-required");
    const again = await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [selected] }, "unknown");
    expect(again.ok && again.result.kind).toBe("existing");
    const retry = await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [f.target()] }, "retry");
    expect(retry).toMatchObject({ ok: false, error: { code: "resources_busy" } });
    expect(f.effects).toEqual(effects);
    expect(job.installTxn).toMatchObject({ state: "not_required", receipt: null });
  } finally { await f.close(); }
});
test("unauthenticated or changed source cannot dispatch native effects", async () => {
  const f = await fixture();
  try {
    const request: ServiceRequest = { version: 1, requestId: "unauthorized", token: "0".repeat(64),
      operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [f.target()] };
    expect(await requestPrivateSocket(f.worker.owner, request)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    f.invalidate();
    const result = await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [f.target()] });
    expect(result).toMatchObject({ ok: false, error: { code: "stale_selection" } });
    expect(f.effects).toEqual([]);
  } finally { await f.close(); }
});

for (const first of ["update", "restart"] as const) test(`shared queue excludes ${first === "update" ? "restart" : "update"} across independent connections`, async () => {
  const f = await fixture({ working: true });
  const other = new MutationQueue(join(f.root, "queue"));
  const supported = { kind: "supported", reason: "verified", evidenceRef: "fixture" } as const;
  const unsupported = { kind: "unsupported", reason: "not_verified" } as const;
  const plan = { contract: { version: 1, family: "codex", installation: f.installation, runtime: null,
    capabilities: { check: supported, update: supported, busySafe: unsupported, completion: unsupported,
      gracefulExit: unsupported, resume: unsupported } }, mode: "update-only", selectedTargets: [],
    installerDigest: hash("installer"), mutationResources: f.installation.resources } as const;
  const observe = () => ({ installation: f.installation, installerDigest: plan.installerDigest,
    mutationResources: plan.mutationResources, allSocketsKnown: true, outsideConsumersKnown: true, consumers: [], busySafety: null });
  try {
    if (first === "update") {
      const queued = other.enqueue({ jobId: "other-update", requestId: "other-update", plan });
      const owned = other.acquire(queued.entry.jobId, queued.entry.revision, observe);
      const result = await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [f.target()] });
      expect(result).toMatchObject({ ok: false, error: { code: "resources_busy" } });
      expect(f.effects).toEqual([]);
      other.complete(owned, f.installation, () => f.installation);
    } else {
      await f.client.request({ operation: "create-job", mode: "restart-only", installation: f.selection, selectedTargets: [f.target()] });
      await bounded(f.claimed);
      const queued = other.enqueue({ jobId: "other-update", requestId: "other-update", plan });
      expect(() => other.acquire(queued.entry.jobId, queued.entry.revision, observe)).toThrow("resources_busy");
      f.drain(); await bounded(f.completed);
      const owned = other.acquire(queued.entry.jobId, queued.entry.revision, observe);
      expect(owned.kind).toBe("mutation-ownership");
      other.complete(owned, f.installation, () => f.installation);
    }
  } finally { f.drain(); other.close(); await f.close(); }
});
