import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync,
  readSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, types } from "node:util";
import type { OmoUpdateExecutor, UpdateFilePin } from "./update-context";
import type { AdapterResult, InstallationIdentity, Mode, NativeUpdateCompletion, PrivateUpdateCommand, PrivateUpdateContext,
  PrivateUpdateIntent, PrivateUpdateObservation, UpdateSpec } from "./types";

// allow: SIZE_OK — the authorized two-file scope keeps this one native strategy's
// private issuance, immutable original invocation and independent postflight together.
type Member = { readonly path: string; readonly sha256: string; readonly bytes: number; readonly mode: number };
export type NativeCursorUpdateInput = {
  /** Separately authenticated by the private producer, never chosen by a client. */
  readonly receipt: UpdateFilePin;
  readonly qualification: {
    readonly installation: InstallationIdentity;
    /** Separately acquired current original updater, not the old selected CLI. */
    readonly originalExecutable: string;
    readonly beforeFiles: readonly Member[];
    readonly beforeDirectories: readonly string[];
    /** Immutable owner provenance outside HOME; the old grant pins install.sh,
     * not a nonexistent same-digest file inside the selected payload. */
    readonly beforeInstaller: UpdateFilePin;
    /** Existing canonical, same-user 0700 isolated HOME, never the operating HOME. */
    readonly home: string;
    readonly env: Readonly<Record<string, string>>;
    /** Complete original manifest, an array of Member in localeCompare path order.
     * This exact current original grant does not authenticate future sources. */
    readonly manifest: UpdateFilePin;
    readonly expectedFiles: readonly Member[];
    readonly dependencies: readonly UpdateFilePin[];
    readonly target: {
      readonly version: string;
      readonly channel: "prod";
      readonly archive: UpdateFilePin;
      /** Credential-free acquisition record:
       * {method:"POST",url,request:{channel:"prod"},status:200,response:{version,url}}
       * The returned download lane is NOT the effective installed channel. */
      readonly release: UpdateFilePin;
      readonly checkedAt: number;
      readonly expiresAt: number;
    };
  };
};
type Qualification = NativeCursorUpdateInput["qualification"];
type CursorSpec = UpdateSpec & {
  readonly expectedAfter: InstallationIdentity;
  readonly mutationRoots: readonly string[];
};
/** The durable parent consumer must observe/reap this exact original descendant
 * before run resolves. A direct-spawn-only consumer cannot consume this command.
 * This is immutable data, not an alternate executor or success callback. */
type CursorCommand = PrivateUpdateCommand & {
  readonly nativeCompletion: NativeUpdateCompletion;
};
const version = "2026.10.01-e373342";
const archiveDigest = "629e51de43a0b7fb3b86f5ebc7e579f7df7df941b39f29e82945cde750145afc";
const manifestDigest = "b6dd14a0cd76f6ec04f924b75027449ff00af4cfc1eba4bb3ee4610b25fdc697";
const installerDigest = "8a2f1c777a037577596844c9759bd121970a33f1be482e9ecea1c8f0987dcbeb";
const legacyInstallerDigest = "b2776d5f0bf35b561a758977f1293278788bf7939586180d4d942b7dae35b50a";
// Original version-addressed archive member receipts retained by task5.
const legacyManifestDigest = "c82d57049334fef08f01f8c4df0cc61d6740f78628d6ff49f31163c97462e6b2";
const shimDigest = "548f4c6948758b82edadb49eee3fc0e5223e967412172a64bc0459fe807f9ddb";
const configDigest = "6bebcca150b22dd97e384d296ce1061a1710659fe9ce9eeb4e9c559c4c412c0c";
const emptyDirectories = ["node_modules/tree-sitter-bash/node-addon-api@7.1.0",
  "node_modules/tree-sitter-bash/build/Release/node-addon-api@7.1.0",
  "node_modules/tree-sitter/node-addon-api@8.5.0", "node_modules/tree-sitter/build/Release/node-addon-api@8.5.0",
  "node_modules/piscina/src/task_queue", "node_modules/piscina/src/worker_pool"];
