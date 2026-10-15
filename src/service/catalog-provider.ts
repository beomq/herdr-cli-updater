import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createConnection } from "node:net";
import { discoverExecutable } from "../discovery";
import { createOmoAdapter } from "../adapters/omo";
import { createOmpAdapter } from "../adapters/omp";
import { createPiAdapter } from "../adapters/pi";
import { createClaudeAdapter } from "../adapters/claude";
import { createCodexAdapter } from "../adapters/codex";
import { createGrokAdapter } from "../adapters/grok";
import { FAMILIES } from "../adapters/types";
import type { AdapterResult, FamilyAdapter, InstallationIdentity } from "../adapters/types";
import { parseCompletion } from "../core/completion";
import type { CatalogObservation, CatalogReaders, CoreObservation, RuntimeAvailability } from "../catalog";
import type { FailureCode, Family } from "../protocol";
import type { CatalogSourceOwner } from "./catalog-sources";
import { checkSubjectKey, createCheckRuntime } from "./check-runtime";
import type { CheckRuntimeConfiguration, CheckSource } from "./check-runtime";
import { createCheckStore } from "./check-store";

// allow: SIZE_OK — the registered footprint assigns the private registry and its
// read-only composition boundary to this file; no adapter or protocol edits.
export type SourceReference = { readonly path: string; readonly sha256: string };
export type ResolvedExecutableReference = SourceReference & { readonly mode: number };
type Candidate = {
  readonly family: Family;
  readonly executable: SourceReference;
  readonly provenance: SourceReference | null;
  readonly sources: readonly (SourceReference & {
    readonly role: "wrapper-manifest" | "engine-manifest" | "omp-manifest";
  })[];
  /** Bootstrap-captured literal exec dependencies, not caller runtime authority. */
  readonly resolvedExecutables?: readonly ResolvedExecutableReference[];
};
export type CatalogRegistration = {
  readonly version: 1;
  readonly candidates: readonly Candidate[];
  readonly sockets: readonly string[];
};
export class CatalogProviderError extends Error {
  constructor(readonly code: "invalid_registry" | "unsafe_registry" | "stale_source") {
    super(code);
    this.name = "CatalogProviderError";
  }
}
export type CheckProviderConfiguration = Pick<CheckRuntimeConfiguration, "request" | "clock">;
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const blocked = <T>(code: FailureCode): AdapterResult<T> => ({ ok: false, error: { code } });
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}
function absolute(value: unknown): value is `/${string}` {
  return text(value) && value.startsWith("/") && normalize(value) === value;
}
function family(value: unknown): value is Family { return FAMILIES.some(item => item === value); }
function reference(value: unknown): value is SourceReference {
  return record(value) && absolute(value["path"]) && typeof value["sha256"] === "string"
    && /^[a-f0-9]{64}$/.test(value["sha256"]);
}
function resolvedReference(value: unknown): value is ResolvedExecutableReference {
  return record(value) && exact(value, ["path", "sha256", "mode"])
    && typeof value["mode"] === "number" && Number.isInteger(value["mode"]) && value["mode"] >= 0
    && value["mode"] <= 0o7777 && (value["mode"] & 0o022) === 0 && (value["mode"] & 0o111) !== 0
    && reference(value);
}
function candidate(value: unknown): value is Candidate {
  return record(value) && exact(value, ["family", "executable", "provenance", "sources",
    ...(Object.hasOwn(value, "resolvedExecutables") ? ["resolvedExecutables"] : [])])
    && family(value["family"]) && reference(value["executable"]) && exact(value["executable"], ["path", "sha256"])
    && (value["provenance"] === null || (reference(value["provenance"]) && exact(value["provenance"], ["path", "sha256"])))
    && Array.isArray(value["sources"]) && value["sources"].length <= 3
    && value["sources"].every((row: unknown) => record(row) && exact(row, ["role", "path", "sha256"])
      && ["wrapper-manifest", "engine-manifest", "omp-manifest"].some(role => role === row["role"]) && reference(row))
    && new Set(value["sources"].map(row => row.role)).size === value["sources"].length
    && (!Object.hasOwn(value, "resolvedExecutables") || (Array.isArray(value["resolvedExecutables"])
      && value["resolvedExecutables"].length <= 15 && value["resolvedExecutables"].every(resolvedReference)
      && new Set(value["resolvedExecutables"].map(row => row.path)).size === value["resolvedExecutables"].length));
}
/** Serialized data only: no accessor, callback, runtime DTO or authority is admitted. */
export function parseCatalogRegistration(input: string): CatalogRegistration {
  if (typeof input !== "string" || Buffer.byteLength(input) > 262144) throw new CatalogProviderError("invalid_registry");
  let value: unknown;
  try { value = JSON.parse(input); }
  catch { throw new CatalogProviderError("invalid_registry"); }
  if (!record(value) || !exact(value, ["version", "candidates", "sockets"]) || value["version"] !== 1
    || !Array.isArray(value["candidates"]) || value["candidates"].length > 64 || !value["candidates"].every(candidate)
    || !Array.isArray(value["sockets"]) || value["sockets"].length > 32 || !value["sockets"].every(absolute)
    || new Set(value["sockets"]).size !== value["sockets"].length
    || new Set(value["candidates"].map(row => `${row.family}:${row.executable.path}`)).size !== value["candidates"].length)
    throw new CatalogProviderError("invalid_registry");
  return { version: 1, candidates: value["candidates"], sockets: value["sockets"] };
}
export function catalogRegistryDirectory(directory: string): string {
  if (!absolute(directory) || basename(directory) === "." || directory === "/")
    throw new CatalogProviderError("unsafe_registry");
  return join(realpathSync(dirname(directory)), `${basename(directory)}.catalog`);
}
function privateDirectory(path: string): BigIntStats {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.uid !== BigInt(process.getuid?.() ?? -1)
    || (info.mode & 0o777n) !== 0o700n || realpathSync(path) !== path)
    throw new CatalogProviderError("unsafe_registry");
  return info;
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Pin verification reads bytes without executing them; file identity is checked
 * before/after the bounded streaming hash, including the named path. */
