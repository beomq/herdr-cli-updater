import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { createGunzip } from "node:zlib";
import { homedir } from "node:os";
import type { OmoUpdateExecutor, UpdateFilePin } from "./update-context";
import type { AdapterResult, InstallationIdentity, Mode, PrivateUpdateCommand, PrivateUpdateContext,
  PrivateUpdateIntent, PrivateUpdateObservation, UpdateSpec } from "./types";

/** Private acquisition records, not public request DTOs. The receipt is separately
 * pinned by the trusted producer exactly as for OmoUpdateInput. Family labels
 * select a closed grammar; they do not authenticate an installation or manager.
 */
export type PackageArtifact = {
  readonly name: string;
  /** Physical node_modules slot; npm aliases retain their registry name above. */
  readonly installName: string;
  readonly version: string;
  readonly archive: UpdateFilePin;
  readonly metadata: UpdateFilePin;
};
export type PackagePrefixSnapshot = {
  /** Complete original prefix inventory, relative to that same selected prefix.
   * Payload files may be hardlinked; private manifests/config/locks may not.
   * mode is the original permission bits (stat.mode & 0777).
   */
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly mode: number }[];
  readonly links: readonly { readonly path: string; readonly target: string }[];
  /** Only the operating npm/Codex manager's root .npmrc. Never content pins.
   * Absolute canonical path and lossless bigint stat fields survive JSON. */
  readonly opaque?: readonly PackageOpaqueNpmrc[];
};
export type PackageOpaqueNpmrc = {
  readonly path: string;
  readonly dev: string; readonly ino: string; readonly uid: string; readonly nlink: string;
  readonly mode: number; readonly size: string; readonly mtimeNs: string; readonly ctimeNs: string;
};
export type PackageUpdateQualification = {
  readonly installation: InstallationIdentity;
  readonly manager: UpdateFilePin & {
    readonly name: "bun" | "npm";
    /** Original Node runtime used by npm and/or package lifecycle scripts. */
    readonly node?: UpdateFilePin;
    /** npm's complete canonical installation files, including npm-cli.js.
     * Empty for a standalone Bun executable. Not a PATH-selected npm command.
     */
    readonly files: readonly UpdateFilePin[];
  };
  /** Exact HOME/PATH, plus BUN_INSTALL for Bun; no ambient environment merging. */
  readonly env: Readonly<Record<string, string>>;
  readonly target: {
    readonly packageName: string;
    readonly version: string;
    readonly channel: string;
    readonly checkedAt: number;
    readonly expiresAt: number;
    readonly artifacts: readonly PackageArtifact[];
    /** Independently acquired original generated/modified postinstall outputs. */
    readonly postinstall: readonly UpdateFilePin[];
  };
  /** Original exact-manager calibration from the ACTUAL before layout.
   * afterLock is the independently acquired canonical original Bun lock (npm
   * does not necessarily have a global lock); never a synthetic global manifest.
   */
  readonly before: PackagePrefixSnapshot;
  readonly after: PackagePrefixSnapshot;
  readonly afterLock?: UpdateFilePin;
  /** Optional for controlled fixtures; production native lifecycle callers must
   * supply this original owned root. Only the child, never its worker, is jailed.
   */
  readonly confinement?: {
    /** Explicit npm Codex installation outside the private preparation root. */
    readonly kind?: "operating-prefix";
    readonly root: string;
    readonly system: UpdateFilePin & { readonly path: "/usr/bin/sandbox-exec" };
  };
  /** Complete original HOME inventory (paths relative to env.HOME), currently
   * admitted only for Grok's .grok outputs, never inferred from a callback.
   */
  readonly home?: {
    readonly before: PackagePrefixSnapshot;
    readonly after: PackagePrefixSnapshot;
  };
};
export type PackageUpdateInput = {
  readonly qualification: PackageUpdateQualification;
  readonly receipt: UpdateFilePin;
};

const families = {
  claude: { packageName: "@anthropic-ai/claude-code", bin: "claude" },
  codex: { packageName: "@openai/codex", bin: "codex" },
  omp: { packageName: "@oh-my-pi/pi-coding-agent", bin: "omp" },
  grok: { packageName: "@xai-official/grok", bin: "grok" },
} as const;
const contexts = new WeakMap<PrivateUpdateContext, PackageUpdateInput>();
const issued = new WeakMap<UpdateSpec, {
  readonly input: PackageUpdateInput; readonly snapshot: UpdateSpec; readonly context: PrivateUpdateContext;
  readonly intent: PrivateUpdateIntent; used: boolean;
}>();
const usedContexts = new WeakSet<PrivateUpdateContext>();
const operations = new Set<string>();
const hash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const absolute = (path: string): path is `/${string}` => path.startsWith("/") && normalize(path) === path
  && !/[\u0000-\u001f\u007f\\]/.test(path);
const relative = (path: string) => path.length > 0 && !path.startsWith("/")
  && !/[\u0000-\u001f\u007f\\]/.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
const packageName = (name: string) => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name);
const version = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value);
const maxFile = 2 * 1024 * 1024 * 1024;
const maxTree = 16 * maxFile;
const maxEntries = 200_000;
const configNames = new Set([".npmrc", ".bunfig.toml", "bunfig.toml", ".env",
  ".env.local", ".env.production", ".env.development"]);
class PackageFailure extends Error { constructor() { super("verification_failed"); } }
function valid(condition: boolean): asserts condition { if (!condition) throw new PackageFailure(); }
/** lstat/realpath only: opening this file, even just to hash it, is forbidden. */
export function snapshotPackageOpaqueNpmrc(path: string): PackageOpaqueNpmrc {
  valid(absolute(path) && path.endsWith("/.npmrc") && realpathSync(path) === path);
  const info = lstatSync(path, { bigint: true }), mode = Number(info.mode & 0o7777n);
  valid(info.isFile() && info.uid === BigInt(process.getuid?.() ?? -1) && info.nlink === 1n
    && (mode === 0o600 || mode === 0o644) && info.size <= BigInt(maxFile));
  return { path, dev: String(info.dev), ino: String(info.ino), uid: String(info.uid), nlink: String(info.nlink),
    mode, size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
}
/** The marker is not authority: derive its only possible path from npm-cli.js.
 * Both inventories must preserve the same original inode and nanosecond stats. */
export function verifyPackageOpaqueNpmrc(q: PackageUpdateQualification): string | undefined {
  const before = q.before.opaque, after = q.after.opaque;
  valid(q.home?.before.opaque === undefined && q.home?.after.opaque === undefined);
  if (before === undefined && after === undefined) return undefined;
  const owner = q.installation.owner, managerRoot = dirname(dirname(q.manager.path));
  valid(q.confinement?.kind === "operating-prefix" && q.installation.family === "codex"
    && q.manager.name === "npm" && owner.kind === "package" && owner.manager === "npm"
    && q.manager.path === join(managerRoot, "bin/npm-cli.js")
    && managerRoot === join(owner.prefix, "lib/node_modules/npm")
    && before?.length === 1 && after?.length === 1 && isDeepStrictEqual(before, after));
  const path = join(managerRoot, ".npmrc"), row = before[0];
  valid(row !== undefined && row.path === path && isDeepStrictEqual(row, snapshotPackageOpaqueNpmrc(path)));
  const local = path.slice(owner.prefix.length + 1);
  for (const snapshot of [q.before, q.after])
    valid(!snapshot.files.some(file => file.path === local) && !snapshot.links.some(link => link.path === local));
  valid(!q.manager.files.some(file => file.path === path));
  return path;
}
const failure = <T>(code: "verification_failed" | "recovery_required" | "update_failed" = "verification_failed"): AdapterResult<T> =>
  ({ ok: false, error: { code } });
function object(value: unknown): Record<string, unknown> {
  valid(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function dataOnly(value: unknown, depth = 0): boolean {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) return true;
  if (typeof value !== "object" || types.isProxy(value) || depth > 20) return false;
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && descriptor !== undefined && Object.hasOwn(descriptor, "value")
      && (descriptor.enumerable || (array && key === "length")) && dataOnly(descriptor.value, depth + 1);
  });
}
/** Large native leaves are hashed through a bounded buffer. nlink is intentionally
 * not relaxed for control files: payload hardlinks are read, never overwritten by
 * this module, while config/lock writes require single-link canonical files.
 */
