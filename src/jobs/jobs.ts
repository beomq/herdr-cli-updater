import { isInstallSelection, isRuntimeBinding, isTargetSelection } from "../protocol";
import type { Failure, InstallSelection, InstallState, InstallTransaction, Job, Receipt, TargetSelection, TargetState, TargetTransaction } from "../protocol";

// allow: SIZE_OK — task23 fixes this file's ownership to the indivisible job state machine and its persistence boundary.
export class JobError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "request_conflict" | "revision_conflict"
    | "invalid_transition" | "cancel_unsafe" | "receipt_mismatch" | "resources_busy"
    | "unsafe_path" | "storage_failure" | "corrupt_store") {
    super(code);
    this.name = "JobError";
  }
}
type Selection = {
  readonly jobId: string;
  readonly requestId: string;
  readonly installation: InstallSelection;
};
export type NewJob = Selection & (
  | { readonly mode: "update-only"; readonly selectedTargets: readonly [] }
  | { readonly mode: "update-and-restart"; readonly selectedTargets: readonly [TargetSelection, ...TargetSelection[]] }
  | { readonly mode: "restart-only"; readonly selectedTargets: readonly [TargetSelection, ...TargetSelection[]] }
);
export type Intent =
  | { readonly kind: "intent"; readonly operationId: string; readonly effect: "updated"; readonly targetId: null }
  | { readonly kind: "intent"; readonly operationId: string; readonly effect: "stopped" | "started"; readonly targetId: string };
export type JobChange =
  | Intent
  | { readonly kind: "wait-resources" }
  | { readonly kind: "claim"; readonly targetId: string }
  | { readonly kind: "observe"; readonly targetId: string | null; readonly receipt: Receipt }
  | { readonly kind: "verify-install" }
  | { readonly kind: "verify-target"; readonly targetId: string }
  | { readonly kind: "fail-install" }
  | { readonly kind: "recover" }
  | { readonly kind: "cancel" };
export type JobRecord = {
  readonly spec: NewJob;
  readonly revision: number;
  readonly cancelled: boolean;
  readonly install: InstallTransaction;
  readonly targets: readonly TargetTransaction[];
};

