import { isInstallSelection, isRuntimeBinding, PROTOCOL_VERSION } from "../protocol";
import type {
  CheckResult, Failure, Family, Installation, Mode, Result, Runtime, RuntimeBinding,
  VersionEvidence,
} from "../protocol";

export const FAMILIES = ["omo", "omp", "pi", "claude", "codex", "agy", "cursor", "grok"] as const satisfies readonly Family[];
export type { Family, Mode } from "../protocol";
export type InstallationIdentity = Omit<Installation, "lastCheck">;
export type MutationResource = InstallationIdentity["resources"][number];
export type RuntimeIdentity = Runtime;

export type Capability =
  | { readonly kind: "supported"; readonly reason: "verified"; readonly evidenceRef: string }
  | {
    readonly kind: "unknown" | "missing" | "unsupported";
    readonly reason: "not_verified" | "not_installed" | "unverified_owner" | "shared_engine"
      | "missing_session" | "missing_bridge" | "unsafe_installer" | "provenance_unverified";
  };
export type BusySafetyProof = {
  readonly installerDigest: string;
  readonly resourcesFingerprint: string;
  readonly resourceIds: readonly string[];
  readonly allConsumersKnown: true;
};
export type BusySafeCapability =
  | Exclude<Capability, { readonly kind: "supported" }>
  | (Extract<Capability, { readonly kind: "supported" }> & { readonly proof: BusySafetyProof });
export type AdapterCapabilities = {
  readonly check: Capability;
  readonly update: Capability;
  readonly busySafe: BusySafeCapability;
  readonly completion: Capability;
  readonly resume: Capability;
  readonly gracefulExit: Capability;
};
export type AdapterContract = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly family: Family;
  readonly installation: InstallationIdentity;
  readonly runtime: RuntimeIdentity | null;
  readonly capabilities: AdapterCapabilities;
};

/** Argument vectors, never shell text. Secret options stay in core's private store.
 * Consumers must use direct spawn, not a shell or string concatenation.
 */
export type CommandSpec = {
  readonly executable: `/${string}`;
  readonly args: readonly string[];
  readonly cwd: `/${string}`;
};
export type ExactResumeSpec = {
  readonly command: CommandSpec;
  readonly expectedBinding: RuntimeBinding;
  readonly optionsRef: string;
};
export type UpdateSpec = {
  readonly command: CommandSpec;
  readonly mode: Mode;
  readonly expectedInstallation: InstallationIdentity;
  readonly mutationResources: readonly MutationResource[];
  /** Private, process-local strategy. When present, task22 MUST dispatch through
   * executePrivateUpdate, never spawn command directly. Legacy producers remain valid.
   * This is not a capability or a public/persistable DTO.
   */
  readonly execution?: PrivateUpdateContext;
};
/** Object identity is authenticated by update-context's private WeakMap.
 * Copying, JSON round trips and structural lookalikes confer no authority.
 */
export type PrivateUpdateContext =
  | { readonly kind: "omo-official-update" }
  | { readonly kind: "package-manager-update" }
  | { readonly kind: "cursor-original-update" }
  | { readonly kind: "agy-original-update" };
/** Static issuer-owned data. This describes a required process observation,
 * never a callback, command authority, or caller-provided success receipt. */
export type NativeUpdateCompletion = {
  readonly kind: "cursor-detached-cleanup";
  readonly executable: string;
  readonly args: readonly string[];
  readonly home: string;
};
export type PrivateUpdateCommand = CommandSpec & {
  readonly shell: false;
  readonly inheritEnv: false;
  readonly env: Readonly<Record<string, string>>;
  readonly nativeCompletion?: NativeUpdateCompletion;
};
/** Private worker contract, not a protocol DTO or a callback-issued attestation. */
export type PrivateUpdateIntent = {
  readonly operationId: string;
  readonly family: Family;
  readonly mode: Mode;
  readonly installationId: string;
  readonly targetFingerprint: string;
  readonly provenanceDigest: string;
  readonly managerDigest: string;
};
export type PrivateUpdateEvent =
  | { readonly kind: "intent" | "dispatch"; readonly intent: PrivateUpdateIntent }
  | { readonly kind: "exit"; readonly intent: PrivateUpdateIntent; readonly status: number | null; readonly signal: string | null };
