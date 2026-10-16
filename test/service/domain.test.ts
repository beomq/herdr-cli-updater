import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JobStore } from "../../src/jobs/store";
import { Database } from "bun:sqlite";
import type { NewJob } from "../../src/jobs/jobs";
import { initialJob, parseNewJob, transition, viewJob } from "../../src/jobs/jobs";
import type { CatalogObservation, CatalogReaders, CoreObservation } from "../../src/catalog";
import type { AdapterCapabilities } from "../../src/adapters/types";
import type { ServiceRequest, TargetTransaction } from "../../src/protocol";
import { domainStoreDirectory } from "../../src/service/domain";
import { createDomain } from "../../src/service/domain";
import { createCatalogProvider, registerCatalog } from "../../src/service/catalog-provider";
import { digest as packageDigest, fixture as packageFixture } from "../../.omo/evidence/herdr-cli-updater/task-4/check-runtime-r1/fixture";

test("sessions deduplicate socket pane pairs without merging different sockets or granting targets", async () => {
  // Given: two sockets share a pane label; duplicate same-socket observations exist.
  const row: CoreObservation = { paneId: "pane", terminalId: "terminal", agent: "pi", cwd: null, session: null,
    revision: 1, completion: null, family: "pi", status: "idle", workComplete: null };
  const domain = createDomain(directory(), { candidates: [], sockets: [], runtimeSources: [
    ...["socket-A", "socket-A", "socket-B"].map(socketId => ({ socketId,
      read: async () => ({ ok: true, value: { kind: "unavailable", reason: "identity_incomplete", observations: [row, row] } } as const) })),
    { socketId: "missing", read: async () => ({ ok: false, error: { code: "verification_failed" } } as const) },
  ] });
  try {
    // When
    const response = await domain.handle({ version: 1, token: "a".repeat(64), requestId: "display", operation: "sessions" },
      new AbortController().signal);
    // Then
    expect(response).toEqual({ version: 1, requestId: "display", operation: "sessions", ok: true, result: {
      sessions: ["socket-A", "socket-B"].map(socketId => ({ socketId, paneId: "pane", family: "pi", status: "idle", workComplete: null })),
      unavailableSources: 1,
    } });
  } finally { domain.close(); }
});