function pinned(pin: UpdateFilePin, limit = maxFile, singleLink = false, owner = process.getuid?.()): string {
  valid(absolute(pin.path) && !pin.path.endsWith("/.npmrc") && digest(pin.sha256) && realpathSync(pin.path) === pin.path);
  const fd = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    valid(before.isFile() && before.size <= limit && before.uid === owner
      && (!singleLink || before.nlink === 1));
    const sha256 = createHash("sha256"), sha512 = createHash("sha512");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      valid(count > 0);
      sha256.update(chunk.subarray(0, count)); sha512.update(chunk.subarray(0, count)); offset += count;
    }
    const after = fstatSync(fd), entry = lstatSync(pin.path);
    valid(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
      && entry.dev === before.dev && entry.ino === before.ino && sha256.digest("hex") === pin.sha256);
    return `sha512-${sha512.digest("base64")}`;
  } finally { closeSync(fd); }
}
function document(path: string, limit = 1024 * 1024): Record<string, unknown> {
  const info = lstatSync(path);
  valid(absolute(path) && realpathSync(path) === path && info.isFile() && info.nlink === 1 && info.size <= limit);
  return object(JSON.parse(readFileSync(path, "utf8")));
}
function roots(q: PackageUpdateQualification) {
  const owner = q.installation.owner;
  valid(owner.kind === "package" && owner.manager === q.manager.name);
  valid(absolute(owner.prefix) && realpathSync(owner.prefix) === owner.prefix
    && lstatSync(owner.prefix).isDirectory() && lstatSync(owner.prefix).uid === process.getuid?.());
  const global = join(owner.prefix, q.manager.name === "bun" ? "install/global" : "lib");
  return { prefix: owner.prefix, global, modules: join(global, "node_modules"),
    primary: join(global, "node_modules", owner.packageName) };
}
function strategy(q: PackageUpdateQualification) {
  const family = q.installation.family;
  valid(family === "claude" || family === "codex" || family === "omp" || family === "grok");
  const selected = families[family], owner = q.installation.owner;
  valid(owner.kind === "package" && owner.packageName === selected.packageName
    && owner.manager === q.manager.name && q.target.packageName === selected.packageName);
  return selected;
}
function control(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return configNames.has(name) || name === "package.json" || name === "bun.lock"
    || name === "package-lock.json" || name === ".package-lock.json";
}
function inventory(q: PackageUpdateQualification, snapshot: PackagePrefixSnapshot,
  prefix: string = roots(q).prefix, ephemeral?: string): void {
  valid((snapshot.files.length > 0 || prefix === q.env["HOME"]) && snapshot.files.length + snapshot.links.length <= maxEntries);
  const files = new Map(snapshot.files.map(pin => [pin.path, pin]));
  const links = new Map(snapshot.links.map(pin => [pin.path, pin]));
  const opaque = new Map(snapshot.opaque?.map(row => [row.path, row]));
  valid(files.size === snapshot.files.length && links.size === snapshot.links.length);
  for (const pin of snapshot.files) valid(relative(pin.path) && digest(pin.sha256)
    && Number.isInteger(pin.mode) && pin.mode >= 0 && pin.mode <= 0o777 && !links.has(pin.path));
  for (const pin of snapshot.links) valid(relative(pin.path) && pin.target.length > 0
    && ownedPath(q, resolve(dirname(join(prefix, pin.path)), pin.target)));
  let bytes = 0, count = 0;
  const pending: string[] = [prefix];
  while (pending.length) {
    const dir = pending.pop();
    valid(dir !== undefined && realpathSync(dir) === dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      valid(++count <= maxEntries);
      const path = join(dir, entry.name), local = path.slice(prefix.length + 1), info = lstatSync(path);
      const metadata = opaque.get(path);
      if (metadata) {
        valid(isDeepStrictEqual(metadata, snapshotPackageOpaqueNpmrc(path)));
        opaque.delete(path); continue;
      }
      valid(entry.name !== ".npmrc");
      if (entry.isDirectory()) {
        valid(info.uid === process.getuid?.() && (info.mode & 0o022) === 0);
        if (path === ephemeral) { valid(realpathSync(path) === path && (info.mode & 0o777) === 0o700); continue; }
        pending.push(path);
      } else if (entry.isSymbolicLink()) {
        valid(!control(path) && links.get(local)?.target === readlinkSync(path)
          && ownedPath(q, realpathSync(path)));
        links.delete(local);
      } else {
        const pin = files.get(local);
        valid(entry.isFile() && pin !== undefined && (info.mode & 0o777) === pin.mode);
        bytes += info.size; valid(bytes <= maxTree);
        pinned({ path, sha256: pin.sha256 }, maxFile, control(path) || path.endsWith("/.grok/config.toml"));
        files.delete(local);
      }
    }
  }
  valid(files.size === 0 && links.size === 0 && opaque.size === 0);
}
function ownedPath(q: PackageUpdateQualification, path: string): boolean {
  const { prefix } = roots(q), home = q.env["HOME"];
  return path.startsWith(`${prefix}/`) || (q.home !== undefined && home !== undefined && path.startsWith(`${home}/.grok/`));
}
/** Resolve literal acquired links without touching a future after path. Every
 * hop and the final file must occur in one of the receipt-bound inventories.
 */
