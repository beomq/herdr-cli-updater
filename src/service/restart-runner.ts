import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setImmediate as yieldToIO } from "node:timers/promises";
import type { InstallationIdentity } from "../adapters/types";
import { verifyResourceFingerprint } from "../install/resources";
import { QueueError } from "../install/queue";
import type { MutationOwnership, MutationQueue } from "../install/queue";
import { canonical, initialJob, JobError, viewJob } from "../jobs/jobs";
import type { JobChange, NewJob } from "../jobs/jobs";
import type { JobStore } from "../jobs/store";
import type { FailureCode, Installation, Job, Runtime, SelectionMetadata, ServiceRequest, ServiceResponse, TargetSelection, TargetTransaction } from "../protocol";
import type { LifecyclePort, UpdateOnlyRunnerConfiguration } from "./job-runner";
import { responseFits } from "./socket";

/** Re-read the retained source and compose a NEW native port for each selection
 * or request. Never transplant a new binding into an old process-local claim. */
export type RestartSource = {
  readonly installationId: string;
  readonly read: (signal: AbortSignal) => Promise<{
    readonly installation: InstallationIdentity;
    readonly runtime: Runtime;
    readonly target: TargetSelection;
    readonly lifecycle: LifecyclePort;
    readonly evidenceRef: string;
    readonly fence: () => void;
    readonly observe: () => InstallationIdentity;
  }>;
};
type Qualified = Awaited<ReturnType<RestartSource["read"]>>;
type Configuration = {
  readonly store: JobStore;
  readonly queue: MutationQueue;
  readonly directory: string;
  readonly sources: readonly RestartSource[];
  readonly publication: UpdateOnlyRunnerConfiguration["publication"];
  readonly alive: (signal: AbortSignal) => void;
};
export class RestartError extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const failureCode = (error: unknown): FailureCode => error instanceof RestartError || error instanceof QueueError ? error.code
  : error instanceof JobError && ["resources_busy", "request_conflict", "revision_conflict", "not_found"].includes(error.code)
    ? error.code === "resources_busy" ? "resources_busy" : error.code === "request_conflict" ? "request_conflict"
      : error.code === "not_found" ? "not_found" : "revision_conflict"
    : "recovery_required";

