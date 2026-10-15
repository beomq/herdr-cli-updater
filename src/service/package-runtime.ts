import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { createPackageUpdateSpec, qualifyPackageUpdate, verifyPackageOpaqueNpmrc } from "../adapters/package-update";
import type { PackagePrefixSnapshot, PackageUpdateInput, PackageUpdateQualification } from "../adapters/package-update";
import { parseAdapterContract } from "../adapters/types";
import type { AdapterContract, AdapterResult, FamilyAdapter, InstallationIdentity } from "../adapters/types";
import { getPrivateUpdateIntent } from "../adapters/update-context";
import type { UpdateFilePin } from "../adapters/update-context";
import type { CatalogObservation, CatalogReaders } from "../catalog";
import { discoverExecutable } from "../discovery";
import { MutationQueue } from "../install/queue";
import type { ResourceObservation, ResourcePlan } from "../install/resources";
import { createCheckRuntime } from "./check-runtime";
import type { CheckSource } from "./check-runtime";
import { createCheckStore } from "./check-store";
import type { UpdateOnlyRunnerConfiguration } from "./job-runner";
import { PluginRuntimeError } from "./plugin-runtime";
import type { PluginRuntimeContext, PluginRuntimeLoad } from "./plugin-runtime";
import { discoverWorker } from "./worker";
import { composeCodexRuntime, parseCodexRuntimeInput } from "./codex-runtime";
import type { CodexRuntimeInput } from "./codex-runtime";
import { OperationFailure } from "../core/client";

// allow: SIZE_OK — the two-file ownership boundary keeps the private package
// composition and its strict persisted-data parser under one authority owner.
export const PACKAGE_RUNTIME_PROFILE = "qualified-package-update-only-v1" as const;
export const PACKAGE_OPERATING_RUNTIME_PROFILE = "qualified-npm-installation-update-only-v1" as const;
export type PackageRuntimeInputs = {
  readonly schemaVersion: 1;
  readonly profile: typeof PACKAGE_RUNTIME_PROFILE | typeof PACKAGE_OPERATING_RUNTIME_PROFILE;
  readonly ownerDirectory: string;
  readonly profiles: readonly {
    readonly update: PackageUpdateInput;
    /** Exactly one existing discovery receipt, plus immutable acquisition pins. */
    readonly sourcePins: readonly UpdateFilePin[];
    readonly expectedAfterPin: UpdateFilePin;
    readonly native?: CodexRuntimeInput;
    readonly acquiredReplies: readonly { readonly url: string; readonly status: 200; readonly body: UpdateFilePin }[];
    readonly coverage: {
      readonly root: string; readonly prefix: string; readonly socketDirectory: string;
      readonly registeredSockets: readonly string[]; readonly rootPids: readonly number[];
    };
  }[];
};
type Profile = PackageRuntimeInputs["profiles"][number];
const unsupported = { kind: "unsupported", reason: "not_verified" } as const;
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const failed = <T>(): AdapterResult<T> => ({ ok: false, error: { code: "stale_selection" } });
function requireInput(value: boolean, reason: PluginRuntimeError["reason"] = "inputs"): asserts value {
  if (!value) throw new PluginRuntimeError(reason);
}
function dataOnly(value: unknown, depth = 0): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (typeof value !== "object" || types.isProxy(value) || depth > 20) return false;
  const array = Array.isArray(value), keys = Reflect.ownKeys(value);
  return keys.length <= 200_001 && Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype)
    && (!array || keys.length === value.length + 1) && keys.every(key => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === "string" && key !== "toJSON" && d !== undefined && Object.hasOwn(d, "value")
        && (d.enumerable || (array && key === "length")) && dataOnly(d.value, depth + 1);
    });
}
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  requireInput(typeof value === "object" && value !== null && !Array.isArray(value), "configuration");
  const result = Object.fromEntries(Object.entries(value));
  requireInput(!keys || (Object.keys(result).length === keys.length && keys.every(key => Object.hasOwn(result, key))), "configuration");
  return result;
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
function pin(value: unknown): UpdateFilePin {
  const row = object(value, ["path", "sha256"]), sha256 = text(row["sha256"]);
  requireInput(/^[a-f0-9]{64}$/.test(sha256), "configuration");
  return { path: path(row["path"]), sha256 };
}
function installation(value: unknown): InstallationIdentity {
  const row = object(value);
  const parsed = parseAdapterContract({ version: 1, family: row["family"], installation: value, runtime: null,
    capabilities: { check: unsupported, update: unsupported, busySafe: unsupported,
      completion: unsupported, resume: unsupported, gracefulExit: unsupported } });
  requireInput(parsed.ok && parsed.value.installation.owner.kind === "package", "configuration");
  return parsed.value.installation;
}
function snapshot(value: unknown, opaquePath?: string): PackagePrefixSnapshot {
  const row = object(value);
  object(row, ["files", "links", ...(Object.hasOwn(row, "opaque") ? ["opaque"] : [])]);
  requireInput(row["opaque"] === undefined || opaquePath !== undefined, "configuration");
  const opaque = row["opaque"] === undefined ? undefined : list(row["opaque"], value => {
    const item = object(value, ["path", "dev", "ino", "uid", "nlink", "mode", "size", "mtimeNs", "ctimeNs"]);
    const decimal = (value: unknown) => {
      const result = text(value); requireInput(/^(0|[1-9]\d*)$/.test(result), "configuration"); return result;
    };
    const mode = integer(item["mode"]);
    requireInput(item["path"] === opaquePath && (mode === 0o600 || mode === 0o644)
      && item["nlink"] === "1", "configuration");
    return { path: path(item["path"]), dev: decimal(item["dev"]), ino: decimal(item["ino"]), uid: decimal(item["uid"]),
      nlink: decimal(item["nlink"]), mode, size: decimal(item["size"]), mtimeNs: decimal(item["mtimeNs"]),
      ctimeNs: decimal(item["ctimeNs"]) };
  }, 1);
  requireInput(opaque === undefined || opaque.length === 1, "configuration");
  return { files: list(row["files"], value => {
    const file = object(value, ["path", "sha256", "mode"]), sha256 = text(file["sha256"]), mode = integer(file["mode"]);
    requireInput(/^[a-f0-9]{64}$/.test(sha256) && mode <= 0o777, "configuration");
    return { path: text(file["path"]), sha256, mode };
  }, 200_000), links: list(row["links"], value => {
    const link = object(value, ["path", "target"]);
    return { path: text(link["path"]), target: text(link["target"]) };
  }, 200_000), ...(opaque ? { opaque } : {}) };
}
/** Pure data parsing only. No authority is conferred until worker qualification.
 * Getter/proxy/callback-bearing inputs are rejected before accessing their fields.
 */
