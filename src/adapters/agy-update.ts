import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
  readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { gunzipSync } from "node:zlib";
import { AGY_INSTALLER_SHA256, AGY_MANIFEST_CHANNEL } from "./agy";
import type { OmoUpdateExecutor, UpdateFilePin } from "./update-context";
import type { AdapterResult, InstallationIdentity, Mode, MutationResource, PrivateUpdateCommand,
  PrivateUpdateContext, PrivateUpdateIntent, PrivateUpdateObservation, UpdateSpec } from "./types";

// allow: SIZE_OK — the authorized two-file scope keeps this single native strategy's
// private issuance, original invocation and independent postflight together.
type Member = { readonly path: string; readonly sha256: string; readonly bytes: number; readonly mode: number };
type Entry = { readonly path: string; readonly type: "directory" | "file"; readonly mode: number;
  readonly bytes?: number; readonly sha256?: string };
export type NativeAgyUpdateInput = {
  /** The private producer authenticates this receipt; a client cannot select it. */
  readonly receipt: UpdateFilePin;
  readonly qualification: {
    readonly installation: InstallationIdentity;
    /** Entire native owner, canonical same-user 0700; contains only bin and home. */
    readonly root: string;
    readonly home: string;
    readonly env: Readonly<Record<string, string>>;
    /** Immutable separately acquired original, outside the writable root. */
    readonly source: UpdateFilePin;
    readonly installer: UpdateFilePin;
    readonly dependencies: readonly UpdateFilePin[];
    readonly target: {
      /** This is deliberately NOT an immutable target authorization. */
      readonly selection: "official-latest";
      readonly version: string;
      readonly channel: typeof AGY_MANIFEST_CHANNEL;
      readonly manifest: UpdateFilePin;
      /** {method:"GET",url,status:200,checkedAt,response:<manifest JSON>} */
      readonly release: UpdateFilePin;
      readonly archive: UpdateFilePin;
      readonly expectedFiles: readonly Member[];
      readonly checkedAt: number;
      readonly expiresAt: number;
    };
  };
};
type Qualification = NativeAgyUpdateInput["qualification"];
export type AgyUpdateSpec = UpdateSpec & {
  readonly expectedAfter: InstallationIdentity;
  readonly mutationRoots: readonly string[];
  readonly targetSelection: "official-latest";
};
type Bound = { readonly input: NativeAgyUpdateInput; readonly before: readonly Entry[]; readonly after: readonly Entry[] };
const contexts = new WeakMap<PrivateUpdateContext, Bound>();
const issued = new WeakMap<UpdateSpec, {
  readonly bound: Bound; readonly context: PrivateUpdateContext;
  readonly snapshot: AgyUpdateSpec; readonly intent: PrivateUpdateIntent;
}>();
const consumed = new WeakSet<PrivateUpdateContext>(), operations = new Set<string>();
const originals = [
  { version: "1.2.15", sha256: "d15693410c904242c1c3423a579f60a81e018444bb51fbccc6505f988b62a91d", bytes: 174613232 },
  { version: "1.2.16", sha256: "7dca095cfc1df2c057a385ed88a76c7ba98dc103258a80be87a8f42e484cb3aa", bytes: 175966448 },
] as const;
const statusPath = "home/.gemini/antigravity-cli/updater/update_status.json";
const lockPath = "home/.gemini/antigravity-cli/updater/update.lock";
const backupPath = "bin/agy.<timestamp>.old";
const statusBody = '{"success":true,"message":"Update successful, restart CLI to use"}';
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const failure = <T>(code: "verification_failed" | "recovery_required" | "unsupported" = "verification_failed"): AdapterResult<T> =>
  ({ ok: false, error: { code } });
class AgyFailure extends Error { constructor() { super("verification_failed"); } }
function valid(condition: boolean): asserts condition { if (!condition) throw new AgyFailure(); }
/** Reject Proxy objects BEFORE reflection, including revoked/nested proxies.
 * Descriptor walking never invokes accessors, toJSON or caller iterators. */
function plain(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || types.isProxy(value) || depth > 16) return false;
  const array = Array.isArray(value), keys = Reflect.ownKeys(value);
  return keys.length <= 4096 && Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype)
    && (!array || keys.length === value.length + 1) && keys.every(key => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === "string" && key !== "toJSON" && d !== undefined && Object.hasOwn(d, "value")
        && (d.enumerable || (array && key === "length")) && plain(d.value, depth + 1);
    });
}
function absolute(path: string): path is `/${string}` {
  return path.startsWith("/") && normalize(path) === path && !/[\u0000-\u001f\u007f"\\]/.test(path);
}
function directory(path: string): void {
  valid(absolute(path) && realpathSync(path) === path);
  const info = lstatSync(path);
  valid(info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o022) === 0);
}
/** Full streamed digest, no metadata-only cache; reject links and replacement
 * during the read. System dependency ownership is root, native ownership is uid. */
