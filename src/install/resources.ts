import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { types } from "node:util";
import { createHash } from "node:crypto";
import { matchesNativeStoppedClaim } from "../core/client";
import type { LifecycleClaim } from "../service/job-runner";
import { parseAdapterContract } from "../adapters/types";
import type { AdapterContract, BusySafetyProof, InstallationIdentity, MutationResource } from "../adapters/types";
import { canonical, exact, identifier, parseNewJob, record } from "../jobs/jobs";
import { isRuntimeBinding } from "../protocol";
import type { Failure, Mode, Receipt, Result, RuntimeBinding, TargetSelection } from "../protocol";

export type ResourcePlan = {
  readonly contract: AdapterContract;
  readonly mode: Mode;
  readonly selectedTargets: readonly TargetSelection[];
  readonly installerDigest: string;
  readonly mutationResources: readonly MutationResource[];
  readonly transition?: {
    readonly expectedAfter: InstallationIdentity;
    readonly mutationRoots: readonly string[];
    readonly scopeRoot?: string;
  };
};
export type ResourceConsumer = {
  /** Stable process incarnation from the reader, never PID or display-idle alone. */
  readonly consumerId: string;
  readonly binding: RuntimeBinding | null;
  readonly resources: readonly MutationResource[];
  readonly state: "running" | "exited" | "unknown";
};
/** Private reader output, NOT a public capability, core receipt, or discovery API.
 * Completeness/exit and busySafety must be independently established by the reader.
 * CatalogSnapshot alone proves neither all sockets nor outside-process coverage.
 */
export type ResourceObservation = {
  readonly installation: InstallationIdentity;
  readonly installerDigest: string;
  readonly mutationResources: readonly MutationResource[];
  readonly allSocketsKnown: boolean;
  readonly outsideConsumersKnown: boolean;
  readonly consumers: readonly ResourceConsumer[];
  readonly busySafety: BusySafetyProof | null;
};
/** Private call argument only; never stored in ResourcePlan or admitted JSON.
 * Its existing claim/receipt references must originate in the concrete client.
 */
export type NativeExitAdmission = {
  readonly jobId: string;
  readonly claim: LifecycleClaim;
  readonly receipt: Receipt;
};

const unknown = { kind: "unknown", reason: "not_verified" } as const;
function denied(code: Failure["code"]): Result<never, Failure> { return { ok: false, error: { code } }; }
function digest(value: unknown): value is string {
  return typeof value === "string" && /^(sha256:)?[a-f0-9]{64}$/.test(value);
}
function resource(value: unknown): value is MutationResource {
  return record(value) && exact(value, ["resourceId", "realpath", "fingerprint"])
    && identifier(value["resourceId"]) && identifier(value["fingerprint"])
    && typeof value["realpath"] === "string" && isAbsolute(value["realpath"])
    && resolve(value["realpath"]) === value["realpath"] && !/[\u0000-\u001f\u007f]/.test(value["realpath"]);
}
function resources(value: unknown): value is readonly MutationResource[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 4096 && value.every(resource)
    && new Set(value.map(row => row.resourceId)).size === value.length
    && new Set(value.map(row => row.realpath)).size === value.length;
}
function resourceKey(value: readonly MutationResource[]): string {
  return canonical([...value].sort((a, b) => a.resourceId.localeCompare(b.resourceId)));
}

/** Internal data boundary shared by the gate and queue. Reject hooks BEFORE cloning.
 * No dependency needed: the frozen contracts already provide strict classifiers.
 */
export function captureResourceData(input: unknown): Result<unknown, Failure> {
  const ancestors = new WeakSet<object>();
  function copy(value: unknown, depth: number): unknown {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string" && value.length <= 16384) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null || types.isProxy(value) || depth > 20 || ancestors.has(value))
      throw new TypeError("invalid data");
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new TypeError("invalid data");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 4097 || (array && keys.length !== value.length + 1)) throw new TypeError("invalid data");
    ancestors.add(value);
    const result: object = array ? [] : {};
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || key === "toJSON" || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new TypeError("invalid data");
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("invalid data");
      const child: unknown = descriptor.value;
      Object.defineProperty(result, key, { value: copy(child, depth + 1), enumerable: true });
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }
  // Opaque untrusted boundary: never inspect or stringify a thrown caller object.
  try { return { ok: true, value: copy(input, 0) }; }
  catch { return denied("malformed_request"); }
}

