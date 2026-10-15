import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AdapterResult, InstallationIdentity } from "../adapters/types";
import type { Receipt, Runtime, RuntimeBinding, TargetSelection } from "../protocol";
import { isTargetSelection } from "../protocol";
import type { LifecycleClaim, LifecyclePort } from "../service/job-runner";

export const RESTART_METHOD = "updater.restart.v1";
export type CoreIdentity = {
  readonly version: string; readonly protocol: number; readonly schemaSha256: string;
};
export type ProcessIncarnation = {
  readonly pid: number; readonly parent_pid: number; readonly uid: number;
  readonly pgid: number; readonly tty: number; readonly start_seconds: number;
  readonly start_microseconds: number; readonly executable: string;
};
export type SessionAttestation = {
  readonly full_id: string; readonly storage_identity: string; readonly cwd: string;
  readonly options_sha256: string; readonly environment_sha256: string;
};
export type RestartBinding = {
  readonly socket_epoch: string; readonly pane_id: string; readonly terminal_id: string;
  readonly slot: string; readonly generation: number; readonly supervisor: ProcessIncarnation;
  readonly work_generation: number; readonly input_sequence: number;
  readonly root: ProcessIncarnation; readonly launch_ref: string; readonly session: SessionAttestation;
};
export type OperationReceipt = {
  readonly operation_id: string; readonly pane_id: string; readonly request_sha256: string;
  readonly action: "launch" | "claim" | "stop" | "start" | "release";
  readonly status: "in_progress" | "completed" | "uncertain" | "rejected";
  readonly binding: RestartBinding | null; readonly native_qualified: boolean; readonly reason: string | null;
};
export type RestartSnapshot = {
  readonly binding: RestartBinding | null; readonly receipt: OperationReceipt | null;
  readonly owner_token: string | null; readonly native_qualified: boolean;
  readonly recovery_required: boolean; readonly replay_ready: false;
};
export type RestartRequest =
  | { readonly action: "inspect"; readonly pane_id: string }
  | { readonly action: "result"; readonly operation_id: string }
  | { readonly action: "launch"; readonly operation_id: string; readonly pane_id: string; readonly profile: string }
  | { readonly action: "claim"; readonly operation_id: string; readonly expected_binding: RestartBinding }
  | { readonly action: "stop" | "release"; readonly operation_id: string; readonly expected_binding: RestartBinding; readonly owner_token: string }
  | { readonly action: "start"; readonly operation_id: string; readonly expected_binding: RestartBinding;
      readonly owner_token: string; readonly stop_operation_id: string; readonly profile: string };