test("routes hinted check reads but admits only the observed matching identity", async () => {
  // Given: unhinted readers remain eligible; unrelated hinted readers cannot block.
  const row = observation(false);
  const installation = { ...row.contract.installation, installedVersion: { kind: "known", version: "1" } as const };
  const observed = { ...row, contract: { ...row.contract, installation, runtime: null } };
  const calls: string[] = [], operations: ServiceRequest["operation"][] = [];
  let checks = 0;
  const domain = createDomain(directory(), (_signal, operation) => {
    if (operation) operations.push(operation);
    return { candidates: [
      { candidateId: "unrelated", installationId: "other", family: "omo", read: async () => {
        calls.push("unrelated"); throw new Error("unrelated candidate must not be read");
      } },
      { candidateId: "legacy", family: "omo", read: async () => {
        calls.push("legacy"); return { ok: true, value: observed } as const;
      } },
      { candidateId: "hinted", installationId: "install", family: "omo", read: async () => {
        calls.push("hinted"); return { ok: true, value: observed } as const;
      } },
    ], sockets: [], check: async identity => {
      checks++; expect(identity).toEqual(installation);
      return { ok: true, value: { kind: "up-to-date", installedVersion: "1", checkedAt: 1 } } as const;
    } };
  });
  try {
    // When
    const response = await domain.handle({ version: 1, token: "a".repeat(64), requestId: "check", operation: "check",
      installationId: "install" }, new AbortController().signal);
    const missing = await domain.handle({ version: 1, token: "a".repeat(64), requestId: "missing", operation: "check",
      installationId: "missing" }, new AbortController().signal);
    // Then
    expect(response).toMatchObject({ ok: true, result: { installationId: "install" } });
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(calls).toEqual(["legacy", "hinted", "legacy"]);
    expect(checks).toBe(1);
    expect(operations).toEqual(["check", "check"]);
  } finally { domain.close(); }
});
test("merges display pane statuses without exposing them through runtime authority", async () => {
  // Given: ordinary and native observations name the same socket and pane differently.
  const path = "/fixture/core.sock", socketId = `socket:${createHash("sha256").update(path).digest("hex")}`;
  const row: CoreObservation = { paneId: "pane", terminalId: "terminal", agent: "omo", family: "omo", cwd: null,
    session: null, revision: 1, completion: null, status: "unknown", workComplete: null };
  let displayReads = 0;
  const operations: ServiceRequest["operation"][] = [];
  const domain = createDomain(directory(), (_signal, operation) => {
    if (operation) operations.push(operation);
    return { candidates: [], sockets: [],
      displaySources: [{ socketId, read: async () => { displayReads++; return { ok: true, value: {
        kind: "unavailable", reason: "identity_incomplete", observations: [{ ...row, status: "working" }],
      } } as const; } }],
      runtimeSources: [{ socketId: path, read: async () => ({ ok: true, value: {
        kind: "unavailable", reason: "identity_incomplete", observations: [row],
      } } as const) }],
    };
  });
  try {
    // When
    const sessions = await domain.handle({ version: 1, token: "a".repeat(64), requestId: "sessions", operation: "sessions" }, new AbortController().signal);
    const runtimes = await domain.handle({ version: 1, token: "a".repeat(64), requestId: "runtimes", operation: "runtimes" }, new AbortController().signal);
    // Then
    expect(sessions).toMatchObject({ ok: true, result: { sessions: [{ socketId, paneId: "pane", family: "omo",
      status: "working", workComplete: null }], unavailableSources: 0 } });
    expect(runtimes).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(displayReads).toBe(1);
    expect(operations).toEqual(["sessions", "runtimes"]);
  } finally { domain.close(); }
});
test("dispatches a source-only check and retains metadata despite an unrelated incomplete core", async () => {
  // Given: production provider/runtime/store; the unrelated core must not be read.
  const f = await packageFixture(), directory = join(f.root, "worker");
  registerCatalog(directory, JSON.stringify({ version: 1, candidates: [{ family: "pi",
    executable: { path: f.executable, sha256: packageDigest(readFileSync(f.executable)) }, provenance: null,
    sources: [{ role: "engine-manifest", path: f.manifest, sha256: packageDigest(readFileSync(f.manifest)) }] }], sockets: [] }));
  const provider = createCatalogProvider(directory, { request: f.request });
  let coreReads = 0;
  const domain = createDomain(directory, () => ({ ...provider(), runtimeSources: [{ socketId: join(f.root, "incomplete.sock"),
    read: async () => { coreReads++; throw new Error("incomplete core must not be called by check"); } }] }));
  try {
    const signal = new AbortController().signal;
    // When
    const response = await domain.handle({ version: 1, token: "a".repeat(64), requestId: "actual-check", operation: "check",
      installationId: f.source.installation.installationId }, signal);
    // Then
    expect(response).toMatchObject({ operation: "check", ok: true, result: { result: {
      kind: "update-available", installedVersion: "1.1.0", availableVersion: "1.2.0",
    } } });
    expect(coreReads).toBe(0);
    const installations = await domain.handle({ version: 1, token: "a".repeat(64), requestId: "after-check", operation: "installations" }, signal);
    expect(installations).toMatchObject({ ok: true, result: { installations: [{ lastCheck: { result: {
      kind: "update-available", availableVersion: "1.2.0",
    } }, owner: { kind: "unknown", reason: "unverified_owner" }, channel: "unknown" }] } });
  } finally { domain.close(); await f.cleanup(); }
});