function selectedBin(q: PackageUpdateQualification, pkg: Record<string, unknown>, after: boolean): string {
  const r = roots(q), name = strategy(q).bin;
  const bin = typeof pkg["bin"] === "string" ? pkg["bin"] : object(pkg["bin"])[name];
  valid(typeof bin === "string" && relative(bin.replace(/^(\.\/)+/, "")));
  let path = join(r.primary, bin);
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    valid(ownedPath(q, path) && !seen.has(path)); seen.add(path);
    const prefix = path.startsWith(`${r.prefix}/`) ? r.prefix : q.env["HOME"];
    const snapshot = prefix === r.prefix ? (after ? q.after : q.before) : (after ? q.home?.after : q.home?.before);
    valid(prefix !== undefined && snapshot !== undefined);
    const local = path.slice(prefix.length + 1);
    if (snapshot.files.some(pin => pin.path === local)) return path;
    const link = snapshot.links.find(pin => pin.path === local);
    valid(link !== undefined);
    path = resolve(dirname(path), link.target);
  }
  throw new PackageFailure();
}
function confinement(q: PackageUpdateQualification): void {
  const scope = q.confinement, r = roots(q), home = q.env["HOME"];
  if (!scope) { valid(q.home === undefined); return; }
  const operating = scope.kind === "operating-prefix";
  valid(isDeepStrictEqual(Object.keys(scope).sort(), operating ? ["kind", "root", "system"] : ["root", "system"])
    && isDeepStrictEqual(Object.keys(scope.system).sort(), ["path", "sha256"])
    && process.platform === "darwin" && absolute(scope.root) && realpathSync(scope.root) === scope.root
    && scope.root !== homedir() && home !== undefined && dirname(home) === scope.root
    && scope.system.path === "/usr/bin/sandbox-exec");
  if (operating) {
    const info = lstatSync(r.prefix), mode = info.mode & 0o7777;
    valid(q.installation.family === "codex" && q.manager.name === "npm" && q.home === undefined
      && home === join(scope.root, "home") && r.prefix !== "/" && r.prefix !== homedir()
      && !homedir().startsWith(`${r.prefix}/`) && r.prefix !== scope.root
      && !r.prefix.startsWith(`${scope.root}/`) && !scope.root.startsWith(`${r.prefix}/`)
      && (mode === 0o755 || mode === 0o700));
  } else valid(dirname(r.prefix) === scope.root);
  for (const path of operating ? [scope.root, home] : [scope.root, r.prefix, home]) {
    const info = lstatSync(path);
    valid(realpathSync(path) === path && info.isDirectory() && info.uid === process.getuid?.()
      && (info.mode & 0o777) === 0o700);
  }
  pinned(scope.system, 16 * 1024 * 1024, true, 0);
  valid((lstatSync(scope.system.path).mode & 0o111) !== 0);
  if (q.home) {
    valid(q.installation.family === "grok" && isDeepStrictEqual(Object.keys(q.home).sort(), ["after", "before"]));
    for (const snapshot of [q.home.before, q.home.after])
      for (const pin of [...snapshot.files, ...snapshot.links])
        valid(relative(pin.path) && pin.path.startsWith(".grok/"));
  }
}
function configuration(q: PackageUpdateQualification): void {
  const r = roots(q), home = q.env["HOME"];
  const opaque = verifyPackageOpaqueNpmrc(q);
  valid(typeof home === "string" && absolute(home) && realpathSync(home) === home
    && lstatSync(home).isDirectory() && !home.startsWith(`${r.prefix}/`) && home !== r.prefix);
  const allowed = q.manager.name === "bun" ? ["BUN_INSTALL", "HOME", "PATH"] : ["HOME", "PATH"];
  const paths = [...new Set([dirname(q.manager.path), ...(q.manager.node ? [dirname(q.manager.node.path)] : [])])];
  valid(isDeepStrictEqual(Object.keys(q.env).sort(), allowed) && q.env["PATH"] === paths.join(":")
    && (q.manager.name !== "bun" || q.env["BUN_INSTALL"] === r.prefix));
  // Owned working/HOME/package config stays excluded for lifecycle safety.
  // Bun additionally discovers dotenv/bunfig upwards. npm --global with an
  // explicit --prefix does not load project/ancestor .npmrc; its user/global
  // files are replaced by separate pinned empty files at private dispatch.
  const search = new Set([home, r.prefix, r.primary]);
  if (q.manager.name === "bun") {
    for (let path = r.global;; path = dirname(path)) {
      search.add(path); if (dirname(path) === path) break;
    }
  }
  for (const dir of search) for (const name of configNames)
    valid(!lstatSync(join(dir, name), { throwIfNoEntry: false }));
  const globalConfigs = q.manager.name === "bun"
    ? ["/etc/npmrc", "/usr/local/etc/npmrc", join(r.prefix, "etc/npmrc"), join(dirname(q.manager.path), "../etc/npmrc")]
    : [join(r.prefix, "etc/npmrc")];
  for (const path of globalConfigs)
    valid(!lstatSync(path, { throwIfNoEntry: false }));
  pinned(q.manager);
  valid((lstatSync(q.manager.path).mode & 0o111) !== 0);
  if (q.manager.node) {
    pinned(q.manager.node);
    valid(q.manager.node.path.endsWith("/node") && (lstatSync(q.manager.node.path).mode & 0o111) !== 0);
  }
  confinement(q);
  switch (q.manager.name) {
    case "bun": valid(q.manager.files.length === 0); break;
    case "npm": {
      valid(q.manager.node !== undefined && q.manager.path.endsWith("/bin/npm-cli.js"));
      const root = dirname(dirname(q.manager.path));
      const manifest = document(join(root, "package.json"));
      valid(manifest["name"] === "npm" && q.manager.files.length > 0 && q.manager.files.length < maxEntries);
      const files = new Map(q.manager.files.map(pin => [pin.path, pin]));
      valid(files.size === q.manager.files.length);
      const pending = [root];
      while (pending.length) {
        const dir = pending.pop(); valid(dir !== undefined && realpathSync(dir) === dir);
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (path === opaque) { snapshotPackageOpaqueNpmrc(path); continue; }
          valid(entry.name !== ".npmrc");
          if (entry.isDirectory()) pending.push(path);
          else {
            const pin = files.get(path); valid(entry.isFile() && pin !== undefined);
            pinned(pin, maxFile, control(path)); files.delete(path);
          }
        }
      }
      valid(files.size === 0);
      break;
    }
  }
}
function fresh(input: PackageUpdateInput, now: number, after = false, ephemeral?: string): void {
  const q = input.qualification, i = q.installation, t = q.target;
  strategy(q); const r = roots(q);
  pinned(input.receipt, 32 * 1024 * 1024, true);
  valid(isDeepStrictEqual(document(input.receipt.path, 32 * 1024 * 1024), q));
  valid(Number.isSafeInteger(now) && Number.isSafeInteger(t.checkedAt) && Number.isSafeInteger(t.expiresAt)
    && t.checkedAt <= now && now < t.expiresAt && t.expiresAt - t.checkedAt <= 300_000
    && t.channel === i.channel && version(t.version) && i.installedVersion.kind === "known"
    && version(i.installedVersion.version) && Bun.semver.order(t.version, i.installedVersion.version) > 0);
  configuration(q);
  for (const artifact of t.artifacts) {
    pinned(artifact.metadata, 1024 * 1024, true);
    const metadata = document(artifact.metadata.path), dist = object(metadata["dist"]);
    valid(pinned(artifact.archive) === dist["integrity"]);
  }
  const resources = [...i.resources].sort((a, b) => a.realpath.localeCompare(b.realpath));
  valid(i.installationId === `install:${hash(i.executableRealpath)}`
    && i.resourcesFingerprint === `sha256:${hash(JSON.stringify(resources))}`
    && resources.length > 0 && new Set(resources.map(row => row.realpath)).size === resources.length);
  for (const row of resources) {
    valid(row.resourceId === `resource:${hash(row.realpath)}` && /^sha256:[a-f0-9]{64}$/.test(row.fingerprint)
      && ownedPath(q, row.realpath));
    if (!after) pinned({ path: row.realpath, sha256: row.fingerprint.slice(7) }, maxFile, control(row.realpath));
  }
  const primary = document(join(r.primary, "package.json")), selected = strategy(q);
  valid(primary["name"] === selected.packageName && primary["version"] === (after ? t.version : i.installedVersion.version));
  const bin = typeof primary["bin"] === "string" ? primary["bin"] : object(primary["bin"])[selected.bin];
  const expectedBin = selectedBin(q, primary, after);
  valid(typeof bin === "string" && (after || expectedBin === i.executableRealpath)
    && realpathSync(join(r.primary, bin)) === expectedBin && realpathSync(expectedBin) === expectedBin
    && resources.some(row => row.realpath === i.executableRealpath)
    && resources.some(row => row.realpath === join(r.primary, "package.json"))
    && realpathSync(join(r.prefix, "bin", selected.bin)) === expectedBin);
  inventory(q, after ? q.after : q.before);
  if (q.home) {
    const home = q.env["HOME"]; valid(home !== undefined);
    inventory(q, after ? q.home.after : q.home.before, home, ephemeral);
  }
}

