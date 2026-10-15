import { timingSafeEqual } from "node:crypto";
import type { AdapterCapabilities, Capability } from "./adapters/types";

export const PROTOCOL_VERSION = 1 as const;
export const OPERATIONS = [
  "installations", "sessions", "runtimes", "jobs", "targets", "check",
  "create-job", "cancel-job", "inspect-job", "reconcile-job",
] as const;
export type Operation = (typeof OPERATIONS)[number];
export type Family = "omo" | "omp" | "pi" | "claude" | "codex" | "agy" | "cursor" | "grok";
/** Display observation only; no selection or lifecycle authority. */
export type DisplaySession = {
  readonly socketId: string;
  readonly paneId: string;
  readonly family: Family | null;
  readonly status: "working" | "idle" | "done" | "unknown";
  /** Whole-work evidence only; null means unverified, never inferred from idle. */
  readonly workComplete: boolean | null;
};
export type Mode = "update-only" | "update-and-restart";
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type FailureCode =
  | "malformed_request" | "unsupported_version" | "unauthorized"
  | "not_found" | "stale_selection" | "stale_binding" | "revision_conflict"
  | "request_conflict" | "unsupported" | "resources_busy" | "external_writer"
  | "cancel_unsafe" | "missing_session" | "identity_mismatch"
  | "update_failed" | "verification_failed" | "receipt_uncertain" | "recovery_required";
// Codes, not raw errors/argv, cross the public boundary.
export type Failure = { readonly code: FailureCode };
export type BoundaryFailure =
  | { readonly code: "malformed_request" }
  | { readonly code: "unsupported_version" }
  | { readonly code: "unauthorized" };
export type VersionEvidence =
  | { readonly kind: "known"; readonly version: string }
  | { readonly kind: "unknown"; readonly reason: "not_captured" | "probe_failed" };
export type InstallationOwner =
  | { readonly kind: "package"; readonly manager: "npm" | "bun" | "homebrew"; readonly packageName: string; readonly prefix: string }
  | { readonly kind: "native"; readonly installerDigest: string; readonly prefix: string }
  | { readonly kind: "wrapper"; readonly packageName: string; readonly engineResourceId: string; readonly prefix: string }
  | { readonly kind: "unknown"; readonly reason: "unverified_owner" };
export type InstallSelection = {
  readonly installationId: string;
  readonly resourcesFingerprint: string;
  readonly owner: InstallationOwner;
  readonly installedVersion: VersionEvidence;
};
export type Installation = InstallSelection & {
  readonly family: Family;
  readonly channel: string;
  readonly executableRealpath: string;
  readonly resources: readonly { readonly resourceId: string; readonly realpath: string; readonly fingerprint: string }[];
  readonly lastCheck: null | {
    readonly checkedAt: number;
    readonly result: CheckResult;
  };
};
export type SessionIdentity = {
  readonly kind: "file" | "conversation";
  readonly fullId: string;
  readonly storagePathHash: string;
};
export type RuntimeBinding = {
  readonly socketId: string;
  readonly socketEpoch: string;
  readonly paneId: string;
  readonly paneGeneration: number;
  readonly rootIncarnation: {
    readonly pid: number;
    readonly startIdentity: string;
    readonly executableRealpath: string;
  };
  readonly session: SessionIdentity;
  readonly cwd: string;
  // Opaque private-store reference; never secret argv/environment values.
  readonly optionsRef: string;
  readonly turnGeneration: number;
  readonly resourcesFingerprint: string;
};
export type Runtime = {
  // Local to binding.socketId, not globally unique across registered sockets.
  readonly runtimeId: string;
  readonly installationId: string;
  readonly binding: RuntimeBinding;
  readonly runningVersion: VersionEvidence;
};
export type TargetSelection = {
  readonly targetId: string;
  readonly runtimeId: string;
  readonly installationId: string;
  readonly expectedBinding: RuntimeBinding;
};
/** Display/selection eligibility, not private update or lifecycle authority. */
export type SelectionMetadata = {
  readonly installation: Installation;
  readonly update: AdapterCapabilities["update"];
  readonly readiness: Capability;
  readonly targets: readonly ({
    readonly target: TargetSelection;
    readonly runningVersion: VersionEvidence;
    readonly readiness: Capability;
  } & Pick<AdapterCapabilities, "completion" | "resume" | "gracefulExit">)[];
};
export type InstallState = "not_required" | "queued" | "waiting_resources" | "updating" | "verifying" | "succeeded" | "failed" | "recovery_required";
export type TargetState = "waiting_completion" | "claimed" | "stopping" | "exited" | "launching" | "verifying" | "completed" | "recovery_required" | "cancelled";
export type Receipt =
  | { readonly kind: "absent"; readonly operationId: string }
  | { readonly kind: "in-progress"; readonly operationId: string }
  | { readonly kind: "completed"; readonly operationId: string; readonly effect: "updated" | "stopped" | "started"; readonly identity: RuntimeBinding | null }
  | { readonly kind: "uncertain"; readonly operationId: string };