function installation(value: unknown): InstallationIdentity | null {
  if (!record(value)) return null;
  const parsed = parseAdapterContract({ version: 1, family: value["family"], installation: value, runtime: null,
    capabilities: { check: unknown, update: unknown, busySafe: unknown, completion: unknown, resume: unknown, gracefulExit: unknown } });
  return parsed.ok && resources(parsed.value.installation.resources) ? parsed.value.installation : null;
}
function exactPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value
    && value !== sep && !/[\u0000-\u001f\u007f]/.test(value);
}
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}
function pathHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalInstallation(value: InstallationIdentity): boolean {
  return exactPath(value.executableRealpath)
    && value.installationId === `install:${pathHash(value.executableRealpath)}`
    && value.resourcesFingerprint === `sha256:${pathHash(JSON.stringify(
      [...value.resources].sort((a, b) => a.realpath.localeCompare(b.realpath))))}`
    && value.resources.every(row => row.resourceId === `resource:${pathHash(row.realpath)}` && digest(row.fingerprint))
    && value.resources.some(row => row.realpath === value.executableRealpath);
}
function transitionPlan(value: unknown, contract: AdapterContract, mutation: readonly MutationResource[],
  installerDigest: string): Result<NonNullable<ResourcePlan["transition"]>, Failure> {
  if (!record(value) || !exact(value, ["expectedAfter", "mutationRoots", ...(Object.hasOwn(value, "scopeRoot") ? ["scopeRoot"] : [])])
    || !Array.isArray(value["mutationRoots"]) || value["mutationRoots"].length === 0
    || value["mutationRoots"].length > 4096 || !value["mutationRoots"].every(exactPath)
    || new Set(value["mutationRoots"]).size !== value["mutationRoots"].length) return denied("malformed_request");
  const before = contract.installation, after = installation(value["expectedAfter"]), roots = value["mutationRoots"];
  if (contract.capabilities.update.kind !== "supported" || before.owner.kind === "unknown"
    || (before.owner.kind === "native" && before.owner.installerDigest !== installerDigest)) return denied("unsupported");
  if (!after || after.family !== before.family || after.channel !== before.channel
    || canonical(after.owner) !== canonical(before.owner) || after.installedVersion.kind !== "known"
    || !canonicalInstallation(before) || !canonicalInstallation(after)
    || !exactPath(before.owner.prefix)) return denied("identity_mismatch");
  const scopeRoot = value["scopeRoot"];
  if (scopeRoot !== undefined && (before.family !== "grok" || before.owner.kind !== "package"
    || !exactPath(scopeRoot) || dirname(before.owner.prefix) !== scopeRoot || roots.length !== 2
    || !roots.includes(before.owner.prefix) || !roots.includes(resolve(scopeRoot, "home"))
    || realpathSync(scopeRoot) !== scopeRoot || !statSync(scopeRoot).isDirectory()
    || statSync(scopeRoot).uid !== process.getuid?.() || (statSync(scopeRoot).mode & 0o777) !== 0o700))
    return denied("unsupported");
  const prefix = typeof scopeRoot === "string" ? scopeRoot : before.owner.prefix;
  // Existing selection fingerprints remain authoritative; a transition only adds
  // declared scope. Neither a new target nor a wider root can replace a source row.
  if (!before.resources.every(row => mutation.some(candidate => canonical(candidate) === canonical(row)))
    || !roots.every(root => within(root, prefix) && mutation.some(row => row.realpath === root))
    || !mutation.every(row => within(row.realpath, prefix)
      && row.resourceId === `resource:${pathHash(row.realpath)}` && digest(row.fingerprint)
      && (before.resources.some(source => canonical(source) === canonical(row))
        || roots.some(root => within(row.realpath, root))))
    || !after.resources.every(row => roots.some(root => within(row.realpath, root)))) return denied("unsupported");
  return { ok: true, value: Object.freeze({ expectedAfter: after, mutationRoots: roots,
    ...(typeof scopeRoot === "string" ? { scopeRoot } : {}) }) };
}
export function parseResourcePlan(input: unknown): Result<ResourcePlan, Failure> {
  const captured = captureResourceData(input);
  if (!captured.ok) return captured;
  const value = captured.value;
  if (!record(value) || !exact(value, ["contract", "mode", "selectedTargets", "installerDigest", "mutationResources",
    ...(Object.hasOwn(value, "transition") ? ["transition"] : [])])
    || !digest(value["installerDigest"]) || !resources(value["mutationResources"])) return denied("malformed_request");
  const contract = parseAdapterContract(value["contract"]);
  if (!contract.ok) return denied("malformed_request");
  const selected = contract.value.installation;
  if (!resources(selected.resources)) return denied("unsupported");
  const transition = Object.hasOwn(value, "transition")
    ? transitionPlan(value["transition"], contract.value, value["mutationResources"], value["installerDigest"]) : null;
  if (transition !== null && !transition.ok) return transition;
  if (transition === null && resourceKey(selected.resources) !== resourceKey(value["mutationResources"])) return denied("unsupported");
  try {
    const job = parseNewJob({ jobId: "validation", requestId: "validation", mode: value["mode"], selectedTargets: value["selectedTargets"],
      installation: { installationId: selected.installationId, owner: selected.owner,
        resourcesFingerprint: selected.resourcesFingerprint, installedVersion: selected.installedVersion } });
    if (job.mode === "restart-only") return denied("unsupported");
    return { ok: true, value: Object.freeze({ contract: Object.freeze(contract.value), mode: job.mode,
      selectedTargets: Object.freeze(job.selectedTargets), installerDigest: value["installerDigest"],
      mutationResources: value["mutationResources"], ...(transition?.ok ? { transition: transition.value } : {}) }) };
  } catch { return denied("malformed_request"); }
}

