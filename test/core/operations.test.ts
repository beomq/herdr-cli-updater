import { expect, test } from "bun:test";
import { once } from "node:events";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { appendFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { canonical } from "../../src/jobs/jobs";
import { evaluateResourceGate } from "../../src/install/resources";
import type { ResourceObservation, ResourcePlan } from "../../src/install/resources";
import { MutationQueue, QueueError } from "../../src/install/queue";
import { CoreOperationsClient, createRestartLifecyclePort, OperationFailure, parseRestart, RESTART_METHOD } from "../../src/core/client";
import type { RestartBinding, RestartSnapshot } from "../../src/core/client";

const identity = { version: "0.9.1", protocol: 1, schemaSha256: "a".repeat(64) };
const pong = {
  type: "pong", version: identity.version, protocol: identity.protocol,
  capabilities: { updater_restart_v1: true, updater_native_launch_v1: true,
    updater_restart_schema_sha256: identity.schemaSha256 },
};
function snapshot(): RestartSnapshot {
  return { binding: null, receipt: null, owner_token: null, native_qualified: false,
    recovery_required: false, replay_ready: false };
}
function boundSnapshot(): RestartSnapshot {
  const supervisor = { pid: 20, parent_pid: 10, uid: 501, pgid: 20, tty: 17,
    start_seconds: 100, start_microseconds: 200, executable: "/private/core" };
  const binding: RestartBinding = {
    socket_epoch: "fresh-core", pane_id: "w:p", terminal_id: "terminal", slot: "b".repeat(64),
    generation: 2, work_generation: 0, input_sequence: 3, supervisor,
    root: { ...supervisor, pid: 30, parent_pid: 20, pgid: 30, start_seconds: 102, executable: "/private/native" },
    launch_ref: "b".repeat(64),
    session: { full_id: "full-session", storage_identity: "c".repeat(64), cwd: "/private/work",
      options_sha256: "d".repeat(64), environment_sha256: "e".repeat(64) },
  };
  return { ...snapshot(), binding,
    receipt: { operation_id: "start-once", pane_id: "w:p", request_sha256: "a".repeat(64),
      action: "start", status: "completed", binding, native_qualified: false, reason: null } };
}
type Wire = { readonly id: string; readonly method: string; readonly params: unknown };
function wire(value: unknown): Wire {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string"
    || !("method" in value) || typeof value.method !== "string" || !("params" in value))
    throw new Error("test peer received invalid request");
  return { id: value.id, method: value.method, params: value.params };
}
async function peer(
  response: (request: Wire, socket: Socket, journalPath: string) => unknown,
  exercise: (client: CoreOperationsClient, methods: string[], journalPath: string) => Promise<void>,
): Promise<void> {
  const root = realpathSync(await mkdtemp("/tmp/operations-"));
  const path = join(root, "core.sock"), sockets = new Set<Socket>(), methods: string[] = [];
  const journal = join(root, "operations.jsonl");
  await writeFile(journal, "", { mode: 0o600 });
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", data => {
      input += data;
      const end = input.indexOf("\n");
      if (end < 0) return;
      const request = wire(JSON.parse(input.slice(0, end)));
      input = "";
      methods.push(request.method);
      const result = response(request, socket, journal);
      if (result !== undefined) socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  try {
    const listening = once(server, "listening");
    server.listen(path);
    await listening;
    await chmod(path, 0o600);
    await exercise(new CoreOperationsClient(path, identity), methods, journal);
  } finally {
    for (const socket of sockets) socket.destroy();
    const closed = once(server, "close");
    server.close();
    await closed;
    await rm(root, { recursive: true });
  }
}

test("strictly distinguishes absent operation from native success", () => {
  expect(parseRestart(snapshot()).receipt).toBeNull();
  expect(parseRestart(snapshot()).native_qualified).toBe(false);
  for (const changed of [
    { ...snapshot(), native_qualified: ["true"] },
    { ...snapshot(), replay_ready: true },
    { ...snapshot(), owner_token: "b".repeat(64) },
    { ...snapshot(), extra: "not-in-contract" },
    { ...snapshot(), receipt: { operation_id: "op", status: "completed" } },
  ]) expect(() => parseRestart(changed)).toThrow(OperationFailure);
});

test("discovers native identity before requesting an operation", async () => {
  await peer(request => request.method === "ping" ? pong : { type: "updater_restart", snapshot: snapshot() },
    async (client, methods) => {
      const discovered = await CoreOperationsClient.discover(client.socketId);
      expect(methods).toEqual(["ping"]);
      expect(await discovered.request({ action: "inspect", pane_id: "w:p" })).toEqual(snapshot());
      expect(methods).toEqual(["ping", "ping", RESTART_METHOD]);
    });
});