export type TargetTransaction = TargetSelection & {
  readonly state: TargetState;
  readonly receipt: Receipt | null;
  readonly failure: Failure | null;
};
export type InstallTransaction = {
  readonly selection: InstallSelection;
  readonly state: InstallState;
  readonly receipt: Receipt | null;
  readonly failure: Failure | null;
};
type JobBase = {
  readonly jobId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly selectedTargets: readonly TargetSelection[];
  readonly failure: Failure | null;
};
// Completed cannot describe an unverified install or a partial target result.
type JobOutcome =
  | {
    readonly status: "completed";
    readonly installTxn: InstallTransaction & { readonly state: "succeeded"; readonly failure: null };
    readonly targetTxns: readonly (TargetTransaction & { readonly state: "completed"; readonly failure: null })[];
    readonly failure: null;
  }
  | {
    readonly status: "queued" | "waiting" | "running" | "partial" | "failed" | "recovery_required" | "cancelled";
    readonly installTxn: InstallTransaction;
    readonly targetTxns: readonly TargetTransaction[];
  };
export type Job = (JobBase & JobOutcome & (
  | { readonly mode: "update-only"; readonly selectedTargets: readonly []; readonly targetTxns: readonly [] }
  | { readonly mode: "update-and-restart"; readonly selectedTargets: readonly [TargetSelection, ...TargetSelection[]] }
)) | (JobBase & {
  readonly mode: "restart-only";
  readonly selectedTargets: readonly [TargetSelection, ...TargetSelection[]];
  readonly installTxn: InstallTransaction & { readonly state: "not_required"; readonly receipt: null; readonly failure: null };
} & (
  | { readonly status: "completed"; readonly failure: null;
      readonly targetTxns: readonly (TargetTransaction & { readonly state: "completed"; readonly failure: null })[] }
  | { readonly status: Exclude<JobOutcome["status"], "completed">; readonly targetTxns: readonly TargetTransaction[] }
));
export type CheckResult =
  | { readonly kind: "up-to-date"; readonly installedVersion: string; readonly checkedAt: number }
  | { readonly kind: "update-available"; readonly installedVersion: string; readonly availableVersion: string; readonly checkedAt: number }
  | { readonly kind: "unavailable"; readonly failure: Failure; readonly checkedAt: number };
export type RecoveryTarget = {
  readonly target: TargetTransaction;
  readonly effect: "known" | "unknown";
  readonly lastIdentity: RuntimeBinding | null;
  readonly safeAction: "inspect" | "reconcile" | "confirm-verified-restore" | "none";
};
export type Inspection = { readonly job: Job; readonly targets: readonly RecoveryTarget[] };

type RequestEnvelope = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  // Ephemeral authentication only. Never persist a ServiceRequest.
  readonly token: string;
};
type RequestBody =
  | { readonly operation: "installations" }
  | { readonly operation: "sessions" }
  | { readonly operation: "runtimes" }
  | { readonly operation: "jobs" }
  | { readonly operation: "targets"; readonly installationId: string }
  | { readonly operation: "check"; readonly installationId: string }
  | {
    readonly operation: "create-job";
    readonly mode: "update-only";
    readonly installation: InstallSelection;
    readonly selectedTargets: readonly [];
  }
  | {
    readonly operation: "create-job";
    readonly mode: "update-and-restart";
    readonly installation: InstallSelection;
    readonly selectedTargets: readonly [TargetSelection, ...TargetSelection[]];
  }
  | {
    readonly operation: "create-job";
    readonly mode: "restart-only";
    readonly installation: InstallSelection;
    readonly selectedTargets: readonly [TargetSelection, ...TargetSelection[]];
  }
  | { readonly operation: "cancel-job"; readonly jobId: string; readonly expectedRevision: number }
  | { readonly operation: "reconcile-job"; readonly jobId: string; readonly expectedRevision: number }
  | { readonly operation: "inspect-job"; readonly jobId: string };