export class OperationFailure extends Error {
  constructor(readonly code: string, readonly mayHaveExecuted = false) {
    super(code); this.name = "OperationFailure";
  }
}
// Existing claim and actual returned stop receipt identities carry authority.
// Serialized receipts and Result-only observations cannot reopen mutation.
const stoppedClaims = new WeakMap<LifecycleClaim, {
  readonly binding: RuntimeBinding;
  readonly target: TargetSelection;
  readonly signal: AbortSignal;
  active: boolean;
  receipt: Receipt | null;
}>();
export function matchesNativeStoppedClaim(claim: LifecycleClaim, receipt: Receipt,
  operationId: string, target: TargetSelection): boolean {
  const owned = stoppedClaims.get(claim);
  return owned !== undefined && owned.active && !owned.signal.aborted && owned.receipt !== null && owned.receipt === receipt
    && receipt.kind === "completed" && receipt.effect === "stopped" && receipt.operationId === operationId
    && isDeepStrictEqual(owned.target, target);
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function text(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v);
}
function integer(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function hash(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{64}$/.test(v); }
function keys(v: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(v).length === expected.length && expected.every(key => Object.hasOwn(v, key));
}
function processIdentity(v: unknown): v is ProcessIncarnation {
  return record(v) && keys(v, ["pid", "parent_pid", "uid", "pgid", "tty", "start_seconds", "start_microseconds", "executable"])
    && integer(v["pid"]) && v["pid"] > 0 && integer(v["parent_pid"]) && integer(v["uid"])
    && integer(v["pgid"]) && v["pgid"] > 0 && integer(v["tty"]) && integer(v["start_seconds"])
    && integer(v["start_microseconds"]) && v["start_microseconds"] < 1_000_000
    && text(v["executable"]) && v["executable"].startsWith("/");
}
function session(v: unknown): v is SessionAttestation {
  return record(v) && keys(v, ["full_id", "storage_identity", "cwd", "options_sha256", "environment_sha256"])
    && text(v["full_id"]) && hash(v["storage_identity"]) && text(v["cwd"]) && v["cwd"].startsWith("/")
    && hash(v["options_sha256"]) && hash(v["environment_sha256"]);
}
function binding(v: unknown): v is RestartBinding {
  return record(v) && keys(v, ["socket_epoch", "pane_id", "terminal_id", "slot", "generation", "work_generation", "input_sequence",
    "supervisor", "root", "launch_ref", "session"])
    && text(v["socket_epoch"]) && text(v["pane_id"]) && text(v["terminal_id"]) && hash(v["slot"])
    && integer(v["generation"]) && v["generation"] > 0 && hash(v["launch_ref"])
    && integer(v["work_generation"]) && integer(v["input_sequence"])
    && processIdentity(v["supervisor"]) && processIdentity(v["root"])
    && v["root"].parent_pid === v["supervisor"].pid && v["root"].pid !== v["supervisor"].pid
    && v["root"].uid === v["supervisor"].uid && v["root"].pgid === v["root"].pid
    && v["root"].tty === v["supervisor"].tty && session(v["session"]);
}
function action(v: unknown): v is OperationReceipt["action"] {
  return typeof v === "string" && ["launch", "claim", "stop", "start", "release"].includes(v);
}
function status(v: unknown): v is OperationReceipt["status"] {
  return typeof v === "string" && ["in_progress", "completed", "uncertain", "rejected"].includes(v);
}
function receipt(v: unknown): v is OperationReceipt {
  return record(v) && keys(v, ["operation_id", "pane_id", "request_sha256", "action", "status",
    "binding", "native_qualified", "reason"])
    && text(v["operation_id"]) && text(v["pane_id"]) && hash(v["request_sha256"])
    && action(v["action"]) && status(v["status"]) && typeof v["native_qualified"] === "boolean"
    && (v["reason"] === null || text(v["reason"]))
    && (v["binding"] === null || (binding(v["binding"]) && v["binding"].pane_id === v["pane_id"]))
    && (v["status"] !== "completed" || v["binding"] !== null);
}
export function parseRestart(v: unknown): RestartSnapshot {
  if (!record(v) || !keys(v, ["binding", "receipt", "owner_token", "native_qualified", "recovery_required", "replay_ready"])
    || !(v["binding"] === null || binding(v["binding"]))
    || !(v["receipt"] === null || receipt(v["receipt"]))
    || !(v["owner_token"] === null || hash(v["owner_token"]))
    || typeof v["native_qualified"] !== "boolean" || typeof v["recovery_required"] !== "boolean"
    || v["replay_ready"] !== false
    || (v["owner_token"] !== null && (v["binding"] === null || v["recovery_required"]))
    || (v["binding"] !== null && v["receipt"] !== null && v["binding"].pane_id !== v["receipt"].pane_id))
    throw new OperationFailure("malformed_restart");
  return { binding: v["binding"], receipt: v["receipt"], owner_token: v["owner_token"],
    native_qualified: v["native_qualified"], recovery_required: v["recovery_required"], replay_ready: false };
}

/** No automatic retries: an uncertain mutation is followed by a separate result query. */
export class CoreOperationsClient {
  private inFlight = false;
  constructor(private readonly socketPath: string, private readonly identity: CoreIdentity) {}
  static async discover(socketPath: string, signal?: AbortSignal): Promise<CoreOperationsClient> {
    const probe = new CoreOperationsClient(socketPath, { version: "", protocol: 0, schemaSha256: "" });
    const pong = await probe.exchange("ping", {}, false, signal);
    if (!record(pong) || pong["type"] !== "pong" || !text(pong["version"])
      || !integer(pong["protocol"]) || !record(pong["capabilities"])
      || pong["capabilities"]["updater_restart_v1"] !== true
      || !hash(pong["capabilities"]["updater_restart_schema_sha256"]))
      throw new OperationFailure("unqualified_core");
    return new CoreOperationsClient(socketPath, { version: pong["version"], protocol: pong["protocol"],
      schemaSha256: pong["capabilities"]["updater_restart_schema_sha256"] });
  }
  get socketId(): string { return join(realpathSync(dirname(this.socketPath)), basename(this.socketPath)); }
  get coreIdentity(): CoreIdentity { return { ...this.identity }; }

  async request(request: RestartRequest, signal?: AbortSignal): Promise<RestartSnapshot> {
    if (this.inFlight) throw new OperationFailure("concurrent_request");
    this.inFlight = true;
    try {
      const pong = await this.exchange("ping", {}, false, signal);
      if (!record(pong) || pong["type"] !== "pong" || pong["version"] !== this.identity.version
        || pong["protocol"] !== this.identity.protocol || !record(pong["capabilities"])
        || pong["capabilities"]["updater_restart_v1"] !== true
        || pong["capabilities"]["updater_restart_schema_sha256"] !== this.identity.schemaSha256)
        throw new OperationFailure("unqualified_core");
      const mutation = request.action !== "inspect" && request.action !== "result";
      const method = request.action === "launch" ? "updater.native.launch.v1" : RESTART_METHOD;
      if (request.action === "launch" && pong["capabilities"]["updater_native_launch_v1"] !== true)
        throw new OperationFailure("unsupported_launch");
      const response = await this.exchange(method, request, mutation, signal);
      if (!record(response) || response["type"] !== "updater_restart")
        throw new OperationFailure("malformed_restart", mutation);
      let snapshot: RestartSnapshot;
      try { snapshot = parseRestart(response["snapshot"]); }
      catch (error) {
        if (!(error instanceof OperationFailure)) throw error;
        throw new OperationFailure(error.code, mutation);
      }
      const pane = "pane_id" in request ? request.pane_id
        : "expected_binding" in request ? request.expected_binding.pane_id : undefined;
      if ((request.action !== "inspect" && snapshot.receipt !== null
        && snapshot.receipt.operation_id !== request.operation_id)
        || (pane !== undefined && snapshot.binding !== null && snapshot.binding.pane_id !== pane)
        || (pane !== undefined && snapshot.receipt !== null && snapshot.receipt.pane_id !== pane))
        throw new OperationFailure("receipt_identity", mutation);
      return snapshot;
    } finally { this.inFlight = false; }
  }

  /** The owned WAL is only a wake-up source. Every observation is authenticated
   * through Result; no journal bytes or filesystem event confer effect authority.
   * No polling, no mutation retry, and wire timeout remains separate from work.
   */
  observeOperation(operationId: string, operationsPath: string, signal: AbortSignal, nodeExecutable?: string) {
    const metadata = lstatSync(operationsPath);
    if (realpathSync(operationsPath) !== operationsPath || !metadata.isFile() || metadata.nlink !== 1
      || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600)
      throw new OperationFailure("unsafe_operation_journal");
    const completed = Promise.withResolvers<RestartSnapshot>();
    const reader = new CoreOperationsClient(this.socketPath, this.identity);
    let closed = false, reading = false, dirty = false;
    const changed = async () => {
      if (closed) return;
      dirty = true;
      if (reading) return;
      reading = true;
      try {
        // Iterate only for a new observed write while a Result call was active.
        while (dirty && !closed) {
          dirty = false;
          const current = lstatSync(operationsPath);
          if (current.dev !== metadata.dev || current.ino !== metadata.ino
            || current.uid !== metadata.uid || (current.mode & 0o777) !== 0o600)
            throw new OperationFailure("operation_journal_changed");
          const result = await reader.request({ action: "result", operation_id: operationId }, signal);
          if (result.receipt && result.receipt.status !== "in_progress") {
            completed.resolve(result); close(); return;
          }
        }
      } catch (error) { completed.reject(error); close(); }
      finally { reading = false; }
    };
    const ready = Promise.withResolvers<void>();
    let stopWatcher: () => void;
    let joined: Promise<unknown> = Promise.resolve();
    if (nodeExecutable) {
      const node = Bun.spawn([nodeExecutable, "--input-type=commonjs", "--eval",
        'const fs=require("node:fs");const watcher=fs.watch(process.argv[1],()=>process.stdout.write("CHANGE\\n"));watcher.on("error",()=>process.exit(1));process.stdout.write("READY\\n");',
        operationsPath], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      stopWatcher = () => { if (node.exitCode === null) node.kill(); };
      const reading = (async () => {
        const decoder = new TextDecoder();
        let text = "";
        for await (const bytes of node.stdout) {
          text += decoder.decode(bytes, { stream: true });
          let newline: number;
          while ((newline = text.indexOf("\n")) >= 0) {
            const line = text.slice(0, newline); text = text.slice(newline + 1);
            if (line === "READY") ready.resolve();
            else if (line === "CHANGE") void changed();
            else throw new OperationFailure("operation_observer_protocol");
          }
        }
      })();
      joined = Promise.all([reading, node.exited]).then(() => {
        if (!closed) throw new OperationFailure("operation_observer_exited");
      });
      void joined.catch(error => { ready.reject(error); completed.reject(error); close(); });
    } else {
      const watcher = watch(operationsPath, () => { void changed(); });
      stopWatcher = () => watcher.close();
      watcher.on("error", error => { completed.reject(error); close(); });
      ready.resolve();
    }
    const abandon = () => {
      const error = new OperationFailure("observation_abandoned");
      ready.reject(error); completed.reject(error); close();
    };
    function close(): void {
      if (closed) return;
      closed = true; stopWatcher(); signal.removeEventListener("abort", abandon);
    }
    signal.addEventListener("abort", abandon, { once: true });
    if (signal.aborted) abandon();
    void completed.promise.catch(() => undefined);
    void ready.promise.catch(() => undefined);
    return { ready: ready.promise, completed: completed.promise, close: async () => { close(); await joined; } };
  }

  private async exchange(method: string, params: unknown, mutation: boolean, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new OperationFailure("abandoned");
    const metadata = await lstat(this.socketPath);
    if (signal?.aborted) throw new OperationFailure("abandoned");
    if (!this.socketPath.startsWith("/") || !metadata.isSocket() || metadata.isSymbolicLink()
      || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid?.())
      throw new OperationFailure("unsafe_socket");
    const id = randomUUID(), message = `${JSON.stringify({ id, method, params })}\n`;
    if (Buffer.byteLength(message) > 65536) throw new OperationFailure("request_too_large");
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let data = "", settled = false, sent = false;
      const finish = (code: string | null, value?: unknown): void => {
        if (settled) return;
        settled = true; socket.destroy(); signal?.removeEventListener("abort", abandon);
        if (code !== null) reject(new OperationFailure(code, mutation && sent)); else resolve(value);
      };
      const abandon = () => finish("abandoned");
      signal?.addEventListener("abort", abandon, { once: true });
      socket.setEncoding("utf8");
      socket.setTimeout(5000, () => finish("timeout"));
      socket.on("error", () => finish("unavailable"));
      socket.on("end", () => finish("partial_response"));
      socket.on("data", chunk => {
        data += chunk.toString("utf8");
        if (Buffer.byteLength(data) > 1_048_576) { finish("response_too_large"); return; }
        const end = data.indexOf("\n");
        if (end < 0) return;
        let response: unknown;
        try { response = JSON.parse(data.slice(0, end)); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          finish("malformed_json"); return;
        }
        if (!record(response) || response["id"] !== id) { finish("response_identity"); return; }
        if (response["error"] !== undefined) { finish("core_rejected"); return; }
        finish(null, response["result"]);
      });
      socket.once("connect", () => { sent = true; socket.write(message); });
    });
  }
}

