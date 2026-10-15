import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { attachAuthenticatedWorker, ClientError, isServiceResponse } from "../../src/service/client";
import type { WorkerAttachment } from "../../src/service/client";
import { serveDomainWorker, serveWorker, unsupportedDomainHandler } from "../../src/service/worker";
import { domainStoreDirectory } from "../../src/service/domain";
import { JobStore } from "../../src/jobs/store";
import { decodeJob, initialJob, parseNewJob, viewJob } from "../../src/jobs/jobs";
import type { Job, OperationResults, RuntimeBinding, ServiceResponse, TargetSelection } from "../../src/protocol";

// allow: SIZE_OK — disjoint registered test file owns wire faults and real-worker
// integration together; no production or shared fixture writes are authorized.
const roots: string[] = [];
const workers: ReturnType<typeof serveWorker>[] = [];
const clients: WorkerAttachment[] = [];
const listeners: ReturnType<typeof Bun.listen>[] = [];
function directory(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cl-"));
  roots.push(root);
  return join(root, "worker");
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ClientError("timeout")), 2000);
  })]).finally(() => clearTimeout(timer));
}
async function attach(path: string, timeout = 1000) {
  const client = await attachAuthenticatedWorker(path, timeout);
  clients.push(client);
  return client;
}
afterEach(async () => {
  // Then: retire only this test's exact connections, servers and private roots.
  for (const client of clients.splice(0)) client.close();
  for (const listener of listeners.splice(0)) listener.stop(true);
  for (const worker of workers.splice(0)) {
    await worker.stop();
    expect(worker.transport.connectionCount).toBe(0);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
    expect(existsSync(root)).toBe(false);
  }
  expect([roots.length, workers.length, clients.length, listeners.length]).toEqual([0, 0, 0, 0]);
});
const selection = { installationId: "install", resourcesFingerprint: "fingerprint",
  owner: { kind: "unknown", reason: "unverified_owner" }, installedVersion: { kind: "unknown", reason: "not_captured" } } as const;
const binding: RuntimeBinding = { socketId: "socket", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
  rootIncarnation: { pid: 1, startIdentity: "start", executableRealpath: "/fixture/cli" },
  session: { kind: "conversation", fullId: "conversation", storagePathHash: "hash" },
  cwd: "/fixture", optionsRef: "opaque", turnGeneration: 1, resourcesFingerprint: "fingerprint" };
const target: TargetSelection = { targetId: "target", runtimeId: "runtime", installationId: "install", expectedBinding: binding };
const job: Job = { jobId: "job", requestId: "create", revision: 0, mode: "update-and-restart", selectedTargets: [target],
  status: "queued", failure: null, installTxn: { selection, state: "queued", receipt: null, failure: null },
  targetTxns: [{ ...target, state: "waiting_completion", receipt: { kind: "completed", operationId: "op", effect: "started", identity: binding }, failure: null }] };
const inspection = { job, targets: job.targetTxns.map(target => ({ target,
  effect: "known", lastIdentity: binding, safeAction: "inspect" } as const)) };