export type ServiceRequest = RequestEnvelope & RequestBody;
// Every operation has its own machine result. No generic record payload.
export type OperationResults = {
  readonly installations: { readonly installations: readonly Installation[] };
  readonly sessions: { readonly sessions: readonly DisplaySession[]; readonly unavailableSources: number };
  readonly runtimes: { readonly runtimes: readonly Runtime[] };
  readonly jobs: { readonly jobs: readonly Job[] };
  readonly targets: { readonly targets: readonly TargetSelection[]; readonly selection?: SelectionMetadata };
  readonly check: { readonly installationId: string; readonly result: CheckResult };
  readonly "create-job": { readonly kind: "created" | "existing"; readonly job: Job };
  readonly "cancel-job": { readonly kind: "cancelled"; readonly job: Job & { readonly status: "cancelled" } };
  readonly "inspect-job": Inspection;
  // Adoption is not an update/start retry or a claim of completion.
  readonly "reconcile-job": { readonly kind: "adopted" | "unchanged" | "recovery-required"; readonly inspection: Inspection };
};
export type ServiceResponse = {
  [O in Operation]: {
    readonly version: typeof PROTOCOL_VERSION;
    readonly requestId: string;
    readonly operation: O;
  } & (
    | { readonly ok: true; readonly result: OperationResults[O] }
    | { readonly ok: false; readonly error: Failure }
  )
}[Operation];
export type RejectedRequest = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly requestId: null;
  readonly ok: false;
  readonly error: BoundaryFailure;
};