type ArchiveFile = { readonly sha256: string; readonly size: number };
type ArchiveContents = { readonly files: ReadonlyMap<string, ArchiveFile>; readonly manifest: Record<string, unknown> };
/** Inspect original tar bytes without extracting or materializing native leaves.
 * The sole admitted link type is an in-archive hardlink to a regular file; no
 * absolute/traversal/symlink/device entry can redirect the manager's extraction.
 */
async function archiveContents(pin: UpdateFilePin): Promise<ArchiveContents> {
  pinned(pin);
  const head = Buffer.alloc(2), fd = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { valid(readSync(fd, head, 0, 2, 0) === 2); } finally { closeSync(fd); }
  const source = createReadStream(pin.path, { highWaterMark: 1024 * 1024 });
  const stream = head[0] === 31 && head[1] === 139 ? source.pipe(createGunzip()) : source;
  const iterator = stream[Symbol.asyncIterator]();
  let current: Buffer = Buffer.alloc(0), cursor = 0, total = 0;
  async function take(size: number, consume: (part: Buffer) => void): Promise<void> {
    valid(size >= 0 && Number.isSafeInteger(size));
    total += size; valid(total <= maxTree);
    while (size > 0) {
      if (cursor === current.length) {
        const next = await iterator.next(); valid(!next.done && Buffer.isBuffer(next.value));
        current = next.value; cursor = 0;
      }
      const count = Math.min(size, current.length - cursor);
      consume(current.subarray(cursor, cursor + count)); cursor += count; size -= count;
    }
  }
  async function bytes(size: number): Promise<Buffer> {
    valid(size <= 1024 * 1024);
    const body = Buffer.alloc(size); let offset = 0;
    await take(size, part => { part.copy(body, offset); offset += part.length; });
    return body;
  }
  const files = new Map<string, ArchiveFile>(), hardlinks = new Map<string, string>();
  let root: string | undefined, pkg: Record<string, unknown> | undefined, pax: Record<string, string> | undefined;
  function path(raw: string, directory = false): string {
    valid(!raw.startsWith("/") && !raw.includes("\\") && !/[\u0000-\u001f\u007f]/.test(raw));
    const parts = raw.split("/");
    valid(parts.every((part, index) => part !== ".." && (part !== "" || (directory && index === parts.length - 1))));
    const clean = parts.filter(part => part !== "." && part !== "");
    const first = clean.shift(); valid(first !== undefined && /^[A-Za-z0-9_@-][A-Za-z0-9_.@-]*$/.test(first));
    root ??= first; valid(root === first && (directory || clean.length > 0));
    return clean.join("/");
  }
  try {
    for (let count = 0;; count++) {
      valid(count < maxEntries);
      const header = await bytes(512);
      if (header.every(byte => byte === 0)) {
        valid(pax === undefined && (await bytes(512)).every(byte => byte === 0));
        // tar's optional blocking-factor padding contains only zero bytes.
        valid(current.subarray(cursor).every(byte => byte === 0));
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          valid(Buffer.isBuffer(chunk)); total += chunk.length;
          valid(total <= maxTree && chunk.every((byte: number) => byte === 0));
        }
        break;
      }
      const text = (start: number, end: number) => header.subarray(start, end).toString().replace(/\0.*$/, "");
      const octal = (start: number, end: number) => {
        const value = text(start, end).trim(); valid(/^[0-7]*$/.test(value));
        const parsed = Number.parseInt(value || "0", 8); valid(Number.isSafeInteger(parsed)); return parsed;
      };
      const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      valid(checksum === octal(148, 156));
      const kind = header[156], size = octal(124, 136), prefix = text(345, 500);
      valid(size <= maxFile && (kind === 0 || kind === 48 || kind === 49 || kind === 53 || kind === 120));
      if (kind === 120) {
        valid(pax === undefined && size <= 1024 * 1024);
        pax = {};
        const body = await bytes(size);
        for (let offset = 0; offset < body.length;) {
          const space = body.indexOf(32, offset), length = Number(body.subarray(offset, space).toString());
          valid(space > offset && Number.isSafeInteger(length) && length > space - offset + 2
            && offset + length <= body.length && body[offset + length - 1] === 10);
          const record = body.subarray(space + 1, offset + length - 1).toString(), equals = record.indexOf("=");
          const key = record.slice(0, equals), value = record.slice(equals + 1);
          valid(equals > 0 && !Object.hasOwn(pax, key)
            && /^(?:path|size|uid|gid|mtime|atime|ctime|SCHILY\.(?:dev|ino|nlink)|NODETAR\.(?:depth|follow|ignoreFiles\.\d+|package\..+|type|blksize|blocks))$/.test(key)
            && (key !== "NODETAR.follow" || value === "false"));
          pax[key] = value; offset += length;
        }
      } else {
        const raw = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
        valid(!pax || ((!pax["path"] || pax["path"] === raw) && (!pax["size"] || pax["size"] === String(size))));
        pax = undefined;
        const name = path(raw, kind === 53);
        valid(!name.split("/").some(part => configNames.has(part)));
        switch (kind) {
          case 53: valid(size === 0); break;
          case 49: {
            valid(size === 0 && !files.has(name) && !hardlinks.has(name) && !control(name));
            hardlinks.set(name, path(text(157, 257))); break;
          }
          default: {
            const sha = createHash("sha256"), parts: Buffer[] = [];
            if (name === "package.json") valid(size <= 1024 * 1024);
            await take(size, part => { sha.update(part); if (name === "package.json") parts.push(Buffer.from(part)); });
            const file = { sha256: sha.digest("hex"), size };
            valid(!hardlinks.has(name) && (!files.has(name) || isDeepStrictEqual(files.get(name), file)));
            files.set(name, file);
            if (name === "package.json") pkg = object(JSON.parse(Buffer.concat(parts).toString("utf8")));
          }
        }
      }
      const padding = (512 - size % 512) % 512;
      if (padding) await take(padding, () => {});
    }
    for (const [name, target] of hardlinks) {
      const file = files.get(target); valid(file !== undefined && !control(target)); files.set(name, file);
    }
    valid(pkg !== undefined && files.size > 0);
    pinned(pin);
    return { files, manifest: pkg };
  } finally { stream.destroy(); source.destroy(); }
}
type Edge = { readonly parent: string | null; readonly key: string; readonly artifact: PackageArtifact | null };
function slots(parent: string | null, key: string): string[] {
  const root = "/global", result: string[] = [];
  for (let search = parent === null ? root : join(root, "node_modules", parent);;) {
    result.push(join(search, "node_modules", key).slice(`${root}/node_modules/`.length));
    if (search === root) return result;
    search = dirname(search); if (search.endsWith("/node_modules")) search = dirname(search);
    valid(search === root || search.startsWith(`${root}/`));
  }
}
function edges(q: PackageUpdateQualification, pkg: Record<string, unknown>, parent: string | null): Edge[] {
  const result: Edge[] = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", ...(parent === null ? ["devDependencies"] : [])]) {
    if (pkg[field] === undefined) continue;
    const deps = object(pkg[field]);
    for (const [key, value] of Object.entries(deps)) {
      valid(packageName(key) && typeof value === "string");
      const alias = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(.+)$/.exec(value);
      const range = alias ? alias[2] : value;
      valid(typeof range === "string" && /^[0-9A-Za-z*^~<>=| .+-]+$/.test(range) && /[0-9*]/.test(range));
      const candidates = slots(parent, key), selected = candidates.find(slot => q.target.artifacts.some(a => a.installName === slot));
      const artifact = q.target.artifacts.find(a => a.installName === selected);
      if (artifact) {
        valid(artifact.name === (alias ? alias[1] : key) && (Bun.semver.satisfies(artifact.version, range)
          || (parent === null && key === q.target.packageName && q.installation.installedVersion.kind === "known"
            && Bun.semver.satisfies(q.installation.installedVersion.version, range))));
        result.push({ parent, key, artifact });
      } else {
        const meta = pkg["peerDependenciesMeta"], peer = typeof meta === "object" && meta !== null
          ? Object.entries(meta).find(([name]) => name === key)?.[1] : undefined;
        valid(field === "optionalDependencies" || (field === "peerDependencies"
          && typeof peer === "object" && peer !== null && "optional" in peer && peer.optional === true));
        result.push({ parent, key, artifact: null });
      }
    }
  }
  return result;
}
type Contents = {
  readonly manifests: ReadonlyMap<string, Record<string, unknown>>;
  readonly metadata: ReadonlyMap<string, Record<string, unknown>>;
  readonly expected: ReadonlyMap<string, string>;
  readonly edges: readonly Edge[];
};
/** npm's published version metadata strips the harmless leading "./" in bin
 * paths while the original tar manifest retains it. Compare this normalization
 * only; neither bytes nor dependency declarations are rewritten.
 */