/** Conservative relation, not a lock graph: IDs, physical paths, ancestors and
 * hardlinks overlap. Missing/inaccessible geometry is unknown, hence overlapping.
 */
export function resourcesOverlap(left: readonly MutationResource[], right: readonly MutationResource[]): boolean {
  try {
    if (!resources(left) || !resources(right)) return true;
    for (const a of left) for (const b of right) {
      if (a.resourceId === b.resourceId) return true;
      const ap = realpathSync(a.realpath), bp = realpathSync(b.realpath);
      const ast = statSync(ap), bst = statSync(bp);
      if (ap === bp || ap.startsWith(bp.endsWith(sep) ? bp : bp + sep)
        || bp.startsWith(ap.endsWith(sep) ? ap : ap + sep) || (ast.dev === bst.dev && ast.ino === bst.ino)) return true;
    }
    return false;
  } catch { return true; }
}

function sameInstallation(a: InstallationIdentity, b: InstallationIdentity): boolean {
  return canonical({ ...a, resources: [] }) === canonical({ ...b, resources: [] })
    && resourceKey(a.resources) === resourceKey(b.resources);
}
/** Fresh reader fingerprints detect observed conflicts; they cannot exclude an
 * external/self updater writing after the observation. No external lock is claimed.
 */
export function verifyResourceFingerprint(expected: unknown, observed: unknown): Result<null, Failure> {
  const a = captureResourceData(expected), b = captureResourceData(observed);
  if (!a.ok || !b.ok) return denied("malformed_request");
  const left = installation(a.value), right = installation(b.value);
  if (!left || !right) return denied("malformed_request");
  return sameInstallation(left, right) ? { ok: true, value: null } : denied("external_writer");
}
function proof(value: unknown): value is BusySafetyProof {
  return record(value) && exact(value, ["installerDigest", "resourcesFingerprint", "resourceIds", "allConsumersKnown"])
    && digest(value["installerDigest"]) && identifier(value["resourcesFingerprint"])
    && Array.isArray(value["resourceIds"]) && value["resourceIds"].length > 0
    && value["resourceIds"].every(identifier) && new Set(value["resourceIds"]).size === value["resourceIds"].length
    && value["allConsumersKnown"] === true;
}
function consumer(value: unknown): value is ResourceConsumer {
  return record(value) && exact(value, ["consumerId", "binding", "resources", "state"])
    && identifier(value["consumerId"]) && (value["binding"] === null || isRuntimeBinding(value["binding"]))
    && resources(value["resources"]) && ["running", "exited", "unknown"].some(state => state === value["state"]);
}

/** Missing destinations are bounded by an existing, canonical owned directory.
 * For overlap, use that parent conservatively; absence never proves no consumers.
 */
function ownedAnchor(path: string, prefix: string): string {
  let anchor = path;
  let info = lstatSync(anchor, { throwIfNoEntry: false });
  while (!info && anchor !== prefix) {
    anchor = dirname(anchor);
    info = lstatSync(anchor, { throwIfNoEntry: false });
  }
  if (!info || !within(anchor, prefix) || realpathSync(anchor) !== anchor
    || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0
    || (anchor !== path && !info.isDirectory())) throw new TypeError("invalid resource geometry");
  // Check the owned ancestors too, not just the missing leaf's nearest parent.
  for (let parent = dirname(anchor); within(parent, prefix); parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0
      || realpathSync(parent) !== parent) throw new TypeError("invalid resource geometry");
    if (parent === prefix) break;
  }
  return anchor;
}

