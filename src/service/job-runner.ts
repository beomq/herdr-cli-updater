import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { isDeepStrictEqual, types } from "node:util";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { createOmoUpdateSpec, getPrivateUpdateIntent } from "../adapters/update-context";
import { createPackageUpdateSpec } from "../adapters/package-update";
import { createCursorUpdateSpec } from "../adapters/cursor-update";
import { createAgyUpdateSpec } from "../adapters/agy-update";
import type { UpdateFilePin } from "../adapters/update-context";
import type { AdapterContract, AdapterResult, FamilyAdapter, InstallationIdentity, UpdateSpec } from "../adapters/types";
import { consumeOmoUpdate } from "../install/update";
import { MutationQueue, QueueError } from "../install/queue";
import type { MutationOwnership, QueueEntry } from "../install/queue";
import { evaluateResourceGate, parseResourcePlan, verifyResourceFingerprint } from "../install/resources";
import type { NativeExitAdmission, ResourcePlan } from "../install/resources";
import { canonical, initialJob, JobError, viewJob } from "../jobs/jobs";
import type { JobChange, NewJob } from "../jobs/jobs";
import { JobStore } from "../jobs/store";
import type { FailureCode, Inspection, Installation, Job, Receipt, RuntimeBinding, SelectionMetadata, ServiceRequest, ServiceResponse, TargetSelection, TargetTransaction } from "../protocol";
import { responseFits } from "./socket";
import { discoverWorker } from "./worker";
import type { WorkerOwner } from "./worker";
import { createRestartRunner, RestartError } from "./restart-runner";
import type { RestartSource } from "./restart-runner";

/** Private owner composition, not a capability obtained from service JSON.
 * The concrete owner maps existing updater.restart.v1 and native ABI4 results.
 * Subscribe must install observation synchronously, before inspect can yield.
 * Claim/stop/start are single dispatches; result is read-only after uncertainty.
 */
export type LifecycleClaim = {
  readonly binding: RuntimeBinding;
  readonly profile: string;
  readonly handle: object;
};
export interface LifecyclePort {
  readonly subscribe: (target: TargetSelection, signal: AbortSignal) => {
    readonly completed: Promise<AdapterResult<RuntimeBinding>>;
    readonly close: () => void;
  };
  readonly inspect: (target: TargetSelection, signal: AbortSignal) =>
    Promise<AdapterResult<{ readonly binding: RuntimeBinding; readonly complete: boolean }>>;
  readonly claim: (target: TargetSelection, operationId: string, signal: AbortSignal) =>
    Promise<AdapterResult<LifecycleClaim>>;
  readonly stop: (claim: LifecycleClaim, operationId: string, signal: AbortSignal) => Promise<AdapterResult<Receipt>>;
  readonly start: (claim: LifecycleClaim, operationId: string, stopOperationId: string, signal: AbortSignal) => Promise<AdapterResult<Receipt>>;
  readonly release: (claim: LifecycleClaim, binding: RuntimeBinding, operationId: string, signal: AbortSignal) => Promise<AdapterResult<null>>;
  readonly result: (operationId: string, signal: AbortSignal) => Promise<AdapterResult<Receipt>>;
}