const resultFixtures: OperationResults = {
  sessions: { sessions: [{ socketId: "/fixture/core.sock", paneId: "pane", family: "pi", status: "idle", workComplete: null }],
    unavailableSources: 0 },
  installations: { installations: [{ ...selection, family: "omo", channel: "stable", executableRealpath: "/fixture/cli",
    resources: [{ resourceId: "resource", realpath: "/fixture/cli", fingerprint: "hash" }],
    lastCheck: { checkedAt: 1, result: { kind: "update-available", installedVersion: "1", availableVersion: "2", checkedAt: 1 } } }] },
  runtimes: { runtimes: [{ runtimeId: "runtime", installationId: "install", binding, runningVersion: { kind: "known", version: "1" } }] },
  jobs: { jobs: [job] }, targets: { targets: [target] },
  check: { installationId: "install", result: { kind: "unavailable", failure: { code: "unsupported" }, checkedAt: 1 } },
  "create-job": { kind: "existing", job },
  "cancel-job": { kind: "cancelled", job: { ...job, status: "cancelled" } },
  "inspect-job": inspection,
  "reconcile-job": { kind: "unchanged", inspection },
};
test("preserves a caller intent id across authenticated attachments", async () => {
  // Given: a real private worker and a durable caller-owned intent.
  const path = directory(), observed: string[] = [];
  workers.push(serveWorker(path, request => {
    observed.push(request.requestId);
    return { version: 1, requestId: request.requestId, operation: request.operation,
      ok: false, error: { code: "unsupported" } };
  }));
  const first = await attach(path);
  await first.request({ operation: "jobs" }, "intent:stable");
  first.close();
  // When: a fresh authenticated attachment observes with the same intent id.
  const second = await attach(path);
  const reply = await second.request({ operation: "jobs" }, "intent:stable");
  // Then: transport preserves correlation rather than inventing a new intent.
  expect(observed).toEqual(["intent:stable", "intent:stable"]);
  expect(reply.requestId).toBe("intent:stable");
});
test("rejects an invalid caller intent id before sending it", async () => {
  // Given: an authenticated worker whose handler counts admissions.
  const path = directory();
  let admissions = 0;
  workers.push(serveWorker(path, (request, signal) => {
    admissions++;
    return unsupportedDomainHandler(request, signal);
  }));
  const client = await attach(path);
  // When: the caller supplies an invalid wire identity.
  const request = client.request({ operation: "jobs" }, "bad\nidentity");
  // Then: no worker operation runs.
  await expect(request).rejects.toMatchObject({ code: "invalid_request" });
  expect(admissions).toBe(0);
});
test.each(Object.entries(resultFixtures))("admits every complete v1 result for %s", (operation, result) => {
  // Given / When
  const response: unknown = { version: 1, requestId: "request", operation, ok: true, result };
  // Then
  expect(isServiceResponse(response)).toBe(true);
});
test.each([true, false, null])("admits explicit whole-work evidence %s without deriving it from status", workComplete => {
  // Given / When / Then
  expect(isServiceResponse({ version: 1, requestId: "request", operation: "sessions", ok: true, result: {
    unavailableSources: 0, sessions: [{ socketId: "socket", paneId: "pane", family: null, status: "unknown", workComplete }],
  } })).toBe(true);
});
test("rejects missing whole-work evidence rather than treating idle as readiness", () => {
  // Given / When / Then
  expect(isServiceResponse({ version: 1, requestId: "request", operation: "sessions", ok: true, result: {
    unavailableSources: 0, sessions: [{ socketId: "socket", paneId: "pane", family: "pi", status: "idle" }],
  } })).toBe(false);
});
function corrupt(value: unknown, path: readonly (string | number)[], replacement: unknown): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  let current: unknown = copy;
  for (const key of path.slice(0, -1)) {
    if (typeof current !== "object" || current === null || !(key in current)) throw new ClientError("protocol");
    current = Reflect.get(current, key);
  }
  const key = path.at(-1);
  if (typeof current !== "object" || current === null || key === undefined) throw new ClientError("protocol");
  Reflect.set(current, key, replacement);
  return copy;
}
const faults: readonly (readonly [keyof OperationResults, readonly (string | number)[], unknown])[] = [
  ["sessions", ["sessions", 0, "family"], "senpi"],
  ["sessions", ["sessions", 0, "status"], "ready"],
  ["sessions", ["sessions", 0, "socketId"], ""],
  ["sessions", ["sessions", 0, "paneId"], "bad\nid"],
  ["sessions", ["sessions", 0, "argv"], ["PRIVATE"]],
  ["sessions", ["sessions", 0, "workComplete"], "true"],
  ["sessions", ["unavailableSources"], -1],
  ["sessions", ["unavailableSources"], 0.5],
  ["sessions", ["sessions"], [
    { socketId: "socket", paneId: "pane", family: null, status: "unknown", workComplete: null },
    { socketId: "socket", paneId: "pane", family: "pi", status: "idle", workComplete: true },
  ]],
  ["installations", ["installations", 0, "family"], ["omo"]],
  ["installations", ["installations", 0, "owner", "reason"], "invented"],
  ["installations", ["installations", 0, "resources", 0, "fingerprint"], 1],
  ["installations", ["installations", 0, "lastCheck", "result", "availableVersion"], {}],
  ["installations", ["installations", 0, "installedVersion", "reason"], ["not_captured"]],
  ["runtimes", ["runtimes", 0, "runningVersion", "version"], 1],
  ["runtimes", ["runtimes", 0, "binding", "rootIncarnation", "pid"], -1],
  ["runtimes", ["runtimes", 0, "binding", "session", "fullId"], {}],
  ["runtimes", ["runtimes", 0, "binding", "unexpected"], "SECRET"],
  ["targets", ["targets", 0, "expectedBinding", "paneGeneration"], 0.5],
  ["jobs", ["jobs", 0, "mode"], ["update-and-restart"]],
  ["jobs", ["jobs", 0, "status"], "completed"],
  ["jobs", ["jobs", 0, "targetTxns", 0, "state"], "invented"],
  ["jobs", ["jobs", 0, "targetTxns", 0, "receipt", "identity", "cwd"], "relative"],
  ["jobs", ["jobs", 0, "installTxn", "failure"], { code: "invented" }],
  ["jobs", ["jobs", 0, "failure"], { code: ["unsupported"] }],
  ["jobs", ["jobs", 0, "revision"], Number.MAX_SAFE_INTEGER + 1],
  ["check", ["result", "checkedAt"], "1"],
  ["create-job", ["kind"], ["created"]],
  ["cancel-job", ["job", "status"], "queued"],
  ["inspect-job", ["targets", 0, "effect"], ["known"]],
  ["inspect-job", ["targets", 0, "safeAction"], "launch"],
  ["inspect-job", ["targets", 0, "lastIdentity", "optionsRef"], {}],
  ["reconcile-job", ["inspection", "extra"], "SECRET"],
];
test.each(faults)("rejects wrong or unknown DTO fields in %s at %s", (operation, path, replacement) => {
  // Given
  const response = { version: 1, requestId: "request", operation, ok: true,
    result: corrupt(resultFixtures[operation], path, replacement) };
  // When / Then
  expect(isServiceResponse(response)).toBe(false);
});
test.each([null, [], {}, { version: 2 }, { version: 1, requestId: "r", operation: "unknown", ok: true, result: {} },
  { version: 1, requestId: "r", operation: "jobs", ok: true, result: { jobs: [], token: "SECRET" } },
  { version: 1, requestId: "r", operation: "jobs", ok: false, error: { code: ["unsupported"] } }].map(value => [value] as const))
