// allow: SIZE_OK - Task11 owns exactly one family module; private frozen-contract
// validation and spec construction stay together without editing shared helpers.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { discoverExecutable } from "../discovery";
import type { ProvenancePin } from "../discovery";
import { isRuntimeBinding } from "../protocol";
import type { CheckResult, FailureCode, RuntimeBinding } from "../protocol";
import type { AdapterResult, FamilyAdapter, InstallationIdentity, RuntimeIdentity } from "./types";

/** These accessors belong to core's private store, never a public capability/UI.
 * Qualification is an independently acquired vendor/installer record, not help output.
 * Absent real records block specs. Fixture records prove mechanisms only.
 * Core must revalidate the spec's complete binding before any process effect.
 */
export type PiQualification = {
  readonly publicationCommit: string;
  readonly tagCommit: string;
  readonly signatureVerified: boolean;
  readonly sourcePins: readonly ProvenancePin[];
};
export type PiRuntimeRecord = {
  readonly runtime: RuntimeIdentity;
  readonly installation: InstallationIdentity;
  readonly sessionPath: string;
  readonly optionsRef: string;
  readonly startupOptionsFingerprint: string;
  readonly options: readonly string[];
};
export type PiCoreRecord = {
  readonly expectedBinding: RuntimeBinding;
  readonly evidenceRef: string;
  readonly workGeneration: number;
  readonly activeWork: {
    readonly root: number; readonly tools: number; readonly subagents: number;
    readonly monitors: number; readonly continuations: number;
  };
  readonly admission: "open" | "fenced";
  readonly claim: null | { readonly operationId: string; readonly ownerTokenRef: string };
};
export type PiUpdateRecord = {
  readonly manager: ProvenancePin;
  readonly release: unknown;
  readonly resourcesFingerprint: string;
  readonly allConsumersKnown: true;
  readonly consumerInstallationIds: readonly string[];
};
export type PiConfiguration = {
  readonly provenance: readonly ProvenancePin[];
  readonly engineManifest: string;
  readonly qualification: () => PiQualification | null;
  readonly release: (channel: string) => Promise<unknown>;
  readonly runtime: (runtimeId: string) => PiRuntimeRecord | null;
  readonly core: (runtimeId: string) => PiCoreRecord | null;
  readonly update: (installationId: string) => PiUpdateRecord | null;
  /** Exact observed package snapshot; never supplies mutation provenance. */
  readonly checkOnly?: InstallationIdentity;
};
const PACKAGE = "@code-yeongyu/senpi";
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const fail = <T>(code: FailureCode): AdapterResult<T> => ({ ok: false, error: { code } });
const object = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const absolute = (value: string): value is `/${string}` =>
  value.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(value);
function bytes(path: string, limit = 64 * 1024 * 1024): Buffer {
  if (!absolute(path) || realpathSync(path) !== path || !statSync(path).isFile()
    || statSync(path).size > limit) throw new TypeError("invalid artifact");
  return readFileSync(path);
}
const json = (path: string): unknown => JSON.parse(bytes(path, 65536).toString());
function calver(value: unknown): readonly number[] | null {
  const match = typeof value === "string" ? /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-([2-9]\d*))?$/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)] : null;
}
function newer(candidate: string, installed: string): boolean {
  const a = calver(candidate), b = calver(installed);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i], right = b[i];
    if (left !== undefined && right !== undefined && left !== right) return left > right;
  }
  return false;
}
function boundary<T>(action: () => AdapterResult<T>): AdapterResult<T> {
  // Private producers may throw any value. Never inspect, coerce or log it.
  try { return action(); } catch {
    return fail("verification_failed");
  }
}