test("does not publish malformed private checker machine data or invoke mutation operations", async () => {
  // Given: a structurally typed private callback can still violate machine admission.
  const f = await packageFixture(), directory = join(f.root, "worker");
  const cap = { kind: "unknown", reason: "unverified_owner" } as const;
  let checks = 0;
  const readers: CatalogReaders = { candidates: [{ candidateId: "real-package", family: "pi", read: async () => ({
    ok: true, value: { contract: { version: 1, family: "pi", installation: f.source.installation, runtime: null,
      capabilities: { check: cap, update: cap, busySafe: cap, completion: cap, resume: cap, gracefulExit: cap } }, lastCheck: null },
  }) }], sockets: [], check: async () => { checks++; return { ok: true, value: {
    kind: "up-to-date", installedVersion: "2026.10.1-3", checkedAt: Number.NaN,
  } }; } };
  const domain = createDomain(directory, readers), signal = new AbortController().signal;
  try {
    // When / Then
    expect(await domain.handle({ version: 1, token: "a".repeat(64), requestId: "bad-check", operation: "check",
      installationId: f.source.installation.installationId }, signal)).toMatchObject({ ok: false, error: { code: "verification_failed" } });
    const missing = await domain.handle({ version: 1, token: "a".repeat(64), requestId: "missing-check", operation: "check", installationId: "missing" }, signal);
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(checks).toBe(1);
    expect((await domain.handle({ version: 1, token: "a".repeat(64), requestId: "jobs-still-empty", operation: "jobs" }, signal))).toMatchObject({ ok: true, result: { jobs: [] } });
  } finally { domain.close(); await f.cleanup(); }
});
import { serveDomainWorker } from "../../src/service/worker";
import { connectPrivateSocket, MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, requestPrivateSocket, subscribePrivateSocket } from "../../src/service/socket";

