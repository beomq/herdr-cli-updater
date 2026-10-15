import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { createOmoAdapter } from "../adapters/omo";
import { parseAdapterContract } from "../adapters/types";
import type { AdapterContract, AdapterResult, InstallationIdentity } from "../adapters/types";
import { createOmoUpdateSpec, getOmoUpdateIntent, qualifyOmoUpdate } from "../adapters/update-context";
import type { OmoArtifact, OmoLocalOverlay, OmoLocalOverlayGrant, OmoUpdateInput, UpdateFilePin } from "../adapters/update-context";
import { CoreOperationsClient, createRestartLifecyclePort, OperationFailure, parseRestart } from "../core/client";
import type { CoreIdentity, RestartBinding } from "../core/client";
import type { CatalogObservation, CatalogReaders } from "../catalog";
import { discoverExecutable } from "../discovery";
import { MutationQueue } from "../install/queue";
import type { ResourceObservation, ResourcePlan } from "../install/resources";
import type { RuntimeBinding } from "../protocol";
import { createCheckRuntime } from "./check-runtime";
import type { CheckSource } from "./check-runtime";
import { createCheckStore } from "./check-store";
import type { UpdateOnlyRunnerConfiguration } from "./job-runner";
import { loadPackageRuntime, PACKAGE_OPERATING_RUNTIME_PROFILE, PACKAGE_RUNTIME_PROFILE, validatePackageRuntimeInputs } from "./package-runtime";
import { loadNativeUpdateRuntime, NATIVE_UPDATE_RUNTIME_PROFILE, validateNativeUpdateRuntimeInputs } from "./native-update-runtime";
import { loadOmoUpdateRuntime, OMO_UPDATE_RUNTIME_PROFILE, validateOmoUpdateRuntimeInputs } from "./omo-update-runtime";
import { createRestartSource, loadRestartRuntime, RESTART_RUNTIME_PROFILE, validateRestartRuntimeInputs } from "./restart-runtime";

// allow: SIZE_OK — the requested two-file ownership keeps the one private product
// composition and its data boundary together; no new authority/helper module.
export const PLUGIN_RUNTIME_PROFILE = "omo-5.1.9-to-5.1.10-native-abi4" as const;
export const QUALIFIED_PLUGIN_RUNTIME_PROFILE = "omo-qualified-native-abi4" as const;
/** Explicit qualified local profile, NOT support for arbitrary OmO or stock herdr.
 * Pins are independently acquired inputs. No port, module, command or callback
 * can be selected by configuration. Qualification expiry is never refreshed here.
 */
export type PluginRuntimeInputs = {
  readonly schemaVersion: 1;
  readonly profile: typeof PLUGIN_RUNTIME_PROFILE | typeof QUALIFIED_PLUGIN_RUNTIME_PROFILE;
  readonly ownerDirectory: string;
  readonly update: OmoUpdateInput;
  readonly overlays: readonly OmoLocalOverlayGrant[];
  readonly provenance: readonly UpdateFilePin[];
  readonly expectedAfterPin: UpdateFilePin;
  readonly independentTargetPins: readonly UpdateFilePin[];
  readonly sourcePins: readonly UpdateFilePin[];
  readonly acquiredReplies: readonly { readonly url: string; readonly status: 200; readonly body: UpdateFilePin }[];
  readonly native: {
    readonly coreSocket: string;
    readonly coreIdentity: CoreIdentity;
    readonly operationsPath: string;
    readonly runtimeId: string;
    readonly profile: string;
    readonly sessionPath: string;
    readonly sourceBinding: UpdateFilePin;
    readonly node: UpdateFilePin;
    readonly expectedBinding: RestartBinding;
  };
  readonly coverage: {
    readonly root: string;
    readonly prefix: string;
    readonly socketDirectory: string;
    readonly registeredSockets: readonly string[];
    readonly rootPids: readonly number[];
  };
};
export type PluginRuntimeContext = { readonly directory: string; readonly coreSocket: string };
export type PluginRuntimeCandidate = Omit<PluginRuntimeInputs, "update" | "native"> & {
  readonly update: Pick<OmoUpdateInput, "qualification">;
  readonly native: Omit<PluginRuntimeInputs["native"], "expectedBinding"> & { readonly paneId: string };
};
export type PluginRuntimeLoad =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "unsupported"; readonly reason: "profile" | "platform" | "configuration" | "inputs" | "qualification" | "native" }
  | { readonly kind: "configured"; readonly readers: CatalogReaders;
      readonly runner: Omit<UpdateOnlyRunnerConfiguration, "store" | "owner" | "publication"> };