const dependencyPaths = ["/bin/bash", "/bin/realpath", "/bin/sh", "/usr/bin/basename", "/usr/bin/bsdtar",
  "/usr/bin/curl", "/usr/bin/dirname", "/usr/bin/env", "/usr/bin/readlink", "/usr/bin/sandbox-exec"];
const contexts = new WeakMap<PrivateUpdateContext, NativeCursorUpdateInput>();
const issued = new WeakMap<UpdateSpec, {
  readonly input: NativeCursorUpdateInput; readonly context: PrivateUpdateContext;
  readonly snapshot: CursorSpec; readonly intent: PrivateUpdateIntent;
}>();
const consumed = new WeakSet<PrivateUpdateContext>();
const operations = new Set<string>();
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const failure = <T>(code: "verification_failed" | "recovery_required" | "update_failed" = "verification_failed"): AdapterResult<T> =>
  ({ ok: false, error: { code } });
class CursorFailure extends Error { constructor() { super("verification_failed"); } }
function valid(condition: boolean): asserts condition { if (!condition) throw new CursorFailure(); }
function plain(value: unknown, depth = 0): boolean {
  if (value === null || ["string", "boolean", "undefined"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || types.isProxy(value) || depth > 16) return false;
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && descriptor !== undefined && "value" in descriptor
      && (descriptor.enumerable || (array && key === "length")) && plain(descriptor.value, depth + 1);
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
function pinned(pin: UpdateFilePin, system = false): void {
  valid(absolute(pin.path) && /^[a-f0-9]{64}$/.test(pin.sha256) && realpathSync(pin.path) === pin.path);
  const fd = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    // macOS readlink shares its root-owned system inode with stat. Unlike owned
    // mutable inputs it need not be single-linked; its canonical bytes stay pinned.
    valid(before.isFile() && before.size <= 1024 * 1024 * 1024 && (system || before.nlink === 1)
      && before.uid === (system ? 0 : process.getuid?.()) && (before.mode & 0o022) === 0);
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let offset = 0; offset < before.size;) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      valid(length > 0); digest.update(buffer.subarray(0, length)); offset += length;
    }
    const after = fstatSync(fd), entry = lstatSync(pin.path);
    valid(digest.digest("hex") === pin.sha256 && before.dev === entry.dev && before.ino === entry.ino
      && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
  } finally { closeSync(fd); }
}
function json(pin: UpdateFilePin): unknown {
  pinned(pin); valid(lstatSync(pin.path).size <= 1024 * 1024);
  return JSON.parse(readFileSync(pin.path, "utf8"));
}
function geometry(q: Qualification) {
  const prefix = join(q.home, ".local/share/cursor-agent");
  const source = dirname(q.installation.executableRealpath);
  const target = join(prefix, "versions", version);
  return { prefix, source, target, bin: join(q.home, ".local/bin"),
    roots: [prefix, join(q.home, ".local/bin"), join(q.home, "config"), join(q.home, "data"),
      join(q.home, "compile-cache"), join(q.home, "tmp")] };
}
function identity(q: Qualification, after: boolean): InstallationIdentity {
  const payload = after ? geometry(q).target : geometry(q).source;
  const executable = join(payload, "cursor-agent");
  const resources = (after ? q.expectedFiles : q.beforeFiles).map(file => {
    const path = join(payload, file.path);
    return { realpath: path, resourceId: `resource:${hash(path)}`, fingerprint: `sha256:${file.sha256}` };
  }).sort((a, b) => a.realpath.localeCompare(b.realpath));
  return { family: "cursor", channel: "prod", executableRealpath: executable,
    installationId: `install:${hash(executable)}`, owner: structuredClone(q.installation.owner),
    installedVersion: after ? { kind: "known", version } : structuredClone(q.installation.installedVersion), resources,
    resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
}
function environment(q: Qualification): Record<string, string> {
  return { HOME: q.home, TMPDIR: join(q.home, "tmp"), PATH: "/usr/bin:/bin",
    AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_CONFIG_DIR: join(q.home, "config"),
    CURSOR_DATA_DIR: join(q.home, "data"), NODE_COMPILE_CACHE: join(q.home, "compile-cache") };
}
/** This is the evidence's Seatbelt confinement, narrowed to the actual six write
 * roots. Personal contents and all network access are denied, including children. */
function command(q: Qualification): CursorCommand {
  const r = geometry(q), supply = dirname(dirname(dirname(q.target.archive.path)));
  const profile = `(version 1)(allow default)(deny network*)(deny file-write*)`
    + `(deny file-read* (subpath "/Users") (subpath ${JSON.stringify(homedir())}))`
    + `(allow file-read-metadata)(allow file-read* (subpath ${JSON.stringify(q.home)})`
    + ` (subpath ${JSON.stringify(dirname(q.originalExecutable))})`
    + ` (literal ${JSON.stringify(q.target.archive.path)}))`
    + `(allow file-write* ${r.roots.map(path => `(subpath ${JSON.stringify(path)})`).join(" ")}`
    + ` (literal "/dev/null"))`;
  valid(absolute(q.home));
  return Object.freeze({ executable: "/usr/bin/sandbox-exec", args: Object.freeze(["-p", profile,
    q.originalExecutable, "install", version, pathToFileURL(supply).href]),
    cwd: q.home, shell: false, inheritEnv: false, env: Object.freeze(environment(q)),
    nativeCompletion: Object.freeze({ kind: "cursor-detached-cleanup",
      executable: join(r.target, "cursor-agent"), args: Object.freeze(["cleanup-install-versions", version]), home: q.home }) });
}
/** Inspect every entry of HOME, including the whole versions owner and aliases.
 * Only native scratch namespaces are nondeterministic; even there reject links,
 * executable files, unexpected names, oversized files and foreign ownership.
 * Scratch bytes are never treated as target/version or completion evidence. */
function inventory(q: Qualification, after: boolean): void {
  const r = geometry(q), expected = new Map<string, { sha256: string; mode: number }>();
  for (const file of q.beforeFiles) expected.set(join(r.source, file.path), file);
  if (after) for (const file of q.expectedFiles) expected.set(join(r.target, file.path), file);
  expected.set(join(q.home, "config/cli-config.json"), { sha256: configDigest, mode: 0o644 });
  if (after) expected.set(join(r.bin, "cursor"), { sha256: shimDigest, mode: 0o755 });
  const aliases = [join(r.bin, "agent"), join(r.bin, "cursor-agent")];
  const directories = new Set([q.home, ...r.roots,
    ...q.beforeDirectories.map(path => join(r.source, path)),
    ...(after ? [...emptyDirectories, ".running"].map(path => join(r.target, path)) : [])]);
  for (const leaf of [...expected.keys(), ...aliases, ...directories]) {
    for (let path = dirname(leaf); path.startsWith(`${q.home}/`); path = dirname(path)) directories.add(path);
  }
  const found = new Set<string>(), links = new Set<string>(), seenDirectories = new Set([q.home]), pending = [q.home];
  let total = 0, count = 0;
  while (pending.length) {
    const dir = pending.pop(); valid(dir !== undefined); directory(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      valid(++count <= 5000);
      const path = join(dir, entry.name), info = lstatSync(path), relative = path.slice(q.home.length + 1);
      if (entry.isDirectory()) {
        valid(directories.has(path) || (after && (
          new RegExp(`^tmp/cursor-agent-logs-${process.getuid?.()}$`).test(relative)
          || /^compile-cache\/v26\.8\.1-arm64-[a-f0-9]{8}-\d+$/.test(relative))));
        seenDirectories.add(path); pending.push(path); continue;
      }
      if (aliases.includes(path)) {
        const target = join(after ? r.target : r.source, "cursor-agent");
        valid(entry.isSymbolicLink() && readlinkSync(path) === target && realpathSync(path) === target
          && info.uid === process.getuid?.()); links.add(path); continue;
      }
      if (after && new RegExp(`^tmp/cursor-agent-logs-${process.getuid?.()}/latest\\.log$`).test(relative)) {
        const target = readlinkSync(path), parent = dirname(path);
        valid(entry.isSymbolicLink() && info.uid === process.getuid?.() && dirname(target) === parent
          && /^session-[0-9TZ.:-]+-\d+-\d+\.log$/.test(target.slice(parent.length + 1))
          && realpathSync(path) === target);
        const logfile = lstatSync(target);
        valid(logfile.isFile() && logfile.nlink === 1 && logfile.uid === process.getuid?.()
          && (logfile.mode & 0o777) === 0o600 && logfile.size < 64 * 1024 * 1024);
        continue;
      }
      valid(entry.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & 0o022) === 0);
      total += info.size; valid(total < 3 * 1024 * 1024 * 1024);
      const file = expected.get(path);
      if (file) { pinned({ path, sha256: file.sha256 }); valid((info.mode & 0o777) === file.mode); found.add(path); continue; }
      valid(after && (info.mode & 0o111) === 0 && info.size < 64 * 1024 * 1024 && (
        /^compile-cache\/v26\.8\.1-arm64-[a-f0-9]{8}-\d+\/[a-f0-9]{8}$/.test(relative)
        || new RegExp(`^tmp/cursor-agent-logs-${process.getuid?.()}/(?:session-[0-9TZ.:-]+-\\d+-\\d+\\.log|latest\\.txt)$`).test(relative)));
    }
  }
  valid(found.size === expected.size && links.size === 2 && [...directories].every(path => seenDirectories.has(path)));
}
/** Source grant is the exact current complete original closure. Old before
 * installation data never selects code to execute or grants future source. */