function file(path: string, privateOwned: boolean, capture = false): {
  readonly digest: string; readonly body: string; readonly header: string; readonly size: number; readonly mode: number;
} {
  const named = lstatSync(path, { bigint: true });
  const uid = BigInt(process.getuid?.() ?? -1);
  if (!named.isFile() || realpathSync(path) !== path || named.nlink !== 1n
    || (privateOwned ? named.uid !== uid || (named.mode & 0o777n) !== 0o600n
      : (named.uid !== uid && named.uid !== 0n) || (named.mode & 0o022n) !== 0n)
    || named.size > BigInt(capture ? 262144 : 512 * 1024 * 1024))
    throw new CatalogProviderError("unsafe_registry");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!same(named, before)) throw new CatalogProviderError("stale_source");
    const digest = createHash("sha256"), chunks: Buffer[] = [], buffer = Buffer.alloc(65536);
    let header = "";
    for (let offset = 0; offset < Number(before.size);) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (count === 0) throw new CatalogProviderError("stale_source");
      if (offset === 0) header = buffer.subarray(0, Math.min(count, 4096)).toString("utf8");
      digest.update(buffer.subarray(0, count));
      if (capture) chunks.push(Buffer.from(buffer.subarray(0, count)));
      offset += count;
    }
    if (!same(before, fstatSync(fd, { bigint: true })) || !same(before, lstatSync(path, { bigint: true }))
      || realpathSync(path) !== path) throw new CatalogProviderError("stale_source");
    return { digest: digest.digest("hex"), body: capture ? Buffer.concat(chunks).toString("utf8") : "",
      header, size: Number(before.size), mode: Number(before.mode & 0o7777n) };
  } finally { closeSync(fd); }
}
function verifyCandidate(row: Candidate, operation: "register" | "read" = "read"): {
  readonly physical: SourceReference; readonly resolvedExecutables: readonly ResolvedExecutableReference[];
} {
  for (const ref of [...(row.provenance ? [row.provenance] : []), ...row.sources])
    if (file(ref.path, false).digest !== ref.sha256) throw new CatalogProviderError("stale_source");
  const seen = new Set<string>(), resolvedExecutables: ResolvedExecutableReference[] = [];
  let path = row.executable.path;
  for (;;) {
    if (seen.has(path) || seen.size >= 16) throw new CatalogProviderError("stale_source");
    const expected = seen.size === 0 ? row.executable : row.resolvedExecutables?.[resolvedExecutables.length];
    if (!expected && (operation === "read" || row.resolvedExecutables !== undefined))
      throw new CatalogProviderError("stale_source");
    if (expected && expected.path !== path) throw new CatalogProviderError("stale_source");
    const observed = file(path, false);
    if ((observed.mode & 0o111) === 0 || (expected && (observed.digest !== expected.sha256
      || ("mode" in expected && observed.mode !== expected.mode)))) throw new CatalogProviderError("stale_source");
    if (seen.size > 0) resolvedExecutables.push({ path, sha256: observed.digest, mode: observed.mode });
    seen.add(path);
    if (!/^#!\/(?:bin\/(?:ba)?sh|usr\/bin\/env (?:ba)?sh)\r?\n/.test(observed.header)) {
      if (row.resolvedExecutables !== undefined && row.resolvedExecutables.length !== resolvedExecutables.length)
        throw new CatalogProviderError("stale_source");
      return { physical: { path, sha256: observed.digest }, resolvedExecutables };
    }
    // Mirror discovery's supported literal grammar only; never evaluate shell.
    // All hops, including intermediate launchers, must be pinned on later reads.
    const target = /^#!\/bin\/sh\nexec "([^"$`\\\n]+)" "\$@"\n?$/.exec(observed.header)?.[1];
    if (observed.size > 4096 || !absolute(target)) throw new CatalogProviderError("stale_source");
    path = target;
  }
}
/** Bootstrap API, never a socket command. Atomic replace has one publication
 * point; the old registry survives validation/write failure. Same-UID owners
 * are trusted, matching worker/jobs ownership, not a hostile same-UID sandbox. */
