import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isRuntimeBinding } from "../protocol";
import type { FailureCode } from "../protocol";
import { parseAdapterContract } from "./types";
import type { AdapterCapabilities, AdapterResult, FamilyAdapter, InstallationIdentity, RuntimeIdentity } from "./types";

export const GROK_PUBLIC_SOURCE_REF = "2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8";
const unknown = { kind: "unknown", reason: "not_verified" } as const;
const capabilities: AdapterCapabilities = {
  check: unknown, update: unknown, resume: unknown, gracefulExit: unknown,
  completion: { kind: "unknown", reason: "missing_bridge" },
  busySafe: { kind: "unknown", reason: "unsafe_installer" },
};

/** Private authoritative readers, never public DTO claims.
 * installation resolves canonical native OR npm-launcher paths to one owner.
 * versionReceipt binds version to native executable bytes, not its filename.
 * parserReceipt must independently map those same bytes/version to the public
 * Rust parser AND persistence decoder. Task5 has no such release mapping.
 * privateRuntime resolves opaque path/options references; decodeSavedSession is
 * an independently qualified installed-format decoder, not a guessed JSON schema.
 * preflight supplies the current core runtime plus storage/options fingerprints.
 * No reader may search global profiles or execute a CLI.
 */
export type GrokConfiguration = {
  readonly installation: (canonicalPath: string) => InstallationIdentity | null;
  readonly versionReceipt: (installationId: string) => unknown;
  readonly release: (installationId: string) => unknown;
  readonly parserReceipt: (installationId: string) => unknown;
  readonly privateRuntime: (runtimeId: string) => unknown;
  readonly decodeSavedSession: (bytes: Uint8Array) => unknown;
  readonly preflight: (runtimeId: string) => unknown;
  readonly now: () => number;
};

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const fail = <T>(code: FailureCode): AdapterResult<T> => ({ ok: false, error: { code } });
function object(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function clean(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function absolute(value: unknown): value is `/${string}` {
  return clean(value) && value.startsWith("/");
}
function semver(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}
function bytes(path: string, limit = 256 * 1024 * 1024): Buffer {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new RangeError("bounded_read");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
type ReadonlyFiles = {
  readonly realpath: (path: string) => string;
  readonly info: (path: string) => Stats;
  readonly read: (path: string, limit?: number) => Buffer;
};
function boundary<T>(action: (files: ReadonlyFiles) => AdapterResult<T>, missing: FailureCode = "verification_failed"): AdapterResult<T> {
  let failure: FailureCode = "verification_failed";
  // Only Node filesystem operations enter this catch. Private callbacks and
  // argument/property evaluation happen outside it. Missing classification is
  // local to this invocation; no thrown value crosses into the outer catch.
  function filesystem<V>(operation: () => V): V {
    try { return operation(); } catch (error) {
      failure = error instanceof Error && "code" in error && error.code === "ENOENT"
        ? missing : "verification_failed";
      throw undefined;
    }
  }
  const files: ReadonlyFiles = {
    realpath: path => filesystem(() => realpathSync(path)),
    info: path => filesystem(() => lstatSync(path)),
    read: (path, limit) => filesystem(() => bytes(path, limit)),
  };
  // No binding, prototype check, property read, coercion or logging of unknown
  // callback/decoder exceptions, including revoked proxies and poisoned Errors.
  try { return action(files); } catch { return fail(failure); }
}

export function createGrokAdapter(config: GrokConfiguration): FamilyAdapter {
  const observations = new Map<string, InstallationIdentity>();
  function verify(installation: InstallationIdentity, files: ReadonlyFiles): AdapterResult<InstallationIdentity> {
    if (!parseAdapterContract({ version: 1, family: "grok", installation, runtime: null, capabilities }).ok)
      return fail("malformed_request");
    const owner = installation.owner;
    if ((owner.kind !== "native" && !(owner.kind === "package"
      && owner.manager === "npm" && owner.packageName === "@xai-official/grok"))
      || !["stable", "alpha", "enterprise"].includes(installation.channel)) return fail("identity_mismatch");
    const authoritative = config.installation(installation.executableRealpath);
    if (!authoritative || !isDeepStrictEqual(authoritative, installation)) return fail("stale_selection");
    if (!absolute(owner.prefix) || files.realpath(owner.prefix) !== owner.prefix
      || files.realpath(installation.executableRealpath) !== installation.executableRealpath
      || (files.info(installation.executableRealpath).mode & 0o111) === 0) return fail("identity_mismatch");
    const resources = [...installation.resources].sort((a, b) => a.realpath.localeCompare(b.realpath));
    if (installation.installationId !== `install:${hash(installation.executableRealpath)}`
      || installation.resourcesFingerprint !== `sha256:${hash(JSON.stringify(resources))}`
      || !resources.some(row => row.realpath === installation.executableRealpath)) return fail("identity_mismatch");
    for (const row of resources) {
      if (!row.realpath.startsWith(`${owner.prefix}/`) || files.realpath(row.realpath) !== row.realpath
        || row.resourceId !== `resource:${hash(row.realpath)}`) return fail("identity_mismatch");
      if (`sha256:${hash(files.read(row.realpath))}` !== row.fingerprint) return fail("external_writer");
    }
    return { ok: true, value: structuredClone(installation) };
  }
  function current(installation: InstallationIdentity, files: ReadonlyFiles): AdapterResult<InstallationIdentity> {
    if (!isDeepStrictEqual(observations.get(installation.installationId), installation)) return fail("stale_selection");
    return verify(installation, files);
  }
  function installed(installation: InstallationIdentity): AdapterResult<{ readonly kind: "known"; readonly version: string }> {
    const receipt = config.versionReceipt(installation.installationId);
    const binary = installation.resources.find(row => row.realpath === installation.executableRealpath);
    if (!object(receipt) || !clean(receipt["evidenceRef"]) || !semver(receipt["version"])
      || receipt["executableFingerprint"] !== binary?.fingerprint
      || installation.installedVersion.kind !== "known"
      || receipt["version"] !== installation.installedVersion.version) return fail("receipt_uncertain");
    return { ok: true, value: { kind: "known", version: receipt["version"] } };
  }
  function bound(runtime: RuntimeIdentity, files: ReadonlyFiles): AdapterResult<InstallationIdentity> {
    if (!object(runtime) || !isRuntimeBinding(runtime.binding)) return fail("malformed_request");
    const installation = observations.get(runtime.installationId);
    if (!installation || !parseAdapterContract({ version: 1, family: "grok", installation, runtime, capabilities }).ok)
      return fail("stale_binding");
    const fresh = current(installation, files);
    if (!fresh.ok) return fresh;
    if (runtime.binding.rootIncarnation.executableRealpath !== installation.executableRealpath
      || runtime.binding.session.kind !== "conversation"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runtime.binding.session.fullId))
      return fail("identity_mismatch");
    const live = config.preflight(runtime.runtimeId);
    if (!object(live) || !isDeepStrictEqual(live["runtime"], runtime)) return fail("stale_binding");
    return fresh;
  }
  const adapter: FamilyAdapter = {
    family: "grok",
    async detect(executable) {
      return boundary(files => {
        if (!absolute(executable)) return fail("malformed_request");
        const canonical = files.realpath(executable), installation = config.installation(canonical);
        // `agent` is only an alias. Neither its name nor a npm bootstrap's
        // GROK_MANAGED_BY_NPM environment establishes the native binary owner.
        if (!installation || !installation.resources.some(row => row.realpath === canonical)) return fail("identity_mismatch");
        const found = verify(installation, files);
        if (!found.ok) return found;
        const version = installed(found.value);
        if (!version.ok) return version;
        observations.set(found.value.installationId, structuredClone(found.value));
        return found;
      }, "not_found");
    },
    async version(installation) {
      return boundary(files => {
        const fresh = current(installation, files);
        return fresh.ok ? installed(fresh.value) : fresh;
      });
    },
    async check(installation) {
      return boundary(files => {
        const fresh = current(installation, files);
        if (!fresh.ok) return fresh;
        const version = installed(fresh.value);
        if (!version.ok) return version;
        const receipt = config.release(installation.installationId);
        if (!object(receipt) || !clean(receipt["evidenceRef"]) || receipt["channel"] !== installation.channel
          || receipt["resourcesFingerprint"] !== installation.resourcesFingerprint || !semver(receipt["version"]))
          return fail("receipt_uncertain");
        const available = receipt["version"], actual = version.value.version;
        const parts = available.split(".").map(Number), old = actual.split(".").map(Number);
        const index = parts.findIndex((part, i) => part !== old[i]);
        if (index >= 0 && (parts[index] ?? 0) < (old[index] ?? 0)) return fail("verification_failed");
        const checkedAt = config.now();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) return fail("verification_failed");
        const after = current(installation, files);
        return after.ok ? { ok: true, value: available === actual
          ? { kind: "up-to-date", installedVersion: actual, checkedAt }
          : { kind: "update-available", installedVersion: actual, availableVersion: available, checkedAt } } : after;
      });
    },
    exactResume(runtime) {
      return boundary(files => {
        const fresh = bound(runtime, files);
        if (!fresh.ok) return fresh;
        const version = installed(fresh.value);
        if (!version.ok) return version;
        const parser = config.parserReceipt(runtime.installationId);
        if (!object(parser) || parser["sourceRef"] !== GROK_PUBLIC_SOURCE_REF
          || parser["version"] !== version.value.version
          || parser["executableFingerprint"] !== fresh.value.resources.find(row => row.realpath === fresh.value.executableRealpath)?.fingerprint
          || !clean(parser["evidenceRef"])) return fail("receipt_uncertain");
        const privateValue = config.privateRuntime(runtime.runtimeId), liveValue = config.preflight(runtime.runtimeId);
        if (!object(privateValue)) return fail("missing_session");
        if (!object(liveValue) || !isDeepStrictEqual(liveValue["runtime"], runtime)) return fail("stale_binding");
        const stored = structuredClone(privateValue), live = structuredClone(liveValue);
        if (!absolute(stored["storagePath"]) || !absolute(stored["storageRoot"])
          || !Array.isArray(stored["args"])) return fail("malformed_request");
        // Nonempty private options need a release-qualified equivalence parser.
        // Never replay selectors, prompts, worktrees, forks or unsafe flags.
        if (stored["args"].length !== 0) return fail("receipt_uncertain");
        const binding = runtime.binding, path = stored["storagePath"];
        if (stored["fullId"] !== binding.session.fullId || stored["cwd"] !== binding.cwd
          || stored["optionsRef"] !== binding.optionsRef || live["optionsSha256"] !== hash(JSON.stringify(stored["args"]))
          || files.realpath(binding.cwd) !== binding.cwd || !files.info(binding.cwd).isDirectory()
          || files.realpath(stored["storageRoot"]) !== stored["storageRoot"]
          || !path.startsWith(`${stored["storageRoot"]}/`) || files.realpath(path) !== path
          || binding.session.storagePathHash !== hash(path)) return fail("identity_mismatch");
        const body = files.read(path, 16 * 1024 * 1024), digest = hash(body);
        if (stored["storageSha256"] !== digest || live["storageSha256"] !== digest) return fail("stale_binding");
        const decoded = config.decodeSavedSession(body);
        // A local hit can itself resolve to a restored child or another cwd.
        if (!object(decoded) || decoded["fullId"] !== binding.session.fullId
          || decoded["resolvedId"] !== binding.session.fullId || decoded["cwd"] !== binding.cwd
          || decoded["hasSavedState"] !== true) return fail("missing_session");
        if (hash(files.read(path, 16 * 1024 * 1024)) !== digest
          || !isDeepStrictEqual(config.preflight(runtime.runtimeId), live)
          || !isDeepStrictEqual(config.privateRuntime(runtime.runtimeId), stored)) return fail("stale_binding");
        const after = current(fresh.value, files);
        if (!after.ok) return after;
        const command = { executable: `/${fresh.value.executableRealpath.slice(1)}` as const,
          args: ["--resume", binding.session.fullId], cwd: `/${binding.cwd.slice(1)}` as const, shell: false as const };
        return { ok: true, value: { command, expectedBinding: structuredClone(binding), optionsRef: binding.optionsRef } };
      }, "missing_session");
    },
    updateSpec(installation, mode) {
      return boundary(files => {
        if (mode !== "update-only" && mode !== "update-and-restart") return fail("malformed_request");
        const fresh = current(installation, files);
        if (!fresh.ok) return fresh;
        // Public-source `update --version` also relaunches shared leaders.
        // npm i -g @xai-official/grok@VERSION needs an authenticated absolute
        // manager, isolated env, immutable target and complete mutation scope.
        // Frozen API cannot carry those obligations; do not guess a bare PATH.
        return fail("receipt_uncertain");
      });
    },
    bridge(runtime) {
      return boundary(files => {
        const fresh = bound(runtime, files);
        // No authenticated all-work core attestation available in this API.
        return fresh.ok ? fail("receipt_uncertain") : fresh;
      });
    },
    gracefulExit(runtime, operationId, ownerTokenRef) {
      return boundary(files => {
        if (!clean(operationId) || !clean(ownerTokenRef)) return fail("malformed_request");
        const fresh = bound(runtime, files);
        // Relaunch ACK/display idle/5-second grace is not a drain proof.
        return fresh.ok ? fail("receipt_uncertain") : fresh;
      });
    },
  };
  return adapter;
}