export function validatePackageRuntimeInputs(value: unknown): PackageRuntimeInputs {
  requireInput(dataOnly(value), "configuration");
  const row = object(structuredClone(value), ["schemaVersion", "profile", "ownerDirectory", "profiles"]);
  const profile = row["profile"];
  requireInput(row["schemaVersion"] === 1
    && (profile === PACKAGE_RUNTIME_PROFILE || profile === PACKAGE_OPERATING_RUNTIME_PROFILE), "profile");
  const operating = profile === PACKAGE_OPERATING_RUNTIME_PROFILE;
  const profiles = list(row["profiles"], value => {
    const p = object(value);
    object(p, ["update", "sourcePins", "expectedAfterPin", "acquiredReplies", "coverage",
      ...(Object.hasOwn(p, "native") ? ["native"] : [])]);
    const update = object(p["update"], ["qualification", "receipt"]), q = object(update["qualification"]);
    object(q, ["installation", "manager", "env", "target", "before", "after", ...(Object.hasOwn(q, "afterLock") ? ["afterLock"] : []),
      ...(Object.hasOwn(q, "confinement") ? ["confinement"] : []), ...(Object.hasOwn(q, "home") ? ["home"] : [])]);
    const manager = object(q["manager"]), hasNode = Object.hasOwn(manager, "node");
    object(manager, ["name", "path", "sha256", "files", ...(hasNode ? ["node"] : [])]);
    const name = manager["name"];
    requireInput(name === "bun" || name === "npm", "profile");
    const env = object(q["env"], name === "bun" ? ["HOME", "PATH", "BUN_INSTALL"] : ["HOME", "PATH"]);
    const target = object(q["target"], ["packageName", "version", "channel", "checkedAt", "expiresAt", "artifacts", "postinstall"]);
    const coverage = object(p["coverage"], ["root", "prefix", "socketDirectory", "registeredSockets", "rootPids"]);
    const confinement = q["confinement"] === undefined ? undefined
      : object(q["confinement"], operating ? ["kind", "root", "system"] : ["root", "system"]);
    const system = confinement === undefined ? undefined : pin(confinement["system"]);
    requireInput(!system || system.path === "/usr/bin/sandbox-exec", "configuration");
    const home = q["home"] === undefined ? undefined : object(q["home"], ["before", "after"]);
    const selected = installation(q["installation"]);
    requireInput(!Object.hasOwn(p, "native") || ["codex", "omp", "pi", "claude"].includes(selected.family), "profile");
    const native = Object.hasOwn(p, "native") ? parseCodexRuntimeInput(p["native"]) : undefined;
    requireInput(!operating || (confinement?.["kind"] === "operating-prefix" && name === "npm"
      && selected.family === "codex" && selected.owner.kind === "package" && selected.owner.manager === "npm"
      && home === undefined), "profile");
    const managerPath = path(manager["path"]), managerRoot = dirname(dirname(managerPath));
    const opaquePath = operating && selected.owner.kind === "package"
      && managerPath === join(managerRoot, "bin/npm-cli.js")
      && managerRoot === join(selected.owner.prefix, "lib/node_modules/npm") ? join(managerRoot, ".npmrc") : undefined;
    const before = snapshot(q["before"], opaquePath), after = snapshot(q["after"], opaquePath);
    requireInput(isDeepStrictEqual(before.opaque, after.opaque), "configuration");
    return { update: { receipt: pin(update["receipt"]), qualification: {
      installation: selected,
      manager: { name, ...pin({ path: manager["path"], sha256: manager["sha256"] }),
        files: list(manager["files"], pin, 200_000), ...(hasNode ? { node: pin(manager["node"]) } : {}) },
      env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, text(value)])),
      target: { packageName: text(target["packageName"]), version: text(target["version"]), channel: text(target["channel"]),
        checkedAt: integer(target["checkedAt"]), expiresAt: integer(target["expiresAt"]),
        artifacts: list(target["artifacts"], value => {
          const a = object(value, ["name", "installName", "version", "archive", "metadata"]);
          return { name: text(a["name"]), installName: text(a["installName"]), version: text(a["version"]),
            archive: pin(a["archive"]), metadata: pin(a["metadata"]) };
        }), postinstall: list(target["postinstall"], pin, 200_000) },
      before, after,
      ...(Object.hasOwn(q, "afterLock") ? { afterLock: pin(q["afterLock"]) } : {}),
      ...(confinement && system ? { confinement: { root: path(confinement["root"]),
        ...(operating ? { kind: "operating-prefix" as const } : {}),
        system: { path: "/usr/bin/sandbox-exec" as const, sha256: system.sha256 } } } : {}),
      ...(home ? { home: { before: snapshot(home["before"]), after: snapshot(home["after"]) } } : {}) } },
      sourcePins: list(p["sourcePins"], pin), expectedAfterPin: pin(p["expectedAfterPin"]),
      ...(native ? { native } : {}),
      acquiredReplies: list(p["acquiredReplies"], value => {
        const reply = object(value, ["url", "status", "body"]);
        requireInput(reply["status"] === 200, "configuration");
        return { url: text(reply["url"]), status: 200 as const, body: pin(reply["body"]) };
      }, 32),
      coverage: { root: path(coverage["root"]), prefix: path(coverage["prefix"]), socketDirectory: path(coverage["socketDirectory"]),
        registeredSockets: list(coverage["registeredSockets"], path), rootPids: list(coverage["rootPids"], integer) } } satisfies Profile;
  }, 32);
  requireInput(profiles.length > 0 && new Set(profiles.map(p => p.update.qualification.installation.installationId)).size === profiles.length,
    "configuration");
  return { schemaVersion: 1, profile, ownerDirectory: path(row["ownerDirectory"]), profiles };
}
function privateDirectory(value: string): void {
  const info = lstatSync(value);
  requireInput(realpathSync(value) === value && info.isDirectory() && info.uid === process.getuid?.()
    && (info.mode & 0o777) === 0o700, "configuration");
}
/** Streaming payload reads retain inode/byte guards without allocating native
 * binaries. Hardlinks are allowed only for payload, never control/source pins.
 */