export function registerCatalog(directory: string, serialized: string): void {
  const input = parseCatalogRegistration(serialized);
  const registration: CatalogRegistration = { ...input, candidates: input.candidates.map(row => {
    const captured = verifyCandidate(row, "register");
    return captured.resolvedExecutables.length > 0 ? { ...row, resolvedExecutables: captured.resolvedExecutables } : row;
  }) };
  for (const row of registration.candidates) verifyCandidate(row);
  const root = catalogRegistryDirectory(directory);
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const identity = privateDirectory(root), path = join(root, "sources.json");
  if (lstatSync(path, { throwIfNoEntry: false })) file(path, true, true);
  const temporary = join(root, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let published = false;
  try {
    writeFileSync(fd, JSON.stringify(registration));
    fsyncSync(fd);
    const current = privateDirectory(root);
    if (current.dev !== identity.dev || current.ino !== identity.ino) throw new CatalogProviderError("unsafe_registry");
    if (lstatSync(path, { throwIfNoEntry: false })) file(path, true, true);
    renameSync(temporary, path);
    published = true;
    const directoryFd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally {
    closeSync(fd);
    if (!published) unlinkSync(temporary);
  }
}
function load(directory: string): CatalogRegistration | null {
  const root = catalogRegistryDirectory(directory);
  if (!lstatSync(root, { throwIfNoEntry: false })) return null;
  const before = privateDirectory(root);
  if (!lstatSync(join(root, "sources.json"), { throwIfNoEntry: false })) return null;
  const input = file(join(root, "sources.json"), true, true).body;
  const after = privateDirectory(root);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new CatalogProviderError("unsafe_registry");
  return parseCatalogRegistration(input);
}

/** Each family has an explicit read policy. AGY/Cursor detect calls execute a
 * CLI, so only their shared physical detector is admissible in this provider.
 * Grok requires a vendor version receipt which registration cannot manufacture.
 * No update, version probe, release request, session read or native hook runs. */
export const catalogDetectorPolicies = {
  omo: "adapter-with-manifests", omp: "adapter-with-source", pi: "adapter-with-manifest",
  claude: "adapter", codex: "adapter", agy: "physical-only-probe-required",
  cursor: "physical-only-probe-required", grok: "adapter-version-receipt-unavailable",
} as const satisfies Record<Family, string>;
function adapter(row: Candidate, installation: InstallationIdentity): FamilyAdapter | null {
  const provenance = row.provenance ? [row.provenance] : [];
  const source = (role: Candidate["sources"][number]["role"]) => row.sources.find(item => item.role === role)?.path;
  const cwd = dirname(row.executable.path);
  if (!absolute(cwd)) throw new CatalogProviderError("invalid_registry");
  switch (row.family) {
    case "omo": {
      const wrapperManifest = source("wrapper-manifest"), engineManifest = source("engine-manifest");
      return wrapperManifest && engineManifest ? createOmoAdapter({ provenance, wrapperManifest, engineManifest,
        release: async () => null, runtime: () => null, core: () => null }) : null;
    }
    case "omp": {
      const manifest = source("omp-manifest");
      return manifest && manifest.endsWith("/officialresponse/npm-version.json")
        ? createOmpAdapter({ sourceRoot: dirname(dirname(manifest)), probeCwd: cwd,
          provenance: () => provenance, readRuntime: () => null }) : null;
    }
    case "pi": {
      const engineManifest = source("engine-manifest");
      return engineManifest ? createPiAdapter({ provenance, engineManifest, qualification: () => null,
        release: async () => null, runtime: () => null, core: () => null, update: () => null }) : null;
    }
    case "claude": return createClaudeAdapter({ cwd, provenance: () => provenance, probeExecutables: [] });
    case "codex": return createCodexAdapter({ probeCwd: cwd, provenance: () => provenance,
      privateRuntime: () => null, preflight: () => null, manager: () => null, releases: async () => null, now: Date.now });
    case "grok": return createGrokAdapter({ installation: path => path === installation.executableRealpath ? installation : null,
      versionReceipt: () => null, release: () => null, parserReceipt: () => null, privateRuntime: () => null,
      decodeSavedSession: () => null, preflight: () => null, now: Date.now });
    case "agy": case "cursor": return null;
    default: return unreachable(row.family);
  }
}
function unreachable(_value: never): never { throw new CatalogProviderError("invalid_registry"); }
async function candidateObservation(row: Candidate): Promise<AdapterResult<CatalogObservation>> {
  try {
    const verified = verifyCandidate(row);
    const found = await discoverExecutable({ executable: row.executable.path, family: row.family,
      provenance: row.provenance ? [row.provenance] : [] });
    if (!found.ok) return blocked(found.error.code === "missing" ? "not_found" : "verification_failed");
    const install = found.value.installation;
    if (!install.resources.some(resource => resource.realpath === verified.physical.path
      && resource.fingerprint === `sha256:${verified.physical.sha256}`)) return blocked("verification_failed");
    // An ambiguous alias is never classified by its basename or registry hint.
    // Bound package names can disprove a hint even without an owner receipt.
    const packages = {
      "omo-ai": "omo", "@oh-my-pi/pi-coding-agent": "omp", "@code-yeongyu/senpi": "pi",
      "@anthropic-ai/claude-code": "claude", "@openai/codex": "codex", "@xai-official/grok": "grok",
    } as const;
    let packageFamily: Family | undefined;
    for (const resource of install.resources.filter(item => basename(item.realpath) === "package.json")) {
      const captured = file(resource.realpath, false, true);
      if (resource.fingerprint !== `sha256:${captured.digest}`) return blocked("verification_failed");
      const manifest: unknown = JSON.parse(captured.body);
      if (!record(manifest)) continue;
      const bin = manifest["bin"], entries = typeof bin === "string" ? [bin] : record(bin) ? Object.values(bin) : [];
      if (!entries.some(entry => typeof entry === "string" && join(dirname(resource.realpath), entry) === verified.physical.path)) continue;
      const physicalFamily = Object.entries(packages).find(([name]) => name === manifest["name"])?.[1];
      if (physicalFamily && physicalFamily !== row.family
        && !(physicalFamily === "pi" && install.family === "omo" && install.owner.kind === "wrapper"))
        return blocked("identity_mismatch");
      if (physicalFamily) packageFamily = physicalFamily;
    }
    if (!row.provenance && !packageFamily && basename(verified.physical.path) === "agent") return blocked("identity_mismatch");
    const reader = adapter(row, install);
    const detected = reader ? await reader.detect(row.executable.path) : null;
    // A failed family qualification cannot erase independently observed files,
    // nor upgrade their capabilities. Unknown version is a first-class value.
    const observation: CatalogObservation = { lastCheck: null, contract: {
      version: 1, family: install.family, installation: detected?.ok ? detected.value : install,
      runtime: null, capabilities: found.value.capabilities,
    } };
    verifyCandidate(row);
    if (!observation.contract.installation.resources.some(resource => resource.realpath === verified.physical.path
      && resource.fingerprint === `sha256:${verified.physical.sha256}`)) return blocked("verification_failed");
    return { ok: true, value: observation };
  } catch { return blocked("verification_failed"); }
}

function socketIdentity(path: string): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isSocket() || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o777n) !== 0o600n
    || realpathSync(dirname(path)) !== dirname(path)) throw new CatalogProviderError("unsafe_registry");
  return stat;
}
/** One bounded, read-only core request. Never sends worker credentials or a
 * begin/register/claim action. Socket replacement invalidates the observation. */
