import { isDeepStrictEqual } from "node:util";
import { FAMILIES, parseAdapterContract } from "./adapters/types";
import type { AdapterContract, AdapterResult, InstallationIdentity } from "./adapters/types";
import { isInstallSelection } from "./protocol";
import type { CheckResult, DisplaySession, Failure, Family, Installation, Runtime } from "./protocol";
import type { CompletionBinding } from "./core/completion";

/** Private injection only: readers supply current, independently observed contracts.
 * No detector, core readiness, idle status or private startup record is invented here.
 * lastCheck belongs to this exact installation snapshot, not a latest-conversation lookup.
 */
export type CatalogObservation = {
  readonly contract: AdapterContract;
  readonly lastCheck: Installation["lastCheck"];
};
/** Read-only core facts, deliberately NOT RuntimeBinding. In particular the
 * string incarnation and completion lease generation are never numeric pane/
 * turn generations, and session.value is never a storage-path hash. */
export type CoreObservation = {
  readonly paneId: string;
  readonly terminalId: string;
  readonly agent: string | null;
  /** Optional display-only classification/status, never runtime qualification. */
  readonly family?: DisplaySession["family"];
  readonly status?: DisplaySession["status"];
  readonly workComplete?: DisplaySession["workComplete"];
  readonly cwd: string | null;
  readonly session: CompletionBinding["session"];
  /** Display record revision, NOT a native generation. */
  readonly revision: number;
  readonly completion: {
    readonly binding: CompletionBinding;
    readonly generation: number;
    readonly sequence: number;
  } | null;
};
export type RuntimeAvailability =
  | { readonly kind: "observed"; readonly observations: readonly CatalogObservation[] }
  | { readonly kind: "unavailable"; readonly reason: "identity_incomplete" | "source_unavailable";
    readonly observations: readonly CoreObservation[] };