function fileHash(value: string, singleLink = true): string {
  requireInput(!value.endsWith("/.npmrc") && realpathSync(value) === value);
  const fd = openSync(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    requireInput(before.isFile() && before.uid === BigInt(process.getuid?.() ?? -1)
      && (!singleLink || before.nlink === 1n) && (before.mode & 0o022n) === 0n && before.size <= 2n * 1024n ** 3n);
    const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < Number(before.size);) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      requireInput(count > 0); digest.update(buffer.subarray(0, count)); offset += count;
    }
    const after = fstatSync(fd, { bigint: true }), entry = lstatSync(value, { bigint: true });
    requireInput([after, entry].every(info => info.dev === before.dev && info.ino === before.ino && info.size === before.size
      && info.mode === before.mode && info.mtimeNs === before.mtimeNs && info.ctimeNs === before.ctimeNs) && realpathSync(value) === value);
    return digest.digest("hex");
  } finally { closeSync(fd); }
}
function verifyPin(pin: UpdateFilePin): void { requireInput(fileHash(pin.path) === pin.sha256); }
function document(pin: UpdateFilePin, limit = 64 * 1024 * 1024): unknown {
  requireInput(lstatSync(pin.path).size <= limit); verifyPin(pin);
  const body = readFileSync(pin.path); requireInput(hash(body) === pin.sha256); verifyPin(pin);
  return JSON.parse(body.toString("utf8"));
}
function observeInstalled(expected: InstallationIdentity, inventory: PackagePrefixSnapshot,
  q: PackageUpdateQualification, wholePrefix = true): InstallationIdentity {
  const owner = expected.owner;
  requireInput(owner.kind === "package");
  const opaquePath = verifyPackageOpaqueNpmrc(q);
  const seenFiles = new Set<string>(), seenLinks = new Set<string>();
  const files = new Map(inventory.files.map(row => [row.path, row])), links = new Map(inventory.links.map(row => [row.path, row]));
  requireInput(files.size === inventory.files.length && links.size === inventory.links.length && files.size > 0);
  const pending = wholePrefix ? [owner.prefix] : [];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    requireInput(realpathSync(dir) === dir);
    for (const name of readdirSync(dir)) {
      const file = join(dir, name), local = file.slice(owner.prefix.length + 1), info = lstatSync(file);
      if (file === opaquePath) continue;
      requireInput(name !== ".npmrc");
      requireInput(info.uid === process.getuid?.() && (info.isSymbolicLink() || (info.mode & 0o022) === 0));
      if (info.isDirectory()) pending.push(file);
      else if (info.isSymbolicLink()) {
        requireInput(links.get(local)?.target === readlinkSync(file) && realpathSync(file).startsWith(`${owner.prefix}/`));
        seenLinks.add(local);
      } else {
        const row = files.get(local);
        requireInput(row !== undefined && (info.mode & 0o777) === row.mode && fileHash(file, /(?:^|\/)(?:package\.json|.*lock|\.npmrc|.*bunfig.*)$/.test(local)) === row.sha256);
        seenFiles.add(local);
      }
    }
  }
  requireInput(!wholePrefix || (seenFiles.size === files.size && seenLinks.size === links.size));
  if (!wholePrefix) for (const link of inventory.links) {
    const entry = join(owner.prefix, link.path);
    requireInput(lstatSync(entry).isSymbolicLink() && readlinkSync(entry) === link.target
      && realpathSync(entry) === realpathSync(resolve(dirname(entry), link.target)));
  }
  const manifest = join(owner.prefix, owner.manager === "bun" ? "install/global" : "lib", "node_modules", owner.packageName, "package.json");
  const pin = files.get(manifest.slice(owner.prefix.length + 1));
  requireInput(pin !== undefined);
  const pkg = object(document({ path: manifest, sha256: pin.sha256 }, 262144));
  const bin = typeof pkg["bin"] === "string" ? pkg["bin"] : object(pkg["bin"])[expected.family];
  requireInput(pkg["name"] === owner.packageName && typeof bin === "string"
    && realpathSync(resolve(dirname(manifest), bin)) === expected.executableRealpath
    && realpathSync(join(owner.prefix, "bin", expected.family)) === expected.executableRealpath);
  const resources = expected.resources.map(row => {
    const current = files.get(row.realpath.slice(owner.prefix.length + 1));
    requireInput(row.realpath.startsWith(`${owner.prefix}/`) && current !== undefined
      && row.resourceId === `resource:${hash(row.realpath)}`);
    requireInput((lstatSync(row.realpath).mode & 0o777) === current.mode);
    return { ...row, fingerprint: `sha256:${wholePrefix ? current.sha256 : fileHash(row.realpath, false)}` };
  });
  return { ...expected, installedVersion: { kind: "known", version: text(pkg["version"]) },
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
}
function observeHome(home: string, inventory: PackagePrefixSnapshot): void {
  privateDirectory(home);
  const files = new Map(inventory.files.map(row => [join(home, row.path), row]));
  const links = new Map(inventory.links.map(row => [join(home, row.path), row]));
  const pending = [home];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), info = lstatSync(path);
      requireInput(info.uid === process.getuid?.());
      if (info.isDirectory()) { requireInput(realpathSync(path) === path); pending.push(path); }
      else if (info.isSymbolicLink()) {
        const expected = links.get(path);
        requireInput(expected !== undefined && readlinkSync(path) === expected.target && realpathSync(path).startsWith(`${home}/`));
        links.delete(path);
      } else {
        const expected = files.get(path);
        requireInput(expected !== undefined && (info.mode & 0o777) === expected.mode
          && fileHash(path, /(?:^|\/)(?:config\.toml|package\.json|.*lock)$/.test(path)) === expected.sha256);
        files.delete(path);
      }
    }
  }
  requireInput(files.size === 0 && links.size === 0);
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
function coverageRoots(profile: Profile) {
  const c = profile.coverage, q = profile.update.qualification, owner = q.installation.owner;
  const operating = q.confinement?.kind === "operating-prefix";
  privateDirectory(c.root); privateDirectory(c.socketDirectory);
  if (operating) {
    const info = lstatSync(c.prefix), mode = info.mode & 0o7777;
    requireInput(q.confinement?.root === c.root && info.isDirectory() && info.uid === process.getuid?.()
      && (mode === 0o755 || mode === 0o700) && c.prefix !== c.root
      && !c.prefix.startsWith(`${c.root}/`) && !c.root.startsWith(`${c.prefix}/`));
  } else privateDirectory(c.prefix);
  const home = q.env["HOME"];
  requireInput(home !== undefined && home.startsWith(`${c.root}/`) && home !== c.prefix
    && !home.startsWith(`${c.prefix}/`) && (!operating || home === join(c.root, "home")));
  privateDirectory(home);
  requireInput(owner.kind === "package" && owner.prefix === c.prefix && (operating || c.prefix.startsWith(`${c.root}/`))
    && realpathSync(c.prefix) === c.prefix && c.rootPids.length > 0 && c.registeredSockets.length > 0
    && new Set(c.rootPids).size === c.rootPids.length && new Set(c.registeredSockets).size === c.registeredSockets.length
    && c.registeredSockets.every(socket => socket.startsWith(`${c.socketDirectory}/`)));
  const census = processes();
  return c.rootPids.map(pid => {
    const row = census.find(row => row.pid === pid);
    requireInput(row !== undefined && pid > 1 && row.uid === process.getuid?.());
    return row;
  });
}
type ControlAlias = { readonly path: string; readonly target: string };
function socketCensus(directory: string, control?: ControlAlias): string[] {
  const sockets: string[] = [], pending = [directory];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    requireInput(realpathSync(dir) === dir);
    for (const name of readdirSync(dir)) {
      const entry = join(dir, name), info = lstatSync(entry);
      requireInput(info.uid === process.getuid?.());
      if (info.isSymbolicLink()) {
        requireInput(control !== undefined && entry === control.path
          && resolve(dirname(entry), readlinkSync(entry)) === control.target);
      } else if (info.isDirectory()) pending.push(entry);
      else if (info.isSocket()) sockets.push(entry);
    }
  }
  return sockets;
}
/** The loading worker already owns these coordinates. Its private owner record,
 * current process identity and socket inodes bind this incarnation without reading
 * the capability token or accepting preparation-time socket names as authority.
 */
