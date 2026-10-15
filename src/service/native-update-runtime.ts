import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { AGY_MANIFEST_CHANNEL } from "../adapters/agy";
import { createAgyUpdateSpec, getAgyUpdateIntent, observeAgyUpdate, qualifyAgyUpdate } from "../adapters/agy-update";
import type { NativeAgyUpdateInput } from "../adapters/agy-update";
import { createCursorUpdateSpec, getCursorUpdateIntent, qualifyCursorUpdate } from "../adapters/cursor-update";
import type { NativeCursorUpdateInput } from "../adapters/cursor-update";
import { parseAdapterContract } from "../adapters/types";
import type { AdapterContract, AdapterResult, FamilyAdapter, InstallationIdentity, PrivateUpdateContext } from "../adapters/types";
import type { UpdateFilePin } from "../adapters/update-context";
import type { CatalogReaders } from "../catalog";
import { MutationQueue } from "../install/queue";
import type { ResourceObservation, ResourcePlan } from "../install/resources";
import { createCheckRuntime } from "./check-runtime";
import type { CheckSource } from "./check-runtime";
import { createCheckStore } from "./check-store";
import type { UpdateOnlyRunnerConfiguration } from "./job-runner";
import { checkNativeFamilyRelease } from "./native-family-release";
import { PluginRuntimeError } from "./plugin-runtime";
import type { PluginRuntimeContext, PluginRuntimeLoad } from "./plugin-runtime";