export type CatalogReaders = {
  readonly candidates: readonly {
    readonly candidateId: string;
    readonly family: Family;
    readonly installationId?: string;
    readonly read: () => Promise<AdapterResult<CatalogObservation>>;
  }[];
  readonly sockets: readonly {
    readonly socketId: string;
    readonly socketEpoch: string;
    readonly read: () => Promise<AdapterResult<readonly CatalogObservation[]>>;
  }[];
  readonly runtimeSources?: readonly {
    readonly socketId: string;
    readonly read: () => Promise<AdapterResult<RuntimeAvailability>>;
  }[];
  /** General process observations are display-only, never restart authority. */
  readonly displaySources?: CatalogReaders["runtimeSources"];
  readonly registrationFailure?: Failure;
  /** Private scanner completed successfully and found no installations/sockets. */
  readonly emptyDiscovery?: true;
  /** Private source-bound checker; no public callback or mutation authority. */
  readonly check?: (installation: InstallationIdentity, signal?: AbortSignal) => Promise<AdapterResult<CheckResult>>;
};
type RuntimeReadiness = {
  readonly runtimeAvailability: readonly (RuntimeAvailability & { readonly sourceId: string })[];
  readonly runtimeReadiness: "observed" | "unavailable";
};
export type CatalogSnapshot = {
  readonly installations: readonly Installation[];
  readonly runtimes: readonly Runtime[];
  /** Capabilities remain per observation; dedup never upgrades their authority. */
  readonly observations: readonly (CatalogObservation & { readonly sourceId: string })[];
  readonly failures: readonly { readonly sourceId: string; readonly error: Failure }[];
  readonly aliases: readonly { readonly installationId: string; readonly canonicalId: string }[];
  readonly families: readonly { readonly family: Family; readonly observationCount: number }[];
} & Partial<RuntimeReadiness>;

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function failure(value: unknown): value is Failure {
  return object(value) && keys(value, ["code"]) && [
    "malformed_request", "unsupported_version", "unauthorized", "not_found",
    "stale_selection", "stale_binding", "revision_conflict", "request_conflict",
    "unsupported", "resources_busy", "external_writer", "cancel_unsafe",
    "missing_session", "identity_mismatch", "update_failed", "verification_failed",
    "receipt_uncertain", "recovery_required",
  ].some(code => code === value["code"]);
}
function check(value: unknown): value is CheckResult {
  if (!object(value) || typeof value["checkedAt"] !== "number"
    || !Number.isSafeInteger(value["checkedAt"]) || value["checkedAt"] < 0) return false;
  const version = (entry: unknown) => typeof entry === "string" && entry.length > 0
    && entry.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(entry);
  switch (value["kind"]) {
    case "up-to-date": return keys(value, ["kind", "installedVersion", "checkedAt"]) && version(value["installedVersion"]);
    case "update-available": return keys(value, ["kind", "installedVersion", "availableVersion", "checkedAt"])
      && version(value["installedVersion"]) && version(value["availableVersion"]);
    case "unavailable": return keys(value, ["kind", "failure", "checkedAt"]) && failure(value["failure"]);
    default: return false;
  }
}
export { check as isCheckResult };
function observation(value: unknown): value is CatalogObservation {
  if (!object(value) || !keys(value, ["contract", "lastCheck"])) return false;
  const parsed = parseAdapterContract(value["contract"]);
  if (!parsed.ok) return false;
  const last = value["lastCheck"];
  if (last === null) return true;
  if (!object(last) || !keys(last, ["checkedAt", "result"]) || !check(last["result"])
    || last["checkedAt"] !== last["result"].checkedAt) return false;
  const installed = parsed.value.installation.installedVersion;
  return last["result"].kind === "unavailable"
    || (installed.kind === "known" && installed.version === last["result"].installedVersion);
}
function coreObservation(value: unknown): value is CoreObservation {
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(v);
  const nullable = (v: unknown) => v === null || text(v);
  const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const session = (v: unknown) => v === null || (object(v) && keys(v, ["source", "agent", "kind", "value"])
    && [v["source"], v["agent"], v["kind"], v["value"]].every(text));
  if (!object(value) || !keys(value, ["paneId", "terminalId", "agent", "cwd", "session", "revision", "completion",
    ...(Object.hasOwn(value, "family") ? ["family"] : []), ...(Object.hasOwn(value, "status") ? ["status"] : []),
    ...(Object.hasOwn(value, "workComplete") ? ["workComplete"] : [])])
    || (Object.hasOwn(value, "family") && value["family"] !== null && !FAMILIES.some(family => family === value["family"]))
    || (Object.hasOwn(value, "status") && !["working", "idle", "done", "unknown"].some(status => status === value["status"]))
    || (Object.hasOwn(value, "workComplete") && value["workComplete"] !== null && typeof value["workComplete"] !== "boolean")
    || !text(value["paneId"]) || !text(value["terminalId"]) || !nullable(value["agent"]) || !nullable(value["cwd"])
    || !session(value["session"]) || !integer(value["revision"])) return false;
  const completion = value["completion"];
  if (completion === null) return true;
  if (!object(completion) || !keys(completion, ["binding", "generation", "sequence"])
    || !integer(completion["generation"]) || !integer(completion["sequence"])) return false;
  const binding = completion["binding"];
  if (!object(binding) || !keys(binding, ["socket_id", "socket_epoch", "pane_id", "pane_incarnation",
    "root_pid", "root_start_identity", "root_executable", "session", "cwd", "options_ref"])
    || !text(binding["socket_id"]) || !text(binding["socket_epoch"]) || binding["pane_id"] !== value["paneId"]
    || !text(binding["pane_incarnation"]) || !integer(binding["root_pid"]) || binding["root_pid"] <= 0
    || !nullable(binding["root_start_identity"]) || !nullable(binding["root_executable"])
    || !nullable(binding["cwd"]) || !nullable(binding["options_ref"])) return false;
  return session(binding["session"]);
}
function runtimeAvailability(value: unknown): value is RuntimeAvailability {
  if (!object(value) || !Array.isArray(value["observations"]) || value["observations"].length > 1024) return false;
  switch (value["kind"]) {
    case "observed": return keys(value, ["kind", "observations"]) && value["observations"].every(observation);
    case "unavailable": return keys(value, ["kind", "reason", "observations"])
      && (value["reason"] === "identity_incomplete" || value["reason"] === "source_unavailable")
      && value["observations"].every(coreObservation);
    default: return false;
  }
}
function result<T>(input: unknown, valid: (input: unknown) => input is T): AdapterResult<T> {
  // Capture once before parsing: accessors cannot swap a validated public record
  // for a second private payload between validation and snapshot creation.
  const value: unknown = structuredClone(input);
  if (!object(value)) return { ok: false, error: { code: "malformed_request" } };
  if (value["ok"] === false && keys(value, ["ok", "error"]) && failure(value["error"]))
    return { ok: false, error: { code: value["error"].code } };
  if (value["ok"] === true && keys(value, ["ok", "value"]) && valid(value["value"]))
    return { ok: true, value: freeze(value["value"]) };
  return { ok: false, error: { code: "malformed_request" } };
}

