import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { executePackageUpdate, getPackageUpdateIntent } from "./package-update";
import { executeCursorUpdate, getCursorUpdateIntent } from "./cursor-update";
import { executeAgyUpdate, getAgyUpdateIntent } from "./agy-update";
import type { AdapterResult, InstallationIdentity, Mode, PrivateUpdateCommand, PrivateUpdateContext,
  PrivateUpdateIntent, PrivateUpdateEvent, PrivateUpdateObservation, UpdateSpec } from "./types";

// allow: SIZE_OK — task38 owns only this execution module and shared types.
// Keep the private issuance table, immutable payload lease and effect boundary
// together; exporting validation helpers through shared types would widen authority.
export type UpdateFilePin = { readonly path: string; readonly sha256: string };
export const reviewedOmoTrustNames = ["omo-ai", "@google/genai", "protobufjs"] as const;
/** Exact registry lifecycle sources reviewed alongside the OmO lifecycle.
 * Preserve user trust declarations; do not turn a package name into code approval.
 */
export function isAuditedOmoTrustedLifecycle(name: string, manifest: Readonly<Record<string, unknown>>,
  members: ReadonlyMap<string, string>): boolean {
  const scripts = manifest["scripts"];
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return false;
  const lifecycle = Object.fromEntries(Object.entries(scripts).filter(([key]) =>
    ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"].includes(key)));
  switch (name) {
    case "omo-ai": return isDeepStrictEqual(lifecycle, { postinstall: "node bin/senpi-patch.mjs" });
    case "@google/genai":
      return isDeepStrictEqual(lifecycle, { preinstall: "echo 'preinstall: no-op'", prepare: "node scripts/prepare.js" })
        && ![...members.keys()].some(path => path.startsWith("scripts/"));
    case "protobufjs":
      return isDeepStrictEqual(lifecycle, { postinstall: "node scripts/postinstall" })
        && ![...members.keys()].some(path => path === "scripts/postinstall" || path.startsWith("scripts/postinstall/"))
        && members.get("scripts/postinstall.js") === "5af8463b97ee8e309b4a2111f9479bacdf0c180de0ca0155527679b1fc6d9e6c";
    default: return false;
  }
}
/** Explicit local variant, never substituted for acquired vendor evidence. */
export type OmoLocalOverlay = {
  readonly kind: "local-source-overlay";
  readonly archive: UpdateFilePin;
  readonly localDist: { readonly integrity: string; readonly tarballPath: string };
  readonly sourceBinding: UpdateFilePin;
  readonly originalBuildCommands: readonly string[];
  readonly files: readonly { readonly relativePath: string; readonly source: UpdateFilePin }[];
};
export type OmoLocalOverlayGrant = {
  readonly vendorArchive: UpdateFilePin;
  readonly vendorMetadata: UpdateFilePin;
  readonly overlay: OmoLocalOverlay;
};
export type OmoArtifact = {
  readonly name: string; readonly installName: string; readonly version: string;
  readonly archive: UpdateFilePin;
  /** Independently acquired npm version metadata, pinned by the private producer. */
  readonly metadata: UpdateFilePin;
  readonly overlay?: OmoLocalOverlay;
};
/** Trusted private qualification producer supplies the separately authenticated
 * receipt pin. A UI/client must never choose this pin or construct this record.
 * The receipt binds selection, manager, clean environment and checked release.
 */
export type OmoUpdateQualification = {
  readonly installation: InstallationIdentity;
  readonly manager: UpdateFilePin & { readonly name: "bun"; readonly node?: UpdateFilePin };
  readonly env: Readonly<Record<string, string>>;
  /** Unrelated top-level package links remain opaque and must never change. */
  readonly preservedLinks?: readonly { readonly path: string; readonly target: string }[];
  /** Existing peer conflicts outside OmO's dependency graph, unchanged
   * at both manifest paths and covered by the installation resource lease. */
  readonly preservedPeers?: readonly { readonly parent: UpdateFilePin; readonly dependency: UpdateFilePin; readonly key: string }[];
  /** Only packages whose complete existing payload matches the qualified
   * original archive may be reused instead of forcing every shared root. */
  readonly reuseVerifiedPackages?: true;
  /** Unreferenced installed packages are preserved as immutable data, not
   * promoted into the target dependency graph or reinstalled as dependencies. */
  readonly preservedPackages?: readonly { readonly root: string; readonly files: readonly UpdateFilePin[] }[];
  /** Recorded old nested packages removed only by replacing an authenticated
   * parent package version; unrecorded shadows remain forbidden. */
  readonly retiredPackages?: readonly { readonly root: string; readonly files: readonly UpdateFilePin[] }[];
  readonly target: {
    readonly packageName: "omo-ai"; readonly version: string;
    readonly channel: "latest" | "beta"; readonly checkedAt: number; readonly expiresAt: number;
    readonly artifacts: readonly OmoArtifact[];
    /** Independently qualified generated/modified outputs of official postinstall. */
    readonly postinstall: readonly UpdateFilePin[];
  };
};
export type OmoUpdateInput = {
  readonly qualification: OmoUpdateQualification;
  readonly receipt: UpdateFilePin;
};
export type UpdateChildResult = { readonly status: number | null; readonly signal: string | null };
export type OmoUpdateExecutor = {
  /** Clock is called again immediately before handing off the manager command. */
  readonly now: () => number;
  /** The only manager-process seam. No default executor, ambient env or shell. */
  readonly run: (command: PrivateUpdateCommand) => Promise<UpdateChildResult>;
  /** Task22 persists intent before resolving this hook. It cannot attest success. */
  readonly event?: (event: OmoUpdateEvent) => Promise<void>;
};
export type OmoExecutionIntent = PrivateUpdateIntent & { readonly family: "omo" };
export type OmoUpdateEvent = PrivateUpdateEvent;
export type OmoUpdateObservation = PrivateUpdateObservation;
type OfficialTarget = { manager: string; command: string; argv: string[]; env?: Record<string, string> };
type OfficialApi = {
  updateTarget: (root: string, platform: string, version: string, home: string,
    exists: (path: string) => boolean, target: string) => OfficialTarget;
  runSelfUpdate: (args: string[], options: {
    resolveUpdate: (target?: string) => OfficialTarget;
    fetchDistTags: () => Record<string, string>;
    log: (line: string) => void; error: (line: string) => void;
    readInstalled: () => { omo: string; engine: string };
    env: Readonly<Record<string, string>>;
    run: (command: string, args: string[], options: { env: Record<string, string> }) => Promise<UpdateChildResult>;
  }) => Promise<number>;
};
const sources = {
  "self-update.js": "8fc5b3ba5ebc7a3d9e4e1ed75b36ddf6f76f77c1595148d184a30681ce234fe7",
  "package-paths.js": "da57bd6016ab85a0f65f53cde53ca3b2e8606e2efc515bcb592d637c24401e67",
  "update-args.js": "3f571751faa087d83d1e6bae61c3206877616e93243479d7604f7a34f4685c6e",
} as const;
const contexts = new WeakMap<PrivateUpdateContext, OmoUpdateInput>();
// Only the private qualifier's explicit configuration grants a local variant.
// An overlay property in qualification JSON alone cannot select this branch.
const localOverlays = new WeakMap<OmoUpdateInput, readonly OmoLocalOverlayGrant[]>();
const issued = new WeakMap<UpdateSpec, { readonly input: OmoUpdateInput; readonly snapshot: UpdateSpec; readonly intent: OmoExecutionIntent; used: boolean }>();
const dispatchedOperations = new Set<string>();
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const absolute = (path: string): path is `/${string}` => path.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(path);
const exactVersion = (value: string): boolean => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value);
const packageName = (value: unknown): value is string => typeof value === "string"
  && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
// installName is a physical slot relative to the owned global node_modules,
// not necessarily the registry identity (aliases and nested versions retain both).
const installSlot = (value: unknown): value is string => typeof value === "string"
  && value.split("/node_modules/").every(part => packageName(part) && part !== "node_modules");
const slotName = (slot: string): string => slot.split("/node_modules/").at(-1) ?? "";
function dependencySlots(parent: string | null, key: string): string[] {
  const global = "/install/global";
  const slots: string[] = [];
  let search = parent === null ? global : join(global, "node_modules", parent);
  for (;;) {
    slots.push(join(search, "node_modules", key).slice(`${global}/node_modules/`.length));
    if (search === global) return slots;
    search = dirname(search);
    if (search.endsWith("/node_modules")) search = dirname(search);
    requireValid(search === global || search.startsWith(`${global}/`));
  }
}
const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
type DependencyEdge = {
  readonly parent: string | null; readonly field: string; readonly key: string; readonly declaration: string;
  readonly artifact: OmoArtifact | null;
};
class ContextFailure extends Error { constructor() { super("verification_failed"); } }
function requireValid(valid: boolean): asserts valid { if (!valid) throw new ContextFailure(); }
/** Resolve the nearest selected physical slot, then validate its actual identity
 * and version against the unchanged declaring field (including npm aliases). */
function declarations(q: OmoUpdateQualification, pkg: Record<string, unknown>, parent: string | null, after = false,
  preservedPeers: ReadonlySet<string> = new Set()): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const field of [...dependencyFields, ...(parent === null ? ["devDependencies"] : [])]) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    requireValid(typeof deps === "object" && deps !== null && !Array.isArray(deps));
    for (const [key, declaration] of Object.entries(deps)) {
      requireValid(packageName(key) && typeof declaration === "string");
      const slot = dependencySlots(parent, key).find(candidate => q.target.artifacts.some(a => a.installName === candidate));
      const artifact = q.target.artifacts.find(a => a.installName === slot);
      const alias = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(.+)$/.exec(declaration);
      const range = alias ? alias[2] : declaration;
      requireValid(typeof range === "string" && /^[0-9A-Za-z*^~<>=| .+-]+$/.test(range)
        && /[0-9*]/.test(range));
      if (artifact === undefined) {
        const meta = pkg["peerDependenciesMeta"];
        const peer: unknown = typeof meta === "object" && meta !== null
          ? Object.entries(meta).find(([name]) => name === key)?.[1] : undefined;
        requireValid(field === "optionalDependencies" || (field === "peerDependencies"
          && typeof peer === "object" && peer !== null && "optional" in peer && peer.optional === true));
        edges.push({ parent, field, key, declaration, artifact: null });
        continue;
      }
      requireValid(alias ? alias[1] === artifact.name : key === artifact.name);
      // The original global declaration selects the currently installed wrapper;
      // the official add command replaces it with the qualified target.
      const version = parent === null && key === "omo-ai"
        && q.installation.installedVersion.kind === "known" ? q.installation.installedVersion.version : artifact.version;
      requireValid(Bun.semver.satisfies(version, range)
        || (field === "peerDependencies" && preservedPeers.has(JSON.stringify([parent, key, artifact.installName])))
        || (after && parent === null && key === "omo-ai" && Bun.semver.satisfies(artifact.version, range)));
      edges.push({ parent, field, key, declaration, artifact });
    }
  }
  return edges;
}
function file(pin: UpdateFilePin): Buffer {
  requireValid(absolute(pin.path) && realpathSync(pin.path) === pin.path);
  const stat = statSync(pin.path);
  requireValid(stat.isFile() && stat.size <= 256 * 1024 * 1024);
  const body = readFileSync(pin.path);
  requireValid(hash(body) === pin.sha256);
  return body;
}
function manifest(path: string): Record<string, unknown> {
  requireValid(realpathSync(path) === path && statSync(path).isFile() && statSync(path).size <= 1024 * 1024);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  requireValid(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function roots(q: OmoUpdateQualification) {
  const owner = q.installation.owner;
  requireValid(owner.kind === "wrapper");
  const wrapper = join(owner.prefix, "install/global/node_modules/omo-ai");
  return { prefix: owner.prefix, wrapper, engine: join(owner.prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json") };
}
function verifyPreservedLinks(q: OmoUpdateQualification): void {
  const links = q.preservedLinks ?? [], modules = join(roots(q).prefix, "install/global/node_modules");
  requireValid(links.length <= 128 && new Set(links.map(row => row.path)).size === links.length);
  for (const row of links) {
    const slot = row.path.slice(modules.length + 1);
    requireValid(row.path === join(modules, slot) && packageName(slot)
      && !q.target.artifacts.some(artifact => artifact.installName === slot || artifact.installName.startsWith(`${slot}/node_modules/`))
      && absolute(row.target) && realpathSync(dirname(row.path)) === dirname(row.path));
    const info = lstatSync(row.path);
    requireValid(info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid?.()
      && readlinkSync(row.path) === row.target);
  }
}
function installed(q: OmoUpdateQualification) {
  const r = roots(q);
  const wrapper = manifest(join(r.wrapper, "package.json"));
  const engine = manifest(r.engine);
  const deps = wrapper["dependencies"];
  requireValid(wrapper["name"] === "omo-ai" && engine["name"] === "@code-yeongyu/senpi"
    && typeof wrapper["version"] === "string" && typeof engine["version"] === "string"
    && typeof deps === "object" && deps !== null
    && "@code-yeongyu/senpi" in deps && deps["@code-yeongyu/senpi"] === engine["version"]);
  return { omo: wrapper["version"], engine: engine["version"] };
}
function configuration(q: OmoUpdateQualification, after = false): DependencyEdge[] {
  const r = roots(q), home = q.env["HOME"];
  requireValid(home !== undefined);
  // Known Bun/npm search roots, with no inherited XDG/config/env-file overrides.
  const search = new Set([home, r.wrapper, join(r.prefix, "install/global"), r.prefix]);
  for (const dir of search) for (const name of [".npmrc", ".bunfig.toml", "bunfig.toml", ".env", ".env.local", ".env.production", ".env.development"]) {
    // lstat also catches dangling links; never read credential-bearing config.
    requireValid(!existsSync(join(dir, name)) && !lstatSync(join(dir, name), { throwIfNoEntry: false }));
  }
  for (const path of ["/etc/npmrc", "/usr/local/etc/npmrc", join(dirname(q.manager.path), "../etc/npmrc")])
    requireValid(!lstatSync(path, { throwIfNoEntry: false }));
  const global = manifest(join(r.prefix, "install/global/package.json"));
  requireValid(!global["overrides"] && !global["resolutions"] && !global["scripts"] && !global["workspaces"]);
  const edges = declarations(q, global, null, after);
  // The fingerprinted old lock is discarded after durable dispatch, before
  // the manager can resolve any URL/git/file entry outside the leased registry.
  return edges;
}
/** Do not persist dead loopback references in the owned global lock. Only the
 * exact leased URLs map back to independently pinned canonical npm URLs.
 * This is an intent-covered post-effect write, never a success/rollback receipt.
 */
function canonicalizeLock(q: OmoUpdateQualification, registry: string): void {
  const path = join(roots(q).prefix, "install/global/bun.lock");
  requireValid(realpathSync(path) === path && statSync(path).isFile() && statSync(path).size <= 16 * 1024 * 1024);
  const replacements = new Map([[registry, "https://registry.npmjs.org"]]);
  for (const artifact of q.target.artifacts) {
    const metadata: unknown = JSON.parse(file(artifact.metadata).toString("utf8"));
    requireValid(typeof metadata === "object" && metadata !== null && "dist" in metadata
      && typeof metadata.dist === "object" && metadata.dist !== null && "tarball" in metadata.dist
      && typeof metadata.dist.tarball === "string");
    const archive = artifact.overlay?.archive ?? artifact.archive;
    replacements.set(`${registry}/tarballs/${archive.sha256}.tgz`, artifact.overlay
      ? `file://${archive.path}` : metadata.dist.tarball);
  }
  const allowed = new Set(replacements.values());
  let changed = false;
  function normalize(value: unknown): unknown {
    if (typeof value === "string") {
      const canonical = replacements.get(value);
      if (canonical) { changed = true; return canonical; }
      requireValid(!value.includes(registry) && (!/(?:https?:|git:|file:|ssh:)/.test(value) || allowed.has(value)));
      return value;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        requireValid(!/(?:https?:|git:|file:|ssh:)/.test(key));
        return [key, normalize(item)];
      }));
    return value;
  }
  const normalized = normalize(Bun.JSON5.parse(readFileSync(path, "utf8")));
  if (changed) writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
}
function artifactBytes(artifact: OmoArtifact): Buffer {
  const metadata: unknown = JSON.parse(file(artifact.metadata).toString("utf8"));
  requireValid(typeof metadata === "object" && metadata !== null && "name" in metadata && metadata.name === artifact.name
    && "version" in metadata && metadata.version === artifact.version && "dist" in metadata
    && typeof metadata.dist === "object" && metadata.dist !== null && "tarball" in metadata.dist && "integrity" in metadata.dist);
  const dist = metadata.dist;
  requireValid(typeof dist.tarball === "string" && dist.tarball.startsWith(`https://registry.npmjs.org/${artifact.name}/-/`)
    && typeof dist.integrity === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity));
  const bytes = file(artifact.archive);
  requireValid(`sha512-${createHash("sha512").update(bytes).digest("base64")}` === dist.integrity);
  return bytes;
}
function overlayBytes(artifact: OmoArtifact, grants: readonly OmoLocalOverlayGrant[]): Buffer {
  const overlay = artifact.overlay;
  requireValid(overlay !== undefined && overlay.kind === "local-source-overlay"
    && grants.some(grant => isDeepStrictEqual(grant.vendorArchive, artifact.archive)
      && isDeepStrictEqual(grant.vendorMetadata, artifact.metadata) && isDeepStrictEqual(grant.overlay, overlay)));
  file(overlay.sourceBinding);
  requireValid(overlay.originalBuildCommands.length > 0 && overlay.originalBuildCommands.every(command => typeof command === "string" && command.length > 0)
    && overlay.files.length > 0 && new Set(overlay.files.map(row => row.relativePath)).size === overlay.files.length);
  const required = artifact.name === "omo-ai"
    ? ["bin/omo.js", "bin/lib/launcher.js", "plugin/extensions/omo.js", "plugin/extensions/omo-task.js", "plugin/extensions/omo-member.js"]
    : artifact.name === "@code-yeongyu/senpi"
      ? ["dist/cli-main.js", "dist/core/updater-native-bridge.js", "dist/core/agent-session.js", "dist/core/session-manager.js",
        "dist/modes/interactive/interactive-mode.js", "dist/core/extensions/builtin/terminal/tools/monitor.js"] : [];
  requireValid(required.every(path => overlay.files.some(row => row.relativePath === path)));
  for (const row of overlay.files) {
    requireValid(!row.relativePath.startsWith("/") && !row.relativePath.includes("\\")
      && row.relativePath !== "package.json" && row.relativePath !== "plugin/package.json"
      && row.relativePath.split("/").every(part => part !== ".." && part !== "." && part !== ""));
    file(row.source);
  }
  const bytes = file(overlay.archive);
  requireValid(overlay.localDist.tarballPath === `/tarballs/${overlay.archive.sha256}.tgz`
    && /^sha512-[A-Za-z0-9+/]{86}==$/.test(overlay.localDist.integrity)
    && `sha512-${createHash("sha512").update(bytes).digest("base64")}` === overlay.localDist.integrity);
  return bytes;
}
/** Freshness is bounded by the receipt's checkedAt/expiresAt (maximum five minutes),
 * not by a mutable capability boolean. Every invocation repeats these disk reads.
 */
function fresh(input: OmoUpdateInput, now: number): Record<string, string> {
  const q = input.qualification;
  requireValid(isDeepStrictEqual(JSON.parse(file(input.receipt).toString("utf8")), q));
  const i = q.installation, t = q.target, r = roots(q);
  verifyPreservedLinks(q);
  requireValid(Array.isArray(t.artifacts) && t.artifacts.length >= 2
    && new Set(t.artifacts.map(a => a.installName)).size === t.artifacts.length
    && t.artifacts.some(a => a.name === "omo-ai" && a.installName === a.name && a.version === t.version)
    && t.artifacts.some(a => a.name === "@code-yeongyu/senpi" && a.installName === a.name)
    && Array.isArray(t.postinstall) && t.postinstall.length > 0);
  for (const artifact of t.artifacts) {
    requireValid(packageName(artifact.name) && installSlot(artifact.installName) && exactVersion(artifact.version));
    for (const same of t.artifacts.filter(a => a.name === artifact.name && a.version === artifact.version))
      requireValid(same.archive.sha256 === artifact.archive.sha256 && same.metadata.sha256 === artifact.metadata.sha256
        && isDeepStrictEqual(same.overlay, artifact.overlay));
    artifactBytes(artifact);
    if (artifact.overlay) overlayBytes(artifact, localOverlays.get(input) ?? []);
  }
  for (const output of t.postinstall) requireValid(output.path.startsWith(`${r.prefix}/`) && /^[a-f0-9]{64}$/.test(output.sha256));
  requireValid(i.family === "omo" && i.owner.kind === "wrapper" && i.owner.packageName === "omo-ai"
    && i.installedVersion.kind === "known" && exactVersion(i.installedVersion.version)
    && !i.installedVersion.version.includes("-")
    && i.channel === "latest" && t.channel === i.channel && t.packageName === "omo-ai"
    && exactVersion(t.version) && !t.version.includes("-")
    && Number.isSafeInteger(now) && Number.isSafeInteger(t.checkedAt) && Number.isSafeInteger(t.expiresAt)
    && t.checkedAt <= now && now < t.expiresAt && t.expiresAt - t.checkedAt <= 300_000);
  requireValid(absolute(r.prefix) && realpathSync(r.prefix) === r.prefix && statSync(r.prefix).isDirectory());
  const env = q.env;
  requireValid(Object.keys(env).sort().join(",") === "BUN_INSTALL,HOME,PATH"
    && env["BUN_INSTALL"] === r.prefix && env["PATH"] === [dirname(q.manager.path),
      ...(q.manager.node ? [dirname(q.manager.node.path)] : [])].join(":")
    && typeof env["HOME"] === "string" && absolute(env["HOME"])
    && realpathSync(env["HOME"]) === env["HOME"] && statSync(env["HOME"]).isDirectory());
  requireValid(q.manager.name === "bun");
  file(q.manager);
  if (q.manager.node) {
    file(q.manager.node);
    requireValid(q.manager.node.path.endsWith("/node") && (statSync(q.manager.node.path).mode & 0o111) !== 0);
  }
  requireValid((statSync(q.manager.path).mode & 0o111) !== 0);
  configuration(q);
  requireValid(i.executableRealpath === join(r.wrapper, "bin/omo.js")
    && i.installationId === `install:${hash(i.executableRealpath)}`
    && i.resourcesFingerprint === `sha256:${hash(JSON.stringify(i.resources))}`
    && new Set(i.resources.map(row => row.realpath)).size === i.resources.length
    && new Set(i.resources.map(row => row.resourceId)).size === i.resources.length);
  const required = [i.executableRealpath, join(r.wrapper, "package.json"), r.engine,
    join(r.prefix, "install/global/package.json"), join(r.prefix, "install/global/bun.lock"),
    join(r.prefix, "bin/omo"), join(r.wrapper, "bin/senpi-patch.mjs"),
    ...Object.keys(sources).map(name => join(r.wrapper, "bin/lib", name))];
  requireValid(i.owner.kind === "wrapper" && i.owner.engineResourceId === `resource:${hash(r.engine)}`
    && required.every(path => i.resources.some(row => row.realpath === path)));
  for (const row of i.resources) {
    requireValid(row.realpath.startsWith(`${r.prefix}/`) && row.resourceId === `resource:${hash(row.realpath)}`
      && /^sha256:[a-f0-9]{64}$/.test(row.fingerprint));
    file({ path: row.realpath, sha256: row.fingerprint.replace(/^sha256:/, "") });
  }
  requireValid(installed(q).omo === i.installedVersion.version);
  const wrapper = manifest(join(r.wrapper, "package.json"));
  requireValid(isDeepStrictEqual(wrapper["bin"], { omo: "bin/omo.js" })
    && typeof wrapper["scripts"] === "object" && wrapper["scripts"] !== null
    && "postinstall" in wrapper["scripts"] && wrapper["scripts"].postinstall === "node bin/senpi-patch.mjs");
  const files: Record<string, string> = {};
  for (const [name, sha256] of Object.entries(sources)) files[`/omo/${name}`] = file({ path: join(r.wrapper, "bin/lib", name), sha256 }).toString("utf8");
  return files;
}
const failure = <T>(): AdapterResult<T> => ({ ok: false, error: { code: "verification_failed" } });

export async function qualifyOmoUpdate(input: OmoUpdateInput, now: number,
  trustedLocalOverlays: readonly OmoLocalOverlayGrant[] = []): Promise<AdapterResult<PrivateUpdateContext>> {
  try {
    const snapshot = structuredClone(input);
    localOverlays.set(snapshot, structuredClone(trustedLocalOverlays));
    fresh(snapshot, now);
    const contents = await payload(snapshot.qualification, localOverlays.get(snapshot) ?? []);
    fresh(snapshot, now);
    verifyDestinations(snapshot.qualification, contents);
    verifyReusablePackages(snapshot.qualification, contents);
    const handle: PrivateUpdateContext = Object.freeze({ kind: "omo-official-update" });
    contexts.set(handle, snapshot);
    return { ok: true, value: handle };
  // Private boundary: even non-Error throws must not escape with secret payloads.
  } catch { return failure(); }
}
export function createOmoUpdateSpec(context: PrivateUpdateContext, request: Mode | OmoExecutionIntent, now: number): AdapterResult<UpdateSpec> {
  try {
    const input = contexts.get(context);
    const mode = typeof request === "string" ? request : request.mode;
    requireValid(input !== undefined && (mode === "update-only" || mode === "update-and-restart"));
    fresh(input, now);
    const q = input.qualification, r = roots(q);
    requireValid(absolute(q.manager.path) && absolute(r.wrapper));
    const intent: OmoExecutionIntent = Object.freeze({ operationId: typeof request === "string" ? randomUUID() : request.operationId,
      family: "omo", mode, installationId: q.installation.installationId, targetFingerprint: hash(JSON.stringify(q.target)),
      provenanceDigest: input.receipt.sha256, managerDigest: q.manager.sha256 });
    requireValid(/^[A-Za-z0-9._:-]{1,128}$/.test(intent.operationId)
      && (typeof request === "string" || isDeepStrictEqual(request, intent)));
    const spec: UpdateSpec = {
      command: { executable: q.manager.path, args: ["add", "-g", `omo-ai@${q.target.version}`], cwd: r.wrapper },
      mode, expectedInstallation: structuredClone(q.installation),
      mutationResources: structuredClone(q.installation.resources), execution: context,
    };
    issued.set(spec, { input, snapshot: { ...structuredClone(spec), execution: context }, intent, used: false });
    return { ok: true, value: spec };
  } catch { return failure(); }
}
export function getOmoUpdateIntent(spec: UpdateSpec): AdapterResult<OmoExecutionIntent> {
  try {
    const record = issued.get(spec);
    return record && isDeepStrictEqual(record.snapshot, spec) ? { ok: true, value: record.intent } : failure();
  } catch { return failure(); }
}
/** Closed process-local union. A family label or copied handle cannot select a
 * strategy: only the respective issuer's WeakMap authenticates its exact spec.
 */
export function getPrivateUpdateIntent(spec: UpdateSpec): AdapterResult<PrivateUpdateIntent> {
  const omo = getOmoUpdateIntent(spec);
  if (omo.ok) return omo;
  const packaged = getPackageUpdateIntent(spec);
  if (packaged.ok) return packaged;
  const cursor = getCursorUpdateIntent(spec);
  return cursor.ok ? cursor : getAgyUpdateIntent(spec);
}
export async function executePrivateUpdate(spec: UpdateSpec, executor: OmoUpdateExecutor): Promise<AdapterResult<PrivateUpdateObservation>> {
  if (getOmoUpdateIntent(spec).ok) return executeOmoUpdate(spec, executor);
  if (getPackageUpdateIntent(spec).ok) return executePackageUpdate(spec, executor);
  if (getCursorUpdateIntent(spec).ok) return executeCursorUpdate(spec, executor);
  if (getAgyUpdateIntent(spec).ok) return executeAgyUpdate(spec, executor);
  return failure();
}
/** Link authenticated snapshots, not an installed module with unauthenticated
 * transitive imports. Official function bodies are unmodified. Unused upstream
 * defaults are traps: registry/spawn must only use the explicit injected API.
 * No acquired file is edited, imported from disk or written by this linker.
 */
async function official(files: Record<string, string>): Promise<OfficialApi> {
  const result = await Bun.build({
    entrypoints: ["/omo/entry.js"], target: "bun",
    define: { "import.meta.url": JSON.stringify("file:///omo/package-paths.js") },
    files: { ...files,
      "/omo/entry.js": 'export {runSelfUpdate} from "./self-update.js"; export {updateTarget} from "./package-paths.js";',
      "/omo/child-process.js": 'export function runChild(){throw new Error("injection_required")}',
      "/omo/npm-dist-tags.js": 'export function fetchNpmDistTagsSync(){throw new Error("injection_required")}',
    },
  });
  requireValid(result.success && result.outputs.length === 1);
  const output = result.outputs[0];
  requireValid(output !== undefined);
  return import(`data:text/javascript;base64,${Buffer.from(await output.text()).toString("base64")}`);
}
/** Only qualified bytes are reachable from this per-invocation registry. No
 * proxy/fallback exists. An empty private cache and --force prevent reuse of
 * unchecked installed/cache bytes. Whole wrapper installation retains scripts.
 */
async function archiveEntries(bytes: Buffer) {
    const tar = bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 }) : bytes;
    let regularFiles = 0;
    let root: string | undefined;
    let pax: Map<string, string> | undefined;
    // Extended metadata is admitted only when it cannot redirect extraction.
    for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0;) {
      const kind = tar[offset + 156];
      requireValid(kind === 0 || kind === 48 || kind === 53 || kind === 120);
      const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, "").trim() || "0", 8);
      requireValid(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length);
      if (kind === 120) {
        requireValid(pax === undefined);
        pax = new Map();
        const data = tar.subarray(offset + 512, offset + 512 + size);
        for (let position = 0; position < data.length;) {
          const space = data.indexOf(32, position);
          requireValid(space > position);
          const length = Number(data.subarray(position, space).toString());
          requireValid(Number.isSafeInteger(length) && length > space - position + 2
            && position + length <= data.length && data[position + length - 1] === 10);
          const record = data.subarray(space + 1, position + length - 1).toString(), equal = record.indexOf("=");
          requireValid(equal > 0);
          const key = record.slice(0, equal), value = record.slice(equal + 1);
          requireValid(!pax.has(key) && (key === "path" || key === "size" || key === "uid" || key === "gid"
            || /^NODETAR\.(?:depth|follow|ignoreFiles\.\d+|package\..+|type|blksize|blocks)$/.test(key)
            || /^SCHILY\.(?:dev|ino|nlink)$/.test(key)));
          requireValid((key !== "SCHILY.nlink" || value === "1")
            && (key !== "NODETAR.type" || value === "File") && (key !== "NODETAR.follow" || value === "false"));
          pax.set(key, value);
          position += length;
        }
        offset += 512 + Math.ceil(size / 512) * 512;
        continue;
      }
      const rawName = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/, "");
      const prefix = tar.subarray(offset + 345, offset + 500).toString().replace(/\0.*$/, "");
      const fullName = prefix ? `${prefix}/${rawName}` : rawName;
      // Redundant PAX path/size must agree exactly with the ordinary header.
      if (pax) {
        requireValid((!pax.has("path") || pax.get("path") === fullName)
          && (!pax.has("size") || pax.get("size") === String(size)) && (kind === 0 || kind === 48));
        pax = undefined;
      }
      const rawParts = fullName.split("/");
      requireValid(!fullName.includes("\\") && rawParts.every((part, index) => part !== ".."
        && (part !== "" || (kind === 53 && index === rawParts.length - 1))));
      const parts = rawParts.filter(part => part !== "." && part !== "");
      const entryRoot = parts[0];
      requireValid(entryRoot !== undefined && /^[A-Za-z0-9_@-][A-Za-z0-9_.@-]*$/.test(entryRoot)
        && (parts.length > 1 || kind === 53));
      root ??= entryRoot;
      requireValid(entryRoot === root);
      if (kind === 53) requireValid(size === 0);
      else regularFiles++;
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    const entries = await new Bun.Archive(bytes).files();
    requireValid(pax === undefined && root !== undefined && entries.size === regularFiles);
    // npm also ships named roots (for example @types/retry uses retry/).
    // Normalize inspection keys only; the original archive reaches Bun unchanged.
    const normalized: typeof entries = new Map();
    for (const [name, entry] of entries) {
      const parts = name.split("/").filter(part => part !== ".");
      requireValid(parts[0] === root && parts.length > 1 && parts.every(part => part !== ".." && part !== ""));
      const key = `package/${parts.slice(1).join("/")}`, previous = normalized.get(key);
      // Safe dot aliases may repeat only identical bytes, never overwrite them.
      if (previous) requireValid(hash(new Uint8Array(await previous.arrayBuffer())) === hash(new Uint8Array(await entry.arrayBuffer())));
      normalized.set(key, entry);
    }
    return normalized;
}
async function payload(q: OmoUpdateQualification, grants: readonly OmoLocalOverlayGrant[] = []) {
  const manifests = new Map<string, Record<string, unknown>>();
  const archives = new Map<string, Buffer>();
  const expected = new Map<string, string>();
  const originalPackages = new Map<string, Map<string, string>>();
  const r = roots(q);
  const trusted = manifest(join(r.prefix, "install/global/package.json"))["trustedDependencies"];
  if (trusted !== undefined) requireValid(Array.isArray(trusted) && trusted.includes("omo-ai")
    && new Set(trusted).size === trusted.length && trusted.every(name => reviewedOmoTrustNames.some(known => known === name)));
  for (const artifact of q.target.artifacts) {
    const vendorBytes = artifactBytes(artifact);
    const vendorEntries = await archiveEntries(vendorBytes);
    const bytes = artifact.overlay ? overlayBytes(artifact, grants) : vendorBytes;
    const entries = artifact.overlay ? await archiveEntries(bytes) : vendorEntries;
    if (artifact.overlay) {
      const vendorManifest = vendorEntries.get("package/package.json"), localManifest = entries.get("package/package.json");
      requireValid(vendorManifest !== undefined && localManifest !== undefined
        && isDeepStrictEqual(JSON.parse(await vendorManifest.text()), JSON.parse(await localManifest.text())));
      const changes = new Map(artifact.overlay.files.map(row => [`package/${row.relativePath}`, row.source]));
      for (const name of vendorEntries.keys()) requireValid(entries.has(name));
      for (const [name, blob] of entries) {
        const source = changes.get(name), original = vendorEntries.get(name);
        requireValid(source !== undefined || original !== undefined);
        const actual = new Uint8Array(await blob.arrayBuffer());
        requireValid(source ? hash(actual) === hash(file(source))
          : original !== undefined && hash(actual) === hash(new Uint8Array(await original.arrayBuffer())));
      }
      for (const name of changes.keys()) requireValid(entries.has(name));
    }
    const entry = entries.get("package/package.json");
    requireValid(entry !== undefined);
    const data: unknown = JSON.parse(await entry.text());
    requireValid(typeof data === "object" && data !== null && "name" in data && data.name === artifact.name
      && "version" in data && (data.version === artifact.version
        || (artifact.name !== "omo-ai" && artifact.name !== "@code-yeongyu/senpi" && data.version === `v${artifact.version}`)));
    const pkg = Object.fromEntries(Object.entries(data));
    // These are installed dependency manifests, not the global resolution root.
    // Preserve their root-only metadata; bundled code still needs its own pins.
    requireValid(!pkg["bundledDependencies"] && !pkg["bundleDependencies"]);
    const installedRoot = join(r.prefix, "install/global/node_modules", artifact.installName);
    const originalFiles = new Map<string, string>();
    for (const [name, blob] of entries) {
      requireValid(name.startsWith("package/") && !name.includes("\\") && name.split("/").every(part => part !== ".." && part !== "."));
      // Dependency-local Bun configuration is inert for the fixed global cwd.
      // Keep it in the integrity-bound payload; active root/HOME configuration
      // remains rejected by configuration(). The wrapper itself runs hooks.
      requireValid(artifact.name !== "omo-ai" || !["package/bunfig.toml", "package/.bunfig.toml"].includes(name));
      requireValid(!["package/.npmrc",
        "package/.env", "package/.env.local", "package/.env.production", "package/.env.development"].includes(name));
      const path = join(installedRoot, name.slice(8)), digest = hash(new Uint8Array(await blob.arrayBuffer()));
      expected.set(path, digest);
      originalFiles.set(path, digest);
    }
    originalPackages.set(artifact.installName, originalFiles);
    if (Array.isArray(trusted) && (trusted.includes(artifact.name) || trusted.includes(slotName(artifact.installName))))
      requireValid(isAuditedOmoTrustedLifecycle(artifact.name, pkg,
        new Map([...originalFiles].map(([path, digest]) => [path.slice(installedRoot.length + 1), digest]))));
    manifests.set(artifact.installName, pkg);
    archives.set(`/tarballs/${(artifact.overlay?.archive ?? artifact.archive).sha256}.tgz`, bytes);
  }
  if (Array.isArray(trusted)) requireValid(trusted.every(name =>
    q.target.artifacts.some(artifact => artifact.name === name || slotName(artifact.installName) === name)));
  // Collect every manifest first: declaration joins never depend on row order.
  const preservedPeers = new Set<string>();
  if (q.preservedPeers?.length) {
    requireValid(q.preservedPeers.length <= 128);
    const reachable = new Set(["omo-ai"]), pending = ["omo-ai"];
    for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
      const pkg = manifests.get(parent);
      requireValid(pkg !== undefined);
      for (const field of dependencyFields) {
        const dependencies = pkg[field];
        if (dependencies === undefined) continue;
        requireValid(typeof dependencies === "object" && dependencies !== null);
        for (const key of Object.keys(dependencies)) {
          const child = dependencySlots(parent, key).find(slot => manifests.has(slot));
          if (child && !reachable.has(child)) { reachable.add(child); pending.push(child); }
        }
      }
    }
    const modules = join(r.prefix, "install/global/node_modules");
    for (const row of q.preservedPeers) {
      const parent = q.target.artifacts.find(artifact => join(modules, artifact.installName, "package.json") === row.parent.path);
      const child = q.target.artifacts.find(artifact => join(modules, artifact.installName, "package.json") === row.dependency.path);
      requireValid(parent !== undefined && child !== undefined && !reachable.has(parent.installName) && packageName(row.key));
      for (const reference of [row.parent, row.dependency]) {
        requireValid(q.installation.resources.some(resource => resource.realpath === reference.path
          && resource.fingerprint === `sha256:${reference.sha256}`) && expected.get(reference.path) === reference.sha256
          && q.target.postinstall.every(pin => pin.path !== reference.path || pin.sha256 === reference.sha256));
        file(reference);
      }
      requireValid(dependencySlots(parent.installName, row.key).find(slot => manifests.has(slot)) === child.installName);
      preservedPeers.add(JSON.stringify([parent.installName, row.key, child.installName]));
    }
  }
  const edges = configuration(q);
  for (const [slot, pkg] of manifests) edges.push(...declarations(q, pkg, slot, false, preservedPeers));
  for (const artifact of q.target.artifacts) {
    requireValid(slotName(artifact.installName) === artifact.name
      || edges.some(edge => edge.artifact === artifact && edge.declaration.startsWith(`npm:${artifact.name}@`)));
    if (artifact.installName.includes("/node_modules/")
      || q.target.artifacts.filter(a => a.name === artifact.name).length > 1)
      requireValid(edges.some(edge => edge.artifact === artifact));
    const parts = artifact.installName.split("/node_modules/");
    for (let index = 1; index < parts.length; index++)
      requireValid(manifests.has(parts.slice(0, index).join("/node_modules/")));
  }
  const wrapper = manifests.get("omo-ai"), engine = manifests.get("@code-yeongyu/senpi");
  requireValid(wrapper !== undefined && engine !== undefined
    && isDeepStrictEqual(wrapper["dependencies"], { "@code-yeongyu/senpi": engine["version"] })
    && isDeepStrictEqual(wrapper["scripts"], { postinstall: "node bin/senpi-patch.mjs" }));
  const preservedRoots: string[] = [];
  for (const preserved of q.preservedPackages ?? []) {
    const modules = join(r.prefix, "install/global/node_modules"), slot = preserved.root.slice(modules.length + 1);
    requireValid(preserved.root === join(modules, slot) && installSlot(slot)
      && !q.target.artifacts.some(artifact => artifact.installName === slot || artifact.installName.startsWith(`${slot}/node_modules/`))
      && preserved.files.length > 0 && preserved.files.some(pin => pin.path === join(preserved.root, "package.json")));
    preservedRoots.push(preserved.root);
    for (const pin of preserved.files) {
      requireValid(pin.path.startsWith(`${preserved.root}/`) && !expected.has(pin.path)
        && !q.target.postinstall.some(output => output.path === pin.path));
      file(pin);
      expected.set(pin.path, pin.sha256);
    }
  }
  for (const pin of q.target.postinstall) expected.set(pin.path, pin.sha256);
  return { manifests, archives, expected, edges,
    originalPackages,
    roots: [...q.target.artifacts.map(a => join(r.prefix, "install/global/node_modules", a.installName)), ...preservedRoots] };
}
function verifyReusablePackages(q: OmoUpdateQualification, contents: Awaited<ReturnType<typeof payload>>): void {
  if (q.reuseVerifiedPackages === undefined) return;
  requireValid(q.reuseVerifiedPackages === true);
  const modules = join(roots(q).prefix, "install/global/node_modules");
  for (const artifact of q.target.artifacts) {
    const root = join(modules, artifact.installName), packageJson = join(root, "package.json");
    if (!lstatSync(packageJson, { throwIfNoEntry: false })) continue;
    const installed = manifest(packageJson), target = contents.manifests.get(artifact.installName);
    if (installed["version"] !== target?.["version"]) continue;
    const expected = new Map(contents.originalPackages.get(artifact.installName));
    const pending = [root];
    while (pending.length) {
      const directory = pending.pop();
      requireValid(directory !== undefined && realpathSync(directory) === directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (path === join(root, "node_modules")) continue;
        if (entry.isDirectory()) pending.push(path);
        else {
          const sha256 = expected.get(path);
          requireValid(entry.isFile() && sha256 !== undefined);
          const actual = hash(readFileSync(path));
          requireValid(actual === sha256 || q.target.postinstall.some(pin => pin.path === path && pin.sha256 === actual));
          file({ path, sha256: actual });
          expected.delete(path);
        }
      }
    }
    requireValid(expected.size === 0);
  }
}
/** Check existing write paths before effects; future leaves may be absent only
 * below canonical directories. The owner still supplies exclusive mutation
 * admission: this synchronous check does not cancel arbitrary external writers. */