test("discovery refuses a stock host without native capability before mutation", async () => {
  await peer(() => ({ ...pong, capabilities: {} }), async (client, methods) => {
    await expect(CoreOperationsClient.discover(client.socketId)).rejects.toMatchObject({ code: "unqualified_core" });
    expect(methods).toEqual(["ping"]);
  });
});

test("preserves complete mechanism receipts without promoting native qualification", () => {
  const result = parseRestart(boundSnapshot());
  expect(result).toEqual(boundSnapshot());
  expect(result.receipt?.native_qualified).toBe(false);
  expect(result.binding?.root.pid).not.toBe(result.binding?.supervisor.pid);
});

for (const [name, changed] of [
  ["wrong parent", { parent_pid: 999 }],
  ["wrong process group", { pgid: 20 }],
  ["other uid", { uid: 502 }],
  ["other tty", { tty: 18 }],
  ["unsafe start time", { start_seconds: Number.MAX_SAFE_INTEGER + 1 }],
  ["coerced pid", { pid: [30] }],
] as const) {
  test(`rejects ${name} in the process binding`, () => {
    const original = boundSnapshot();
    expect(() => parseRestart({ ...original, binding: { ...original.binding,
      root: { ...original.binding?.root, ...changed } } })).toThrow(OperationFailure);
  });
}

test("rejects an unqualified core before sending any mutation", async () => {
  await peer(() => ({ ...pong, capabilities: { ...pong.capabilities, updater_restart_schema_sha256: "c".repeat(64) } }),
    async (client, methods) => {
      await expect(client.request({ action: "launch", operation_id: "launch-one", pane_id: "w:p", profile: "native" }))
        .rejects.toMatchObject({ code: "unqualified_core", mayHaveExecuted: false });
      expect(methods).toEqual(["ping"]);
    });
});

test("a lost mutation response is uncertain and does not retry the launch", async () => {
  const received = Promise.withResolvers<void>();
  await peer((request, socket) => {
    if (request.method === "ping") return pong;
    if (request.method === "updater.native.launch.v1") {
      received.resolve();
      socket.end();
      return undefined;
    }
    return { type: "updater_restart", snapshot: snapshot() };
  }, async (client, methods) => {
    const pending = client.request({ action: "launch", operation_id: "launch-once", pane_id: "w:p", profile: "mechanism" });
    const rejected = expect(pending).rejects.toMatchObject({ mayHaveExecuted: true, code: "partial_response" });
    await received.promise;
    await rejected;
    expect(methods).toEqual(["ping", "updater.native.launch.v1"]);
    const result = await client.request({ action: "result", operation_id: "launch-once" });
    expect(result.receipt).toBeNull();
    expect(methods).toEqual(["ping", "updater.native.launch.v1", "ping", "updater.restart.v1"]);
  });
});

test("rejects a mismatched public response identity without retransmission", async () => {
  await peer((request, socket) => {
    if (request.method === "ping") return pong;
    socket.end(`${JSON.stringify({ id: "another-request", result: { type: "updater_restart", snapshot: snapshot() } })}\n`);
    return undefined;
  }, async (client, methods) => {
    await expect(client.request({ action: "inspect", pane_id: "w:p" }))
      .rejects.toMatchObject({ code: "response_identity", mayHaveExecuted: false });
    expect(methods).toEqual(["ping", "updater.restart.v1"]);
  });
});

const installation = { installationId: "isolated-install", family: "omo", channel: "latest", executableRealpath: "/private/omo",
  resourcesFingerprint: "before", owner: { kind: "wrapper", packageName: "omo-ai", engineResourceId: "engine", prefix: "/private" },
  installedVersion: { kind: "known", version: "5.1.9" },
  resources: [{ resourceId: "engine", realpath: "/private/engine", fingerprint: "engine-before" }] } as const;