function metadataBin(value: unknown, name: string): unknown {
  if (typeof value === "string") return { [name.split("/").at(-1) ?? name]: value.replace(/^(\.\/)+/, "") };
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value).map(([key, path]) =>
      [key, typeof path === "string" ? path.replace(/^(\.\/)+/, "") : path]));
  return value;
}
function lifecycleScripts(value: unknown): Record<string, unknown> {
  const scripts = value === undefined ? {} : object(value);
  // npm registry normalization rewrites dev-tool script paths and supplies a
  // default "start" script. Installation hooks must still match the original
  // archive, whose complete package.json bytes remain independently pinned.
  return Object.fromEntries(["preinstall", "install", "postinstall", "prepublish", "prepare", "preprepare", "postprepare"]
    .filter(key => scripts[key] !== undefined).map(key => [key, scripts[key]]));
}
async function payload(q: PackageUpdateQualification): Promise<Contents> {
  const r = roots(q), artifacts = q.target.artifacts;
  valid(artifacts.length > 0 && artifacts.length <= 10_000
    && new Set(artifacts.map(a => a.installName)).size === artifacts.length
    && artifacts.some(a => a.name === q.target.packageName && a.installName === a.name && a.version === q.target.version));
  const manifests = new Map<string, Record<string, unknown>>(), metadata = new Map<string, Record<string, unknown>>();
  const expected = new Map<string, string>();
  for (const artifact of artifacts) {
    valid(packageName(artifact.name) && version(artifact.version)
      && artifact.installName.split("/node_modules/").every(name => packageName(name) && name !== "node_modules"));
    for (const duplicate of artifacts.filter(a => a.name === artifact.name && a.version === artifact.version))
      valid(isDeepStrictEqual(duplicate.archive, artifact.archive) && isDeepStrictEqual(duplicate.metadata, artifact.metadata));
    pinned(artifact.metadata, 1024 * 1024, true);
    const meta = document(artifact.metadata.path), dist = object(meta["dist"]);
    valid(meta["name"] === artifact.name && meta["version"] === artifact.version && typeof dist["tarball"] === "string");
    const url = new URL(dist["tarball"]);
    valid(url.origin === "https://registry.npmjs.org" && url.pathname.startsWith(`/${artifact.name}/-/`)
      && !url.search && !url.hash && !url.username && !url.password
      && typeof dist["integrity"] === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(dist["integrity"])
      && pinned(artifact.archive) === dist["integrity"]);
    const archive = await archiveContents(artifact.archive), pkg = archive.manifest;
    valid(pkg["name"] === artifact.name && pkg["version"] === artifact.version
      && !pkg["bundledDependencies"] && !pkg["bundleDependencies"]);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bin", "os", "cpu", "scripts"])
      if (meta[field] !== undefined) valid(field === "bin"
        ? isDeepStrictEqual(metadataBin(meta[field], artifact.name), metadataBin(pkg[field], artifact.name))
        : field === "scripts" ? isDeepStrictEqual(lifecycleScripts(meta[field]), lifecycleScripts(pkg[field]))
          : isDeepStrictEqual(meta[field], pkg[field]));
    for (const [name, file] of archive.files) {
      const path = join(r.modules, artifact.installName, name);
      valid(!expected.has(path)); expected.set(path, file.sha256);
    }
    manifests.set(artifact.installName, pkg); metadata.set(artifact.installName, meta);
  }
  const primary = manifests.get(q.target.packageName); valid(primary !== undefined);
  const primaryBin = typeof primary["bin"] === "string" ? primary["bin"] : object(primary["bin"])[strategy(q).bin];
  valid(typeof primaryBin === "string" && relative(primaryBin.replace(/^(\.\/)+/, "")));
  const declaredBin = join(r.primary, primaryBin), targetBin = selectedBin(q, primary, true);
  // Genuine Grok postinstall writes both its package bin and HOME/.grok. The
  // package symlink alone cannot grant those external writes.
  if (q.installation.family === "grok" && Object.keys(lifecycleScripts(primary["scripts"])).length)
    valid(q.home !== undefined && q.confinement !== undefined);
  const global: Record<string, unknown> = q.manager.name === "bun" ? document(join(r.global, "package.json"))
    : { dependencies: { [q.target.packageName]: q.target.version } };
  valid(!global["overrides"] && !global["resolutions"] && !global["scripts"] && !global["workspaces"]);
  const allEdges = edges(q, global, null);
  for (const [slot, pkg] of manifests) allEdges.push(...edges(q, pkg, slot));
  for (const artifact of artifacts) {
    valid(artifact.installName.split("/node_modules/").at(-1) === artifact.name
      || allEdges.some(edge => edge.artifact === artifact));
    const parts = artifact.installName.split("/node_modules/");
    for (let n = 1; n < parts.length; n++) valid(manifests.has(parts.slice(0, n).join("/node_modules/")));
    if (parts.length > 1) valid(allEdges.some(edge => edge.artifact === artifact));
  }
  const before = new Map(q.before.files.map(pin => [pin.path, pin]));
  const after = new Map(q.after.files.map(pin => [pin.path, pin]));
  const afterLinks = new Map(q.after.links.map(link => [link.path, link]));
  valid(before.size === q.before.files.length && after.size === q.after.files.length
    && afterLinks.size === q.after.links.length && after.size + afterLinks.size <= maxEntries);
  for (const pin of q.after.files) valid(relative(pin.path) && digest(pin.sha256)
    && Number.isInteger(pin.mode) && pin.mode >= 0 && pin.mode <= 0o777 && !afterLinks.has(pin.path));
  for (const pin of q.target.postinstall) {
    valid(digest(pin.sha256) && absolute(pin.path) && (!control(pin.path) || expected.get(pin.path) === pin.sha256)
      && artifacts.some(a => pin.path.startsWith(`${join(r.modules, a.installName)}/`))
      && after.get(pin.path.slice(r.prefix.length + 1))?.sha256 === pin.sha256);
    expected.set(pin.path, pin.sha256);
  }
  for (const [path, sha256] of expected) {
    if (afterLinks.has(path.slice(r.prefix.length + 1))) {
      // Original postinstall may replace ONLY the selected package bin file
      // with its acquired literal link to a separately pinned native leaf.
      valid(path === declaredBin && path !== targetBin && ownedPath(q, targetBin));
      expected.delete(path);
    } else valid(after.get(path.slice(r.prefix.length + 1))?.sha256 === sha256);
  }
  const home = q.env["HOME"];
  if (q.home) {
    valid(home !== undefined);
    const homeBefore = new Map(q.home.before.files.map(pin => [pin.path, pin]));
    const homeAfter = new Map(q.home.after.files.map(pin => [pin.path, pin]));
    valid(homeBefore.size === q.home.before.files.length && homeAfter.size === q.home.after.files.length
      && homeAfter.size + q.home.after.links.length <= maxEntries
      && new Set(q.home.after.links.map(link => link.path)).size === q.home.after.links.length);
    for (const pin of q.home.after.files) {
      valid(relative(pin.path) && digest(pin.sha256) && Number.isInteger(pin.mode)
        && pin.mode >= 0 && pin.mode <= 0o777 && !q.home.after.links.some(link => link.path === pin.path));
      if (isDeepStrictEqual(pin, homeBefore.get(pin.path))) continue;
      valid((pin.path === `.grok/bin/grok-${q.target.version}`
        && q.target.postinstall.some(output => output.sha256 === pin.sha256)) || pin.path === ".grok/config.toml");
    }
    for (const pin of q.home.before.files) if (!homeAfter.has(pin.path))
      valid(/^\.grok\/bin\/grok-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pin.path));
    for (const link of q.home.after.links) {
      valid(link.path === ".grok/bin/grok"
        && resolve(dirname(join(home, link.path)), link.target) === join(home, ".grok/bin", `grok-${q.target.version}`)
        && homeAfter.has(`.grok/bin/grok-${q.target.version}`));
    }
  }
  const globalFiles = new Set(q.manager.name === "bun"
    ? [join(r.global, "package.json"), join(r.global, "bun.lock")]
    : [join(r.modules, ".package-lock.json")]);
  for (const pin of q.after.files) {
    const path = join(r.prefix, pin.path);
    if (expected.has(path) || globalFiles.has(path)) continue;
    // No unaccounted generated package files or manager/runtime writes.
    valid(!artifacts.some(a => path.startsWith(`${join(r.modules, a.installName)}/`))
      && isDeepStrictEqual(pin, before.get(pin.path)));
  }
  for (const pin of q.before.files) {
    const path = join(r.prefix, pin.path);
    if (!artifacts.some(a => path.startsWith(`${join(r.modules, a.installName)}/`)) && !globalFiles.has(path))
      valid(isDeepStrictEqual(pin, after.get(pin.path)));
  }
  // Bind after bin mappings to unchanged original package declarations.
  const binTargets = new Map<string, Set<string>>();
  for (const [slot, pkg] of manifests) {
    const bins = typeof pkg["bin"] === "string"
      ? { [slot.split("/").at(-1) ?? ""]: pkg["bin"] } : pkg["bin"] === undefined ? {} : object(pkg["bin"]);
    for (const [name, value] of Object.entries(bins)) {
      valid(/^[A-Za-z0-9_.-]+$/.test(name) && typeof value === "string" && relative(value.replace(/^\.\//, "")));
      const declared = join(r.modules, slot, value);
      const target = declared === declaredBin ? targetBin : declared;
      valid(expected.has(target) || (q.home !== undefined && home !== undefined
        && q.home.after.files.some(pin => join(home, pin.path) === target)));
      const targets = binTargets.get(name) ?? new Set<string>();
      targets.add(target); binTargets.set(name, targets);
    }
  }
  for (const link of q.after.links) {
    valid(relative(link.path));
    const path = join(r.prefix, link.path), target = resolve(dirname(path), link.target);
    const name = link.path.split("/").at(-1) ?? "";
    valid(ownedPath(q, target) && ((binTargets.get(name)?.has(target)
      && (dirname(path) === join(r.prefix, "bin") || dirname(path).endsWith("/node_modules/.bin")))
      || (path === declaredBin && target === targetBin)
      || (path === join(r.prefix, "bin", strategy(q).bin) && target === declaredBin && path !== target)
      || q.before.links.some(beforeLink => isDeepStrictEqual(beforeLink, link))));
  }
  for (const link of q.before.links) {
    if (q.after.links.some(afterLink => isDeepStrictEqual(afterLink, link))) continue;
    const target = resolve(dirname(join(r.prefix, link.path)), link.target);
    valid(artifacts.some(a => target.startsWith(`${join(r.modules, a.installName)}/`)));
  }
  if (q.manager.name === "bun") {
    valid(q.afterLock !== undefined);
    pinned(q.afterLock, 16 * 1024 * 1024, true);
    valid(after.get("install/global/bun.lock")?.sha256 === q.afterLock.sha256
      && before.has("install/global/bun.lock") && before.has("install/global/package.json")
      && after.has("install/global/package.json"));
    validateLock(q, metadata, object(Bun.JSON5.parse(readFileSync(q.afterLock.path, "utf8"))));
  } else valid(q.afterLock === undefined);
  return { manifests, metadata, expected, edges: allEdges };
}
/** The independently observed original lock must bind every physical slot,
 * including alias identity and nested versions. No caller-chosen extra URLs.
 */
function validateLock(q: PackageUpdateQualification, metadata: ReadonlyMap<string, Record<string, unknown>>,
  lock: Record<string, unknown>): void {
  valid(lock["lockfileVersion"] === 1 || lock["lockfileVersion"] === 2);
  const packages = object(lock["packages"]);
  valid(Object.keys(packages).length === q.target.artifacts.length);
  for (const artifact of q.target.artifacts) {
    const row = packages[artifact.installName.replaceAll("/node_modules/", "/")];
    const meta = metadata.get(artifact.installName); valid(meta !== undefined);
    const dist = object(meta["dist"]);
    valid(Array.isArray(row) && row[0] === `${artifact.name}@${artifact.version}`
      && (row[1] === dist["tarball"] || row[1] === "") && row.at(-1) === dist["integrity"]);
  }
}
function destinations(q: PackageUpdateQualification, contents: Contents, after = false): void {
  const r = roots(q);
  const paths = new Set([...contents.expected.keys(),
    ...q.after.files.map(pin => join(r.prefix, pin.path))]);
  for (const path of paths) {
    valid(path.startsWith(`${r.prefix}/`));
    let current: string = r.prefix;
    for (const part of path.slice(r.prefix.length + 1).split("/")) {
      current = join(current, part);
      const info = lstatSync(current, { throwIfNoEntry: false }); if (!info) break;
      valid(!info.isSymbolicLink() && realpathSync(current) === current
        && (current === path ? info.isFile() : info.isDirectory())
        && (!control(current) || info.nlink === 1));
    }
  }
  for (const edge of contents.edges) {
    for (const slot of slots(edge.parent, edge.key)) {
      const path = join(r.modules, slot), info = lstatSync(path, { throwIfNoEntry: false });
      if (slot === edge.artifact?.installName) {
        if (after) valid(info?.isDirectory() === true && realpathSync(path) === path);
        break;
      }
      valid(!info);
    }
  }
}

export async function qualifyPackageUpdate(input: PackageUpdateInput, now: number): Promise<AdapterResult<PrivateUpdateContext>> {
  try {
    valid(dataOnly(input));
    const snapshot = structuredClone(input);
    fresh(snapshot, now);
    const contents = await payload(snapshot.qualification);
    fresh(snapshot, now); destinations(snapshot.qualification, contents);
    const context: PrivateUpdateContext = Object.freeze({ kind: "package-manager-update" });
    contexts.set(context, snapshot);
    return { ok: true, value: context };
  } catch { return failure(); }
}
export function createPackageUpdateSpec(context: PrivateUpdateContext, request: Mode | PrivateUpdateIntent,
  now: number): AdapterResult<UpdateSpec> {
  try {
    const input = contexts.get(context); valid(input !== undefined && !usedContexts.has(context));
    valid(dataOnly(request)); fresh(input, now);
    const q = input.qualification, r = roots(q), mode = typeof request === "string" ? request : request.mode;
    valid(mode === "update-only" || mode === "update-and-restart");
    valid(q.confinement?.kind !== "operating-prefix" || mode === "update-only");
    const intent: PrivateUpdateIntent = Object.freeze({
      operationId: typeof request === "string" ? randomUUID() : request.operationId,
      family: q.installation.family, mode, installationId: q.installation.installationId,
      targetFingerprint: hash(JSON.stringify(q.target)), provenanceDigest: input.receipt.sha256, managerDigest: q.manager.sha256,
    });
    valid(/^[A-Za-z0-9._:-]{1,128}$/.test(intent.operationId)
      && (typeof request === "string" || isDeepStrictEqual(request, intent)));
    valid(absolute(q.manager.path) && absolute(r.prefix));
    const args = q.manager.name === "bun" ? ["add", "--global", `${q.target.packageName}@${q.target.version}`]
      : ["install", "--global", "--prefix", r.prefix, `${q.target.packageName}@${q.target.version}`];
    const spec: UpdateSpec = { command: { executable: q.manager.path, args, cwd: r.prefix },
      mode, expectedInstallation: structuredClone(q.installation),
      // A package manager writes beyond the selected executable/manifests.
      // This directory row is a bound whole-prefix snapshot, NOT a file pin.
      // Only this issuer constructs it; installation identity keeps file rows.
      mutationResources: [...structuredClone(q.installation.resources), {
        resourceId: `resource:${hash(r.prefix)}`, realpath: r.prefix,
        fingerprint: `sha256:${hash(JSON.stringify(q.before))}`,
      }, ...(q.home && q.env["HOME"] ? [{
        resourceId: `resource:${hash(q.env["HOME"])}`, realpath: q.env["HOME"],
        fingerprint: `sha256:${hash(JSON.stringify(q.home.before))}`,
      }] : [])], execution: context };
    issued.set(spec, { input, snapshot: { ...structuredClone(spec), execution: context }, context, intent, used: false });
    return { ok: true, value: spec };
  } catch { return failure(); }
}
export function getPackageUpdateIntent(spec: UpdateSpec): AdapterResult<PrivateUpdateIntent> {
  try {
    const operation = issued.get(spec);
    return operation && dataOnly(spec) && spec.execution === operation.context
      && isDeepStrictEqual(spec, operation.snapshot) ? { ok: true, value: operation.intent } : failure();
  } catch { return failure(); }
}

/** Closed Seatbelt grammar: no supplied profile text, executable override or
 * wrapper callback. The worker retains ps/lsof/journal access outside this jail.
 */
function confinedCommand(q: PackageUpdateQualification, command: PrivateUpdateCommand,
  cache: string, port: number): PrivateUpdateCommand {
  const scope = q.confinement;
  if (!scope) return command;
  confinement(q);
  valid(Number.isInteger(port) && port > 0 && port <= 65535);
  const r = roots(q), home = q.env["HOME"];
  valid(home !== undefined && cache.startsWith(`${q.home ? scope.root : home}/.herdr-update-cache-`));
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
  const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
  const readPaths = [
    // dyld/libignition on current macOS opens "/" as its openat root and
    // loads the system shared cache from sealed Cryptex graft points.
    literal("/"), subpath("/System/Cryptexes"), subpath("/System/Volumes/Preboot/Cryptexes"),
    subpath("/System/Library"), subpath("/usr/lib"), subpath("/usr/share"),
    subpath("/Library/Apple/System/Library"), subpath("/private/var/db/dyld"),
    subpath("/private/var/db/timezone"), subpath("/var/db/timezone"),
    literal("/private/etc/hosts"), literal("/private/etc/resolv.conf"), literal("/private/etc/localtime"),
    literal("/dev/null"), literal("/dev/random"), literal("/dev/urandom"),
    literal("/bin/sh"), literal("/usr/bin/env"), literal(q.manager.path),
    ...(q.manager.name === "npm" ? [subpath(dirname(dirname(q.manager.path)))] : []),
    ...(q.manager.node ? [literal(q.manager.node.path)] : []),
    subpath(r.prefix), subpath(cache), ...(q.home ? [subpath(join(home, ".grok"))] : []),
  ];
  const writes = [subpath(r.prefix), subpath(cache), ...(q.home ? [subpath(join(home, ".grok"))] : [])];
  const profile = [
    "(version 1)", "(allow default)", "(deny file-read* file-write*)",
    "(allow file-read-metadata)", `(allow file-read* ${readPaths.join(" ")})`,
    `(allow file-write* ${writes.join(" ")})`, '(allow file-write-data (literal "/dev/null"))',
    ...(q.before.opaque ? [`(deny file-read-data file-write* ${literal(join(dirname(dirname(q.manager.path)), ".npmrc"))})`] : []),
    // Seatbelt's address grammar accepts "localhost", not a numeric loopback
    // host. The manager URL itself remains the exact 127.0.0.1 leased endpoint.
    "(deny network*)", `(allow network-outbound (remote ip "localhost:${port}"))`,
    "(deny signal)", "(allow signal (target same-sandbox))",
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.CredentialStore"))',
  ].join("\n");
  return Object.freeze({
    ...command, executable: scope.system.path,
    args: Object.freeze(["-p", profile, command.executable, ...command.args]),
    env: Object.freeze({ ...command.env, TMPDIR: join(cache, "tmp") }),
  });
}

/** Static strategy reached only by the durable single consumer. The executor's
 * status is never sufficient: canonical files, original lock, package closure,
 * bins and source pins independently decide the postflight result.
 */
export async function executePackageUpdate(spec: UpdateSpec, executor: OmoUpdateExecutor): Promise<AdapterResult<PrivateUpdateObservation>> {
  let attempted = false, cache: string | undefined, server: Bun.Server<undefined> | undefined;
  const leases = new Map<string, { readonly fd: number; readonly size: number }>();
  const configs: UpdateFilePin[] = [];
  try {
    const authenticated = getPackageUpdateIntent(spec), operation = issued.get(spec);
    valid(authenticated.ok && operation !== undefined && !operation.used
      && !usedContexts.has(operation.context) && !operations.has(operation.intent.operationId));
    const input = operation.input, q = input.qualification, r = roots(q);
    fresh(input, executor.now());
    const contents = await payload(q);
    fresh(input, executor.now()); destinations(q, contents);
    operation.used = true; usedContexts.add(operation.context); operations.add(operation.intent.operationId);
    await executor.event?.({ kind: "intent", intent: operation.intent });
    fresh(input, executor.now()); destinations(q, contents);
    const home = q.env["HOME"]; valid(home !== undefined);
    // The cache and immutable archive leases are covered by durable intent.
    // Grok's whole HOME is an observed mutation resource. Keep consumer-owned
    // temporary inputs beside it in the already-qualified private scope so a
    // dispatch-time HOME gate never needs to ignore unknown files.
    cache = mkdtempSync(join(q.home && q.confinement ? q.confinement.root : home, ".herdr-update-cache-"));
    mkdirSync(join(cache, "manager"));
    if (q.confinement) mkdirSync(join(cache, "tmp"), { mode: 0o700 });
    for (const artifact of q.target.artifacts) {
      if (leases.has(artifact.archive.sha256)) continue;
      const path = join(cache, artifact.archive.sha256);
      copyFileSync(artifact.archive.path, path, constants.COPYFILE_EXCL);
      pinned({ path, sha256: artifact.archive.sha256 });
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), info = fstatSync(fd);
      // Unlinked open descriptors cannot be replaced through a caller's path.
      leases.set(artifact.archive.sha256, { fd, size: info.size }); unlinkSync(path);
    }
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      try {
        if (request.method !== "GET") return new Response(null, { status: 405 });
        const url = new URL(request.url), archiveHash = /^\/tarballs\/([a-f0-9]{64})\.tgz$/.exec(url.pathname)?.[1];
        const lease = archiveHash ? leases.get(archiveHash) : undefined;
        if (lease) {
          let offset = 0;
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              try {
                if (offset === lease.size) { controller.close(); return; }
                const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, lease.size - offset));
                const count = readSync(lease.fd, bytes, 0, bytes.length, offset);
                valid(count > 0); offset += count; controller.enqueue(bytes.subarray(0, count));
              } catch { controller.error(new PackageFailure()); }
            },
          }), { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(lease.size) } });
        }
        const name = decodeURIComponent(url.pathname.slice(1));
        const artifacts = q.target.artifacts.filter(a => a.name === name);
        if (!artifacts.length) return new Response(null, { status: 404 });
        const versions = Object.fromEntries(artifacts.map(artifact => {
          const meta = contents.metadata.get(artifact.installName); valid(meta !== undefined);
          return [artifact.version, { ...meta, dist: { ...object(meta["dist"]),
            tarball: `${url.origin}/tarballs/${artifact.archive.sha256}.tgz` } }];
        }));
        return Response.json({ name, "dist-tags": name === q.target.packageName
          ? { [q.target.channel]: q.target.version } : {}, versions });
      } catch { return new Response(null, { status: 400 }); }
    } });
    const port = server.port;
    valid(port !== undefined);
    const registry = `http://127.0.0.1:${port}`;
    const args = [...operation.snapshot.command.args, "--registry", registry];
    const environment = { ...q.env };
    switch (q.manager.name) {
      case "bun":
        args.push("--cache-dir", join(cache, "manager"), "--force", "--linker", "hoisted", "--frozen-lockfile");
        environment["BUN_INSTALL_GLOBAL_DIR"] = r.global;
        environment["BUN_INSTALL_BIN"] = join(r.prefix, "bin");
        break;
      case "npm":
        for (const name of ["user.npmrc", "global.npmrc"]) {
          const path = join(cache, name);
          writeFileSync(path, "", { mode: 0o600, flag: "wx" });
          configs.push({ path, sha256: hash("") });
        }
        args.push("--cache", join(cache, "manager"), "--userconfig", join(cache, "user.npmrc"),
          "--globalconfig", join(cache, "global.npmrc"),
          "--no-audit", "--no-fund", "--fetch-retries", "0", "--force", "--script-shell=/bin/sh");
        environment["npm_config_prefix"] = r.prefix;
        environment["npm_config_cache"] = join(cache, "manager");
        environment["npm_config_userconfig"] = join(cache, "user.npmrc");
        environment["npm_config_globalconfig"] = join(cache, "global.npmrc");
        environment["npm_config_registry"] = registry;
        environment["npm_config_script_shell"] = "/bin/sh";
        break;
    }
    const invocation = confinedCommand(q, Object.freeze({
      ...operation.snapshot.command, args: Object.freeze(args), shell: false, inheritEnv: false,
      env: Object.freeze(environment),
    }), cache, port);
    await executor.event?.({ kind: "dispatch", intent: operation.intent });
    const run = executor.run;
    fresh(input, executor.now(), false, cache); destinations(q, contents);
    for (const pin of configs) pinned(pin, 0, true);
    // Seed ONLY the independently calibrated original lock, rebinding its exact
    // artifact URLs to leased bytes. The original global package.json is never
    // synthesized/replaced. Bun itself performs the exact-version global add.
    if (q.manager.name === "bun") {
      valid(q.afterLock !== undefined);
      pinned(q.afterLock, 16 * 1024 * 1024, true);
      const lock = object(Bun.JSON5.parse(readFileSync(q.afterLock.path, "utf8"))), packages = object(lock["packages"]);
      validateLock(q, contents.metadata, lock);
      for (const artifact of q.target.artifacts) {
        const row = packages[artifact.installName.replaceAll("/node_modules/", "/")]; valid(Array.isArray(row));
        row[1] = `${registry}/tarballs/${artifact.archive.sha256}.tgz`;
      }
      lock["packages"] = packages;
      attempted = true;
      writeFileSync(join(r.global, "bun.lock"), `${JSON.stringify(lock, null, 2)}\n`);
    }
    attempted = true;
    const exit = await run(invocation);
    const status = exit.status, signal = exit.signal;
    valid((status === null || (Number.isInteger(status) && status >= 0 && status <= 255))
      && (signal === null || typeof signal === "string"));
    await executor.event?.({ kind: "exit", intent: operation.intent, status, signal });
    if (status !== 0 || signal !== null) return failure("update_failed");
    const observedAt = executor.now();
    configuration(q);
    for (const pin of configs) pinned(pin, 0, true);
    pinned(input.receipt, 32 * 1024 * 1024, true);
    for (const artifact of q.target.artifacts) {
      pinned(artifact.metadata, 1024 * 1024, true);
      const meta = contents.metadata.get(artifact.installName); valid(meta !== undefined);
      valid(pinned(artifact.archive) === object(meta["dist"])["integrity"]);
    }
    const current = document(join(r.primary, "package.json"));
    if (current["version"] !== q.target.version) return failure("update_failed");
    if (q.manager.name === "bun") {
      valid(q.afterLock !== undefined);
      pinned(q.afterLock, 16 * 1024 * 1024, true);
      const lockPath = join(r.global, "bun.lock"), info = lstatSync(lockPath);
      valid(realpathSync(lockPath) === lockPath && info.isFile() && info.nlink === 1 && info.size <= 16 * 1024 * 1024);
      const actual = object(Bun.JSON5.parse(readFileSync(lockPath, "utf8")));
      const original = object(Bun.JSON5.parse(readFileSync(q.afterLock.path, "utf8")));
      const packages = object(actual["packages"]), expectedPackages = object(original["packages"]);
      for (const artifact of q.target.artifacts) {
        const key = artifact.installName.replaceAll("/node_modules/", "/"), row = packages[key], expected = expectedPackages[key];
        valid(Array.isArray(row) && Array.isArray(expected));
        if (row[1] === `${registry}/tarballs/${artifact.archive.sha256}.tgz`) row[1] = expected[1];
      }
      actual["packages"] = packages;
      valid(isDeepStrictEqual(actual, original));
      // Canonical original encoding only after structural equality; never repair
      // missing packages or copy expected payload bytes into the installation.
      writeFileSync(lockPath, readFileSync(q.afterLock.path));
    }
    fresh(input, observedAt, true, cache);
    destinations(q, contents, true);
    for (const [path, sha256] of contents.expected) pinned({ path, sha256 }, maxFile, control(path));
    return { ok: true, value: { kind: "files-verified", intent: operation.intent, durableReceipt: false } };
  } catch { return failure(attempted ? "recovery_required" : "verification_failed"); }
  finally {
    let failed = false;
    try { if (server) await server.stop(true); } catch { failed = true; }
    for (const lease of leases.values()) try { closeSync(lease.fd); } catch { failed = true; }
    try { if (cache) rmSync(cache, { recursive: true, force: true }); } catch { failed = true; }
    if (failed) return failure("recovery_required");
  }
}
