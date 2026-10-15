import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isCapability } from "../adapters/types";
import { JobError, parseNewJob } from "../jobs/jobs";
import { isInstallSelection, isRuntimeBinding, isTargetSelection, OPERATIONS, validateRequest } from "../protocol";
import type { Operation, ServiceRequest, ServiceResponse } from "../protocol";
import { connectPrivateSocket, TransportError } from "./socket";
import type { SocketEvent } from "./socket";
import { attachWorker, defaultWorkerDirectory, discoverWorker } from "./worker";

// allow: SIZE_OK — registered single-file ownership keeps full wire admission and
// its authenticated connection owner together; no shared DTO/source edits allowed.
type Body<T> = T extends ServiceRequest ? Omit<T, "version" | "token" | "requestId"> : never;
export type DomainRequest = Body<ServiceRequest>;
export type DomainResponse<O extends Operation> = Extract<ServiceResponse, { readonly operation: O }>;
export type EventCursor = { readonly incarnation: string; readonly sequence: number };
export type LiveEventCursor = { readonly incarnation: string; readonly sequence: "current" };
export class ClientError extends Error {
  constructor(readonly code: "closed" | "timeout" | "protocol" | "identity_mismatch" | "invalid_request"
    | "unauthorized" | "unsupported_version" | "malformed_request" | "overflow" | "listener_failed") {
    super(code);
    this.name = "ClientError";
  }
}
type Check = (value: unknown) => boolean;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function shape(value: unknown, fields: Readonly<Record<string, Check>>): boolean {
  return object(value) && Object.keys(value).length === Object.keys(fields).length
    && Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
}
const text: Check = v => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v);
const id: Check = v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const path: Check = v => typeof v === "string" && text(v) && v.startsWith("/");
const counter: Check = v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nil: Check = v => v === null;
const oneOf = (...values: readonly string[]): Check => v => typeof v === "string" && values.includes(v);
const array = (check: Check): Check => v => Array.isArray(v) && v.every(check);
const nullable = (check: Check): Check => v => v === null || check(v);
const failureCodes = [
  "malformed_request", "unsupported_version", "unauthorized", "not_found", "stale_selection", "stale_binding",
  "revision_conflict", "request_conflict", "unsupported", "resources_busy", "external_writer", "cancel_unsafe",
  "missing_session", "identity_mismatch", "update_failed", "verification_failed", "receipt_uncertain", "recovery_required",
] as const;
const failure: Check = v => shape(v, { code: oneOf(...failureCodes) });
const version: Check = v => shape(v, { kind: oneOf("known"), version: text })
  || shape(v, { kind: oneOf("unknown"), reason: oneOf("not_captured", "probe_failed") });
const owner: Check = v => isInstallSelection({ installationId: "probe", resourcesFingerprint: "probe",
  installedVersion: { kind: "unknown", reason: "not_captured" }, owner: v });
const selectionFields = { installationId: id, resourcesFingerprint: id, owner, installedVersion: version };
const targetFields = { targetId: id, runtimeId: id, installationId: id, expectedBinding: isRuntimeBinding };
const checkResult: Check = v =>
  shape(v, { kind: oneOf("up-to-date"), installedVersion: text, checkedAt: counter })
  || shape(v, { kind: oneOf("update-available"), installedVersion: text, availableVersion: text, checkedAt: counter })
  || shape(v, { kind: oneOf("unavailable"), failure, checkedAt: counter });
const installation: Check = v => shape(v, {
  ...selectionFields, family: oneOf("omo", "omp", "pi", "claude", "codex", "agy", "cursor", "grok"),
  channel: text, executableRealpath: path,
  resources: array(v => shape(v, { resourceId: id, realpath: path, fingerprint: id })),
  lastCheck: nullable(v => shape(v, { checkedAt: counter, result: checkResult })),
});
const runtime: Check = v => shape(v, {
  runtimeId: id, installationId: id, binding: isRuntimeBinding, runningVersion: version,
});
const selectionMetadata: Check = v => {
  if (!shape(v, {
    installation, update: isCapability, readiness: isCapability,
    targets: array(row => shape(row, { target: isTargetSelection, runningVersion: version,
      readiness: isCapability, completion: isCapability, resume: isCapability, gracefulExit: isCapability })),
  }) || !object(v)) return false;
  const selected = v["installation"], rows = v["targets"];
  return object(selected) && Array.isArray(rows) && rows.every((row: unknown) => object(row) && object(row["target"])
    && row["target"]["installationId"] === selected["installationId"]);
};
const receipt: Check = v =>
  shape(v, { kind: oneOf("absent", "in-progress", "uncertain"), operationId: id })
  || shape(v, { kind: oneOf("completed"), operationId: id, effect: oneOf("updated", "stopped", "started"),
    identity: nullable(isRuntimeBinding) });