const roots: string[] = [];
const workers: Awaited<ReturnType<typeof serveDomainWorker>>[] = [];
function directory(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "dom-"));
  roots.push(root);
  return join(root, "worker");
}
function spec(jobId = "job"): NewJob {
  return { jobId, requestId: `request:${jobId}`, mode: "update-only", selectedTargets: [],
    installation: { installationId: "install", resourcesFingerprint: "fingerprint",
      owner: { kind: "unknown", reason: "unverified_owner" }, installedVersion: { kind: "unknown", reason: "not_captured" } } };
}
function restartSpec(jobId: string, count: number): NewJob {
  const target = (index: number) => ({ targetId: `target-${index}`, runtimeId: "runtime", installationId: "install",
    expectedBinding: { socketId: `socket-${index}`, socketEpoch: "epoch", paneId: `pane-${index}`, paneGeneration: 1,
      rootIncarnation: { pid: 100 + index, startIdentity: `incarnation-${index}`, executableRealpath: "/fixture/omo" },
      session: { kind: "conversation", fullId: `saved-${index}`, storagePathHash: "hash" } as const,
      cwd: "/fixture", optionsRef: "opaque-options", turnGeneration: 1, resourcesFingerprint: "fingerprint" } });
  return { jobId, requestId: `request-${jobId}`, mode: "update-and-restart",
    installation: { installationId: "install", resourcesFingerprint: "fingerprint",
      owner: { kind: "native", installerDigest: "digest", prefix: "/fixture" },
      installedVersion: { kind: "known", version: "1" } },
    selectedTargets: [target(0), ...Array.from({ length: count - 1 }, (_, index) => target(index + 1))] };
}
async function boot(path = directory(), readers?: CatalogReaders | (() => Promise<CatalogReaders>)) {
  const worker = await serveDomainWorker(path, readers ?? { candidates: [], sockets: [] });
  workers.push(worker);
  const token = readFileSync(worker.owner.tokenPath, "utf8");
  return { worker, token, request: (body: { readonly operation: "jobs" | "installations" | "runtimes" }) =>
    requestPrivateSocket(worker.owner, { version: 1, requestId: "query", token, ...body }, AbortSignal.timeout(2000)) };
}
function observation(supported: boolean): CatalogObservation {
  const capability = supported ? { kind: "supported", reason: "verified", evidenceRef: "fixture-only" } as const
    : { kind: "unknown", reason: "missing_bridge" } as const;
  const capabilities: AdapterCapabilities = { check: capability, update: { kind: "unknown", reason: "not_verified" },
    busySafe: { kind: "unknown", reason: "not_verified" }, completion: capability, resume: capability, gracefulExit: capability };
  return { lastCheck: null, contract: { version: 1, family: "omo", capabilities,
    installation: { ...spec().installation, family: "omo", channel: "unknown", executableRealpath: "/fixture/omo",
      resources: [{ resourceId: "resource", realpath: "/fixture/omo", fingerprint: "fingerprint" }] },
    runtime: { runtimeId: "runtime", installationId: "install", runningVersion: { kind: "unknown", reason: "not_captured" },
      binding: { socketId: "socket", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
        rootIncarnation: { pid: 1, startIdentity: "fixture", executableRealpath: "/fixture/omo" },
        session: { kind: "conversation", fullId: "fixture-session", storagePathHash: "hash" },
        cwd: "/fixture", optionsRef: "opaque-reference", turnGeneration: 1, resourcesFingerprint: "fingerprint" } },
  } };
}
function readers(row: CatalogObservation): CatalogReaders {
  return { candidates: [], sockets: [{ socketId: "socket", socketEpoch: "epoch",
    read: async () => ({ ok: true, value: [row] }) }] };
}
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("returns real persisted public jobs when no catalog provider is registered", async () => {
  // Given
  const path = directory();
  using store = new JobStore(domainStoreDirectory(path));
  const created = store.create(spec());
  const service = await boot(path);
  // When
  const response = await service.request({ operation: "jobs" });
  // Then
  expect(response).toEqual({ version: 1, requestId: "query", operation: "jobs", ok: true, result: { jobs: [created.job] } });
  expect(JSON.stringify(response)).not.toContain(service.token);
  expect(await service.request({ operation: "installations" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
});

test("awaits an asynchronous catalog reader without blocking durable job reads", async () => {
  // Given: subscribe to the exact reader-entry event before triggering it.
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<CatalogReaders>();
  let calls = 0;
  const service = await boot(directory(), () => { calls++; entered.resolve(); return released.promise; });
  // When
  const installations = service.request({ operation: "installations" });
  await entered.promise;
  expect(await service.request({ operation: "jobs" })).toMatchObject({ ok: true, result: { jobs: [] } });
  released.resolve(readers(observation(false)));
  // Then
  expect(await installations).toMatchObject({ ok: true, result: { installations: [{ family: "omo" }] } });
  expect(calls).toBe(1);
});

test.each([false, true])("projects socket observations without upgrading restart capability when supported=%s", async supported => {
  // Given: private registered source, not a wire-supplied command or installed core.
  const row = observation(supported);
  const service = await boot(directory(), readers(row));
  const first = await connectPrivateSocket(service.worker.owner.socketPath, AbortSignal.timeout(2000));
  const second = await connectPrivateSocket(service.worker.owner.socketPath, AbortSignal.timeout(2000));
  try {
    // When: two authenticated consumers issue identical requests.
    const replies = [first.next(), second.next()];
    const request = { version: 1, requestId: "same", token: service.token, operation: "runtimes" } as const;
    first.send(request); second.send(request);
    // Then
    const [a, b] = await Promise.all(replies);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: true, result: { runtimes: [row.contract.runtime] } });
    expect(JSON.stringify(a)).not.toContain(service.token);
    expect(await service.request({ operation: "installations" })).toMatchObject({ ok: true,
      result: { installations: [{ ...row.contract.installation, lastCheck: null }] } });
    const targets = await requestPrivateSocket(service.worker.owner, { version: 1, token: service.token,
      requestId: "targets", operation: "targets", installationId: "install" });
    expect(targets).toMatchObject({ ok: true, result: { targets: supported
      ? [{ runtimeId: "runtime", installationId: "install", expectedBinding: row.contract.runtime?.binding }] : [] } });
  } finally { first.close(); second.close(); }
});

test("commits safe cancellation and emits its actual result after an authenticated subscription", async () => {
  // Given: source store is closed before the worker opens the same DB.
  const path = directory();
  const store = new JobStore(domainStoreDirectory(path));
  store.create(spec()); store.close();
  const service = await boot(path);
  const stream = await subscribePrivateSocket(service.worker.owner,
    { version: 1, requestId: "subscribe", token: service.token, operation: "jobs" }, 0, AbortSignal.timeout(2000));
  try {
    const event = stream.next();
    // When
    const response = await requestPrivateSocket(service.worker.owner, { version: 1, requestId: "cancel",
      token: service.token, operation: "cancel-job", jobId: "job", expectedRevision: 0 });
    // Then
    expect(response).toMatchObject({ ok: true, result: { kind: "cancelled", job: { status: "cancelled", revision: 1 } } });
    expect(await event).toEqual({ kind: "event", incarnation: service.worker.owner.incarnation, sequence: 1, response });
    expect(await requestPrivateSocket(service.worker.owner, { version: 1, requestId: "stale",
      token: service.token, operation: "cancel-job", jobId: "job", expectedRevision: 0 }))
      .toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    expect(await requestPrivateSocket(service.worker.owner, { version: 1, requestId: "terminal",
      token: service.token, operation: "cancel-job", jobId: "job", expectedRevision: 1 }))
      .toMatchObject({ ok: false, error: { code: "cancel_unsafe" } });
  } finally { stream.close(); }
});

test("refuses cancellation after a durable effect intent without rewriting the job", async () => {
  // Given
  const path = directory();
  const store = new JobStore(domainStoreDirectory(path));
  store.create(spec());
  const intent = store.change({ jobId: "job", expectedRevision: 0 }, { kind: "intent", targetId: null, effect: "updated", operationId: "effect" });
  store.close();
  const service = await boot(path);
  // When
  const response = await requestPrivateSocket(service.worker.owner, { version: 1, requestId: "unsafe",
    token: service.token, operation: "cancel-job", jobId: "job", expectedRevision: 1 });
  // Then
  expect(response).toMatchObject({ ok: false, error: { code: "cancel_unsafe" } });
  expect(await requestPrivateSocket(service.worker.owner, { version: 1, requestId: "inspect",
    token: service.token, operation: "inspect-job", jobId: "job" })).toMatchObject({ ok: true, result: { job: intent.job, targets: [] } });
});

test("rejects missing jobs and forged socket authentication with machine codes", async () => {
  // Given
  const service = await boot();
  // When / Then
  for (const operation of ["inspect-job", "cancel-job"] as const)
    expect(await requestPrivateSocket(service.worker.owner, operation === "cancel-job"
      ? { version: 1, requestId: "missing", token: service.token, operation, jobId: "missing", expectedRevision: 0 }
      : { version: 1, requestId: "missing", token: service.token, operation, jobId: "missing" }))
      .toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(await requestPrivateSocket(service.worker.owner, { version: 1, requestId: "forged", token: "0".repeat(64), operation: "jobs" }))
    .toEqual({ version: 1, requestId: null, ok: false, error: { code: "unauthorized" } });
});

test("retains queue storage after consumer close and lifecycle stop", async () => {
  // Given
  const path = directory();
  const service = await boot(path);
  const client = await connectPrivateSocket(service.worker.owner.socketPath);
  client.close();
  // When
  await service.worker.stop();
  // Then
  expect(existsSync(path)).toBe(false);
  using reopened = new JobStore(domainStoreDirectory(path));
  expect(reopened.list()).toEqual([]);
});

test("cleans its sockets on store admission failure and never touches a foreign owner", async () => {
  // Given
  const path = directory();
  const store = new JobStore(domainStoreDirectory(path));
  store.close();
  chmodSync(domainStoreDirectory(path), 0o755);
  // When / Then
  await expect(serveDomainWorker(path, { candidates: [], sockets: [] })).rejects.toMatchObject({ code: "unsafe_path" });
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(domainStoreDirectory(path), "jobs.sqlite"))).toBe(true);
});