async function coreRead(path: string, request: {
  readonly method: "agent.list" | "ping" | "pane.list" | "pane.process_info" | "updater.completion.v1";
  readonly params: Readonly<Record<string, unknown>>;
}, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new CatalogProviderError("stale_source");
  const before = socketIdentity(path), id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let data = "", settled = false;
    const finish = (error: boolean, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(new CatalogProviderError("stale_source")); else resolve(value);
    };
    const abort = () => finish(true);
    signal.addEventListener("abort", abort, { once: true });
    socket.on("error", () => finish(true));
    socket.on("close", () => { if (!settled) finish(true); });
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > 1_048_576) { finish(true); return; }
      const end = data.indexOf("\n");
      if (end < 0) return;
      try {
        const response: unknown = JSON.parse(data.slice(0, end)), after = socketIdentity(path);
        if (!record(response) || !exact(response, ["id", "result"]) || response["id"] !== id
          || before.dev !== after.dev || before.ino !== after.ino) { finish(true); return; }
        finish(false, response["result"]);
      } catch { finish(true); }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, ...request })}\n`));
  });
}
function displayPlugins(refs: readonly SourceReference[]): readonly string[] {
  const plugins = new Set<string>();
  for (const ref of refs) {
    if (basename(ref.path) !== "package.json") continue;
    try {
      const captured = file(ref.path, false, true);
      if (captured.digest !== ref.sha256) continue;
      const manifest: unknown = JSON.parse(captured.body);
      if (record(manifest) && manifest["name"] === "omo-ai") plugins.add(join(dirname(ref.path), "plugin"));
    } catch { /* Unverified package sources cannot classify a display session. */ }
  }
  return [...plugins];
}
function quietOmoProcess(value: unknown): boolean {
  if (!record(value) || !Array.isArray(value["argv"]) || !value["argv"].every(text)) return false;
  const argv: string[] = value["argv"];
  return argv.some((arg, index) => {
    const plugin = argv[index + 1];
    if (arg !== "--extension" || !absolute(plugin) || basename(plugin) !== "plugin") return false;
    try {
      const wrapper = dirname(plugin), engine = join(wrapper, "../@code-yeongyu/senpi");
      const manifest: unknown = JSON.parse(file(join(wrapper, "package.json"), false, true).body);
      const metadata: unknown = JSON.parse(file(join(engine, "package.json"), false, true).body);
      if (!record(manifest) || manifest["name"] !== "omo-ai" || !record(manifest["dependencies"])
        || !text(manifest["dependencies"]["@code-yeongyu/senpi"])
        || !record(metadata) || metadata["name"] !== "@code-yeongyu/senpi" || !record(metadata["bin"])
        || !text(metadata["bin"]["senpi"])) return false;
      const entry = realpathSync(join(engine, metadata["bin"]["senpi"]));
      return argv.includes(entry);
    } catch { return false; }
  });
}
async function runtimeObservation(path: string, plugins: readonly string[] = []): Promise<AdapterResult<RuntimeAvailability>> {
  const observations: CoreObservation[] = [];
  try {
    const signal = AbortSignal.timeout(2000);
    const identity = socketIdentity(path), result = await coreRead(path, { method: "agent.list", params: {} }, signal);
    if (!record(result) || result["type"] !== "agent_list" || !Array.isArray(result["agents"]) || result["agents"].length > 1024)
      return blocked("verification_failed");
    let advertised = false;
    try {
      const pong = await coreRead(path, { method: "ping", params: {} }, signal);
      advertised = record(pong) && pong["type"] === "pong" && record(pong["capabilities"])
        && pong["capabilities"]["updater_completion_v1"] === true;
    } catch { advertised = false; }
    const agents = [...result["agents"]], quietPanes = new Set<string>();
    if (plugins.length > 0) {
      // Handoff can clear title-based detection. Foreground argv is sufficient
      // for display only; quiet panes never receive native mutation authority.
      const panes = await coreRead(path, { method: "pane.list", params: {} }, signal);
      if (!record(panes) || panes["type"] !== "pane_list" || !Array.isArray(panes["panes"]) || panes["panes"].length > 1024)
        return blocked("verification_failed");
      const quiet = panes["panes"].filter((pane: unknown) => record(pane) && text(pane["pane_id"])
        && !agents.some(row => record(row) && row["pane_id"] === pane["pane_id"]));
      for (let offset = 0; offset < quiet.length; offset += 8) {
        await Promise.all(quiet.slice(offset, offset + 8).map(async (pane: unknown) => {
          if (!record(pane) || !text(pane["pane_id"]) || !text(pane["terminal_id"])) return;
          const response = await coreRead(path, { method: "pane.process_info", params: { pane_id: pane["pane_id"] } }, signal);
          const info = record(response) ? response["process_info"] : null;
          if (!record(response) || response["type"] !== "pane_process_info" || !record(info)
            || info["pane_id"] !== pane["pane_id"] || !Array.isArray(info["foreground_processes"])) return;
          if (info["foreground_processes"].some(quietOmoProcess)) {
            agents.push({ ...pane, agent: "omo" });
            quietPanes.add(pane["pane_id"]);
          }
        }));
      }
    }
    for (const row of agents) {
      if (!record(row) || !text(row["pane_id"]) || !text(row["terminal_id"])
        || !(row["agent"] === undefined || text(row["agent"])) || !(row["cwd"] === undefined || absolute(row["cwd"]))
        || typeof row["revision"] !== "number" || !Number.isSafeInteger(row["revision"]) || row["revision"] < 0)
        return blocked("verification_failed");
      const rawSession = row["agent_session"];
      if (rawSession !== undefined && (!record(rawSession)
        || ![rawSession["source"], rawSession["agent"], rawSession["kind"], rawSession["value"]].every(text)))
        return blocked("verification_failed");
      const session = record(rawSession) && text(rawSession["source"]) && text(rawSession["agent"])
        && text(rawSession["kind"]) && text(rawSession["value"])
        ? { source: rawSession["source"], agent: rawSession["agent"], kind: rawSession["kind"], value: rawSession["value"] } : null;
      let displayFamily = family(row["agent"]) ? row["agent"] : null;
      if (displayFamily === "pi" && plugins.length > 0 && !signal.aborted) {
        try {
          const processResult = await coreRead(path, { method: "pane.process_info", params: { pane_id: row["pane_id"] } }, signal);
          const info = record(processResult) ? processResult["process_info"] : null;
          if (record(processResult) && processResult["type"] === "pane_process_info" && record(info)
            && info["pane_id"] === row["pane_id"] && Array.isArray(info["foreground_processes"])
            && info["foreground_processes"].some((process: unknown) => {
              if (!record(process) || !Array.isArray(process["argv"]) || !process["argv"].every(text)) return false;
              return process["argv"].some((arg: string, index: number, argv: string[]) =>
                arg === "--extension" && plugins.some(plugin => argv[index + 1] === plugin)) || quietOmoProcess(process);
            })) displayFamily = "omo";
        } catch { /* Missing foreground argv preserves the physical Pi display. */ }
      }
      const status = row["agent_status"] === "working" || row["agent_status"] === "idle" || row["agent_status"] === "done"
        ? row["agent_status"] : "unknown";
      let completion: CoreObservation["completion"] = null;
      // Only the exact family name is mapped; display aliases confer no identity.
      if (advertised && !signal.aborted && family(row["agent"]) && !quietPanes.has(row["pane_id"])) {
        try {
          const response = await coreRead(path, { method: "updater.completion.v1", params: {
            family: row["agent"], pane_id: row["pane_id"], expected_binding: null,
            generation: 0, sequence: 0, owner: null, operation: { action: "inspect" },
          } }, signal);
          if (!record(response) || response["type"] !== "updater_completion") throw new CatalogProviderError("stale_source");
          const snapshot = parseCompletion(response["snapshot"], row["agent"]);
          const b = snapshot.binding;
          if (b.socket_id !== path || b.pane_id !== row["pane_id"]) throw new CatalogProviderError("stale_source");
          completion = { generation: snapshot.generation, sequence: snapshot.sequence, binding: {
            socket_id: b.socket_id, socket_epoch: b.socket_epoch, pane_id: b.pane_id, pane_incarnation: b.pane_incarnation,
            root_pid: b.root_pid, root_start_identity: b.root_start_identity, root_executable: b.root_executable,
            session: b.session === null ? null : { source: b.session.source, agent: b.session.agent, kind: b.session.kind, value: b.session.value },
            cwd: b.cwd, options_ref: b.options_ref,
          } };
        } catch { completion = null; }
      }
      observations.push({ paneId: row["pane_id"], terminalId: row["terminal_id"],
        // parseCompletion currently rejects qualified hooks/all-work drain.
        // Producer-local completion or detector idle cannot prove whole work.
        agent: row["agent"] ?? null, family: displayFamily, status, workComplete: null,
        cwd: row["cwd"] ?? null, session, revision: row["revision"], completion });
    }
    const after = socketIdentity(path);
    if (after.dev !== identity.dev || after.ino !== identity.ino) return blocked("stale_binding");
    // Even zero displayed agents cannot prove a complete runtime inventory.
    return { ok: true, value: { kind: "unavailable", reason: "identity_incomplete", observations } };
  } catch {
    return { ok: true, value: { kind: "unavailable", reason: "source_unavailable", observations } };
  }
}
function sourceSnapshot(input: {
  readonly installation: InstallationIdentity;
  readonly pins: CheckSource["pins"];
  readonly aliases: CheckSource["aliases"];
  readonly packageManifest?: string | null;
  readonly engineManifest?: string | null;
  readonly managedEngine?: CheckSource["managedEngine"];
}): CheckSource {
  const pins = new Map(input.pins.map(pin => [pin.path, pin]));
  for (const resource of input.installation.resources) {
    const captured = file(resource.realpath, false, false);
    if (resource.fingerprint !== `sha256:${captured.digest}`) throw new CatalogProviderError("stale_source");
    const old = pins.get(resource.realpath);
    if (old && (old.sha256 !== captured.digest || old.mode !== captured.mode)) throw new CatalogProviderError("stale_source");
    pins.set(resource.realpath, { path: resource.realpath, sha256: captured.digest, mode: captured.mode });
  }
  const aliases = new Map(input.aliases.map(edge => [edge.path, edge]));
  let packageManifest = input.packageManifest ?? null, engineManifest = input.engineManifest ?? null;
  const expected = input.installation.family === "omo" ? "omo-ai"
    : input.installation.family === "pi" ? "@code-yeongyu/senpi" : null;
  if (expected !== null) {
    for (const pin of pins.values()) {
      if (basename(pin.path) !== "package.json") continue;
      const parsed: unknown = JSON.parse(file(pin.path, false, true).body);
      if (!record(parsed)) continue;
      if (parsed["name"] === expected) {
        if (packageManifest !== null && packageManifest !== pin.path) throw new CatalogProviderError("stale_source");
        packageManifest = pin.path;
      }
      if (input.installation.family === "omo" && parsed["name"] === "@code-yeongyu/senpi") {
        if (engineManifest !== null && engineManifest !== pin.path) throw new CatalogProviderError("stale_source");
        engineManifest = pin.path;
      }
    }
    const captureAlias = (path: string) => {
      const target = realpathSync(path), old = aliases.get(path);
      if (old && old.target !== target) throw new CatalogProviderError("stale_source");
      aliases.set(path, { path, target }); return target;
    };
    if (packageManifest !== null) {
      const parsed: unknown = JSON.parse(file(packageManifest, false, true).body);
      const bin = record(parsed) && record(parsed["bin"])
        ? parsed["bin"][input.installation.family === "omo" ? "omo" : "pi"] : null;
      if (typeof bin === "string") captureAlias(resolve(dirname(packageManifest), bin));
      if (input.installation.family === "omo" && engineManifest !== null) {
        for (let parent = dirname(packageManifest), level = 0; level < 16; level++, parent = dirname(parent)) {
          try {
            captureAlias(join(parent, "node_modules", "@code-yeongyu", "senpi", "package.json"));
            break;
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          }
          if (parent === dirname(parent)) break;
        }
        // Absence/mismatch is check qualification, not an inventory exclusion.
        // The checker independently enforces this relationship before adoption.
      }
    }
  }
  return { installation: structuredClone(input.installation),
    pins: [...pins.values()].sort((a, b) => a.path.localeCompare(b.path)),
    aliases: [...aliases.values()].sort((a, b) => a.path.localeCompare(b.path)), packageManifest, engineManifest,
    ...(input.managedEngine ? { managedEngine: structuredClone(input.managedEngine) } : {}) };
}
function combined(sources: readonly CheckSource[]): CheckSource {
  const first = sources[0];
  if (!first || sources.some(source => !isDeepStrictEqual(source.installation, first.installation)))
    throw new CatalogProviderError("stale_source");
  const pins = new Map<string, CheckSource["pins"][number]>(), aliases = new Map<string, CheckSource["aliases"][number]>();
  for (const source of sources) {
    for (const pin of source.pins) {
      const old = pins.get(pin.path);
      if (old && !isDeepStrictEqual(old, pin)) throw new CatalogProviderError("stale_source");
      pins.set(pin.path, pin);
    }
    for (const edge of source.aliases) {
      const old = aliases.get(edge.path);
      if (old && old.target !== edge.target) throw new CatalogProviderError("stale_source");
      aliases.set(edge.path, edge);
    }
  }
  if (sources.some(source => !isDeepStrictEqual(source.managedEngine, first.managedEngine)))
    throw new CatalogProviderError("stale_source");
  return sourceSnapshot({ installation: first.installation, pins: [...pins.values()], aliases: [...aliases.values()],
    packageManifest: first.packageManifest, engineManifest: first.engineManifest,
    ...(first.managedEngine ? { managedEngine: first.managedEngine } : {}) });
}
/** Called at request time, not cached at boot. Empty/missing registration is
 * unsupported, never a fabricated empty runtime success. */
export function createCatalogProvider(directory: string, options: CheckProviderConfiguration = {}): () => CatalogReaders {
  const checker = createCheckRuntime({ ...options, store: createCheckStore(directory), admit: async (_source) => {
    try {
      const current = load(directory);
      if (!current) return blocked("unsupported");
      for (const row of current.candidates) verifyCandidate(row);
      return { ok: true, value: null };
    } catch { return blocked("verification_failed"); }
  } });
  return () => {
    try {
      const registration = load(directory);
      if (!registration) return { candidates: [], sockets: [] };
      const registryPath = join(catalogRegistryDirectory(directory), "sources.json"), registryPin = file(registryPath, true, true);
      let observed: Promise<readonly AdapterResult<CatalogObservation>[]> | undefined;
      const observations = () => observed ??= Promise.all(registration.candidates.map(candidateObservation));
      const source = async (installation: InstallationIdentity): Promise<CheckSource> => {
        const values = await observations(), sources: CheckSource[] = [];
        for (let index = 0; index < registration.candidates.length; index++) {
          const row = registration.candidates[index], value = values[index];
          if (!row || !value?.ok || value.value.contract.installation.installationId !== installation.installationId) continue;
          if (!isDeepStrictEqual(value.value.contract.installation, installation)) throw new CatalogProviderError("stale_source");
          const verified = verifyCandidate(row);
          const refs = [row.executable, verified.physical, ...verified.resolvedExecutables,
            ...(row.provenance ? [row.provenance] : []), ...row.sources];
          sources.push(sourceSnapshot({ installation, pins: [...refs.map(ref => {
            const captured = file(ref.path, false, false);
            if (captured.digest !== ref.sha256) throw new CatalogProviderError("stale_source");
            return { path: ref.path, sha256: captured.digest, mode: captured.mode };
          }), { path: registryPath, sha256: registryPin.digest, mode: registryPin.mode }], aliases: [],
          packageManifest: row.sources.find(ref => ref.role === (installation.family === "omo" ? "wrapper-manifest" : "engine-manifest"))?.path ?? null,
          engineManifest: installation.family === "omo" ? row.sources.find(ref => ref.role === "engine-manifest")?.path ?? null : null }));
        }
        return combined(sources);
      };
      return {
        candidates: registration.candidates.map((row, index) => ({
          candidateId: `source:${hash(`${row.family}:${row.executable.path}`)}`, family: row.family,
          read: async () => {
            try {
              const value = (await observations())[index];
              if (!value) return blocked("verification_failed");
              if (!value.ok) return value;
              const last = await checker.lastCheck(await source(value.value.contract.installation));
              return last.ok ? { ok: true, value: { ...value.value, lastCheck: last.value } } : last;
            } catch { return blocked("verification_failed"); }
          },
        })),
        sockets: [],
        runtimeSources: registration.sockets.map(path => ({ socketId: path,
          read: () => runtimeObservation(path, displayPlugins(registration.candidates.flatMap(row => row.sources))) })),
        check: async (installation, signal) => {
          try {
            const latest = load(directory);
            if (!latest || !isDeepStrictEqual(latest, registration)) return blocked("stale_selection");
            const values = await Promise.all(registration.candidates.map(candidateObservation));
            if (!values.some(value => value.ok && isDeepStrictEqual(value.value.contract.installation, installation)))
              return blocked("stale_selection");
            return await checker.check(await source(installation), signal);
          } catch { return blocked("verification_failed"); }
        },
      };
    } catch {
      return { candidates: [], sockets: [], runtimeSources: [],
        registrationFailure: { code: "verification_failed" } };
    }
  };
}

/** Explicit publication has whole-document precedence, including refusal. The
 * automatic owner never writes sources.json or learns replacements for its pins.
 */
export function createAutomaticCatalogProvider(directory: string, owner: CatalogSourceOwner, options: CheckProviderConfiguration = {}):
  (signal?: AbortSignal, operation?: import("../protocol").Operation) => Promise<CatalogReaders> {
  const explicit = createCatalogProvider(directory, options);
  const admissions = new Map<string, () => Promise<AdapterResult<null>>>();
  const checker = createCheckRuntime({ ...options, store: createCheckStore(directory), admit: async source =>
    await admissions.get(checkSubjectKey(source))?.() ?? blocked("stale_selection") });
  let current: CatalogReaders | undefined;
  let refreshing: Promise<CatalogReaders> | undefined;
  const refresh = async (signal?: AbortSignal): Promise<CatalogReaders> => {
    try {
      if (load(directory) !== null) return explicit();
      const acquired = await owner.refresh(signal);
      // A publisher may have appeared while asynchronous discovery yielded.
      if (load(directory) !== null) return explicit();
      // Refuse the failed physical closure, including all aliases of any affected
      // installation. Independent installations of the same family stay visible.
      // Unclassified failures and time/size limits still refuse the whole scan.
      const refusedFamilies = acquired.failures.map(row => acquired.references
        .find(reference => reference.path === row.sourcePath)?.familyHint ?? null);
      // Generic aliases such as "agent" can share a refused physical executable
      // with a named family launcher. Isolate that same closure, not the catalog.
      const classifiedFailures = acquired.failures.map((row, index) => {
        if (refusedFamilies[index] !== null) return true;
        const physical = row.relatedPaths?.[1];
        return physical !== undefined && acquired.failures.some((other, otherIndex) =>
          refusedFamilies[otherIndex] !== null && other.relatedPaths?.[1] === physical);
      });
      const isolatedFailures = acquired.scanComplete && refusedFamilies.length > 0
        && classifiedFailures.every(Boolean);
      const failedPaths = new Set(acquired.failures.flatMap(row => row.relatedPaths ?? [row.sourcePath]));
      const refusedInstallations = new Set(acquired.candidates.filter(row => row.pins.some(pin => failedPaths.has(pin.path))
        || row.aliases.some(alias => failedPaths.has(alias.path) || failedPaths.has(alias.target)))
        .map(row => row.installation.installationId));
      const unresolvedFamilies = acquired.failures.filter(row => !row.relatedPaths).map(row => acquired.references
        .find(reference => reference.path === row.sourcePath)?.familyHint);
      const observed = isolatedFailures ? { ...acquired,
        candidates: acquired.candidates.filter(row => !refusedInstallations.has(row.installation.installationId)
          && !unresolvedFamilies.includes(row.family)),
        failures: [], state: "complete" as const } : acquired;
      if (isolatedFailures && observed.candidates.length === 0)
        return { candidates: [], sockets: [], registrationFailure: { code: acquired.failures[0]!.code } };
      if (observed.failures.length > 0 || observed.state === "incomplete")
        return { candidates: [], sockets: [], registrationFailure: {
          code: observed.failures[0]?.code ?? "resources_busy",
        } };
      const sources = new Map<string, CheckSource>(), groups = new Map<string, typeof observed.candidates>();
      for (const row of observed.candidates) {
        const group = groups.get(row.installation.installationId) ?? [];
        groups.set(row.installation.installationId, [...group, row]);
      }
      admissions.clear();
      for (const [id, rows] of groups) {
        const selected = combined(rows.map(row => sourceSnapshot({ installation: row.installation, pins: row.pins, aliases: row.aliases,
          ...(row.managedEngine ? { managedEngine: row.managedEngine } : {}) })));
        sources.set(id, selected);
        admissions.set(checkSubjectKey(selected), async () => {
          try {
            if (load(directory) !== null) return blocked("verification_failed");
            for (const row of rows) if (!await owner.verify(row)) return blocked("verification_failed");
            return { ok: true, value: null };
          } catch { return blocked("verification_failed"); }
        });
      }
      return {
        ...(observed.candidates.length === 0 && observed.sockets.length === 0 ? { emptyDiscovery: true as const } : {}),
        candidates: observed.candidates.map(row => ({
          candidateId: row.candidateId, family: row.installation.family, installationId: row.installation.installationId,
          read: async () => {
            if (!await owner.verify(row)) return blocked("verification_failed");
            const installation = structuredClone(row.installation);
            const unknown = { kind: "unknown", reason: "unverified_owner" } as const;
            const value: CatalogObservation = { lastCheck: null, contract: {
              version: 1, family: installation.family, installation, runtime: null,
              capabilities: { check: unknown, update: unknown, busySafe: unknown,
                completion: unknown, resume: unknown, gracefulExit: unknown },
            } };
            if (!await owner.verify(row)) return blocked("verification_failed");
            const source = sources.get(installation.installationId);
            if (!source) return blocked("verification_failed");
            const last = await checker.lastCheck(source);
            return last.ok ? { ok: true, value: { ...value, lastCheck: last.value } } : last;
          },
        })),
        sockets: [],
        runtimeSources: observed.sockets.map(path => ({ socketId: path,
          read: () => runtimeObservation(path, displayPlugins(observed.candidates
            .filter(row => row.installation.family === "omo").flatMap(row => row.pins))) })),
        check: async (installation, checkSignal) => {
          const source = sources.get(installation.installationId);
          if (!source || !isDeepStrictEqual(source.installation, installation)) return blocked("stale_selection");
          return checker.check(source, checkSignal);
        },
      };
    } catch {
      return { candidates: [], sockets: [], registrationFailure: { code: "verification_failed" } };
    }
  };
  return async (signal, operation) => {
    try { if (load(directory) !== null) return explicit(); }
    catch { return { candidates: [], sockets: [], registrationFailure: { code: "verification_failed" } }; }
    if (refreshing) return refreshing;
    if (current && operation !== undefined && operation !== "installations") return current;
    refreshing = refresh(signal);
    try {
      const next = await refreshing;
      if (!next.registrationFailure) current = next;
      else current = undefined;
      return next;
    } finally { refreshing = undefined; }
  };
}