export type RestartLifecycleConfiguration = {
  readonly operationsPath: string;
  readonly paneId: string;
  readonly runtimeId: string;
  /** Core-owned registered updated profile, never UI argv or shell text. */
  readonly profile: string;
  readonly installation: InstallationIdentity;
  readonly observeInstallation: () => InstallationIdentity;
  readonly workWaitMs?: number;
  readonly transitionWaitMs?: number;
  /** Owned Node runtime for event-driven WAL observation under Bun. */
  readonly observerNode?: string;
};

/** Native lifecycle bridge over the existing JSON client and owned operation WAL.
 * Construction inspects actual native authority before exposing eligibility.
 * Claim owns the native Freeze/Natural wait; inspect never reports work complete.
 */
export async function createRestartLifecyclePort(client: CoreOperationsClient, configuration: RestartLifecycleConfiguration) {
  const initial = await client.request({ action: "inspect", pane_id: configuration.paneId });
  if (!initial.binding || !initial.native_qualified || initial.recovery_required)
    throw new OperationFailure("unqualified_native");
  const original = structuredClone(initial.binding);
  const installation = structuredClone(configuration.installation);
  if (!["omo", "codex", "omp", "pi", "claude"].includes(installation.family) || !configuration.profile || !configuration.runtimeId)
    throw new OperationFailure("unsupported_family");
  const workWaitMs = configuration.workWaitMs;
  const transitionWaitMs = configuration.transitionWaitMs ?? 30_000;
  if (![...(workWaitMs === undefined ? [] : [workWaitMs]), transitionWaitMs]
    .every(value => Number.isSafeInteger(value) && value > 0 && value <= 1_800_000))
    throw new OperationFailure("invalid_deadline");
  function project(value: RestartBinding, fingerprint = installation.resourcesFingerprint): RuntimeBinding {
    return { socketId: `socket:${createHash("sha256").update(client.socketId).digest("hex")}`,
      socketEpoch: value.socket_epoch, paneId: value.pane_id, paneGeneration: value.generation,
      rootIncarnation: { pid: value.root.pid, startIdentity: `${value.root.pid}:${value.root.start_seconds}:${value.root.start_microseconds}`,
        executableRealpath: value.root.executable },
      session: { kind: "conversation", fullId: value.session.full_id, storagePathHash: value.session.storage_identity },
      cwd: value.session.cwd, optionsRef: `options:${value.session.options_sha256}`,
      turnGeneration: value.work_generation, resourcesFingerprint: fingerprint };
  }
  const runtime: Runtime = { runtimeId: configuration.runtimeId, installationId: installation.installationId,
    binding: project(original), runningVersion: installation.installedVersion };
  const selected: TargetSelection = { targetId: `target:${createHash("sha256").update(JSON.stringify([
    runtime.binding.socketId, runtime.runtimeId,
  ])).digest("hex")}`, runtimeId: runtime.runtimeId, installationId: runtime.installationId, expectedBinding: runtime.binding };
  if (!isTargetSelection(selected)) throw new OperationFailure("public_binding_unrepresentable");
  const selection = structuredClone(selected);
  const handles = new WeakMap<object, { readonly token: string; readonly binding: RestartBinding; current: RestartBinding }>();
  const completions = new WeakMap<TargetSelection, ReturnType<typeof Promise.withResolvers<AdapterResult<RuntimeBinding>>>>();
  const failure = <T>(): AdapterResult<T> => ({ ok: false, error: { code: "recovery_required" } });
  function exact(target: TargetSelection): void {
    if (!isDeepStrictEqual(target, selection)) throw new OperationFailure("stale_binding");
  }
  async function dispatch(request: RestartRequest, signal: AbortSignal, waitMs: number | undefined): Promise<RestartSnapshot> {
    if (signal.aborted) throw new OperationFailure("abandoned");
    if (request.action === "inspect") return client.request(request, signal);
    const observation = client.observeOperation(request.operation_id, configuration.operationsPath,
      waitMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(waitMs)]), configuration.observerNode);
    try {
      await observation.ready;
      let response: RestartSnapshot;
      try { response = await client.request(request, signal); }
      catch (error) {
        if (!(error instanceof OperationFailure) || !error.mayHaveExecuted) throw error;
        return await observation.completed;
      }
      if (response.receipt && response.receipt.status !== "in_progress") return response;
      return await observation.completed;
    } finally { await observation.close(); }
  }
  function checked(value: RestartSnapshot, operationId: string, action: "claim" | "stop" | "start" | "release"): RestartBinding {
    if (value.recovery_required || !value.native_qualified || !value.binding || !value.receipt
      || !value.receipt.native_qualified || value.receipt.operation_id !== operationId
      || value.receipt.action !== action || value.receipt.status !== "completed"
      || !isDeepStrictEqual(value.binding, value.receipt.binding)) throw new OperationFailure("unverified_effect");
    return value.binding;
  }
  const port: LifecyclePort = {
    subscribe(target, _signal) {
      exact(target);
      if (completions.has(target)) throw new OperationFailure("concurrent_subscription");
      const current = Promise.withResolvers<AdapterResult<RuntimeBinding>>();
      completions.set(target, current);
      return { completed: current.promise, close: () => { if (completions.get(target) === current) completions.delete(target); } };
    },
    async inspect(target, signal) {
      try {
        exact(target);
        const value = await client.request({ action: "inspect", pane_id: original.pane_id }, signal);
        if (!value.native_qualified || value.recovery_required || !isDeepStrictEqual(value.binding, original)) return failure();
        return { ok: true, value: { binding: runtime.binding, complete: false } };
      } catch { return failure(); }
    },
    async claim(target, operationId, signal) {
      const completion = completions.get(target);
      try {
        exact(target);
        if (!completion) throw new OperationFailure("subscription_required");
        const value = await dispatch({ action: "claim", operation_id: operationId, expected_binding: original }, signal, workWaitMs);
        const binding = checked(value, operationId, "claim");
        if (!value.owner_token || !isDeepStrictEqual(binding, original)) throw new OperationFailure("claim_identity");
        const handle = {};
        handles.set(handle, { token: value.owner_token, binding, current: binding });
        const identity = project(original);
        Object.freeze(identity.rootIncarnation); Object.freeze(identity.session); Object.freeze(identity);
        completion.resolve({ ok: true, value: identity });
        const claim: LifecycleClaim = Object.freeze({ binding: identity, profile: configuration.profile, handle });
        stoppedClaims.set(claim, { binding: identity, target: selection, signal, active: true, receipt: null });
        return { ok: true, value: claim };
      } catch { completion?.resolve(failure()); return failure(); }
    },
    async stop(claim, operationId, signal) {
      try {
        const owner = handles.get(claim.handle);
        const admitted = stoppedClaims.get(claim);
        if (!owner || !admitted?.active || admitted.receipt || !isDeepStrictEqual(claim.binding, project(original))
          || claim.profile !== configuration.profile) return failure();
        const value = await dispatch({ action: "stop", operation_id: operationId,
          expected_binding: owner.binding, owner_token: owner.token }, signal, transitionWaitMs);
        const binding = checked(value, operationId, "stop");
        if (!isDeepStrictEqual(binding, original)) return failure();
        const receipt: Receipt = Object.freeze({ kind: "completed", operationId, effect: "stopped", identity: admitted.binding });
        admitted.receipt = receipt;
        return { ok: true, value: receipt };
      } catch { return failure(); }
    },
    async start(claim, operationId, stopOperationId, signal) {
      try {
        const owner = handles.get(claim.handle);
        const admitted = stoppedClaims.get(claim);
        if (!owner || !admitted?.active || !admitted.receipt || admitted.receipt.operationId !== stopOperationId
          || claim.profile !== configuration.profile) return failure();
        admitted.active = false;
        const value = await dispatch({ action: "start", operation_id: operationId, stop_operation_id: stopOperationId,
          expected_binding: owner.binding, owner_token: owner.token, profile: configuration.profile }, signal, transitionWaitMs);
        const binding = checked(value, operationId, "start");
        if (!isDeepStrictEqual(binding.session, original.session) || !isDeepStrictEqual(binding.supervisor, original.supervisor)
          || binding.generation <= original.generation
          || (binding.root.pid === original.root.pid && binding.root.start_seconds === original.root.start_seconds
            && binding.root.start_microseconds === original.root.start_microseconds)) return failure();
        owner.current = binding;
        return { ok: true, value: { kind: "completed", operationId, effect: "started",
          identity: project(binding, configuration.observeInstallation().resourcesFingerprint) } };
      } catch { return failure(); }
    },
    async release(claim, binding, operationId, signal) {
      try {
        const owner = handles.get(claim.handle);
        if (!owner || !isDeepStrictEqual(binding, project(owner.current, binding.resourcesFingerprint))) return failure();
        const admitted = stoppedClaims.get(claim);
        if (!admitted) return failure();
        admitted.active = false;
        const value = await dispatch({ action: "release", operation_id: operationId,
          expected_binding: owner.current, owner_token: owner.token }, signal, transitionWaitMs);
        checked(value, operationId, "release");
        handles.delete(claim.handle);
        return { ok: true, value: null };
      } catch { return failure(); }
    },
    async result(operationId, signal) {
      try {
        const value = await client.request({ action: "result", operation_id: operationId }, signal);
        const receipt = value.receipt;
        if (!receipt) return { ok: true, value: { kind: "absent", operationId } };
        if (receipt.status !== "completed") return { ok: true, value: {
          kind: receipt.status === "in_progress" ? "in-progress" : "uncertain", operationId,
        } };
        if (value.recovery_required || !value.native_qualified || !receipt.native_qualified
          || !receipt.binding || !["stop", "start"].includes(receipt.action)) return failure();
        const effect = receipt.action === "stop" ? "stopped" : "started";
        const observed: Receipt = { kind: "completed", operationId, effect, identity: project(receipt.binding,
          effect === "stopped" ? installation.resourcesFingerprint : configuration.observeInstallation().resourcesFingerprint) };
        return { ok: true, value: observed };
      } catch { return failure(); }
    },
  };
  return { lifecycle: port, runtime, target: selected };
}