function unreachable(_value: never): never { throw new JobError("invalid_input"); }
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
export function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
export function parseNewJob(value: unknown): NewJob {
  if (!record(value) || !exact(value, ["jobId", "requestId", "installation", "mode", "selectedTargets"])
    || !identifier(value["jobId"]) || !identifier(value["requestId"]) || !isInstallSelection(value["installation"])) {
    throw new JobError("invalid_input");
  }
  const installation = value["installation"];
  const targets: unknown = value["selectedTargets"];
  if (!Array.isArray(targets) || !targets.every(isTargetSelection)
    || targets.some(target => target.installationId !== installation.installationId)
    || new Set(targets.map(target => target.targetId)).size !== targets.length
    || new Set(targets.map(target => canonical([target.expectedBinding.socketId, target.runtimeId]))).size !== targets.length
    || new Set(targets.map(target => canonical([target.expectedBinding.socketId, target.expectedBinding.socketEpoch]))).size
      !== new Set(targets.map(target => target.expectedBinding.socketId)).size
    || new Set(targets.map(target => canonical([target.expectedBinding.socketId, target.expectedBinding.paneId]))).size !== targets.length) {
    throw new JobError("invalid_input");
  }
  const base = { jobId: value["jobId"], requestId: value["requestId"], installation: value["installation"] };
  switch (value["mode"]) {
    case "update-only":
      if (targets.length !== 0) throw new JobError("invalid_input");
      return { ...base, mode: "update-only", selectedTargets: [] };
    case "update-and-restart": case "restart-only": {
      const sorted = [...targets].sort((a, b) => a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0);
      const first = sorted[0];
      if (!first) throw new JobError("invalid_input");
      return { ...base, mode: value["mode"], selectedTargets: [first, ...sorted.slice(1)] };
    }
    default: throw new JobError("invalid_input");
  }
}
/** Stable semantic comparison, independent of object insertion order. No secret-bearing request envelope. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new JobError("invalid_input");
  return encoded;
}
export function isReceipt(value: unknown): value is Receipt {
  if (!record(value) || !identifier(value["operationId"])) return false;
  switch (value["kind"]) {
    case "absent": case "in-progress": case "uncertain": return exact(value, ["kind", "operationId"]);
    case "completed": return exact(value, ["kind", "operationId", "effect", "identity"])
      && (value["effect"] === "updated" || value["effect"] === "stopped" || value["effect"] === "started")
      && (value["identity"] === null || isRuntimeBinding(value["identity"]));
    default: return false;
  }
}
export function parseChange(value: unknown): JobChange {
  if (!record(value)) throw new JobError("invalid_input");
  switch (value["kind"]) {
    case "wait-resources": case "verify-install": case "fail-install": case "recover": case "cancel":
      if (exact(value, ["kind"])) return { kind: value["kind"] };
      break;
    case "claim": case "verify-target":
      if (exact(value, ["kind", "targetId"]) && identifier(value["targetId"])) return { kind: value["kind"], targetId: value["targetId"] };
      break;
    case "intent":
      if (!exact(value, ["kind", "operationId", "effect", "targetId"]) || !identifier(value["operationId"])) break;
      if (value["effect"] === "updated" && value["targetId"] === null) return { kind: "intent", operationId: value["operationId"], effect: "updated", targetId: null };
      if ((value["effect"] === "stopped" || value["effect"] === "started") && identifier(value["targetId"])) {
        return { kind: "intent", operationId: value["operationId"], effect: value["effect"], targetId: value["targetId"] };
      }
      break;
    case "observe":
      if (exact(value, ["kind", "targetId", "receipt"]) && (value["targetId"] === null || identifier(value["targetId"])) && isReceipt(value["receipt"])) {
        return { kind: "observe", targetId: value["targetId"], receipt: value["receipt"] };
      }
      break;
  }
  throw new JobError("invalid_input");
}
export function initialJob(spec: NewJob): JobRecord {
  return { spec, revision: 0, cancelled: false,
    install: { selection: spec.installation, state: spec.mode === "restart-only" ? "not_required" : "queued", receipt: null, failure: null },
    targets: spec.selectedTargets.map(target => ({ ...target, state: "waiting_completion", receipt: null, failure: null })) };
}
function installState(value: unknown): value is InstallState {
  return ["not_required", "queued", "waiting_resources", "updating", "verifying", "succeeded", "failed", "recovery_required"].some(state => state === value);
}
function targetState(value: unknown): value is TargetState {
  return ["waiting_completion", "claimed", "stopping", "exited", "launching", "verifying", "completed", "recovery_required", "cancelled"].some(state => state === value);
}
function failure(value: unknown): value is { readonly code: "update_failed" | "receipt_uncertain" } | null {
  return value === null || (record(value) && exact(value, ["code"]) && (value["code"] === "update_failed" || value["code"] === "receipt_uncertain"));
}
export function decodeJob(text: string): JobRecord {
  const value: unknown = JSON.parse(text);
  if (!record(value) || !exact(value, ["spec", "revision", "cancelled", "install", "targets"])
    || !Number.isSafeInteger(value["revision"]) || typeof value["revision"] !== "number" || value["revision"] < 0
    || typeof value["cancelled"] !== "boolean") throw new JobError("corrupt_store");
  const spec = parseNewJob(value["spec"]);
  const install = value["install"];
  if (!record(install) || !exact(install, ["selection", "state", "receipt", "failure"])
    || !isInstallSelection(install["selection"]) || canonical(install["selection"]) !== canonical(spec.installation)
    || !installState(install["state"]) || !(install["receipt"] === null || isReceipt(install["receipt"]))
    || !failure(install["failure"])
    || (spec.mode === "restart-only"
      ? install["state"] !== "not_required" || install["receipt"] !== null || install["failure"] !== null
      : install["state"] === "not_required")) throw new JobError("corrupt_store");
  const raw: unknown = value["targets"];
  if (!Array.isArray(raw) || raw.length !== spec.selectedTargets.length) throw new JobError("corrupt_store");
  const targets = raw.map((target: unknown, index): TargetTransaction => {
    if (!record(target) || !exact(target, ["targetId", "runtimeId", "installationId", "expectedBinding", "state", "receipt", "failure"])
      || !targetState(target["state"]) || !(target["receipt"] === null || isReceipt(target["receipt"])) || !failure(target["failure"])) {
      throw new JobError("corrupt_store");
    }
    const selection = { targetId: target["targetId"], runtimeId: target["runtimeId"], installationId: target["installationId"], expectedBinding: target["expectedBinding"] };
    if (!isTargetSelection(selection) || canonical(selection) !== canonical(spec.selectedTargets[index])) throw new JobError("corrupt_store");
    return { ...selection, state: target["state"], receipt: target["receipt"], failure: target["failure"] };
  });
  return { spec, revision: value["revision"], cancelled: value["cancelled"],
    install: { selection: install["selection"], state: install["state"], receipt: install["receipt"], failure: install["failure"] }, targets };
}
function targetAt(job: JobRecord, targetId: string): TargetTransaction {
  const target = job.targets.find(candidate => candidate.targetId === targetId);
  if (!target) throw new JobError("not_found");
  return target;
}
function replaceTarget(job: JobRecord, target: TargetTransaction): JobRecord {
  return { ...job, targets: job.targets.map(old => old.targetId === target.targetId ? target : old) };
}
function requireState(condition: boolean): void {
  if (!condition) throw new JobError("invalid_transition");
}
/** Receipt authenticity, fence ownership, version/provenance and process absence are CALLER trust boundaries.
 * This reducer only checks stored operation correlation and exact-resume identity invariants; it executes nothing.
 */