function digest(path: string, system = false): string {
  valid(absolute(path) && realpathSync(path) === path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    valid(before.isFile() && before.nlink === 1n && before.size <= 512n * 1024n ** 2n
      && before.uid === BigInt(system ? 0 : process.getuid?.() ?? -1) && (before.mode & 0o022n) === 0n);
    const sha = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let offset = 0; offset < Number(before.size);) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      valid(length > 0); sha.update(buffer.subarray(0, length)); offset += length;
    }
    valid([fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })].every(info =>
      info.dev === before.dev && info.ino === before.ino && info.size === before.size && info.mode === before.mode
      && info.mtimeNs === before.mtimeNs && info.ctimeNs === before.ctimeNs) && realpathSync(path) === path);
    return sha.digest("hex");
  } finally { closeSync(fd); }
}
function pin(value: UpdateFilePin, system = false): void {
  valid(/^[a-f0-9]{64}$/.test(value.sha256) && digest(value.path, system) === value.sha256);
}
function json(value: UpdateFilePin): unknown {
  pin(value); valid(lstatSync(value.path).size <= 1024 * 1024);
  const body = readFileSync(value.path); valid(hash(body) === value.sha256);
  return JSON.parse(body.toString("utf8"));
}
function environment(q: Qualification): Record<string, string> {
  return { HOME: q.home, TMPDIR: join(q.home, "tmp"), PATH: "/usr/bin:/bin",
    XDG_CONFIG_HOME: join(q.home, ".config"), XDG_CACHE_HOME: join(q.home, ".cache"),
    XDG_DATA_HOME: join(q.home, ".local/share") };
}
function layout(q: Qualification): void {
  valid(absolute(q.root) && q.root.split("/").length > 3 && q.root !== homedir() && !homedir().startsWith(`${q.root}/`)
    && q.home === join(q.root, "home") && q.installation.executableRealpath === join(q.root, "bin/agy"));
  directory(q.root); directory(q.home);
  valid((lstatSync(q.root).mode & 0o777) === 0o700 && (lstatSync(q.home).mode & 0o777) === 0o700);
  valid(isDeepStrictEqual(q.env, environment(q)) && q.installation.owner.kind === "native"
    && q.installation.owner.prefix === q.root && q.installation.owner.installerDigest === `sha256:${AGY_INSTALLER_SHA256}`);
}
/** Official hosts are the pinned original's manifest contract, NOT an OS host
 * allowlist. Seatbelt permits HTTPS/DNS and the resolver socket, nothing else.
 * Metadata reads enable path resolution; personal/keychain contents stay denied. */
function command(q: Qualification): PrivateUpdateCommand {
  valid(absolute(q.root));
  const profile = `(version 1)(allow default)(deny network*)`
    + `(allow network-outbound (remote udp "*:53") (remote tcp "*:53") (remote tcp "*:443"))`
    + `(allow network-outbound (literal "/private/var/run/mDNSResponder"))`
    + `(deny file-write*)(allow file-write* (subpath ${JSON.stringify(q.root)}) (literal "/dev/null"))`
    + `(deny file-read* (subpath "/Users") (subpath ${JSON.stringify(homedir())}) (subpath "/Library/Keychains"))`
    + `(allow file-read* (subpath ${JSON.stringify(q.root)}))(allow file-read-metadata)`
    + `(deny process-exec)(allow process-exec (subpath ${JSON.stringify(join(q.root, "bin"))}))`;
  return Object.freeze({ executable: "/usr/bin/sandbox-exec",
    args: Object.freeze(["-p", profile, q.installation.executableRealpath, "update"]), cwd: q.root,
    shell: false, inheritEnv: false, env: Object.freeze(environment(q)) });
}
function sorted(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}
/** Complete writable prefix; the only normalized field is ONE backup's
 * runtime-generated decimal timestamp. All bytes, modes, entries and counts
 * remain exact. This is a constrained manifest digest, not a raw tree digest. */