("rejects unknown response bodies %j", value => {
  // Given / When / Then
  expect(isServiceResponse(value)).toBe(false);
});
test("serializes concurrent authenticated calls against a real worker without promoting unsupported", async () => {
  // Given
  const path = directory();
  const worker = await serveDomainWorker(path, { candidates: [], sockets: [] });
  workers.push(worker);
  const client = await attach(path);
  const secret = readFileSync(worker.owner.tokenPath, "utf8");
  // When
  const responses = await Promise.all([client.request({ operation: "jobs" }),
    client.request({ operation: "installations" }), client.request({ operation: "inspect-job", jobId: "missing" })]);
  // Then
  expect(responses[0]).toMatchObject({ ok: true, result: { jobs: [] } });
  expect(responses[1]).toMatchObject({ ok: false, error: { code: "unsupported" } });
  expect(responses[2]).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(new Set(responses.map(response => response.requestId)).size).toBe(3);
  expect(JSON.stringify([client, responses])).not.toContain(secret);
  client.close();
  expect(await attach(path).then(c => c.request({ operation: "jobs" }))).toMatchObject({ ok: true });
});
test("streams actual committed cancellation and reopens only with the exact retained cursor", async () => {
  // Given
  const path = directory();
  const store = new JobStore(domainStoreDirectory(path));
  store.create({ jobId: "job", requestId: "seed", mode: "update-only", selectedTargets: [], installation: selection });
  store.close();
  const worker = await serveDomainWorker(path);
  workers.push(worker);
  const client = await attach(path);
  const changed = Promise.withResolvers<unknown>();
  const stream = await client.subscribe({ incarnation: client.incarnation, sequence: worker.transport.sequence },
    { event: changed.resolve, error: changed.reject });
  const responsePromise = client.request({ operation: "cancel-job", jobId: "job", expectedRevision: 0 });
  // When
  const [response, published] = await Promise.all([responsePromise, bounded(changed.promise)]);
  // Then
  expect(response).toMatchObject({ ok: true, result: { kind: "cancelled", job: { revision: 1, status: "cancelled" } } });
  expect(published).toEqual({ kind: "event", incarnation: client.incarnation, sequence: 1, response });
  const cursor = stream.cursor;
  stream.close(); await stream.closed;
  const reopened = await client.subscribe(cursor, { event: () => { throw new ClientError("protocol"); }, error: () => undefined });
  reopened.close(); await reopened.closed;
  await expect(client.subscribe({ incarnation: client.incarnation, sequence: 0 }, { event: () => undefined, error: () => undefined }))
    .rejects.toMatchObject({ code: "malformed_request" });
  expect(await client.request({ operation: "jobs" })).toMatchObject({ ok: true, result: { jobs: [{ status: "cancelled" }] } });
});
test("subscribes atomically to current publications after earlier events", async () => {
  const path = directory();
  const worker = serveWorker(path, unsupportedDomainHandler);
  workers.push(worker);
  const client = await attach(path);
  const response: ServiceResponse = { version: 1, requestId: "live", operation: "jobs",
    ok: true, result: { jobs: [] } };
  worker.transport.publish(response);
  const changed = Promise.withResolvers<unknown>();
  const stream = await client.subscribe({ incarnation: client.incarnation, sequence: "current" },
    { event: changed.resolve, error: changed.reject });
  expect(stream.cursor.sequence).toBe(1);
  worker.transport.publish(response);
  expect(await bounded(changed.promise)).toEqual({ kind: "event", incarnation: client.incarnation,
    sequence: 2, response });
  expect(stream.cursor.sequence).toBe(2);
  stream.close(); await stream.closed;
});
test("settles in-flight and queued calls on close without stopping the worker", async () => {
  // Given
  const path = directory();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const worker = serveWorker(path, async request => {
    entered.resolve();
    await release.promise;
    return unsupportedDomainHandler(request, new AbortController().signal);
  });
  workers.push(worker);
  const client = await attach(path);
  const outcomes = Promise.allSettled([client.request({ operation: "jobs" }), client.request({ operation: "jobs" })]);
  await bounded(entered.promise);
  // When
  client.close();
  release.resolve();
  // Then
  for (const outcome of await outcomes) expect(outcome).toMatchObject({ status: "rejected", reason: { code: "closed" } });
  expect(await attach(path).then(c => c.request({ operation: "jobs" }))).toMatchObject({ ok: false, error: { code: "unsupported" } });
});
test("rejects a different incarnation and refuses dirty identity without exposing paths", async () => {
  // Given
  const path = directory();
  const worker = serveWorker(path, unsupportedDomainHandler);
  workers.push(worker);
  const client = await attach(path);
  // When / Then
  await expect(client.subscribe({ incarnation: "different", sequence: 0 }, { event: () => undefined, error: () => undefined }))
    .rejects.toMatchObject({ code: "identity_mismatch" });
  chmodSync(worker.owner.tokenPath, 0o644);
  await expect(attachAuthenticatedWorker(path)).rejects.toMatchObject({ message: "identity_mismatch" });
  expect(Object.keys(client)).toEqual(["incarnation", "request", "subscribe", "close"]);
});

