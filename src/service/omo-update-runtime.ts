import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { createOmoAdapter } from "../adapters/omo";
import { parseAdapterContract } from "../adapters/types";
import type { AdapterContract, AdapterResult, FamilyAdapter, InstallationIdentity } from "../adapters/types";
import { createOmoUpdateSpec, getOmoUpdateIntent, qualifyOmoUpdate } from "../adapters/update-context";
import type { OmoArtifact, OmoLocalOverlay, UpdateFilePin } from "../adapters/update-context";
import type { CatalogObservation, CatalogReaders } from "../catalog";
import { MutationQueue } from "../install/queue";
import { evaluateResourceGate, parseResourcePlan } from "../install/resources";
import type { ResourceObservation, ResourcePlan } from "../install/resources";
import { createCheckRuntime } from "./check-runtime";
import type { CheckSource } from "./check-runtime";
import { createCheckStore } from "./check-store";
import type { UpdateOnlyRunnerConfiguration } from "./job-runner";
import { PluginRuntimeError } from "./plugin-runtime";
import type { PluginRuntimeContext, PluginRuntimeInputs, PluginRuntimeLoad } from "./plugin-runtime";
import { discoverWorker } from "./worker";

// allow: SIZE_OK — the assigned single-module ownership keeps this profile's
// persisted-data parser, source fence and actual census under one boundary.
export const OMO_UPDATE_RUNTIME_PROFILE = "qualified-omo-update-only-v1" as const;
/** Same original-source qualification inputs as the legacy profile, without
 * native authority. rootPids are stable, caller-attested herdr census anchors;
 * registeredSockets excludes this worker's registry-derived socket pair.
 */
