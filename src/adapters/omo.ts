import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isDeepStrictEqual, types as utilTypes } from "node:util";
import { dirname, join, resolve } from "node:path";
import { discoverExecutable } from "../discovery";
import { createOmoUpdateSpec, getOmoUpdateIntent } from "./update-context";
import type { OmoExecutionIntent } from "./update-context";
import type { ProvenancePin } from "../discovery";
import { isRuntimeBinding } from "../protocol";
import type { CheckResult, FailureCode, Mode, RuntimeBinding } from "../protocol";
import type { AdapterResult, FamilyAdapter, InstallationIdentity, PrivateUpdateContext, RuntimeIdentity } from "./types";
import { parseAdapterContract } from "./types";

// allow: SIZE_OK — task9 owns one family boundary; shared private issuance belongs
// to task38. Splitting this scoped consumer into sibling modules is not authorized.
export type OmoUpdateAuthority = {
  readonly now: () => number;
  readonly read: (selection: {
    readonly installation: InstallationIdentity;
    readonly check: Extract<CheckResult, { readonly kind: "update-available" }>;
    readonly mode: Mode;
  }) => { readonly context: PrivateUpdateContext; readonly intent: OmoExecutionIntent } | null;
};

/** Private core accessors read authoritative records at call time, not UI capabilities.
 * No accessor is an updater/launcher. Core must revalidate specs before effects.
 * Conversation identity is the JSONL header id; the path exists only here.
 */
export type OmoRuntimeRecord = {
  readonly runtime: RuntimeIdentity;
  readonly installation: InstallationIdentity;
  readonly sessionPath: string;
  readonly options: readonly string[];
};
export type OmoCoreRecord = {
  readonly expectedBinding: RuntimeBinding;
  readonly evidenceRef: string;
  readonly workGeneration: number;
  readonly activeWork: {
    readonly root: number; readonly tools: number; readonly subagents: number;
    readonly monitors: number; readonly continuations: number;
  };
  readonly admission: "fenced" | "open";
  readonly claim: null | { readonly operationId: string; readonly ownerTokenRef: string };
};
export type OmoConfiguration = {
  readonly provenance: readonly ProvenancePin[];
  readonly wrapperManifest: string;
  readonly engineManifest: string;
  /** Reads registry response data; the adapter parses name, channel and version. */
  readonly release: (channel: string) => Promise<unknown>;
  readonly runtime: (runtimeId: string) => OmoRuntimeRecord | null;
  /** Missing until qualified core inspect/claim integration is provided. */
  readonly core: (runtimeId: string) => OmoCoreRecord | null;
  /** Trusted private operation lookup, never a public DTO or capability flag. */
  readonly updateAuthority?: OmoUpdateAuthority;
  /** Exact observed package snapshot, not an owner or update receipt. */
  readonly checkOnly?: InstallationIdentity;
  /** Private exact check target. The release seam must read that version endpoint, not retag it. */
  readonly targetVersion?: string;
};
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const fail = <T>(code: FailureCode): AdapterResult<T> => ({ ok: false, error: { code } });
const object = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const absolute = (value: string): value is `/${string}` =>
  value.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(value);
const version = (value: unknown): value is string =>
  typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
const exactTarget = (value: string): boolean =>
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(value);
function json(path: string): unknown {
  if (!absolute(path) || !statSync(path).isFile() || statSync(path).size > 65536) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}
/** Public failures never include filesystem errors, private paths or option values. */
function boundary<T>(action: () => AdapterResult<T>): AdapterResult<T> {
  // All JS thrown values are private, including objects, strings and null.
  try { return action(); } catch {
    return fail("verification_failed");
  }
}

/** Selection is plain enumerable contract data, not a live object capability.
 * Reject proxies before reflection and accessors before any value read.
 */