function verifyDestinations(q: OmoUpdateQualification, contents: Awaited<ReturnType<typeof payload>>): void {
  const prefix = roots(q).prefix, globalRoot = join(prefix, "install/global");
  for (const retired of q.retiredPackages ?? []) {
    const modules = join(globalRoot, "node_modules"), slot = retired.root.slice(modules.length + 1);
    requireValid(retired.root === join(modules, slot) && installSlot(slot)
      && !q.target.artifacts.some(artifact => artifact.installName === slot || artifact.installName.startsWith(`${slot}/node_modules/`))
      && ![...contents.expected.keys()].some(path => path.startsWith(`${retired.root}/`))
      && retired.files.some(pin => pin.path === join(retired.root, "package.json")));
    const parent = q.target.artifacts.find(artifact => {
      const parentRoot = join(modules, artifact.installName);
      if (!retired.root.startsWith(`${parentRoot}/node_modules/`)) return false;
      const path = join(parentRoot, "package.json"), bound = q.installation.resources.find(row => row.realpath === path);
      if (!bound) return false;
      file({ path, sha256: bound.fingerprint.slice(7) });
      const before = manifest(path);
      return before["name"] === artifact.name && typeof before["version"] === "string"
        && before["version"].replace(/^v(?=\d)/, "") !== artifact.version;
    });
    requireValid(parent !== undefined);
    const expected = new Map(retired.files.map(pin => [pin.path, pin.sha256]));
    requireValid(expected.size === retired.files.length);
    const pending = [retired.root];
    while (pending.length) {
      const directory = pending.pop();
      requireValid(directory !== undefined && realpathSync(directory) === directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else {
          const sha256 = expected.get(path);
          requireValid(entry.isFile() && sha256 !== undefined);
          file({ path, sha256 }); expected.delete(path);
        }
      }
    }
    requireValid(expected.size === 0);
  }
  function existing(path: string, outputFile = false): void {
    requireValid(path.startsWith(`${prefix}/`) && join(prefix, path.slice(prefix.length + 1)) === path);
    let current = prefix;
    for (const part of path.slice(prefix.length + 1).split("/")) {
      current = join(current, part);
      const entry = lstatSync(current, { throwIfNoEntry: false });
      if (!entry) break;
      requireValid(!entry.isSymbolicLink() && realpathSync(current) === current
        && (current === path && outputFile ? entry.isFile() : entry.isDirectory()));
    }
  }
  for (const artifact of q.target.artifacts) {
    const root = join(globalRoot, "node_modules", artifact.installName);
    existing(root);
    const path = join(root, "package.json");
    if (lstatSync(path, { throwIfNoEntry: false })) {
      existing(path, true);
      const pkg = manifest(path);
      requireValid(pkg["name"] === artifact.name && typeof pkg["version"] === "string"
        && exactVersion(pkg["version"].replace(/^v(?=\d)/, "")));
      const pin = q.installation.resources.find(row => row.realpath === path);
      // Old versions may differ during an update only when the existing bytes
      // are independently bound by the installation resource snapshot.
      if (pin) file({ path, sha256: pin.fingerprint.replace(/^sha256:/, "") });
      else requireValid(pkg["version"] === artifact.version
        || (artifact.name !== "omo-ai" && artifact.name !== "@code-yeongyu/senpi" && pkg["version"] === `v${artifact.version}`));
    }
  }
  for (const path of contents.expected.keys()) existing(path, true);
  for (const edge of contents.edges) {
    for (const slot of dependencySlots(edge.parent, edge.key)) {
      const candidate = join(globalRoot, "node_modules", slot);
      existing(candidate);
      if (slot === edge.artifact?.installName) break;
      requireValid(!lstatSync(candidate, { throwIfNoEntry: false })
        || q.retiredPackages?.some(retired => candidate === retired.root || candidate.startsWith(`${retired.root}/`)) === true);
    }
  }
}
function verifyOutputs(q: OmoUpdateQualification, contents: Awaited<ReturnType<typeof payload>>): void {
  verifyPreservedLinks(q);
  for (const retired of q.retiredPackages ?? []) requireValid(!lstatSync(retired.root, { throwIfNoEntry: false }));
  const globalRoot = join(roots(q).prefix, "install/global");
  const packageRoot = (artifact: OmoArtifact) => join(globalRoot, "node_modules", artifact.installName);
  for (const [path, sha256] of contents.expected) file({ path, sha256 });
  // Postinstall hash exceptions cannot rewrite package identity or dependency edges.
  for (const artifact of q.target.artifacts) {
    const root = packageRoot(artifact), original = contents.manifests.get(artifact.installName);
    requireValid(realpathSync(root) === root && original !== undefined);
    const actual = manifest(join(root, "package.json"));
    requireValid(actual["name"] === artifact.name && actual["version"] === original["version"]);
    for (const field of dependencyFields) requireValid(isDeepStrictEqual(actual[field], original[field]));
    requireValid(isDeepStrictEqual(actual["peerDependenciesMeta"], original["peerDependenciesMeta"]));
    if (artifact.overlay) requireValid(isDeepStrictEqual(actual["overrides"], original["overrides"]));
  }
  const currentGlobal = configuration(q, true);
  const globalAliases = contents.edges.filter(edge => edge.parent === null && edge.declaration.startsWith("npm:"));
  const currentAliases = currentGlobal.filter(edge => edge.declaration.startsWith("npm:"));
  requireValid(currentAliases.length === globalAliases.length && globalAliases.every(edge =>
    currentAliases.some(current => current.field === edge.field && current.key === edge.key
      && current.declaration === edge.declaration)));
  for (const edge of contents.edges) {
    const parent = q.target.artifacts.find(a => a.installName === edge.parent);
    requireValid(edge.parent === null || parent !== undefined);
    if (edge.artifact === null) {
      for (const slot of dependencySlots(edge.parent, edge.key))
        requireValid(!lstatSync(join(globalRoot, "node_modules", slot), { throwIfNoEntry: false }));
      continue;
    }
    let search = parent ? packageRoot(parent) : globalRoot;
    const expectedRoot = packageRoot(edge.artifact);
    // Inspect dependency search locations without importing or executing packages.
    // Any unqualified nearer entry, including a dangling link, is refused.
    for (;;) {
      const candidate = join(search, "node_modules", edge.key);
      if (lstatSync(candidate, { throwIfNoEntry: false })) {
        requireValid(candidate === expectedRoot && realpathSync(candidate) === candidate
          && realpathSync(join(candidate, "package.json")) === join(candidate, "package.json"));
        break;
      }
      requireValid(search !== globalRoot);
      search = dirname(search);
      if (search.endsWith("/node_modules")) search = dirname(search);
      requireValid(search === globalRoot || search.startsWith(`${globalRoot}/`));
    }
  }
  const binLinks = new Map<string, Set<string>>();
  for (const artifact of q.target.artifacts) {
    const root = packageRoot(artifact), pkg = contents.manifests.get(artifact.installName);
    const bins = pkg?.["bin"], slot = artifact.installName.split("/node_modules/").at(-1);
    requireValid(slot !== undefined);
    const entries = typeof bins === "string" ? [[artifact.name.split("/").at(-1), bins]]
      : typeof bins === "object" && bins !== null ? Object.entries(bins) : [];
    for (const [name, value] of entries) {
      if (typeof name !== "string" || !/^[A-Za-z0-9_@.-]+$/.test(name) || name === "." || name === ".."
        || typeof value !== "string") continue;
      const target = join(root, value);
      if (!target.startsWith(`${root}/`) || !contents.expected.has(target)) continue;
      const path = join(root.slice(0, -slot.length), ".bin", name);
      const targets = binLinks.get(path) ?? new Set<string>();
      targets.add(relative(dirname(path), target));
      binLinks.set(path, targets);
    }
  }
  const pending = [...contents.roots];
  while (pending.length) {
    const dir = pending.pop();
    requireValid(dir !== undefined && realpathSync(dir) === dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        requireValid(binLinks.get(path)?.has(target) === true
          && realpathSync(path) === join(dirname(path), target));
      } else requireValid(entry.isFile() && contents.expected.has(path));
    }
  }
}
/** Task22 invokes this strategy only after its queue/drain/resource gates.
 * The callback owns manager process effects; intent also covers owned registry,
 * cache and lock normalization. Spawn with this exact environment, never ambient
 * merging. A successful observation is not a durable operation receipt.
 */