type WirePeer = { input: string };
/** Malicious wire peer replaces only a disposable fixture's socket. Real worker
 * lifecycle still authenticates the exact identity; JSON crosses a real UDS. */
function faultyWorker(onFrame: (socket: Bun.Socket<WirePeer>, value: unknown) => void) {
  const path = directory();
  const worker = serveWorker(path, unsupportedDomainHandler);
  workers.push(worker);
  renameSync(worker.owner.socketPath, join(path, "original.sock"));
  const bind = join(path, "fault.sock");
  const listener = Bun.listen<WirePeer>({ unix: bind, socket: {
    open(socket) { socket.data = { input: "" }; },
    data(socket, data) {
      socket.data.input += new TextDecoder().decode(data);
      let newline: number;
      while ((newline = socket.data.input.indexOf("\n")) >= 0) {
        const frame = socket.data.input.slice(0, newline);
        socket.data.input = socket.data.input.slice(newline + 1);
        onFrame(socket, JSON.parse(frame));
      }
    },
  } });
  chmodSync(bind, 0o600);
  renameSync(bind, worker.owner.socketPath);
  listeners.push(listener);
  return { path, worker };
}
function send(socket: Bun.Socket<WirePeer>, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`); socket.flush();
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
test.each(["wrong-request", "wrong-operation", "wrong-body", "extra-field", "secret", "boundary"] as const)
("fails closed on %s from a real wire", async fault => {
  // Given
  let secret = "";
  const fixture = faultyWorker((socket, value) => {
    if (!record(value)) throw new ClientError("protocol");
    const response: unknown = fault === "boundary"
      ? { version: 1, requestId: null, ok: false, error: { code: "unauthorized" } }
      : { version: 1, requestId: fault === "wrong-request" ? "other" : value["requestId"],
        operation: fault === "wrong-operation" ? "runtimes" : "jobs", ok: true,
        result: fault === "wrong-body" ? { jobs: [{}] } : fault === "secret" ? { jobs: [{
          ...job, jobId: secret,
        }] } : fault === "extra-field" ? { jobs: [], secret } : { jobs: [] } };
    send(socket, response);
  });
  secret = readFileSync(fixture.worker.owner.tokenPath, "utf8");
  const client = await attach(fixture.path);
  // When / Then
  await expect(client.request({ operation: "jobs" })).rejects.toMatchObject({ code: fault === "boundary" ? "unauthorized" : "protocol" });
  await expect(client.request({ operation: "jobs" })).rejects.toMatchObject({ code: "closed" });
});
test("bounds timeout and rejects queued calls; late replies are never consumed by another request", async () => {
  // Given
  const received = Promise.withResolvers<{ socket: Bun.Socket<WirePeer>; value: unknown }>();
  const fixture = faultyWorker((socket, value) => received.resolve({ socket, value }));
  const client = await attach(fixture.path, 50);
  const first = client.request({ operation: "jobs" });
  const outcomes = Promise.allSettled([first, client.request({ operation: "jobs" })]);
  const late = await bounded(received.promise);
  // When: timeout itself is the behavior under test, not a readiness delay.
  const results = await outcomes;
  // Then
  expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "timeout" } });
  expect(results[1]).toMatchObject({ status: "rejected" });
  send(late.socket, { version: 1, requestId: record(late.value) ? late.value["requestId"] : "bad",
    operation: "jobs", ok: true, result: { jobs: [] } });
  await expect(client.request({ operation: "jobs" })).rejects.toMatchObject({ code: "closed" });
});
test.each(["gap", "incarnation", "dto", "ack-extra", "listener", "duplicate"] as const)
("retires event listener and preserves request channel on %s", async fault => {
  // Given
  const failed = Promise.withResolvers<ClientError>();
  const fixture = faultyWorker((socket, value) => {
    if (!record(value)) throw new ClientError("protocol");
    if (value["kind"] === "subscribe") {
      send(socket, fault === "ack-extra" ? { kind: "subscribed", incarnation: value["incarnation"], sequence: 0, extra: true }
        : { kind: "subscribed", incarnation: value["incarnation"], sequence: 0 });
      const payload = { kind: "event",
        incarnation: fault === "incarnation" ? "other" : value["incarnation"],
        sequence: fault === "gap" ? 2 : 1,
        response: { version: 1, requestId: "event", operation: "jobs", ok: true, result: { jobs: fault === "dto" ? [{}] : [] } } };
      if (fault !== "ack-extra") send(socket, payload);
      if (fault === "duplicate") send(socket, payload);
    } else send(socket, { version: 1, requestId: value["requestId"], operation: "jobs", ok: true, result: { jobs: [] } });
  });
  const client = await attach(fixture.path);
  const ready = client.subscribe({ incarnation: client.incarnation, sequence: 0 },
    { event: () => { if (fault === "listener") throw new Error("private-listener-secret"); }, error: failed.resolve });
  // When / Then
  if (fault === "ack-extra") await expect(ready).rejects.toMatchObject({ code: "protocol" });
  else {
    const stream = await ready;
    expect(await bounded(failed.promise)).toMatchObject({ code: fault === "listener" ? "listener_failed" : "protocol" });
    await stream.closed;
    expect(stream.cursor.sequence).toBe(fault === "listener" || fault === "duplicate" ? 1 : 0);
  }
  expect(await client.request({ operation: "jobs" })).toMatchObject({ ok: true, result: { jobs: [] } });
});
test("bounds subscription readiness and closes active subscriptions on attachment disposal", async () => {
  // Given
  const fixture = faultyWorker(() => undefined);
  const client = await attach(fixture.path, 50);
  // When / Then
  await expect(client.subscribe({ incarnation: client.incarnation, sequence: 0 }, { event: () => undefined, error: () => undefined }))
    .rejects.toMatchObject({ code: "timeout" });
  const path = directory();
  const worker = serveWorker(path, unsupportedDomainHandler);
  workers.push(worker);
  const attached = await attach(path);
  let errors = 0;
  const stream = await attached.subscribe({ incarnation: attached.incarnation, sequence: 0 },
    { event: () => undefined, error: () => { errors++; } });
  attached.close();
  await bounded(stream.closed);
  expect(errors).toBe(0);
});
test("rejects malformed request bodies locally before the real worker receives them", async () => {
  // Given
  let requests = 0;
  const path = directory();
  const worker = serveWorker(path, request => { requests++; return unsupportedDomainHandler(request, new AbortController().signal); });
  workers.push(worker);
  const client = await attach(path);
  // When: structurally compatible extra properties still fail runtime admission.
  const extra = { operation: "jobs", token: "fake" } as const;
  await expect(client.request(extra)).rejects.toMatchObject({ code: "invalid_request" });
  await expect(client.request({ operation: "inspect-job", jobId: "" })).rejects.toMatchObject({ code: "invalid_request" });
  // Then
  expect(requests).toBe(0);
  expect(await client.request({ operation: "jobs" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
});
test("admits public noncompleted failure, receipt and owner variants without coercion", () => {
  // Given
  const owners = [{ kind: "package", manager: "bun", packageName: "pkg", prefix: "/fixture" },
    { kind: "native", installerDigest: "digest", prefix: "/fixture" },
    { kind: "wrapper", packageName: "pkg", engineResourceId: "engine", prefix: "/fixture" }];
  // When / Then
  for (const owner of owners) for (const kind of ["absent", "in-progress", "uncertain"]) {
    expect(isServiceResponse({ version: 1, requestId: "r", operation: "jobs", ok: true, result: { jobs: [{
      ...job, failure: { code: "recovery_required" }, installTxn: { ...job.installTxn,
        selection: { ...selection, owner }, receipt: { kind, operationId: "op" } },
    }] } })).toBe(true);
  }
  const explicit: ServiceResponse = { version: 1, requestId: "r", operation: "check", ok: false, error: { code: "unsupported" } };
  expect(isServiceResponse(explicit)).toBe(true);
});
test("reconnects explicitly to a replacement worker and rejects the retired incarnation cursor", async () => {
  // Given
  const path = directory();
  const first = serveWorker(path, unsupportedDomainHandler);
  workers.push(first);
  const old = await attach(path);
  const disconnected = Promise.withResolvers<ClientError>();
  const subscription = await old.subscribe({ incarnation: old.incarnation, sequence: 0 },
    { event: () => undefined, error: disconnected.resolve });
  // When
  await first.stop();
  expect(await bounded(disconnected.promise)).toMatchObject({ code: "closed" });
  await subscription.closed;
  const replacement = serveWorker(path, unsupportedDomainHandler);
  workers.push(replacement);
  const fresh = await attach(path);
  // Then
  expect(fresh.incarnation).not.toBe(old.incarnation);
  await expect(fresh.subscribe(subscription.cursor, { event: () => undefined, error: () => undefined }))
    .rejects.toMatchObject({ code: "identity_mismatch" });
  const stream = await fresh.subscribe({ incarnation: fresh.incarnation, sequence: replacement.transport.sequence },
    { event: () => undefined, error: () => undefined });
  stream.close(); await stream.closed;
  expect(await fresh.request({ operation: "jobs" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
});
test("bounds concurrent queued requests before any extra frame is written", async () => {
  // Given
  const path = directory();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const worker = serveWorker(path, async request => {
    calls++; entered.resolve();
    await release.promise;
    return unsupportedDomainHandler(request, new AbortController().signal);
  });
  workers.push(worker);
  const client = await attach(path);
  const pending = Promise.allSettled(Array.from({ length: 64 }, () => client.request({ operation: "jobs" })));
  await bounded(entered.promise);
  // When / Then
  await expect(client.request({ operation: "jobs" })).rejects.toMatchObject({ code: "overflow" });
  expect(calls).toBe(1);
  client.close(); release.resolve();
  expect((await pending).every(value => value.status === "rejected")).toBe(true);
});

const completed: Job = { ...job, status: "completed", failure: null,
  installTxn: { selection, state: "succeeded", failure: null,
    receipt: { kind: "completed", operationId: "update", effect: "updated", identity: null } },
  targetTxns: [{ ...target, state: "completed", failure: null,
    receipt: { kind: "completed", operationId: "start", effect: "started", identity: binding } }] };
const semanticFaults: readonly (readonly [string, unknown])[] = [
  ["missing transaction", { ...completed, targetTxns: [] }],
  ["extra transaction", { ...completed, targetTxns: [...completed.targetTxns, ...completed.targetTxns] }],
  ["duplicate selection", { ...completed, selectedTargets: [target, target], targetTxns: [...completed.targetTxns, ...completed.targetTxns] }],
  ["different runtime", corrupt(completed, ["targetTxns", 0, "runtimeId"], "unrelated")],
  ["different installation", corrupt(completed, ["targetTxns", 0, "installationId"], "unrelated")],
  ["different binding", corrupt(completed, ["targetTxns", 0, "expectedBinding", "session", "fullId"], "unrelated")],
  ["different selected installation", corrupt(completed, ["selectedTargets", 0, "installationId"], "unrelated")],
  ["missing updated receipt", corrupt(completed, ["installTxn", "receipt"], null)],
  ["uncertain updated receipt", corrupt(completed, ["installTxn", "receipt"], { kind: "uncertain", operationId: "update" })],
  ["wrong install effect", corrupt(completed, ["installTxn", "receipt", "effect"], "started")],
  ["install identity", corrupt(completed, ["installTxn", "receipt", "identity"], binding)],
  ["missing started receipt", corrupt(completed, ["targetTxns", 0, "receipt"], null)],
  ["wrong target effect", corrupt(completed, ["targetTxns", 0, "receipt", "effect"], "stopped")],
  ["missing started identity", corrupt(completed, ["targetTxns", 0, "receipt", "identity"], null)],
];
function jobResponse(operation: "jobs" | "create-job" | "inspect-job" | "reconcile-job", requestId: unknown, value: unknown): unknown {
  const inspection = { job: value, targets: [] };
  const result = operation === "jobs" ? { jobs: [value] }
    : operation === "create-job" ? { kind: "created", job: value }
    : operation === "inspect-job" ? inspection : { kind: "unchanged", inspection };
  return { version: 1, requestId, operation, ok: true, result };
}
test.each(["jobs", "create-job", "inspect-job", "reconcile-job"] as const)
("r2 rejects contradictory job semantics without normalizing the %s DTO", operation => {
  // Given: a valid completed control and independently shape-valid contradictions.
  expect(isServiceResponse(jobResponse(operation, "r", completed))).toBe(true);
  // When / Then
  for (const [_name, invalid] of semanticFaults) {
    const before = JSON.stringify(invalid);
    expect(isServiceResponse(jobResponse(operation, "r", invalid))).toBe(false);
    expect(JSON.stringify(invalid)).toBe(before);
  }
});
test("r2 preserves established job decoder and projection semantics", () => {
  // Given
  const stored = initialJob(parseNewJob({ jobId: "job", requestId: "create", installation: selection,
    mode: "update-and-restart", selectedTargets: [target] }));
  // When / Then
  expect(() => decodeJob(JSON.stringify({ ...stored, targets: [] }))).toThrow();
  const unverifiedInstall = { ...stored.install, state: "succeeded", receipt: null } as const;
  expect(viewJob({ ...stored, install: unverifiedInstall }).status).toBe("partial");
  expect(isServiceResponse(jobResponse("jobs", "r", { ...completed, mode: "update-only",
    selectedTargets: [], targetTxns: [], installTxn: unverifiedInstall }))).toBe(false);
  expect(isServiceResponse(jobResponse("jobs", "r", { ...completed, mode: "update-only",
    selectedTargets: [], targetTxns: [] }))).toBe(true);
});
test.each(["queued", "partial", "failed", "cancelled", "recovery_required"] as const)
("r2 rejects mismatched selection and transactions even when status is %s", status => {
  // Given: matching noncompleted state remains admissible without completed receipts.
  const valid = { ...job, status };
  expect(isServiceResponse(jobResponse("jobs", "r", valid))).toBe(true);
  // When / Then
  expect(isServiceResponse(jobResponse("jobs", "r", { ...valid, targetTxns: [] }))).toBe(false);
  expect(isServiceResponse(jobResponse("jobs", "r",
    corrupt(valid, ["targetTxns", 0, "expectedBinding", "paneGeneration"], 2)))).toBe(false);
});
test.each(["jobs", "create-job", "inspect-job", "reconcile-job"] as const)
("r2 fails closed for false completed %s responses over real authenticated UDS", async operation => {
  // Given
  const fixture = faultyWorker((socket, value) => {
    if (!record(value)) throw new ClientError("protocol");
    send(socket, jobResponse(operation, value["requestId"], { ...completed, targetTxns: [] }));
  });
  const client = await attach(fixture.path);
  const body = operation === "jobs" ? { operation } as const
    : operation === "create-job" ? { operation, mode: "update-only", installation: selection, selectedTargets: [] } as const
    : operation === "inspect-job" ? { operation, jobId: "job" } as const
    : { operation, jobId: "job", expectedRevision: 0 } as const;
  // When / Then
  await expect(client.request(body)).rejects.toMatchObject({ code: "protocol" });
  await expect(client.request({ operation: "jobs" })).rejects.toMatchObject({ code: "closed" });
});
test.each(["jobs", "create-job", "inspect-job", "reconcile-job"] as const)
("r2 rejects false completed %s event before listener or cursor advancement", async operation => {
  // Given
  const failed = Promise.withResolvers<ClientError>();
  const fixture = faultyWorker((socket, value) => {
    if (!record(value)) throw new ClientError("protocol");
    if (value["kind"] === "subscribe") {
      send(socket, { kind: "subscribed", incarnation: value["incarnation"], sequence: 0 });
      send(socket, { kind: "event", incarnation: value["incarnation"], sequence: 1,
        response: jobResponse(operation, "event", { ...completed, targetTxns: [] }) });
    } else send(socket, { version: 1, requestId: value["requestId"], operation: "jobs", ok: true, result: { jobs: [] } });
  });
  const client = await attach(fixture.path);
  let delivered = 0;
  // When
  const stream = await client.subscribe({ incarnation: client.incarnation, sequence: 0 },
    { event: () => { delivered++; }, error: failed.resolve });
  // Then
  expect(await bounded(failed.promise)).toMatchObject({ code: "protocol" });
  await bounded(stream.closed);
  expect(delivered).toBe(0);
  expect(stream.cursor.sequence).toBe(0);
  expect(await client.request({ operation: "jobs" })).toMatchObject({ ok: true });
});

test("r2 owns reply rejection for a real valid oversized request without process unhandled events", async () => {
  // Given: isolate the host event loop so absence is checked at beforeExit, after
  // real socket retirement, not by an arbitrary delay inside the test runner.
  const probe = `
    import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { attachAuthenticatedWorker, ClientError } from "./src/service/client.ts";
    import { serveWorker, unsupportedDomainHandler } from "./src/service/worker.ts";
    import { validateRequest } from "./src/protocol.ts";
    import { MAX_FRAME_BYTES } from "./src/service/socket.ts";
    const unexpected = [];
    process.on("unhandledRejection", error => {
      unexpected.push({ name: error instanceof Error ? error.name : "unknown",
        code: error instanceof Error && "code" in error ? error.code : "unknown" });
    });
    let result;
    process.once("beforeExit", () => {
      if (!result || unexpected.length !== 0) process.exitCode = 1;
      console.log(JSON.stringify({ ...result, unexpectedUnhandled: unexpected }));
    });
    const root = mkdtempSync(join(realpathSync(tmpdir()), "clov-"));
    const worker = serveWorker(join(root, "worker"), unsupportedDomainHandler);
    let client;
    try {
      client = await attachAuthenticatedWorker(worker.owner.directory, 1000);
      const token = readFileSync(worker.owner.tokenPath, "utf8");
      const targets = Array.from({ length: 20 }, (_, i) => ({
        targetId: "t" + i, runtimeId: "r" + i, installationId: "install",
        expectedBinding: { socketId: "s" + i, socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
          rootIncarnation: { pid: 1, startIdentity: "start", executableRealpath: "/fixture/cli" },
          session: { kind: "conversation", fullId: "conversation", storagePathHash: "hash" },
          cwd: "/" + "x".repeat(4000), optionsRef: "opaque", turnGeneration: 1, resourcesFingerprint: "fp" },
      }));
      const body = { operation: "create-job", mode: "update-and-restart",
        installation: { installationId: "install", resourcesFingerprint: "fp",
          owner: { kind: "unknown", reason: "unverified_owner" },
          installedVersion: { kind: "unknown", reason: "not_captured" } },
        selectedTargets: targets };
      const framed = { ...body, version: 1, requestId: "00000000-0000-0000-0000-000000000000", token };
      const bytes = Buffer.byteLength(JSON.stringify(framed));
      if (!validateRequest(framed, token).ok || bytes <= MAX_FRAME_BYTES) throw new ClientError("invalid_request");
      const caller = await client.request(body).then(() => "unexpected_success",
        error => error instanceof ClientError ? error.code : "raw_error");
      const subsequent = await client.request({ operation: "jobs" }).then(() => "unexpected_success",
        error => error instanceof ClientError ? error.code : "raw_error");
      result = { bytes, validRequest: true, caller, subsequent };
      if (caller !== "overflow" || subsequent !== "closed") process.exitCode = 1;
    } catch {
      process.exitCode = 1;
      result = { failure: "probe_failed" };
    } finally {
      client?.close();
      await worker.stop();
      const workerConnections = worker.transport.connectionCount;
      rmSync(root, { recursive: true });
      result = { ...result, cleanup: { workerConnections, rootExists: existsSync(root) } };
      if (workerConnections !== 0 || existsSync(root)) process.exitCode = 1;
    }
  `;
  const child = Bun.spawn([process.execPath, "--eval", probe], {
    cwd: resolve(import.meta.dir, "../.."), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    signal: AbortSignal.timeout(2000),
  });
  // When: observer is installed inside the child before invoking request.
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    // Then: natural beforeExit follows all rejection notification and cleanup.
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const result: unknown = JSON.parse(stdout);
    expect(result).toMatchObject({ validRequest: true, caller: "overflow", subsequent: "closed",
      unexpectedUnhandled: [], cleanup: { workerConnections: 0, rootExists: false } });
    if (!record(result)) throw new ClientError("protocol");
    expect(result["bytes"]).toBe(88531);
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
});