export type PrivateUpdateObservation = {
  readonly kind: "files-verified" | "already-current";
  readonly intent: PrivateUpdateIntent;
  readonly durableReceipt: false;
};
export type CompletionBridge = {
  readonly kind: "core-attestation";
  readonly evidenceRef: string;
  readonly expectedBinding: RuntimeBinding;
  readonly workGeneration: number;
};
export type GracefulExitSpec = {
  readonly kind: "core-stop";
  readonly operationId: string;
  readonly ownerTokenRef: string;
  readonly expectedBinding: RuntimeBinding;
};
export type AdapterResult<T> = Result<T, Failure>;

/** Family implementations construct specs only; core owns completion and process effects.
 * Detect/check/version are bounded read-only probes. No generic shell executor is exposed.
 */
export interface FamilyAdapter {
  readonly family: Family;
  readonly detect: (executableRealpath: string) => Promise<AdapterResult<InstallationIdentity>>;
  readonly check: (installation: InstallationIdentity) => Promise<AdapterResult<CheckResult>>;
  readonly version: (installation: InstallationIdentity) => Promise<AdapterResult<VersionEvidence>>;
  readonly exactResume: (runtime: RuntimeIdentity) => AdapterResult<ExactResumeSpec>;
  readonly updateSpec: (installation: InstallationIdentity, mode: Mode) => AdapterResult<UpdateSpec>;
  readonly bridge: (runtime: RuntimeIdentity) => AdapterResult<CompletionBridge>;
  readonly gracefulExit: (runtime: RuntimeIdentity, operationId: string, ownerTokenRef: string) => AdapterResult<GracefulExitSpec>;
}

