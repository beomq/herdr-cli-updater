import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, cpSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { qualifyPackageUpdate, snapshotPackageOpaqueNpmrc } from "../adapters/package-update";
import type { PackageArtifact, PackageOpaqueNpmrc, PackagePrefixSnapshot, PackageUpdateQualification } from "../adapters/package-update";
import type { InstallationIdentity } from "../adapters/types";
import type { UpdateFilePin } from "../adapters/update-context";
import { prepareCodexRuntime } from "./codex-runtime";
import type { CodexRuntimeCandidate } from "./codex-runtime";
import { discoverExecutable } from "../discovery";
import { PACKAGE_OPERATING_RUNTIME_PROFILE, validatePackageRuntimeInputs } from "./package-runtime";
import type { PackageRuntimeInputs } from "./package-runtime";
import { releaseFailedPreparation } from "./preparation-retention";

export type PrepareNpmInstallationOptions = {
  /** Empty, canonical, caller-owned 0700 directory. Never an installation root. */
  readonly directory: string;
  readonly prefix: string;
  readonly executable: string;
  readonly npm: string;
  readonly node: string;
  readonly ownerDirectory: string;
  readonly socketDirectory: string;
  readonly registeredSockets: readonly string[];
  readonly native?: CodexRuntimeCandidate;
  /** Stable herdr anchors already identified by the caller's owned control
   * connection, not the short-lived prepare command or a replaceable worker.
   * This producer verifies incarnation, not herdr identity from a PID alone. */
  readonly rootPids: readonly number[];
};
export type PreparedNpmInstallation = {
  readonly inputs: PackageRuntimeInputs;
  readonly configurationPin: UpdateFilePin;
};
export class PackagePreparationError extends Error {
  constructor(readonly reason: "geometry" | "configuration" | "manager" | "source" | "lifecycle"
    | "calibration" | "path_dependent" | "source_changed" | "qualification", readonly detail: string) {
    super(`${reason}: ${detail}`);
  }
}

const name = "@openai/codex";
const registry = "https://registry.npmjs.org";
const latestUrl = `${registry}/${encodeURIComponent(name)}/latest`;
const tagsUrl = `${registry}/-/package/${encodeURIComponent(name)}/dist-tags`;
const githubUrl = "https://api.github.com/repos/openai/codex/releases/latest";
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const forbidden = new Set([".npmrc", "npmrc", ".env", ".env.local", ".env.production", ".env.development",
  ".bunfig.toml", "bunfig.toml", ".ssh", ".aws", ".config", ".codex", ".claude", ".opencodex", ".grok"]);
function need(condition: boolean, reason: PackagePreparationError["reason"], detail: string): asserts condition {
  if (!condition) throw new PackagePreparationError(reason, detail);
}
function object(value: unknown): Record<string, unknown> {
  need(typeof value === "object" && value !== null && !Array.isArray(value), "source", "expected JSON object");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  need(typeof value === "string" && value.length > 0, "source", "expected nonempty string");
  return value;
}
function canonical(path: string): void {
  need(isAbsolute(path) && normalize(path) === path && !/[\x00-\x1f\x7f\\]/.test(path)
    && realpathSync(path) === path, "geometry", `noncanonical path: ${path}`);
}
function directory(path: string, privateMode = false): void {
  canonical(path);
  const info = lstatSync(path);
  need(info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o022) === 0
    && (!privateMode || (info.mode & 0o777) === 0o700), "geometry", `directory ownership/mode: ${path}`);
}
function mkdir(path: string): void { mkdirSync(path, { mode: 0o700 }); }
function pin(path: string, singleLink = true): UpdateFilePin {
  need(!path.endsWith("/.npmrc"), "configuration", `config cannot be content-pinned: ${path}`);
  canonical(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    need(before.isFile() && before.uid === BigInt(process.getuid?.() ?? -1) && (before.mode & 0o022n) === 0n
      && (!singleLink || before.nlink === 1n) && before.size <= 2n * 1024n ** 3n, "geometry", `unsafe file: ${path}`);
    const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < Number(before.size);) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      need(count > 0, "source_changed", path); digest.update(buffer.subarray(0, count)); offset += count;
    }
    for (const after of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })]) {
      need(after.dev === before.dev && after.ino === before.ino && after.size === before.size
        && after.mode === before.mode && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs,
      "source_changed", path);
    }
    canonical(path);
    return { path, sha256: digest.digest("hex") };
  } finally { closeSync(fd); }
}
function document(path: string): Record<string, unknown> {
  const expected = pin(path);
  need(lstatSync(path).size <= 1024 * 1024, "source", `manifest too large: ${path}`);
  const bytes = readFileSync(path);
  need(hash(bytes) === expected.sha256, "source_changed", path);
  return object(JSON.parse(bytes.toString("utf8")));
}
function put(path: string, bytes: string | Uint8Array): UpdateFilePin {
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return { path, sha256: hash(bytes) };
}
function record(path: string, value: unknown): UpdateFilePin { return put(path, `${JSON.stringify(value)}\n`); }