test("propagates reader failure rather than presenting an empty catalog as verified", async () => {
  // Given
  const service = await boot(directory(), { candidates: [], sockets: [{
    socketId: "socket", socketEpoch: "epoch", read: async () => ({ ok: false, error: { code: "stale_binding" } }),
  }] });
  // When
  const response = await service.request({ operation: "runtimes" });
  // Then
  expect(response).toMatchObject({ ok: false, error: { code: "stale_binding" } });
});

test("keeps mutation commands unsupported without seeding any production job", async () => {
  // Given
  const service = await boot();
  const base = { version: 1, requestId: "mutation", token: service.token } as const;
  // When / Then
  expect(await requestPrivateSocket(service.worker.owner, { ...base, operation: "create-job", mode: "update-only",
    installation: spec().installation, selectedTargets: [] })).toMatchObject({ ok: false, error: { code: "unsupported" } });
  expect(await requestPrivateSocket(service.worker.owner, { ...base, operation: "check", installationId: "install" }))
    .toMatchObject({ ok: false, error: { code: "unsupported" } });
  expect(await requestPrivateSocket(service.worker.owner, { ...base, operation: "reconcile-job", jobId: "job", expectedRevision: 0 }))
    .toMatchObject({ ok: false, error: { code: "unsupported" } });
  expect(await service.request({ operation: "jobs" })).toMatchObject({ ok: true, result: { jobs: [] } });
});