test("refuses concrete eligibility from an unqualified native inspection", async () => {
  // Given / When / Then: real JSON socket, intentionally unqualified native peer.
  await peer(request => request.method === "ping" ? pong : { type: "updater_restart", snapshot: boundSnapshot() },
    async (client, methods, operationsPath) => {
      await expect(createRestartLifecyclePort(client, { operationsPath, paneId: "w:p", runtimeId: "omo",
        profile: "updated-pair", installation, observeInstallation: () => installation }))
        .rejects.toMatchObject({ code: "unqualified_native" });
      expect(methods).toEqual(["ping", "updater.restart.v1"]);
    });
});
test("Node WAL observer queries authenticated Result after a held descriptor append and joins on close", async () => {
  const operationId = "held-writer";
  const before = boundSnapshot();
  const final: RestartSnapshot = { ...before, receipt: { operation_id: operationId, pane_id: "w:p", request_sha256: "a".repeat(64),
    action: "claim", status: "completed", binding: before.binding, native_qualified: true, reason: null } };
  await peer(request => request.method === "ping" ? pong : { type: "updater_restart", snapshot: final },
    async (client, methods, operationsPath) => {
      const writer = await open(operationsPath, "a");
      const node = Bun.which("node");
      if (!node) throw new Error("Node runtime required for WAL observer regression");
      const observation = client.observeOperation(operationId, operationsPath, AbortSignal.timeout(5000), node);
      try {
        await observation.ready;
        await writer.write("wake-only\n");
        await writer.sync();
        expect(await observation.completed).toEqual(final);
        expect(methods).toEqual(["ping", RESTART_METHOD]);
      } finally { await observation.close(); await writer.close(); }
    });
});
for (const family of ["omo", "codex", "omp", "pi", "claude"] as const)
test.each(["wal-change", "already-completed", "lost-response"] as const)(`${family} concrete port observes %s without retry and resumes the exact bound profile`, async mode => {
  // Given: real socket/WAL signals and a controlled native-shaped peer, not actual
  // native qualification. The peer enforces original binding/profile/stop linkage.
  const original = boundSnapshot().binding;
  if (!original) throw new Error("fixture_binding_missing");
  let current = original;
  let recordedStopId: string | null = null;
  const operations = new Map<string, RestartSnapshot>(), actions: string[] = [];
  await peer((request, socket, journal) => {
    if (request.method === "ping") return pong;
    const p = request.params;
    if (typeof p !== "object" || p === null || !("action" in p) || typeof p.action !== "string") throw new Error("fixture_action");
    if (p.action === "inspect") return { type: "updater_restart", snapshot: {
      ...snapshot(), binding: current, native_qualified: true,
    } };
    if (!("operation_id" in p) || typeof p.operation_id !== "string") throw new Error("fixture_operation");
    if (p.action === "result") return { type: "updater_restart", snapshot: operations.get(p.operation_id) ?? snapshot() };
    if (!("expected_binding" in p)) throw new Error("fixture_expected_binding");
    expect(p.expected_binding).toEqual(p.action === "release" ? current : original);
    const action = p.action;
    if (action !== "claim" && action !== "stop" && action !== "start" && action !== "release") throw new Error("fixture_mutation");
    actions.push(action);
    if (action === "stop") recordedStopId = p.operation_id;
    if (action === "start") {
      expect(p).toMatchObject({ profile: "updated-pair", stop_operation_id: recordedStopId });
      current = { ...original, generation: original.generation + 1,
        root: { ...original.root, pid: original.root.pid + 1, pgid: original.root.pid + 1,
          start_seconds: original.root.start_seconds + 1 } };
    }
    const completed: RestartSnapshot = { binding: current, native_qualified: true, recovery_required: false,
      replay_ready: false, owner_token: action === "release" ? null : "f".repeat(64),
      receipt: { operation_id: p.operation_id, pane_id: current.pane_id, request_sha256: "a".repeat(64),
        action, status: "completed", binding: current, native_qualified: true, reason: null } };
    operations.set(p.operation_id, completed);
    if (mode === "lost-response") {
      appendFileSync(journal, "controlled-completion\n");
      socket.end();
      return undefined;
    }
    if (mode === "wal-change") {
      appendFileSync(journal, "controlled-completion\n");
      return { type: "updater_restart", snapshot: { ...completed,
        receipt: { ...completed.receipt, operation_id: p.operation_id, pane_id: current.pane_id,
          request_sha256: "a".repeat(64), action, status: "in_progress", binding: current, native_qualified: true, reason: null } } };
    }
    // A completed duplicate response must settle even without a new WAL event.
    return { type: "updater_restart", snapshot: completed };
  }, async (client, _methods, operationsPath) => {
    const executableRealpath = join(dirname(operationsPath), `owned-installed-${family}`);
    await writeFile(executableRealpath, "controlled installed fixture");
    const owner = family !== "omo"
      ? { kind: "package", manager: "npm", packageName: { codex: "@openai/codex", omp: "@oh-my-pi/pi-coding-agent",
        pi: "@code-yeongyu/senpi", claude: "@anthropic-ai/claude-code" }[family], prefix: dirname(operationsPath) } as const
      : { ...installation.owner, prefix: dirname(operationsPath) };
    const installed = { ...installation, family, executableRealpath, owner,
      resources: [{ resourceId: "engine", realpath: executableRealpath, fingerprint: "engine-before" }] };
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required for WAL observer regression");
    const actual = await createRestartLifecyclePort(client, { operationsPath, paneId: "w:p", runtimeId: family, observerNode: node,
      profile: "updated-pair", installation: installed, observeInstallation: () => ({ ...installed, resourcesFingerprint: "after" }) });
    const signal = new AbortController().signal;
    const subscribed = actual.lifecycle.subscribe(actual.target, signal);
    try {
      const inspected = await actual.lifecycle.inspect(actual.target, signal);
      expect(inspected).toMatchObject({ ok: true, value: { complete: false } });
      const claim = await actual.lifecycle.claim(actual.target, "job-claim", signal);
      if (!claim.ok) throw new Error("fixture_claim_failed");
      expect(await subscribed.completed).toEqual({ ok: true, value: actual.runtime.binding });
      const jobId = "native-gate-job";
      const operationId = `op-${createHash("sha256").update(canonical([jobId, actual.target.targetId, "stop"])).digest("hex")}`;
      expect(operationId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      const supported = { kind: "supported", reason: "verified", evidenceRef: "controlled-native-shaped-peer" } as const;
      const unknown = { kind: "unknown", reason: "not_verified" } as const;
      const plan: ResourcePlan = { mode: "update-and-restart", installerDigest: `sha256:${"a".repeat(64)}`,
        selectedTargets: [actual.target], mutationResources: installed.resources,
        contract: { version: 1, family, installation: installed, runtime: actual.runtime,
          capabilities: { check: supported, update: supported, completion: supported, gracefulExit: supported, resume: supported, busySafe: unknown } } };
      const observation: ResourceObservation = { installation: installed, installerDigest: plan.installerDigest,
        mutationResources: installed.resources, allSocketsKnown: true, outsideConsumersKnown: true, consumers: [], busySafety: null };
      const forged = { kind: "completed", operationId, effect: "stopped", identity: actual.runtime.binding } as const;
      expect(evaluateResourceGate(plan, observation, { jobId, claim: claim.value, receipt: forged }))
        .toMatchObject({ ok: false, error: { code: "unsupported" } });
      const stopped = await actual.lifecycle.stop(claim.value, operationId, signal);
      expect(stopped).toMatchObject({ ok: true,
        value: { kind: "completed", effect: "stopped", identity: actual.runtime.binding } });
      if (!stopped.ok) throw new Error("fixture_stop_failed");
      const authority = { jobId, claim: claim.value, receipt: stopped.value };
      expect(evaluateResourceGate(plan, observation, authority)).toEqual({ ok: true, value: null });
      for (const invalid of [{ ...authority, jobId: "different-job" }, { ...authority, claim: { ...claim.value } },
        { ...authority, receipt: { ...stopped.value } }])
        expect(evaluateResourceGate(plan, observation, invalid)).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(evaluateResourceGate({ ...plan, selectedTargets: [{ ...actual.target, targetId: "different-target" }] }, observation, authority))
        .toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(evaluateResourceGate({ ...plan, selectedTargets: [{ ...actual.target, runtimeId: "different-runtime" }] }, observation, authority))
        .toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(evaluateResourceGate({ ...plan, selectedTargets: [{ ...actual.target,
        expectedBinding: { ...actual.target.expectedBinding, socketEpoch: "different-epoch" } }] }, observation, authority))
        .toMatchObject({ ok: false, error: { code: "unsupported" } });
      for (const field of ["allSocketsKnown", "outsideConsumersKnown"])
        expect(evaluateResourceGate(plan, { ...observation, [field]: false }, authority))
          .toMatchObject({ ok: false, error: { code: "unsupported" } });
      for (const binding of [actual.runtime.binding, null])
        expect(evaluateResourceGate(plan, { ...observation, consumers: [{
          consumerId: "still-live", binding, resources: installed.resources, state: "running",
        }] }, authority)).toMatchObject({ ok: false, error: { code: "resources_busy" } });
      using queue = new MutationQueue(join(dirname(operationsPath), "mutation-queue"));
      queue.enqueue({ jobId, requestId: jobId, plan });
      expect(() => queue.acquire(jobId, 0, () => observation, { claim: claim.value, receipt: { ...stopped.value } }))
        .toThrow(new QueueError("unsupported"));
      expect(queue.get(jobId).revision).toBe(0);
      const ownership = queue.acquire(jobId, 0, () => observation, authority);
      expect(queue.get(jobId)).toMatchObject({ state: "recovery_required", revision: 1 });
      expect(evaluateResourceGate(plan, observation, authority)).toEqual({ ok: true, value: null });
      expect(() => queue.acquire(jobId, 1, () => observation, authority)).toThrow(new QueueError("recovery_required"));
      queue.complete(ownership, installed, () => installed);
      const started = await actual.lifecycle.start(claim.value, "job-start", operationId, signal);
      if (!started.ok || started.value.kind !== "completed" || !started.value.identity) throw new Error("fixture_start_failed");
      expect(started.value.identity.session).toEqual(actual.runtime.binding.session);
      expect(started.value.identity.optionsRef).toBe(actual.runtime.binding.optionsRef);
      expect(started.value.identity.rootIncarnation.startIdentity).not.toBe(actual.runtime.binding.rootIncarnation.startIdentity);
      expect(evaluateResourceGate(plan, observation, authority)).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(await actual.lifecycle.release(claim.value, started.value.identity, "job-release", signal)).toEqual({ ok: true, value: null });
      expect(actions).toEqual(["claim", "stop", "start", "release"]);
    } finally { subscribed.close(); }
  });
});
test("abandons owned work observation after dispatch without mutation retry or fake completion", async () => {
  // Given: actual subscribed WAL and a held InProgress response.
  const received = Promise.withResolvers<void>(), actions: string[] = [];
  const original = boundSnapshot().binding;
  if (!original) throw new Error("fixture_binding_missing");
  await peer((request, _socket, journal) => {
    if (request.method === "ping") return pong;
    const p = request.params;
    if (typeof p !== "object" || p === null || !("action" in p)) throw new Error("fixture_action");
    if (p.action === "claim") {
      actions.push("claim"); appendFileSync(journal, "controlled-intent\n"); received.resolve();
      if (!("operation_id" in p) || typeof p.operation_id !== "string") throw new Error("fixture_operation");
      return { type: "updater_restart", snapshot: { ...snapshot(), binding: original, native_qualified: true,
        receipt: { operation_id: p.operation_id, pane_id: original.pane_id, request_sha256: "a".repeat(64),
          action: "claim", status: "in_progress", binding: original, native_qualified: true, reason: null } } };
    }
    return { type: "updater_restart", snapshot: { ...snapshot(), binding: original, native_qualified: true } };
  }, async (client, _methods, operationsPath) => {
    const actual = await createRestartLifecyclePort(client, { operationsPath, paneId: "w:p", runtimeId: "omo",
      profile: "updated-pair", installation, observeInstallation: () => installation });
    const owner = new AbortController();
    const subscribed = actual.lifecycle.subscribe(actual.target, owner.signal);
    try {
      const pending = actual.lifecycle.claim(actual.target, "once-only", owner.signal);
      await received.promise;
      // When / Then: exact owner event, no sleeps or timed polling.
      owner.abort();
      expect(await pending).toMatchObject({ ok: false, error: { code: "recovery_required" } });
      expect(await subscribed.completed).toMatchObject({ ok: false });
      expect(actions).toEqual(["claim"]);
    } finally { subscribed.close(); }
  });
});
test.each(["unqualified-caller", "uncertain-current-root"] as const)("does not promote a historical native receipt with %s", async mode => {
  // Given: completed historical receipt but current caller/root is not qualified.
  const binding = boundSnapshot().binding;
  if (!binding) throw new Error("fixture_binding_missing");
  await peer(request => {
    if (request.method === "ping") return pong;
    const p = request.params;
    if (typeof p !== "object" || p === null || !("action" in p)) throw new Error("fixture_action");
    if (p.action !== "result") return { type: "updater_restart",
      snapshot: { ...snapshot(), binding, native_qualified: true } };
    return { type: "updater_restart", snapshot: { ...snapshot(), binding,
      native_qualified: mode !== "unqualified-caller", recovery_required: mode === "uncertain-current-root",
      receipt: { operation_id: "historic-stop", pane_id: binding.pane_id, request_sha256: "a".repeat(64),
        action: "stop", status: "completed", binding, native_qualified: true, reason: null } } };
  }, async (client, methods, operationsPath) => {
    const actual = await createRestartLifecyclePort(client, { operationsPath, paneId: "w:p", runtimeId: "omo",
      profile: "updated-pair", installation, observeInstallation: () => installation });
    // When / Then: no mutation or promotion from an otherwise well-formed receipt.
    expect(await actual.lifecycle.result("historic-stop", new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: "recovery_required" } });
    expect(methods).toEqual(["ping", "updater.restart.v1", "ping", "updater.restart.v1"]);
  });
});