export type UpdateOnlyRunnerConfiguration = {
  readonly store: JobStore;
  readonly queue: MutationQueue;
  readonly owner: WorkerOwner;
  readonly receiptRoot: string;
  readonly now?: () => number;
  readonly lifecycle?: LifecyclePort;
  readonly restartSources?: readonly RestartSource[];
  readonly publication: {
    readonly sequence: number;
    readonly admit: (response: ServiceResponse) => null;
    readonly publish: (response: ServiceResponse) => void;
  };
  /** Private source-owner binding, never constructed from a service request.
   * Coverage readers need registered physical namespace/membership evidence.
   * Source-only check adapters and arbitrary callback receipts are insufficient.
   */
  readonly profile?: {
    readonly lifecycle?: LifecyclePort;
    readonly adapter: FamilyAdapter;
    readonly contract: AdapterContract;
    readonly sourcePins: readonly UpdateFilePin[];
    readonly expectedAfter: InstallationIdentity;
    readonly expectedAfterPin: UpdateFilePin;
    readonly observe: (plan: ResourcePlan) => unknown;
    readonly observeAfter: () => unknown;
    readonly mutationRoots?: readonly string[];
    /** Private discovery exclusions only; never a mutation-scope grant. */
    readonly catalogRoots?: readonly string[];
    readonly mutationScopeRoot?: string;
  };
  readonly profiles?: readonly NonNullable<UpdateOnlyRunnerConfiguration["profile"]>[];
};
class RunnerError extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
function pin(value: UpdateFilePin, capture = false): Buffer {
  const before = lstatSync(value.path);
  if (realpathSync(value.path) !== value.path || !before.isFile() || before.nlink !== 1
    || before.size > (capture ? 32 : 2048) * 1024 * 1024 || (before.mode & 0o022) !== 0)
    throw new RunnerError("verification_failed");
  const fd = openSync(value.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = capture ? readFileSync(fd) : Buffer.alloc(0);
    const digest = createHash("sha256"), chunk = Buffer.allocUnsafe(1024 * 1024);
    if (capture) digest.update(bytes);
    else for (let offset = 0; offset < before.size;) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (count === 0) throw new RunnerError("stale_selection");
      digest.update(chunk.subarray(0, count)); offset += count;
    }
    const after = fstatSync(fd), entry = lstatSync(value.path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || entry.dev !== before.dev || entry.ino !== before.ino || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || digest.digest("hex") !== value.sha256
      || realpathSync(value.path) !== value.path) throw new RunnerError("stale_selection");
    return bytes;
  } finally { closeSync(fd); }
}
function code(error: unknown): FailureCode {
  // Private callback throws, including Proxy payloads, are never inspected.
  if (types.isProxy(error) || !types.isNativeError(error)) return "recovery_required";
  const prototype = Object.getPrototypeOf(error);
  if (prototype === RunnerError.prototype || prototype === QueueError.prototype) {
    const value: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    const known: readonly FailureCode[] = ["malformed_request", "unauthorized", "verification_failed", "not_found",
      "request_conflict", "revision_conflict", "recovery_required", "cancel_unsafe", "resources_busy",
      "external_writer", "identity_mismatch", "unsupported", "stale_selection"];
    return known.find(candidate => candidate === value) ?? "recovery_required";
  }
  if (prototype === JobError.prototype) {
    const value: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    switch (value) {
      case "not_found": case "request_conflict": case "revision_conflict": case "resources_busy": case "cancel_unsafe": return value;
      case "invalid_input": return "malformed_request";
      case "invalid_transition": return "cancel_unsafe";
      default: return "recovery_required";
    }
  }
  return "recovery_required";
}
type Profile = NonNullable<UpdateOnlyRunnerConfiguration["profile"]>;
// Tickets retain live capabilities/revision expectations, never shadow Job DTOs.
type Ticket = {
  readonly requestId: string;
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly profile: Profile;
  readonly spec: UpdateSpec;
  readonly plan: ResourcePlan;
  revision: number;
  entry: QueueEntry | null;
  ownership: MutationOwnership | null;
  effectStarted: boolean;
  claim: LifecycleClaim | null;
  stopped: Receipt | null;
};

/** One real consumer composition. No startup executor, generic spawn seam or
 * implicit private profile. Separate queue/job commits can be uncertain, never
 * rolled back/replayed. The owner must supply serveWorker's lifetime signal;
 * a creator connection disappearing does not terminate or retry the updater.
 */
