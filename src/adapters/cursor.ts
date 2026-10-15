import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { accessSync, constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { probeExecutable } from "../discovery";
import { isRuntimeBinding } from "../protocol";
import type { FailureCode } from "../protocol";
import { parseAdapterContract } from "./types";
import type { AdapterCapabilities, AdapterResult, FamilyAdapter, InstallationIdentity, RuntimeIdentity } from "./types";

export const CURSOR_SOURCE_VERSION = "2026.01.23-916f423";
export const CURSOR_INSTALLER_DIGEST = "sha256:b2776d5f0bf35b561a758977f1293278788bf7939586180d4d942b7dae35b50a";
const channels = ["static", "prod", "lab", "staging", "prod-stable-internal"] as const;
const unknown = { kind: "unknown", reason: "not_verified" } as const;
const capabilities: AdapterCapabilities = {
  check: unknown, update: unknown, resume: unknown, gracefulExit: unknown,
  completion: { kind: "unknown", reason: "missing_bridge" },
  busySafe: { kind: "unknown", reason: "unsafe_installer" },
};

/** Private, authoritative core readers, not public readiness/display flags.
 * installation must carry independently qualified native owner/channel receipts.
 * privateRuntime returns {storagePath, chatsRoot, storageSha256, fullId, cwd,
 * optionsRef, args, environment}. preflight returns
 * {runtime, storageSha256, optionsSha256}; options digest covers args AND env.
 * Both private runtime and preflight also carry independently captured
 * physical:{cwd:{dev,ino},storage:{dev,ino}} using decimal strings, recorded
 * at runtime/session registration, not reconstructed at resume time.
 * decodeMetadata must be a separately qualified installed-format decoder returning
 * {fullId, rootBlobId}; absence is NOT permission to assume a nonempty session.
 * Release receipts return {channel, installedSourceVersion, version, evidenceRef}.
 * These dependencies do not qualify latest-release compatibility or runtime QA.
 */
export type CursorConfiguration = {
  readonly probeCwd: `/${string}`;
  readonly installation: (canonicalExecutable: string) => InstallationIdentity | null;
  readonly release: (installationId: string) => unknown;
  readonly privateRuntime: (runtimeId: string) => unknown;
  readonly preflight: (runtimeId: string) => unknown;
  readonly decodeMetadata: (value: string) => unknown;
  readonly now: () => number;
};

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const fail = <T>(code: FailureCode): AdapterResult<T> => ({ ok: false, error: { code } });
function object(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
// Admit data, not behavior, before clone can erase its raw classification.
function plain(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || value === undefined || typeof value === "string"
    || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return true;
  if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) return false;
  if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) return false;
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !plain(descriptor.value, ancestors)) return false;
  }
  ancestors.delete(value);
  return true;
}
function clean(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function absolute(value: unknown): value is `/${string}` {
  return clean(value) && value.startsWith("/");
}
function releaseVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]{7}$/.test(value);
}
type PhysicalIdentity = {
  readonly dev: string; readonly ino: string; readonly kind: "file" | "directory";
};
function physical(path: string): PhysicalIdentity | null {
  if (!existsSync(path) || realpathSync(path) !== path) return null;
  const info = lstatSync(path, { bigint: true });
  const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : null;
  return kind === null ? null : { dev: String(info.dev), ino: String(info.ino), kind };
}
function samePhysical(value: unknown, actual: PhysicalIdentity | null): boolean {
  return actual !== null && object(value) && Object.keys(value).length === 2
    && value["dev"] === actual.dev && value["ino"] === actual.ino;
}
function bytes(path: string, limit = 64 * 1024 * 1024): Buffer {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new RangeError("bounded_read");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
// Public failures must not contain private filesystem paths or options.
function boundary<T>(action: () => AdapterResult<T>): AdapterResult<T> {
  // Non-observing by contract: even instanceof/code/coercion can trap.
  try { return action(); } catch { return fail("verification_failed"); }
}
async function asyncBoundary<T>(action: () => Promise<AdapterResult<T>>): Promise<AdapterResult<T>> {
  try { return await action(); } catch { return fail("verification_failed"); }
}

export function createCursorAdapter(config: CursorConfiguration): FamilyAdapter {
  const observations = new Map<string, InstallationIdentity>();
  const physicalInstallations = new Map<string, string>();
  function installationGeometry(installation: InstallationIdentity): string | null {
    if (installation.owner.kind !== "native") return null;
    const paths = [...new Set([installation.owner.prefix, dirname(installation.executableRealpath),
      ...installation.resources.map(resource => resource.realpath)])].sort();
    const rows: { readonly path: string; readonly identity: PhysicalIdentity }[] = [];
    for (const path of paths) {
      const identity = physical(path);
      if (!identity) return null;
      rows.push({ path, identity });
    }
    return JSON.stringify(rows);
  }
  function verify(input: InstallationIdentity): AdapterResult<InstallationIdentity> {
    if (!plain(input)) return fail("identity_mismatch");
    const installation = structuredClone(input);
    if (!parseAdapterContract({ version: 1, family: "cursor", installation, runtime: null, capabilities }).ok)
      return fail("malformed_request");
    if (installation.owner.kind !== "native" || installation.owner.installerDigest !== CURSOR_INSTALLER_DIGEST
      || basename(installation.executableRealpath) !== "cursor-agent"
      || !channels.some(channel => channel === installation.channel)) return fail("identity_mismatch");
    const authoritativeObservation = config.installation(installation.executableRealpath);
    if (!plain(authoritativeObservation)) return fail("identity_mismatch");
    const authoritative = structuredClone(authoritativeObservation);
    if (!authoritative || !isDeepStrictEqual(authoritative, installation)) return fail("stale_selection");
    return verifyResources(installation);
  }
  // Filesystem-only: callers must settle private readers before this check.
  function verifyResources(installation: InstallationIdentity): AdapterResult<InstallationIdentity> {
    if (installation.owner.kind !== "native") return fail("identity_mismatch");
    if (realpathSync(installation.executableRealpath) !== installation.executableRealpath
      || realpathSync(installation.owner.prefix) !== installation.owner.prefix
      || (lstatSync(installation.executableRealpath).mode & 0o111) === 0) return fail("identity_mismatch");
    try { accessSync(installation.executableRealpath, constants.X_OK); }
    catch { return fail("identity_mismatch"); }
    const resources = [...installation.resources].sort((a, b) => a.realpath.localeCompare(b.realpath));
    if (installation.installationId !== `install:${hash(installation.executableRealpath)}`
      || installation.resourcesFingerprint !== `sha256:${hash(JSON.stringify(resources))}`
      || !resources.some(resource => resource.realpath === installation.executableRealpath))
      return fail("identity_mismatch");
    const geometry = installationGeometry(installation);
    if (geometry === null) return fail("verification_failed");
    for (const resource of resources) {
      if (!resource.realpath.startsWith(`${installation.owner.prefix}/`)
        || realpathSync(resource.realpath) !== resource.realpath
        || resource.resourceId !== `resource:${hash(resource.realpath)}`) return fail("identity_mismatch");
      if (`sha256:${hash(bytes(resource.realpath))}` !== resource.fingerprint) return fail("external_writer");
    }
    if (readdirSync(dirname(installation.executableRealpath)).some(name =>
      !resources.some(resource => resource.realpath === join(dirname(installation.executableRealpath), name))))
      return fail("external_writer");
    const captured = physicalInstallations.get(installation.installationId);
    if (installationGeometry(installation) !== geometry || (captured !== undefined && captured !== geometry))
      return fail("stale_selection");
    if (captured === undefined) physicalInstallations.set(installation.installationId, geometry);
    return { ok: true, value: structuredClone(installation) };
  }
  function current(installation: InstallationIdentity): AdapterResult<InstallationIdentity> {
    if (!plain(installation)) return fail("identity_mismatch");
    if (!isDeepStrictEqual(observations.get(installation.installationId), installation)) return fail("stale_selection");
    return verify(installation);
  }
  function bound(runtime: RuntimeIdentity): AdapterResult<InstallationIdentity> {
    if (!plain(runtime)) return fail("identity_mismatch");
    if (!object(runtime) || !isRuntimeBinding(runtime.binding)) return fail("malformed_request");
    const installation = observations.get(runtime.installationId);
    if (!installation || !parseAdapterContract({ version: 1, family: "cursor", installation, runtime, capabilities }).ok)
      return fail("stale_binding");
    const fresh = current(installation);
    if (!fresh.ok) return fresh;
    if (runtime.binding.rootIncarnation.executableRealpath !== installation.executableRealpath
      || runtime.binding.session.kind !== "conversation"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runtime.binding.session.fullId))
      return fail("identity_mismatch");
    const liveObservation = config.preflight(runtime.runtimeId);
    if (!plain(liveObservation)) return fail("identity_mismatch");
    const live = structuredClone(liveObservation);
    if (!object(live) || !isDeepStrictEqual(live["runtime"], runtime)) return fail("stale_binding");
    return fresh;
  }
  const adapter: FamilyAdapter = {
    family: "cursor",
    async detect(executable) {
      return asyncBoundary(async () => {
        const found = boundary(() => {
          if (!absolute(executable)) return fail<InstallationIdentity>("malformed_request");
          if (!existsSync(executable)) return fail<InstallationIdentity>("not_found");
          const canonical = realpathSync(executable);
          // In particular, the global `agent` alias resolving to Grok is rejected.
          const installation = config.installation(canonical);
          if (!plain(installation)) return fail<InstallationIdentity>("identity_mismatch");
          if (!installation || canonical !== installation.executableRealpath) return fail<InstallationIdentity>("identity_mismatch");
          return verify(installation);
        });
        if (!found.ok) return found;
        observations.set(found.value.installationId, structuredClone(found.value));
        const version = await adapter.version(found.value);
        if (!version.ok) {
          observations.delete(found.value.installationId);
          physicalInstallations.delete(found.value.installationId);
        }
        return version.ok ? found : version;
      });
    },
    async version(installation) {
      return asyncBoundary(async () => {
        const fresh = boundary(() => current(installation));
        if (!fresh.ok) return fresh;
        const probe = await probeExecutable({ executable: fresh.value.executableRealpath,
          cwd: config.probeCwd, argument: "--version" });
        const match = probe.ok && probe.value.stderr === ""
          ? /^(\d{4}\.\d{2}\.\d{2}-[a-f0-9]{7})\r?\n?$/.exec(probe.value.stdout) : null;
        const version = match?.[1];
        if (!version || installation.installedVersion.kind !== "known"
          || installation.installedVersion.version !== version) return fail("verification_failed");
        const after = boundary(() => current(installation));
        return after.ok ? { ok: true, value: { kind: "known", version } } : after;
      });
    },
    async check(installation) {
      return asyncBoundary(async () => {
        const version = await adapter.version(installation);
        if (!version.ok) return version;
        const receipt = config.release(installation.installationId);
        if (!plain(receipt) || !object(receipt) || !clean(receipt["evidenceRef"])
          || receipt["channel"] !== installation.channel || installation.channel === "static"
          || receipt["installedSourceVersion"] !== CURSOR_SOURCE_VERSION
          || version.value.kind !== "known" || version.value.version !== CURSOR_SOURCE_VERSION
          || !releaseVersion(receipt["version"])) return fail("receipt_uncertain");
        const available = receipt["version"], installed = version.value.version;
        if (available.slice(0, 10) < installed.slice(0, 10)) return fail("verification_failed");
        const checkedAt = config.now();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) return fail("verification_failed");
        const fresh = boundary(() => current(installation));
        return fresh.ok ? { ok: true, value: available === installed
          ? { kind: "up-to-date", installedVersion: installed, checkedAt }
          : { kind: "update-available", installedVersion: installed, availableVersion: available, checkedAt } } : fresh;
      });
    },
    exactResume(input) {
      return boundary(() => {
        if (!plain(input) || !object(input) || !isRuntimeBinding(input.binding)) return fail("identity_mismatch");
        const runtime = structuredClone(input);
        const fresh = bound(runtime);
        if (!fresh.ok) return fresh;
        if (fresh.value.installedVersion.kind !== "known"
          || fresh.value.installedVersion.version !== CURSOR_SOURCE_VERSION
          || runtime.runningVersion.kind !== "known"
          || runtime.runningVersion.version !== CURSOR_SOURCE_VERSION) return fail("receipt_uncertain");
        const storedObservation = config.privateRuntime(runtime.runtimeId);
        if (!plain(storedObservation)) return fail("identity_mismatch");
        const stored = structuredClone(storedObservation);
        const liveObservation = config.preflight(runtime.runtimeId);
        if (!plain(liveObservation)) return fail("identity_mismatch");
        const live = structuredClone(liveObservation);
        if (!object(stored)) return fail("missing_session");
        if (!object(live) || !isDeepStrictEqual(live["runtime"], runtime)) return fail("stale_binding");
        if (!absolute(stored["storagePath"]) || !absolute(stored["chatsRoot"])
          || !Array.isArray(stored["args"]) || stored["args"].length !== 0
          || !object(stored["environment"])
          || Object.entries(stored["environment"]).some(([key, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string"
            || value.length > 32768 || value.includes("\0"))) return fail("malformed_request");
        // No prompts, selectors, --continue, --workspace, force, cloud or unsafe
        // options can be replayed. Nonempty option equivalence is unqualified.
        const binding = runtime.binding, path = stored["storagePath"];
        if (!existsSync(binding.cwd) || !existsSync(path) || !existsSync(stored["chatsRoot"])) return fail("missing_session");
        if (stored["fullId"] !== binding.session.fullId || stored["cwd"] !== binding.cwd
          || stored["optionsRef"] !== binding.optionsRef
          || live["optionsSha256"] !== hash(JSON.stringify({ args: stored["args"], environment: stored["environment"] }))
          || realpathSync(binding.cwd) !== binding.cwd || !lstatSync(binding.cwd).isDirectory()
          || realpathSync(stored["chatsRoot"]) !== stored["chatsRoot"]
          || path !== join(stored["chatsRoot"], createHash("md5").update(binding.cwd).digest("hex"), binding.session.fullId, "store.db")
          || realpathSync(path) !== path || binding.session.storagePathHash !== hash(path)) return fail("identity_mismatch");
        const canonicalCwd = realpathSync(binding.cwd), cwdIdentity = physical(canonicalCwd);
        if (cwdIdentity?.kind !== "directory") return fail("stale_binding");
        const storageIdentity = physical(path), storedPhysical = stored["physical"], livePhysical = live["physical"];
        if (!object(storedPhysical) || !object(livePhysical)) return fail("receipt_uncertain");
        if (storageIdentity?.kind !== "file" || !isDeepStrictEqual(storedPhysical, livePhysical)
          || !samePhysical(storedPhysical["cwd"], cwdIdentity)
          || !samePhysical(storedPhysical["storage"], storageIdentity)) return fail("stale_binding");
        // Never open with create flags. Reject pending WAL/journal state rather
        // than hash only the main DB and accidentally accept stale metadata.
        if (readdirSync(dirname(path)).some(name => name.startsWith("store.db-"))) return fail("external_writer");
        const digest = hash(bytes(path));
        if (stored["storageSha256"] !== digest || live["storageSha256"] !== digest) return fail("stale_binding");
        const db = new Database(path, { readonly: true, create: false, strict: true });
        try {
          db.exec("PRAGMA query_only = ON");
          const integrity: unknown = db.query("PRAGMA integrity_check").all();
          if (!Array.isArray(integrity) || integrity.length !== 1 || !object(integrity[0])
            || integrity[0]["integrity_check"] !== "ok") return fail("verification_failed");
          const tables: unknown = db.query("SELECT name,type FROM sqlite_schema WHERE name IN ('meta','blobs')").all();
          if (!Array.isArray(tables) || tables.length !== 2
            || !tables.every((table: unknown) => object(table) && table["type"] === "table"
              && (table["name"] === "meta" || table["name"] === "blobs"))) return fail("identity_mismatch");
          // Verify the native two-column schema and its actual unique PK index,
          // not the SQL's prose or whichever row SQLite happens to return first.
          for (const [table, key, value, valueType] of [
            ["meta", "key", "value", "TEXT"], ["blobs", "id", "data", "BLOB"],
          ] as const) {
            const columns: unknown = db.query(`PRAGMA table_info('${table}')`).all();
            if (!Array.isArray(columns) || columns.length !== 2
              || !columns.every((column: unknown, index: number) => object(column)
                && column["cid"] === index && column["name"] === (index === 0 ? key : value)
                && column["type"] === (index === 0 ? "TEXT" : valueType)
                && column["notnull"] === 0 && column["dflt_value"] === null
                && column["pk"] === (index === 0 ? 1 : 0))) return fail("identity_mismatch");
            const indexes: unknown = db.query(`PRAGMA index_list('${table}')`).all();
            if (!Array.isArray(indexes)) return fail("identity_mismatch");
            const primary: unknown = indexes.find((index: unknown) => object(index)
              && index["origin"] === "pk" && index["unique"] === 1 && index["partial"] === 0);
            if (!object(primary) || !clean(primary["name"])) return fail("identity_mismatch");
            const keys: unknown = db.query("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(primary["name"]);
            if (!Array.isArray(keys) || keys.length !== 1 || !object(keys[0]) || keys[0]["name"] !== key)
              return fail("identity_mismatch");
          }
          const rows: unknown = db.query("SELECT value FROM meta WHERE key = '0' LIMIT 2").all();
          if (!Array.isArray(rows) || rows.length > 1) return fail("identity_mismatch");
          const row: unknown = rows[0];
          if (!object(row) || typeof row["value"] !== "string" || row["value"].length === 0) return fail("missing_session");
          const metadata = config.decodeMetadata(row["value"]);
          if (types.isProxy(metadata)) return fail("verification_failed");
          if (!plain(metadata) || !object(metadata)) return fail("receipt_uncertain");
          if (metadata["fullId"] !== binding.session.fullId || !clean(metadata["rootBlobId"])) return fail("identity_mismatch");
          const roots: unknown = db.query("SELECT data FROM blobs WHERE id = ? LIMIT 2").all(metadata["rootBlobId"]);
          if (!Array.isArray(roots) || roots.length > 1) return fail("identity_mismatch");
          const root: unknown = roots[0];
          if (!object(root) || !(root["data"] instanceof Uint8Array) || root["data"].length === 0) return fail("missing_session");
        } finally { db.close(); }
        const after = current(fresh.value);
        if (!after.ok) return after;
        const finalLiveObservation = config.preflight(runtime.runtimeId);
        if (!plain(finalLiveObservation)) return fail("identity_mismatch");
        const finalLive = structuredClone(finalLiveObservation);
        const finalStoredObservation = config.privateRuntime(runtime.runtimeId);
        if (!plain(finalStoredObservation)) return fail("identity_mismatch");
        const finalStored = structuredClone(finalStoredObservation);
        if (!plain(input) || !plain(finalLiveObservation) || !plain(finalStoredObservation))
          return fail("identity_mismatch");
        if (!isDeepStrictEqual(physical(path), storageIdentity)) return fail("stale_binding");
        if (!isDeepStrictEqual(finalLiveObservation, finalLive) || !isDeepStrictEqual(finalStoredObservation, finalStored)
          || !isDeepStrictEqual(finalLive, live) || !isDeepStrictEqual(finalStored, stored)
          || !isDeepStrictEqual(input, runtime) || hash(bytes(path)) !== digest
          || readdirSync(dirname(path)).some(name => name.startsWith("store.db-"))) return fail("stale_binding");
        // This is after every private callback, including installation revalidation.
        // A later core launch still needs its own filesystem/binding preflight.
        if (!isDeepStrictEqual(physical(canonicalCwd), cwdIdentity)) return fail("stale_binding");
        const terminal = verifyResources(after.value);
        if (!terminal.ok) return terminal;
        const executable = terminal.value.executableRealpath;
        if (!absolute(executable)) return fail("identity_mismatch");
        // Source-bounded spec, not a claim of actual loader success or drain.
        return { ok: true, value: { command: { executable,
          args: [`--resume=${binding.session.fullId}`], cwd: `/${canonicalCwd.slice(1)}` },
          expectedBinding: structuredClone(binding), optionsRef: binding.optionsRef } };
      });
    },
    updateSpec(installation, mode) {
      return boundary(() => {
        if (mode !== "update-only" && mode !== "update-and-restart") return fail("malformed_request");
        const fresh = current(installation);
        if (!fresh.ok) return fresh;
        if (installation.channel === "static") return fail("unsupported");
        // Observed `update`/`upgrade` takes no immutable target; updater resolves
        // channel at execution, spawns bare curl/tar and rewrites both aliases.
        // Frozen UpdateSpec has no private environment/immutable target contract.
        // Never substitute a floating `update` command or guessed PATH.
        return fail("receipt_uncertain");
      });
    },
    bridge(runtime) {
      return boundary(() => {
        const fresh = bound(runtime);
        return fresh.ok ? fail("receipt_uncertain") : fresh;
      });
    },
    gracefulExit(runtime, operationId, ownerTokenRef) {
      return boundary(() => {
        if (!clean(operationId) || !clean(ownerTokenRef)) return fail("malformed_request");
        const fresh = bound(runtime);
        // Display idle, hooks and process signals do not prove owned-work drain.
        return fresh.ok ? fail("receipt_uncertain") : fresh;
      });
    },
  };
  return adapter;
}