export class PluginRuntimeError extends Error {
  constructor(readonly reason: Extract<PluginRuntimeLoad, { readonly kind: "unsupported" }>["reason"]) {
    super(reason); this.name = "PluginRuntimeError";
  }
}
export const RUNTIME_SET_PROFILE = "qualified-runtime-set-v1";
const unknown = { kind: "unknown", reason: "not_verified" } as const;
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
function requireInput(value: boolean, reason: PluginRuntimeError["reason"] = "inputs"): asserts value {
  if (!value) throw new PluginRuntimeError(reason);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireInput(typeof value === "object" && value !== null && !Array.isArray(value), "configuration");
  const entries = Object.entries(value);
  requireInput(entries.length === keys.length && entries.every(([key]) => keys.includes(key)), "configuration");
  return Object.fromEntries(entries);
}
function text(value: unknown): string {
  requireInput(typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value), "configuration");
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
  const row = object(value, ["path", "sha256"]), digest = text(row["sha256"]);
  requireInput(/^[a-f0-9]{64}$/.test(digest), "configuration");
  return { path: path(row["path"]), sha256: digest };
}
function installation(value: unknown): InstallationIdentity {
  const parsed = parseAdapterContract({ version: 1, family: "omo", installation: value, runtime: null,
    capabilities: { check: unknown, update: unknown, busySafe: unknown, completion: unknown, resume: unknown, gracefulExit: unknown } });
  requireInput(parsed.ok, "configuration");
  return parsed.value.installation;
}
function overlay(value: unknown): OmoLocalOverlay {
  const row = object(value, ["kind", "archive", "localDist", "sourceBinding", "originalBuildCommands", "files"]);
  requireInput(row["kind"] === "local-source-overlay", "configuration");
  const dist = object(row["localDist"], ["integrity", "tarballPath"]);
  return { kind: "local-source-overlay", archive: pin(row["archive"]), sourceBinding: pin(row["sourceBinding"]),
    localDist: { integrity: text(dist["integrity"]), tarballPath: text(dist["tarballPath"]) },
    originalBuildCommands: list(row["originalBuildCommands"], text),
    files: list(row["files"], value => {
      const file = object(value, ["relativePath", "source"]);
      return { relativePath: text(file["relativePath"]), source: pin(file["source"]) };
    }, 131072) };
}
function parseInputs(value: unknown): PluginRuntimeInputs {
  const row = object(value, ["schemaVersion", "profile", "ownerDirectory", "update", "overlays", "provenance",
    "expectedAfterPin", "independentTargetPins", "sourcePins", "acquiredReplies", "native", "coverage"]);
  const profile = row["profile"];
  requireInput(row["schemaVersion"] === 1
    && (profile === PLUGIN_RUNTIME_PROFILE || profile === QUALIFIED_PLUGIN_RUNTIME_PROFILE), "profile");
  const update = object(row["update"], ["qualification", "receipt"]);
  const q = object(update["qualification"], ["installation", "manager", "env", "target"]);
  const hasNode = typeof q["manager"] === "object" && q["manager"] !== null && Object.hasOwn(q["manager"], "node");
  const manager = object(q["manager"], ["name", "path", "sha256", ...(hasNode ? ["node"] : [])]);
  const env = object(q["env"], ["BUN_INSTALL", "HOME", "PATH"]);
  const target = object(q["target"], ["packageName", "version", "channel", "checkedAt", "expiresAt", "artifacts", "postinstall"]);
  requireInput(manager["name"] === "bun" && target["packageName"] === "omo-ai"
    && target["channel"] === "latest", "profile");
  const native = object(row["native"], ["coreSocket", "coreIdentity", "operationsPath", "runtimeId", "profile", "sessionPath",
    "sourceBinding", "node", "expectedBinding"]);
  const identity = object(native["coreIdentity"], ["version", "protocol", "schemaSha256"]);
  const binding = parseRestart({ binding: native["expectedBinding"], receipt: null, owner_token: null,
    native_qualified: true, recovery_required: false, replay_ready: false }).binding;
  requireInput(binding !== null, "configuration");
  const coverage = object(row["coverage"], ["root", "prefix", "socketDirectory", "registeredSockets", "rootPids"]);
  return { schemaVersion: 1, profile, ownerDirectory: path(row["ownerDirectory"]),
    update: { receipt: pin(update["receipt"]), qualification: {
      installation: installation(q["installation"]), manager: { name: "bun", ...pin({ path: manager["path"], sha256: manager["sha256"] }),
        ...(hasNode ? { node: pin(manager["node"]) } : {}) },
      env: { BUN_INSTALL: path(env["BUN_INSTALL"]), HOME: path(env["HOME"]), PATH: path(env["PATH"]) },
      target: { packageName: "omo-ai", version: text(target["version"]), channel: "latest",
        checkedAt: integer(target["checkedAt"]), expiresAt: integer(target["expiresAt"]),
        artifacts: list(target["artifacts"], value => {
          const hasOverlay = typeof value === "object" && value !== null && Object.hasOwn(value, "overlay");
          const artifact = object(value, ["name", "installName", "version", "archive", "metadata", ...(hasOverlay ? ["overlay"] : [])]);
          return { name: text(artifact["name"]), installName: text(artifact["installName"]), version: text(artifact["version"]),
            archive: pin(artifact["archive"]), metadata: pin(artifact["metadata"]),
            ...(hasOverlay ? { overlay: overlay(artifact["overlay"]) } : {}) } satisfies OmoArtifact;
        }), postinstall: list(target["postinstall"], pin, 131072) } } },
    overlays: list(row["overlays"], value => {
      const grant = object(value, ["vendorArchive", "vendorMetadata", "overlay"]);
      return { vendorArchive: pin(grant["vendorArchive"]), vendorMetadata: pin(grant["vendorMetadata"]), overlay: overlay(grant["overlay"]) };
    }),
    provenance: list(row["provenance"], pin), expectedAfterPin: pin(row["expectedAfterPin"]),
    independentTargetPins: list(row["independentTargetPins"], pin, 131072), sourcePins: list(row["sourcePins"], pin),
    acquiredReplies: list(row["acquiredReplies"], value => {
      const reply = object(value, ["url", "status", "body"]);
      requireInput(reply["status"] === 200, "configuration");
      return { url: text(reply["url"]), status: 200, body: pin(reply["body"]) };
    }),
    native: { coreSocket: path(native["coreSocket"]), coreIdentity: { version: text(identity["version"]),
      protocol: integer(identity["protocol"]), schemaSha256: text(identity["schemaSha256"]) },
      operationsPath: path(native["operationsPath"]), runtimeId: text(native["runtimeId"]), profile: text(native["profile"]),
      sessionPath: path(native["sessionPath"]),
      sourceBinding: pin(native["sourceBinding"]), node: pin(native["node"]), expectedBinding: binding },
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
    && typeof wrapper.dependencies === "object" && wrapper.dependencies !== null
    && "@code-yeongyu/senpi" in wrapper.dependencies
    && typeof engine === "object" && engine !== null && "name" in engine && engine.name === "@code-yeongyu/senpi"
    && "version" in engine && wrapper.dependencies["@code-yeongyu/senpi"] === engine.version);
  return { ...template, installedVersion: { kind: "known", version: wrapper.version },
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
}
function captured(input: PluginRuntimeInputs, allowUpdated = false) {
  const before = input.update.qualification.installation;
  requireInput(before.owner.kind === "wrapper" && before.installedVersion.kind === "known", "profile");
  const after = installation(JSON.parse(bytes(input.expectedAfterPin).toString("utf8")));
  requireInput((isDeepStrictEqual(observeInstalled(before), before)
      || (allowUpdated && isDeepStrictEqual(observeInstalled(after), after)))
    && after.installationId === before.installationId && after.executableRealpath === before.executableRealpath
    && after.channel === before.channel && isDeepStrictEqual(after.owner, before.owner)
    && after.installedVersion.kind === "known" && after.installedVersion.version === input.update.qualification.target.version
    && after.resourcesFingerprint === `sha256:${hash(JSON.stringify(after.resources))}`
    && isDeepStrictEqual(after.resources.map(r => [r.resourceId, r.realpath]), before.resources.map(r => [r.resourceId, r.realpath])));
  const independent = new Set(input.independentTargetPins.map(pin => JSON.stringify([pin.path, pin.sha256])));
  for (const reference of [...input.update.qualification.target.postinstall,
    ...after.resources.map(r => ({ path: r.realpath, sha256: r.fingerprint.slice(7) }))])
    requireInput(independent.has(JSON.stringify([reference.path, reference.sha256])));
  const sourcePins = [input.update.receipt, input.update.qualification.manager, input.expectedAfterPin,
    ...input.sourcePins, ...input.provenance, input.native.sourceBinding, input.native.node,
    ...input.acquiredReplies.map(r => r.body), ...input.update.qualification.target.artifacts.flatMap(a =>
      [a.archive, a.metadata, ...(a.overlay ? [a.overlay.archive, a.overlay.sourceBinding, ...a.overlay.files.map(f => f.source)] : [])])];
  for (const reference of sourcePins) bytes(reference);
  requireInput(input.provenance.length > 0
    && isDeepStrictEqual(JSON.parse(bytes(input.update.receipt).toString("utf8")), input.update.qualification));
  return { before, after, sourcePins };
}

/** The parent chooses a path under its private plugin config directory.
 * Exclusive creation: replacing an approval is a separate explicit owner action.
 * This records data only; no qualifier, native operation or executable is run.
 */
export function configurePluginRuntime(configurationPath: string, inputs: unknown): void {
  const target = path(configurationPath);
  privateDirectory(dirname(target));
  requireInput(typeof inputs !== "object" || inputs === null || !types.isProxy(inputs), "configuration");
  const profile = typeof inputs === "object" && inputs !== null ? Object.getOwnPropertyDescriptor(inputs, "profile") : undefined;
  requireInput(!profile || Object.hasOwn(profile, "value"), "configuration");
  if (profile?.value === RUNTIME_SET_PROFILE) {
    const row = object(inputs, ["schemaVersion", "profile", "configurations"]);
    requireInput(row["schemaVersion"] === 1, "configuration");
    const configurations = list(row["configurations"], pin);
    requireInput(configurations.length > 0 && configurations.length <= 16
      && new Set(configurations.map(reference => reference.path)).size === configurations.length, "configuration");
    for (const reference of configurations) bytes(reference);
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, profile: RUNTIME_SET_PROFILE, configurations }),
      { flag: "wx", mode: 0o600 });
    return;
  }
  if (profile?.value === OMO_UPDATE_RUNTIME_PROFILE) {
    const input = validateOmoUpdateRuntimeInputs(inputs);
    writeFileSync(target, JSON.stringify(input), { flag: "wx", mode: 0o600 });
    return;
  }
  if (profile?.value === RESTART_RUNTIME_PROFILE) {
    writeFileSync(target, JSON.stringify(validateRestartRuntimeInputs(inputs)), { flag: "wx", mode: 0o600 });
    return;
  }
  if (profile?.value === PACKAGE_RUNTIME_PROFILE || profile?.value === PACKAGE_OPERATING_RUNTIME_PROFILE) {
    const input = validatePackageRuntimeInputs(inputs);
    writeFileSync(target, JSON.stringify(input), { flag: "wx", mode: 0o600 });
    return;
  }
  if (profile?.value === NATIVE_UPDATE_RUNTIME_PROFILE) {
    const input = validateNativeUpdateRuntimeInputs(inputs);
    writeFileSync(target, JSON.stringify(input), { flag: "wx", mode: 0o600 });
    return;
  }
  const input = parseInputs(inputs);
  captured(input);
  writeFileSync(target, JSON.stringify(input), { flag: "wx", mode: 0o600 });
}

