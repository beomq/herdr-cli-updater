import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createOmoUpdateSpec, executeOmoUpdate, isAuditedOmoTrustedLifecycle,
  qualifyOmoUpdate, reviewedOmoTrustNames } from "../adapters/update-context";
import type { OmoArtifact, OmoUpdateQualification, UpdateFilePin } from "../adapters/update-context";
import type { InstallationIdentity, PrivateUpdateCommand } from "../adapters/types";
import { OMO_UPDATE_RUNTIME_PROFILE, validateOmoUpdateRuntimeInputs } from "./omo-update-runtime";
import type { OmoUpdateRuntimeInputs } from "./omo-update-runtime";
import { releaseFailedPreparation } from "./preparation-retention";

// allow: SIZE_OK — the assigned new-file boundary keeps this single preparation
// transaction, its public-source parser and its independently observed evidence together.
export type PrepareOmoRuntimeOptions = {
  readonly directory: string;
  readonly prefix: string;
  readonly bun: string;
  readonly ownerDirectory: string;
  readonly socketDirectory: string;
  readonly registeredSockets: readonly string[];
  readonly rootPids: readonly number[];
};
export type PreparedOmoRuntime = {
  readonly inputs: OmoUpdateRuntimeInputs;
  readonly configurationPin: UpdateFilePin;
};
export class OmoPreparationError extends Error {
  constructor(readonly reason: "geometry" | "configuration" | "source" | "source_changed"
    | "calibration" | "path_dependent" | "qualification", readonly detail: string) {
    super(`${reason}: ${detail}`); this.name = "OmoPreparationError";
  }
}
const registry = "https://registry.npmjs.org";
// Versions may advance while the audited lifecycle and publish transform stay
// identical. Registry integrity and source agreement remain mandatory; a new
// lifecycle implementation still needs review, not a new version allowlist.
const audited = {
  "bin/senpi-patch.mjs": "ea0ddab45598cd9df0f7d05c277881a8f049ce710a3de6f831bd175680fe0145",
  "bin/lib/bun-bin-shim.js": "f5278e37090e46183d11e7816d79747510bb5de76a7851f555e8e3bf198827f7",
  "bin/lib/bun-runtime.js": "c32f583bbfc5735157f092f43c8009d60301e8ec9fa5432032333afcc841a86e",
  "bin/lib/child-process.js": "2dc0b5cd1d9c01bc85d230b178b238004908d8e3d933de307453312e0479d0ae",
  "bin/lib/engine-prepare.js": "ee5a3c38d265c20395996d9eb69434fe1fbb9f26ae76d1cb71d130444dd01f21",
  "bin/lib/engine-dependency.js": "1009e10b535da973f7bb9ed562de49214de69adcafb396d48fe7376188e73d40",
  "bin/lib/compile-safe-engine.js": "eed2f056c8519482152ceeada553c9b276d55006d0c4f84d1751ab73637d9602",
  "bin/lib/claude-code-floor.js": "77ab5ba7ff3117e0ad9edb7d66287bb3a23f7abee3f4bf75ea0c43df55e84fcc",
  "bin/lib/rpc-stream-errors.js": "9acab07efe3bb0f098c30591a215b558fda9a2effa28a2ad784e72b270d82d5b",
  "bin/lib/launch-spec-mode.js": "baf57600b12b44d5bd4978ded84456c82b20f94d40151b0f2c899c0335d79dc4",
} as const;
const forbidden = new Set([".npmrc", ".bunfig.toml", "bunfig.toml", ".env", ".env.local", ".env.production",
  ".env.development", ".ssh", ".aws"]);
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function need(condition: boolean, reason: OmoPreparationError["reason"], detail: string): asserts condition {
  if (!condition) throw new OmoPreparationError(reason, detail);
}
function object(value: unknown): Record<string, unknown> {
  need(typeof value === "object" && value !== null && !Array.isArray(value), "source", "expected JSON object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  need(typeof value === "string" && value.length > 0, "source", "expected nonempty string"); return value;
}
function canonical(path: string): void {
  need(isAbsolute(path) && normalize(path) === path && !/[\x00-\x1f\x7f\\]/.test(path)
    && realpathSync(path) === path, "geometry", `noncanonical path: ${path}`);
}
function directory(path: string, privateMode = false): void {
  canonical(path); const stat = lstatSync(path);
  need(stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0
    && (!privateMode || (stat.mode & 0o777) === 0o700), "geometry", `unsafe directory: ${path}`);
}
function pin(path: string): UpdateFilePin {
  canonical(path); const before = lstatSync(path, { bigint: true });
  need(before.isFile() && before.size <= 256n * 1024n ** 2n,
    "geometry", `unsafe/oversized file: ${path}`);
  const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
  need(before.dev === after.dev && before.ino === after.ino && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs && before.size === after.size, "source_changed", path);
  return { path, sha256: hash(bytes) };
}
function document(path: string): Record<string, unknown> {
  const reference = pin(path); need(lstatSync(path).size <= 16 * 1024 * 1024, "source", "oversized manifest");
  const bytes = readFileSync(path); need(hash(bytes) === reference.sha256, "source_changed", path);
  return object(JSON.parse(bytes.toString("utf8")));
}
function put(path: string, bytes: string | Uint8Array): UpdateFilePin {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); return { path, sha256: hash(bytes) };
}
function record(path: string, data: unknown): UpdateFilePin { return put(path, `${JSON.stringify(data)}\n`); }
function mkdir(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }
type Inventory = {
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly mode: number }[];
  readonly links: readonly { readonly path: string; readonly target: string }[];
};
/** Names/geometry are checked before file content. No config or cache is copied. */
function inventory(root: string, opaqueLinks: ReadonlySet<string> = new Set()): Inventory {
  const files: { path: string; sha256: string; mode: number }[] = [], links: { path: string; target: string }[] = [];
  const pending = [root], names: string[] = [];
  while (pending.length) {
    const dir = pending.pop(); need(dir !== undefined, "geometry", "missing directory"); directory(dir);
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry), stat = lstatSync(path);
      const rel = relative(root, path);
      const dependencyBunfig = (entry === "bunfig.toml" || entry === ".bunfig.toml")
        && /^node_modules\/(?:@[^/]+\/)?[^/]+\/(?:\.bunfig|bunfig)\.toml$/.test(rel)
        && !rel.startsWith("node_modules/omo-ai/");
      need(!dependencyBunfig || stat.isFile(), "configuration", `dependency configuration must be a payload file: ${path}`);
      need(!forbidden.has(entry) || dependencyBunfig, "configuration", `unsupported configuration entry: ${path}`);
      need(names.length + links.length < 200_000 && stat.uid === process.getuid?.(), "geometry", `inventory bound/owner: ${path}`);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        need(opaqueLinks.has(rel) ? isAbsolute(target)
          : !isAbsolute(target) && resolve(dirname(path), target).startsWith(`${root}/`)
            && realpathSync(path).startsWith(`${root}/`), "geometry", `external installed link: ${path}`);
        links.push({ path: relative(root, path), target });
      } else {
        need(stat.isFile(), "geometry", `unsupported entry: ${path}`); names.push(path);
      }
    }
  }
  for (const path of names) files.push({ path: relative(root, path), sha256: pin(path).sha256, mode: lstatSync(path).mode & 0o777 });
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), links: links.sort((a, b) => a.path.localeCompare(b.path)) };
}
type Slot = { readonly name: string; readonly version: string; readonly installName: string };
function slots(global: string, opaqueLinks: ReadonlySet<string> = new Set()): Slot[] {
  const result: Slot[] = [], pending = [join(global, "node_modules")];
  while (pending.length) {
    const modules = pending.pop(); need(modules !== undefined, "geometry", "missing modules"); directory(modules);
    for (const entry of readdirSync(modules).filter(name => !name.startsWith(".")).sort()) {
      const names = entry.startsWith("@") ? readdirSync(join(modules, entry)).map(name => `${entry}/${name}`) : [entry];
      for (const name of names) {
        const root = join(modules, name);
        if (opaqueLinks.has(relative(global, root))) continue;
        directory(root);
        const pkg = document(join(root, "package.json")), nested = join(root, "node_modules");
        result.push({ name: text(pkg["name"]), version: text(pkg["version"]).replace(/^v(?=\d)/, ""), installName: relative(join(global, "node_modules"), root) });
        if (lstatSync(nested, { throwIfNoEntry: false })) pending.push(nested);
      }
    }
  }
  return result.sort((a, b) => a.installName.localeCompare(b.installName));
}
function anchors(options: PrepareOmoRuntimeOptions): readonly string[] {
  need(options.rootPids.length > 0 && new Set(options.rootPids).size === options.rootPids.length
    && new Set(options.registeredSockets).size === options.registeredSockets.length, "geometry", "explicit unique stable coverage required");
  for (const socket of options.registeredSockets) {
    need(socket.startsWith(`${options.socketDirectory}/`) && normalize(socket) === socket, "geometry", "socket outside namespace");
    const stat = lstatSync(socket); need(stat.isSocket() && stat.uid === process.getuid?.(), "geometry", `unowned socket: ${socket}`);
  }
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,uid=,lstart="], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 ** 2,
  }).trim().split("\n");
  return options.rootPids.map(pid => {
    const row = rows.find(line => Number(/^\s*(\d+)\s/.exec(line)?.[1]) === pid);
    need(Number.isSafeInteger(pid) && pid > 1 && row !== undefined
      && Number(/^\s*\d+\s+\d+\s+(\d+)\s/.exec(row)?.[1]) === process.getuid?.(), "geometry", `missing stable anchor: ${pid}`);
    return row.trim();
  });
}
function identity(prefix: string, paths: readonly string[], installedVersion: string): InstallationIdentity {
  const resources = [...new Set(paths)].sort().map(path => ({ resourceId: `resource:${hash(path)}`,
    realpath: path, fingerprint: `sha256:${pin(path).sha256}` }));
  const executableRealpath = join(prefix, "install/global/node_modules/omo-ai/bin/omo.js");
  return { installationId: `install:${hash(executableRealpath)}`, family: "omo", executableRealpath,
    installedVersion: { kind: "known", version: installedVersion }, channel: "latest",
    owner: { kind: "wrapper", prefix, packageName: "omo-ai",
      engineResourceId: `resource:${hash(join(prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json"))}` },
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
}
type Acquired = {
  readonly name: string; readonly version: string; readonly archive: UpdateFilePin; readonly metadata: UpdateFilePin;
  readonly manifest: Record<string, unknown>; readonly meta: Record<string, unknown>;
  readonly members: ReadonlyMap<string, string>;
  readonly binMembers: ReadonlyMap<string, string>;
};
/** Public acquisition seam only; never accepts an executor, receipt, after image or source overlay. */
export async function prepareOmoInstallationRuntime(options: PrepareOmoRuntimeOptions,
  source: { readonly request?: (request: Request) => Promise<Response>; readonly keepFailedArtifacts?: boolean } = {}): Promise<PreparedOmoRuntime> {
  need(process.platform === "darwin", "geometry", "Darwin original Bun preparation required");
  directory(options.directory, true); directory(options.prefix); directory(options.ownerDirectory, true);
  directory(options.socketDirectory, true);
  need(readdirSync(options.directory).length === 0 && options.directory !== options.prefix
    && !options.directory.startsWith(`${options.prefix}/`) && !options.prefix.startsWith(`${options.directory}/`),
  "geometry", "empty preparation directory must be disjoint from selected prefix");
  const root = options.directory, global = join(options.prefix, "install/global"), wrapper = join(global, "node_modules/omo-ai");
  let completed = false;
  try {
  for (const dir of [options.prefix, global, wrapper, dirname(options.bun) + "/../etc", "/etc", "/usr/local/etc"]) {
    for (const name of forbidden) need(!lstatSync(join(dir, name), { throwIfNoEntry: false }),
      "configuration", `unsupported configuration exists: ${join(dir, name)}`);
  }
  for (const path of ["/etc/npmrc", "/usr/local/etc/npmrc", join(dirname(options.bun), "../etc/npmrc")])
    need(!lstatSync(path, { throwIfNoEntry: false }), "configuration", `unsupported configuration exists: ${path}`);
  const node = Bun.which("node");
  need(node !== null, "geometry", "original Node required by official OmO postinstall");
  const manager = { name: "bun" as const, ...pin(options.bun), node: pin(realpathSync(node)) };
  need(manager.node.path.endsWith("/node") && (lstatSync(manager.node.path).mode & 0o111) !== 0,
    "geometry", "original executable Node required");
  need((lstatSync(manager.path).mode & 0o111) !== 0 && (lstatSync(manager.path).mode & 0o022) === 0 && manager.path.endsWith("/bun")
    && !manager.path.startsWith(`${root}/`), "geometry", "preexisting original Bun executable required");
  const declaration = document(join(global, "package.json")), oldWrapper = document(join(wrapper, "package.json"));
  const preservedLinks = readdirSync(join(global, "node_modules"), { withFileTypes: true })
    .filter(entry => entry.isSymbolicLink()).map(entry => {
      const path = join(global, "node_modules", entry.name), target = readlinkSync(path);
      need(/^[a-z0-9][a-z0-9._-]*$/.test(entry.name) && isAbsolute(target)
        && !target.startsWith(`${global}/`) && ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
          .every(field => !Object.hasOwn(object(declaration[field] ?? {}), entry.name)),
      "configuration", `linked package is not an unrelated external entry: ${path}`);
      return { path, target };
    });
  const opaqueLinks = new Set(preservedLinks.map(link => relative(global, link.path)));
  const coverageBefore = anchors(options), beforeGlobal = inventory(global, opaqueLinks), beforeShim = pin(join(options.prefix, "bin/omo"));
  need(!declaration["overrides"] && !declaration["resolutions"] && !declaration["scripts"] && !declaration["workspaces"]
    && oldWrapper["name"] === "omo-ai" && typeof oldWrapper["version"] === "string",
  "configuration", "unsupported shared declaration or installed OmO version");
  const trusted = declaration["trustedDependencies"];
  need(Array.isArray(trusted) && trusted.includes("omo-ai") && new Set(trusted).size === trusted.length
    && trusted.every(name => reviewedOmoTrustNames.some(known => known === name)), "configuration",
    "trusted lifecycle names need source review; declaration is never rewritten");
  const oldSlots = slots(global, opaqueLinks), home = join(root, "home"), acquiredDirectory = join(root, "acquired");
  mkdir(home); mkdir(acquiredDirectory);
  const request = source.request ?? ((request: Request) => fetch(request));
  const sourcePins: UpdateFilePin[] = [], acquired = new Map<string, Promise<Acquired>>();
  async function get(url: string, maximum = 256 * 1024 ** 2): Promise<Uint8Array> {
    const parsed = new URL(url);
    need(["registry.npmjs.org", "raw.githubusercontent.com"].includes(parsed.hostname) && parsed.protocol === "https:"
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash, "source", "nonpublic acquisition URL");
    const response = await request(new Request(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(120_000) }));
    need(response.status === 200 && response.body !== null, "source", `HTTP ${response.status}: ${url}`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.length; need(size <= maximum, "source", `response bound: ${url}`); chunks.push(item.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  async function acquire(name: string, selectedVersion: string): Promise<Acquired> {
    const key = `${name}@${selectedVersion}`, previous = acquired.get(key); if (previous) return previous;
    const pending = (async () => {
      const metadataBytes = await get(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(selectedVersion)}`, 4 * 1024 ** 2);
      const meta = object(JSON.parse(Buffer.from(metadataBytes).toString("utf8"))), dist = object(meta["dist"]);
      need(meta["name"] === name && meta["version"] === selectedVersion && text(dist["tarball"]).startsWith(`${registry}/${name}/-/`)
        && /^sha512-[A-Za-z0-9+/]{86}==$/.test(text(dist["integrity"])), "source", `metadata identity: ${key}`);
      const bytes = await get(text(dist["tarball"]));
      need(`sha512-${createHash("sha512").update(bytes).digest("base64")}` === dist["integrity"], "source", `integrity: ${key}`);
      const entries = await new Bun.Archive(bytes).files(), members = new Map<string, string>(), binMembers = new Map<string, string>();
      const manifests = [...entries].filter(([path]) => /^[^/]+\/package\.json$/.test(path));
      need(manifests.length === 1 && manifests[0] !== undefined, "source", `archive root: ${key}`);
      const archiveRoot = manifests[0][0].split("/")[0], manifest = object(JSON.parse(await manifests[0][1].text()));
      need(manifest["name"] === name && (manifest["version"] === selectedVersion
        || (name !== "omo-ai" && name !== "@code-yeongyu/senpi" && manifest["version"] === `v${selectedVersion}`))
        && !manifest["bundledDependencies"] && !manifest["bundleDependencies"], "source", `archive identity/bundle: ${key}`);
      const bins = typeof manifest["bin"] === "string" ? [manifest["bin"]]
        : manifest["bin"] === undefined ? [] : Object.values(object(manifest["bin"]));
      const binPaths = new Set(bins.filter((entry): entry is string => typeof entry === "string"
        && !isAbsolute(entry) && !entry.split("/").includes("..")).map(entry => normalize(entry)));
      for (const [path, blob] of entries) {
        const parts = path.split("/").filter(part => part !== ".");
        const dependencyBunfig = name !== "omo-ai" && (parts[1] === "bunfig.toml" || parts[1] === ".bunfig.toml");
        need(parts[0] === archiveRoot && parts.length > 1 && parts.every(part => part && part !== "..")
          && !/[\x00-\x1f\x7f\\]/.test(path) && (!forbidden.has(parts[1] ?? "") || dependencyBunfig), "source", `archive path: ${key}:${path}`);
        const local = parts.slice(1).join("/"), body = new Uint8Array(await blob.arrayBuffer()), digest = hash(body);
        need(!members.has(local) || members.get(local) === digest, "source", `archive collision: ${key}:${local}`);
        members.set(local, digest);
        const newline = body.indexOf(10);
        if (binPaths.has(local) && body[0] === 35 && body[1] === 33 && newline > 0 && body[newline - 1] === 13) {
          binMembers.set(local, hash(Buffer.concat([body.subarray(0, newline - 1), body.subarray(newline)])));
        }
      }
      return { name, version: selectedVersion, meta, manifest, members, binMembers,
        metadata: put(join(acquiredDirectory, `${hash(key)}.json`), metadataBytes),
        archive: put(join(acquiredDirectory, `${hash(key)}.tgz`), bytes) };
    })();
    acquired.set(key, pending); return pending;
  }
  const latest = object(JSON.parse(Buffer.from(await get(`${registry}/omo-ai/latest`, 4 * 1024 ** 2)).toString("utf8")));
  const version = text(latest["version"]), wrapperCommit = text(latest["gitHead"]);
  need(/^\d+\.\d+\.\d+$/.test(version) && /^[a-f0-9]{40}$/.test(wrapperCommit),
    "source", "invalid stable release source");
  need(Bun.semver.order(version, oldWrapper["version"]) > 0, "configuration", "unsupported installed OmO version");
  const main = await acquire("omo-ai", version);
  need(main.meta["gitHead"] === wrapperCommit, "source", "target metadata differs from audited official contract");
  const engineVersion = text(object(main.manifest["dependencies"])["@code-yeongyu/senpi"]);
  need(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(engineVersion)
    && isDeepStrictEqual(main.manifest["dependencies"], { "@code-yeongyu/senpi": engineVersion })
    && (latest["dependencies"] === undefined || isDeepStrictEqual(latest["dependencies"], main.manifest["dependencies"])),
  "source", "exact paired Senpi required");
  const engine = await acquire("@code-yeongyu/senpi", engineVersion);
  const officialFiles: Record<string, string> = {};
  for (const [path, expected] of Object.entries(audited)) {
    need(main.members.get(path) === expected, "source", `unaudited lifecycle source: ${path}`);
    const bytes = await get(`https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/${wrapperCommit}/packages/omo-native/${path}`, 1024 ** 2);
    need(hash(bytes) === expected, "source", `Git/archive source disagreement: ${path}`);
    sourcePins.push(put(join(acquiredDirectory, `${hash(path)}.source`), bytes));
    officialFiles[`/official/${path}`] = Buffer.from(bytes).toString("utf8");
  }
  const repository = object(engine.meta["repository"]);
  need(repository["url"] === "git+https://github.com/code-yeongyu/senpi.git"
    && repository["directory"] === "packages/coding-agent", "source", "unexpected engine source repository");
  const attestationUrl = text(object(object(engine.meta["dist"])["attestations"])["url"]);
  need(attestationUrl === `${registry}/-/npm/v1/attestations/@code-yeongyu%2fsenpi@${engineVersion}`,
    "source", "unexpected engine provenance URL");
  const provenanceBytes = await get(attestationUrl, 8 * 1024 ** 2);
  const attestations = object(JSON.parse(Buffer.from(provenanceBytes).toString("utf8")))["attestations"];
  need(Array.isArray(attestations), "source", "missing engine provenance");
  const provenanceRecords = attestations.map(object).filter(row => row["predicateType"] === "https://slsa.dev/provenance/v1");
  need(provenanceRecords.length === 1 && provenanceRecords[0] !== undefined, "source", "ambiguous engine provenance");
  const envelope = object(object(provenanceRecords[0]["bundle"])["dsseEnvelope"]);
  const statement = object(JSON.parse(Buffer.from(text(envelope["payload"]), "base64").toString("utf8")));
  const subjects = statement["subject"];
  need(statement["predicateType"] === "https://slsa.dev/provenance/v1" && Array.isArray(subjects)
    && subjects.length === 1, "source", "invalid engine provenance subject");
  const subject = object(subjects[0]), digest = object(subject["digest"]);
  const archiveDigest = createHash("sha512").update(readFileSync(engine.archive.path)).digest("hex");
  need(subject["name"] === `pkg:npm/%40code-yeongyu/senpi@${engineVersion}`
    && digest["sha512"] === archiveDigest, "source", "engine provenance archive mismatch");
  const definition = object(object(statement["predicate"])["buildDefinition"]);
  const workflow = object(object(definition["externalParameters"])["workflow"]);
  need(workflow["repository"] === "https://github.com/code-yeongyu/senpi"
    && workflow["path"] === ".github/workflows/publish-npm.yml", "source", "unexpected engine publisher");
  const dependencies = definition["resolvedDependencies"];
  need(Array.isArray(dependencies), "source", "missing source dependency");
  const dependenciesFromSource = dependencies.map(object).filter(row =>
    typeof row["uri"] === "string" && row["uri"].startsWith("git+https://github.com/code-yeongyu/senpi@"));
  need(dependenciesFromSource.length === 1 && dependenciesFromSource[0] !== undefined, "source", "ambiguous engine commit");
  const engineCommit = text(object(dependenciesFromSource[0]["digest"])["gitCommit"]);
  need(/^[a-f0-9]{40}$/.test(engineCommit), "source", "invalid engine commit");
  // This is registry-served provenance plus archive/source cross-checking, not
  // an independent Sigstore signature-verification claim.
  sourcePins.push(put(join(acquiredDirectory, "senpi-provenance.json"), provenanceBytes));
  const contract = { version, engineVersion, wrapperCommit, engineCommit };
  const engineSource = await get(`https://raw.githubusercontent.com/code-yeongyu/senpi/${engineCommit}/packages/coding-agent/package.json`, 1024 ** 2);
  const engineSourceManifest = object(JSON.parse(Buffer.from(engineSource).toString("utf8")));
  // The official publish step removes vendored workspaces and rewrites owned
  // registry aliases. Compare its published dependency shape, not the monorepo.
  for (const [path, expected] of [
    ["prepare-senpi-publish-manifest.mjs", "6114167c4d82fe2d1305e2b251185eaa75e8de7d84abc9ee952c9c5fb2c1f94a"],
    ["registry-packages.mjs", "e7c17304f4e4dcc8b4520898f5da8c73418fc32cc741ed488ea7f4b5207ea565"],
  ] as const) {
    const bytes = await get(`https://raw.githubusercontent.com/code-yeongyu/senpi/${engineCommit}/scripts/${path}`, 1024 ** 2);
    need(hash(bytes) === expected, "source", `unaudited publish transform: ${path}`);
    sourcePins.push(put(join(acquiredDirectory, path), bytes));
  }
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    if (engineSourceManifest[field] === undefined) continue;
    const dependencies = object(engineSourceManifest[field]);
    delete dependencies["@earendil-works/pi-client"];
    delete dependencies["@earendil-works/pi-protocol"];
    for (const [name, spec] of Object.entries(dependencies)) {
      if (name.startsWith("@earendil-works/pi-") && ["ai", "agent-core", "tui", "pty", "telemetry"].includes(name.slice(19)))
        dependencies[name] = `npm:@code-yeongyu/senpi-${name.slice(19)}@${text(spec).replace(/^[~^]/, "")}`;
      else if (name === "@code-yeongyu/senpi-codemode") dependencies[name] = text(spec).replace(/^[~^]/, "");
    }
    engineSourceManifest[field] = dependencies;
  }
  for (const field of ["name", "version", "dependencies", "optionalDependencies", "bin"])
    need(isDeepStrictEqual(engineSourceManifest[field], engine.manifest[field]), "source", `paired engine Git/archive ${field}`);
  sourcePins.push(put(join(acquiredDirectory, "senpi-source-package.json"), engineSource));
  // Bundle the complete audited modules, but call only the pure official generator.
  const build = await Bun.build({ entrypoints: ["/official/entry.js"], target: "bun",
    files: { ...officialFiles, "/official/entry.js": 'export {bunBinShimScript} from "./bin/lib/bun-bin-shim.js"; export {prepareCompileSafeEngine} from "./bin/lib/compile-safe-engine.js";' } });
  need(build.success && build.outputs.length === 1 && build.outputs[0] !== undefined, "source", "official generator linkage failed");
  const generator: { readonly bunBinShimScript: (entry: string, bun: string) => string;
    readonly prepareCompileSafeEngine: (root: string) => void } =
    await import(`data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString("base64")}`);
  const actualBun = lstatSync(join(options.prefix, "bin/bun"), { throwIfNoEntry: false })
    ? join(options.prefix, "bin/bun") : manager.path;
  need(realpathSync(actualBun) === manager.path, "geometry", "official shim would select a different Bun");
  const system = "/usr/bin/sandbox-exec", commands: unknown[] = [];
  async function run(command: Omit<PrivateUpdateCommand, "cwd" | "executable"> & { readonly cwd: string; readonly executable: string },
    scope: string, publicNetwork = false): Promise<{ status: number; signal: null }> {
    need(command.cwd.startsWith(`${scope}/`) && command.env["BUN_INSTALL"]?.startsWith(`${scope}/`) === true
      && command.env["HOME"]?.startsWith(`${scope}/`) === true && pin(manager.path).sha256 === manager.sha256,
    "geometry", "calibration command escaped owned prefix");
    need(pin(manager.node.path).sha256 === manager.node.sha256, "source_changed", "original postinstall Node changed");
    const sub = (path: string) => `(subpath ${JSON.stringify(path)})`, literal = (path: string) => `(literal ${JSON.stringify(path)})`;
    const policy = `(version 1)(allow default)(deny file-read* file-write*)(allow file-read-metadata)
(allow file-read* ${[literal("/"), sub(scope), literal(manager.path), literal(manager.node.path), ...["/System", "/usr/lib", "/usr/share", "/Library/Apple",
      "/System/Cryptexes", "/System/Volumes/Preboot/Cryptexes",
      "/private/var/db/dyld", "/private/var/db/timezone", "/private/etc/ssl"].map(sub),
      ...["/private/etc/hosts", "/private/etc/resolv.conf", "/private/etc/localtime", "/dev/null",
        "/dev/random", "/dev/urandom", "/bin/sh", "/usr/bin/env"].map(literal)].join(" ")})
(allow file-write* ${sub(scope)})(allow file-write-data (literal "/dev/null"))
${publicNetwork ? "" : '(deny network*)(allow network-outbound (remote ip "localhost:*"))'}
(deny signal)(allow signal (target same-sandbox))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.CredentialStore"))`;
    const child = Bun.spawn([system, "-p", policy, command.executable, ...command.args],
      { cwd: command.cwd, env: command.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 240_000);
    let status: number, stdout: string, stderr: string;
    try { [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
    finally { clearTimeout(timeout); }
    const id = commands.length;
    commands.push({ executable: manager, args: command.args, cwd: command.cwd, env: command.env, status,
      stdout: put(join(root, `command-${id}.stdout`), stdout), stderr: put(join(root, `command-${id}.stderr`), stderr),
      policy: put(join(root, `command-${id}.sb`), policy) });
    need(status === 0, "calibration", `original Bun exit ${status}; ${root}/command-${id}.stderr`);
    return { status, signal: null };
  }
  const resolver = join(root, "resolve"), resolvedPrefix = join(resolver, "prefix"), resolvedGlobal = join(resolvedPrefix, "install/global");
  mkdir(resolvedGlobal); mkdir(join(resolver, "home")); mkdir(join(resolver, "cache"));
  // Resolve the update from the real before layout. A fresh manifest-only
  // install can hoist dependencies past retained nested slots that still shadow
  // them in both calibrations and the actual prefix.
  cpSync(global, resolvedGlobal, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  need(isDeepStrictEqual(inventory(resolvedGlobal, opaqueLinks), beforeGlobal), "source_changed", "resolver before image differs");
  await run({ executable: manager.path, args: ["add", "-g", `omo-ai@${version}`, "--ignore-scripts", "--linker", "hoisted",
    "--registry", registry, "--cache-dir", join(resolver, "cache")], cwd: resolvedGlobal,
    env: { BUN_INSTALL: resolvedPrefix, HOME: join(resolver, "home"), PATH: dirname(manager.path) },
    shell: false, inheritEnv: false }, resolver, true);
  // Bun's frozen global workspace must include every declared root. Authenticate
  // their registry archives too; do not carry arbitrary old lock sources into
  // the authority or silently omit shared roots from the lock.
  let selectedSlots = slots(resolvedGlobal, opaqueLinks), rows: Acquired[] = [];
  const retainedRoots = Object.keys(object(declaration["dependencies"] ?? {})).filter(name => name !== "omo-ai");
  for (const name of retainedRoots) {
    const prior = oldSlots.find(slot => slot.installName === name), selected = selectedSlots.find(slot => slot.installName === name);
    need(prior !== undefined && selected !== undefined && isDeepStrictEqual(prior, selected),
      "calibration", `original manager changed an unrelated root: ${name}`);
  }
  for (let offset = 0; offset < selectedSlots.length; offset += 6)
    rows.push(...await Promise.all(selectedSlots.slice(offset, offset + 6).map(slot => acquire(slot.name, slot.version))));
  for (const name of trusted) {
    const packages = rows.filter(row => row.name === name);
    need(packages.length > 0 && packages.every(row => isAuditedOmoTrustedLifecycle(row.name, row.manifest, row.members)),
      "source", `unaudited trusted lifecycle: ${name}`);
  }
  const beforeTransforms = new Map<string, string>();
  const oldDependency = (parent: string, name: string): Slot | undefined => {
    let search = join(global, "node_modules", parent);
    for (;;) {
      const slot = relative(join(global, "node_modules"), join(search, "node_modules", name));
      const found = oldSlots.find(entry => entry.installName === slot);
      if (found || search === global) return found;
      search = dirname(search);
      if (search.endsWith("/node_modules")) search = dirname(search);
    }
  };
  const css = oldDependency("@code-yeongyu/senpi", "css-tree");
  const mdn = css && (oldSlots.find(slot => slot.installName === join(dirname(css.installName), "mdn-data"))
    ?? oldDependency(css.installName, "mdn-data"));
  if (css && mdn) {
    need(css.name === "css-tree" && mdn.name === "mdn-data", "source", "unsupported compile dependency alias");
    const stage = join(root, "compile-safe-before", "engine");
    const cssArchive = await acquire(css.name, css.version), mdnArchive = await acquire(mdn.name, mdn.version);
    need(cssArchive.members.has("package.json") && cssArchive.members.has("data/patch.json")
      && ["at-rules", "properties", "syntaxes"].every(name => mdnArchive.members.has(`css/${name}.json`)),
    "source", "missing compile transform inputs");
    for (const artifact of [cssArchive, mdnArchive]) {
      sourcePins.push(artifact.archive, artifact.metadata);
      for (const [name, blob] of await new Bun.Archive(readFileSync(artifact.archive.path)).files()) {
        const relativeName = name.split("/").filter(part => part !== ".").slice(1).join("/");
        need(artifact.members.has(relativeName), "source", "compile input outside original archive");
        const path = join(stage, "node_modules", artifact.name, relativeName);
        mkdir(dirname(path)); put(path, new Uint8Array(await blob.arrayBuffer()));
      }
    }
    // Execute only the audited original file transform, on independently
    // acquired inputs in owned scratch, never on the operating installation.
    generator.prepareCompileSafeEngine(stage);
    for (const [path, original] of cssArchive.members) {
      const transformed = pin(join(stage, "node_modules/css-tree", path));
      if (transformed.sha256 !== original) {
        beforeTransforms.set(`node_modules/${css.installName}/${path}`, transformed.sha256);
        sourcePins.push(transformed);
      }
    }
  }
  const reuseDrift: { slot: string; changedOrExtra: readonly string[]; missing: readonly string[]; links: readonly string[] }[] = [];
  for (const [index, slot] of selectedSlots.entries()) {
    const prior = oldSlots.find(before => before.installName === slot.installName);
    if (!prior || prior.name !== slot.name || prior.version !== slot.version) continue;
    const row = rows[index]; need(row !== undefined, "source", "missing reusable artifact");
    const packagePath = `node_modules/${slot.installName}/`;
    const current = beforeGlobal.files.filter(file => file.path.startsWith(packagePath)
      && !file.path.slice(packagePath.length).startsWith("node_modules/"));
    const changedOrExtra = current.filter(file =>
      !(row.members.get(file.path.slice(packagePath.length)) === file.sha256
        || row.binMembers.get(file.path.slice(packagePath.length)) === file.sha256
        || beforeTransforms.get(file.path) === file.sha256)).map(file => file.path.slice(packagePath.length));
    const present = new Set(current.map(file => file.path.slice(packagePath.length)));
    const missing = [...row.members.keys()].filter(path => !present.has(path));
    const links = beforeGlobal.links.filter(link => link.path.startsWith(packagePath)
      && !link.path.slice(packagePath.length).startsWith("node_modules/")).map(link => link.path.slice(packagePath.length));
    if (changedOrExtra.length || missing.length || links.length)
      reuseDrift.push({ slot: slot.installName, changedOrExtra, missing, links });
  }
  if (reuseDrift.length) {
    record(join(root, "reuse-drift.json"), reuseDrift);
    need(false, "qualification", `${reuseDrift.length} reused packages differ from verified originals; ${root}/reuse-drift.json`);
  }
  const selectedBySlot = new Map(selectedSlots.map((slot, index) => [slot.installName, { slot, row: rows[index] }]));
  const reachableFrom = (roots: readonly string[]) => {
  const reachable = new Set(roots.filter(root => selectedBySlot.has(root))), pendingDependencies = [...reachable];
  for (let parent = pendingDependencies.pop(); parent !== undefined; parent = pendingDependencies.pop()) {
    const row = selectedBySlot.get(parent)?.row;
    need(row !== undefined, "source", "missing reachable package");
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(object(row.manifest[field] ?? {}))) {
        let search = join(resolvedGlobal, "node_modules", parent);
        for (;;) {
          const candidate = relative(join(resolvedGlobal, "node_modules"), join(search, "node_modules", name));
          if (selectedBySlot.has(candidate)) {
            if (!reachable.has(candidate)) { reachable.add(candidate); pendingDependencies.push(candidate); }
            break;
          }
          if (search === resolvedGlobal) break;
          search = dirname(search);
          if (search.endsWith("/node_modules")) search = dirname(search);
        }
      }
    }
  }
  return reachable;
  };
  const omoReachable = reachableFrom(["omo-ai"]);
  const activeSlots = reachableFrom(["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"]
    .flatMap(field => Object.keys(object(declaration[field] ?? {}))));
  const preservedPackages = selectedSlots.filter(slot => !activeSlots.has(slot.installName)).map(slot => {
    need(oldSlots.some(before => isDeepStrictEqual(before, slot)), "calibration", `unexpected residual package: ${slot.installName}`);
    const packagePath = `node_modules/${slot.installName}/`;
    return { root: join(global, "node_modules", slot.installName),
      files: beforeGlobal.files.filter(file => file.path.startsWith(packagePath)
        && !file.path.slice(packagePath.length).startsWith("node_modules/"))
        .map(file => ({ path: join(global, file.path), sha256: file.sha256 })) };
  });
  rows = rows.filter((_row, index) => {
    const slot = selectedSlots[index]; return slot !== undefined && activeSlots.has(slot.installName);
  });
  selectedSlots = selectedSlots.filter(slot => activeSlots.has(slot.installName));
  // New peer conflicts remain forbidden. An existing conflict in an
  // unrelated unchanged root can be carried, with both manifests leased and
  // byte-identical before/after; the issuer also checks OmO graph reachability.
  const preservedPeers: { parent: UpdateFilePin; dependency: UpdateFilePin; key: string }[] = [];
  for (const [index, slot] of selectedSlots.entries()) {
    const row = rows[index]; need(row !== undefined, "source", "closure missing");
    for (const [name, declaration] of Object.entries(object(row.manifest["peerDependencies"] ?? {}))) {
      const alias = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(text(declaration));
      let search = join(resolvedGlobal, "node_modules", slot.installName);
      for (;;) {
        const candidate = relative(join(resolvedGlobal, "node_modules"), join(search, "node_modules", name));
        const selected = selectedSlots.find(entry => entry.installName === candidate);
        if (selected) {
          need(selected.name === (alias?.[1] ?? name), "qualification", `shared peer identity conflict: ${candidate}`);
          if (!Bun.semver.satisfies(selected.version, alias?.[2] ?? text(declaration))) {
            const prior = oldSlots.find(before => before.installName === slot.installName);
            const priorDependency = oldSlots.find(before => before.installName === selected.installName);
            need(isDeepStrictEqual(prior, slot) && isDeepStrictEqual(priorDependency, selected)
              && !omoReachable.has(slot.installName),
            "qualification", `new shared peer conflict: ${slot.installName} requires ${name}@${declaration}; selected ${selected.installName}@${selected.version}`);
            const parent = pin(join(global, "node_modules", slot.installName, "package.json"));
            const dependency = pin(join(global, "node_modules", selected.installName, "package.json"));
            const selectedIndex = selectedSlots.findIndex(candidate => candidate.installName === selected.installName);
            need(row.members.get("package.json") === parent.sha256
              && rows[selectedIndex]?.members.get("package.json") === dependency.sha256,
            "qualification", "preserved peer manifests differ from original target artifacts");
            preservedPeers.push({ parent, dependency, key: name });
          }
          break;
        }
        if (search === resolvedGlobal) break;
        search = dirname(search);
        if (search.endsWith("/node_modules")) search = dirname(search);
      }
    }
  }
  const artifacts: OmoArtifact[] = selectedSlots.map((slot, index) => {
    const row = rows[index]; need(row !== undefined, "source", "closure missing");
    return { ...slot, archive: row.archive, metadata: row.metadata };
  });
  const updatedParents = selectedSlots.filter(slot => {
    const before = oldSlots.find(old => old.installName === slot.installName);
    return before !== undefined && before.name === slot.name && before.version !== slot.version;
  });
  const removedSlots = oldSlots.filter(slot => !selectedBySlot.has(slot.installName)
    && updatedParents.some(parent => slot.installName.startsWith(`${parent.installName}/node_modules/`)));
  const retiredPackages = removedSlots.filter(slot => !removedSlots.some(parent =>
    slot.installName.startsWith(`${parent.installName}/node_modules/`))).map(slot => {
    const packagePath = `node_modules/${slot.installName}/`;
    need(!beforeGlobal.links.some(link => link.path.startsWith(packagePath)),
      "geometry", `retired dependency contains unqualified links: ${slot.installName}`);
    return { root: join(global, "node_modules", slot.installName),
      files: beforeGlobal.files.filter(file => file.path.startsWith(packagePath))
        .map(file => ({ path: join(global, file.path), sha256: file.sha256 })) };
  });
  // Only the original OmO hook is permitted to run. Bun's default trust list
  // cannot widen the explicit, preserved shared trustedDependencies declaration.
  const required = ["package.json", "bin/omo.js", "bin/senpi-patch.mjs", "bin/lib/self-update.js",
    "bin/lib/package-paths.js", "bin/lib/update-args.js", "bin/lib/bun-bin-shim.js",
    "bin/lib/bun-runtime.js", "bin/lib/child-process.js"].map(path => join(wrapper, path));
  const installedPaths = [...required, join(global, "node_modules/@code-yeongyu/senpi/package.json"),
    join(global, "node_modules/@code-yeongyu/senpi/dist/bundle/cli.js"),
    join(global, "package.json"), join(global, "bun.lock"), beforeShim.path,
    ...preservedPeers.flatMap(peer => [peer.parent.path, peer.dependency.path]),
    ...oldSlots.filter(slot => artifacts.some(a => a.installName === slot.installName && a.version !== slot.version))
      .map(slot => join(global, "node_modules", slot.installName, "package.json"))];
  const before = identity(options.prefix, installedPaths, oldWrapper["version"]);
  const shimPaths = ["bin/omo"];
  const secondaryShim = beforeGlobal.files.find(file => file.path === "node_modules/.bin/omo");
  const expectedArchive = new Map<string, string>();
  for (const [index, artifact] of artifacts.entries()) {
    const row = rows[index]; need(row !== undefined, "source", "closure missing");
    for (const [path, sha256] of row.members) expectedArchive.set(`install/global/node_modules/${artifact.installName}/${path}`, sha256);
  }
  const afterImages: Map<string, string>[] = [];
  let postinstall: UpdateFilePin[] = [];
  for (const label of ["calibration-a", "calibration-b"]) {
    const scope = join(root, label), prefix = join(scope, "prefix"), ownGlobal = join(prefix, "install/global"), ownHome = join(scope, "home");
    mkdir(join(prefix, "install")); mkdir(join(prefix, "bin")); mkdir(ownHome);
    cpSync(global, ownGlobal, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    cpSync(beforeShim.path, join(prefix, "bin/omo"), { mode: constants.COPYFILE_FICLONE });
    need(isDeepStrictEqual(inventory(ownGlobal, opaqueLinks), beforeGlobal), "source_changed", "copied selected declaration/tree differs");
    const ownPaths = installedPaths.map(path => join(prefix, relative(options.prefix, path)));
    const ownBefore = identity(prefix, ownPaths, oldWrapper["version"]);
    const env = { BUN_INSTALL: prefix, HOME: ownHome, PATH: [dirname(manager.path), dirname(manager.node.path)].join(":") };
    if (label === "calibration-a") {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (request.method !== "GET") return new Response(null, { status: 405 });
        const url = new URL(request.url), row = rows.find(row => url.pathname === `/tarballs/${row.archive.sha256}.tgz`);
        if (row) return new Response(readFileSync(row.archive.path));
        const name = decodeURIComponent(url.pathname.slice(1)), matches = rows.filter(row => row.name === name);
        if (!matches.length) return new Response(null, { status: 404 });
        return Response.json({ name, "dist-tags": name === "omo-ai" ? { latest: version } : {}, versions:
          Object.fromEntries(matches.map(row => [row.version, { ...row.manifest, dist: {
            tarball: `${url.origin}/tarballs/${row.archive.sha256}.tgz`, integrity: object(row.meta["dist"])["integrity"],
          } }])) });
      } });
      const origin = `http://127.0.0.1:${server.port}`, workspace: Record<string, unknown> = { ...declaration,
        dependencies: { ...object(declaration["dependencies"]), "omo-ai": version } };
      // Bun lock v1 keeps trust at the lock's top level, not in workspaces[""].
      // This matches executeOmoUpdate exactly. The installed package.json remains
      // byte-for-byte copied, and `trusted` is retained below: hooks DO execute.
      delete workspace["trustedDependencies"];
      const packages = Object.fromEntries(artifacts.map((artifact, index) => {
        const row = rows[index]; need(row !== undefined, "source", "missing closure");
        const metadata = Object.fromEntries(["dependencies", "optionalDependencies", "peerDependencies", "os", "cpu", "bin"]
          .filter(field => row.manifest[field] !== undefined).map(field => [field, row.manifest[field]]));
        if (row.manifest["peerDependenciesMeta"]) {
          const optionalPeers = Object.entries(object(row.manifest["peerDependenciesMeta"]))
            .filter(([, value]) => object(value)["optional"] === true).map(([key]) => key);
          if (optionalPeers.length) metadata["optionalPeers"] = optionalPeers;
        }
        return [artifact.installName.replaceAll("/node_modules/", "/"), [`${artifact.name}@${artifact.version}`,
          `${origin}/tarballs/${artifact.archive.sha256}.tgz`, metadata, object(row.meta["dist"])["integrity"]]];
      }));
      writeFileSync(join(ownGlobal, "bun.lock"), `${JSON.stringify({ lockfileVersion: 1, configVersion: 1,
        workspaces: { "": workspace }, trustedDependencies: trusted, packages }, null, 2)}\n`);
      mkdir(join(scope, "cache"));
      try {
        await run({ executable: manager.path, args: ["add", "-g", `omo-ai@${version}`, "--registry", origin,
          "--cache-dir", join(scope, "cache"), "--linker", "hoisted", "--frozen-lockfile"],
        cwd: join(ownGlobal, "node_modules/omo-ai"), env, shell: false, inheritEnv: false }, scope);
        const replacements = new Map(rows.map(row => [`${origin}/tarballs/${row.archive.sha256}.tgz`, text(object(row.meta["dist"])["tarball"])]));
        replacements.set(origin, registry);
        const canonicalLock = JSON.stringify(Bun.JSON5.parse(readFileSync(join(ownGlobal, "bun.lock"), "utf8")),
          (_key, value: unknown) => typeof value === "string" ? replacements.get(value) ?? value : value, 2);
        need(!canonicalLock.includes(origin), "calibration", "unmapped lock URL");
        writeFileSync(join(ownGlobal, "bun.lock"), `${canonicalLock}\n`);
      } finally { await server.stop(true); }
    } else {
      const checkedAt = Date.now();
      const qualification: OmoUpdateQualification = { installation: ownBefore, manager, env, reuseVerifiedPackages: true,
        retiredPackages: retiredPackages.map(group => ({ root: join(prefix, relative(options.prefix, group.root)),
          files: group.files.map(pin => ({ ...pin, path: join(prefix, relative(options.prefix, pin.path)) })) })),
        preservedPackages: preservedPackages.map(group => ({ root: join(prefix, relative(options.prefix, group.root)),
          files: group.files.map(pin => ({ ...pin, path: join(prefix, relative(options.prefix, pin.path)) })) })),
        preservedLinks: preservedLinks.map(link => ({ ...link, path: join(prefix, relative(options.prefix, link.path)) })),
        preservedPeers: preservedPeers.map(peer => ({ key: peer.key,
          parent: { ...peer.parent, path: join(prefix, relative(options.prefix, peer.parent.path)) },
          dependency: { ...peer.dependency, path: join(prefix, relative(options.prefix, peer.dependency.path)) } })),
        target: { packageName: "omo-ai", version, channel: "latest", checkedAt, expiresAt: checkedAt + 300_000,
          artifacts, postinstall: postinstall.map(row => ({ path: join(prefix, relative(options.prefix, row.path)),
            sha256: shimPaths.includes(relative(options.prefix, row.path))
              ? hash(generator.bunBinShimScript(join(prefix, "install/global/node_modules/omo-ai/bin/omo.js"), manager.path)) : row.sha256 })) } };
      const receipt = record(join(scope, "qualification.json"), qualification);
      const qualified = await qualifyOmoUpdate({ qualification, receipt }, Date.now());
      need(qualified.ok, "qualification", "independent calibration rejected by legacy issuer");
      const spec = createOmoUpdateSpec(qualified.value, "update-only", Date.now());
      need(spec.ok, "qualification", "legacy calibration spec rejected");
      const result = await executeOmoUpdate(spec.value, { now: Date.now, run: command => run(command, scope) });
      record(join(scope, "execution.json"), result);
      need(result.ok && result.value.kind === "files-verified", "calibration", "independent original legacy execution failed");
    }
    const output = inventory(ownGlobal, opaqueLinks), image = new Map(output.files.map(file => [`install/global/${file.path}`, file.sha256]));
    need(isDeepStrictEqual(output.links.filter(link => opaqueLinks.has(link.path)),
      beforeGlobal.links.filter(link => opaqueLinks.has(link.path))), "calibration", "unrelated external package links changed");
    for (const name of retainedRoots) {
      const packagePath = `node_modules/${name}/`;
      const belongs = (file: { readonly path: string }) => file.path.startsWith(packagePath)
        && !file.path.slice(packagePath.length).startsWith("node_modules/");
      const beforeFiles = beforeGlobal.files.filter(belongs), afterFiles = output.files.filter(belongs);
      need(beforeFiles.length === afterFiles.length && beforeFiles.every((before, index) => {
        const after = afterFiles[index];
        return after !== undefined && before.path === after.path && before.sha256 === after.sha256
          && (after.mode === before.mode || after.mode === (before.mode & ~0o022));
      })
        && isDeepStrictEqual(output.links.filter(belongs), beforeGlobal.links.filter(belongs)),
      "calibration", `unrelated root package contents changed: ${name}`);
    }
    image.set("bin/omo", pin(join(prefix, "bin/omo")).sha256);
    const ownShim = generator.bunBinShimScript(join(prefix, "install/global/node_modules/omo-ai/bin/omo.js"), manager.path);
    if (secondaryShim && label === "calibration-a") {
      const path = "install/global/node_modules/.bin/omo";
      if (image.get(path) === hash(ownShim)) shimPaths.push(path);
      else need(image.get(path) === secondaryShim.sha256, "path_dependent", "foreign secondary launcher changed");
    }
    for (const path of shimPaths) {
      need(image.get(path) === hash(ownShim), "path_dependent", `official generated shim mismatch: ${label}/${path}`);
      image.set(path, hash(generator.bunBinShimScript(before.executableRealpath, actualBun)));
    }
    need(isDeepStrictEqual(document(join(ownGlobal, "package.json")), {
      ...declaration, dependencies: { ...object(declaration["dependencies"]), "omo-ai": version },
    }), "calibration", "original Bun changed an unrelated shared declaration");
    const actualSlots = slots(ownGlobal, opaqueLinks), retained = actualSlots.filter(slot =>
      !selectedSlots.some(selected => selected.installName === slot.installName));
    const missingSlots = selectedSlots.filter(selected => !actualSlots.some(slot => isDeepStrictEqual(slot, selected)));
    const changedRetained = retained.filter(slot => !oldSlots.some(original => isDeepStrictEqual(slot, original)));
    if (missingSlots.length || changedRetained.length) {
      record(join(scope, "slot-drift.json"), { selectedSlots, actualSlots, missingSlots, changedRetained });
      need(false, "calibration", `physical alias/nested closure changed; ${scope}/slot-drift.json`);
    }
    // Original Bun may retain orphaned packages. They are not target artifacts
    // or postinstall output: their complete bytes/modes/links must stay unchanged.
    for (const slot of retained) {
      const path = `node_modules/${slot.installName}/`;
      const belongs = (file: { readonly path: string }) => file.path.startsWith(path)
        && !file.path.slice(path.length).startsWith("node_modules/");
      need(isDeepStrictEqual(output.files.filter(belongs), beforeGlobal.files.filter(belongs))
        && isDeepStrictEqual(output.links.filter(belongs), beforeGlobal.links.filter(belongs)),
      "calibration", `retained package changed: ${slot.installName}`);
      for (const file of beforeGlobal.files.filter(belongs))
        expectedArchive.set(`install/global/${file.path}`, file.sha256);
    }
    need(lstatSync(join(ownGlobal, "node_modules/omo-ai/plugin/daemon-launch-spec.json")).mode % 0o1000 === 0o644,
      "calibration", "official launch spec mode differs");
    afterImages.push(image);
    if (label === "calibration-a") {
      postinstall = [...image].filter(([path, sha256]) => expectedArchive.get(path) !== sha256)
        .filter(([path]) => path === "bin/omo" || path.startsWith("install/global/node_modules/"))
        .map(([path, sha256]) => ({ path: join(options.prefix, path), sha256 }));
    }
  }
  const afterImage = afterImages[0];
  need(afterImage !== undefined && isDeepStrictEqual(afterImage, afterImages[1]),
    "path_dependent", "independent after images disagree beyond official bound shims");
  need(isDeepStrictEqual(inventory(global, opaqueLinks), beforeGlobal) && pin(beforeShim.path).sha256 === beforeShim.sha256
    && pin(manager.path).sha256 === manager.sha256 && pin(manager.node.path).sha256 === manager.node.sha256
    && isDeepStrictEqual(anchors(options), coverageBefore),
  "source_changed", "selected operating inputs or stable coverage changed");
  const resources = before.resources.map(row => {
    const digest = afterImage.get(relative(options.prefix, row.realpath));
    need(digest !== undefined, "calibration", `after resource absent: ${row.realpath}`);
    return { ...row, fingerprint: `sha256:${digest}` };
  });
  const after: InstallationIdentity = { ...before, installedVersion: { kind: "known", version }, resources,
    resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  // Fresh public observation, not timestamp renewal of an old check/receipt.
  const tagsUrl = `${registry}/-/package/omo-ai/dist-tags`, targetUrl = `${registry}/omo-ai/${version}`;
  const tagsBytes = await get(tagsUrl, 1024 ** 2), targetBytes = await get(targetUrl, 4 * 1024 ** 2);
  need(object(JSON.parse(Buffer.from(tagsBytes).toString("utf8")))["latest"] === version
    && hash(targetBytes) === main.metadata.sha256, "source_changed", "official latest changed during calibration");
  const checkedAt = Date.now(), qualification: OmoUpdateQualification = { installation: before, manager, preservedLinks, preservedPeers,
    reuseVerifiedPackages: true, preservedPackages, retiredPackages,
    env: { BUN_INSTALL: options.prefix, HOME: home, PATH: [dirname(manager.path), dirname(manager.node.path)].join(":") },
    target: { packageName: "omo-ai", version, channel: "latest", checkedAt, expiresAt: checkedAt + 300_000, artifacts, postinstall } };
  const receipt = record(join(root, "qualification.json"), qualification);
  const qualified = await qualifyOmoUpdate({ qualification, receipt }, Date.now());
  need(qualified.ok, "qualification", "actual selected prefix rejected by legacy issuer");
  const provenance = record(join(root, "discovery.json"), { family: "omo", executable: before.executableRealpath,
    channel: "latest", owner: before.owner, packageManifest: join(wrapper, "package.json"),
    resources: before.resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })) });
  const preparation = record(join(root, "preparation.json"), { manager, originalPrefix: options.prefix, beforeGlobal,
    supportedSource: contract,
    independentCalibrations: 2, commands, operatingMutation: false, checkedAt,
    generatedShim: { generator: audited["bin/lib/bun-bin-shim.js"], executable: before.executableRealpath, bun: actualBun },
    oldSlots, selectedSlots, after: [...afterImage] });
  const inputs = validateOmoUpdateRuntimeInputs({ schemaVersion: 1, profile: OMO_UPDATE_RUNTIME_PROFILE,
    ownerDirectory: options.ownerDirectory, update: { qualification, receipt }, overlays: [], provenance: [provenance],
    expectedAfterPin: record(join(root, "expected-after.json"), after),
    independentTargetPins: [...afterImage].map(([path, sha256]) => ({ path: join(options.prefix, path), sha256 })),
    sourcePins: [...sourcePins, preparation], acquiredReplies: [
      { url: tagsUrl, status: 200, body: put(join(root, "latest-tags.json"), tagsBytes) },
      { url: targetUrl, status: 200, body: main.metadata },
    ], coverage: { root, prefix: options.prefix, socketDirectory: options.socketDirectory,
      registeredSockets: options.registeredSockets, rootPids: options.rootPids } });
  const configurationPin = record(join(root, "omo-runtime.json"), inputs);
  completed = true;
  return { inputs, configurationPin };
  } finally { if (completed || !source.keepFailedArtifacts) releaseFailedPreparation(root); }
}

/** Command composition compatibility; both names use the same producer. */
export const prepareOmoRuntimeUpdate = prepareOmoInstallationRuntime;