function original(q: Qualification): void {
  const source = dirname(q.originalExecutable);
  valid(q.originalExecutable === join(source, "cursor-agent")
    && !source.startsWith(`${q.home}/`) && !q.home.startsWith(`${source}/`));
  directory(source);
  const expected = new Map(q.expectedFiles.map(file => [join(source, file.path), file]));
  const dirs = new Set(emptyDirectories.map(path => join(source, path)));
  for (const leaf of [...expected.keys(), ...dirs])
    for (let path = dirname(leaf); path.startsWith(`${source}/`); path = dirname(path)) dirs.add(path);
  const pending = [source]; let count = 0;
  while (pending.length) {
    const dir = pending.pop(); valid(dir !== undefined); directory(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { valid(dirs.has(path)); pending.push(path); continue; }
      const member = expected.get(path); valid(member !== undefined);
      pinned({ path, sha256: member.sha256 });
      valid((lstatSync(path).mode & 0o777) === member.mode); count++;
    }
  }
  valid(count === 447);
}
function fresh(input: NativeCursorUpdateInput, now: number, after = false): void {
  const q = input.qualification, r = geometry(q), t = q.target;
  valid(process.platform === "darwin" && process.arch === "arm64" && plain(input)
    && isDeepStrictEqual(json(input.receipt), q));
  valid(Number.isSafeInteger(now) && Number.isSafeInteger(t.checkedAt) && Number.isSafeInteger(t.expiresAt)
    && t.checkedAt >= 0 && t.checkedAt <= now && now < t.expiresAt && t.expiresAt - t.checkedAt <= 300_000);
  valid(q.home !== homedir() && !homedir().startsWith(`${q.home}/`) && q.home.split("/").length > 3);
  directory(q.home); valid((lstatSync(q.home).mode & 0o777) === 0o700);
  for (const path of r.roots) directory(path);
  valid(isDeepStrictEqual(q.env, environment(q)) && q.installation.owner.kind === "native"
    && q.installation.owner.prefix === q.home && r.source.startsWith(`${r.prefix}/versions/`)
    && dirname(r.source) === join(r.prefix, "versions") && r.source !== r.target
    && !dirname(q.target.archive.path).startsWith(`${q.home}/`));
  valid(t.version === version && t.channel === "prod" && t.archive.sha256 === archiveDigest
    && t.archive.path.endsWith("/darwin/arm64/agent-cli-package.tar.gz"));
  pinned(t.archive);
  const manifest = json(q.manifest);
  valid(Array.isArray(manifest) && q.expectedFiles.length === 447
    && isDeepStrictEqual(manifest, q.expectedFiles) && hash(JSON.stringify(manifest)) === manifestDigest);
  const relative = (path: string) => path.length > 0 && !path.startsWith("/")
    && !/[\u0000-\u001f\u007f\\]/.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
  valid(q.beforeFiles.length > 0 && q.beforeFiles.length < 5000
    && new Set(q.beforeFiles.map(file => file.path)).size === q.beforeFiles.length
    && q.beforeFiles.every(file => relative(file.path) && !file.path.startsWith(".running/") && /^[a-f0-9]{64}$/.test(file.sha256)
      && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && (file.mode === 0o644 || file.mode === 0o755))
    && ["cursor-agent", "node", "index.js"].every(path => q.beforeFiles.some(file =>
      file.path === path && file.bytes > 0 && file.mode === (path === "index.js" ? 0o644 : 0o755)))
    && q.beforeDirectories.length < 5000 && q.beforeDirectories.every(relative));
  valid(q.installation.installedVersion.kind === "known"
    && q.installation.installedVersion.version === (q.beforeInstaller.sha256 === installerDigest ? version : "2026.01.23-916f423")
    && !q.beforeInstaller.path.startsWith(`${q.home}/`)
    && [installerDigest, legacyInstallerDigest].includes(q.beforeInstaller.sha256)
    && q.installation.owner.installerDigest === `sha256:${q.beforeInstaller.sha256}`
    && isDeepStrictEqual(q.installation, identity(q, false)));
  valid(q.beforeInstaller.sha256 === installerDigest ? isDeepStrictEqual(q.beforeFiles, q.expectedFiles)
    : hash(JSON.stringify(q.beforeFiles.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })))) === legacyManifestDigest);
  pinned(q.beforeInstaller); original(q);
  valid(isDeepStrictEqual(q.dependencies.map(pin => pin.path).sort(), dependencyPaths));
  for (const pin of q.dependencies) { pinned(pin, true); valid((lstatSync(pin.path).mode & 0o111) !== 0); }
  valid(realpathSync("/usr/bin/tar") === "/usr/bin/bsdtar" && lstatSync("/usr/bin/tar").uid === 0);
  // PATH selects the qualified /bin/realpath, not an earlier unqualified tool.
  valid(!lstatSync("/usr/bin/realpath", { throwIfNoEntry: false })
    && !lstatSync("/usr/bin/bash", { throwIfNoEntry: false }));
  const release = json(t.release);
  valid(isDeepStrictEqual(release, { method: "POST",
    url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl",
    request: { channel: "prod" }, status: 200,
    response: { version, url: `https://downloads.cursor.com/lab/${version}/` } }));
  valid(!lstatSync(join(r.prefix, ".install.lock"), { throwIfNoEntry: false })
    && !lstatSync(join(r.prefix, "versions", `.${version}`), { throwIfNoEntry: false }));
  if (!after) valid(!lstatSync(r.target, { throwIfNoEntry: false }));
  inventory(q, after);
}