/** Private production candidate -> owned observation receipt + runtime config.
 * No approval timestamp, native mutation or census authority is minted here.
 * The normal worker still repeats qualification/native checks and real census.
 */
export async function preparePluginRuntime(inputPath: string, destination: string, context: PluginRuntimeContext): Promise<void> {
  requireInput(process.platform === "darwin", "platform");
  const source = path(inputPath), target = path(destination), receiptPath = `${target}.qualification.json`;
  privateDirectory(dirname(source));
  privateDirectory(dirname(target));
  const workerDirectory = path(context.directory);
  privateDirectory(dirname(workerDirectory));
  requireInput(!lstatSync(workerDirectory, { throwIfNoEntry: false }), "configuration");
  requireInput(source !== target && source !== receiptPath && !lstatSync(target, { throwIfNoEntry: false }), "configuration");
  const info = lstatSync(source);
  requireInput(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.()
    && (info.mode & 0o777) === 0o600 && info.size <= 64 * 1024 * 1024 && realpathSync(source) === source, "configuration");
  const candidatePin = { path: source, sha256: hash(readFileSync(source)) };
  const row = object(JSON.parse(bytes(candidatePin).toString("utf8")), ["schemaVersion", "profile", "ownerDirectory",
    "update", "overlays", "provenance", "expectedAfterPin", "independentTargetPins", "sourcePins", "acquiredReplies", "native", "coverage"]);
  const update = object(row["update"], ["qualification"]);
  const native = object(row["native"], ["coreSocket", "coreIdentity", "operationsPath", "runtimeId", "profile", "sessionPath",
    "sourceBinding", "node", "paneId"]);
  const identity = object(native["coreIdentity"], ["version", "protocol", "schemaSha256"]);
  const paneId = text(native["paneId"]);
  requireInput(path(row["ownerDirectory"]) === context.directory
    && path(native["coreSocket"]) === path(context.coreSocket), "configuration");
  const client = new CoreOperationsClient(context.coreSocket, { version: text(identity["version"]),
    protocol: integer(identity["protocol"]), schemaSha256: text(identity["schemaSha256"]) });
  const observed = await client.request({ action: "inspect", pane_id: paneId }, AbortSignal.timeout(5000));
  requireInput(observed.native_qualified && !observed.recovery_required && observed.binding !== null
    && observed.binding.pane_id === paneId, "native");
  bytes(candidatePin);
  const { paneId: _paneId, ...nativeInput } = native;
  const receiptBody = JSON.stringify(update["qualification"]);
  requireInput(typeof receiptBody === "string", "configuration");
  const receipt = { path: receiptPath, sha256: hash(receiptBody) };
  const parsed = parseInputs({ ...row, update: { ...update, receipt },
    native: { ...nativeInput, expectedBinding: observed.binding } });
  const input: PluginRuntimeInputs = { ...parsed, sourcePins: [...parsed.sourcePins, candidatePin] };
  writeFileSync(receiptPath, receiptBody, { flag: "wx", mode: 0o600 });
  const written = lstatSync(receiptPath);
  try {
    captured(input);
    const qualified = await qualifyOmoUpdate(input.update, Date.now(), input.overlays);
    requireInput(qualified.ok, "qualification");
    requireInput(!lstatSync(workerDirectory, { throwIfNoEntry: false }), "configuration");
    configurePluginRuntime(target, input);
  } catch (error) {
    const current = lstatSync(receiptPath, { throwIfNoEntry: false });
    if (current?.isFile() && current.dev === written.dev && current.ino === written.ino
      && hash(readFileSync(receiptPath)) === receipt.sha256) unlinkSync(receiptPath);
    throw error;
  }
}

