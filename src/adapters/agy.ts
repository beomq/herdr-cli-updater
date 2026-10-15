import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { discoverExecutable, probeExecutable } from "../discovery";
import type { ProvenancePin } from "../discovery";
import { isRuntimeBinding } from "../protocol";
import type { FailureCode } from "../protocol";
import { parseAdapterContract } from "./types";
import type { AdapterCapabilities, AdapterResult, FamilyAdapter, InstallationIdentity, RuntimeIdentity } from "./types";

/** Endpoint identity, NOT an inferred stable/beta channel. Qualified provenance must
 * independently bind this endpoint to the installation; help/basename cannot do so.
 */
export const AGY_MANIFEST_CHANNEL = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json";
export const AGY_INSTALLER_SHA256 = "62966c07365423bd4dc209355060744058fb30d60f5323e2d360e39de64e5042";

/** Private readers are authoritative observations, not caller readiness flags.
 * privateRuntime returns { storagePath, storageSha256, fullId, cwd, optionsRef, args }.
 * preflight independently resolves the existing conversation, returning
 * { binding, storagePath, storageSha256, fullId, cwd, optionsRef, optionsSha256 }.
 * Neither path is reconstructed from storagePathHash or a guessed basename.
 * These observations do NOT qualify the unknown native loader or core bridge.
 */
export type AgyConfiguration = {
  readonly probeCwd: `/${string}`;
  readonly provenance: (executable: string) => readonly ProvenancePin[];
  readonly manifest: () => ProvenancePin | null;
  readonly installer: () => ProvenancePin | null;
  readonly privateRuntime: (runtimeId: string) => unknown;
  readonly preflight: (runtimeId: string) => unknown;
  readonly now: () => number;
};