export type OmoUpdateRuntimeInputs = Omit<PluginRuntimeInputs, "profile" | "native"> & {
  readonly profile: typeof OMO_UPDATE_RUNTIME_PROFILE;
};
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
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireInput(typeof value === "object" && value !== null && !Array.isArray(value), "configuration");
  const entries = Object.entries(value);
  requireInput(entries.length === keys.length && entries.every(([key]) => keys.includes(key)), "configuration");
  return Object.fromEntries(entries);
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
function list<T>(value: unknown, parse: (value: unknown) => T, limit = 131072): readonly T[] {
  requireInput(Array.isArray(value) && value.length <= limit, "configuration");
  return value.map(parse);
}
function pin(value: unknown): UpdateFilePin {
  const row = object(value, ["path", "sha256"]), sha256 = text(row["sha256"]);
  requireInput(/^[a-f0-9]{64}$/.test(sha256), "configuration");
  return { path: path(row["path"]), sha256 };
}
function installation(value: unknown): InstallationIdentity {
  const parsed = parseAdapterContract({ version: 1, family: "omo", installation: value, runtime: null,
    capabilities: { check: unsupported, update: unsupported, busySafe: unsupported,
      completion: unsupported, resume: unsupported, gracefulExit: unsupported } });
  requireInput(parsed.ok && parsed.value.installation.owner.kind === "wrapper", "configuration");
  return parsed.value.installation;
}
function overlay(value: unknown): OmoLocalOverlay {
  const row = object(value, ["kind", "archive", "localDist", "sourceBinding", "originalBuildCommands", "files"]);
  requireInput(row["kind"] === "local-source-overlay", "configuration");
  const dist = object(row["localDist"], ["integrity", "tarballPath"]);
  return { kind: "local-source-overlay", archive: pin(row["archive"]), sourceBinding: pin(row["sourceBinding"]),
    localDist: { integrity: text(dist["integrity"]), tarballPath: text(dist["tarballPath"]) },
    originalBuildCommands: list(row["originalBuildCommands"], text), files: list(row["files"], value => {
      const file = object(value, ["relativePath", "source"]);
      return { relativePath: text(file["relativePath"]), source: pin(file["source"]) };
    }) };
}
/** Data only; no qualification timestamps, receipt or authority are minted. */
export function validateOmoUpdateRuntimeInputs(value: unknown): OmoUpdateRuntimeInputs {
  requireInput(dataOnly(value), "configuration");
  const row = object(structuredClone(value), ["schemaVersion", "profile", "ownerDirectory", "update", "overlays", "provenance",
    "expectedAfterPin", "independentTargetPins", "sourcePins", "acquiredReplies", "coverage"]);
  requireInput(row["schemaVersion"] === 1 && row["profile"] === OMO_UPDATE_RUNTIME_PROFILE, "profile");
  const update = object(row["update"], ["qualification", "receipt"]);
  const withLinks = typeof update["qualification"] === "object" && update["qualification"] !== null
    && Object.hasOwn(update["qualification"], "preservedLinks");
  const withPeers = typeof update["qualification"] === "object" && update["qualification"] !== null
    && Object.hasOwn(update["qualification"], "preservedPeers");
  const withReuse = typeof update["qualification"] === "object" && update["qualification"] !== null
    && Object.hasOwn(update["qualification"], "reuseVerifiedPackages");
  const withPreserved = typeof update["qualification"] === "object" && update["qualification"] !== null
    && Object.hasOwn(update["qualification"], "preservedPackages");
  const withRetired = typeof update["qualification"] === "object" && update["qualification"] !== null
    && Object.hasOwn(update["qualification"], "retiredPackages");
  const q = object(update["qualification"], ["installation", "manager", "env", "target",
    ...(withLinks ? ["preservedLinks"] : []), ...(withPeers ? ["preservedPeers"] : []),
    ...(withReuse ? ["reuseVerifiedPackages"] : []), ...(withPreserved ? ["preservedPackages"] : []),
    ...(withRetired ? ["retiredPackages"] : [])]);
  requireInput(!withReuse || q["reuseVerifiedPackages"] === true, "configuration");
  const managerHasNode = typeof q["manager"] === "object" && q["manager"] !== null && Object.hasOwn(q["manager"], "node");
  const manager = object(q["manager"], ["name", "path", "sha256", ...(managerHasNode ? ["node"] : [])]);
  const env = object(q["env"], ["BUN_INSTALL", "HOME", "PATH"]);
  const target = object(q["target"], ["packageName", "version", "channel", "checkedAt", "expiresAt", "artifacts", "postinstall"]);
  requireInput(manager["name"] === "bun" && target["packageName"] === "omo-ai"
    && target["channel"] === "latest", "profile");
  const coverage = object(row["coverage"], ["root", "prefix", "socketDirectory", "registeredSockets", "rootPids"]);
  return { schemaVersion: 1, profile: OMO_UPDATE_RUNTIME_PROFILE, ownerDirectory: path(row["ownerDirectory"]),
    update: { receipt: pin(update["receipt"]), qualification: {
      ...(withReuse ? { reuseVerifiedPackages: true as const } : {}),
      ...(withPreserved ? { preservedPackages: list(q["preservedPackages"], value => {
        const group = object(value, ["root", "files"]);
        return { root: path(group["root"]), files: list(group["files"], pin) };
      }) } : {}),
      ...(withRetired ? { retiredPackages: list(q["retiredPackages"], value => {
        const group = object(value, ["root", "files"]);
        return { root: path(group["root"]), files: list(group["files"], pin) };
      }) } : {}),
      ...(withLinks ? { preservedLinks: list(q["preservedLinks"], value => {
        const link = object(value, ["path", "target"]);
        return { path: path(link["path"]), target: path(link["target"]) };
      }, 128) } : {}),
      ...(withPeers ? { preservedPeers: list(q["preservedPeers"], value => {
        const peer = object(value, ["parent", "dependency", "key"]);
        return { parent: pin(peer["parent"]), dependency: pin(peer["dependency"]), key: text(peer["key"]) };
      }, 128) } : {}),
      installation: installation(q["installation"]), manager: { name: "bun", ...pin({ path: manager["path"], sha256: manager["sha256"] }),
        ...(managerHasNode ? { node: pin(manager["node"]) } : {}) },
      env: { BUN_INSTALL: path(env["BUN_INSTALL"]), HOME: path(env["HOME"]), PATH: path(env["PATH"]) },
      target: { packageName: "omo-ai", version: text(target["version"]), channel: "latest",
        checkedAt: integer(target["checkedAt"]), expiresAt: integer(target["expiresAt"]),
        artifacts: list(target["artifacts"], value => {
          const hasOverlay = typeof value === "object" && value !== null && Object.hasOwn(value, "overlay");
          const a = object(value, ["name", "installName", "version", "archive", "metadata", ...(hasOverlay ? ["overlay"] : [])]);
          return { name: text(a["name"]), installName: text(a["installName"]), version: text(a["version"]),
            archive: pin(a["archive"]), metadata: pin(a["metadata"]),
            ...(hasOverlay ? { overlay: overlay(a["overlay"]) } : {}) } satisfies OmoArtifact;
        }), postinstall: list(target["postinstall"], pin) } } },
    overlays: list(row["overlays"], value => {
      const grant = object(value, ["vendorArchive", "vendorMetadata", "overlay"]);
      return { vendorArchive: pin(grant["vendorArchive"]), vendorMetadata: pin(grant["vendorMetadata"]), overlay: overlay(grant["overlay"]) };
    }), provenance: list(row["provenance"], pin), expectedAfterPin: pin(row["expectedAfterPin"]),
    independentTargetPins: list(row["independentTargetPins"], pin), sourcePins: list(row["sourcePins"], pin),
    acquiredReplies: list(row["acquiredReplies"], value => {
      const reply = object(value, ["url", "status", "body"]);
      requireInput(reply["status"] === 200, "configuration");
      return { url: text(reply["url"]), status: 200, body: pin(reply["body"]) };
    }),
    coverage: { root: path(coverage["root"]), prefix: path(coverage["prefix"]), socketDirectory: path(coverage["socketDirectory"]),
      registeredSockets: list(coverage["registeredSockets"], path), rootPids: list(coverage["rootPids"], integer) } };
}
function privateDirectory(value: string): void {
  const info = lstatSync(value);
  requireInput(realpathSync(value) === value && info.isDirectory()
    && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700, "configuration");
}
function bytes(reference: UpdateFilePin): Buffer {
  const before = lstatSync(reference.path);
  requireInput(realpathSync(reference.path) === reference.path && before.isFile() && before.nlink === 1
    && before.uid === process.getuid?.() && (before.mode & 0o022) === 0 && before.size <= 256 * 1024 * 1024);
  const body = readFileSync(reference.path), after = lstatSync(reference.path);
  requireInput(before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
    && realpathSync(reference.path) === reference.path && hash(body) === reference.sha256);
  return body;
}
function observeInstalled(template: InstallationIdentity): InstallationIdentity {
  requireInput(template.owner.kind === "wrapper");
  const resources = template.resources.map(row => {
    const info = lstatSync(row.realpath);
    requireInput(realpathSync(row.realpath) === row.realpath && info.isFile() && info.nlink === 1
      && info.uid === process.getuid?.() && (info.mode & 0o022) === 0 && info.size <= 256 * 1024 * 1024);
    return { ...row, fingerprint: `sha256:${hash(readFileSync(row.realpath))}` };
  });
  const modules = join(template.owner.prefix, "install/global/node_modules");
  const wrapper: unknown = JSON.parse(readFileSync(join(modules, "omo-ai/package.json"), "utf8"));
  const engine: unknown = JSON.parse(readFileSync(join(modules, "@code-yeongyu/senpi/package.json"), "utf8"));
  requireInput(typeof wrapper === "object" && wrapper !== null && "name" in wrapper && wrapper.name === "omo-ai"
    && "version" in wrapper && typeof wrapper.version === "string" && "dependencies" in wrapper
    && typeof wrapper.dependencies === "object" && wrapper.dependencies !== null && "@code-yeongyu/senpi" in wrapper.dependencies
    && typeof engine === "object" && engine !== null && "name" in engine && engine.name === "@code-yeongyu/senpi"
    && "version" in engine && wrapper.dependencies["@code-yeongyu/senpi"] === engine.version);
  return { ...template, installedVersion: { kind: "known", version: wrapper.version },
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
}
const censusOptions = { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 } as const;
function processes() {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,uid=,lstart="], censusOptions).trim().split("\n").map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    requireInput(m !== null && m[1] !== undefined && m[2] !== undefined && m[3] !== undefined && m[4] !== undefined);
    return { pid: Number(m[1]), parent: Number(m[2]), uid: Number(m[3]), start: m[4] };
  });
}
function coverageRoots(input: OmoUpdateRuntimeInputs) {
  const c = input.coverage, owner = input.update.qualification.installation.owner;
  privateDirectory(c.root); privateDirectory(c.socketDirectory);
  const prefix = lstatSync(c.prefix);
  requireInput(prefix.isDirectory() && prefix.uid === process.getuid?.() && (prefix.mode & 0o022) === 0
    && realpathSync(c.prefix) === c.prefix && owner.kind === "wrapper" && owner.prefix === c.prefix
    && input.update.qualification.env["BUN_INSTALL"] === c.prefix
    && input.update.qualification.env["HOME"]?.startsWith(`${c.root}/`) === true
    && !input.update.qualification.env["HOME"]?.startsWith(`${c.prefix}/`)
    && c.rootPids.length > 0 && new Set(c.rootPids).size === c.rootPids.length
    && new Set(c.registeredSockets).size === c.registeredSockets.length
    && c.registeredSockets.every(socket => socket.startsWith(`${c.socketDirectory}/`)));
  const census = processes();
  return c.rootPids.map(pid => {
    const row = census.find(row => row.pid === pid);
    requireInput(row !== undefined && pid > 1 && row.uid === process.getuid?.());
    return row;
  });
}
function observeResources(plan: ResourcePlan, input: OmoUpdateRuntimeInputs, roots: ReturnType<typeof coverageRoots>): ResourceObservation {
  const c = input.coverage;
  requireInput(isDeepStrictEqual(coverageRoots(input), roots)
    && isDeepStrictEqual(plan.contract.installation, input.update.qualification.installation)
    && plan.mode === "update-only" && plan.selectedTargets.length === 0
    && isDeepStrictEqual(plan.mutationResources, plan.contract.installation.resources));
  const owner = discoverWorker(input.ownerDirectory);
  requireInput(owner.pid === process.pid && owner.executableRealpath === realpathSync(process.execPath));
  const control = lstatSync(owner.controlPath).isSymbolicLink()
    ? resolve(input.ownerDirectory, readlinkSync(owner.controlPath)) : owner.controlPath;
  requireInput(control === owner.controlPath || control === join(input.ownerDirectory, `c${owner.incarnation.slice(0, 8)}`));
  const registered = [...c.registeredSockets, owner.socketPath, control];
  requireInput(new Set(registered).size === registered.length
    && registered.every(socket => socket.startsWith(`${c.socketDirectory}/`)));
  const before = processes(), known = new Set([...roots.map(row => row.pid), owner.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of before) if (known.has(row.parent) && !known.has(row.pid)) { known.add(row.pid); changed = true; }
  }
  // The audited Bun command changes global packages and launchers. Its cache
  // is explicitly redirected to private HOME, not BUN_INSTALL/install/cache.
  // Keep lsof's inode-based selection (including external hardlink readers),
  // but do not recursively enumerate unrelated, potentially huge Bun caches.
  const mutationRoots = [join(c.prefix, "install/global"), join(c.prefix, "bin")];
  const existingRoots = mutationRoots.filter(path => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return false;
    requireInput(info.isDirectory() && realpathSync(path) === path);
    return true;
  });
  requireInput(existingRoots.includes(join(c.prefix, "install/global")));
  let output: string, complete = true;
  try { output = execFileSync("/usr/sbin/lsof", ["-n", "-P", "-Fpn",
    ...existingRoots.flatMap(path => ["+D", path])], censusOptions); }
  catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1
      && "stdout" in error && typeof error.stdout === "string" && "stderr" in error && error.stderr === "") {
      output = error.stdout; complete = output === "";
    } else throw error;
  }
  const seen = [...new Set(output.split("\n").filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
  const sockets: string[] = [], pending = [c.socketDirectory];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    requireInput(realpathSync(dir) === dir);
    for (const name of readdirSync(dir)) {
      const entry = join(dir, name), info = lstatSync(entry);
      if (entry === owner.controlPath && info.isSymbolicLink()) {
        requireInput(info.uid === process.getuid?.() && resolve(dir, readlinkSync(entry)) === control);
        continue;
      }
      requireInput(!info.isSymbolicLink() && info.uid === process.getuid?.());
      if (info.isDirectory()) pending.push(entry);
      else if (info.isSocket()) sockets.push(entry);
    }
  }
  const after = processes();
  const incarnation = (pid: number) => {
    const a = before.find(row => row.pid === pid), b = after.find(row => row.pid === pid);
    return a !== undefined && isDeepStrictEqual(a, b) ? a : undefined;
  };
  return { installation: observeInstalled(plan.contract.installation), installerDigest: plan.installerDigest,
    mutationResources: plan.mutationResources,
    allSocketsKnown: isDeepStrictEqual([...sockets].sort(), [...registered].sort())
      && isDeepStrictEqual(discoverWorker(input.ownerDirectory), owner),
    outsideConsumersKnown: complete && roots.every(row => isDeepStrictEqual(incarnation(row.pid), row))
      && seen.every(pid => known.has(pid) && incarnation(pid)?.uid === process.getuid?.()),
    consumers: seen.map(pid => ({ consumerId: `${pid}:${hash(incarnation(pid)?.start ?? "unknown")}`, binding: null,
      resources: plan.mutationResources, state: incarnation(pid) ? "running" as const : "unknown" as const })), busySafety: null };
}