/** Fixed Darwin census implementation. Registered namespace and real OS reads
 * prove coverage; neither empty catalog rows nor JSON "allKnown" flags can do so.
 * Every observed additional consumer remains a blocker, even in the owned tree.
 */
function observeResources(plan: ResourcePlan, input: PluginRuntimeInputs): ResourceObservation {
  const coverage = input.coverage;
  privateDirectory(coverage.root);
  privateDirectory(coverage.socketDirectory);
  requireInput(realpathSync(coverage.prefix) === coverage.prefix && coverage.prefix.startsWith(`${coverage.root}/`)
    && plan.contract.installation.owner.kind === "wrapper" && plan.contract.installation.owner.prefix === coverage.prefix);
  const options = { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 } as const;
  const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], options).trim().split("\n").map(line => {
    const parts = line.trim().split(/\s+/);
    requireInput(parts.length === 2 && parts.every(part => /^\d+$/.test(part)));
    return { pid: Number(parts[0]), parent: Number(parts[1]) };
  });
  const known = new Set([...coverage.rootPids, process.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of processes) if (known.has(row.parent) && !known.has(row.pid)) { known.add(row.pid); changed = true; }
  }
  let openFiles: string;
  try { openFiles = execFileSync("/usr/sbin/lsof", ["-n", "-P", "-Fpn", "+D", coverage.prefix], options); }
  catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1
      && "stdout" in error && error.stdout === "" && "stderr" in error && error.stderr === "") openFiles = "";
    else throw error;
  }
  const seen = [...new Set(openFiles.split("\n").filter(row => /^p\d+$/.test(row)).map(row => Number(row.slice(1))))];
  const sockets: string[] = [], pending = [coverage.socketDirectory];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    requireInput(realpathSync(directory) === directory);
    for (const name of readdirSync(directory)) {
      const entry = join(directory, name), info = lstatSync(entry);
      if (info.isSymbolicLink()) {
        let target = entry, resolved = info;
        const visited = new Set<string>();
        while (resolved.isSymbolicLink()) {
          requireInput(!visited.has(target)); visited.add(target);
          target = resolve(dirname(target), readlinkSync(target));
          target = join(realpathSync(dirname(target)), basename(target));
          resolved = lstatSync(target);
        }
        requireInput(!resolved.isDirectory());
        if (resolved.isSocket()) sockets.push(target);
        continue;
      }
      if (info.isDirectory()) pending.push(entry);
      else if (info.isSocket()) sockets.push(entry);
    }
  }
  const runtime = plan.contract.runtime;
  requireInput(runtime !== null && coverage.registeredSockets.includes(input.native.coreSocket)
    && sockets.includes(input.native.coreSocket));
  const root = runtime.binding.rootIncarnation;
  return { installation: observeInstalled(plan.contract.installation), installerDigest: plan.installerDigest,
    mutationResources: plan.mutationResources, allSocketsKnown: sockets.every(p => coverage.registeredSockets.includes(p)),
    outsideConsumersKnown: seen.every(pid => known.has(pid)),
    consumers: [{ consumerId: root.startIdentity, binding: runtime.binding, resources: plan.mutationResources,
      state: processes.some(p => p.pid === root.pid) ? "running" : "exited" },
    ...seen.filter(pid => pid !== root.pid && pid !== process.pid).map(pid => ({
      consumerId: `observed:${pid}`, binding: null, resources: plan.mutationResources, state: "running" as const,
    }))], busySafety: null };
}