export function createRestartRunner(configuration: Configuration) {
  const { store, publication, alive } = configuration;
  if (new Set(configuration.sources.map(source => source.installationId)).size !== configuration.sources.length)
    throw new RestartError("verification_failed");
  const active = new Set<Promise<void>>();
  function current(source: Qualified, signal: AbortSignal) {
    alive(signal); source.fence();
    const verified = verifyResourceFingerprint(source.installation, source.observe());
    if (!verified.ok) throw new RestartError(verified.error.code);
    source.fence(); alive(signal);
  }
  function event(job: Job, requestId: string): ServiceResponse {
    const targets: readonly TargetTransaction[] = job.targetTxns;
    return { version: 1, requestId, operation: "inspect-job", ok: true, result: { job,
      targets: targets.map(target => ({ target, effect: target.receipt?.kind === "completed" ? "known" : "unknown",
        lastIdentity: target.receipt?.kind === "completed" ? target.receipt.identity : null, safeAction: "inspect" })) } };
  }
  function change(job: Job, update: JobChange, signal: AbortSignal): Job {
    alive(signal);
    const sequence = publication.sequence;
    const result = store.change({ jobId: job.jobId, expectedRevision: job.revision }, update, next => {
      const response = event(next, job.requestId);
      if (!responseFits(response, true)) throw new RestartError("resources_busy");
      publication.admit(response); alive(signal);
      if (sequence !== publication.sequence) throw new RestartError("revision_conflict");
      return null;
    });
    alive(signal);
    if (sequence !== publication.sequence) throw new RestartError("revision_conflict");
    publication.publish(event(result.job, job.requestId));
    return result.job;
  }
  async function run(initial: Job, source: Qualified, signal: AbortSignal, ownership: MutationOwnership): Promise<void> {
    let job = initial;
    const selected = source.target, lifecycle = source.lifecycle;
    const reservation = configuration.queue.get(job.jobId);
    const operation = (stage: string) => `op-${hash(canonical([job.jobId, selected.targetId, stage]))}`;
    const check = () => {
      current(source, signal);
      if (store.get(job.jobId).revision !== job.revision) throw new RestartError("revision_conflict");
      const entry = configuration.queue.get(job.jobId);
      if (entry.revision !== reservation.revision || entry.operationId !== reservation.operationId
        || entry.state !== reservation.state) throw new RestartError("revision_conflict");
    };
    try {
      check();
      // Subscribe before inspect/claim so completion cannot race registration.
      const subscription = lifecycle.subscribe(selected, signal);
      void subscription.completed.catch(() => undefined);
      let claim;
      try {
        const observed = await lifecycle.inspect(selected, signal); check();
        if (!observed.ok) throw new RestartError(observed.error.code);
        if (!isDeepStrictEqual(observed.value.binding, selected.expectedBinding)) throw new RestartError("stale_binding");
        job = change(job, { kind: "claim", targetId: selected.targetId }, signal);
        const claimed = await lifecycle.claim(selected, operation("claim"), signal); check();
        if (!claimed.ok) throw new RestartError(claimed.error.code);
        claim = claimed.value;
        if (!claim.profile || !isDeepStrictEqual(claim.binding, selected.expectedBinding)) throw new RestartError("stale_binding");
        if (!observed.value.complete) {
          const completed = await subscription.completed; check();
          if (!completed.ok) throw new RestartError(completed.error.code);
          if (!isDeepStrictEqual(completed.value, selected.expectedBinding)) throw new RestartError("stale_binding");
        }
      } finally { subscription.close(); }
      check();
      const stopId = operation("stop");
      job = change(job, { kind: "intent", targetId: selected.targetId, effect: "stopped", operationId: stopId }, signal);
      const stopped = await lifecycle.stop(claim, stopId, signal); check();
      if (!stopped.ok) throw new RestartError(stopped.error.code);
      job = change(job, { kind: "observe", targetId: selected.targetId, receipt: stopped.value }, signal);
      if (stopped.value.kind !== "completed") throw new RestartError("receipt_uncertain");
      const startId = operation("start");
      job = change(job, { kind: "intent", targetId: selected.targetId, effect: "started", operationId: startId }, signal);
      const started = await lifecycle.start(claim, startId, stopId, signal); check();
      if (!started.ok) throw new RestartError(started.error.code);
      job = change(job, { kind: "observe", targetId: selected.targetId, receipt: started.value }, signal);
      if (started.value.kind !== "completed" || !started.value.identity) throw new RestartError("receipt_uncertain");
      if (started.value.identity.resourcesFingerprint !== source.installation.resourcesFingerprint)
        throw new RestartError("identity_mismatch");
      const released = await lifecycle.release(claim, started.value.identity, operation("release"), signal); check();
      if (!released.ok) throw new RestartError(released.error.code);
      configuration.queue.completeRestart(ownership, () => { check(); return source.observe(); });
      job = change(job, { kind: "verify-target", targetId: selected.targetId }, signal);
    } catch {
      // Unknown claim/stop/start/release retains the durable writer. There is no
      // compensating release or automatic retry after ambiguous delivery.
      if (!signal.aborted && store.get(job.jobId).revision === job.revision && job.status !== "cancelled") {
        change(job, { kind: "recover" }, signal);
      }
    }
  }
  return {
    async selection(installation: Installation, signal: AbortSignal): Promise<SelectionMetadata | undefined> {
      const found = configuration.sources.find(source => source.installationId === installation.installationId);
      if (!found) return undefined;
      const source = await found.read(signal); current(source, signal);
      const { lastCheck: _lastCheck, ...identity } = installation;
      if (!isDeepStrictEqual(identity, source.installation)) throw new RestartError("stale_selection");
      const supported = { kind: "supported", reason: "verified", evidenceRef: source.evidenceRef } as const;
      const verified = store.list().find(job => job.mode === "restart-only" && job.status === "completed"
        && job.installTxn.selection.resourcesFingerprint === source.installation.resourcesFingerprint
        && job.targetTxns.some(target => target.receipt?.kind === "completed"
          && isDeepStrictEqual(target.receipt.identity, source.target.expectedBinding)));
      return { installation, update: { kind: "unsupported", reason: "not_verified" }, readiness: supported,
        targets: [{ target: source.target, runningVersion: verified?.installTxn.selection.installedVersion ?? source.runtime.runningVersion, readiness: supported,
          completion: supported, resume: supported, gracefulExit: supported }] };
    },
    async create(request: Extract<ServiceRequest, { operation: "create-job" }>, signal: AbortSignal): Promise<ServiceResponse> {
      try {
        alive(signal);
        if (request.mode !== "restart-only" || request.selectedTargets.length !== 1) throw new RestartError("unsupported");
        const spec: NewJob = { jobId: `job:${hash(canonical([configuration.directory, request.requestId]))}`,
          requestId: request.requestId, mode: "restart-only", installation: request.installation, selectedTargets: request.selectedTargets };
        try {
          store.get(spec.jobId);
          return { version: 1, requestId: request.requestId, operation: "create-job", ok: true, result: store.create(spec) };
        } catch (error) { if (!(error instanceof JobError && error.code === "not_found")) throw error; }
        const found = configuration.sources.find(source => source.installationId === request.installation.installationId);
        if (!found) throw new RestartError("unsupported");
        const source = await found.read(signal); current(source, signal);
        const installed = source.installation;
        if (!isDeepStrictEqual(request.installation, { installationId: installed.installationId, owner: installed.owner,
          resourcesFingerprint: installed.resourcesFingerprint, installedVersion: installed.installedVersion }))
          throw new RestartError("stale_selection");
        if (!isDeepStrictEqual(request.selectedTargets, [source.target])) throw new RestartError("stale_binding");
        const response: ServiceResponse = { version: 1, requestId: request.requestId, operation: "create-job", ok: true,
          result: { kind: "created", job: viewJob(initialJob(spec)) } };
        const sequence = publication.sequence;
        if (!responseFits(response, true)) throw new RestartError("resources_busy");
        publication.admit(response); current(source, signal);
        if (sequence !== publication.sequence) throw new RestartError("revision_conflict");
        // Same FULL/WAL writer used by update intents; reserve before any claim.
        const created = store.create(spec);
        if (created.kind === "existing") return { ...response, result: created };
        let ownership: MutationOwnership;
        try {
          ownership = configuration.queue.reserveRestart({ jobId: created.job.jobId, installation: installed, target: source.target },
            () => { current(source, signal); return source.observe(); });
        } catch (error) {
          // No native operation has run. The shared queue refused admission.
          change(created.job, { kind: "cancel" }, signal);
          throw error;
        }
        const result: ServiceResponse = { ...response, result: created };
        publication.publish(result);
        if (created.kind === "created") {
          const task = yieldToIO().then(() => run(created.job, source, signal, ownership));
          active.add(task);
          void task.then(() => active.delete(task), () => active.delete(task));
        }
        return result;
      } catch (error) {
        return { version: 1, requestId: request.requestId, operation: "create-job", ok: false, error: { code: failureCode(error) } };
      }
    },
    async close() { await Promise.allSettled([...active]); },
  };
}