const installTxn: Check = v => shape(v, {
  selection: isInstallSelection, state: oneOf("not_required", "queued", "waiting_resources", "updating", "verifying", "succeeded", "failed", "recovery_required"),
  receipt: nullable(receipt), failure: nullable(failure),
});
const targetTxn: Check = v => shape(v, {
  ...targetFields, state: oneOf("waiting_completion", "claimed", "stopping", "exited", "launching", "verifying", "completed", "recovery_required", "cancelled"),
  receipt: nullable(receipt), failure: nullable(failure),
});
const job: Check = v => {
  if (!shape(v, { jobId: id, requestId: id, revision: counter, selectedTargets: array(isTargetSelection),
    failure: nullable(failure), status: oneOf("completed", "queued", "waiting", "running", "partial", "failed", "recovery_required", "cancelled"),
    installTxn, targetTxns: array(targetTxn), mode: oneOf("update-only", "update-and-restart", "restart-only") }) || !object(v)) return false;
  const selected = v["selectedTargets"];
  const transactions = v["targetTxns"];
  const install = v["installTxn"];
  if (!Array.isArray(selected) || !Array.isArray(transactions) || !object(install)) return false;
  // Reuse the authoritative selection/uniqueness rules, but never replace the
  // admitted DTO with parseNewJob's sorted projection.
  try {
    parseNewJob({ jobId: v["jobId"], requestId: v["requestId"], mode: v["mode"],
      installation: install["selection"], selectedTargets: selected });
  } catch (error) {
    if (error instanceof JobError) return false;
    throw error;
  }
  if (selected.length !== transactions.length || !transactions.every((t: unknown, index) => object(t)
    && isDeepStrictEqual({ targetId: t["targetId"], runtimeId: t["runtimeId"], installationId: t["installationId"],
      expectedBinding: t["expectedBinding"] }, selected[index]))) return false;
  if (v["mode"] === "restart-only"
    ? install["state"] !== "not_required" || install["receipt"] !== null || install["failure"] !== null
    : install["state"] === "not_required") return false;
  return v["status"] !== "completed" || (v["failure"] === null
    && (v["mode"] === "restart-only" || (install["state"] === "succeeded"
      && install["failure"] === null && object(install["receipt"]) && install["receipt"]["kind"] === "completed"
      && install["receipt"]["effect"] === "updated" && install["receipt"]["identity"] === null))
    && transactions.every((t: unknown) => object(t) && t["state"] === "completed" && t["failure"] === null
      && object(t["receipt"]) && t["receipt"]["kind"] === "completed" && t["receipt"]["effect"] === "started"
      && isRuntimeBinding(t["receipt"]["identity"])));
};
const inspection: Check = v => shape(v, { job, targets: array(v => shape(v, {
  target: targetTxn, effect: oneOf("known", "unknown"), lastIdentity: nullable(isRuntimeBinding),
  safeAction: oneOf("inspect", "reconcile", "confirm-verified-restore", "none"),
})) });
const results: Readonly<Record<Operation, Check>> = {
  installations: v => shape(v, { installations: array(installation) }),
  sessions: v => shape(v, {
    sessions: array(row => shape(row, { socketId: text, paneId: text,
      family: nullable(oneOf("omo", "omp", "pi", "claude", "codex", "agy", "cursor", "grok")),
      status: oneOf("working", "idle", "done", "unknown"), workComplete: nullable(v => typeof v === "boolean") })),
    unavailableSources: counter,
  }) && object(v) && Array.isArray(v["sessions"])
    && new Set(v["sessions"].map((row: unknown) => object(row)
      ? JSON.stringify([row["socketId"], row["paneId"]]) : null)).size === v["sessions"].length,
  runtimes: v => shape(v, { runtimes: array(runtime) }),
  jobs: v => shape(v, { jobs: array(job) }),
  targets: v => shape(v, { targets: array(isTargetSelection) })
    || (shape(v, { targets: array(isTargetSelection), selection: selectionMetadata }) && object(v)
      && object(v["selection"]) && Array.isArray(v["selection"]["targets"])
      && isDeepStrictEqual(v["targets"], v["selection"]["targets"].map((row: unknown) => object(row) ? row["target"] : null))),
  check: v => shape(v, { installationId: id, result: checkResult }),
  "create-job": v => shape(v, { kind: oneOf("created", "existing"), job }),
  "cancel-job": v => shape(v, { kind: oneOf("cancelled"),
    job: v => job(v) && object(v) && v["status"] === "cancelled" }),
  "inspect-job": inspection,
  "reconcile-job": v => shape(v, { kind: oneOf("adopted", "unchanged", "recovery-required"), inspection }),
};
/** Exact full-v1 admission; rejects extra fields instead of casting wire JSON. */
export function isServiceResponse(value: unknown): value is ServiceResponse {
  if (!object(value) || typeof value["operation"] !== "string") return false;
  const operation = OPERATIONS.find(op => op === value["operation"]);
  if (!operation) return false;
  const envelope = { version: (v: unknown) => v === 1, requestId: id, operation: oneOf(operation) };
  return shape(value, { ...envelope, ok: v => v === false, error: failure })
    || shape(value, { ...envelope, ok: v => v === true, result: results[operation] });
}
function correlated<O extends Operation>(value: unknown, operation: O, requestId: string): value is DomainResponse<O> {
  return isServiceResponse(value) && value.operation === operation && value.requestId === requestId;
}
function event(value: unknown): value is SocketEvent {
  return shape(value, { kind: oneOf("event"), incarnation: id, sequence: counter, response: isServiceResponse });
}
function safeError(error: unknown): ClientError {
  if (error instanceof ClientError) return error;
  if (error instanceof TransportError && error.code === "overflow") return new ClientError("overflow");
  if (error instanceof TransportError && error.code === "protocol") return new ClientError("protocol");
  return new ClientError("closed");
}
function admitBoundary(value: unknown): never {
  if (object(value) && shape(value, { version: v => v === 1, requestId: nil, ok: v => v === false,
    error: v => shape(v, { code: oneOf("unauthorized", "unsupported_version", "malformed_request") }) })
    && object(value["error"])) {
    switch (value["error"]["code"]) {
      case "unauthorized": throw new ClientError("unauthorized");
      case "unsupported_version": throw new ClientError("unsupported_version");
      case "malformed_request": throw new ClientError("malformed_request");
    }
  }
  throw new ClientError("protocol");
}
async function bounded<T>(work: Promise<T>, timeoutMs: number, expire: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new ClientError("timeout")); expire(); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
export type EventListener = {
  readonly event: (event: SocketEvent) => void;
  readonly error: (error: ClientError) => void;
};
export type WorkerSubscription = {
  readonly cursor: EventCursor;
  readonly closed: Promise<void>;
  readonly close: () => void;
};
export type WorkerAttachment = {
  readonly incarnation: string;
  readonly request: <B extends DomainRequest>(body: B, requestId?: string) => Promise<DomainResponse<B["operation"]>>;
  readonly subscribe: (cursor: EventCursor | LiveEventCursor, listener: EventListener) => Promise<WorkerSubscription>;
  readonly close: () => void;
};