export function createUpdateOnlyJobRunner(configuration: UpdateOnlyRunnerConfiguration) {
  const { store, queue, receiptRoot, publication } = configuration;
  const owner = structuredClone(configuration.owner), clock = configuration.now ?? Date.now;
  const profiles: readonly Profile[] = [...(configuration.profile ? [configuration.profile] : []),
    ...(configuration.profiles ?? [])].map(source => ({
    ...source, contract: structuredClone(source.contract),
    sourcePins: source.sourcePins.map(row => ({ ...row })),
    expectedAfter: structuredClone(source.expectedAfter), expectedAfterPin: { ...source.expectedAfterPin },
  }));
  if (new Set(profiles.map(row => row.contract.installation.installationId)).size !== profiles.length)
    throw new RunnerError("verification_failed");
  const active = new Set<Promise<void>>();
  let closed = false;
  const restarts = createRestartRunner({ store, queue, directory: owner.directory,
    sources: configuration.restartSources ?? [], publication, alive });
  function alive(signal: AbortSignal): void {
    if (closed || signal.aborted || !isDeepStrictEqual(discoverWorker(owner.directory), owner))
      throw new RunnerError("resources_busy");
  }
  function sourceCurrent(value: Profile, signal: AbortSignal): void {
    alive(signal);
    if (value.sourcePins.length === 0 || value.adapter.family !== value.contract.family)
      throw new RunnerError("unsupported");
    for (const reference of value.sourcePins) pin(reference);
    const expected: unknown = JSON.parse(pin(value.expectedAfterPin, true).toString("utf8"));
    if (!isDeepStrictEqual(expected, value.expectedAfter)) throw new RunnerError("verification_failed");
    alive(signal);
  }
  function inspection(jobId: string): Inspection {
    const job = store.get(jobId);
    return inspectJob(job);
  }
  function inspectJob(job: Job): Inspection {
    const transactions: readonly TargetTransaction[] = job.targetTxns;
    return { job, targets: transactions.map(target => ({
      target, effect: target.receipt?.kind === "completed" ? "known" : "unknown",
      lastIdentity: target.receipt?.kind === "completed" ? target.receipt.identity : null,
      safeAction: "inspect",
    })) };
  }
  function failure(request: ServiceRequest, value: FailureCode): ServiceResponse {
    return { version: 1, requestId: request.requestId, operation: request.operation, ok: false, error: { code: value } };
  }
  function event(job: Job, requestId: string): ServiceResponse {
    return { version: 1, requestId, operation: "inspect-job", ok: true, result: inspectJob(job) };
  }
  function publish(response: ServiceResponse, signal: AbortSignal): void {
    alive(signal);
    const sequence = publication.sequence;
    if (!responseFits(response, true)) throw new RunnerError("resources_busy");
    publication.admit(response);
    alive(signal);
    if (publication.sequence !== sequence) throw new RunnerError("revision_conflict");
    publication.publish(response);
  }
  function change(jobId: string, revision: number, update: JobChange, requestId: string, signal: AbortSignal): Job {
    alive(signal);
    const sequence = publication.sequence;
    let response: ServiceResponse | undefined;
    const changed = store.change({ jobId, expectedRevision: revision }, update, job => {
      response = event(job, requestId);
      if (!responseFits(response, true)) throw new RunnerError("resources_busy");
      publication.admit(response);
      alive(signal);
      if (publication.sequence !== sequence) throw new RunnerError("revision_conflict");
      return null;
    });
    if (!response) throw new RunnerError("recovery_required");
    // No await separates synchronous admission, SQL commit and publication.
    alive(signal);
    if (publication.sequence !== sequence) throw new RunnerError("revision_conflict");
    publication.publish(response);
    return changed.job;
  }
  function current(ticket: Ticket): void {
    sourceCurrent(ticket.profile, ticket.signal);
    const job = store.get(ticket.jobId);
    if (job.revision !== ticket.revision || job.status === "cancelled") throw new RunnerError("revision_conflict");
    if (ticket.entry) {
      const entry = queue.get(ticket.jobId);
      if (entry.revision !== ticket.entry.revision || entry.operationId !== ticket.entry.operationId
        || entry.state !== ticket.entry.state) throw new RunnerError("revision_conflict");
    }
    if (ticket.ownership && (!ticket.entry?.operationId || job.installTxn.receipt?.operationId !== ticket.entry.operationId))
      throw new RunnerError("recovery_required");
  }
  function stageId(jobId: string, stage: "claim" | "stop" | "start" | "release", targetId: string): string {
    return `op-${hash(canonical([jobId, targetId, stage]))}`;
  }
  function target(value: Profile): TargetSelection | undefined {
    const runtime = value.contract.runtime;
    const lifecycle = value.lifecycle ?? configuration.lifecycle;
    if (!runtime || !lifecycle || ["completion", "gracefulExit", "resume"].some(key =>
      key === "completion" ? value.contract.capabilities.completion.kind !== "supported"
        : key === "gracefulExit" ? value.contract.capabilities.gracefulExit.kind !== "supported"
        : value.contract.capabilities.resume.kind !== "supported")) return undefined;
    return { targetId: `target:${hash(JSON.stringify([runtime.binding.socketId, runtime.runtimeId]))}`,
      runtimeId: runtime.runtimeId, installationId: runtime.installationId, expectedBinding: runtime.binding };
  }
  async function stopTarget(ticket: Ticket): Promise<void> {
    const selected = ticket.plan.selectedTargets[0];
    const lifecycle = ticket.profile.lifecycle ?? configuration.lifecycle;
    if (!selected || !lifecycle) throw new RunnerError("unsupported");
    const subscription = lifecycle.subscribe(selected, ticket.signal);
    // Own the rejection even if a ready inspect lets us close without awaiting.
    void subscription.completed.catch(() => undefined);
    try {
      const observed = await lifecycle.inspect(selected, ticket.signal);
      current(ticket);
      if (!observed.ok) throw new RunnerError(observed.error.code);
      if (!isDeepStrictEqual(observed.value.binding, selected.expectedBinding)) throw new RunnerError("stale_binding");
      // Native Claim atomically guards ingress while waiting for Natural/Frozen.
      // The observer is installed first; completion is never inferred from inspect.
      ticket.revision = change(ticket.jobId, ticket.revision,
        { kind: "claim", targetId: selected.targetId }, ticket.requestId, ticket.signal).revision;
      const claimed = await lifecycle.claim(selected, stageId(ticket.jobId, "claim", selected.targetId), ticket.signal);
      if (claimed.ok) ticket.claim = claimed.value;
      current(ticket);
      if (!claimed.ok) throw new RunnerError(claimed.error.code);
      if (!isDeepStrictEqual(claimed.value.binding, selected.expectedBinding) || !claimed.value.profile)
        throw new RunnerError("stale_binding");
      if (!observed.value.complete) {
        const completed = await subscription.completed;
        current(ticket);
        if (!completed.ok) throw new RunnerError(completed.error.code);
        if (!isDeepStrictEqual(completed.value, selected.expectedBinding)) throw new RunnerError("stale_binding");
      }
    } finally { subscription.close(); }
    // Freshness must still hold after potentially long work, before any stop.
    const intent = getPrivateUpdateIntent(ticket.spec);
    if (!intent.ok || !ticket.spec.execution) throw new RunnerError("verification_failed");
    if (ticket.spec.execution.kind !== "omo-official-update" || intent.value.family !== "omo")
      throw new RunnerError("unsupported");
    const fresh = createOmoUpdateSpec(ticket.spec.execution, { ...intent.value, family: "omo" }, clock());
    if (!fresh.ok) throw new RunnerError(fresh.error.code);
    current(ticket);
    const claimed = ticket.claim;
    if (!claimed) throw new RunnerError("recovery_required");
    const operationId = stageId(ticket.jobId, "stop", selected.targetId);
    ticket.revision = change(ticket.jobId, ticket.revision,
      { kind: "intent", targetId: selected.targetId, effect: "stopped", operationId }, ticket.requestId, ticket.signal).revision;
    const stopped = await lifecycle.stop(claimed, operationId, ticket.signal);
    current(ticket);
    if (!stopped.ok) throw new RunnerError(stopped.error.code);
    if (stopped.value.operationId !== operationId || (stopped.value.kind === "completed"
      && (stopped.value.effect !== "stopped" || !isDeepStrictEqual(stopped.value.identity, selected.expectedBinding))))
      throw new RunnerError("verification_failed");
    ticket.revision = change(ticket.jobId, ticket.revision,
      { kind: "observe", targetId: selected.targetId, receipt: stopped.value }, ticket.requestId, ticket.signal).revision;
    if (stopped.value.kind !== "completed") throw new RunnerError("receipt_uncertain");
    ticket.stopped = stopped.value;
  }
  async function startTarget(ticket: Ticket): Promise<void> {
    const selected = ticket.plan.selectedTargets[0], claim = ticket.claim;
    const lifecycle = ticket.profile.lifecycle ?? configuration.lifecycle;
    if (!selected || !claim || !lifecycle) throw new RunnerError("recovery_required");
    current(ticket);
    const operationId = stageId(ticket.jobId, "start", selected.targetId);
    ticket.revision = change(ticket.jobId, ticket.revision,
      { kind: "intent", targetId: selected.targetId, effect: "started", operationId }, ticket.requestId, ticket.signal).revision;
    const started = await lifecycle.start(claim, operationId, stageId(ticket.jobId, "stop", selected.targetId), ticket.signal);
    current(ticket);
    if (!started.ok) throw new RunnerError(started.error.code);
    const installed = verifyResourceFingerprint(ticket.profile.expectedAfter, ticket.profile.observeAfter());
    current(ticket);
    if (!installed.ok) throw new RunnerError(installed.error.code);
    if (started.value.operationId !== operationId || (started.value.kind === "completed" && started.value.effect !== "started"))
      throw new RunnerError("verification_failed");
    ticket.revision = change(ticket.jobId, ticket.revision,
      { kind: "observe", targetId: selected.targetId, receipt: started.value }, ticket.requestId, ticket.signal).revision;
    if (started.value.kind !== "completed" || !started.value.identity) throw new RunnerError("receipt_uncertain");
    const released = await lifecycle.release(claim, started.value.identity, stageId(ticket.jobId, "release", selected.targetId), ticket.signal);
    current(ticket);
    if (!released.ok) throw new RunnerError(released.error.code);
    const final = verifyResourceFingerprint(ticket.profile.expectedAfter, ticket.profile.observeAfter());
    current(ticket);
    if (!final.ok) throw new RunnerError(final.error.code);
    ticket.revision = change(ticket.jobId, ticket.revision,
      { kind: "verify-target", targetId: selected.targetId }, ticket.requestId, ticket.signal).revision;
  }
  async function run(ticket: Ticket): Promise<void> {
    try {
      current(ticket);
      if (ticket.plan.mode === "update-and-restart") await stopTarget(ticket);
      current(ticket);
      if (!ticket.entry) {
        const enqueued = queue.enqueue({ jobId: ticket.jobId, requestId: ticket.jobId, plan: ticket.plan });
        if (enqueued.kind !== "created" || enqueued.entry.jobId !== ticket.jobId) throw new RunnerError("recovery_required");
        ticket.entry = enqueued.entry;
      }
      const nativeExit: NativeExitAdmission | undefined = ticket.claim && ticket.stopped
        ? { jobId: ticket.jobId, claim: ticket.claim, receipt: ticket.stopped } : undefined;
      const ownership = queue.acquire(ticket.jobId, ticket.entry.revision, plan => {
        current(ticket);
        const observed = ticket.profile.observe(plan);
        current(ticket);
        return observed;
      }, nativeExit);
      ticket.ownership = ownership;
      ticket.entry = queue.get(ticket.jobId);
      const operationId = ticket.entry.operationId;
      if (!operationId) throw new RunnerError("recovery_required");
      // Both FULL/WAL commits precede registry/cache/installation mutations.
      ticket.revision = change(ticket.jobId, ticket.revision,
        { kind: "intent", operationId, effect: "updated", targetId: null }, ticket.requestId, ticket.signal).revision;
      current(ticket);
      const authenticated = getPrivateUpdateIntent(ticket.spec);
      if (!authenticated.ok || !ticket.spec.execution) throw new RunnerError("verification_failed");
      const issued = ticket.spec.execution.kind === "package-manager-update"
        ? createPackageUpdateSpec(ticket.spec.execution, { ...authenticated.value, operationId }, clock())
        : ticket.spec.execution.kind === "cursor-original-update"
          ? createCursorUpdateSpec(ticket.spec.execution, { ...authenticated.value, operationId }, clock())
        : ticket.spec.execution.kind === "agy-original-update"
          ? createAgyUpdateSpec(ticket.spec.execution, { ...authenticated.value, operationId }, clock())
        : createOmoUpdateSpec(ticket.spec.execution, { ...authenticated.value, family: "omo", operationId }, clock());
      if (!issued.ok) throw new RunnerError(issued.error.code);
      const bound = getPrivateUpdateIntent(issued.value);
      if (!bound.ok || bound.value.operationId !== operationId) throw new RunnerError("verification_failed");
      const observed = await consumeOmoUpdate(issued.value, {
        receiptRoot, signal: ticket.signal,
        now: () => {
          const now = clock();
          current(ticket);
          if (!ticket.effectStarted) {
            const gate = evaluateResourceGate(ticket.plan, ticket.profile.observe(ticket.plan), nativeExit);
            current(ticket);
            if (!gate.ok) throw new RunnerError(gate.error.code);
          }
          return now;
        },
        event: async receipt => {
          if (!isDeepStrictEqual(receipt.intent, bound.value)) throw new RunnerError("verification_failed");
          if (receipt.kind === "launched") ticket.effectStarted = true;
          current(ticket);
          // Native exit/notifications never fabricate protocol completed receipts.
          publish(event(store.get(ticket.jobId), ticket.requestId), ticket.signal);
          current(ticket);
        },
      });
      current(ticket); // Consumer's await can outlive any earlier data/publication lease.
      if (!observed.ok) throw new RunnerError(observed.error.code);
      if (observed.value.kind !== "files-verified" || !observed.value.durableReceipt
        || !isDeepStrictEqual(observed.value.intent, bound.value)) throw new RunnerError("recovery_required");
      const after = ticket.profile.observeAfter();
      current(ticket);
      const verified = verifyResourceFingerprint(ticket.profile.expectedAfter, after);
      if (!verified.ok) throw new RunnerError(verified.error.code);
      queue.complete(ownership, ticket.profile.expectedAfter, () => {
        current(ticket);
        const value = ticket.profile.observeAfter();
        current(ticket);
        return value;
      });
      // Queue release may commit before SQL settlement. A failed ACK never repeats effects.
      ticket.entry = queue.get(ticket.jobId);
      ticket.ownership = null;
      current(ticket);
      ticket.revision = change(ticket.jobId, ticket.revision, { kind: "observe", targetId: null,
        receipt: { kind: "completed", operationId, effect: "updated", identity: null } }, ticket.requestId, ticket.signal).revision;
      current(ticket);
      const final = verifyResourceFingerprint(ticket.profile.expectedAfter, ticket.profile.observeAfter());
      current(ticket);
      if (!final.ok) throw new RunnerError(final.error.code);
      ticket.revision = change(ticket.jobId, ticket.revision, { kind: "verify-install" }, ticket.requestId, ticket.signal).revision;
      if (ticket.plan.mode === "update-and-restart") await startTarget(ticket);
    } catch (error) {
      const failed = code(error);
      if (closed || ticket.signal.aborted) return;
      const job = store.get(ticket.jobId);
      const selected = ticket.plan.selectedTargets[0];
      const lifecycle = ticket.profile.lifecycle ?? configuration.lifecycle;
      if (ticket.claim && lifecycle && selected && job.targetTxns.every(target => target.receipt === null)
        && isDeepStrictEqual(ticket.claim.binding, selected.expectedBinding)) {
        // A proven claim with no stop intent can safely reopen ingress. Unknown
        // stop/start effects never enter this branch or gain another ticket.
        await lifecycle.release(ticket.claim, ticket.claim.binding,
          stageId(ticket.jobId, "release", selected.targetId), ticket.signal);
      }
      if (!closed && !ticket.signal.aborted && job.revision === ticket.revision && job.status !== "cancelled") {
        if (failed === "resources_busy" && !ticket.ownership && job.installTxn.state === "queued"
          && job.targetTxns.every(target => target.receipt === null && target.state === "waiting_completion")) {
          ticket.revision = change(ticket.jobId, ticket.revision, { kind: "wait-resources" }, ticket.requestId, ticket.signal).revision;
        } else if ((job.installTxn.receipt !== null || job.targetTxns.some(target => target.state !== "waiting_completion"))
          && job.status !== "completed") {
          ticket.revision = change(ticket.jobId, ticket.revision, { kind: "recover" }, ticket.requestId, ticket.signal).revision;
        }
      }
      // Reservation/journal remain intact on uncertain outcomes. No compensating grant.
    }
  }
  function start(ticket: Ticket): void {
    // Hand the committed create response back to transport before synchronous
    // source/resource verification starts. run() rechecks ownership and revision.
    const work = yieldToIO().then(() => run(ticket));
    active.add(work);
    void work.then(() => { active.delete(work); },
      () => { active.delete(work); });
  }
  async function handle(request: ServiceRequest, signal: AbortSignal): Promise<ServiceResponse> {
    try {
      alive(signal);
      switch (request.operation) {
        case "create-job": {
          if (request.mode === "restart-only") return restarts.create(request, signal);
          const profile = profiles.find(row => row.contract.installation.installationId === request.installation.installationId);
          if (request.mode === "update-and-restart" && request.selectedTargets.length !== 1) return failure(request, "unsupported");
          const jobId = `job:${hash(canonical([owner.directory, request.requestId]))}`;
          const selection = structuredClone(request.installation);
          const base = { jobId, requestId: request.requestId, installation: selection };
          const spec: NewJob = request.mode === "update-only"
            ? { ...base, mode: "update-only", selectedTargets: [] }
            : { ...base, mode: "update-and-restart", selectedTargets: structuredClone(request.selectedTargets) };
          let existing: Job | undefined;
          try { existing = store.get(jobId); }
          catch (error) { if (code(error) !== "not_found") throw error; }
          if (existing) {
            // Durable idempotency has no profile read, requalification or execution ticket.
            const found = store.create(spec);
            return { version: 1, requestId: request.requestId, operation: "create-job", ok: true, result: found };
          }
          if (!profile) return failure(request, "unsupported");
          sourceCurrent(profile, signal);
          if (request.mode === "update-and-restart") {
            const expected = target(profile);
            if (!expected) return failure(request, "unsupported");
            if (!isDeepStrictEqual(request.selectedTargets, [expected])) return failure(request, "stale_binding");
          }
          const installation = profile.contract.installation;
          if (!isDeepStrictEqual(selection, {
            installationId: installation.installationId, resourcesFingerprint: installation.resourcesFingerprint,
            owner: installation.owner, installedVersion: installation.installedVersion,
          })) return failure(request, "stale_selection");
          const checked = await profile.adapter.check(installation);
          sourceCurrent(profile, signal);
          if (!checked.ok) return failure(request, checked.error.code);
          if (checked.value.kind !== "update-available") return failure(request, "unsupported");
          const update = profile.adapter.updateSpec(installation, request.mode);
          sourceCurrent(profile, signal);
          if (!update.ok) return failure(request, update.error.code);
          const intent = getPrivateUpdateIntent(update.value);
          if (!intent.ok || intent.value.mode !== request.mode || !update.value.execution
            || !isDeepStrictEqual(update.value.expectedInstallation, installation)
            || profile.expectedAfter.installedVersion.kind !== "known"
            || profile.expectedAfter.installedVersion.version !== checked.value.availableVersion
            || !profile.sourcePins.some(row => row.sha256 === intent.value.managerDigest)
            || !profile.sourcePins.some(row => row.sha256 === intent.value.provenanceDigest)) return failure(request, "verification_failed");
          const plan = parseResourcePlan({ contract: profile.contract, mode: request.mode, selectedTargets: request.selectedTargets,
            mutationResources: update.value.mutationResources,
            installerDigest: installation.owner.kind === "native" ? installation.owner.installerDigest
              : hash(canonical([intent.value.managerDigest, intent.value.provenanceDigest, intent.value.targetFingerprint])),
            ...(profile.mutationRoots ? { transition: { expectedAfter: profile.expectedAfter,
              mutationRoots: profile.mutationRoots,
              ...(profile.mutationScopeRoot ? { scopeRoot: profile.mutationScopeRoot } : {}) } } : {}) });
          if (!plan.ok) return failure(request, plan.error.code);
          const initial: ServiceResponse = { version: 1, requestId: request.requestId, operation: "create-job",
            ok: true, result: { kind: "created", job: viewJob(initialJob(spec)) } };
          // No JobStore.create admission API: refuse before commit where possible.
          const sequence = publication.sequence;
          if (!responseFits(initial, true)) throw new RunnerError("resources_busy");
          publication.admit(initial);
          sourceCurrent(profile, signal);
          if (publication.sequence !== sequence) throw new RunnerError("revision_conflict");
          const created = store.create(spec);
          const response: ServiceResponse = { version: 1, requestId: request.requestId, operation: "create-job", ok: true, result: created };
          publish(response, signal);
          if (created.kind === "created") {
            const ticket: Ticket = { jobId, requestId: request.requestId, signal, profile, spec: update.value,
              plan: plan.value, revision: created.job.revision, entry: null, ownership: null, effectStarted: false,
              claim: null, stopped: null };
            start(ticket);
          }
          return response;
        }
        case "inspect-job":
          return { version: 1, requestId: request.requestId, operation: "inspect-job", ok: true, result: inspection(request.jobId) };
        case "cancel-job": {
          const before = inspection(request.jobId).job;
          if (before.revision !== request.expectedRevision) return failure(request, "revision_conflict");
          if (before.installTxn.receipt || before.targetTxns.some(target => target.receipt !== null || target.state !== "waiting_completion")
            || !["not_required", "queued", "waiting_resources"].includes(before.installTxn.state))
            return failure(request, "cancel_unsafe");
          let entry: QueueEntry | undefined;
          try { entry = queue.get(request.jobId); }
          catch (error) { if (code(error) !== "not_found") throw error; }
          if (entry && entry.state !== "queued" && entry.state !== "cancelled") return failure(request, "cancel_unsafe");
          if (entry?.state === "queued") queue.cancel(request.jobId, entry.revision);
          const cancelled = change(request.jobId, before.revision, { kind: "cancel" }, request.requestId, signal);
          if (cancelled.status !== "cancelled") return failure(request, "recovery_required");
          return { version: 1, requestId: request.requestId, operation: "cancel-job", ok: true,
            result: { kind: "cancelled", job: { ...cancelled, status: "cancelled" } } };
        }
        case "reconcile-job": {
          const currentJob = inspection(request.jobId);
          if (currentJob.job.revision !== request.expectedRevision) return failure(request, "revision_conflict");
          if (currentJob.job.mode === "restart-only") {
            // Never borrow a stale update profile or mint a new lifecycle owner
            // to reconcile an uncertain restart. This endpoint observes only.
            return { version: 1, requestId: request.requestId, operation: "reconcile-job", ok: true,
              result: { kind: currentJob.job.status === "completed" ? "unchanged" : "recovery-required", inspection: currentJob } };
          }
          const profile = profiles.find(row => row.contract.installation.installationId === currentJob.job.installTxn.selection.installationId);
          const lifecycle = profile?.lifecycle ?? (profile ? configuration.lifecycle : undefined);
          if (lifecycle && profile) for (const transaction of currentJob.job.targetTxns) {
            if (transaction.receipt && transaction.receipt.kind !== "completed") {
              const selected = currentJob.job.selectedTargets.find(row => row.targetId === transaction.targetId);
              if (!isDeepStrictEqual(selected, target(profile))) return failure(request, "stale_binding");
              const receipt = await lifecycle.result(transaction.receipt.operationId, signal);
              alive(signal);
              if (!receipt.ok) return failure(request, receipt.error.code);
              if (receipt.value.operationId !== transaction.receipt.operationId) return failure(request, "verification_failed");
              if (store.get(request.jobId).revision !== request.expectedRevision) return failure(request, "revision_conflict");
            }
          }
          let entry: QueueEntry | undefined;
          try { entry = queue.get(request.jobId); }
          catch (error) { if (code(error) !== "not_found") throw error; }
          const completed = currentJob.job.status === "completed" && entry?.state === "completed"
            && currentJob.job.installTxn.receipt?.kind === "completed"
            && currentJob.job.installTxn.receipt.operationId === entry.operationId;
          // Observe only. Existing/reopened jobs and uncertain intents cannot grant a retry.
          return { version: 1, requestId: request.requestId, operation: "reconcile-job", ok: true,
            result: { kind: completed ? "unchanged" : "recovery-required", inspection: currentJob } };
        }
        default: return failure(request, "unsupported");
      }
    } catch (error) { return failure(request, code(error)); }
  }
  return {
    handle,
    async selection(installation: Installation, signal: AbortSignal): Promise<AdapterResult<SelectionMetadata | undefined>> {
      try {
        const restart = await restarts.selection(installation, signal);
        if (restart) {
          const update = profiles.find(profile => profile.contract.installation.installationId === installation.installationId);
          return { ok: true, value: update ? { ...restart, update: update.contract.capabilities.update } : restart };
        }
        const profile = profiles.find(row => row.contract.installation.installationId === installation.installationId);
        if (!profile) return { ok: true, value: undefined };
        sourceCurrent(profile, signal);
        const { lastCheck: _lastCheck, ...identity } = installation;
        if (!isDeepStrictEqual(identity, profile.contract.installation)) return { ok: true, value: undefined };
        const selected = target(profile), runtime = profile.contract.runtime;
        const lifecycle = profile.lifecycle ?? configuration.lifecycle;
        if (selected && lifecycle) {
          const currentTarget = await lifecycle.inspect(selected, signal);
          sourceCurrent(profile, signal);
          if (!currentTarget.ok) return currentTarget;
          if (!isDeepStrictEqual(currentTarget.value.binding, selected.expectedBinding))
            return { ok: false, error: { code: "stale_binding" } };
        }
        const capabilities = profile.contract.capabilities;
        return { ok: true, value: { installation, update: capabilities.update, readiness: capabilities.update,
          targets: selected && runtime ? [{ target: selected, runningVersion: runtime.runningVersion,
            readiness: capabilities.resume, completion: capabilities.completion,
            gracefulExit: capabilities.gracefulExit, resume: capabilities.resume }] : [] } };
      } catch (error) { return { ok: false, error: { code: error instanceof RestartError ? error.code : code(error) } }; }
    },
    async close(): Promise<void> {
      closed = true; // Retire publication/SQL callback authority before any await.
      await restarts.close();
      await Promise.allSettled([...active]);
      // Store/queue belong to the caller. Unknown native observers retain journals.
    },
  };
}