// These structural helpers only inspect unknown JSON, never protocol records.
function object(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function keys(value: { readonly [key: string]: unknown }, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function path(value: unknown): value is string {
  return text(value) && value.startsWith("/");
}
function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function token(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function versionEvidence(value: unknown): value is VersionEvidence {
  if (!object(value)) return false;
  switch (value["kind"]) {
    case "known": return keys(value, ["kind", "version"]) && text(value["version"]);
    case "unknown": return keys(value, ["kind", "reason"])
      && (value["reason"] === "not_captured" || value["reason"] === "probe_failed");
    default: return false;
  }
}
function owner(value: unknown): value is InstallationOwner {
  if (!object(value)) return false;
  switch (value["kind"]) {
    case "package": return keys(value, ["kind", "manager", "packageName", "prefix"])
      && (value["manager"] === "npm" || value["manager"] === "bun" || value["manager"] === "homebrew")
      && text(value["packageName"]) && path(value["prefix"]);
    case "native": return keys(value, ["kind", "installerDigest", "prefix"])
      && id(value["installerDigest"]) && path(value["prefix"]);
    case "wrapper": return keys(value, ["kind", "packageName", "engineResourceId", "prefix"])
      && text(value["packageName"]) && id(value["engineResourceId"]) && path(value["prefix"]);
    case "unknown": return keys(value, ["kind", "reason"]) && value["reason"] === "unverified_owner";
    default: return false;
  }
}
export function isInstallSelection(value: unknown): value is InstallSelection {
  return object(value) && keys(value, ["installationId", "resourcesFingerprint", "owner", "installedVersion"])
    && id(value["installationId"]) && id(value["resourcesFingerprint"])
    && owner(value["owner"]) && versionEvidence(value["installedVersion"]);
}
export function isRuntimeBinding(value: unknown): value is RuntimeBinding {
  if (!object(value) || !keys(value, [
    "socketId", "socketEpoch", "paneId", "paneGeneration", "rootIncarnation",
    "session", "cwd", "optionsRef", "turnGeneration", "resourcesFingerprint",
  ])) return false;
  const root = value["rootIncarnation"];
  const session = value["session"];
  return id(value["socketId"]) && id(value["socketEpoch"]) && id(value["paneId"])
    && counter(value["paneGeneration"]) && counter(value["turnGeneration"])
    && path(value["cwd"]) && id(value["optionsRef"]) && id(value["resourcesFingerprint"])
    && object(root) && keys(root, ["pid", "startIdentity", "executableRealpath"])
    && counter(root["pid"]) && root["pid"] > 0 && id(root["startIdentity"]) && path(root["executableRealpath"])
    && object(session) && keys(session, ["kind", "fullId", "storagePathHash"])
    && (session["kind"] === "file" ? path(session["fullId"]) : session["kind"] === "conversation" && id(session["fullId"]))
    && id(session["storagePathHash"]);
}
export function isTargetSelection(value: unknown): value is TargetSelection {
  return object(value) && keys(value, ["targetId", "runtimeId", "installationId", "expectedBinding"])
    && id(value["targetId"]) && id(value["runtimeId"]) && id(value["installationId"])
    && isRuntimeBinding(value["expectedBinding"]);
}
function operation(value: unknown): value is Operation {
  return typeof value === "string" && OPERATIONS.some(candidate => candidate === value);
}
function unreachable(value: never): never {
  throw new TypeError(`Unreachable operation: ${value}`);
}
function request(value: unknown): value is ServiceRequest {
  if (!object(value) || value["version"] !== PROTOCOL_VERSION || !id(value["requestId"])
    || !token(value["token"]) || !operation(value["operation"])) return false;
  const envelope = ["version", "requestId", "token", "operation"];
  const op = value["operation"];
  switch (op) {
    case "installations":
    case "sessions":
    case "runtimes":
    case "jobs": return keys(value, envelope);
    case "targets":
    case "check": return keys(value, [...envelope, "installationId"]) && id(value["installationId"]);
    case "inspect-job": return keys(value, [...envelope, "jobId"]) && id(value["jobId"]);
    case "cancel-job":
    case "reconcile-job": return keys(value, [...envelope, "jobId", "expectedRevision"])
      && id(value["jobId"]) && counter(value["expectedRevision"]);
    case "create-job": {
      const installation = value["installation"];
      if (!keys(value, [...envelope, "mode", "installation", "selectedTargets"])
        || !isInstallSelection(installation)) return false;
      const targets: unknown = value["selectedTargets"];
      if (!Array.isArray(targets) || !targets.every(isTargetSelection)) return false;
      if (!targets.every(target => target.installationId === installation.installationId)
        || new Set(targets.map(target => target.targetId)).size !== targets.length
        || new Set(targets.map(target => `${target.expectedBinding.socketId}/${target.runtimeId}`)).size !== targets.length
        || new Set(targets.map(target => `${target.expectedBinding.socketId}/${target.expectedBinding.paneId}`)).size !== targets.length
        // Epoch is a snapshot, never a way to select one physical socket twice.
        || new Set(targets.map(target => target.expectedBinding.socketId)).size
          !== new Set(targets.map(target => `${target.expectedBinding.socketId}/${target.expectedBinding.socketEpoch}`)).size) return false;
      switch (value["mode"]) {
        case "update-only": return targets.length === 0;
        case "update-and-restart": case "restart-only": return targets.length > 0;
        default: return false;
      }
    }
    default: return unreachable(op);
  }
}

/** Service entry: parsed unknown JSON in, authenticated typed request or safe code out.
 * No dispatch, persistence, process operations, or logging occurs here.
 * Revision/fingerprint freshness must be compared by the authoritative worker.
 */
export function validateRequest(value: unknown, expectedToken: string): Result<ServiceRequest, BoundaryFailure> {
  if (!object(value) || !counter(value["version"])) return { ok: false, error: { code: "malformed_request" } };
  if (value["version"] !== PROTOCOL_VERSION) return { ok: false, error: { code: "unsupported_version" } };
  if (!request(value)) return { ok: false, error: { code: "malformed_request" } };
  if (!token(expectedToken) || !timingSafeEqual(Buffer.from(value.token), Buffer.from(expectedToken))) {
    return { ok: false, error: { code: "unauthorized" } };
  }
  return { ok: true, value };
}