/** Original qualification and consumer boundaries only; no native lifecycle. */
export async function loadOmoUpdateRuntime(context: PluginRuntimeContext, configurationPin: UpdateFilePin,
  value: unknown): Promise<PluginRuntimeLoad> {
  try {
    const input = validateOmoUpdateRuntimeInputs(value), config = pin(configurationPin);
    if (process.platform !== "darwin") return { kind: "unsupported", reason: "platform" };
    privateDirectory(dirname(config.path)); privateDirectory(context.directory);
    requireInput((lstatSync(config.path).mode & 0o777) === 0o600 && input.ownerDirectory === context.directory
      && isDeepStrictEqual(JSON.parse(bytes(config).toString("utf8")), input), "configuration");
    const q = input.update.qualification, before = q.installation;
    const after = installation(JSON.parse(bytes(input.expectedAfterPin).toString("utf8")));
    requireInput(before.owner.kind === "wrapper" && before.installedVersion.kind === "known"
      && after.installationId === before.installationId && after.executableRealpath === before.executableRealpath
      && after.channel === before.channel && isDeepStrictEqual(after.owner, before.owner)
      && after.installedVersion.kind === "known" && after.installedVersion.version === q.target.version
      && after.resourcesFingerprint === `sha256:${hash(JSON.stringify(after.resources))}`
      && isDeepStrictEqual(after.resources.map(r => [r.resourceId, r.realpath]), before.resources.map(r => [r.resourceId, r.realpath])));
    const independent = new Set(input.independentTargetPins.map(pin => JSON.stringify([pin.path, pin.sha256])));
    for (const reference of [...q.target.postinstall, ...after.resources.map(r => ({ path: r.realpath, sha256: r.fingerprint.slice(7) }))])
      requireInput(independent.has(JSON.stringify([reference.path, reference.sha256])));
    const readPins = [config, input.update.receipt, input.expectedAfterPin, ...input.sourcePins,
      ...input.provenance, ...input.acquiredReplies.map(row => row.body)];
    const sourcePins = [...readPins, q.manager, ...(q.manager.node ? [q.manager.node] : []), ...q.target.artifacts.flatMap(a => [a.archive, a.metadata,
      ...(a.overlay ? [a.overlay.archive, a.overlay.sourceBinding, ...a.overlay.files.map(f => f.source)] : [])])];
    const readFence = () => {
      for (const reference of readPins) bytes(reference);
      for (const link of q.preservedLinks ?? []) {
        const info = lstatSync(link.path);
        requireInput(info.isSymbolicLink() && info.uid === process.getuid?.()
          && info.nlink === 1 && readlinkSync(link.path) === link.target);
      }
    };
    const fence = () => { readFence(); for (const reference of sourcePins) bytes(reference); };
    fence();
    requireInput(input.provenance.length === 1 && isDeepStrictEqual(JSON.parse(bytes(input.update.receipt).toString("utf8")), q));
    // These are the existing source-qualified 5.1.19 modules, not installed
    // code or an observed shim promoted into a new baseline.
    const shimSources = {
      "bun-bin-shim.js": "f5278e37090e46183d11e7816d79747510bb5de76a7851f555e8e3bf198827f7",
      "bun-runtime.js": "c32f583bbfc5735157f092f43c8009d60301e8ec9fa5432032333afcc841a86e",
      "child-process.js": "2dc0b5cd1d9c01bc85d230b178b238004908d8e3d933de307453312e0479d0ae",
    } as const;
    const afterStates = [after];
    const generatedShimHashes = new Map<string, ReadonlySet<string>>();
    const generatedBunAliases = new Map<string, string>();
    const officialFiles: Record<string, string> = {};
    for (const [name, digest] of Object.entries(shimSources)) {
      const reference = input.sourcePins.find(row => row.sha256 === digest);
      if (reference) officialFiles[`/official/${name}`] = bytes(reference).toString("utf8");
    }
    if (Object.keys(officialFiles).length === 3) {
      const build = await Bun.build({ entrypoints: ["/official/entry.js"], target: "bun", files: {
        ...officialFiles, "/official/entry.js": 'export {bunBinShimScript} from "./bun-bin-shim.js";',
      } });
      requireInput(build.success && build.outputs.length === 1 && build.outputs[0] !== undefined);
      const generator: { readonly bunBinShimScript: (entry: string, bun: string) => string } =
        await import(`data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString("base64")}`);
      const shimPaths = [join(input.coverage.prefix, "bin/omo"),
        join(input.coverage.prefix, "install/global/node_modules/.bin/omo")];
      const baselineBuns = [...new Set([q.manager.path, join(input.coverage.prefix, "bin/bun"), Bun.which("bun")])]
        .filter((bun): bun is string => bun !== null && lstatSync(bun, { throwIfNoEntry: false }) !== undefined
          && realpathSync(bun) === q.manager.path);
      const baselineHashes = new Set(baselineBuns.map(bun => {
        const digest = hash(generator.bunBinShimScript(after.executableRealpath, bun));
        generatedBunAliases.set(digest, bun);
        return digest;
      }));
      const shimPins = q.target.postinstall.filter(row => shimPaths.includes(row.path) && baselineHashes.has(row.sha256));
      requireInput(shimPins.some(row => row.path === shimPaths[0]));
      for (const shim of shimPins) {
        generatedShimHashes.set(shim.path, baselineHashes);
        // Each official bin is repaired independently; neither can exempt the
        // other from its own exact hash and filesystem guards.
        for (const state of [...afterStates]) {
          for (const digest of baselineHashes) {
            const resources = state.resources.map(row => row.realpath === shim.path
              ? { ...row, fingerprint: `sha256:${digest}` } : row);
            afterStates.push({ ...after, resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` });
          }
        }
      }
    }
    const roots = coverageRoots(input), targetVersion = q.target.version;
    const observeAfter = (verifyPayload = true) => {
      if (verifyPayload) fence(); else readFence();
      const current = observeInstalled(after);
      requireInput(afterStates.some(state => isDeepStrictEqual(current, state)));
      let regenerated = !isDeepStrictEqual(current, after);
      for (const reference of q.target.postinstall) {
        const allowed = generatedShimHashes.get(reference.path);
        if (allowed) {
          const digest = hash(readFileSync(reference.path));
          requireInput(allowed.has(digest));
          const bun = generatedBunAliases.get(digest);
          requireInput(bun !== undefined && realpathSync(bun) === q.manager.path);
          bytes({ path: reference.path, sha256: digest });
          regenerated ||= digest !== reference.sha256;
        } else bytes(reference);
      }
      if (regenerated) {
        for (const [name, sha256] of Object.entries(shimSources))
          bytes({ path: join(input.coverage.prefix, "install/global/node_modules/omo-ai/bin/lib", name), sha256 });
      }
      return current;
    };
    const wrapper = join(input.coverage.prefix, "install/global/node_modules/omo-ai/package.json");
    const engine = join(input.coverage.prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json");
    const supported = { kind: "supported", reason: "verified", evidenceRef: input.update.receipt.path } as const;
    const contract: AdapterContract = { version: 1, family: "omo", installation: before, runtime: null,
      capabilities: { check: supported, update: supported, busySafe: unsupported,
        completion: unsupported, resume: unsupported, gracefulExit: unsupported } };
    const profiles: NonNullable<UpdateOnlyRunnerConfiguration["profile"]>[] = [];
    const isBefore = isDeepStrictEqual(observeInstalled(before), before);
    const reply = (url: string): Buffer => {
      readFence();
      const rows = input.acquiredReplies.filter(row => row.url === url);
      requireInput(rows.length === 1 && rows[0] !== undefined);
      return bytes(rows[0].body);
    };
    const source = (identity: InstallationIdentity): CheckSource => ({ installation: identity,
      pins: identity.resources.map(r => ({ path: r.realpath, sha256: r.fingerprint.slice(7), mode: lstatSync(r.realpath).mode & 0o7777 })),
      aliases: [], packageManifest: wrapper, engineManifest: engine });
    const beforeSource = source(before);
    let updateAvailable = () => false;
    const checker = createCheckRuntime({ omoTargetVersion: targetVersion, store: createCheckStore(context.directory),
      admit: async candidate => {
        try {
          readFence();
          if (isDeepStrictEqual(candidate, beforeSource) && isDeepStrictEqual(observeInstalled(before), before))
            return { ok: true, value: null };
          if (isDeepStrictEqual(candidate, source(observeAfter()))) return { ok: true, value: null };
          return failed();
        } catch { return failed(); }
      }, request: async request => {
        request.signal.throwIfAborted(); requireInput(request.method === "GET");
        return new Response(reply(request.url), { headers: { "content-type": "application/json" } });
      } });
    const afterChecker = createCheckRuntime({ store: createCheckStore(context.directory),
      admit: async candidate => {
        try {
          readFence();
          return isDeepStrictEqual(candidate, source(observeAfter(false))) ? { ok: true, value: null } : failed();
        } catch { return failed(); }
      } });
    if (isBefore) {
      const qualified = await qualifyOmoUpdate(input.update, Date.now(), input.overlays);
      fence(); requireInput(qualified.ok, "qualification");
      const issued = createOmoUpdateSpec(qualified.value, "update-only", Date.now());
      requireInput(issued.ok, "qualification");
      const intent = getOmoUpdateIntent(issued.value);
      requireInput(intent.ok, "qualification");
      const plan = parseResourcePlan({ contract, mode: "update-only", selectedTargets: [],
        mutationResources: before.resources, installerDigest: hash(JSON.stringify({ command: issued.value.command, intent: intent.value })) });
      requireInput(plan.ok, "qualification");
      const omo = createOmoAdapter({ provenance: input.provenance, wrapperManifest: wrapper, engineManifest: engine,
        targetVersion, release: async channel => {
          requireInput(channel === targetVersion);
          return JSON.parse(reply(`https://registry.npmjs.org/omo-ai/${targetVersion}`).toString("utf8"));
        }, runtime: () => null, core: () => null,
        updateAuthority: { now: Date.now, read: selection => {
          fence();
          if (selection.mode !== "update-only" || !isDeepStrictEqual(selection.installation, before)
            || selection.check.availableVersion !== targetVersion) return null;
          return { context: qualified.value, intent: intent.value };
        } } });
      const adapter: FamilyAdapter = { ...omo,
        detect: async executable => {
          try { fence(); return executable === before.executableRealpath && isDeepStrictEqual(observeInstalled(before), before)
            ? { ok: true, value: before } : failed(); } catch { return failed(); }
        },
        check: async identity => {
          if (!isDeepStrictEqual(identity, before)) return failed();
          const result = await checker.check(beforeSource);
          fence();
          return result;
        },
        updateSpec: (identity, mode) => {
        if (mode !== "update-only") return { ok: false, error: { code: "unsupported" } };
        try {
          fence();
          if (!isDeepStrictEqual(identity, before) || !isDeepStrictEqual(observeInstalled(before), before)) return failed();
          // This profile owns an exact prepared filesystem identity, not the
          // native adapter's additional canonical discovery resource.
          const spec = createOmoUpdateSpec(qualified.value, "update-only", Date.now());
          if (!spec.ok) return spec;
          const observed = observeResources(plan.value, input, roots);
          // A positive live observation is a definite blocker even when Darwin
          // reports partial coverage. It never makes partial coverage admissible.
          if (observed.consumers.some(row => row.state !== "exited"))
            return { ok: false, error: { code: "resources_busy" } };
          const gate = evaluateResourceGate(plan.value, observed);
          return gate.ok ? spec : gate;
        } catch { return failed(); }
      } };
      const detected = await adapter.detect(before.executableRealpath);
      fence(); requireInput(detected.ok && isDeepStrictEqual(detected.value, before));
      const checked = await adapter.check(before);
      fence(); requireInput(checked.ok && checked.value.kind === "update-available" && checked.value.availableVersion === targetVersion);
      updateAvailable = () => adapter.updateSpec(before, "update-only").ok;
      profiles.push({ adapter, contract, sourcePins,
        catalogRoots: [join(input.coverage.prefix, "install/global"), join(input.coverage.prefix, "bin")],
        expectedAfter: after, expectedAfterPin: input.expectedAfterPin,
        observe: plan => { fence(); return observeResources(plan, input, roots); }, observeAfter });
    } else observeAfter();
    const readInstalled = async (): Promise<AdapterResult<CatalogObservation>> => {
      try {
        readFence();
        if (isBefore && isDeepStrictEqual(observeInstalled(before), before)) {
          const last = await checker.lastCheck(beforeSource);
          return last.ok ? { ok: true, value: { contract: { ...contract,
            capabilities: { ...contract.capabilities, update: updateAvailable() ? supported : unsupported } }, lastCheck: last.value } } : last;
        }
        const current = observeAfter(false);
        const last = await afterChecker.lastCheck(source(current));
        return last.ok ? { ok: true, value: { contract: { ...contract, installation: current,
          capabilities: { ...contract.capabilities, update: unsupported } }, lastCheck: last.value } } : last;
      } catch { return failed(); }
    };
    const readers: CatalogReaders = { candidates: [{ candidateId: `installed:${before.installationId}`,
      family: "omo", installationId: before.installationId, read: readInstalled }],
      sockets: [], check: (identity, signal) => {
        if (isBefore && isDeepStrictEqual(identity, before)) return checker.check(beforeSource, signal);
        try {
          const current = observeAfter(false);
          if (isDeepStrictEqual(identity, current)) return afterChecker.check(source(current), signal);
        } catch { return Promise.resolve(failed()); }
        return Promise.resolve(failed());
      } };
    let queue: MutationQueue | undefined;
    return { kind: "configured", readers, runner: { get queue() {
      return queue ??= new MutationQueue(`${context.directory}-mutations`);
    }, receiptRoot: context.directory, profiles } };
  } catch (error) {
    return { kind: "unsupported", reason: error instanceof PluginRuntimeError ? error.reason : "configuration" };
  }
}