export function createPiAdapter(config: PiConfiguration): FamilyAdapter {
  const checkOnly = config.checkOnly ? structuredClone(config.checkOnly) : undefined;
  function packageCurrent(installation: InstallationIdentity): boolean {
    if (!checkOnly || !isDeepStrictEqual(checkOnly, installation) || installation.family !== "pi"
      || installation.owner.kind === "wrapper" || installation.installedVersion.kind !== "known"
      || !calver(installation.installedVersion.version) || installation.resources.length === 0
      || installation.installationId !== `install:${hash(installation.executableRealpath)}`
      || installation.resourcesFingerprint !== `sha256:${hash(JSON.stringify(installation.resources))}`) return false;
    for (const resource of installation.resources) {
      if (resource.resourceId !== `resource:${hash(resource.realpath)}`
        || resource.fingerprint !== `sha256:${hash(bytes(resource.realpath))}`) return false;
    }
    if (![config.engineManifest, installation.executableRealpath]
      .every(path => installation.resources.some(resource => resource.realpath === path))) return false;
    const engine = json(config.engineManifest);
    return object(engine) && engine["name"] === PACKAGE && engine["version"] === installation.installedVersion.version
      && object(engine["bin"]) && typeof engine["bin"]["pi"] === "string"
      && engine["bin"]["pi"] === engine["bin"]["senpi"]
      && realpathSync(resolve(dirname(config.engineManifest), engine["bin"]["pi"])) === installation.executableRealpath;
  }
  async function packageCheck(installation: InstallationIdentity): Promise<AdapterResult<CheckResult>> {
    try {
      if (!packageCurrent(installation)) return fail("stale_selection");
      const candidate = release(await config.release("latest"));
      if (!candidate || installation.installedVersion.kind !== "known") return fail("verification_failed");
      if (!packageCurrent(installation)) return fail("stale_selection");
      const installedVersion = installation.installedVersion.version, checkedAt = Date.now();
      return { ok: true, value: newer(candidate, installedVersion)
        ? { kind: "update-available", installedVersion, availableVersion: candidate, checkedAt }
        : { kind: "up-to-date", installedVersion, checkedAt } };
    } catch { return fail("verification_failed"); }
  }
  function fresh(installation: InstallationIdentity): boolean {
    const pin = config.provenance.length === 1 ? config.provenance[0] : undefined;
    if (!pin || hash(bytes(pin.path, 65536)) !== pin.sha256) return false;
    const receipt = json(pin.path);
    if (!object(receipt) || receipt["family"] !== installation.family
      || receipt["executable"] !== installation.executableRealpath || receipt["channel"] !== installation.channel
      || !isDeepStrictEqual(receipt["owner"], installation.owner) || !Array.isArray(receipt["resources"])
      || installation.installationId !== `install:${hash(installation.executableRealpath)}`
      || installation.resourcesFingerprint !== `sha256:${hash(JSON.stringify(installation.resources))}`
      || installation.resources.length !== receipt["resources"].length + 1
      || new Set(installation.resources.map(row => row.realpath)).size !== installation.resources.length
      || !installation.resources.some(row => row.realpath === pin.path)) return false;
    if (installation.owner.kind === "unknown" || installation.channel !== "latest") return false;
    const prefix = realpathSync(installation.owner.prefix);
    if (prefix !== installation.owner.prefix || installation.resources.some(row =>
      !row.realpath.startsWith(`${prefix}/`) || row.resourceId !== `resource:${hash(row.realpath)}`
      || row.fingerprint !== `sha256:${hash(bytes(row.realpath))}`)) return false;
    if (!receipt["resources"].every((row: unknown) => object(row) && typeof row["path"] === "string"
      && installation.resources.some(resource => resource.realpath === row["path"]
        && resource.fingerprint === `sha256:${row["sha256"]}`))) return false;
    const engine = json(config.engineManifest);
    if (!object(engine) || engine["name"] !== PACKAGE || !calver(engine["version"])
      || !object(engine["bin"]) || typeof engine["bin"]["pi"] !== "string"
      || engine["bin"]["pi"] !== engine["bin"]["senpi"]
      || !installation.resources.some(row => row.realpath === config.engineManifest)) return false;
    const engineExecutable = resolve(dirname(config.engineManifest), engine["bin"]["pi"]);
    if (!installation.resources.some(row => row.realpath === engineExecutable)) return false;
    if (installation.family === "omo" && installation.owner.kind === "wrapper") {
      const manifestPath = receipt["packageManifest"];
      if (typeof manifestPath !== "string" || !installation.resources.some(row => row.realpath === manifestPath)) return false;
      const wrapper = json(manifestPath);
      return installation.owner.packageName === "omo-ai" && object(wrapper)
        && wrapper["name"] === "omo-ai" && object(wrapper["dependencies"])
        && wrapper["dependencies"][PACKAGE] === engine["version"] && object(wrapper["bin"])
        && typeof wrapper["bin"]["omo"] === "string"
        && resolve(dirname(manifestPath), wrapper["bin"]["omo"]) === installation.executableRealpath
        && isDeepStrictEqual(installation.installedVersion, { kind: "known", version: wrapper["version"] });
    }
    return installation.family === "pi" && installation.owner.kind === "package"
      && installation.owner.packageName === PACKAGE && receipt["packageManifest"] === config.engineManifest
      && installation.executableRealpath === engineExecutable
      && isDeepStrictEqual(installation.installedVersion, { kind: "known", version: engine["version"] });
  }
  function qualified(installation: InstallationIdentity): boolean {
    const evidence = config.qualification();
    return evidence !== null && evidence.signatureVerified
      && /^[a-f0-9]{40}$/.test(evidence.publicationCommit) && evidence.publicationCommit === evidence.tagCommit
      && evidence.sourcePins.length > 0
      && evidence.sourcePins.every(pin => /^[a-f0-9]{64}$/.test(pin.sha256)
        && installation.resources.some(row => row.realpath === pin.path)
        && hash(bytes(pin.path)) === pin.sha256);
  }
  function release(value: unknown): string | null {
    return object(value) && value["name"] === PACKAGE && typeof value["version"] === "string"
      && calver(value["version"]) && object(value["dist-tags"])
      && value["dist-tags"]["latest"] === value["version"] ? value["version"] : null;
  }
  async function detect(executableRealpath: string): Promise<AdapterResult<InstallationIdentity>> {
    try {
      const found = await discoverExecutable({ executable: executableRealpath, family: "pi", provenance: config.provenance });
      if (!found.ok) return fail(found.error.code === "missing" ? "not_found" : "verification_failed");
      if (found.value.qualification.kind !== "known" || !fresh(found.value.installation)) return fail("verification_failed");
      return { ok: true, value: found.value.installation };
    } catch {
      return fail("verification_failed");
    }
  }
  function runtimeRecord(runtime: RuntimeIdentity): AdapterResult<PiRuntimeRecord> {
    return boundary(() => {
      if (!isRuntimeBinding(runtime.binding)) return fail("stale_binding");
      const record = config.runtime(runtime.runtimeId);
      if (!record || !isDeepStrictEqual(record.runtime, runtime) || !fresh(record.installation)
        || runtime.installationId !== record.installation.installationId
        || runtime.binding.resourcesFingerprint !== record.installation.resourcesFingerprint
        || runtime.binding.rootIncarnation.executableRealpath !== record.installation.executableRealpath
        || record.optionsRef !== runtime.binding.optionsRef
        || record.startupOptionsFingerprint !== `sha256:${hash(JSON.stringify(record.options))}`
        || realpathSync(runtime.binding.cwd) !== runtime.binding.cwd
        || !statSync(runtime.binding.cwd).isDirectory()) return fail("stale_binding");
      if (record.installation.owner.kind === "wrapper") return fail("unsupported");
      const path = record.sessionPath;
      // Frozen protocol's file.fullId is a path. Senpi's durable header id is
      // represented as conversation.fullId; private storage still supplies the file.
      if (!absolute(path) || !path.endsWith(".jsonl") || runtime.binding.session.kind !== "conversation"
        || runtime.binding.session.storagePathHash !== `sha256:${hash(path)}`) return fail("missing_session");
      let first: string;
      try {
        const fd = openSync(path, "r");
        try {
          if (!fstatSync(fd).isFile() || fstatSync(fd).size === 0 || realpathSync(path) !== path) return fail("missing_session");
          const buffer = Buffer.alloc(16384);
          const length = readSync(fd, buffer, 0, buffer.length, 0);
          const newline = buffer.subarray(0, length).indexOf(10);
          if (newline < 0) return fail("missing_session");
          first = buffer.subarray(0, newline).toString();
        } finally { closeSync(fd); }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return fail("missing_session");
        throw error;
      }
      const header: unknown = JSON.parse(first);
      if (!object(header) || header["type"] !== "session" || header["version"] !== 3
        || typeof header["id"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(header["id"])
        || header["id"] !== runtime.binding.session.fullId || header["cwd"] !== runtime.binding.cwd) return fail("identity_mismatch");
      const flags = new Set<string>();
      for (let i = 0; i < record.options.length; i += 2) {
        const flag = record.options[i], value = record.options[i + 1];
        if (!flag || flags.has(flag) || !["--provider", "--model", "--thinking", "--tools", "--exclude-tools", "--mode"].includes(flag)
          || !value || !/^[A-Za-z0-9][A-Za-z0-9/._,:+-]*$/.test(value)
          || (flag === "--thinking" && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value))
          || (flag === "--mode" && !["text", "json", "rpc"].includes(value))) return fail("unsupported");
        flags.add(flag);
      }
      if (!qualified(record.installation)) return fail("verification_failed");
      return { ok: true, value: record };
    });
  }
  function core(runtime: RuntimeIdentity): AdapterResult<PiCoreRecord> {
    return boundary(() => {
      const resolved = runtimeRecord(runtime);
      if (!resolved.ok) return resolved;
      const evidence = config.core(runtime.runtimeId);
      if (!evidence) return fail("unsupported");
      if (!isDeepStrictEqual(evidence.expectedBinding, runtime.binding)
        || evidence.workGeneration !== runtime.binding.turnGeneration || !evidence.evidenceRef
        || evidence.admission !== "fenced"
        || Object.keys(evidence.activeWork).sort().join(",") !== "continuations,monitors,root,subagents,tools"
        || Object.values(evidence.activeWork).some(count => count !== 0)) return fail("resources_busy");
      return { ok: true, value: evidence };
    });
  }
  return {
    family: "pi", detect,
    async version(installation) {
      const found = await detect(installation.executableRealpath);
      if (!found.ok) return found;
      return isDeepStrictEqual(found.value, installation) ? { ok: true, value: found.value.installedVersion } : fail("stale_selection");
    },
    async check(installation) {
      if (checkOnly) return packageCheck(installation);
      const found = await detect(installation.executableRealpath);
      if (!found.ok) return found;
      if (!isDeepStrictEqual(found.value, installation)) return fail("stale_selection");
      if (installation.owner.kind === "wrapper") return fail("unsupported");
      try {
        const candidate = release(await config.release(installation.channel));
        if (!candidate || installation.installedVersion.kind !== "known") return fail("verification_failed");
        const installedVersion = installation.installedVersion.version;
        return { ok: true, value: newer(candidate, installedVersion)
          ? { kind: "update-available", installedVersion, availableVersion: candidate, checkedAt: Date.now() }
          : { kind: "up-to-date", installedVersion, checkedAt: Date.now() } };
      } catch {
        return fail("verification_failed");
      }
    },
    exactResume(runtime) {
      const record = runtimeRecord(runtime);
      if (!record.ok) return record;
      const executable = record.value.installation.executableRealpath, cwd = runtime.binding.cwd;
      if (!absolute(executable) || !absolute(cwd)) return fail("identity_mismatch");
      return { ok: true, value: { command: { executable, cwd, args: [...record.value.options, "--session", record.value.sessionPath] },
        expectedBinding: runtime.binding, optionsRef: runtime.binding.optionsRef } };
    },
    updateSpec(installation, mode) {
      return boundary(() => {
        if (!fresh(installation)) return fail("stale_selection");
        if (installation.owner.kind !== "package" || installation.owner.manager !== "npm") return fail("unsupported");
        if (!qualified(installation)) return fail("verification_failed");
        const record = config.update(installation.installationId);
        if (!record) return fail("unsupported");
        const target = release(record.release), manager = record.manager.path, cwd = installation.owner.prefix;
        if (!target || installation.installedVersion.kind !== "known" || !newer(target, installation.installedVersion.version)
          || !absolute(manager) || !absolute(cwd) || hash(bytes(manager)) !== record.manager.sha256
          || (statSync(manager).mode & 0o111) === 0 || record.resourcesFingerprint !== installation.resourcesFingerprint
          || record.allConsumersKnown !== true || !isDeepStrictEqual(record.consumerInstallationIds, [installation.installationId])) return fail("verification_failed");
        // Even npm's explicit --prefix leaves config/environment and global-root
        // writes unbound. Discovery fingerprints bounded files, not a complete
        // package-root transaction. Frozen CommandSpec has no isolated environment
        // or installer resource attestation. Do not emit an unsafe pinned command.
        if (mode !== "update-only" && mode !== "update-and-restart") return fail("malformed_request");
        return fail("unsupported");
      });
    },
    bridge(runtime) {
      const evidence = core(runtime);
      return evidence.ok ? { ok: true, value: { kind: "core-attestation", evidenceRef: evidence.value.evidenceRef,
        expectedBinding: runtime.binding, workGeneration: evidence.value.workGeneration } } : evidence;
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