// allow: SIZE_OK — the authorized two-file boundary keeps native composition and
// its closed persisted-data parser together, without another authority module.
export const NATIVE_UPDATE_RUNTIME_PROFILE = "qualified-native-update-only-v1" as const;
type NativeProfile = ({
  readonly family: "cursor"; readonly update: NativeCursorUpdateInput;
} | {
  readonly family: "agy"; readonly update: NativeAgyUpdateInput;
}) & {
  /** Producer-owned discovery receipt; never inferred from the executable name. */
  readonly provenance: UpdateFilePin;
  readonly sourcePins: readonly UpdateFilePin[];
  readonly expectedAfterPin: UpdateFilePin;
  readonly coverage: {
    readonly root: string; readonly socketDirectory: string;
    readonly registeredSockets: readonly string[]; readonly rootPids: readonly number[];
  };
};
export type NativeUpdateRuntimeInputs = {
  readonly schemaVersion: 1;
  readonly profile: typeof NATIVE_UPDATE_RUNTIME_PROFILE;
  readonly ownerDirectory: string;
  readonly profiles: readonly NativeProfile[];
};
const unsupported = { kind: "unsupported", reason: "not_verified" } as const;
const hash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const failed = <T>(): AdapterResult<T> => ({ ok: false, error: { code: "stale_selection" } });
function requireInput(value: boolean, reason: PluginRuntimeError["reason"] = "inputs"): asserts value {
  if (!value) throw new PluginRuntimeError(reason);
}
function dataOnly(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || types.isProxy(value) || depth > 20) return false;
  const array = Array.isArray(value), keys = Reflect.ownKeys(value);
  return keys.length <= 4097 && Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype)
    && (!array || keys.length === value.length + 1) && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === "string" && key !== "toJSON" && descriptor !== undefined && Object.hasOwn(descriptor, "value")
        && (descriptor.enumerable || (array && key === "length")) && dataOnly(descriptor.value, depth + 1);
    });
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireInput(typeof value === "object" && value !== null && !Array.isArray(value), "configuration");
  const row = Object.fromEntries(Object.entries(value));
  requireInput(Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)), "configuration");
  return row;
}
function text(value: unknown): string {
  requireInput(typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f\\]/.test(value), "configuration");
  return value;
}
function path(value: unknown): string {
  const result = text(value);
  requireInput(result.startsWith("/") && normalize(result) === result, "configuration");
  return result;
}
function integer(value: unknown): number {
  requireInput(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, "configuration");
  return value;
}
function list<T>(value: unknown, parse: (value: unknown) => T, limit = 4096): readonly T[] {
  requireInput(Array.isArray(value) && value.length <= limit, "configuration");
  return value.map(parse);
}
function digest(value: unknown): string {
  const result = text(value); requireInput(/^[a-f0-9]{64}$/.test(result), "configuration"); return result;
}
function pin(value: unknown): UpdateFilePin {
  const row = object(value, ["path", "sha256"]); return { path: path(row["path"]), sha256: digest(row["sha256"]) };
}
function installation(value: unknown): InstallationIdentity {
  requireInput(typeof value === "object" && value !== null && "family" in value, "configuration");
  const parsed = parseAdapterContract({ version: 1, family: value.family, installation: value, runtime: null,
    capabilities: { check: unsupported, update: unsupported, busySafe: unsupported,
      completion: unsupported, resume: unsupported, gracefulExit: unsupported } });
  requireInput(parsed.ok && parsed.value.installation.owner.kind === "native"
    && ["cursor", "agy"].includes(parsed.value.family), "configuration");
  return parsed.value.installation;
}
function members(value: unknown) {
  return list(value, value => {
    const row = object(value, ["path", "sha256", "bytes", "mode"]), mode = integer(row["mode"]);
    requireInput(mode <= 0o777, "configuration");
    return { path: text(row["path"]), sha256: digest(row["sha256"]), bytes: integer(row["bytes"]), mode };
  });
}
/** Structural acceptance confers no authority and performs no I/O. */
export function validateNativeUpdateRuntimeInputs(value: unknown): NativeUpdateRuntimeInputs {
  requireInput(dataOnly(value), "configuration");
  const row = object(structuredClone(value), ["schemaVersion", "profile", "ownerDirectory", "profiles"]);
  requireInput(row["schemaVersion"] === 1 && row["profile"] === NATIVE_UPDATE_RUNTIME_PROFILE, "profile");
  const profiles = list(row["profiles"], (value): NativeProfile => {
    const p = object(value, ["family", "update", "provenance", "sourcePins", "expectedAfterPin", "coverage"]);
    const update = object(p["update"], ["qualification", "receipt"]);
    const c = object(p["coverage"], ["root", "socketDirectory", "registeredSockets", "rootPids"]);
    const common = { provenance: pin(p["provenance"]), sourcePins: list(p["sourcePins"], pin),
      expectedAfterPin: pin(p["expectedAfterPin"]), coverage: { root: path(c["root"]), socketDirectory: path(c["socketDirectory"]),
        registeredSockets: list(c["registeredSockets"], path), rootPids: list(c["rootPids"], integer) } };
    const family = p["family"];
    requireInput(family === "cursor" || family === "agy", "profile");
    const q = object(update["qualification"], family === "cursor"
      ? ["installation", "originalExecutable", "beforeFiles", "beforeDirectories", "beforeInstaller",
        "home", "env", "manifest", "expectedFiles", "dependencies", "target"]
      : ["installation", "root", "home", "env", "source", "installer", "dependencies", "target"]);
    const installed = installation(q["installation"]); requireInput(installed.family === family, "profile");
    const env = object(q["env"], family === "cursor"
      ? ["HOME", "TMPDIR", "PATH", "AGENT_CLI_CREDENTIAL_STORE", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "NODE_COMPILE_CACHE"]
      : ["HOME", "TMPDIR", "PATH", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]);
    const shared = { installation: installed, home: path(q["home"]),
      env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, text(value)])),
      dependencies: list(q["dependencies"], pin, 32) };
    switch (family) {
      case "cursor": {
        const t = object(q["target"], ["version", "channel", "archive", "release", "checkedAt", "expiresAt"]);
        requireInput(t["channel"] === "prod", "profile");
        return { ...common, family, update: { receipt: pin(update["receipt"]), qualification: { ...shared,
          originalExecutable: path(q["originalExecutable"]), beforeFiles: members(q["beforeFiles"]),
          beforeDirectories: list(q["beforeDirectories"], text), beforeInstaller: pin(q["beforeInstaller"]),
          manifest: pin(q["manifest"]), expectedFiles: members(q["expectedFiles"]), target: {
            version: text(t["version"]), channel: "prod", archive: pin(t["archive"]), release: pin(t["release"]),
            checkedAt: integer(t["checkedAt"]), expiresAt: integer(t["expiresAt"]) } } } };
      }
      case "agy": {
        const t = object(q["target"], ["selection", "version", "channel", "manifest", "release", "archive", "expectedFiles", "checkedAt", "expiresAt"]);
        requireInput(t["selection"] === "official-latest" && t["channel"] === AGY_MANIFEST_CHANNEL, "profile");
        return { ...common, family, update: { receipt: pin(update["receipt"]), qualification: { ...shared,
          root: path(q["root"]), source: pin(q["source"]), installer: pin(q["installer"]), target: {
            selection: "official-latest", version: text(t["version"]), channel: AGY_MANIFEST_CHANNEL,
            manifest: pin(t["manifest"]), release: pin(t["release"]), archive: pin(t["archive"]),
            expectedFiles: members(t["expectedFiles"]), checkedAt: integer(t["checkedAt"]), expiresAt: integer(t["expiresAt"]) } } } };
      }
    }
  }, 32);
  requireInput(profiles.length > 0 && new Set(profiles.map(p => p.update.qualification.installation.installationId)).size === profiles.length,
    "configuration");
  return { schemaVersion: 1, profile: NATIVE_UPDATE_RUNTIME_PROFILE, ownerDirectory: path(row["ownerDirectory"]), profiles };
}
function directory(value: string, privateMode = false): void {
  const info = lstatSync(value);
  requireInput(realpathSync(value) === value && info.isDirectory() && info.uid === process.getuid?.()
    && (privateMode ? (info.mode & 0o777) === 0o700 : (info.mode & 0o022) === 0));
}
function fileHash(value: string, system = false): string {
  requireInput(realpathSync(value) === value);
  const fd = openSync(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    requireInput(before.isFile() && before.uid === BigInt(system ? 0 : process.getuid?.() ?? -1)
      && (system || before.nlink === 1n) && (before.mode & 0o022n) === 0n && before.size <= 1024n ** 3n);
    const sha = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < Number(before.size);) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      requireInput(count > 0); sha.update(buffer.subarray(0, count)); offset += count;
    }
    requireInput([fstatSync(fd, { bigint: true }), lstatSync(value, { bigint: true })].every(info =>
      info.dev === before.dev && info.ino === before.ino && info.size === before.size && info.mode === before.mode
      && info.mtimeNs === before.mtimeNs && info.ctimeNs === before.ctimeNs) && realpathSync(value) === value);
    return sha.digest("hex");
  } finally { closeSync(fd); }
}
function document(reference: UpdateFilePin): unknown {
  requireInput(lstatSync(reference.path).size <= 1024 * 1024 && fileHash(reference.path) === reference.sha256);
  const body = readFileSync(reference.path);
  requireInput(hash(body) === reference.sha256 && fileHash(reference.path) === reference.sha256);
  return JSON.parse(body.toString("utf8"));
}
function observeInstalled(expected: InstallationIdentity): InstallationIdentity {
  requireInput(expected.installationId === `install:${hash(expected.executableRealpath)}`
    && expected.resourcesFingerprint === `sha256:${hash(JSON.stringify(expected.resources))}`
    && expected.resources.some(row => row.realpath === expected.executableRealpath)
    && (lstatSync(expected.executableRealpath).mode & 0o111) !== 0);
  const resources = expected.resources.map(row => {
    requireInput(row.resourceId === `resource:${hash(row.realpath)}`);
    return { ...row, fingerprint: `sha256:${fileHash(row.realpath)}` };
  });
  requireInput(isDeepStrictEqual(resources, expected.resources));
  return { ...expected, resources };
}
const censusOptions = { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 } as const;
function processes() {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,uid=,lstart="], censusOptions).trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    requireInput(match !== null && match[1] !== undefined && match[2] !== undefined && match[3] !== undefined && match[4] !== undefined);
    return { pid: Number(match[1]), parent: Number(match[2]), uid: Number(match[3]), start: match[4] };
  });
}
function coverageRoots(p: NativeProfile) {
  const c = p.coverage;
  directory(c.root, true); directory(c.socketDirectory, true); directory(p.update.qualification.home, true);
  requireInput(p.update.qualification.home.startsWith(`${c.root}/`)
    && (c.socketDirectory === c.root || c.socketDirectory.startsWith(`${c.root}/`))
    && c.rootPids.includes(process.pid) && c.registeredSockets.length > 0
    && new Set(c.rootPids).size === c.rootPids.length && new Set(c.registeredSockets).size === c.registeredSockets.length
    && c.registeredSockets.every(socket => socket.startsWith(`${c.socketDirectory}/`)));
  const census = processes();
  return c.rootPids.map(pid => {
    const found = census.find(row => row.pid === pid);
    requireInput(found !== undefined && pid > 1 && found.uid === process.getuid?.()); return found;
  });
}
function observeResources(plan: ResourcePlan, p: NativeProfile, roots: ReturnType<typeof coverageRoots>): ResourceObservation {
  const c = p.coverage, before = processes(), known = new Set(roots.map(row => row.pid));
  requireInput(isDeepStrictEqual(coverageRoots(p), roots));
  for (let changed = true; changed;) {
    changed = false;
    for (const row of before) if (known.has(row.parent) && !known.has(row.pid)) { known.add(row.pid); changed = true; }
  }
  // Inspect the complete native owner, including HOME/config/cache/aliases, not
  // merely the executable prefix. The updater's socket can be the only socket.
  const owned = p.family === "agy" ? p.update.qualification.root : p.update.qualification.home;
  let output: string;
  try { output = execFileSync("/usr/sbin/lsof", ["-n", "-P", "-Fpn", "+D", owned], censusOptions); }
  catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1
      && "stdout" in error && error.stdout === "" && "stderr" in error && error.stderr === "") output = "";
    else throw error;
  }
  const seen = [...new Set(output.split("\n").filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
  const sockets: string[] = [], pending = [c.root];
  let count = 0;
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    directory(dir);
    for (const name of readdirSync(dir)) {
      requireInput(++count <= 200_000);
      const entry = join(dir, name), info = lstatSync(entry);
      requireInput(info.uid === process.getuid?.());
      if (info.isSymbolicLink()) requireInput(realpathSync(entry).startsWith(`${c.root}/`));
      else if (info.isDirectory()) pending.push(entry);
      else if (info.isSocket()) { requireInput((info.mode & 0o077) === 0); sockets.push(entry); }
      else requireInput(info.isFile() && (info.mode & 0o022) === 0);
    }
  }
  const after = processes();
  const incarnation = (pid: number) => {
    const a = before.find(row => row.pid === pid), b = after.find(row => row.pid === pid);
    return a !== undefined && isDeepStrictEqual(a, b) ? a : undefined;
  };
  return { installation: observeInstalled(p.update.qualification.installation), installerDigest: plan.installerDigest,
    mutationResources: plan.mutationResources,
    allSocketsKnown: isDeepStrictEqual([...sockets].sort(), [...c.registeredSockets].sort()),
    outsideConsumersKnown: roots.every(row => isDeepStrictEqual(incarnation(row.pid), row))
      && seen.every(pid => known.has(pid) && incarnation(pid) !== undefined),
    consumers: seen.map(pid => ({ consumerId: `${pid}:${incarnation(pid)?.start ?? "unknown"}`, binding: null,
      resources: plan.mutationResources, state: incarnation(pid) ? "running" as const : "unknown" as const })), busySafety: null };
}
function issue(p: NativeProfile, context: PrivateUpdateContext) {
  switch (p.family) {
    case "cursor": return createCursorUpdateSpec(context, "update-only", Date.now());
    case "agy": return createAgyUpdateSpec(context, "update-only", Date.now());
  }
}
/** Static product composition only: no executable probing, native client,
 * credential/session access or update dispatch at load. Latest reads use the
 * existing bounded official HTTP reader; acquired inputs do not renew authority. */