function object(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function keys(value: { readonly [key: string]: unknown }, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function path(value: unknown): value is `/${string}` {
  return text(value) && value.startsWith("/");
}
function family(value: unknown): value is Family {
  return FAMILIES.some(candidate => candidate === value);
}

/** Strict data classifier: missing/unknown/malformed values never become supported.
 * evidenceRef denotes a claim, not verification of the referenced artifact.
 */
export function isCapability(value: unknown): value is Capability {
  if (!object(value)) return false;
  switch (value["kind"]) {
    case "supported": return keys(value, ["kind", "reason", "evidenceRef"])
      && value["reason"] === "verified" && text(value["evidenceRef"]);
    case "unknown":
    case "missing":
    case "unsupported": return keys(value, ["kind", "reason"]) && [
      "not_verified", "not_installed", "unverified_owner", "shared_engine",
      "missing_session", "missing_bridge", "unsafe_installer", "provenance_unverified",
    ].some(reason => reason === value["reason"]);
    default: return false;
  }
}
export function capabilitySupported(value: unknown): boolean {
  return (isCapability(value) || busySafe(value)) && value.kind === "supported";
}
function busySafe(value: unknown): value is BusySafeCapability {
  if (!object(value)) return false;
  if (value["kind"] !== "supported") return isCapability(value);
  const proof = value["proof"];
  return keys(value, ["kind", "reason", "evidenceRef", "proof"])
    && isCapability({ kind: value["kind"], reason: value["reason"], evidenceRef: value["evidenceRef"] })
    && object(proof) && keys(proof, ["installerDigest", "resourcesFingerprint", "resourceIds", "allConsumersKnown"])
    && text(proof["installerDigest"]) && text(proof["resourcesFingerprint"])
    && Array.isArray(proof["resourceIds"]) && proof["resourceIds"].length > 0
    && proof["resourceIds"].every(text)
    && new Set(proof["resourceIds"]).size === proof["resourceIds"].length
    && proof["allConsumersKnown"] === true;
}
function capabilities(value: unknown): value is AdapterCapabilities {
  return object(value) && keys(value, ["check", "update", "busySafe", "completion", "resume", "gracefulExit"])
    && isCapability(value["check"]) && isCapability(value["update"]) && busySafe(value["busySafe"])
    && isCapability(value["completion"]) && isCapability(value["resume"]) && isCapability(value["gracefulExit"]);
}
function resource(value: unknown): value is MutationResource {
  return object(value) && keys(value, ["resourceId", "realpath", "fingerprint"])
    && text(value["resourceId"]) && path(value["realpath"]) && text(value["fingerprint"]);
}
function installation(value: unknown): value is InstallationIdentity {
  if (!object(value) || !keys(value, [
    "installationId", "resourcesFingerprint", "owner", "installedVersion",
    "family", "channel", "executableRealpath", "resources",
  ])) return false;
  return isInstallSelection({
    installationId: value["installationId"], resourcesFingerprint: value["resourcesFingerprint"],
    owner: value["owner"], installedVersion: value["installedVersion"],
  }) && family(value["family"]) && text(value["channel"]) && path(value["executableRealpath"])
    && Array.isArray(value["resources"]) && value["resources"].length > 0 && value["resources"].every(resource)
    && new Set(value["resources"].map(item => item.resourceId)).size === value["resources"].length
    && new Set(value["resources"].map(item => item.realpath)).size === value["resources"].length;
}
function runtime(value: unknown): value is RuntimeIdentity {
  if (!object(value) || !keys(value, ["runtimeId", "installationId", "binding", "runningVersion"])) return false;
  const version = value["runningVersion"];
  return text(value["runtimeId"]) && text(value["installationId"]) && isRuntimeBinding(value["binding"])
    && object(version) && (
      version["kind"] === "known" ? keys(version, ["kind", "version"]) && text(version["version"])
        : version["kind"] === "unknown" && keys(version, ["kind", "reason"])
          && (version["reason"] === "not_captured" || version["reason"] === "probe_failed")
    );
}
export type ContractFailure = {
  readonly code: "malformed_contract" | "unsupported_version" | "inconsistent_capabilities";
};

/** Pure boundary parser. No probing, logging, installation or process effects.
 * Retains snapshots; freshness, provenance, drain and input claims are authoritative
 * worker/core obligations, not consequences of structural acceptance.
 */
export function parseAdapterContract(value: unknown): Result<AdapterContract, ContractFailure> {
  if (!object(value) || typeof value["version"] !== "number" || !Number.isSafeInteger(value["version"])
    || value["version"] < 0) return { ok: false, error: { code: "malformed_contract" } };
  if (value["version"] !== PROTOCOL_VERSION) return { ok: false, error: { code: "unsupported_version" } };
  const install = value["installation"];
  const bound = value["runtime"];
  const caps = value["capabilities"];
  if (!keys(value, ["version", "family", "installation", "runtime", "capabilities"])
    || !family(value["family"]) || !installation(install) || !(bound === null || runtime(bound))
    || !capabilities(caps)) return { ok: false, error: { code: "malformed_contract" } };
  const owner = install.owner;
  const inconsistent = install.family !== value["family"]
    || (owner.kind === "wrapper" && !install.resources.some(item => item.resourceId === owner.engineResourceId))
    || (caps.update.kind === "supported" && (owner.kind === "unknown" || (install.family === "pi" && owner.kind === "wrapper")))
    || (bound !== null && (bound.installationId !== install.installationId
      || bound.binding.resourcesFingerprint !== install.resourcesFingerprint))
    || (bound === null && [caps.completion, caps.resume, caps.gracefulExit].some(cap => cap.kind === "supported"))
    || (caps.busySafe.kind === "supported" && (
      caps.update.kind !== "supported" || owner.kind === "unknown"
      || caps.busySafe.proof.resourcesFingerprint !== install.resourcesFingerprint
      || caps.busySafe.proof.resourceIds.length !== install.resources.length
      || !install.resources.every(item => caps.busySafe.kind === "supported" && caps.busySafe.proof.resourceIds.includes(item.resourceId))
      || (owner.kind === "native" && owner.installerDigest !== caps.busySafe.proof.installerDigest)
    ));
  if (inconsistent) return { ok: false, error: { code: "inconsistent_capabilities" } };
  return { ok: true, value: {
    version: PROTOCOL_VERSION, family: value["family"], installation: install,
    runtime: bound, capabilities: caps,
  } };
}