test("preserves verified runtime targets through canonical installation aliases", async () => {
  // Given: catalog deduplicates two same-resource installation observations.
  const row = observation(true);
  if (!row.contract.runtime) throw new Error("fixture_runtime_missing");
  const service = await boot(directory(), { candidates: [{
    candidateId: "canonical", family: "omo",
    read: async () => ({ ok: true, value: { ...row, contract: { ...row.contract, runtime: null,
      capabilities: { ...row.contract.capabilities,
        completion: { kind: "unknown", reason: "missing_bridge" },
        resume: { kind: "unknown", reason: "missing_session" },
        gracefulExit: { kind: "unknown", reason: "not_verified" } },
      installation: { ...row.contract.installation, installationId: "a-install",
        owner: { kind: "native", installerDigest: "digest", prefix: "/fixture" } } } } }),
  }], sockets: [{
    socketId: "socket", socketEpoch: "epoch",
    read: async () => ({ ok: true, value: [{ ...row, contract: { ...row.contract,
      installation: { ...row.contract.installation, owner: { kind: "native", installerDigest: "digest", prefix: "/fixture" } },
      runtime: row.contract.runtime } }] }),
  }] });
  // When
  const response = await requestPrivateSocket(service.worker.owner, { version: 1, requestId: "aliases",
    token: service.token, operation: "targets", installationId: "a-install" });
  // Then
  expect(response).toMatchObject({ ok: true, result: { targets: [{
    runtimeId: "runtime", installationId: "a-install", expectedBinding: row.contract.runtime.binding,
  }] } });
});

test("reads inspects cancels and publishes the complete persisted eighty target job", async () => {
  // Given: exact original independent fixture, seeded only through private SQLite.
  const path = directory(), storage = domainStoreDirectory(path);
  const seed = new JobStore(storage);
  const input = restartSpec("large", 80), original = seed.create(input).job;
  if (original.mode !== "update-and-restart") throw new TypeError("fixture_mode");
  seed.close();
  const service = await boot(path);
  const base = { version: 1, token: service.token } as const;
  expect(Buffer.byteLength(JSON.stringify({ ...base, requestId: "create", operation: "create-job",
    mode: input.mode, installation: input.installation, selectedTargets: input.selectedTargets }))).toBeLessThan(MAX_FRAME_BYTES);
  expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(MAX_FRAME_BYTES);
  const transactions: readonly TargetTransaction[] = original.targetTxns;
  expect(await service.request({ operation: "jobs" })).toEqual({ version: 1, requestId: "query",
    operation: "jobs", ok: true, result: { jobs: [original] } });
  expect(await requestPrivateSocket(service.worker.owner, { ...base, requestId: "inspect", operation: "inspect-job", jobId: "large" }))
    .toEqual({ version: 1, requestId: "inspect", operation: "inspect-job", ok: true, result: {
      job: original, targets: transactions.map(target => ({ target, effect: "unknown", lastIdentity: null, safeAction: "inspect" })),
    } });
  const stream = await subscribePrivateSocket(service.worker.owner, { ...base, requestId: "stream", operation: "jobs" }, 0, AbortSignal.timeout(2000));
  try {
    const event = stream.next();
    // When: full committed result and notification must both fit the negotiated path.
    const response = await requestPrivateSocket(service.worker.owner,
      { ...base, requestId: "cancel", operation: "cancel-job", jobId: "large", expectedRevision: 0 });
    // Then: no truncated targets, failed-after-commit response or lost event.
    const cancelled = { ...original, revision: 1, status: "cancelled" as const,
      targetTxns: transactions.map(target => ({ ...target, state: "cancelled" as const })) };
    expect(response).toEqual({ version: 1, requestId: "cancel", operation: "cancel-job", ok: true,
      result: { kind: "cancelled", job: cancelled } });
    expect(await event).toEqual({ kind: "event", incarnation: service.worker.owner.incarnation, sequence: 1, response });
    await service.worker.stop();
    using persisted = new JobStore(storage);
    expect(persisted.get("large")).toEqual(cancelled);
    expect(persisted.get("large").selectedTargets).toHaveLength(80);
  } finally { stream.close(); }
});