export async function executeOmoUpdate(spec: UpdateSpec, executor: OmoUpdateExecutor): Promise<AdapterResult<OmoUpdateObservation>> {
  let attempted = false, uncertain = false;
  let server: Bun.Server<undefined> | undefined, cache: string | undefined;
  try {
    const context = spec.execution;
    requireValid(context !== undefined);
    const input = contexts.get(context);
    requireValid(input !== undefined);
    const operation = issued.get(spec);
    requireValid(operation !== undefined && !operation.used && isDeepStrictEqual(operation.snapshot, spec));
    const files = fresh(input, executor.now());
    fresh(input, executor.now());
    requireValid(!dispatchedOperations.has(operation.intent.operationId));
    operation.used = true;
    dispatchedOperations.add(operation.intent.operationId);
    const commandSnapshot = operation.snapshot.command;
    const q = input.qualification, r = roots(q);
    const beforeVersion = q.installation.installedVersion;
    requireValid(beforeVersion.kind === "known");
    const contents = await payload(q, localOverlays.get(input) ?? []);
    verifyDestinations(q, contents);
    verifyReusablePackages(q, contents);
    const api = await official(files);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      try {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const url = new URL(request.url);
      const archive = contents.archives.get(url.pathname);
      if (archive) return new Response(new Uint8Array(archive), { headers: { "Content-Type": "application/octet-stream" } });
      const name = decodeURIComponent(url.pathname.slice(1));
      const artifacts = q.target.artifacts.filter(a => a.name === name);
      if (!artifacts.length) return new Response(null, { status: 404 });
      const versions = Object.fromEntries(artifacts.map(artifact => {
        const pkg = contents.manifests.get(artifact.installName);
        requireValid(pkg !== undefined);
        const archivePin = artifact.overlay?.archive ?? artifact.archive;
        return [artifact.version, { ...pkg, dist: { tarball: `${url.origin}/tarballs/${archivePin.sha256}.tgz`,
          integrity: `sha512-${createHash("sha512").update(contents.archives.get(`/tarballs/${archivePin.sha256}.tgz`) ?? "").digest("base64")}` } }];
      }));
      // Version metadata does not attest a floating npm dist-tag. The exact
      // wrapper target alone has a separately qualified channel selection.
      return Response.json({ name, "dist-tags": name === "omo-ai" ? { [q.target.channel]: q.target.version } : {}, versions });
      } catch { return new Response(null, { status: 400 }); }
    } });
    const home = q.env["HOME"];
    requireValid(home !== undefined);
    cache = mkdtempSync(join(home, ".herdr-update-cache-"));
    const registry = `http://127.0.0.1:${server.port}`;
    const dispatchArgs = [...commandSnapshot.args, "--registry", registry, "--cache-dir", cache,
      ...(q.reuseVerifiedPackages ? [] : ["--force"]), "--linker", "hoisted", "--frozen-lockfile"];
    await executor.event?.({ kind: "intent", intent: operation.intent });
    const exit = await api.runSelfUpdate(["update"], {
      env: Object.freeze({ ...q.env }), log: () => {}, error: () => {},
      readInstalled: () => installed(q),
      fetchDistTags: () => ({ [q.target.channel]: q.target.version }),
      resolveUpdate: target => {
        requireValid(target === q.target.version && exactVersion(target));
        const selected = api.updateTarget(r.wrapper, "darwin", beforeVersion.version, q.env["HOME"] ?? "", () => false, target);
        requireValid(selected.manager === "bun" && isDeepStrictEqual(selected.argv, ["bun", "add", "-g", `omo-ai@${target}`])
          && isDeepStrictEqual(selected.env, { BUN_INSTALL: r.prefix }));
        return { ...selected, argv: [q.manager.path, ...dispatchArgs], command: "private-update" };
      },
      run: async (command, args, options) => {
        fresh(input, executor.now());
        requireValid(command === commandSnapshot.executable && isDeepStrictEqual(args, dispatchArgs)
          && isDeepStrictEqual(options.env, q.env));
        await executor.event?.({ kind: "dispatch", intent: operation.intent });
        // Settle supplied callback access before the final clock/input/path check.
        const run = executor.run;
        fresh(input, executor.now());
        verifyDestinations(q, contents);
        verifyReusablePackages(q, contents);
        const invocation: PrivateUpdateCommand = {
          ...commandSnapshot, args: Object.freeze([...args]), shell: false, inheritEnv: false,
          env: Object.freeze({ ...options.env }),
        };
        Object.defineProperties(invocation, {
          toJSON: { value: () => ({ kind: "private-update-command" }) },
          [Symbol.for("nodejs.util.inspect.custom")]: { value: () => "private-update-command" },
        });
        attempted = true;
        // The qualified physical slots already select every version. Do not let
        // concurrent metadata resolution choose a different hoisted layout.
        const workspace = manifest(join(r.prefix, "install/global/package.json"));
        workspace["dependencies"] = { ...(workspace["dependencies"] as Record<string, string>), "omo-ai": q.target.version };
        delete workspace["trustedDependencies"];
        const packages = Object.fromEntries([...q.target.artifacts].sort((a, b) => a.installName.localeCompare(b.installName)).map(artifact => {
          const pkg = contents.manifests.get(artifact.installName);
          requireValid(pkg !== undefined);
          const metadata = Object.fromEntries(["dependencies", "optionalDependencies", "peerDependencies", "os", "cpu", "bin"]
            .filter(field => pkg[field] !== undefined).map(field => [field, pkg[field]]));
          const peers = pkg["peerDependenciesMeta"];
          if (typeof peers === "object" && peers !== null) {
            const optionalPeers = Object.entries(peers).filter(([, value]) => typeof value === "object"
              && value !== null && "optional" in value && value.optional === true).map(([key]) => key);
            if (optionalPeers.length) metadata["optionalPeers"] = optionalPeers;
          }
          const archive = artifact.overlay?.archive ?? artifact.archive;
          return [artifact.installName.replaceAll("/node_modules/", "/"), [`${artifact.name}@${artifact.version}`,
            `${registry}/tarballs/${archive.sha256}.tgz`, metadata,
            `sha512-${createHash("sha512").update(contents.archives.get(`/tarballs/${archive.sha256}.tgz`) ?? "").digest("base64")}`]];
        }));
        writeFileSync(join(r.prefix, "install/global/bun.lock"), `${JSON.stringify({ lockfileVersion: 1, configVersion: 1,
          workspaces: { "": workspace }, trustedDependencies: manifest(join(r.prefix, "install/global/package.json"))["trustedDependencies"],
          packages }, null, 2)}\n`);
        let result: UpdateChildResult;
        try { result = await run(Object.freeze(invocation)); }
        catch { uncertain = true; throw new ContextFailure(); }
        // Observe identity/config after handoff as well. A callback's metadata is not a receipt.
        uncertain = true;
        file(q.manager);
        file(input.receipt);
        canonicalizeLock(q, registry);
        configuration(q, true);
        const status = result.status, signal = result.signal;
        requireValid((status === null || (Number.isInteger(status) && status >= 0 && status <= 255))
          && (signal === null || typeof signal === "string"));
        await executor.event?.({ kind: "exit", intent: operation.intent, status, signal });
        uncertain = false;
        return signal !== null ? { status: 1, signal } : { status, signal };
      },
    });
    if (uncertain) return { ok: false, error: { code: "recovery_required" } };
    if (exit !== 0) return { ok: false, error: { code: "update_failed" } };
    // All observable hooks have settled. Read the clock before the final checks;
    // do not await or invoke another supplied hook before classifying success.
    // These are post-update inputs/outputs, not the old installation fingerprints.
    const observedAt = executor.now();
    requireValid(Number.isSafeInteger(observedAt) && q.target.checkedAt <= observedAt && observedAt < q.target.expiresAt);
    file(q.manager);
    requireValid((statSync(q.manager.path).mode & 0o111) !== 0);
    file(input.receipt);
    requireValid(realpathSync(home) === home && statSync(home).isDirectory());
    for (const artifact of q.target.artifacts) artifactBytes(artifact);
    configuration(q, true);
    canonicalizeLock(q, registry);
    requireValid(installed(q).omo === q.target.version);
    verifyOutputs(q, contents);
    // Original Bun may retain archive modes with shared write bits. Restrict
    // only authenticated installed outputs before the runtime observes them;
    // preserve executable bits and never change sources or unrelated files.
    const preservedPaths = new Set(q.preservedPackages?.flatMap(group => group.files.map(pin => pin.path)) ?? []);
    for (const [path, sha256] of contents.expected) {
      if (preservedPaths.has(path)) continue;
      const info = lstatSync(path);
      requireValid(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.());
      if ((info.mode & 0o022) !== 0) {
        file({ path, sha256 });
        chmodSync(path, info.mode & 0o755);
        file({ path, sha256 });
      }
    }
    return { ok: true, value: { kind: attempted ? "files-verified" : "already-current", intent: operation.intent, durableReceipt: false } };
  } catch { return attempted ? { ok: false, error: { code: "recovery_required" } } : failure(); }
  finally {
    let cleanupFailed = false;
    try { if (server) await server.stop(true); } catch { cleanupFailed = true; }
    try { if (cache) rmSync(cache, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    if (cleanupFailed) return { ok: false, error: { code: "recovery_required" } };
  }
}