/** Synchronous admission, no updater/core/kill effects. Success is a decision over
 * independently supplied evidence, NOT evidence that any live integration exists.
 * Restart needs the concrete client's native claim and actual stop receipt.
 */
export function evaluateResourceGate(input: unknown, observation: unknown,
  nativeExit?: NativeExitAdmission): Result<null, Failure> {
  const parsed = parseResourcePlan(input), captured = captureResourceData(observation);
  if (!parsed.ok) return parsed;
  if (!captured.ok) return captured;
  const plan = parsed.value, value = captured.value;
  if (!record(value) || !exact(value, ["installation", "installerDigest", "mutationResources", "allSocketsKnown",
    "outsideConsumersKnown", "consumers", "busySafety"]) || !digest(value["installerDigest"])
    || typeof value["allSocketsKnown"] !== "boolean" || typeof value["outsideConsumersKnown"] !== "boolean"
    || !Array.isArray(value["consumers"]) || !value["consumers"].every(consumer)
    || new Set(value["consumers"].map(row => row.consumerId)).size !== value["consumers"].length
    || !(value["busySafety"] === null || proof(value["busySafety"]))) return denied("malformed_request");
  const current = installation(value["installation"]);
  if (!current || !sameInstallation(plan.contract.installation, current)
    || value["installerDigest"] !== plan.installerDigest || !resources(value["mutationResources"])
    || resourceKey(plan.mutationResources) !== resourceKey(value["mutationResources"])) return denied("external_writer");
  if (!value["allSocketsKnown"] || !value["outsideConsumersKnown"]) return denied("unsupported");
  if (plan.contract.capabilities.update.kind !== "supported" || current.owner.kind === "unknown"
    || (current.owner.kind === "native" && current.owner.installerDigest !== plan.installerDigest)) return denied("unsupported");
  let overlapResources = plan.mutationResources;
  try {
    if (plan.transition) {
      if (realpathSync(current.owner.prefix) !== current.owner.prefix
        || !statSync(current.owner.prefix).isDirectory()
        || current.resources.some(row => realpathSync(row.realpath) !== row.realpath)) return denied("external_writer");
      const prefix = plan.transition.scopeRoot ?? current.owner.prefix;
      overlapResources = plan.mutationResources.map(row => ({ ...row, realpath: ownedAnchor(row.realpath, prefix) }));
      for (const row of plan.transition.expectedAfter.resources) ownedAnchor(row.realpath, prefix);
    } else if (plan.mutationResources.some(row => realpathSync(row.realpath) !== row.realpath)) return denied("external_writer");
  } catch { return denied("external_writer"); }
  const affected = value["consumers"].filter(row => overlapResources.some(scope => resourcesOverlap([scope], row.resources)));
  if (affected.some(row => row.state === "unknown")) return denied("resources_busy");
  const live = affected.filter(row => row.state !== "exited");
  switch (plan.mode) {
    case "update-and-restart":
      if (live.some(row => !plan.selectedTargets.some(target =>
        row.binding !== null && canonical(target.expectedBinding) === canonical(row.binding)))) return denied("resources_busy");
      if (!nativeExit || !identifier(nativeExit.jobId) || plan.selectedTargets.length !== 1) return denied("unsupported");
      const selected = plan.selectedTargets[0];
      if (!selected) return denied("unsupported");
      const operationId = `op-${createHash("sha256").update(canonical([nativeExit.jobId, selected.targetId, "stop"])).digest("hex")}`;
      if (!matchesNativeStoppedClaim(nativeExit.claim, nativeExit.receipt, operationId, selected))
        return denied("unsupported");
      // Native exit never overrides a fresh reader's contradictory live consumer,
      // and it grants nothing for another target/job or uncovered outside process.
      return live.length === 0 ? { ok: true, value: null } : denied("resources_busy");
    case "update-only": {
      if (live.length === 0) return { ok: true, value: null };
      const claimed = plan.contract.capabilities.busySafe;
      const independent = value["busySafety"];
      if (claimed.kind !== "supported" || independent === null) return denied("resources_busy");
      const matches = (p: BusySafetyProof) => p.installerDigest === plan.installerDigest
        && p.resourcesFingerprint === current.resourcesFingerprint && p.allConsumersKnown === true
        && canonical([...p.resourceIds].sort()) === canonical(plan.mutationResources.map(row => row.resourceId).sort());
      return matches(claimed.proof) && matches(independent) ? { ok: true, value: null } : denied("resources_busy");
    }
    default: {
      const unreachable: never = plan.mode;
      return unreachable;
    }
  }
}