function operatingWorker(context: PluginRuntimeContext) {
  const ownerPath = join(context.directory, "owner.json");
  requireInput((lstatSync(ownerPath).mode & 0o777) === 0o600, "configuration");
  const ownerPin = { path: ownerPath, sha256: fileHash(ownerPath) }, owner = discoverWorker(context.directory);
  requireInput(isDeepStrictEqual(document(ownerPin), owner) && owner.pid === process.pid
    && owner.executableRealpath === realpathSync(process.execPath), "configuration");
  // Darwin/Bun cannot realpath some Unix socket entries (EOPNOTSUPP). The
  // canonical private parent plus a non-link socket leaf proves the same path.
  const control: ControlAlias = { path: owner.controlPath, target: lstatSync(owner.controlPath).isSymbolicLink()
    ? resolve(context.directory, readlinkSync(owner.controlPath)) : owner.controlPath };
  requireInput(control.target === owner.controlPath
    || control.target === join(context.directory, `c${owner.incarnation.slice(0, 8)}`), "configuration");
  const registeredSockets = [owner.socketPath, control.target];
  const identities = registeredSockets.map(path => ({ path, info: lstatSync(path) }));
  const verify = () => {
    privateDirectory(context.directory);
    requireInput((lstatSync(ownerPath).mode & 0o777) === 0o600);
    verifyPin(ownerPin);
    const alias = lstatSync(control.path);
    requireInput(alias.uid === process.getuid?.()
      && (alias.isSymbolicLink() ? resolve(context.directory, readlinkSync(control.path)) : control.path) === control.target);
    for (const { path, info } of identities) {
      const current = lstatSync(path);
      requireInput(realpathSync(dirname(path)) === dirname(path) && current.isSocket() && current.uid === process.getuid?.()
        && (current.mode & 0o777) === 0o600 && current.dev === info.dev && current.ino === info.ino);
    }
  };
  verify();
  requireInput(isDeepStrictEqual(socketCensus(context.directory, control).sort(), [...registeredSockets].sort()), "configuration");
  return { ownerPin, control, registeredSockets, verify };
}
function observeResources(plan: ResourcePlan, profile: Profile, roots: ReturnType<typeof coverageRoots>,
  control?: ControlAlias): ResourceObservation {
  const c = profile.coverage, current = coverageRoots(profile);
  requireInput(isDeepStrictEqual(current, roots) && isDeepStrictEqual(plan.contract.installation, profile.update.qualification.installation));
  const q = profile.update.qualification, home = q.env["HOME"];
  const installed = observeInstalled(plan.contract.installation, q.before, q);
  if (q.home) { requireInput(home !== undefined); observeHome(home, q.home.before); }
  const mutationResources = [...installed.resources, { resourceId: `resource:${hash(c.prefix)}`, realpath: c.prefix,
    fingerprint: `sha256:${hash(JSON.stringify(profile.update.qualification.before))}` },
    ...(q.home && home ? [{ resourceId: `resource:${hash(home)}`, realpath: home,
      fingerprint: `sha256:${hash(JSON.stringify(q.home.before))}` }] : [])];
  requireInput(isDeepStrictEqual(plan.mutationResources, mutationResources));
  const before = processes(), known = new Set(roots.map(row => row.pid));
  for (let changed = true; changed;) {
    changed = false;
    for (const row of before) if (known.has(row.parent) && !known.has(row.pid)) { known.add(row.pid); changed = true; }
  }
  let output: string, complete = true;
  try { output = execFileSync("/usr/sbin/lsof", ["-n", "-P", "-Fpn", "+D", q.home ? c.root : c.prefix], censusOptions); }
  catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1
      && "stdout" in error && typeof error.stdout === "string" && "stderr" in error && error.stderr === "") {
      output = error.stdout;
      // Darwin can return partial records with status 1. Keep the observed
      // consumers as blockers, but never promote partial output to coverage.
      complete = output === "";
    }
    else throw error;
  }
  const seen = [...new Set(output.split("\n").filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
  const sockets = socketCensus(c.socketDirectory, control);
  const after = processes();
  const incarnation = (pid: number) => {
    const a = before.find(row => row.pid === pid), b = after.find(row => row.pid === pid);
    return a !== undefined && isDeepStrictEqual(a, b) ? a : undefined;
  };
  return { installation: installed, installerDigest: plan.installerDigest, mutationResources,
    allSocketsKnown: sockets.length > 0 && isDeepStrictEqual([...sockets].sort(), [...c.registeredSockets].sort()),
    outsideConsumersKnown: complete && roots.every(row => isDeepStrictEqual(incarnation(row.pid), row))
      && seen.every(pid => known.has(pid) && incarnation(pid)?.uid === process.getuid?.()),
    consumers: seen.map(pid => ({ consumerId: `${pid}:${hash(incarnation(pid)?.start ?? "unknown")}`, binding: null,
      resources: mutationResources, state: incarnation(pid) ? "running" as const : "unknown" as const })), busySafety: null };
}
/** The existing issuer alone grants installation update authority. Optional
 * Codex targets require a separately authenticated, fresh native composition.
 */
export async function loadPackageRuntime(context: PluginRuntimeContext, configurationPin: UpdateFilePin, value: unknown,
  request?: (request: Request) => Promise<Response>): Promise<PluginRuntimeLoad> {
  try {
    const input = validatePackageRuntimeInputs(value), config = pin(configurationPin);
    if (process.platform !== "darwin") return { kind: "unsupported", reason: "platform" };
    privateDirectory(dirname(config.path)); privateDirectory(context.directory);
    requireInput((lstatSync(config.path).mode & 0o777) === 0o600
      && input.ownerDirectory === context.directory && isDeepStrictEqual(document(config), input), "configuration");
    const worker = input.profile === PACKAGE_OPERATING_RUNTIME_PROFILE ? operatingWorker(context) : undefined;
    const profiles: NonNullable<UpdateOnlyRunnerConfiguration["profile"]>[] = [];
    const candidates: CatalogReaders["candidates"][number][] = [];
    const runtimeSources: NonNullable<CatalogReaders["runtimeSources"]>[number][] = [];
    const checks = new Map<string, NonNullable<CatalogReaders["check"]>>();
    for (const persisted of input.profiles) {
      requireInput(!worker || persisted.coverage.socketDirectory === context.directory, "configuration");
      const p = worker ? { ...persisted,
        coverage: { ...persisted.coverage, registeredSockets: worker.registeredSockets } } : persisted;
      const q = p.update.qualification, before = q.installation;
      const readPins = [config, p.update.receipt, p.expectedAfterPin, ...p.sourcePins, ...p.acquiredReplies.map(row => row.body),
        ...(p.native ? [p.native.sourceBinding, p.native.node] : []),
        ...(worker ? [worker.ownerPin] : [])];
      const sourcePins = [...readPins, q.manager, ...q.manager.files, ...(q.manager.node ? [q.manager.node] : []),
        ...q.target.artifacts.flatMap(a => [a.archive, a.metadata]), ...(q.afterLock ? [q.afterLock] : [])];
      const fence = () => { worker?.verify(); verifyPackageOpaqueNpmrc(q); for (const pin of sourcePins) verifyPin(pin); };
      const readFence = () => { worker?.verify(); verifyPackageOpaqueNpmrc(q); for (const pin of readPins) verifyPin(pin); };
      fence();
      const after = installation(document(p.expectedAfterPin));
      requireInput(before.owner.kind === "package" && after.installedVersion.kind === "known"
        && after.installedVersion.version === q.target.version && after.installationId === before.installationId
        && after.executableRealpath === before.executableRealpath && after.family === before.family && after.channel === before.channel
        && isDeepStrictEqual(after.owner, before.owner) && after.resourcesFingerprint === `sha256:${hash(JSON.stringify(after.resources))}`
        && after.resources.every(row => row.realpath.startsWith(`${before.owner.kind === "package" ? before.owner.prefix : ""}/`)
          && q.after.files.some(file => join(p.coverage.prefix, file.path) === row.realpath && row.fingerprint === `sha256:${file.sha256}`))
        && after.resources.some(row => row.realpath === after.executableRealpath));
      const provenance = p.sourcePins.filter(pin => {
        if (lstatSync(pin.path).size > 65536) return false;
        try {
          const row = object(document(pin, 65536));
          return isDeepStrictEqual(Object.keys(row).sort(), ["channel", "executable", "family", "owner", "packageManifest", "resources"]);
        } catch (error) { if (error instanceof SyntaxError) return false; throw error; }
      });
      requireInput(provenance.length === 1 && isDeepStrictEqual(observeInstalled(before, q.before, q), before));
      const qualified = await qualifyPackageUpdate(p.update, Date.now());
      fence(); requireInput(qualified.ok, "qualification");
      const roots = coverageRoots(p);
      const native = p.native ? await composeCodexRuntime(p.native, { context, installation: before, fence: readFence,
        observeBefore: () => observeInstalled(before, q.before, q, false),
        observeAfter: () => { fence(); return observeInstalled(after, q.after, q); } }) : undefined;
      const manifest = join(before.owner.prefix, q.manager.name === "bun" ? "install/global" : "lib", "node_modules", q.target.packageName, "package.json");
      const source: CheckSource = { installation: before, packageManifest: manifest, engineManifest: null,
        pins: before.resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7), mode: lstatSync(row.realpath).mode & 0o7777 })),
        aliases: q.before.links.map(link => ({ path: join(p.coverage.prefix, link.path),
          target: realpathSync(join(p.coverage.prefix, link.path)) })) };
      async function detect(executable: string): Promise<AdapterResult<InstallationIdentity>> {
        try {
          readFence();
          if (executable !== before.executableRealpath || !isDeepStrictEqual(observeInstalled(before, q.before, q, false), before)) return failed();
          const result = await discoverExecutable({ executable, family: before.family, provenance });
          readFence();
          if (!result.ok || result.value.qualification.kind !== "known") return failed();
          const observed = result.value.installation;
          const resources = observed.resources.filter(row => before.resources.some(expected => expected.realpath === row.realpath)
            || !provenance.some(pin => pin.path === row.realpath));
          const selected = { ...observed, resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
          return isDeepStrictEqual(selected, before) ? { ok: true, value: selected } : failed();
        } catch { return failed(); }
      }
      const checker = createCheckRuntime({ store: createCheckStore(context.directory),
        admit: async candidate => {
          if (!isDeepStrictEqual(candidate, source)) return failed();
          const result = await detect(before.executableRealpath);
          return result.ok ? { ok: true, value: null } : result;
        }, ...(request ? { request } : {}) });
      const adapter: FamilyAdapter = { family: before.family, detect,
        check: async identity => isDeepStrictEqual(identity, before) ? checker.check(source, AbortSignal.timeout(5000)) : failed(),
        version: async identity => {
          if (!isDeepStrictEqual(identity, before)) return failed();
          const result = await detect(identity.executableRealpath);
          return result.ok ? { ok: true, value: result.value.installedVersion } : result;
        },
        updateSpec: (identity, mode) => {
          // Installation update and later session restart remain separate. The
          // current runner's combined freshness path is OmO-only.
          if (mode !== "update-only") return { ok: false, error: { code: "unsupported" } };
          try {
            fence();
            if (!isDeepStrictEqual(identity, before) || !isDeepStrictEqual(observeInstalled(before, q.before, q), before)) return failed();
            const spec = createPackageUpdateSpec(qualified.value, mode, Date.now());
            if (!spec.ok) return spec;
            const intent = getPrivateUpdateIntent(spec.value);
            return intent.ok ? spec : intent;
          } catch { return failed(); }
        },
        exactResume: () => ({ ok: false, error: { code: "unsupported" } }),
        bridge: () => ({ ok: false, error: { code: "unsupported" } }),
        gracefulExit: () => ({ ok: false, error: { code: "unsupported" } }) };
      const checked = await adapter.check(before);
      fence(); requireInput(checked.ok && checked.value.kind === "update-available"
        && checked.value.availableVersion === q.target.version, "qualification");
      const supported = { kind: "supported", reason: "verified", evidenceRef: p.update.receipt.path } as const;
      const contract: AdapterContract = { version: 1, family: before.family, installation: before, runtime: null,
        capabilities: { check: supported, update: supported, completion: unsupported, resume: unsupported,
          gracefulExit: unsupported, busySafe: unsupported } };
      const runtimeContract: AdapterContract = native ? { ...contract, runtime: native.runtime,
        capabilities: { ...contract.capabilities, completion: supported, resume: supported, gracefulExit: supported } } : contract;
      if (native) runtimeSources.push({ socketId: native.runtime.binding.socketId, read: async () => {
        const current = await native.lifecycle.inspect(native.target, AbortSignal.timeout(5000));
        if (!current.ok) return current;
        const last = await checker.lastCheck(source);
        return last.ok ? { ok: true, value: { kind: "observed", observations: [{ contract: runtimeContract, lastCheck: last.value }] } } : last;
      } });
      candidates.push({ candidateId: `installed:${before.installationId}`, family: before.family,
        read: async (): Promise<AdapterResult<CatalogObservation>> => {
          const result = await detect(before.executableRealpath);
          if (!result.ok) {
            try {
              fence(); if (q.home) observeHome(text(q.env["HOME"]), q.home.after);
              const current = observeInstalled(after, q.after, q);
              requireInput(isDeepStrictEqual(current, after));
              return { ok: true, value: { contract: { ...contract, installation: current,
                capabilities: { ...contract.capabilities, update: unsupported } }, lastCheck: null } };
            } catch { return result; }
          }
          const last = await checker.lastCheck(source);
          return last.ok ? { ok: true, value: { contract, lastCheck: last.value } } : last;
        } });
      checks.set(before.installationId, (identity, signal) => isDeepStrictEqual(identity, before)
        ? checker.check(source, signal ?? AbortSignal.timeout(5000)) : Promise.resolve(failed()));
      profiles.push({ adapter, contract: runtimeContract, ...(native ? { lifecycle: native.lifecycle } : {}),
        sourcePins, expectedAfter: after, expectedAfterPin: p.expectedAfterPin,
        mutationRoots: q.home ? [p.coverage.prefix, text(q.env["HOME"])] : [p.coverage.prefix],
        ...(q.home && q.confinement ? { mutationScopeRoot: q.confinement.root } : {}),
        observe: plan => { fence(); return observeResources(plan, p, roots, worker?.control); },
        observeAfter: () => { fence(); if (q.home) observeHome(text(q.env["HOME"]), q.home.after);
          return observeInstalled(after, q.after, q); } });
    }
    const readers: CatalogReaders = { candidates, sockets: [], runtimeSources, check: (identity, signal) =>
      checks.get(identity.installationId)?.(identity, signal) ?? Promise.resolve(failed()) };
    return { kind: "configured", readers, runner: { queue: new MutationQueue(`${context.directory}-mutations`),
      receiptRoot: context.directory, profiles } };
  } catch (error) {
    return { kind: "unsupported", reason: error instanceof PluginRuntimeError ? error.reason
      : error instanceof OperationFailure ? "native" : "configuration" };
  }
}