export function transition(job: JobRecord, change: JobChange): JobRecord {
  requireState(!job.cancelled && viewJob(job).status !== "completed");
  let next: JobRecord;
  switch (change.kind) {
    case "cancel":
      if (job.install.receipt !== null || job.targets.some(target => target.receipt !== null)
        || !["not_required", "queued", "waiting_resources"].includes(job.install.state)
        || job.targets.some(target => !["waiting_completion", "claimed"].includes(target.state))) throw new JobError("cancel_unsafe");
      next = { ...job, cancelled: true, targets: job.targets.map(target => ({ ...target, state: "cancelled" })) };
      break;
    case "wait-resources":
      requireState(job.install.state === "queued");
      next = { ...job, install: { ...job.install, state: "waiting_resources" } };
      break;
    case "claim": {
      const target = targetAt(job, change.targetId);
      requireState(target.state === "waiting_completion" && ["not_required", "queued", "waiting_resources"].includes(job.install.state));
      next = replaceTarget(job, { ...target, state: "claimed" });
      break;
    }
    case "intent": {
      const receipt: Receipt = { kind: "uncertain", operationId: change.operationId };
      switch (change.effect) {
        case "updated":
          requireState(["queued", "waiting_resources"].includes(job.install.state) && job.install.receipt === null
            && job.targets.every(target => target.state === "exited"));
          next = { ...job, install: { ...job.install, state: "updating", receipt } };
          break;
        case "stopped": case "started": {
          const target = targetAt(job, change.targetId);
          requireState(change.effect === "stopped"
            ? target.state === "claimed" && target.receipt === null && ["not_required", "queued", "waiting_resources"].includes(job.install.state)
            : target.state === "exited" && ["not_required", "succeeded"].includes(job.install.state));
          next = replaceTarget(job, { ...target, state: change.effect === "stopped" ? "stopping" : "launching", receipt });
          break;
        }
        default: return unreachable(change);
      }
      break;
    }
    case "observe": {
      const current = change.targetId === null ? job.install : targetAt(job, change.targetId);
      if (!current.receipt || current.receipt.operationId !== change.receipt.operationId
        || current.receipt.kind === "completed") throw new JobError("receipt_mismatch");
      switch (change.receipt.kind) {
        case "absent": case "in-progress": case "uncertain":
          next = change.targetId === null
            ? { ...job, install: { ...job.install, state: "recovery_required", receipt: { kind: "uncertain", operationId: change.receipt.operationId }, failure: { code: "receipt_uncertain" } } }
            : replaceTarget(job, { ...targetAt(job, change.targetId), state: "recovery_required", receipt: { kind: "uncertain", operationId: change.receipt.operationId }, failure: { code: "receipt_uncertain" } });
          break;
        case "completed": {
          // The store additionally compares effect to the immutable intent ledger, including after recovery.
          if (change.targetId === null) {
            if (change.receipt.effect !== "updated" || change.receipt.identity !== null) throw new JobError("receipt_mismatch");
            next = { ...job, install: { ...job.install, state: "verifying", receipt: change.receipt, failure: null } };
          } else {
            const target = targetAt(job, change.targetId);
            const old = target.expectedBinding;
            const identity = change.receipt.identity;
            if (!identity || change.receipt.effect === "updated") throw new JobError("receipt_mismatch");
            if (change.receipt.effect === "stopped" ? canonical(identity) !== canonical(old)
              : identity.socketId !== old.socketId || identity.socketEpoch !== old.socketEpoch || identity.paneId !== old.paneId
                || identity.paneGeneration <= old.paneGeneration || canonical(identity.session) !== canonical(old.session)
                || identity.cwd !== old.cwd || identity.optionsRef !== old.optionsRef
                || identity.rootIncarnation.executableRealpath !== old.rootIncarnation.executableRealpath
                || identity.turnGeneration < old.turnGeneration
                || identity.rootIncarnation.startIdentity === old.rootIncarnation.startIdentity) throw new JobError("receipt_mismatch");
            next = replaceTarget(job, { ...target, state: change.receipt.effect === "stopped" ? "exited" : "verifying", receipt: change.receipt, failure: null });
          }
          break;
        }
        default: return unreachable(change.receipt);
      }
      break;
    }
    case "verify-install":
      requireState(job.install.state === "verifying" && job.install.receipt?.kind === "completed" && job.install.receipt.effect === "updated");
      next = { ...job, install: { ...job.install, state: "succeeded", failure: null } };
      break;
    case "verify-target": {
      const target = targetAt(job, change.targetId);
      requireState(["not_required", "succeeded"].includes(job.install.state) && target.state === "verifying" && target.receipt?.kind === "completed" && target.receipt.effect === "started");
      next = replaceTarget(job, { ...target, state: "completed", failure: null });
      break;
    }
    case "fail-install":
      requireState(["updating", "verifying"].includes(job.install.state));
      next = { ...job, install: { ...job.install, state: "failed", failure: { code: "update_failed" } } };
      break;
    case "recover":
      requireState(job.spec.mode === "restart-only" || job.install.receipt !== null
        || job.targets.some(target => target.state !== "waiting_completion"));
      next = { ...job,
        install: ["not_required", "succeeded"].includes(job.install.state) ? job.install : { ...job.install, state: "recovery_required", failure: { code: "receipt_uncertain" } },
        targets: job.targets.map(target => target.state === "completed" ? target : { ...target, state: "recovery_required", failure: { code: "receipt_uncertain" } }) };
      break;
    default: return unreachable(change);
  }
  return { ...next, revision: job.revision + 1 };
}
export function viewJob(job: JobRecord): Job {
  const base = { jobId: job.spec.jobId, requestId: job.spec.requestId, revision: job.revision };
  const install = job.install;
  const completed = job.targets.filter((target): target is TargetTransaction & { readonly state: "completed"; readonly failure: null } =>
    target.state === "completed" && target.failure === null && target.receipt?.kind === "completed" && target.receipt.effect === "started");
  if (job.spec.mode === "restart-only") {
    if (install.state !== "not_required" || install.receipt !== null || install.failure !== null) throw new JobError("corrupt_store");
    const common = { ...base, mode: "restart-only", selectedTargets: job.spec.selectedTargets,
      installTxn: { ...install, state: "not_required", receipt: null, failure: null } } as const;
    if (!job.cancelled && completed.length === job.targets.length)
      return { ...common, status: "completed", failure: null, targetTxns: completed };
    const uncertain = job.targets.some(target => target.state === "recovery_required" || target.receipt?.kind === "uncertain");
    return { ...common, status: job.cancelled ? "cancelled" : uncertain ? "recovery_required"
      : job.targets.every(target => target.state === "waiting_completion") ? "queued" : "running",
      failure: uncertain ? { code: "receipt_uncertain" } : null, targetTxns: job.targets };
  }
  if (!job.cancelled && install.state === "succeeded" && install.failure === null
    && install.receipt?.kind === "completed" && install.receipt.effect === "updated" && completed.length === job.targets.length) {
    const outcome = { ...base, status: "completed", failure: null, installTxn: { ...install, state: "succeeded", failure: null } } as const;
    switch (job.spec.mode) {
      case "update-only": return { ...outcome, mode: "update-only", selectedTargets: [], targetTxns: [] };
      case "update-and-restart": return { ...outcome, mode: "update-and-restart", selectedTargets: job.spec.selectedTargets, targetTxns: completed };
      default: return unreachable(job.spec);
    }
  }
  const uncertain = install.state === "recovery_required" || install.receipt?.kind === "uncertain"
    || job.targets.some(target => target.state === "recovery_required" || target.receipt?.kind === "uncertain");
  const status = job.cancelled ? "cancelled" : uncertain ? "recovery_required" : install.state === "failed" ? "failed"
    : install.state === "succeeded" ? "partial" : install.state === "queued" && job.targets.every(target => target.state === "waiting_completion") ? "queued"
    : install.state === "waiting_resources" ? "waiting" : "running";
  const jobFailure: Failure | null = uncertain ? { code: "receipt_uncertain" } : install.failure;
  const outcome = { ...base, status, failure: jobFailure, installTxn: install } as const;
  switch (job.spec.mode) {
    case "update-only": return { ...outcome, mode: "update-only", selectedTargets: [], targetTxns: [] };
    case "update-and-restart": return { ...outcome, mode: "update-and-restart", selectedTargets: job.spec.selectedTargets, targetTxns: job.targets };
    default: return unreachable(job.spec);
  }
}