export async function qualifyCursorUpdate(input: NativeCursorUpdateInput, now: number): Promise<AdapterResult<PrivateUpdateContext>> {
  try {
    valid(plain(input)); const snapshot = structuredClone(input); fresh(snapshot, now);
    const context: PrivateUpdateContext = Object.freeze({ kind: "cursor-original-update" });
    contexts.set(context, snapshot); return { ok: true, value: context };
  } catch { return failure(); }
}
export function createCursorUpdateSpec(context: PrivateUpdateContext, request: Mode | PrivateUpdateIntent,
  now: number): AdapterResult<CursorSpec> {
  try {
    const input = contexts.get(context); valid(input !== undefined && !consumed.has(context) && plain(request));
    fresh(input, now); const q = input.qualification, mode = typeof request === "string" ? request : request.mode;
    valid(mode === "update-only" || mode === "update-and-restart");
    const intent: PrivateUpdateIntent = Object.freeze({ operationId: typeof request === "string" ? randomUUID() : request.operationId,
      family: "cursor", mode, installationId: q.installation.installationId,
      targetFingerprint: hash(JSON.stringify(q.target)), provenanceDigest: input.receipt.sha256, managerDigest: installerDigest });
    valid(/^[A-Za-z0-9._:-]{1,128}$/.test(intent.operationId)
      && (typeof request === "string" || isDeepStrictEqual(request, intent)));
    const invocation = command(q);
    const mutationRoots = geometry(q).roots;
    const mutationResources = [...structuredClone(q.installation.resources), ...mutationRoots.map(root => ({
      resourceId: `resource:${hash(root)}`, realpath: root,
      fingerprint: `sha256:${hash(JSON.stringify([root, q.beforeFiles, q.beforeDirectories, configDigest]))}`,
    }))].sort((a, b) => a.realpath.localeCompare(b.realpath));
    const spec: CursorSpec = { command: { executable: invocation.executable, args: invocation.args, cwd: invocation.cwd },
      mode, expectedInstallation: structuredClone(q.installation), mutationResources,
      expectedAfter: identity(q, true), mutationRoots, execution: context };
    issued.set(spec, { input, context, snapshot: { ...structuredClone(spec), execution: context }, intent });
    return { ok: true, value: spec };
  } catch { return failure(); }
}
export function getCursorUpdateIntent(spec: UpdateSpec): AdapterResult<PrivateUpdateIntent> {
  try {
    const record = issued.get(spec);
    return record && plain(spec) && record.context === spec.execution && isDeepStrictEqual(record.snapshot, spec)
      ? { ok: true, value: record.intent } : failure();
  } catch { return failure(); }
}
export async function executeCursorUpdate(spec: UpdateSpec, executor: OmoUpdateExecutor): Promise<AdapterResult<PrivateUpdateObservation>> {
  let attempted = false;
  try {
    const authenticated = getCursorUpdateIntent(spec), record = issued.get(spec);
    valid(authenticated.ok && record !== undefined && !consumed.has(record.context)
      && !operations.has(record.intent.operationId));
    // Consume the entire intent before the first supplied hook or await.
    consumed.add(record.context); operations.add(record.intent.operationId);
    const clock = executor.now, event = executor.event, run = executor.run;
    fresh(record.input, clock());
    await event?.({ kind: "intent", intent: record.intent });
    fresh(record.input, clock());
    await event?.({ kind: "dispatch", intent: record.intent });
    fresh(record.input, clock());
    valid(getCursorUpdateIntent(spec).ok);
    const invocation = command(record.input.qualification);
    valid(isDeepStrictEqual(record.snapshot.command, {
      executable: invocation.executable, args: invocation.args, cwd: invocation.cwd }));
    attempted = true;
    // Parent run owns original process AND detached cleanup join/reaping.
    const result = await run(invocation);
    valid(plain(result) && (result.status === null || (Number.isInteger(result.status)
      && result.status >= 0 && result.status <= 255)) && (result.signal === null || typeof result.signal === "string"));
    await event?.({ kind: "exit", intent: record.intent, status: result.status, signal: result.signal });
    valid(result.status === 0 && result.signal === null);
    fresh(record.input, clock(), true);
    valid(getCursorUpdateIntent(spec).ok);
    return { ok: true, value: { kind: "files-verified", intent: record.intent, durableReceipt: false } };
  } catch { return failure(attempted ? "recovery_required" : "verification_failed"); }
}