function inventory(q: Qualification, after: boolean): Entry[] {
  const entries: Entry[] = [], pending = [q.root]; let backups = 0;
  const directories = [".", "bin", "home", "home/tmp",
    ...(after ? ["home/.gemini", "home/.gemini/antigravity-cli", "home/.gemini/antigravity-cli/updater"] : [])];
  while (pending.length) {
    const dir = pending.pop(); valid(dir !== undefined); directory(dir);
    const relative = dir === q.root ? "." : dir.slice(q.root.length + 1);
    valid(directories.includes(relative));
    const before = lstatSync(dir, { bigint: true });
    entries.push({ path: relative, type: "directory", mode: Number(before.mode & 0o777n) });
    for (const name of readdirSync(dir)) {
      valid(entries.length + pending.length < 64);
      const path = join(dir, name), info = lstatSync(path);
      if (info.isDirectory()) { pending.push(path); continue; }
      const local = path.slice(q.root.length + 1);
      const backup = after && /^bin\/agy\.[1-9][0-9]{0,19}\.old$/.test(local);
      // Unknown bystanders, including credentials, are never opened for hashing.
      valid(local === "bin/agy" || (after && (backup || local === statusPath || local === lockPath)));
      if (backup) valid(++backups === 1);
      entries.push({ path: backup ? backupPath : local, type: "file", mode: info.mode & 0o777,
        bytes: info.size, sha256: digest(path) });
    }
    const current = lstatSync(dir, { bigint: true });
    valid(current.dev === before.dev && current.ino === before.ino
      && current.mtimeNs === before.mtimeNs && current.ctimeNs === before.ctimeNs);
  }
  valid(!after || backups === 1);
  return sorted(entries);
}
function resource(path: string, sha256: string): MutationResource {
  return { realpath: path, resourceId: `resource:${hash(path)}`, fingerprint: `sha256:${sha256}` };
}
function identity(q: Qualification, entries: readonly Entry[], after: boolean): InstallationIdentity {
  const file = entries.find(row => row.path === "bin/agy"); valid(file?.sha256 !== undefined);
  const executable = join(q.root, "bin/agy");
  const resources = [resource(executable, file.sha256)];
  if (after) {
    resources.push(resource(q.root, hash(JSON.stringify(entries))));
    for (const local of [statusPath, lockPath]) {
      const row = entries.find(entry => entry.path === local); valid(row?.sha256 !== undefined);
      resources.push(resource(join(q.root, local), row.sha256));
    }
  }
  resources.sort((a, b) => a.realpath.localeCompare(b.realpath));
  return { family: "agy", channel: AGY_MANIFEST_CHANNEL, executableRealpath: executable,
    installationId: `install:${hash(executable)}`,
    owner: { kind: "native", prefix: q.root, installerDigest: `sha256:${AGY_INSTALLER_SHA256}` },
    installedVersion: after ? { kind: "known", version: q.target.version } : q.installation.installedVersion,
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
}
function fresh(bound: Bound, now: number, after = false): void {
  const input = bound.input, q = input.qualification, t = q.target;
  valid(process.platform === "darwin" && process.arch === "arm64" && isDeepStrictEqual(json(input.receipt), q));
  valid(Number.isSafeInteger(now) && Number.isSafeInteger(t.checkedAt) && Number.isSafeInteger(t.expiresAt)
    && t.checkedAt >= 0 && t.checkedAt <= now && now < t.expiresAt && t.expiresAt - t.checkedAt <= 300_000);
  layout(q);
  const original = originals.find(row => q.installation.installedVersion.kind === "known"
    && row.version === q.installation.installedVersion.version && row.sha256 === q.source.sha256);
  valid(original !== undefined && lstatSync(q.source.path).size === original.bytes);
  valid(q.installer.sha256 === AGY_INSTALLER_SHA256 && t.selection === "official-latest" && t.channel === AGY_MANIFEST_CHANNEL
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(t.version) && t.version.length < 64);
  const order = t.version.split(".").map(BigInt), old = original.version.split(".").map(BigInt);
  const first = order.findIndex((value, i) => value !== old[i]);
  valid(first >= 0 && (order[first] ?? 0n) > (old[first] ?? 0n));
  for (const value of [input.receipt, q.source, q.installer, t.archive, t.manifest, t.release]) {
    valid(!value.path.startsWith(`${q.root}/`) && value.path !== q.root); pin(value);
  }
  valid(q.dependencies.length === 1 && q.dependencies[0]?.path === "/usr/bin/sandbox-exec");
  for (const dependency of q.dependencies) { pin(dependency, true); valid((lstatSync(dependency.path).mode & 0o111) !== 0); }
  const manifest = json(t.manifest);
  valid(typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
    && Object.keys(manifest).sort().join(",") === "sha512,url,version"
    && "version" in manifest && manifest.version === t.version && "sha512" in manifest
    && typeof manifest.sha512 === "string" && /^[a-f0-9]{128}$/.test(manifest.sha512)
    && "url" in manifest && typeof manifest.url === "string"
    && new RegExp(`^https://storage\\.googleapis\\.com/antigravity-public/antigravity-cli/${t.version.replaceAll(".", "\\.")}-[0-9]+/darwin-arm/cli_mac_arm64\\.tar\\.gz$`).test(manifest.url));
  valid(isDeepStrictEqual(json(t.release), { method: "GET", url: AGY_MANIFEST_CHANNEL, status: 200,
    checkedAt: t.checkedAt, response: manifest }));
  valid(isDeepStrictEqual(q.installation, identity(q, bound.before, false))
    && isDeepStrictEqual(inventory(q, after), after ? bound.after : bound.before));
}
/** No extraction, process, network or writes. Only the flat original archive
 * format observed in the official release is admitted, not tar link semantics. */
function payload(q: Qualification): Member[] {
  pin(q.target.archive);
  const bytes = readFileSync(q.target.archive.path), manifest = json(q.target.manifest);
  valid(hash(bytes) === q.target.archive.sha256 && typeof manifest === "object" && manifest !== null
    && "sha512" in manifest && createHash("sha512").update(bytes).digest("hex") === manifest.sha512);
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const header = tar.subarray(0, 512);
  const text = (start: number, end: number) => header.subarray(start, end).toString().replace(/\0.*$/, "");
  const octal = (start: number, end: number) => {
    const value = text(start, end).trim(); valid(/^[0-7]+$/.test(value)); return Number.parseInt(value, 8);
  };
  const size = octal(124, 136), mode = octal(100, 108);
  valid(header.length === 512 && text(0, 100) === "antigravity" && text(157, 257) === ""
    && text(345, 500) === "" && (header[156] === 0 || header[156] === 48) && mode === 0o755
    && size > 0 && size <= 256 * 1024 * 1024
    && header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0) === octal(148, 156));
  const end = 512 + Math.ceil(size / 512) * 512;
  valid(tar.length >= end + 1024 && tar.subarray(512 + size).every(byte => byte === 0));
  return [{ path: "antigravity", sha256: hash(tar.subarray(512, 512 + size)), bytes: size, mode }];
}
export async function qualifyAgyUpdate(input: NativeAgyUpdateInput, now: number): Promise<AdapterResult<PrivateUpdateContext>> {
  try {
    valid(plain(input)); const snapshot = structuredClone(input), q = snapshot.qualification; layout(q);
    const files = payload(q); valid(isDeepStrictEqual(files, q.target.expectedFiles));
    const target = files[0]; valid(target !== undefined);
    const before = inventory(q, false);
    valid(isDeepStrictEqual(before.map(row => row.path).sort(), [".", "bin", "bin/agy", "home", "home/tmp"].sort()));
    valid(before.filter(row => row.path !== "bin/agy").every(row => row.type === "directory")
      && before.filter(row => row.path === "bin" || row.path === "home/tmp").every(row => row.mode === 0o755));
    const original = originals.find(row => row.sha256 === q.source.sha256); valid(original !== undefined);
    const native = before.find(row => row.path === "bin/agy");
    valid(native?.type === "file" && native.mode === 0o755 && native.bytes === original.bytes && native.sha256 === original.sha256);
    const after = sorted([...before.filter(row => row.path !== "bin/agy"),
      { path: "bin/agy", type: "file", mode: 0o755, bytes: target.bytes, sha256: target.sha256 },
      { ...native, path: backupPath },
      ...["home/.gemini", "home/.gemini/antigravity-cli", "home/.gemini/antigravity-cli/updater"]
        .map(path => ({ path, type: "directory" as const, mode: 0o755 })),
      { path: statusPath, type: "file", mode: 0o600, bytes: Buffer.byteLength(statusBody), sha256: hash(statusBody) },
      { path: lockPath, type: "file", mode: 0o600, bytes: 0, sha256: hash("") }]);
    const bound: Bound = { input: snapshot, before, after }; fresh(bound, now);
    const context: PrivateUpdateContext = Object.freeze({ kind: "agy-original-update" });
    contexts.set(context, bound); return { ok: true, value: context };
  } catch { return failure(); }
}
export function createAgyUpdateSpec(context: PrivateUpdateContext, request: Mode | PrivateUpdateIntent,
  now: number): AdapterResult<AgyUpdateSpec> {
  try {
    const bound = contexts.get(context); valid(bound !== undefined && !consumed.has(context) && plain(request));
    const mode = typeof request === "string" ? request : request.mode;
    if (mode === "update-and-restart") return failure("unsupported");
    valid(mode === "update-only"); fresh(bound, now);
    const q = bound.input.qualification;
    const intent: PrivateUpdateIntent = Object.freeze({ operationId: typeof request === "string" ? randomUUID() : request.operationId,
      family: "agy", mode, installationId: q.installation.installationId, targetFingerprint: hash(JSON.stringify(q.target)),
      provenanceDigest: bound.input.receipt.sha256, managerDigest: AGY_INSTALLER_SHA256 });
    valid(/^[A-Za-z0-9._:-]{1,128}$/.test(intent.operationId)
      && (typeof request === "string" || isDeepStrictEqual(request, intent)));
    const invocation = command(q);
    const spec: AgyUpdateSpec = { command: { executable: invocation.executable, args: invocation.args, cwd: invocation.cwd },
      mode, expectedInstallation: structuredClone(q.installation), mutationRoots: [q.root], targetSelection: "official-latest",
      mutationResources: [...structuredClone(q.installation.resources), resource(q.root, hash(JSON.stringify(bound.before)))]
        .sort((a, b) => a.realpath.localeCompare(b.realpath)), expectedAfter: identity(q, bound.after, true), execution: context };
    issued.set(spec, { bound, context, snapshot: { ...structuredClone(spec), execution: context }, intent });
    return { ok: true, value: spec };
  } catch { return failure(); }
}
export function getAgyUpdateIntent(spec: UpdateSpec): AdapterResult<PrivateUpdateIntent> {
  try {
    const record = issued.get(spec);
    return record && plain(spec) && record.context === spec.execution && isDeepStrictEqual(record.snapshot, spec)
      ? { ok: true, value: record.intent } : failure();
  } catch { return failure(); }
}
/** Read-only parent observer. Whole-root verification precedes identity return;
 * root fingerprints include the exact old backup/status, never only target bytes. */