/** Every supplied candidate and socket is read exactly once. Missing real readers
 * remain a consumer integration gap, not an implied eight-family readiness result.
 */
export async function readCatalog(readers: CatalogReaders): Promise<CatalogSnapshot & RuntimeReadiness> {
  const candidates = readers.candidates.map(row => ({ candidateId: row.candidateId, family: row.family, read: () => row.read() }));
  const sockets = readers.sockets.map(row => ({ socketId: row.socketId, socketEpoch: row.socketEpoch, read: () => row.read() }));
  const runtimeSources = readers.runtimeSources?.map(row => ({ socketId: row.socketId, read: () => row.read() }));
  // Local mutable accumulators only; no input or previously returned snapshot changes.
  const observations: (CatalogObservation & { readonly sourceId: string })[] = [];
  const failures: { readonly sourceId: string; readonly error: Failure }[] = [];
  const availability: (RuntimeAvailability & { readonly sourceId: string })[] = [];
  if (readers.registrationFailure) failures.push({ sourceId: "registry",
    error: failure(readers.registrationFailure) ? { code: readers.registrationFailure.code } : { code: "malformed_request" } });
  for (const candidate of candidates) {
    try {
      const read = result(await candidate.read(), observation);
      if (!read.ok) failures.push({ sourceId: candidate.candidateId, error: read.error });
      else if ((read.value.contract.family !== candidate.family
        && !(candidate.family === "pi" && read.value.contract.family === "omo"
          && read.value.contract.installation.owner.kind === "wrapper"
          && read.value.contract.installation.owner.packageName === "omo-ai"))
        || read.value.contract.runtime !== null)
        failures.push({ sourceId: candidate.candidateId, error: { code: "identity_mismatch" } });
      else observations.push({ ...read.value, sourceId: candidate.candidateId });
    } catch {
      // Private reader/parser failures are opaque, including revoked proxies.
      failures.push({ sourceId: candidate.candidateId, error: { code: "verification_failed" } });
    }
  }
  // Production registration caps this set at 32. Each provider has one absolute
  // deadline, so unreachable cores do not multiply request latency.
  const runtimeReads = await Promise.all((runtimeSources ?? []).map(async source => {
    try { return { sourceId: source.socketId, read: result(await source.read(), runtimeAvailability) }; }
    catch { return { sourceId: source.socketId, read: { ok: false, error: { code: "verification_failed" } } as const }; }
  }));
  for (const { sourceId, read } of runtimeReads) {
    try {
      if (!read.ok) {
        availability.push({ sourceId, kind: "unavailable", reason: "source_unavailable", observations: [] });
      } else {
        switch (read.value.kind) {
          case "observed":
            if (read.value.observations.some(row => row.contract.runtime === null
              || row.contract.runtime.binding.socketId !== sourceId)) {
              availability.push({ sourceId, kind: "unavailable", reason: "source_unavailable", observations: [] });
            } else {
              availability.push({ ...read.value, sourceId });
              observations.push(...read.value.observations.map(row => ({ ...row, sourceId })));
            }
            break;
          case "unavailable":
            if (read.value.observations.some(row => row.completion !== null && row.completion.binding.socket_id !== sourceId))
              availability.push({ sourceId, kind: "unavailable", reason: "source_unavailable", observations: [] });
            else availability.push({ ...read.value, sourceId });
            break;
          default: unreachableAvailability(read.value);
        }
      }
    } catch {
      availability.push({ sourceId, kind: "unavailable", reason: "source_unavailable", observations: [] });
    }
  }
  for (const socket of sockets) {
    try {
      const read = result(await socket.read(), (value): value is readonly CatalogObservation[] =>
        Array.isArray(value) && value.every(observation));
      if (!read.ok) failures.push({ sourceId: socket.socketId, error: read.error });
      else {
        for (const row of read.value) {
          const runtime = row.contract.runtime;
          if (runtime === null || runtime.binding.socketId !== socket.socketId
            || runtime.binding.socketEpoch !== socket.socketEpoch)
            failures.push({ sourceId: socket.socketId, error: { code: "stale_binding" } });
          else observations.push({ ...row, sourceId: socket.socketId });
        }
      }
    } catch {
      failures.push({ sourceId: socket.socketId, error: { code: "verification_failed" } });
    }
  }
  observations.sort((a, b) => a.contract.installation.installationId.localeCompare(b.contract.installation.installationId)
    || a.sourceId.localeCompare(b.sourceId));
  const groups: (typeof observations)[] = [];
  for (const row of observations) {
    const install = row.contract.installation;
    const related = groups.filter(group => group.some(other => {
      const existing = other.contract.installation;
      return install.installationId === existing.installationId
        || install.resources.some(resource => existing.resources.some(item =>
          resource.realpath === item.realpath || resource.resourceId === item.resourceId));
    }));
    const merged = [row, ...related.flat()];
    for (const group of related) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  }
  const installations: Installation[] = [];
  const aliases: { readonly installationId: string; readonly canonicalId: string }[] = [];
  const runtimes: Runtime[] = [];
  for (const group of groups) {
    group.sort((a, b) => Number(b.contract.family === "omo") - Number(a.contract.family === "omo")
      || a.contract.installation.installationId.localeCompare(b.contract.installation.installationId));
    const first = group[0];
    if (!first) continue;
    const primary = first.contract.installation;
    const checked = group.find(row => row.lastCheck !== null)?.lastCheck ?? null;
    const resources = [...primary.resources].sort((a, b) => a.realpath.localeCompare(b.realpath));
    const conflict = group.some(row => {
      const install = row.contract.installation;
      const sharedWrapper = primary.owner.kind === "wrapper" && install.owner.kind === "wrapper"
        && primary.owner.engineResourceId === install.owner.engineResourceId
        && (primary.family === "omo" || primary.family === "pi")
        && (install.family === "omo" || install.family === "pi");
      return install.resourcesFingerprint !== primary.resourcesFingerprint
        || install.channel !== primary.channel || !isDeepStrictEqual(install.owner, primary.owner)
        || !isDeepStrictEqual(install.installedVersion, primary.installedVersion)
        || !isDeepStrictEqual([...install.resources].sort((a, b) => a.realpath.localeCompare(b.realpath)), resources)
        || (install.family !== primary.family && !sharedWrapper)
        || (install.installationId !== primary.installationId && primary.owner.kind === "unknown")
        || (install.executableRealpath !== primary.executableRealpath && !sharedWrapper)
        || (row.lastCheck !== null && checked !== null && !isDeepStrictEqual(row.lastCheck, checked));
    });
    if (conflict) {
      for (const row of group) failures.push({ sourceId: row.sourceId, error: { code: "stale_selection" } });
    } else {
      // A missing check does not discard another observation of the same snapshot.
      installations.push({ ...primary, lastCheck: checked });
      for (const row of group) aliases.push({
        installationId: row.contract.installation.installationId, canonicalId: primary.installationId,
      });
    }
    // Installation dedup must never act as runtime dedup, even across socket IDs.
    for (const row of group) {
      if (row.contract.runtime !== null) runtimes.push({
        ...row.contract.runtime,
        installationId: conflict ? row.contract.runtime.installationId : primary.installationId,
      });
    }
  }
  installations.sort((a, b) =>
    Number(runtimes.some(row => row.installationId === b.installationId))
      - Number(runtimes.some(row => row.installationId === a.installationId))
    || Number(b.lastCheck?.result.kind === "update-available") - Number(a.lastCheck?.result.kind === "update-available")
    || a.family.localeCompare(b.family) || a.installationId.localeCompare(b.installationId));
  runtimes.sort((a, b) => a.binding.socketId.localeCompare(b.binding.socketId)
    || a.binding.paneId.localeCompare(b.binding.paneId) || a.runtimeId.localeCompare(b.runtimeId));
  // Record makes adding a ninth Family a compile-time obligation.
  const familyRows = {
    omo: 0, omp: 0, pi: 0, claude: 0, codex: 0, agy: 0, cursor: 0, grok: 0,
  } satisfies Record<Family, number>;
  for (const row of observations) familyRows[row.contract.family]++;
  return freeze({
    installations, runtimes, observations, failures,
    aliases: aliases.filter((row, index) => aliases.findIndex(other =>
      other.installationId === row.installationId && other.canonicalId === row.canonicalId) === index),
    families: FAMILIES.map(family => ({ family, observationCount: familyRows[family] })),
    runtimeAvailability: availability,
    runtimeReadiness: runtimeSources !== undefined
      && (runtimeSources.length === 0 || availability.some(row => row.kind === "unavailable"))
      ? "unavailable" : "observed",
  });
}
function unreachableAvailability(_value: never): never { throw new TypeError("invalid availability"); }