function plainSelectionData(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (typeof value !== "object" || utilTypes.isProxy(value) || seen.has(value)) return false;
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor)
      || (!descriptor.enumerable && !(array && key === "length"))
      || !plainSelectionData(descriptor.value, seen)) return false;
  }
  seen.delete(value);
  return true;
}
function captureInstallation(installation: InstallationIdentity): AdapterResult<InstallationIdentity> {
  if (!plainSelectionData(installation)) return fail("verification_failed");
  const snapshot = structuredClone(installation);
  const unknown = { kind: "unknown", reason: "not_verified" } as const;
  const parsed = parseAdapterContract({ version: 1, family: snapshot.family, installation: snapshot, runtime: null,
    capabilities: { check: unknown, update: unknown, busySafe: unknown, completion: unknown, resume: unknown, gracefulExit: unknown } });
  return parsed.ok ? { ok: true, value: parsed.value.installation } : fail("verification_failed");
}

export function createOmoAdapter(config: OmoConfiguration): FamilyAdapter {
  const targetVersion = config.targetVersion;
  const checks = new Map<string, { readonly installation: InstallationIdentity; readonly check: CheckResult }>();
  const checkOnly = config.checkOnly ? structuredClone(config.checkOnly) : undefined;
  function packageCurrent(installation: InstallationIdentity): boolean {
    if (!checkOnly || !plainSelectionData(installation) || !isDeepStrictEqual(checkOnly, installation)
      || installation.family !== "omo" || installation.installedVersion.kind !== "known"
      || installation.resources.length === 0
      || installation.installationId !== `install:${hash(installation.executableRealpath)}`
      || installation.resourcesFingerprint !== `sha256:${hash(JSON.stringify(installation.resources))}`) return false;
    for (const resource of installation.resources) {
      if (realpathSync(resource.realpath) !== resource.realpath || !statSync(resource.realpath).isFile()
        || statSync(resource.realpath).size > 64 * 1024 * 1024
        || resource.resourceId !== `resource:${hash(resource.realpath)}`
        || resource.fingerprint !== `sha256:${hash(readFileSync(resource.realpath))}`) return false;
    }
    if (![config.wrapperManifest, config.engineManifest, installation.executableRealpath]
      .every(path => installation.resources.some(resource => resource.realpath === path))) return false;
    const wrapper = json(config.wrapperManifest), engine = json(config.engineManifest);
    const engineBin = object(engine) && object(engine["bin"]) ? engine["bin"] : null;
    const engineEntry = engineBin && typeof engineBin["pi"] === "string" && engineBin["pi"] === engineBin["senpi"]
      ? engineBin["pi"] : null;
    let dependency = false;
    for (let parent = dirname(config.wrapperManifest), level = 0; level < 16; level++, parent = dirname(parent)) {
      try {
        dependency = realpathSync(join(parent, "node_modules", "@code-yeongyu", "senpi", "package.json")) === config.engineManifest;
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (parent === dirname(parent)) break;
    }
    return object(wrapper) && object(engine) && wrapper["name"] === "omo-ai"
      && wrapper["version"] === installation.installedVersion.version && object(wrapper["bin"])
      && typeof wrapper["bin"]["omo"] === "string"
      && realpathSync(resolve(dirname(config.wrapperManifest), wrapper["bin"]["omo"])) === installation.executableRealpath
      && dependency && engine["name"] === "@code-yeongyu/senpi" && version(engine["version"])
      && engineEntry !== null
      && installation.resources.some(resource => resource.realpath === realpathSync(resolve(dirname(config.engineManifest), engineEntry)))
      && object(wrapper["dependencies"]) && wrapper["dependencies"]["@code-yeongyu/senpi"] === engine["version"];
  }
  async function packageCheck(installation: InstallationIdentity): Promise<AdapterResult<CheckResult>> {
    try {
      if (!packageCurrent(installation)) return fail("stale_selection");
      if (targetVersion !== undefined && !exactTarget(targetVersion)) return fail("verification_failed");
      const release = await config.release(targetVersion ?? "latest");
      if (!object(release) || release["name"] !== "omo-ai" || !version(release["version"])
        || (targetVersion !== undefined ? release["version"] !== targetVersion
          : !object(release["dist-tags"]) || release["dist-tags"]["latest"] !== release["version"])
        || installation.installedVersion.kind !== "known") return fail("verification_failed");
      if (!packageCurrent(installation)) return fail("stale_selection");
      const installedVersion = installation.installedVersion.version, checkedAt = Date.now();
      const comparison = Bun.semver.order(release["version"], installedVersion);
      if (comparison < 0) return fail("verification_failed");
      return { ok: true, value: comparison === 0
        ? { kind: "up-to-date", installedVersion, checkedAt }
        : { kind: "update-available", installedVersion, availableVersion: release["version"], checkedAt } };
    } catch { return fail("verification_failed"); }
  }
  function fresh(installation: InstallationIdentity): boolean {
    if (installation.family !== "omo" || installation.owner.kind !== "wrapper"
      || installation.owner.packageName !== "omo-ai"
      || installation.installedVersion.kind !== "known"
      || installation.channel !== (installation.installedVersion.version.includes("-") ? "beta" : "latest")
      || installation.resources.length === 0) return false;
    const resources = installation.resources;
    const prefix = realpathSync(installation.owner.prefix);
    if (resources.some(row => !row.realpath.startsWith(`${prefix}/`)
      || realpathSync(row.realpath) !== row.realpath || !statSync(row.realpath).isFile()
      || statSync(row.realpath).size > 64 * 1024 * 1024
      || row.resourceId !== `resource:${hash(row.realpath)}`
      || row.fingerprint !== `sha256:${hash(readFileSync(row.realpath))}`)) return false;
    const wrapperPath = realpathSync(config.wrapperManifest);
    const enginePath = realpathSync(config.engineManifest);
    const wrapper = json(wrapperPath);
    const engine = json(enginePath);
    if (!object(wrapper) || !object(engine) || !object(wrapper["dependencies"])
      || wrapper["name"] !== "omo-ai" || engine["name"] !== "@code-yeongyu/senpi"
      || wrapper["version"] !== installation.installedVersion.version
      || !object(wrapper["bin"]) || typeof wrapper["bin"]["omo"] !== "string"
      || resolve(dirname(wrapperPath), wrapper["bin"]["omo"]) !== installation.executableRealpath
      || !version(engine["version"])
      || wrapper["dependencies"]["@code-yeongyu/senpi"] !== engine["version"]
      || ![wrapperPath, enginePath, installation.executableRealpath].every(path => resources.some(row => row.realpath === path))
      || installation.owner.engineResourceId !== `resource:${hash(enginePath)}`
      || installation.installationId !== `install:${hash(installation.executableRealpath)}`
      || installation.resourcesFingerprint !== `sha256:${hash(JSON.stringify(resources))}`) return false;
    // The pinned canonical receipt authenticates owner/channel/full resource set.
    const pin = config.provenance.length === 1 ? config.provenance[0] : undefined;
    if (!pin || hash(readFileSync(pin.path)) !== pin.sha256) return false;
    const receipt = json(pin.path);
    if (!object(receipt) || receipt["family"] !== "omo" || receipt["channel"] !== installation.channel
      || !isDeepStrictEqual(receipt["owner"], installation.owner)
      || receipt["executable"] !== installation.executableRealpath
      || !Array.isArray(receipt["resources"])) return false;
    const declared = receipt["resources"];
    return new Set(resources.map(row => row.realpath)).size === resources.length
      && resources.length === declared.length + 1
      && resources.some(row => row.realpath === realpathSync(pin.path))
      && declared.every((row: unknown) => {
        if (!object(row) || typeof row["path"] !== "string") return false;
        const path = realpathSync(row["path"]);
        return resources.some(resource => resource.realpath === path && resource.fingerprint === `sha256:${row["sha256"]}`);
      });
  }
  async function detect(executableRealpath: string): Promise<AdapterResult<InstallationIdentity>> {
    try {
      const found = await discoverExecutable({ executable: executableRealpath, family: "omo", provenance: config.provenance });
      if (!found.ok) return fail(found.error.code === "missing" ? "not_found" : "verification_failed");
      if (found.value.qualification.kind !== "known" || !fresh(found.value.installation)) return fail("verification_failed");
      return { ok: true, value: found.value.installation };
    } catch {
      return fail("verification_failed");
    }
  }
  function resolveRuntime(runtime: RuntimeIdentity): AdapterResult<OmoRuntimeRecord> {
    return boundary(() => {
      if (!isRuntimeBinding(runtime.binding)) return fail("stale_binding");
      const record = config.runtime(runtime.runtimeId);
      if (!record || !isDeepStrictEqual(record.runtime, runtime)) return fail("stale_binding");
      if (!fresh(record.installation)
        || runtime.installationId !== record.installation.installationId
        || runtime.binding.resourcesFingerprint !== record.installation.resourcesFingerprint
        || runtime.binding.rootIncarnation.executableRealpath !== record.installation.executableRealpath
        || !absolute(runtime.binding.cwd) || realpathSync(runtime.binding.cwd) !== runtime.binding.cwd
        || !statSync(runtime.binding.cwd).isDirectory()) return fail("stale_binding");
      const path = record.sessionPath;
      if (!absolute(path) || !path.endsWith(".jsonl")
        || runtime.binding.session.kind !== "conversation"
        || runtime.binding.session.storagePathHash !== `sha256:${hash(path)}`) return fail("missing_session");
      // Read only a bounded first line, not the conversation body.
      const fd = openSync(path, "r");
      let first: string;
      try {
        if (!statSync(path).isFile() || statSync(path).size === 0) return fail("missing_session");
        const bytes = Buffer.alloc(16384);
        const length = readSync(fd, bytes, 0, bytes.length, 0);
        const newline = bytes.subarray(0, length).indexOf(10);
        if (newline < 0) return fail("missing_session");
        first = bytes.subarray(0, newline).toString();
      } finally { closeSync(fd); }
      const header: unknown = JSON.parse(first);
      if (!object(header) || header["type"] !== "session" || header["version"] !== 3
        || typeof header["id"] !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(header["id"])
        || header["id"] !== runtime.binding.session.fullId || header["cwd"] !== runtime.binding.cwd) return fail("identity_mismatch");
      for (let i = 0; i < record.options.length; i += 2) {
        const flag = record.options[i];
        const value = record.options[i + 1];
        if (!flag || !["--provider", "--model", "--thinking", "--tools", "--exclude-tools"].includes(flag)
          || !value || !/^[A-Za-z0-9][A-Za-z0-9/._,:+-]*$/.test(value)
          || (flag === "--thinking" && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value))) return fail("unsupported");
      }
      return { ok: true, value: record };
    });
  }
  function core(runtime: RuntimeIdentity): AdapterResult<OmoCoreRecord> {
    return boundary(() => {
      const resolved = resolveRuntime(runtime);
      if (!resolved.ok) return resolved;
      const evidence = config.core(runtime.runtimeId);
      if (!evidence) return fail("unsupported");
      if (!isDeepStrictEqual(evidence.expectedBinding, runtime.binding)
        || evidence.workGeneration !== runtime.binding.turnGeneration
        || !evidence.evidenceRef || evidence.admission !== "fenced"
        || Object.keys(evidence.activeWork).sort().join(",") !== "continuations,monitors,root,subagents,tools"
        || Object.values(evidence.activeWork).some(count => count !== 0)) return fail("resources_busy");
      return { ok: true, value: evidence };
    });
  }
  return {
    family: "omo", detect,
    async version(installation) {
      const found = await detect(installation.executableRealpath);
      if (!found.ok) return found;
      if (!isDeepStrictEqual(found.value, installation)) return fail("stale_selection");
      return { ok: true, value: found.value.installedVersion };
    },
    async check(installation) {
      if (checkOnly) return packageCheck(installation);
      checks.delete(installation.installationId);
      const found = await detect(installation.executableRealpath);
      if (!found.ok) return found;
      if (!isDeepStrictEqual(found.value, installation)) return fail("stale_selection");
      try {
        if (targetVersion !== undefined && !exactTarget(targetVersion)) return fail("verification_failed");
        const release = await config.release(targetVersion ?? installation.channel);
        if (!object(release) || release["name"] !== "omo-ai" || !version(release["version"])
          || (targetVersion !== undefined ? release["version"] !== targetVersion
            : !object(release["dist-tags"]) || release["dist-tags"][installation.channel] !== release["version"])
          || installation.installedVersion.kind !== "known") return fail("verification_failed");
        const installedVersion = installation.installedVersion.version;
        const checkedAt = config.updateAuthority?.now() ?? Date.now();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) return fail("verification_failed");
        const result: CheckResult = release["version"] === installedVersion
          ? { kind: "up-to-date", installedVersion, checkedAt }
          : { kind: "update-available", installedVersion, availableVersion: release["version"], checkedAt };
        checks.set(installation.installationId, { installation: structuredClone(installation), check: structuredClone(result) });
        return { ok: true, value: result };
      } catch {
        return fail("verification_failed");
      }
    },
    exactResume(runtime) {
      const record = resolveRuntime(runtime);
      if (!record.ok) return record;
      const executable = record.value.installation.executableRealpath;
      if (!absolute(executable) || !absolute(runtime.binding.cwd)) return fail("identity_mismatch");
      return { ok: true, value: { command: { executable, cwd: runtime.binding.cwd,
        args: [...record.value.options, "--session", record.value.sessionPath] },
        expectedBinding: runtime.binding, optionsRef: runtime.binding.optionsRef } };
    },
    updateSpec(installation, mode) {
      return boundary(() => {
        const captured = captureInstallation(installation);
        if (!captured.ok) return captured;
        const selected = captured.value;
        if (!fresh(selected)) return fail("stale_selection");
        const checked = checks.get(selected.installationId);
        if (!checked || checked.check.kind !== "update-available") return fail("unsupported");
        if (!isDeepStrictEqual(checked.installation, selected)) return fail("stale_selection");
        const authority = config.updateAuthority;
        if (!authority) return fail("unsupported");
        const operation = authority.read({ installation: structuredClone(selected),
          check: structuredClone(checked.check), mode });
        if (!operation) return fail("unsupported");
        const context = operation.context;
        const intent = structuredClone(operation.intent);
        if (intent.family !== "omo" || intent.mode !== mode || intent.installationId !== selected.installationId)
          return fail("verification_failed");
        // Settle original selection changes from provider reads/getters before
        // final clock+issuer. Never touch the original caller object afterward.
        const current = captureInstallation(installation);
        if (!current.ok) return current;
        if (!isDeepStrictEqual(current.value, selected)) return fail("verification_failed");
        const now = authority.now();
        if (!Number.isSafeInteger(now) || now < checked.check.checkedAt) return fail("verification_failed");
        const spec = createOmoUpdateSpec(context, intent, now);
        if (!spec.ok) return spec;
        const bound = getOmoUpdateIntent(spec.value);
        if (!bound.ok || !isDeepStrictEqual(bound.value, intent)
          || !isDeepStrictEqual(spec.value.expectedInstallation, selected)
          || !isDeepStrictEqual(spec.value.mutationResources, selected.resources)
          || spec.value.mode !== mode || spec.value.execution !== context
          || !isDeepStrictEqual(spec.value.command.args, ["add", "-g", `omo-ai@${checked.check.availableVersion}`]))
          return fail("verification_failed");
        return spec;
      });
    },
    bridge(runtime) {
      const evidence = core(runtime);
      if (!evidence.ok) return evidence;
      return { ok: true, value: { kind: "core-attestation", evidenceRef: evidence.value.evidenceRef,
        expectedBinding: runtime.binding, workGeneration: evidence.value.workGeneration } };
    },
    gracefulExit(runtime, operationId, ownerTokenRef) {
      const evidence = core(runtime);
      if (!evidence.ok) return evidence;
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerTokenRef)
        || !isDeepStrictEqual(evidence.value.claim, { operationId, ownerTokenRef })) return fail("unauthorized");
      return { ok: true, value: { kind: "core-stop", operationId, ownerTokenRef, expectedBinding: runtime.binding } };
    },
  };
}