const unverified = { kind: "unknown", reason: "not_verified" } as const;
const capabilities: AdapterCapabilities = {
  check: unverified, update: unverified,
  busySafe: { kind: "unknown", reason: "unsafe_installer" },
  completion: { kind: "unknown", reason: "missing_bridge" },
  resume: unverified, gracefulExit: unverified,
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
function stable(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}
function bytes(path: string, limit: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new RangeError("bounded_read");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function resourceDigest(path: string): AdapterResult<string> {
  const named = lstatSync(path, { bigint: true });
  if (!named.isFile()) return fail("verification_failed");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!sameFile(named, before) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return fail("external_writer");
    const size = Number(before.size);
    const buffer = Buffer.alloc(64 * 1024);
    const digest = createHash("sha256");
    for (let offset = 0; offset < size;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count === 0) return fail("external_writer");
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (!sameFile(before, after)) return fail("external_writer");
    if (!sameFile(after, lstatSync(path, { bigint: true })) || realpathSync(path) !== path)
      return fail("external_writer");
    return { ok: true, value: digest.digest("hex") };
  } finally { closeSync(fd); }
}
function boundary<T>(action: () => AdapterResult<T>): AdapterResult<T> {
  try { return action(); } catch {
    // Even instanceof/property access can throw on a hostile private value.
    // Absence must be an explicit reader result, never exception metadata.
    return fail("verification_failed");
  }
}
async function asynchronous<T>(action: () => Promise<AdapterResult<T>>): Promise<AdapterResult<T>> {
  try { return await action(); } catch {
    return fail("verification_failed");
  }
}

export function createAgyAdapter(config: AgyConfiguration): FamilyAdapter {
  // Observations only. Every operation revalidates pins and physical bytes.
  const installations = new Map<string, InstallationIdentity>();
  function current(installation: InstallationIdentity): AdapterResult<InstallationIdentity> {
    const parsed = parseAdapterContract({ version: 1, family: "agy", installation, runtime: null, capabilities });
    if (!parsed.ok) return fail("malformed_request");
    const observed = installations.get(installation.installationId);
    if (!observed || !isDeepStrictEqual(observed, installation)) return fail("stale_selection");
    if (observed.owner.kind !== "native" || observed.owner.installerDigest !== `sha256:${AGY_INSTALLER_SHA256}`
      || observed.channel !== AGY_MANIFEST_CHANNEL) return fail("identity_mismatch");
    const pins = config.provenance(observed.executableRealpath);
    if (pins.length !== 1 || !pins.every(pin => observed.resources.some(resource =>
      resource.realpath === realpathSync(pin.path) && resource.fingerprint === `sha256:${pin.sha256}`)))
      return fail("stale_selection");
    for (const resource of observed.resources) {
      if (realpathSync(resource.realpath) !== resource.realpath) return fail("external_writer");
      const digest = resourceDigest(resource.realpath);
      if (!digest.ok) return digest;
      if (`sha256:${digest.value}` !== resource.fingerprint) return fail("external_writer");
    }
    return { ok: true, value: observed };
  }
  function bound(runtime: RuntimeIdentity): AdapterResult<InstallationIdentity> {
    if (!object(runtime) || !isRuntimeBinding(runtime.binding)) return fail("malformed_request");
    const installation = installations.get(runtime.installationId);
    if (!installation) return fail("stale_binding");
    const parsed = parseAdapterContract({ version: 1, family: "agy", installation, runtime, capabilities });
    if (!parsed.ok) return fail("stale_binding");
    const fresh = current(installation);
    if (!fresh.ok) return fresh;
    const binding = runtime.binding;
    if (binding.rootIncarnation.executableRealpath !== installation.executableRealpath
      || binding.session.kind !== "conversation"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(binding.session.fullId))
      return fail("identity_mismatch");
    const live = config.preflight(runtime.runtimeId);
    if (live === null || live === undefined) return fail("missing_session");
    if (!object(live) || !isRuntimeBinding(live["binding"]) || !isDeepStrictEqual(live["binding"], binding))
      return fail("stale_binding");
    return fresh;
  }
  const adapter: FamilyAdapter = {
    family: "agy",
    async detect(executable) {
      return asynchronous(async () => {
        const result = await discoverExecutable({ executable, family: "agy", provenance: config.provenance(executable) });
        if (!result.ok) return fail(result.error.code === "missing" ? "not_found" : "verification_failed");
        const installation = structuredClone(result.value.installation);
        installations.set(installation.installationId, installation);
        // Unknown provenance remains explicit and never launches an operating CLI.
        if (result.value.qualification.kind === "unknown") return { ok: true, value: structuredClone(installation) };
        const version = await adapter.version(installation);
        if (!version.ok) { installations.delete(installation.installationId); return version; }
        const captured = { ...installation, installedVersion: version.value };
        installations.set(captured.installationId, captured);
        return { ok: true, value: structuredClone(captured) };
      });
    },
    async version(installation) {
      return asynchronous(async () => {
        const fresh = boundary(() => current(installation));
        if (!fresh.ok) return fresh;
        const result = await probeExecutable({ executable: fresh.value.executableRealpath,
          cwd: config.probeCwd, argument: "--version" });
        const match = result.ok && result.value.stderr === ""
          ? /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\r?\n?$/.exec(result.value.stdout) : null;
        const version = match?.[1];
        if (!version || (installation.installedVersion.kind === "known" && installation.installedVersion.version !== version))
          return fail("verification_failed");
        const after = boundary(() => current(installation));
        return after.ok ? { ok: true, value: { kind: "known", version } } : after;
      });
    },
    async check(installation) {
      return asynchronous(async () => {
        const version = await adapter.version(installation);
        if (!version.ok) return version;
        const pin = config.manifest();
        if (!pin) return fail("receipt_uncertain");
        const body = bytes(pin.path, 64 * 1024);
        if (hash(body) !== pin.sha256) return fail("verification_failed");
        const manifest: unknown = JSON.parse(body.toString());
        if (!object(manifest) || Object.keys(manifest).sort().join(",") !== "sha512,url,version"
          || !stable(manifest["version"]) || typeof manifest["sha512"] !== "string"
          || !/^[a-f0-9]{128}$/.test(manifest["sha512"]) || typeof manifest["url"] !== "string"
          || !new RegExp(`^https://storage\\.googleapis\\.com/antigravity-public/antigravity-cli/${manifest["version"].replaceAll(".", "\\.")}-[0-9]+/darwin-arm/cli_mac_arm64\\.tar\\.gz$`).test(manifest["url"]))
          return fail("verification_failed");
        if (version.value.kind !== "known" || !stable(version.value.version)) return fail("verification_failed");
        const fresh = boundary(() => current(installation));
        if (!fresh.ok) return fresh;
        const left = manifest["version"].split(".").map(BigInt), right = version.value.version.split(".").map(BigInt);
        let comparison = 0;
        for (let i = 0; i < 3; i++) {
          const a = left[i], b = right[i];
          if (a === undefined || b === undefined) return fail("verification_failed");
          if (a !== b) { comparison = a > b ? 1 : -1; break; }
        }
        // A rollback manifest must not be reported as up-to-date.
        if (comparison < 0) return fail("verification_failed");
        const checkedAt = config.now();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) return fail("verification_failed");
        return { ok: true, value: comparison > 0
          ? { kind: "update-available", installedVersion: version.value.version, availableVersion: manifest["version"], checkedAt }
          : { kind: "up-to-date", installedVersion: version.value.version, checkedAt } };
      });
    },
    updateSpec(installation, mode) {
      return boundary(() => {
        if (mode !== "update-only" && mode !== "update-and-restart") return fail("malformed_request");
        const fresh = current(installation);
        if (!fresh.ok) return fresh;
        const pin = config.installer();
        if (!pin) return fail("receipt_uncertain");
        if (pin.sha256 !== AGY_INSTALLER_SHA256 || hash(bytes(pin.path, 64 * 1024)) !== pin.sha256)
          return fail("verification_failed");
        // Reviewed install.sh:25-48 accepts --dir, NOT version/channel/skip flags.
        // :57-65 exits successfully for an existing binary without updating it.
        // :218-239 cp + native install handoff has an incomplete write set.
        // The native `update` help is not its writer/rollback implementation.
        return fail("receipt_uncertain");
      });
    },
    exactResume(runtime) {
      return boundary(() => {
        const fresh = bound(runtime);
        if (!fresh.ok) return fresh;
        const stored = config.privateRuntime(runtime.runtimeId);
        if (stored === null || stored === undefined) return fail("missing_session");
        if (!object(stored) || !absolute(stored["storagePath"]) || !Array.isArray(stored["args"])
          || stored["args"].length !== 0) return fail("malformed_request");
        // No nonempty option grammar is qualified by the native source receipt.
        // Especially forbid --continue, selectors, prompts, project names and forks.
        const binding = runtime.binding;
        const live = config.preflight(runtime.runtimeId);
        if (!object(live) || !isDeepStrictEqual(live["binding"], binding)) return fail("stale_binding");
        if (stored["fullId"] !== binding.session.fullId || stored["cwd"] !== binding.cwd
          || stored["optionsRef"] !== binding.optionsRef || live["fullId"] !== binding.session.fullId
          || live["cwd"] !== binding.cwd || live["optionsRef"] !== binding.optionsRef
          || live["storagePath"] !== stored["storagePath"]
          || live["optionsSha256"] !== hash(JSON.stringify(stored["args"]))) return fail("identity_mismatch");
        const path = realpathSync(stored["storagePath"]);
        if (path !== stored["storagePath"] || binding.session.storagePathHash !== hash(path))
          return fail("identity_mismatch");
        const digest = hash(bytes(path, 4 * 1024 * 1024));
        if (stored["storageSha256"] !== digest || live["storageSha256"] !== digest) return fail("stale_binding");
        // File existence and agreement of private observations do not prove native
        // full-ID lookup/cwd/options semantics. No synthetic fixture can enable it.
        return fail("receipt_uncertain");
      });
    },
    bridge(runtime) {
      return boundary(() => {
        const fresh = bound(runtime);
        if (!fresh.ok) return fresh;
        // No qualified core attestation covering tools/subagents/background drain.
        return fail("receipt_uncertain");
      });
    },
    gracefulExit(runtime, operationId, ownerTokenRef) {
      return boundary(() => {
        if (!clean(operationId) || !clean(ownerTokenRef)) return fail("malformed_request");
        const fresh = bound(runtime);
        if (!fresh.ok) return fresh;
        // No verified core-owned stop/ownership receipt. Hooks/idle are not proof.
        return fail("receipt_uncertain");
      });
    },
  };
  return adapter;
}