/** Worker-process entry. All authority is freshly issued here; persisted JSON
 * cannot supply an UpdateSpec, lifecycle port, census callback or native receipt.
 * Missing config does not open a queue. Failed setup never leaves one open.
 */
export async function loadPluginRuntime(context: PluginRuntimeContext, configurationPath?: string): Promise<PluginRuntimeLoad> {
  if (configurationPath === undefined) return { kind: "unconfigured" };
  try {
    const target = path(configurationPath);
    const info = lstatSync(target, { throwIfNoEntry: false });
    if (!info) return { kind: "unconfigured" };
    privateDirectory(dirname(target));
    requireInput(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.()
      && (info.mode & 0o777) === 0o600 && info.size <= 64 * 1024 * 1024 && realpathSync(target) === target, "configuration");
    const configPin = { path: target, sha256: hash(readFileSync(target)) };
    const value: unknown = JSON.parse(bytes(configPin).toString("utf8"));
    if (typeof value === "object" && value !== null && "profile" in value && value.profile === RUNTIME_SET_PROFILE) {
      const row = object(value, ["schemaVersion", "profile", "configurations"]);
      requireInput(row["schemaVersion"] === 1, "configuration");
      const configurations = list(row["configurations"], pin);
      requireInput(configurations.length > 0 && configurations.length <= 16
        && new Set(configurations.map(reference => reference.path)).size === configurations.length, "configuration");
      const loaded: Extract<PluginRuntimeLoad, { kind: "configured" }>[] = [];
      try {
        for (const reference of configurations) {
          const child: unknown = JSON.parse(bytes(reference).toString("utf8"));
          requireInput(typeof child === "object" && child !== null && "profile" in child
            && child.profile !== RUNTIME_SET_PROFILE, "configuration");
          const runtime = await loadPluginRuntime(context, reference.path);
          if (runtime.kind === "configured") loaded.push(runtime);
          else requireInput(runtime.kind === "unsupported"
            && (runtime.reason === "qualification" || runtime.reason === "inputs"), "configuration");
          bytes(reference);
        }
        requireInput(loaded.length > 0, "qualification");
        const candidates = loaded.flatMap(runtime => runtime.readers.candidates);
        requireInput(new Set(candidates.map(candidate => candidate.candidateId)).size === candidates.length, "configuration");
        const profiles = loaded.flatMap(runtime =>
          (runtime.runner.profiles ?? (runtime.runner.profile ? [runtime.runner.profile] : []))
            .map(profile => ({ ...profile, ...(runtime.runner.lifecycle ? { lifecycle: runtime.runner.lifecycle } : {}) })));
        bytes(configPin);
        const sharedQueue = loaded[0]!.runner.queue;
        for (const runtime of loaded.slice(1)) runtime.runner.queue.close();
        return { kind: "configured", readers: { candidates,
          sockets: loaded.flatMap(runtime => runtime.readers.sockets),
          runtimeSources: loaded.flatMap(runtime => runtime.readers.runtimeSources ?? []),
          check: async (identity, signal) => {
            for (const runtime of loaded) {
              const result = await runtime.readers.check?.(identity, signal);
              if (result?.ok) return result;
            }
            return { ok: false, error: { code: "verification_failed" } };
          } }, runner: { queue: sharedQueue, receiptRoot: context.directory,
            restartSources: loaded.flatMap(runtime => runtime.runner.restartSources ?? []).map(source => ({ ...source,
              read: async signal => {
                bytes(configPin);
                const qualified = await source.read(signal);
                bytes(configPin);
                return { ...qualified, fence: () => { bytes(configPin); qualified.fence(); bytes(configPin); } };
              } })),
            profiles: profiles.map(profile => ({ ...profile, sourcePins: [...profile.sourcePins, configPin] })) } };
      } catch (error) {
        for (const runtime of loaded) runtime.runner.queue.close();
        throw error;
      }
    }
    if (typeof value === "object" && value !== null && "profile" in value && value.profile === OMO_UPDATE_RUNTIME_PROFILE)
      return await loadOmoUpdateRuntime(context, configPin, value);
    if (typeof value === "object" && value !== null && "profile" in value && value.profile === RESTART_RUNTIME_PROFILE)
      return await loadRestartRuntime(context, configPin, value);
    if (typeof value === "object" && value !== null && "profile" in value
      && (value.profile === PACKAGE_RUNTIME_PROFILE || value.profile === PACKAGE_OPERATING_RUNTIME_PROFILE)) {
      const loaded = await loadPackageRuntime(context, configPin, value);
      if (loaded.kind !== "configured") return loaded;
      try {
        const input = validatePackageRuntimeInputs(value);
        const restartSources = input.profiles.flatMap(profile => {
          const native = profile.native, installation = profile.update.qualification.installation;
          if (!native || installation.family !== "codex") return [];
          const provenance = profile.sourcePins.filter(reference => {
            if (lstatSync(reference.path).size > 65536) return false;
            try {
              const value: unknown = JSON.parse(bytes(reference).toString("utf8"));
              return typeof value === "object" && value !== null && isDeepStrictEqual(Object.keys(value).sort(),
                ["channel", "executable", "family", "owner", "packageManifest", "resources"]);
            } catch (error) { if (error instanceof SyntaxError) return false; throw error; }
          });
          requireInput(provenance.length === 1, "configuration");
          return [createRestartSource(context, configPin, { schemaVersion: 1, profile: RESTART_RUNTIME_PROFILE,
            ownerDirectory: context.directory, installation, provenance, native: {
              coreSocket: native.coreSocket, operationsPath: native.operationsPath, runtimeId: native.runtimeId,
              profile: native.profile, sessionPath: native.sessionPath, node: native.node,
              paneId: native.expectedBinding.pane_id,
            } }).source];
        });
        return { ...loaded, runner: { ...loaded.runner, restartSources } };
      } catch (error) { loaded.runner.queue.close(); throw error; }
    }
    if (typeof value === "object" && value !== null && "profile" in value && value.profile === NATIVE_UPDATE_RUNTIME_PROFILE)
      return await loadNativeUpdateRuntime(context, configPin, value);
    const input = parseInputs(value);
    if (process.platform !== "darwin") return { kind: "unsupported", reason: "platform" };
    privateDirectory(context.directory);
    requireInput(input.ownerDirectory === context.directory && input.native.coreSocket === context.coreSocket, "configuration");
    const { before, after, sourcePins } = captured(input, true);
    sourcePins.push(configPin);
    const fence = () => { for (const reference of sourcePins) bytes(reference); };
    const readPins = [configPin, input.update.receipt, input.expectedAfterPin,
      ...input.sourcePins, ...input.provenance, ...input.acquiredReplies.map(row => row.body)];
    const readFence = () => { for (const reference of readPins) bytes(reference); };
    const updatedRead = (): AdapterResult<CatalogObservation> => {
      try {
        readFence();
        requireInput(isDeepStrictEqual(observeInstalled(after), after));
        return { ok: true, value: { contract: { version: 1, family: "omo", installation: after, runtime: null,
          capabilities: { check: unknown, update: unknown, busySafe: unknown,
            completion: unknown, resume: unknown, gracefulExit: unknown } }, lastCheck: null } };
      } catch { return { ok: false, error: { code: "stale_selection" } }; }
    };
    if (!isDeepStrictEqual(observeInstalled(before), before)) {
      requireInput(updatedRead().ok);
      return { kind: "configured", readers: { candidates: [{ candidateId: `installed:${after.installationId}`,
        family: "omo", installationId: after.installationId, read: async () => updatedRead() }], sockets: [] },
        runner: { queue: new MutationQueue(join(context.directory, "mutations")), receiptRoot: context.directory } };
    }
    const qualified = await qualifyOmoUpdate(input.update, Date.now(), input.overlays);
    fence();
    requireInput(qualified.ok, "qualification");
    const targetVersion = input.update.qualification.target.version;
    const intents = new Map(["update-only", "update-and-restart"].map(mode => {
      requireInput(mode === "update-only" || mode === "update-and-restart");
      const spec = createOmoUpdateSpec(qualified.value, mode, Date.now());
      requireInput(spec.ok, "qualification");
      const intent = getOmoUpdateIntent(spec.value);
      requireInput(intent.ok, "qualification");
      return [mode, intent.value] as const;
    }));
    const wrapper = join(input.coverage.prefix, "install/global/node_modules/omo-ai/package.json");
    const engine = join(input.coverage.prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json");
    const reply = (url: string): Buffer => {
      readFence();
      const found = input.acquiredReplies.filter(row => row.url === url);
      requireInput(found.length === 1 && found[0] !== undefined);
      return bytes(found[0].body);
    };
    const adapter = createOmoAdapter({ provenance: input.provenance, wrapperManifest: wrapper, engineManifest: engine,
      targetVersion, release: async channel => {
        requireInput(channel === targetVersion);
        return JSON.parse(reply(`https://registry.npmjs.org/omo-ai/${targetVersion}`).toString("utf8"));
      }, runtime: () => null, core: () => null, updateAuthority: {
        now: Date.now, read: selection => {
          fence();
          const intent = intents.get(selection.mode);
          return intent && isDeepStrictEqual(selection.installation, before)
            && selection.check.kind === "update-available" && selection.check.availableVersion === targetVersion
            ? { context: qualified.value, intent } : null;
        },
      } });
    const detected = await adapter.detect(before.executableRealpath);
    fence();
    requireInput(detected.ok && isDeepStrictEqual(detected.value, before));
    const checked = await adapter.check(before);
    fence();
    requireInput(checked.ok && ((checked.value.kind === "update-available" && checked.value.availableVersion === targetVersion)
      || (checked.value.kind === "up-to-date" && checked.value.installedVersion === targetVersion)));
    const nativeInput = input.native;
    privateDirectory(input.coverage.root);
    privateDirectory(input.coverage.socketDirectory);
    const wal = lstatSync(nativeInput.operationsPath);
    requireInput(realpathSync(nativeInput.operationsPath) === nativeInput.operationsPath && wal.isFile()
      && wal.nlink === 1 && wal.uid === process.getuid?.() && (wal.mode & 0o777) === 0o600, "native");
    const client = new CoreOperationsClient(context.coreSocket, nativeInput.coreIdentity);
    const observed = await client.request({ action: "inspect", pane_id: nativeInput.expectedBinding.pane_id }, AbortSignal.timeout(5000));
    fence();
    requireInput(observed.native_qualified && !observed.recovery_required
      && isDeepStrictEqual(observed.binding, nativeInput.expectedBinding), "native");
    const native = await createRestartLifecyclePort(client, { operationsPath: nativeInput.operationsPath,
      paneId: nativeInput.expectedBinding.pane_id, runtimeId: nativeInput.runtimeId, profile: nativeInput.profile,
      installation: before, observeInstallation: () => observeInstalled(after),
      workWaitMs: 120_000, transitionWaitMs: 30_000, observerNode: nativeInput.node.path });
    fence();
    const binding = nativeInput.expectedBinding;
    const expectedBinding: RuntimeBinding = { socketId: `socket:${hash(client.socketId)}`,
      socketEpoch: binding.socket_epoch, paneId: binding.pane_id, paneGeneration: binding.generation,
      rootIncarnation: { pid: binding.root.pid,
        startIdentity: `${binding.root.pid}:${binding.root.start_seconds}:${binding.root.start_microseconds}`,
        executableRealpath: binding.root.executable },
      session: { kind: "conversation", fullId: binding.session.full_id, storagePathHash: binding.session.storage_identity },
      cwd: binding.session.cwd, optionsRef: `options:${binding.session.options_sha256}`,
      turnGeneration: binding.work_generation, resourcesFingerprint: before.resourcesFingerprint };
    requireInput(isDeepStrictEqual(native.runtime.binding, expectedBinding)
      && isDeepStrictEqual(observeInstalled(before), before), "native");
    const evidenceRef = nativeInput.sourceBinding.path;
    const supported = { kind: "supported", reason: "verified", evidenceRef } as const;
    const contract: AdapterContract = { version: 1, family: "omo", installation: before, runtime: native.runtime,
      capabilities: { check: supported, update: supported, busySafe: unknown,
        completion: supported, resume: supported, gracefulExit: supported } };
    const source: CheckSource = { installation: before, pins: before.resources.map(r => ({
      path: r.realpath, sha256: r.fingerprint.slice(7), mode: lstatSync(r.realpath).mode & 0o7777,
    })), aliases: [], packageManifest: wrapper, engineManifest: engine };
    const checker = createCheckRuntime({ omoTargetVersion: targetVersion, store: createCheckStore(context.directory),
      admit: async candidate => {
        readFence();
        if (!isDeepStrictEqual(candidate, source) || !isDeepStrictEqual(observeInstalled(before), before))
          return { ok: false, error: { code: "stale_selection" } };
        const discovery = await discoverExecutable({ executable: before.executableRealpath, family: "omo", provenance: input.provenance });
        readFence();
        return discovery.ok && discovery.value.qualification.kind === "known" && isDeepStrictEqual(discovery.value.installation, before)
          ? { ok: true, value: null } : { ok: false, error: { code: "stale_selection" } };
      }, request: async request => {
        request.signal.throwIfAborted();
        requireInput(request.method === "GET");
        return new Response(reply(request.url), { headers: { "content-type": "application/json" } });
      } });
    async function readInstalled(): Promise<AdapterResult<CatalogObservation>> {
      try {
        readFence();
        if (!isDeepStrictEqual(observeInstalled(before), before)) return updatedRead();
        const lastCheck = await checker.lastCheck(source);
        readFence();
        return lastCheck.ok ? { ok: true, value: { contract: { ...contract, runtime: null,
          capabilities: { ...contract.capabilities, completion: unknown, resume: unknown, gracefulExit: unknown } },
          lastCheck: lastCheck.value } } : lastCheck;
      } catch { return { ok: false, error: { code: "stale_selection" } }; }
    }
    const readers: CatalogReaders = { candidates: [{ candidateId: `installed:${before.installationId}`, family: "omo",
      installationId: before.installationId, read: readInstalled }],
      sockets: [], runtimeSources: [{ socketId: native.runtime.binding.socketId,
        read: async () => {
          const installed = await readInstalled();
          if (!installed.ok) return installed;
          const current = await native.lifecycle.inspect(native.target, AbortSignal.timeout(5000));
          if (!current.ok) return current;
          if (!isDeepStrictEqual(current.value.binding, expectedBinding)) return { ok: false, error: { code: "stale_binding" } };
          return { ok: true, value: { kind: "observed", observations: [{ contract, lastCheck: installed.value.lastCheck }] } };
        } }],
      check: async (identity, signal) => isDeepStrictEqual(identity, before)
        ? checker.check(source, signal) : { ok: false, error: { code: "stale_selection" } } };
    fence();
    const queue = new MutationQueue(join(context.directory, "mutations"));
    return { kind: "configured", readers, runner: { queue, receiptRoot: context.directory, lifecycle: {
      ...native.lifecycle,
      async inspect(target, signal) {
        const session = lstatSync(nativeInput.sessionPath, { throwIfNoEntry: false });
        if (hash(nativeInput.sessionPath) !== expectedBinding.session.storagePathHash || !session?.isFile()
          || session.nlink !== 1 || session.uid !== process.getuid?.() || (session.mode & 0o022) !== 0
          || realpathSync(nativeInput.sessionPath) !== nativeInput.sessionPath)
          return { ok: false, error: { code: "recovery_required" } };
        return native.lifecycle.inspect(target, signal);
      },
    },
      profile: { adapter, contract, sourcePins, expectedAfter: after, expectedAfterPin: input.expectedAfterPin,
        observe: plan => { fence(); return observeResources(plan, input); },
        observeAfter: () => { fence(); return observeInstalled(after); } } } };
  } catch (error) {
    return { kind: "unsupported", reason: error instanceof PluginRuntimeError ? error.reason
      : error instanceof OperationFailure ? "native" : "configuration" };
  }
}