export function observeAgyUpdate(spec: UpdateSpec, now: number): AdapterResult<InstallationIdentity> {
  try {
    const record = issued.get(spec); valid(record !== undefined && getAgyUpdateIntent(spec).ok);
    fresh(record.bound, now, true);
    return { ok: true, value: identity(record.bound.input.qualification, inventory(record.bound.input.qualification, true), true) };
  } catch { return failure(); }
}
export async function executeAgyUpdate(spec: UpdateSpec, executor: OmoUpdateExecutor): Promise<AdapterResult<PrivateUpdateObservation>> {
  let attempted = false;
  try {
    const record = issued.get(spec);
    valid(record !== undefined && getAgyUpdateIntent(spec).ok && !consumed.has(record.context)
      && !operations.has(record.intent.operationId));
    consumed.add(record.context); operations.add(record.intent.operationId);
    // Consume before any supplied getter/hook/await. Only the existing worker
    // consumer supplies this process seam, after its durable intent journal.
    const clock = executor.now, event = executor.event, run = executor.run;
    fresh(record.bound, clock());
    await event?.({ kind: "intent", intent: record.intent });
    fresh(record.bound, clock());
    await event?.({ kind: "dispatch", intent: record.intent });
    fresh(record.bound, clock());
    valid(getAgyUpdateIntent(spec).ok);
    const invocation = command(record.bound.input.qualification);
    valid(isDeepStrictEqual(spec.command, { executable: invocation.executable, args: invocation.args, cwd: invocation.cwd }));
    attempted = true;
    const result = await run(invocation);
    valid(plain(result) && (result.status === null || (Number.isInteger(result.status) && result.status >= 0 && result.status <= 255))
      && (result.signal === null || typeof result.signal === "string"));
    await event?.({ kind: "exit", intent: record.intent, status: result.status, signal: result.signal });
    valid(result.status === 0 && result.signal === null && observeAgyUpdate(spec, clock()).ok);
    return { ok: true, value: { kind: "files-verified", intent: record.intent, durableReceipt: false } };
  // Floating drift, native failure and observation uncertainty are known possible
  // effects, never permission to rerun or claim the old installation unchanged.
  } catch { return failure(attempted ? "recovery_required" : "verification_failed"); }
}