/** Inspect names and geometry BEFORE reading any content. Unsupported configs
 * are rejected, not copied, parsed, or silently stripped from the clone. */
function tree(root: string, manager = false, opaquePath?: string): PackagePrefixSnapshot {
  directory(root);
  const paths: string[] = [], links: { path: string; target: string }[] = [];
  const opaque: PackageOpaqueNpmrc[] = [];
  const pending = [root];
  let bytes = 0, entries = 0;
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    directory(dir);
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry), info = lstatSync(path), local = path.slice(root.length + 1);
      need(++entries <= 200_000, "geometry", "prefix entry limit");
      if (path === opaquePath) { opaque.push(snapshotPackageOpaqueNpmrc(path)); continue; }
      need(!forbidden.has(entry), "configuration", `unsupported config/session entry: ${path}`);
      need(info.uid === process.getuid?.(), "geometry", `foreign owner: ${path}`);
      if (info.isDirectory()) pending.push(path);
      else if (info.isSymbolicLink()) {
        const target = readlinkSync(path);
        need(!manager && !isAbsolute(target) && !/[\x00-\x1f\x7f\\]/.test(target)
          && resolve(dirname(path), target).startsWith(`${root}/`) && realpathSync(path).startsWith(`${root}/`),
        "path_dependent", `nonportable link: ${path}`);
        need(!/(?:^|\/)(?:package\.json|.*lock|\.npmrc)$/.test(local), "configuration", `linked control: ${path}`);
        links.push({ path: local, target });
      } else {
        need(info.isFile() && (info.mode & 0o022) === 0, "geometry", `unsupported entry: ${path}`);
        bytes += info.size;
        need(bytes <= 32 * 1024 ** 3, "geometry", "prefix byte limit");
        paths.push(path);
      }
    }
  }
  const files = paths.map(path => ({
    path: path.slice(root.length + 1),
    sha256: pin(path, manager || /(?:^|\/)(?:package\.json|.*lock)$/.test(path)).sha256,
    mode: lstatSync(path).mode & 0o777,
  }));
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), links: links.sort((a, b) => a.path.localeCompare(b.path)),
    ...(opaque.length ? { opaque } : {}) };
}
type Acquired = {
  readonly metadata: UpdateFilePin;
  readonly archive: UpdateFilePin;
  readonly meta: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
  readonly bytes: Uint8Array;
};
function noLifecycle(pkg: Record<string, unknown>): void {
  const scripts = pkg["scripts"] === undefined ? {} : object(pkg["scripts"]);
  need(["preinstall", "install", "postinstall", "prepublish", "prepare", "preprepare", "postprepare"]
    .every(key => scripts[key] === undefined), "lifecycle", "first Codex producer supports packages without install hooks only");
  need(["dependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]
    .every(key => pkg[key] === undefined || Object.keys(object(pkg[key])).length === 0),
  "source", "unsupported Codex dependency graph");
}
async function bounded(response: Response, maximum: number): Promise<Uint8Array> {
  need(response.status === 200 && response.body !== null, "source", `HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length; need(size <= maximum, "source", "response size limit"); chunks.push(part.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function managerPins(npm: string, node: string, opaque?: PackageOpaqueNpmrc) {
  canonical(npm); canonical(node);
  need(npm.endsWith("/bin/npm-cli.js") && node.endsWith("/node")
    && (lstatSync(npm).mode & 0o111) !== 0 && (lstatSync(node).mode & 0o111) !== 0, "manager", "original npm/Node entrypoints required");
  const root = dirname(dirname(npm)), inventory = tree(root, true, opaque?.path);
  need(opaque === undefined || (opaque.path === join(root, ".npmrc")
    && isDeepStrictEqual(inventory.opaque, [opaque])), "source_changed", "original npm config metadata changed");
  need(document(join(root, "package.json"))["name"] === "npm", "manager", "not an npm installation");
  return { name: "npm" as const, ...pin(npm), node: pin(node),
    files: inventory.files.map(file => ({ path: join(root, file.path), sha256: file.sha256 })) };
}
function coverage(options: PrepareNpmInstallationOptions): readonly string[] {
  directory(options.socketDirectory, true);
  need(new Set(options.registeredSockets).size === options.registeredSockets.length
    && new Set(options.rootPids).size === options.rootPids.length, "geometry", "duplicate coverage coordinates");
  for (const path of options.registeredSockets) {
    directory(dirname(path), true);
    const info = lstatSync(path);
    need(info.isSocket() && info.uid === process.getuid?.(),
      "geometry", `unowned or missing registered socket: ${path}`);
  }
  const census = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,uid=,lstart="], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  }).trim().split("\n");
  return options.rootPids.map(pid => {
    const row = census.find(line => Number(/^\s*(\d+)\s/.exec(line)?.[1]) === pid);
    need(row !== undefined && Number(/^\s*\d+\s+\d+\s+(\d+)\s/.exec(row)?.[1]) === process.getuid?.(),
      "geometry", `missing/foreign coverage anchor: ${pid}`);
    return row.trim();
  });
}
function identityAfter(before: InstallationIdentity, after: PackagePrefixSnapshot, version: string): InstallationIdentity {
  need(before.owner.kind === "package", "geometry", "package owner required");
  const prefix = before.owner.prefix;
  const resources = before.resources.map(resource => {
    const file = after.files.find(file => join(prefix, file.path) === resource.realpath);
    need(file !== undefined, "calibration", `missing after resource: ${resource.realpath}`);
    return { ...resource, fingerprint: `sha256:${file.sha256}` };
  });
  return { ...before, installedVersion: { kind: "known", version }, resources,
    resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
}

/** One explicitly selected npm/Codex installation. The seam supplies public
 * bytes only; command, argv, environment, jail and original manager are fixed.
 * Calibration NEVER invokes npm against options.prefix. Files left on failure
 * remain in the exclusively caller-owned preparation directory for inspection.
 */
export async function prepareNpmInstallationRuntime(options: PrepareNpmInstallationOptions,
  source: { readonly request?: (request: Request) => Promise<Response> } = {}): Promise<PreparedNpmInstallation> {
  need(process.platform === "darwin" && ["arm64", "x64"].includes(process.arch), "geometry", "supported Darwin npm installation required");
  directory(options.prefix); directory(options.directory, true);
  need(options.directory !== options.prefix && !options.directory.startsWith(`${options.prefix}/`)
    && !options.prefix.startsWith(`${options.directory}/`) && readdirSync(options.directory).length === 0,
  "geometry", "preparation root must be empty and disjoint from installation");
  directory(options.ownerDirectory, true); directory(options.socketDirectory, true);
  need(options.socketDirectory === options.ownerDirectory
    && options.rootPids.length > 0 && options.rootPids.every(pid => Number.isSafeInteger(pid) && pid > 1)
    && options.registeredSockets.length > 0 && options.registeredSockets.every(path =>
      path.startsWith(`${options.socketDirectory}/`) && normalize(path) === path), "geometry", "explicit live coverage coordinates required");
  const anchors = coverage(options);
  const primary = join(options.prefix, "lib/node_modules", name), manifestPath = join(primary, "package.json");
  // Refuse a shim before reading package content, cloning, or making requests.
  const selected = realpathSync(options.executable), defaultBin = join(options.prefix, "bin/codex");
  need(selected.startsWith(`${primary}/`) && realpathSync(defaultBin) === selected
    && lstatSync(defaultBin).isSymbolicLink(), "geometry", "selected executable and prefix/bin/codex must be the original package bin; wrappers unsupported");
  const npm = realpathSync(options.npm), node = realpathSync(options.node), managerRoot = dirname(dirname(npm));
  const opaquePath = join(managerRoot, ".npmrc");
  const opaque = managerRoot === join(options.prefix, "lib/node_modules/npm")
    && lstatSync(opaquePath, { throwIfNoEntry: false }) ? snapshotPackageOpaqueNpmrc(opaquePath) : undefined;
  const before = tree(options.prefix, false, opaque?.path), pkg = document(manifestPath), bins = object(pkg["bin"]);
  need(pkg["name"] === name && typeof pkg["version"] === "string" && typeof bins["codex"] === "string"
    && realpathSync(resolve(primary, bins["codex"])) === selected, "geometry", "Codex package/bin binding mismatch");
  need(/^\d+\.\d+\.\d+$/.test(pkg["version"]), "source", "stable installed Codex version required");
  const manager = managerPins(npm, node, opaque);
  need(!manager.path.startsWith(`${options.directory}/`) && !manager.node.path.startsWith(`${options.directory}/`),
    "manager", "manager must preexist preparation");
  const root = options.directory, home = join(root, "home"), acquisitions = join(root, "acquired");
  try {
  mkdir(home); mkdir(acquisitions);
  const env = { HOME: home, PATH: [...new Set([dirname(manager.path), dirname(manager.node.path)])].join(":") };
  const owner = { kind: "package", manager: "npm", prefix: options.prefix, packageName: name } as const;
  const resources = [manifestPath, selected].sort().map(path => ({ path, sha256: pin(path).sha256 }));
  const discovery = record(join(root, "discovery.json"), { family: "codex", executable: selected, channel: "latest",
    owner, packageManifest: manifestPath, resources });
  const discovered = await discoverExecutable({ executable: options.executable, family: "codex", provenance: [discovery] });
  need(discovered.ok && discovered.value.qualification.kind === "known", "geometry", "original executable discovery failed");
  const installedResources = discovered.value.installation.resources.filter(row => row.realpath !== discovery.path);
  const installation = { ...discovered.value.installation, resources: installedResources,
    resourcesFingerprint: `sha256:${hash(JSON.stringify(installedResources))}` };
  const replies: PackageRuntimeInputs["profiles"][number]["acquiredReplies"][number][] = [];
  const request = source.request ?? ((request: Request) => fetch(request));
  async function acquire(url: string, maximum = 32 * 1024 * 1024): Promise<Uint8Array> {
    const parsed = new URL(url);
    need((parsed.origin === registry || url === githubUrl) && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash, "source", "nonofficial acquisition URL");
    const response = await request(new Request(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(120_000) }));
    return bounded(response, maximum);
  }
  async function reply(url: string, filename: string) {
    const bytes = await acquire(url), body = put(join(acquisitions, filename), bytes);
    replies.push({ url, status: 200, body });
    return object(JSON.parse(Buffer.from(bytes).toString("utf8")));
  }
  const latest = await reply(latestUrl, "latest.json"), tags = await reply(tagsUrl, "tags.json"), github = await reply(githubUrl, "github.json");
  const version = string(latest["version"]);
  need(latest["name"] === name && /^\d+\.\d+\.\d+$/.test(version) && tags["latest"] === version
    && github["tag_name"] === `rust-v${version}` && github["draft"] === false && github["prerelease"] === false
    && Bun.semver.order(version, pkg["version"]) > 0, "source", "official stable sources must agree on a newer Codex version");
  const acquired: Acquired[] = [];
  async function artifact(metadata: Record<string, unknown>, label: string): Promise<Acquired> {
    noLifecycle(metadata);
    const dist = object(metadata["dist"]), url = string(dist["tarball"]), integrity = string(dist["integrity"]);
    need(metadata["name"] === name && /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
      && new URL(url).pathname.startsWith(`/${name}/-/`), "source", "Codex artifact identity/integrity");
    const bytes = await acquire(url, 512 * 1024 * 1024);
    need(`sha512-${createHash("sha512").update(bytes).digest("base64")}` === integrity, "source", "archive integrity mismatch");
    const members = await new Bun.Archive(bytes).files(), entry = members.get("package/package.json");
    need(entry !== undefined && entry.size <= 1024 * 1024 && members.size < 20_000, "source", "archive manifest missing/too large");
    for (const member of members.keys()) {
      need(member.startsWith("package/") && member.split("/").every(part => part !== ".." && part !== ".")
        && !/[\\\x00-\x1f\x7f]/.test(member) && !member.endsWith("/binding.gyp"), "source", "unsupported archive member");
    }
    const manifest = object(JSON.parse(await entry.text()));
    noLifecycle(manifest);
    need(manifest["name"] === name && manifest["version"] === metadata["version"], "source", "archive identity mismatch");
    const result = { metadata: record(join(acquisitions, `${label}.json`), metadata),
      archive: put(join(acquisitions, `${label}.tgz`), bytes), meta: metadata, manifest, bytes };
    acquired.push(result); return result;
  }
  const main = await artifact(latest, "main"), optional = object(main.manifest["optionalDependencies"] ?? {});
  const platformSlot = `@openai/codex-darwin-${process.arch}`;
  const platformSpec = optional[platformSlot];
  // Controlled packages may have no optional payload; genuine Codex must retain
  // its literal npm alias. Other required/deep graphs are deliberately refused.
  if (Object.keys(optional).length > 0) {
    need(typeof platformSpec === "string" && platformSpec === `npm:${name}@${version}-darwin-${process.arch}`,
      "source", "unsupported Codex platform alias");
    const metadata = object(JSON.parse(Buffer.from(await acquire(`${registry}/${encodeURIComponent(name)}/${version}-darwin-${process.arch}`)).toString("utf8")));
    need(metadata["version"] === `${version}-darwin-${process.arch}`, "source", "platform version mismatch");
    await artifact(metadata, "platform");
  }
  const sandbox = "/usr/bin/sandbox-exec";
  // The system executable is root-owned; don't pass it through the user file pin.
  const system = { path: sandbox, sha256: hash(readFileSync(sandbox)) } as const;
  const startRegistry = () => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const row = acquired.find(row => url.pathname === `/tarballs/${row.archive.sha256}.tgz`);
    if (row) return new Response(row.bytes);
    if (decodeURIComponent(url.pathname.slice(1)) !== name) return new Response(null, { status: 404 });
    return Response.json({ name, "dist-tags": { latest: version }, versions: Object.fromEntries(acquired.map(row => [
      string(row.meta["version"]), { ...row.meta, dist: { ...object(row.meta["dist"]), tarball: `${url.origin}/tarballs/${row.archive.sha256}.tgz` } },
    ])) });
  } });
  // Keep both listeners alive so the calibrations cannot accidentally reuse a
  // port. Prefix files containing a clone path OR a leased registry URL differ.
  const servers = [startRegistry(), startRegistry()];
  const observations: PackagePrefixSnapshot[] = [];
  const commands: unknown[] = [];
  try {
    for (const [index, label] of ["calibration-a", "calibration-b"].entries()) {
      const server = servers[index];
      need(server !== undefined, "calibration", "calibration registry missing");
      const calibrationRegistry = `http://127.0.0.1:${server.port}`;
      const scope = join(root, label), prefix = join(scope, "prefix"), cache = join(scope, "cache"), tmp = join(scope, "tmp");
      mkdir(scope); mkdir(cache); mkdir(tmp);
      cpSync(options.prefix, prefix, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true,
        filter: path => {
          if (path === opaque?.path) return false;
          need(!forbidden.has(path.split("/").at(-1) ?? ""), "configuration", `unsupported clone entry: ${path}`);
          return true;
        } });
      need(isDeepStrictEqual(tree(prefix), { files: before.files, links: before.links }),
        "source_changed", "clone does not match complete operating before inventory");
      const userconfig = put(join(scope, "user.npmrc"), ""), globalconfig = put(join(scope, "global.npmrc"), "");
      const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
      const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
      const policy = `(version 1)
(allow default)
(deny file-read* file-write*)
(allow file-read-metadata)
(allow file-read* ${[literal("/"), ...["/System/Cryptexes", "/System/Volumes/Preboot/Cryptexes", "/System/Library",
        "/usr/lib", "/usr/share", "/Library/Apple/System/Library", "/private/var/db/dyld", "/private/var/db/timezone", "/var/db/timezone"].map(subpath),
        ...["/private/etc/hosts", "/private/etc/resolv.conf", "/private/etc/localtime", "/dev/null", "/dev/random", "/dev/urandom", "/bin/sh", "/usr/bin/env",
          manager.node.path].map(literal), subpath(dirname(dirname(manager.path))), subpath(scope)].join(" ")})
(allow file-write* ${subpath(scope)})
(allow file-write-data (literal "/dev/null"))
${opaque ? `(deny file-read-data file-write* ${literal(opaque.path)})\n` : ""}(deny network*)
(allow network-outbound (remote ip "localhost:${server.port}"))
(deny signal)
(allow signal (target same-sandbox))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.CredentialStore"))`;
      const args = ["install", "--global", "--prefix", prefix, `${name}@${version}`, "--registry", calibrationRegistry,
        "--cache", cache, "--userconfig", userconfig.path, "--globalconfig", globalconfig.path,
        "--no-audit", "--no-fund", "--fetch-retries", "0", "--force", "--script-shell=/bin/sh"];
      const environment = { ...env, TMPDIR: tmp, npm_config_prefix: prefix, npm_config_cache: cache,
        npm_config_userconfig: userconfig.path, npm_config_globalconfig: globalconfig.path,
        npm_config_registry: calibrationRegistry, npm_config_script_shell: "/bin/sh" };
      need(isDeepStrictEqual(managerPins(manager.path, manager.node.path, opaque), manager),
        "source_changed", "original npm/Node closure changed");
      const child = Bun.spawn([sandbox, "-p", policy, manager.path, ...args],
        { cwd: prefix, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      let status: number, stdout: string, stderr: string;
      try { [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
      finally { clearTimeout(timer); }
      commands.push({ prefix, executable: manager.path, args, env: environment, umask: process.umask(), status,
        stdout: put(join(scope, "stdout.txt"), stdout), stderr: put(join(scope, "stderr.txt"), stderr),
        policy: put(join(scope, "sandbox.sb"), policy) });
      need(status === 0, "calibration", `original npm exited ${status}; see ${scope}/stderr.txt`);
      observations.push({ ...tree(prefix), ...(before.opaque ? { opaque: before.opaque } : {}) });
    }
  } finally { await Promise.all(servers.map(server => server.stop(true))); }
  const after = observations[0];
  need(after !== undefined && isDeepStrictEqual(after, observations[1]), "path_dependent", "independent clone after inventories differ");
  need(isDeepStrictEqual(tree(options.prefix, false, opaque?.path), before), "source_changed", "operating prefix changed during calibration");
  need(isDeepStrictEqual(managerPins(manager.path, manager.node.path, opaque), manager),
    "source_changed", "original npm/Node closure changed");
  const artifacts: PackageArtifact[] = acquired.map(row => {
    const slots = row === main ? [name] : [`${name}/node_modules/${platformSlot}`, platformSlot];
    const selectedSlots = slots.filter(slot => {
      const file = after.files.find(file => file.path === `lib/node_modules/${slot}/package.json`);
      if (!file) return false;
      const manifest = document(join(root, "calibration-a/prefix", file.path));
      return manifest["name"] === row.manifest["name"] && manifest["version"] === row.manifest["version"];
    });
    need(selectedSlots.length === 1 && selectedSlots[0] !== undefined, "calibration", "ambiguous/missing installed artifact slot");
    return { name, installName: selectedSlots[0], version: string(row.manifest["version"]), archive: row.archive, metadata: row.metadata };
  });
  // Do not renew an old receipt. Reacquire all public check replies after the
  // potentially long calibration, and require exactly the same release.
  const finalLatest = await reply(latestUrl, "final-latest.json"), finalTags = await reply(tagsUrl, "final-tags.json"),
    finalGithub = await reply(githubUrl, "final-github.json");
  need(isDeepStrictEqual(finalLatest, latest) && finalTags["latest"] === version
    && finalGithub["tag_name"] === `rust-v${version}` && finalGithub["draft"] === false && finalGithub["prerelease"] === false,
    "source_changed", "official release changed during calibration");
  const checkedAt = Date.now();
  const qualification: PackageUpdateQualification = { installation, manager, env,
    target: { packageName: name, version, channel: "latest", checkedAt, expiresAt: checkedAt + 300_000, artifacts, postinstall: [] },
    before, after, confinement: { kind: "operating-prefix", root, system } };
  const receipt = record(join(root, "qualification.json"), qualification);
  const qualified = await qualifyPackageUpdate({ qualification, receipt }, Date.now());
  need(qualified.ok, "qualification", "existing package issuer rejected observed calibration");
  need(Date.now() < qualification.target.expiresAt, "source_changed", "target expired during qualification; prepare again");
  need(isDeepStrictEqual(coverage(options), anchors), "source_changed", "coverage anchor changed during preparation");
  const expectedAfterPin = record(join(root, "expected-after.json"), identityAfter(installation, after, version));
  record(join(root, "preparation.json"), { originalManager: manager, originalPrefix: options.prefix,
    before, after, commands, anchors, pathIndependentCalibrations: 2, operatingMutation: false, checkedAt });
  const native = options.native ? await prepareCodexRuntime(options.native) : undefined;
  const inputs = validatePackageRuntimeInputs({ schemaVersion: 1, profile: PACKAGE_OPERATING_RUNTIME_PROFILE,
    ownerDirectory: options.ownerDirectory, profiles: [{ update: { qualification, receipt }, sourcePins: [discovery],
      ...(native ? { native } : {}),
      expectedAfterPin, acquiredReplies: replies.slice(-3),
      coverage: { root, prefix: options.prefix, socketDirectory: options.socketDirectory,
        registeredSockets: options.registeredSockets, rootPids: options.rootPids } }] });
  const configurationPin = record(join(root, "package-runtime.json"), inputs);
  return { inputs, configurationPin };
  } finally { releaseFailedPreparation(root); }
}