test.each(["reply", "event"] as const)("rejects oversized prospective %s before commit or sequence advance", async boundary => {
  // Given: previously accepted private row stays valid and intact, not migrated away.
  const path = directory(), storage = domainStoreDirectory(path);
  const seed = new JobStore(storage);
  let input = restartSpec("over", boundary === "reply" ? 350 : 268);
  if (boundary === "event") {
    const future = viewJob(transition(initialJob(parseNewJob(input)), { kind: "cancel" }));
    const bytes = Buffer.byteLength(JSON.stringify({ version: 1, requestId: "over", operation: "cancel-job",
      ok: true, result: { kind: "cancelled", job: future } }));
    if (input.installation.owner.kind !== "native") throw new TypeError("fixture_owner");
    input = { ...input, installation: { ...input.installation, owner: { ...input.installation.owner,
      prefix: `${input.installation.owner.prefix}${"x".repeat(MAX_RESPONSE_BYTES - bytes)}` } } };
    const padded = viewJob(transition(initialJob(parseNewJob(input)), { kind: "cancel" }));
    expect(Buffer.byteLength(JSON.stringify({ version: 1, requestId: "over", operation: "cancel-job",
      ok: true, result: { kind: "cancelled", job: padded } }))).toBe(MAX_RESPONSE_BYTES);
  }
  const original = seed.create(input).job;
  seed.close();
  if (boundary === "reply") expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(MAX_RESPONSE_BYTES);
  const service = await boot(path);
  // When
  const response = await requestPrivateSocket(service.worker.owner, { version: 1, token: service.token,
    requestId: "over", operation: "cancel-job", jobId: "over", expectedRevision: 0 });
  // Then
  expect(response).toEqual({ version: 1, requestId: "over", operation: "cancel-job", ok: false, error: { code: "resources_busy" } });
  expect(service.worker.transport.sequence).toBe(0);
  using persisted = new JobStore(storage);
  expect(persisted.get("over")).toEqual(original);
});

test("rejects aggregate overflow without a partial list while individual inspection works", async () => {
  // Given
  const path = directory(), seed = new JobStore(domainStoreDirectory(path));
  const originals = Array.from({ length: 4 }, (_, index) => seed.create(restartSpec(`large-${index}`, 80)).job);
  seed.close();
  const service = await boot(path);
  // When
  const response = await service.request({ operation: "jobs" });
  // Then
  expect(response).toEqual({ version: 1, requestId: "query", operation: "jobs", ok: false, error: { code: "resources_busy" } });
  expect(await requestPrivateSocket(service.worker.owner, { version: 1, token: service.token, requestId: "single",
    operation: "inspect-job", jobId: "large-0" })).toMatchObject({ ok: true, result: { job: originals[0] } });
  using persisted = new JobStore(domainStoreDirectory(path));
  expect(persisted.list()).toEqual(originals);
  expect(service.worker.transport.sequence).toBe(0);
});

test("rolls back a real SQLite abort after capacity admission without publishing", async () => {
  // Given
  const path = directory(), storage = domainStoreDirectory(path);
  const seed = new JobStore(storage), original = seed.create(spec("rollback")).job;
  seed.close();
  const service = await boot(path);
  using db = new Database(join(storage, "jobs.sqlite"));
  db.exec("CREATE TRIGGER cancel_abort BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'PRIVATE_SQL_ABORT'); END");
  // When
  const response = await requestPrivateSocket(service.worker.owner, { version: 1, token: service.token,
    requestId: "rollback", operation: "cancel-job", jobId: "rollback", expectedRevision: 0 });
  // Then
  expect(response).toEqual({ version: 1, requestId: "rollback", operation: "cancel-job", ok: false, error: { code: "recovery_required" } });
  using persisted = new JobStore(storage);
  expect(persisted.get("rollback")).toEqual(original);
  expect(service.worker.transport.sequence).toBe(0);
});