/** Compare against a newly read snapshot immediately before submission.
 * This is not a core claim, resource lock or authorization to perform effects.
 * Full installation equality includes channel, absent from public InstallSelection.
 */
export function validateCatalogSelection(
  snapshot: CatalogSnapshot, expected: Installation, selectedRuntimes: readonly Runtime[],
): AdapterResult<null> {
  if (snapshot.runtimeReadiness === "unavailable") return { ok: false, error: { code: "unsupported" } };
  if (snapshot.failures.length > 0) return { ok: false, error: { code: "stale_selection" } };
  if (!isInstallSelection({
    installationId: expected.installationId, resourcesFingerprint: expected.resourcesFingerprint,
    owner: expected.owner, installedVersion: expected.installedVersion,
  }) || !snapshot.installations.some(row => isDeepStrictEqual(row, expected)))
    return { ok: false, error: { code: "stale_selection" } };
  if (selectedRuntimes.some(runtime => runtime.installationId !== expected.installationId
    || snapshot.runtimes.filter(row => isDeepStrictEqual(row, runtime)).length !== 1
    // Epoch/generation/root changes do not create a different physical pane.
    // Keep all observations, but never choose either conflicting incarnation.
    || snapshot.runtimes.some(row => row.binding.socketId === runtime.binding.socketId
      && row.binding.paneId === runtime.binding.paneId && !isDeepStrictEqual(row, runtime))))
    return { ok: false, error: { code: "stale_binding" } };
  return { ok: true, value: null };
}