export async function loadNativeUpdateRuntime(context: PluginRuntimeContext, configurationPin: UpdateFilePin,
  value: unknown): Promise<PluginRuntimeLoad> {
  try {
    const input = validateNativeUpdateRuntimeInputs(value);
    requireInput(dataOnly(configurationPin), "configuration"); const config = pin(configurationPin);
    if (process.platform !== "darwin" || process.arch !== "arm64") return { kind: "unsupported", reason: "platform" };
    directory(dirname(config.path), true); directory(context.directory, true);
    requireInput(input.ownerDirectory === context.directory && (lstatSync(config.path).mode & 0o777) === 0o600
      && isDeepStrictEqual(document(config), input), "configuration");
    const profiles: NonNullable<UpdateOnlyRunnerConfiguration["profile"]>[] = [];
    const candidates: CatalogReaders["candidates"][number][] = [];
    const checks = new Map<string, NonNullable<CatalogReaders["check"]>>();
    for (const p of input.profiles) {
      const q = p.update.qualification, before = q.installation;
      const extra = p.family === "cursor" ? [p.update.qualification.manifest, p.update.qualification.beforeInstaller,
        ...p.update.qualification.expectedFiles.map(file => ({
          path: join(dirname(p.update.qualification.originalExecutable), file.path), sha256: file.sha256 }))]
        : [p.update.qualification.source, p.update.qualification.installer, p.update.qualification.target.manifest];
      const readPins = [config, p.update.receipt, p.provenance, p.expectedAfterPin, ...p.sourcePins, q.target.release];
      const sourcePins = [...readPins, q.target.archive, ...extra];
      const readFence = () => { for (const reference of readPins) requireInput(fileHash(reference.path) === reference.sha256); };
      const fence = () => {
        for (const reference of sourcePins) requireInput(fileHash(reference.path) === reference.sha256);
        // System tools may have root-owned hardlinks. They are revalidated by
        // the static issuer, not smuggled into the runner's owned-file pin set.
        for (const reference of q.dependencies) requireInput(fileHash(reference.path, true) === reference.sha256);
      };
      fence();
      const qualified = p.family === "cursor" ? await qualifyCursorUpdate(p.update, Date.now()) : await qualifyAgyUpdate(p.update, Date.now());
      requireInput(qualified.ok, "qualification");
      const initial = issue(p, qualified.value); requireInput(initial.ok, "qualification");
      const spec = initial.value, after = installation(document(p.expectedAfterPin)), mutationRoots = spec.mutationRoots;
      requireInput(isDeepStrictEqual(after, spec.expectedAfter) && !isDeepStrictEqual(after, before)
        && mutationRoots.length > 0 && mutationRoots.every(root => root.startsWith(`${p.coverage.root}/`))
        && sourcePins.every(reference => mutationRoots.every(root => reference.path !== root && !reference.path.startsWith(`${root}/`))));
      const provenance = document(p.provenance);
      requireInput(isDeepStrictEqual(provenance, { family: before.family, executable: before.executableRealpath,
        channel: before.channel, owner: before.owner, packageManifest: null,
        resources: before.resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })) }));
      observeInstalled(before);
      const roots = coverageRoots(p);
      const source: CheckSource = { installation: before, packageManifest: null, engineManifest: null, aliases: [],
        pins: before.resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7), mode: lstatSync(row.realpath).mode & 0o7777 })) };
      // Qualification alone replays the pinned acquisition method/body. Its
      // timestamp and expiry remain issuer inputs, never a fresh public check.
      const acquired = () => document(q.target.release);
      const readRelease = async (url: string, options?: { readonly method: "POST"; readonly body: string }): Promise<unknown> => {
        readFence();
        const r = p.family === "cursor"
          ? object(acquired(), ["method", "url", "request", "status", "response"])
          : object(acquired(), ["method", "url", "status", "checkedAt", "response"]);
        requireInput(r["url"] === url && r["status"] === 200 && r["method"] === (options?.method ?? "GET"));
        requireInput(p.family === "cursor" ? options?.body === JSON.stringify(r["request"])
          : options === undefined && r["checkedAt"] === q.target.checkedAt);
        return r["response"];
      };
      const latest = await checkNativeFamilyRelease(before, readRelease, q.target.checkedAt);
      requireInput(latest.kind !== "unavailable" && (latest.kind === "update-available"
        ? latest.availableVersion : latest.installedVersion) === q.target.version, "qualification");
      async function detect(executable: string): Promise<AdapterResult<InstallationIdentity>> {
        try {
          readFence(); requireInput(executable === before.executableRealpath);
          return { ok: true, value: observeInstalled(before) };
        } catch { return failed(); }
      }
      const checker = createCheckRuntime({ store: createCheckStore(context.directory),
        // User checks use the existing bounded, credential-free official HTTP
        // reader and actual completion clock, not the qualification's response.
        admit: async candidate => {
          if (!isDeepStrictEqual(candidate, source)) return failed();
          const result = await detect(before.executableRealpath); return result.ok ? { ok: true, value: null } : result;
        } });
      const adapter: FamilyAdapter = { family: p.family, detect,
        version: async identity => {
          if (!isDeepStrictEqual(identity, before)) return failed();
          const result = await detect(identity.executableRealpath);
          return result.ok ? { ok: true, value: result.value.installedVersion } : result;
        },
        check: identity => isDeepStrictEqual(identity, before)
          ? checker.check(source, AbortSignal.timeout(5000)) : Promise.resolve(failed()),
        updateSpec: (identity, mode) => {
          if (mode !== "update-only") return { ok: false, error: { code: "unsupported" } };
          try {
            fence(); requireInput(isDeepStrictEqual(identity, before)); observeInstalled(before);
            const current = issue(p, qualified.value);
            if (!current.ok) return current;
            requireInput(isDeepStrictEqual(current.value.expectedAfter, after)
              && isDeepStrictEqual(current.value.mutationRoots, mutationRoots));
            const intent = p.family === "cursor" ? getCursorUpdateIntent(current.value) : getAgyUpdateIntent(current.value);
            return intent.ok ? current : intent;
          } catch { return failed(); }
        },
        exactResume: () => ({ ok: false, error: { code: "unsupported" } }),
        bridge: () => ({ ok: false, error: { code: "unsupported" } }),
        gracefulExit: () => ({ ok: false, error: { code: "unsupported" } }) };
      const supported = { kind: "supported", reason: "verified", evidenceRef: p.update.receipt.path } as const;
      const contract: AdapterContract = { version: 1, family: p.family, installation: before, runtime: null,
        capabilities: { check: supported, update: supported, completion: unsupported,
          resume: unsupported, gracefulExit: unsupported, busySafe: unsupported } };
      candidates.push({ candidateId: `installed:${before.installationId}`, family: p.family, read: async () => {
        const current = await detect(before.executableRealpath);
        if (!current.ok) {
          try {
            fence();
            const observed = p.family === "agy" ? observeAgyUpdate(spec, Date.now()) : { ok: true as const, value: observeInstalled(after) };
            requireInput(observed.ok && isDeepStrictEqual(observed.value, after));
            return { ok: true as const, value: { contract: { ...contract, installation: after,
              capabilities: { ...contract.capabilities, update: unsupported } }, lastCheck: null } };
          } catch { return current; }
        }
        const last = await checker.lastCheck(source); if (!last.ok) return last;
        const authorized = adapter.updateSpec(before, "update-only");
        return { ok: true, value: { contract: { ...contract, capabilities: {
          ...contract.capabilities, update: authorized.ok ? supported : unsupported } }, lastCheck: last.value } };
      } });
      checks.set(before.installationId, (identity, signal) => isDeepStrictEqual(identity, before)
        ? checker.check(source, signal ?? AbortSignal.timeout(5000)) : Promise.resolve(failed()));
      profiles.push({ adapter, contract, sourcePins, expectedAfter: after, expectedAfterPin: p.expectedAfterPin, mutationRoots,
        observe: plan => {
          fence();
          requireInput(isDeepStrictEqual(plan.contract, contract) && plan.mode === "update-only" && plan.selectedTargets.length === 0
            && before.owner.kind === "native" && plan.installerDigest === before.owner.installerDigest
            && isDeepStrictEqual(plan.mutationResources, spec.mutationResources)
            && isDeepStrictEqual(plan.transition, { expectedAfter: after, mutationRoots }));
          const observation = observeResources(plan, p, roots); fence(); return observation;
        },
        observeAfter: () => {
          fence();
          switch (p.family) {
            case "agy": {
              const result = observeAgyUpdate(spec, Date.now()); requireInput(result.ok); return result.value;
            }
            case "cursor":
              requireInput(["agent", "cursor-agent"].every(name =>
                realpathSync(join(q.home, ".local/bin", name)) === after.executableRealpath));
              return observeInstalled(after);
          }
        } });
    }
    const readers: CatalogReaders = { candidates, sockets: [], check: (identity, signal) =>
      checks.get(identity.installationId)?.(identity, signal) ?? Promise.resolve(failed()) };
    let queue: MutationQueue | undefined;
    return { kind: "configured", readers, runner: { get queue() {
      return queue ??= new MutationQueue(join(context.directory, "mutations"));
    }, receiptRoot: context.directory, profiles } };
  } catch (error) {
    return { kind: "unsupported", reason: error instanceof PluginRuntimeError ? error.reason : "configuration" };
  }
}
