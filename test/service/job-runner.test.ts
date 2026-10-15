import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { once } from "node:events";
import { JobStore } from "../../src/jobs/store";
import { MutationQueue } from "../../src/install/queue";
import { createUpdateOnlyJobRunner } from "../../src/service/job-runner";
import type { LifecyclePort, UpdateOnlyRunnerConfiguration } from "../../src/service/job-runner";
import { createDomain } from "../../src/service/domain";
import { attachAuthenticatedWorker } from "../../src/service/client";
import { serveWorker } from "../../src/service/worker";
import { connectPrivateSocket, requestPrivateSocket } from "../../src/service/socket";
import type { InstallationIdentity } from "../../src/adapters/types";
import type { Job, RuntimeBinding, ServiceRequest, ServiceResponse, TargetSelection } from "../../src/protocol";
import { fixture, hash, now } from "../../.omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/fixture";

// Real qualifier, adapter, SQL, queue, private UDS and native process controls.
// This pinned controlled manager is NOT genuine vendor installation evidence.
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function bounded<T>(promise: Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(5000);
  const timeout = Promise.withResolvers<never>();
  const abort = () => timeout.reject(new TypeError("owned_event_timeout"));
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([promise, timeout.promise]); }
  finally { signal.removeEventListener("abort", abort); }
}
function actualInstallation(f: Fixture): InstallationIdentity {
  const data: unknown = JSON.parse(readFileSync(join(f.wrapper, "package.json"), "utf8"));
  if (typeof data !== "object" || data === null || !("version" in data) || typeof data.version !== "string")
    throw new TypeError("private_actual_manifest");
  const resources = f.installation.resources.map(row => ({ ...row, fingerprint: `sha256:${hash(readFileSync(row.realpath))}` }));
  return { ...f.installation, installedVersion: { kind: "known", version: data.version },
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
}
async function profile(f: Fixture): Promise<NonNullable<UpdateOnlyRunnerConfiguration["profile"]>> {
  const files = new Map(f.files);
  // Expected digests originate in independent archive/declared postinstall inputs,
  // not the files read after the native process.
  const resources = f.installation.resources.map(row => {
    const body = files.get(row.realpath);
    return { ...row, fingerprint: body === undefined ? row.fingerprint : `sha256:${hash(body)}` };
  });
  const expectedAfter: InstallationIdentity = { ...f.installation,
    installedVersion: { kind: "known", version: "5.1.10" }, resources,
    resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  const afterBody = JSON.stringify(expectedAfter), afterPath = join(f.root, "expected-after.json");
  await writeFile(afterPath, afterBody);
  const unknown = { kind: "unknown", reason: "not_verified" } as const;
  return {
    adapter: f.adapter,
    contract: { version: 1, family: "omo", installation: f.installation, runtime: null,
      capabilities: { check: { kind: "supported", reason: "verified", evidenceRef: f.input.receipt.path },
        update: { kind: "supported", reason: "verified", evidenceRef: f.input.receipt.path },
        busySafe: unknown, completion: unknown, resume: unknown, gracefulExit: unknown } },
    sourcePins: [f.input.qualification.manager, f.input.receipt,
      ...f.input.qualification.target.artifacts.flatMap(row => [row.archive, row.metadata])],
    expectedAfter, expectedAfterPin: { path: afterPath, sha256: hash(afterBody) },
    // Coverage is explicitly restricted to this fresh task-owned prefix, two
    // private workers and their managed installer. No operating-user assertion.
    observe: plan => ({ installation: actualInstallation(f), installerDigest: plan.installerDigest,
      mutationResources: plan.mutationResources, allSocketsKnown: true, outsideConsumersKnown: true,
      consumers: [], busySafety: null }),
    observeAfter: () => actualInstallation(f),
  };
}
async function effects(f: Fixture): Promise<readonly { readonly pid: number; readonly registryPort: number }[]> {
  let body: string;
  try { body = await readFile(f.effects, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return body.trim().split("\n").map(line => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("pid" in value) || typeof value.pid !== "number"
      || !("registryPort" in value) || typeof value.registryPort !== "number") throw new TypeError("private_effect_record");
    return { pid: value.pid, registryPort: value.registryPort };
  });
}
function createRequest(f: Fixture, requestId: string, token: string): Extract<ServiceRequest, { readonly operation: "create-job"; readonly mode: "update-only" }> {
  const installation = f.installation;
  return { version: 1, token, requestId, operation: "create-job", mode: "update-only", selectedTargets: [],
    installation: { installationId: installation.installationId, owner: installation.owner,
      resourcesFingerprint: installation.resourcesFingerprint, installedVersion: installation.installedVersion } };
}
async function service(f: Fixture, name: string, queueRoot: string,
  options: { readonly absent?: boolean; readonly admit?: (response: ServiceResponse) => void;
    readonly lifecycle?: LifecyclePort; readonly target?: TargetSelection; readonly domain?: boolean;
    readonly handled?: (request: ServiceRequest) => void; readonly observed?: () => void;
    readonly additionalProfiles?: readonly NonNullable<UpdateOnlyRunnerConfiguration["profile"]>[] } = {}) {
  const store = new JobStore(join(f.root, `${name}.jobs`)), queue = new MutationQueue(queueRoot);
  const completed = Promise.withResolvers<Job>(), waiting = Promise.withResolvers<Job>(), refused = Promise.withResolvers<void>();
  const recovery = Promise.withResolvers<Job>();
  let runner: ReturnType<typeof createUpdateOnlyJobRunner> | undefined;
  let domain: ReturnType<typeof createDomain> | undefined;
  const worker = serveWorker(join(f.root, name), async (request, signal) => {
    if (!runner) throw new TypeError("owned_runner_not_ready");
    const response = await (domain ? domain.handle(request, signal) : runner.handle(request, signal));
    options.handled?.(request);
    return response;
  }, async () => { if (domain) await domain.close(); else await runner?.close(); queue.close(); store.close(); });
  const original = options.absent ? undefined : await profile(f);
  const base = original && { ...original, observe: (plan: Parameters<typeof original.observe>[0]) => {
    options.observed?.();
    return original.observe(plan);
  } };
  const supported = { kind: "supported", reason: "verified", evidenceRef: "controlled-lifecycle-not-native" } as const;
  const configured = base && options.target ? { ...base, contract: { ...base.contract,
    runtime: { runtimeId: options.target.runtimeId, installationId: options.target.installationId,
      binding: options.target.expectedBinding, runningVersion: base.contract.installation.installedVersion },
    capabilities: { ...base.contract.capabilities, completion: supported, resume: supported, gracefulExit: supported },
  } } : base;
  const configuration: UpdateOnlyRunnerConfiguration = {
    store, queue, owner: worker.owner, receiptRoot: f.journal, now: () => now,
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    ...(configured ? { profile: configured } : {}),
    ...(options.additionalProfiles ? { profiles: options.additionalProfiles } : {}),
    publication: {
      get sequence() { return worker.transport.sequence; },
      admit: response => {
        if (!worker.transport.canPublish(response)) throw new TypeError("private_publication_refused");
        try { options.admit?.(response); }
        catch (error) { refused.resolve(); throw error; }
        return null;
      },
      publish: response => {
        worker.transport.publish(response);
        if (response.ok && response.operation === "inspect-job") {
          if (response.result.job.status === "completed") completed.resolve(response.result.job);
          if (response.result.job.status === "waiting") waiting.resolve(response.result.job);
          if (response.result.job.status === "recovery_required"
            && response.result.job.installTxn.state === "recovery_required") recovery.resolve(response.result.job);
        }
      },
    },
  };
  if (options.domain && configured) {
    domain = createDomain(join(f.root, name), { candidates: [{ candidateId: "controlled-installation",
      family: "omo", read: async () => ({ ok: true, value: { contract: { ...configured.contract,
        runtime: null, capabilities: { ...configured.contract.capabilities,
          completion: { kind: "unknown", reason: "not_verified" },
          resume: { kind: "unknown", reason: "not_verified" },
          gracefulExit: { kind: "unknown", reason: "not_verified" } },
      }, lastCheck: { checkedAt: now, result: { kind: "update-available", installedVersion: "5.1.9",
        availableVersion: "5.1.10", checkedAt: now } } } }) }], sockets: [] },
    configuration.publication, domainStore => {
      runner = createUpdateOnlyJobRunner({ ...configuration, store: domainStore });
      return runner;
    });
  } else runner = createUpdateOnlyJobRunner(configuration);
  const token = await readFile(worker.owner.tokenPath, "utf8");
  async function request(input: ServiceRequest): Promise<ServiceResponse> {
    const value = await requestPrivateSocket(worker.owner, input);
    // Own private wire response, correlated by actual transport; no forced cast.
    const { isServiceResponse } = await import("../../src/service/client");
    if (!isServiceResponse(value)) throw new TypeError("private_wire_response");
    return value;
  }
  return { store, queue, worker, runner, token, completed: completed.promise, waiting: waiting.promise, recovery: recovery.promise,
    refused: refused.promise, request, stop: () => worker.stop() };
}
async function cleanup(f: Fixture): Promise<void> {
  const rows = await effects(f);
  for (const row of rows) {
    expect(() => process.kill(row.pid, 0)).toThrow();
    const socket = connect({ host: "127.0.0.1", port: row.registryPort });
    const error = once(socket, "error");
    const observed = await bounded(error);
    expect(observed[0]).toHaveProperty("code", "ECONNREFUSED");
    socket.destroy();
  }
  expect((await readdir(f.home)).some(name => name.startsWith(".herdr-update-cache-"))).toBe(false);
  await f.cleanup();
  await expect(lstat(f.root)).rejects.toHaveProperty("code", "ENOENT");
  console.log("RUNNER_CLEANUP0", JSON.stringify({ roots: 0, processes: 0, sockets: 0, caches: 0 }));
}

test("commits actual private controlled installation through SQL queue and authenticated service", async () => {
  // Given genuine production issuer/consumer with explicitly non-vendor package control.
  const f = await fixture(), s = await service(f, "worker", join(f.root, "queue"));
  try {
    // When the actual authenticated create command starts the private installer.
    const response = await s.request(createRequest(f, "real-install", s.token));
    expect(response.ok && response.operation === "create-job" && response.result.kind).toBe("created");
    const job = await bounded(s.completed);
    // Then durable SQL, actual file bytes and queue agree without target restart.
    expect(job.installTxn.state).toBe("succeeded");
    expect(job.targetTxns).toEqual([]);
    const entry = s.queue.get(job.jobId);
    expect(entry.state).toBe("completed");
    const receipt = job.installTxn.receipt;
    if (!receipt) throw new TypeError("owned_completed_receipt_missing");
    expect(s.store.operation(entry.operationId ?? "").receipt).toEqual(receipt);
    expect((await effects(f)).length).toBe(1);
    const journal = await readFile(join(f.journal, `${hash(entry.operationId ?? "")}.jsonl`), "utf8");
    const kinds: unknown[] = journal.trim().split("\n").map(line => JSON.parse(line).kind);
    expect(kinds).toEqual(["intent", "dispatch", "launched", "exit", "files-verified"]);
    expect(actualInstallation(f)).toEqual((await profile(f)).expectedAfter);
    console.log("RUNNER_ACTUAL_MECHANISM", JSON.stringify({ genuineVendor: false, nativeEffects: 1,
      sql: job.installTxn.state, queue: entry.state, operationId: entry.operationId, restartEffects: 0 }));
  } finally { await s.stop(); await cleanup(f); }
});

test("returns the create response to its transport before synchronous execution observation begins", async () => {
  // Given: real authenticated service and installer, with boundary event ordering.
  const f = await fixture(), order: string[] = [];
  const s = await service(f, "worker", join(f.root, "queue"), {
    handled: request => { if (request.operation === "create-job") order.push("response-ready"); },
    observed: () => { order.push("execution-observation"); },
  });
  try {
    // When: an actual create request is admitted and its background job finishes.
    const response = await s.request(createRequest(f, "ack-before-work", s.token));
    expect(response.ok).toBe(true);
    const job = await bounded(s.completed);
    // Then: synchronous execution cannot prevent the create response reaching transport.
    expect(order[0]).toBe("response-ready");
    expect(order).toContain("execution-observation");
    expect(job.installTxn.state).toBe("succeeded");
    expect((await effects(f)).length).toBe(1);
  } finally { await s.stop(); await cleanup(f); }
});

test("reopens both databases and reattaches exact lost ACK request without requalification or replay", async () => {
  // Given real service/installer and a client that discards its actual queued ACK.
  const f = await fixture("hang"), root = join(f.root, "queue");
  let s = await service(f, "worker", root);
  try {
    const input = createRequest(f, "lost-ack", s.token);
    const client = await connectPrivateSocket(s.worker.owner.socketPath);
    // When intent/effect is committed, disconnect without observing the reply.
    client.send(input);
    await bounded(f.ready);
    client.close();
    f.release();
    const completed = await bounded(s.completed);
    const operationId = completed.installTxn.receipt?.operationId;
    await s.stop();
    s = await service(f, "worker", root, { absent: true });
    // Then actual reattachment with the original request ID adopts stored truth only.
    const existing = await s.request({ ...input, token: s.token });
    expect(existing.ok && existing.operation === "create-job" && existing.result.kind).toBe("existing");
    const inspect = await s.request({ version: 1, token: s.token, requestId: "inspect-reopen",
      operation: "inspect-job", jobId: completed.jobId });
    expect(inspect.ok && inspect.operation === "inspect-job" && inspect.result.job.installTxn.receipt?.operationId).toBe(operationId);
    const reconcile = await s.request({ version: 1, token: s.token, requestId: "reconcile-reopen",
      operation: "reconcile-job", jobId: completed.jobId, expectedRevision: completed.revision });
    expect(reconcile.ok && reconcile.operation === "reconcile-job" && reconcile.result.kind).toBe("unchanged");
    expect((await effects(f)).length).toBe(1);
  } finally { f.release(); await s.stop(); await cleanup(f); }
});

test("rejects cancellation after actual dispatch and creator disconnect without killing or replaying", async () => {
  // Given a real hung manager holding its single queue reservation.
  const f = await fixture("hang"), s = await service(f, "worker", join(f.root, "queue"));
  try {
    const created = await s.request(createRequest(f, "post-dispatch", s.token));
    if (!created.ok || created.operation !== "create-job") throw new TypeError("owned_create_failed");
    await bounded(f.ready);
    const current = s.store.get(created.result.job.jobId);
    // When a second authenticated command asks to cancel after dispatch.
    const cancelled = await s.request({ version: 1, token: s.token, requestId: "unsafe-cancel", operation: "cancel-job",
      jobId: current.jobId, expectedRevision: current.revision });
    // Then native process remains alive and only cooperative release settles it.
    expect(cancelled).toMatchObject({ ok: false, error: { code: "cancel_unsafe" } });
    const row = (await effects(f))[0];
    if (!row) throw new TypeError("owned_effect_missing");
    expect(() => process.kill(row.pid, 0)).not.toThrow();
    f.release();
    await bounded(s.completed);
    expect((await effects(f)).length).toBe(1);
  } finally { f.release(); await s.stop(); await cleanup(f); }
});

test("two actual workers share FIFO reservation and safely cancel the untouched waiting job", async () => {
  // Given separate native workers/stores and the same actual queue database.
  const a = await fixture("hang"), b = await fixture(), root = join(a.root, "queue");
  const left = await service(a, "left", root), right = await service(b, "right", root);
  try {
    await left.request(createRequest(a, "holder", left.token));
    await bounded(a.ready);
    // When another actual create command enters while the reservation is held.
    await right.request(createRequest(b, "waiter", right.token));
    const waiting = await bounded(right.waiting);
    const cancelled = await right.request({ version: 1, token: right.token, requestId: "safe-cancel",
      operation: "cancel-job", jobId: waiting.jobId, expectedRevision: waiting.revision });
    // Then no second native effect happened, and only the queued job cancels.
    expect(cancelled.ok && cancelled.operation === "cancel-job" && cancelled.result.job.status).toBe("cancelled");
    expect(right.queue.get(waiting.jobId).state).toBe("cancelled");
    expect(await effects(b)).toEqual([]);
    a.release();
    await bounded(left.completed);
    expect((await effects(a)).length).toBe(1);
  } finally { a.release(); await right.stop(); await left.stop(); await cleanup(b); await cleanup(a); }
});

test("late check await source drift rejects before SQL queue intent or native effects", async () => {
  // Given a production adapter paused on an exact release Promise.
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const f = await fixture("install", "", { entered: entered.resolve, wait: gate.promise });
  const s = await service(f, "worker", join(f.root, "queue"));
  try {
    // When the source changes after the real adapter yielded.
    const request = s.request(createRequest(f, "drift", s.token));
    await bounded(entered.promise);
    await writeFile(f.manager, "changed while release was awaited");
    gate.resolve();
    const response = await request;
    // Then no stale snapshot authorizes a mutation.
    expect(response).toMatchObject({ ok: false, error: { code: "stale_selection" } });
    expect(s.store.list()).toEqual([]);
    expect(await effects(f)).toEqual([]);
  } finally { gate.resolve(); await s.stop(); await cleanup(f); }
});

test("lost SQL intent admission leaves queue intent quarantined and cancellation unsafe after reopen", async () => {
  // Given a real native owner whose publication refuses the SQL intent result.
  const f = await fixture(), root = join(f.root, "queue");
  let s = await service(f, "worker", root, { admit: response => {
    if (response.ok && response.operation === "inspect-job" && response.result.job.installTxn.state === "updating")
      throw new TypeError("owned_intent_admission_lost");
  } });
  try {
    // When the queue commit succeeds but SQL intent admission refuses.
    const created = await s.request(createRequest(f, "split-commit", s.token));
    if (!created.ok || created.operation !== "create-job") throw new TypeError("owned_create_failed");
    await bounded(s.refused);
    const job = s.store.get(created.result.job.jobId);
    expect(job.installTxn.receipt).toBeNull();
    expect(s.queue.get(job.jobId).state).toBe("recovery_required");
    await s.stop();
    s = await service(f, "worker", root, { absent: true });
    // Then a fresh owner cannot reset/reclaim/replay or falsely cancel it.
    const cancel = await s.request({ version: 1, token: s.token, requestId: "quarantined-cancel",
      operation: "cancel-job", jobId: job.jobId, expectedRevision: job.revision });
    expect(cancel).toMatchObject({ ok: false, error: { code: "cancel_unsafe" } });
    const reconcile = await s.request({ version: 1, token: s.token, requestId: "quarantined-reconcile",
      operation: "reconcile-job", jobId: job.jobId, expectedRevision: job.revision });
    expect(reconcile.ok && reconcile.operation === "reconcile-job" && reconcile.result.kind).toBe("recovery-required");
    expect(await effects(f)).toEqual([]);
  } finally { await s.stop(); await cleanup(f); }
});

test("actual service without a private profile refuses new effects but keeps truthful inspect paths", async () => {
  // Given an authenticated native service with no qualified mutation source.
  const f = await fixture(), s = await service(f, "worker", join(f.root, "queue"), { absent: true });
  try {
    // When a normal update-only create is requested.
    const response = await s.request(createRequest(f, "missing-profile", s.token));
    // Then support is not invented from check/discovery shape.
    expect(response).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(s.store.list()).toEqual([]);
    expect(await effects(f)).toEqual([]);
  } finally { await s.stop(); await cleanup(f); }
});

test("multiple private profiles select only the exact registered installation", async () => {
  const first = await fixture(), second = await fixture();
  const s = await service(first, "worker", join(first.root, "queue"), { additionalProfiles: [await profile(second)] });
  try {
    expect(await s.runner?.selection({ ...second.installation, lastCheck: null }, new AbortController().signal))
      .toMatchObject({ ok: true, value: { installation: second.installation, targets: [] } });
    expect(await s.runner?.selection({ ...first.installation, installationId: "install:unregistered", lastCheck: null },
      new AbortController().signal)).toEqual({ ok: true, value: undefined });
    const response = await s.request(createRequest(first, "multiple-profiles", s.token));
    expect(response).toMatchObject({ ok: true });
    await s.completed;
    expect((await effects(first)).length).toBe(1);
    expect(await effects(second)).toEqual([]);
  } finally { await s.stop(); await cleanup(first); await cleanup(second); }
});

function restartTarget(f: Fixture): TargetSelection {
  const binding: RuntimeBinding = { socketId: "owned-core", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
    rootIncarnation: { pid: 1234, startIdentity: "old-root", executableRealpath: f.installation.executableRealpath },
    session: { kind: "conversation", fullId: "saved-conversation", storagePathHash: "saved-storage" },
    cwd: f.root, optionsRef: "private-options", turnGeneration: 1, resourcesFingerprint: f.installation.resourcesFingerprint };
  return { targetId: `target:${hash(JSON.stringify([binding.socketId, "runtime"]))}`,
    runtimeId: "runtime", installationId: f.installation.installationId, expectedBinding: binding };
}
function controlledLifecycle(target: TargetSelection, outcome: "stopped" | "uncertain",
  observeStop: (operationId: string) => void) {
  const subscribed = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<{ readonly ok: true; readonly value: RuntimeBinding }>();
  const calls: string[] = [];
  const port: LifecyclePort = {
    subscribe: (_target, signal) => {
      calls.push("subscribe"); subscribed.resolve();
      const abort = () => completion.resolve({ ok: true, value: target.expectedBinding });
      signal.addEventListener("abort", abort, { once: true });
      return { completed: completion.promise, close: () => {
        calls.push("unsubscribe"); signal.removeEventListener("abort", abort);
      } };
    },
    inspect: async () => {
      calls.push("inspect");
      return { ok: true, value: { binding: target.expectedBinding, complete: false } };
    },
    claim: async (_target, operationId) => {
      expect(operationId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      expect(calls.lastIndexOf("subscribe")).toBeGreaterThanOrEqual(0);
      expect(calls.lastIndexOf("inspect")).toBeGreaterThan(calls.lastIndexOf("subscribe"));
      calls.push("claim");
      return { ok: true, value: { binding: target.expectedBinding, profile: "original-profile", handle: {} } };
    },
    stop: async (_claim, operationId) => {
      expect(operationId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      observeStop(operationId); calls.push("stop");
      return { ok: true, value: outcome === "uncertain" ? { kind: "uncertain", operationId }
        : { kind: "completed", operationId, effect: "stopped", identity: target.expectedBinding } };
    },
    start: async () => { calls.push("start"); return { ok: false, error: { code: "unsupported" } }; },
    release: async () => { calls.push("release"); return { ok: true, value: null }; },
    result: async operationId => { calls.push("result"); return { ok: true, value: { kind: "uncertain", operationId } }; },
  };
  return { port, calls, subscribed: subscribed.promise, complete: () => completion.resolve({ ok: true, value: target.expectedBinding }) };
}

test.each([0, 1])("routes runtime-set selection, stop and recovery only to profile %s", async index => {
  // Given two independently qualified installations with the same runtime name.
  const first = await fixture(), second = await fixture();
  const fixtures = [first, second];
  const targets = fixtures.map(f => restartTarget(f));
  const controls = targets.map(target => controlledLifecycle(target, "uncertain", () => undefined));
  const unrelated = controlledLifecycle(restartTarget(first), "uncertain", () => undefined);
  const supported = { kind: "supported", reason: "verified", evidenceRef: "controlled-lifecycle-not-native" } as const;
  const profiles = await Promise.all(fixtures.map(async (f, i) => {
    const base = await profile(f), selected = targets[i], control = controls[i];
    if (!selected || !control) throw new TypeError("test_profile_missing");
    return { ...base, lifecycle: control.port, contract: { ...base.contract,
      runtime: { runtimeId: selected.runtimeId, installationId: selected.installationId,
        binding: selected.expectedBinding, runningVersion: base.contract.installation.installedVersion },
      capabilities: { ...base.contract.capabilities, completion: supported, resume: supported, gracefulExit: supported } } };
  }));
  const f = fixtures[index], selected = targets[index], control = controls[index], other = targets[1 - index];
  if (!f || !selected || !control || !other) throw new TypeError("test_selection_missing");
  const s = await service(first, "runtime-set", join(first.root, "queue"), {
    absent: true, additionalProfiles: profiles, lifecycle: unrelated.port });
  try {
    const metadata = await s.runner?.selection({ ...f.installation, lastCheck: null }, new AbortController().signal);
    expect(metadata).toMatchObject({ ok: true, value: { targets: [{ target: selected }] } });
    const input = { ...createRequest(f, "runtime-set-restart", s.token), mode: "update-and-restart", selectedTargets: [selected] } as const;
    // When the other installation's binding is submitted, no lifecycle authority is used.
    expect(await s.request({ ...input, requestId: "wrong-binding", selectedTargets: [{ ...other,
      installationId: selected.installationId }] }))
      .toMatchObject({ ok: false, error: { code: "stale_binding" } });
    expect(await s.request(input)).toMatchObject({ ok: true, result: { kind: "created" } });
    await bounded(control.subscribed);
    control.complete();
    const job = await bounded(s.recovery);
    expect(await s.request({ version: 1, token: s.token, requestId: "runtime-set-reconcile",
      operation: "reconcile-job", jobId: job.jobId, expectedRevision: job.revision }))
      .toMatchObject({ ok: true, result: { kind: "recovery-required" } });
    // Then receipt observation follows the same exact profile without installer effects.
    expect(control.calls).toEqual(["inspect", "subscribe", "inspect", "claim", "unsubscribe", "stop", "result"]);
    expect(controls[1 - index]?.calls).toEqual([]);
    expect(unrelated.calls).toEqual([]);
    expect(await effects(first)).toEqual([]);
    expect(await effects(second)).toEqual([]);
  } finally { controls.forEach(row => row.complete()); await s.stop(); await cleanup(first); await cleanup(second); }
});

test.each(["stopped", "uncertain"] as const)("persists stop intent after subscribed work and never bypasses %s outcome", async outcome => {
  // Given: real issuer, SQL, queue and authenticated domain; explicitly controlled,
  // non-native lifecycle boundary. The production restart install gate stays closed.
  const f = await fixture(), target = restartTarget(f);
  let s: Awaited<ReturnType<typeof service>> | undefined;
  const control = controlledLifecycle(target, outcome, operationId => {
    if (!s) throw new TypeError("owned_service_missing");
    expect(s.store.operation(operationId)).toMatchObject({ targetId: target.targetId, effect: "stopped",
      receipt: { kind: "uncertain", operationId } });
  });
  s = await service(f, "restart", join(f.root, "queue"), { lifecycle: control.port, target, domain: true });
  const client = await attachAuthenticatedWorker(s.worker.owner.directory);
  try {
    const metadata = await client.request({ operation: "targets", installationId: f.installation.installationId });
    if (!metadata.ok || !metadata.result.selection) throw new TypeError("owned_selection_missing");
    expect(metadata.result.targets).toEqual([target]);
    expect(metadata.result.selection.targets[0]?.target).toEqual(target);
    const original = createRequest(f, "restart-request", s.token);
    const input: ServiceRequest = { ...original, mode: "update-and-restart", selectedTargets: [target] };
    // When: create while actual readiness is still held, then settle the event.
    const created = await s.request(input);
    if (!created.ok || created.operation !== "create-job") throw new TypeError("owned_create_failed");
    await bounded(control.subscribed);
    expect(s.store.get(created.result.job.jobId).targetTxns[0]?.receipt).toBeNull();
    const duplicate = await s.request(input);
    expect(duplicate).toMatchObject({ ok: true, result: { kind: "existing", job: { jobId: created.result.job.jobId } } });
    control.complete();
    const recovered = await bounded(s.recovery);
    // Then: neither uncertain stop nor the unchanged closed gate can authorize install/start.
    expect(recovered.status).toBe("recovery_required");
    expect(control.calls).toEqual(["inspect", "subscribe", "inspect", "claim", "unsubscribe", "stop"]);
    expect(await effects(f)).toEqual([]);
    expect(recovered.installTxn.receipt).toBeNull();
    const cancel = await client.request({ operation: "cancel-job", jobId: recovered.jobId, expectedRevision: recovered.revision });
    expect(cancel).toMatchObject({ ok: false, error: { code: "cancel_unsafe" } });
    const inspected = await client.request({ operation: "inspect-job", jobId: recovered.jobId });
    expect(inspected).toMatchObject({ ok: true, result: { targets: [{
      effect: outcome === "stopped" ? "known" : "unknown", safeAction: "inspect",
    }] } });
    const reconcile = await client.request({ operation: "reconcile-job", jobId: recovered.jobId, expectedRevision: recovered.revision });
    expect(reconcile).toMatchObject({ ok: true, result: { kind: "recovery-required" } });
    expect(control.calls.filter(call => call === "stop").length).toBe(1);
    expect(control.calls.includes("start")).toBe(false);
    if (outcome === "uncertain") expect(control.calls.at(-1)).toBe("result");
  } finally { control.complete(); client.close(); await s.stop(); await cleanup(f); }
});

test("publishes authenticated update-only selection and dispatches its original domain job once", async () => {
  // Given: the ordinary catalog is separate from the real private updater profile.
  const f = await fixture(), s = await service(f, "domain", join(f.root, "queue"), { domain: true });
  const client = await attachAuthenticatedWorker(s.worker.owner.directory);
  try {
    const metadata = await client.request({ operation: "targets", installationId: f.installation.installationId });
    expect(metadata).toMatchObject({ ok: true, result: { targets: [], selection: { targets: [] } } });
    // When / Then: production domain dispatch reaches the real controlled manager.
    const input = createRequest(f, "domain-install", s.token);
    const created = await s.request(input);
    if (!created.ok || created.operation !== "create-job") throw new TypeError("owned_create_failed");
    const completed = await bounded(s.completed);
    expect(completed.jobId).toBe(created.result.job.jobId);
    expect(actualInstallation(f).installedVersion).toEqual({ kind: "known", version: "5.1.10" });
    expect(await s.request(input)).toMatchObject({ ok: true, result: { kind: "existing" } });
    expect((await effects(f)).length).toBe(1);
  } finally { client.close(); await s.stop(); await cleanup(f); }
});