/** Concrete default: authenticates the discovered worker, never acquires ownership. */
export async function attachAuthenticatedWorker(directory = defaultWorkerDirectory, timeoutMs = 5000): Promise<WorkerAttachment> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new ClientError("invalid_request");
  let raw: Awaited<ReturnType<typeof attachWorker>>;
  let token: string;
  try {
    const expected = discoverWorker(directory);
    const pending = attachWorker(directory);
    let expired = false;
    void pending.then(value => { if (expired) value.close(); }, () => undefined);
    raw = await bounded(pending, timeoutMs, () => { expired = true; });
    try {
      const actual = discoverWorker(directory);
      if (JSON.stringify(expected) !== JSON.stringify(raw.owner) || JSON.stringify(expected) !== JSON.stringify(actual))
        throw new ClientError("identity_mismatch");
      for (const file of [raw.owner.tokenPath, raw.owner.socketPath]) {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
          throw new ClientError("identity_mismatch");
      }
      token = readFileSync(raw.owner.tokenPath, "utf8");
      if (!/^[a-f0-9]{64}$/.test(token)) throw new ClientError("identity_mismatch");
    } catch (error) { raw.close(); throw error; }
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError("identity_mismatch");
  }
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let pendingRequests = 0;
  const streams = new Set<() => void>();
  function close(): void {
    if (closed) return;
    closed = true;
    raw.close();
    for (const dispose of streams) dispose();
    streams.clear();
  }
  function containsToken(value: unknown): boolean { return JSON.stringify(value)?.includes(token) === true; }
  function wire(body: DomainRequest, requestId: string = randomUUID()): ServiceRequest {
    if (!object(body) || ["version", "token", "requestId"].some(key => Object.hasOwn(body, key)))
      throw new ClientError("invalid_request");
    const input = { ...body, version: 1, token, requestId };
    const validated = validateRequest(input, token);
    if (!validated.ok || containsToken(body) || requestId.includes(token)) throw new ClientError("invalid_request");
    return validated.value;
  }
  function request<B extends DomainRequest>(body: B, requestId?: string): Promise<DomainResponse<B["operation"]>> {
    // Snapshot and admit before queueing: caller mutation cannot alter the command.
    let input: ServiceRequest;
    try { input = wire(JSON.parse(JSON.stringify(body)), requestId); }
    catch (error) { return Promise.reject(error instanceof ClientError ? error : new ClientError("invalid_request")); }
    const operation: B["operation"] = body.operation;
    if (closed) return Promise.reject(new ClientError("closed"));
    if (pendingRequests >= 64) return Promise.reject(new ClientError("overflow"));
    pendingRequests++;
    const work = tail.then(async () => {
      if (closed) throw new ClientError("closed");
      try {
        // Own rejection before send: a synchronous overflow can close/reject
        // this waiter without ever reaching the await below.
        const reply = raw.client.next().then(value => ({ ok: true, value } as const),
          error => ({ ok: false, error } as const));
        raw.client.send(input);
        const outcome = await reply;
        if (!outcome.ok) throw outcome.error;
        const value = outcome.value;
        if (containsToken(value)) throw new ClientError("protocol");
        if (!correlated<B["operation"]>(value, operation, input.requestId)) admitBoundary(value);
        return value;
      } catch (error) { close(); throw safeError(error); }
    });
    tail = work.then(() => undefined, () => undefined);
    return bounded(work, timeoutMs, close).finally(() => { pendingRequests--; });
  }
  async function subscribe(cursor: EventCursor | LiveEventCursor, listener: EventListener): Promise<WorkerSubscription> {
    if (closed) throw new ClientError("closed");
    if (!shape(cursor, { incarnation: id, sequence: v => counter(v) || v === "current" }) || cursor.incarnation !== raw.owner.incarnation)
      throw new ClientError("identity_mismatch");
    let current: EventCursor = { incarnation: cursor.incarnation, sequence: cursor.sequence === "current" ? 0 : cursor.sequence };
    const controller = new AbortController();
    const abort = () => controller.abort();
    streams.add(abort);
    let client: Awaited<ReturnType<typeof connectPrivateSocket>>;
    try {
      client = await bounded((async () => {
        const connected = await connectPrivateSocket(raw.owner.socketPath, controller.signal);
        try {
          const ready = connected.next().then(value => ({ ok: true, value } as const),
            error => ({ ok: false, error } as const));
          connected.send({ kind: "subscribe", request: wire({ operation: "jobs" }),
            incarnation: current.incarnation, afterSequence: cursor.sequence });
          const outcome = await ready;
          if (!outcome.ok) throw outcome.error;
          const ack = outcome.value;
          if (!shape(ack, { kind: oneOf("subscribed"), incarnation: v => v === current.incarnation,
            sequence: v => counter(v) && (cursor.sequence === "current" || v === current.sequence) })) admitBoundary(ack);
          if (!object(ack) || typeof ack["sequence"] !== "number") throw new ClientError("protocol");
          current = { incarnation: current.incarnation, sequence: ack["sequence"] };
          return connected;
        } catch (error) { connected.close(); throw error; }
      })(), timeoutMs, abort);
      if (closed) { client.close(); throw new ClientError("closed"); }
    } catch (error) { abort(); streams.delete(abort); throw safeError(error); }
    let disposed = false;
    const done = Promise.withResolvers<void>();
    function dispose(): void {
      if (disposed) return;
      disposed = true;
      client.close();
      controller.abort();
      streams.delete(dispose);
      done.resolve();
    }
    streams.delete(abort);
    streams.add(dispose);
    void (async () => {
      try {
        while (!disposed) {
          const value = await client.next();
          if (disposed) return;
          if (!event(value) || containsToken(value) || value.incarnation !== current.incarnation
            || !Number.isSafeInteger(current.sequence + 1) || value.sequence !== current.sequence + 1)
            throw new ClientError("protocol");
          current = { incarnation: value.incarnation, sequence: value.sequence };
          try { listener.event(value); } catch { throw new ClientError("listener_failed"); }
        }
      } catch (error) {
        if (!disposed) {
          dispose();
          // Listener failures cannot leak raw exceptions or become unhandled.
          try { listener.error(safeError(error)); } catch { /* Listener is already retired. */ }
        }
      } finally { dispose(); }
    })();
    return { get cursor() { return { ...current }; }, closed: done.promise, close: dispose };
  }
  return { incarnation: raw.owner.incarnation, request, subscribe, close };
}
