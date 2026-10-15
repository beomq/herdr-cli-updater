import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import { CoreOperationsClient, createRestartLifecyclePort, parseRestart } from "../core/client";
import type { CoreIdentity, RestartBinding } from "../core/client";
import type { InstallationIdentity } from "../adapters/types";
import type { UpdateFilePin } from "../adapters/update-context";
import type { RuntimeBinding } from "../protocol";
import { PluginRuntimeError } from "./plugin-runtime";
import type { PluginRuntimeContext } from "./plugin-runtime";

/** Retained core profile selection, never a command or a serialized receipt.
 * The surrounding package parser rejects proxies/accessors before this parser.
 */
export type CodexRuntimeInput = {
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
export type CodexRuntimeCandidate = Pick<CodexRuntimeInput,
  "coreSocket" | "operationsPath" | "runtimeId" | "profile" | "sessionPath" | "node"> & { readonly paneId: string };
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
function need(condition: boolean): asserts condition {
  if (!condition) throw new PluginRuntimeError("native");
}
export function parseCodexRuntimeInput(value: unknown): CodexRuntimeInput {
  function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
    need(typeof value === "object" && value !== null && !Array.isArray(value));
    const row = Object.fromEntries(Object.entries(value));
    need(Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)));
    return row;
  }
  function text(value: unknown): string {
    need(typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f\\]/.test(value));
    return value;
  }
  function path(value: unknown): string {
    const result = text(value);
    need(result.startsWith("/") && !result.split("/").some(part => part === "." || part === "..")
      && !result.includes("//") && !result.endsWith("/"));
    return result;
  }
  function digest(value: unknown): string {
    const result = text(value); need(/^[a-f0-9]{64}$/.test(result)); return result;
  }
  function pin(value: unknown): UpdateFilePin {
    const row = object(value, ["path", "sha256"]);
    return { path: path(row["path"]), sha256: digest(row["sha256"]) };
  }
  const row = object(value, ["coreSocket", "coreIdentity", "operationsPath", "runtimeId", "profile", "sessionPath",
    "sourceBinding", "node", "expectedBinding"]);
  const identity = object(row["coreIdentity"], ["version", "protocol", "schemaSha256"]);
  need(typeof identity["protocol"] === "number" && Number.isSafeInteger(identity["protocol"]) && identity["protocol"] >= 0);
  const binding = parseRestart({ binding: row["expectedBinding"], receipt: null, owner_token: null,
    native_qualified: false, recovery_required: false, replay_ready: false }).binding;
  need(binding !== null && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(binding.session.full_id));
  return { coreSocket: path(row["coreSocket"]), coreIdentity: { version: text(identity["version"]),
    protocol: identity["protocol"], schemaSha256: digest(identity["schemaSha256"]) },
    operationsPath: path(row["operationsPath"]), runtimeId: text(row["runtimeId"]), profile: text(row["profile"]),
    sessionPath: path(row["sessionPath"]), sourceBinding: pin(row["sourceBinding"]), node: pin(row["node"]), expectedBinding: binding };
}

/** Observe qualification rather than accepting a serialized successful receipt. */
export async function prepareCodexRuntime(candidate: CodexRuntimeCandidate): Promise<CodexRuntimeInput> {
  need(/^[A-Za-z0-9_-]{1,128}$/.test(candidate.profile));
  const client = await CoreOperationsClient.discover(candidate.coreSocket);
  const current = await client.request({ action: "inspect", pane_id: candidate.paneId }, AbortSignal.timeout(5000));
  need(current.native_qualified && !current.recovery_required && current.binding !== null && current.owner_token === null);
  const path = join(dirname(candidate.operationsPath), "profiles", `${candidate.profile}.json`);
  const info = lstatSync(path);
  need(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o600
    && realpathSync(path) === path && info.size <= 1024 * 1024);
  const body = readFileSync(path), after = lstatSync(path);
  need(info.dev === after.dev && info.ino === after.ino && info.size === after.size
    && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs);
  const sourceBinding = { path, sha256: createHash("sha256").update(body).digest("hex") };
  const { paneId: _paneId, ...retained } = candidate;
  return parseCodexRuntimeInput({ ...retained, coreIdentity: client.coreIdentity, sourceBinding, expectedBinding: current.binding });
}

/** Fresh native inspect owns qualification; a pinned document cannot create it.
 * JSONL metadata owns saved identity, not a rollout filename. Storage can grow.
 */
export async function composeCodexRuntime(input: CodexRuntimeInput, authority: {
  readonly context: PluginRuntimeContext;
  readonly installation: InstallationIdentity;
  readonly fence: () => void;
  readonly observeBefore: () => InstallationIdentity;
  readonly observeAfter: () => InstallationIdentity;
}) {
  const before = authority.installation, binding = input.expectedBinding;
  need(["codex", "omp", "pi", "omo", "claude"].includes(before.family) && input.coreSocket === authority.context.coreSocket
    && before.resources.some(row => row.realpath === binding.root.executable)
    && /^[A-Za-z0-9_-]{1,128}$/.test(input.profile)
    && input.sourceBinding.path === join(dirname(input.operationsPath), "profiles", `${input.profile}.json`));
  function retained() {
    const profile: unknown = JSON.parse(readFileSync(input.sourceBinding.path, "utf8"));
    need(typeof profile === "object" && profile !== null && "executable" in profile && profile.executable === binding.root.executable
      && "session_path" in profile && profile.session_path === input.sessionPath
      && "full_session_id" in profile && profile.full_session_id === binding.session.full_id
      && "cwd" in profile && profile.cwd === binding.session.cwd
      && "qualification" in profile && typeof profile.qualification === "object" && profile.qualification !== null
      && "kind" in profile.qualification && profile.qualification.kind === "native"
      && "family" in profile.qualification && profile.qualification.family === before.family
      && "options" in profile && "environment" in profile);
    if (before.family !== "codex") need("entrypoint" in profile && typeof profile.entrypoint === "string"
      && before.resources.some(row => row.realpath === profile.entrypoint));
    function mapDigest(value: unknown): string {
      need(typeof value === "object" && value !== null && !Array.isArray(value));
      const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      need(entries.length <= 256 && entries.every(([key, value]) => !key.includes("\0") && typeof value === "string" && !value.includes("\0")));
      return hash(JSON.stringify(Object.fromEntries(entries)));
    }
    need(typeof profile.options === "object" && profile.options !== null && !Array.isArray(profile.options));
    const options = profile.options;
    const optionKeys = before.family === "codex"
      ? ["argv_sha256", "effective_settings_sha256", "model_sha256", "thinking_sha256"]
      : ["argv", "effective_settings", "model", "thinking"];
    need(Object.keys(options).length === optionKeys.length
      && optionKeys.every(key => Object.hasOwn(options, key))
      && Object.values(options).every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)));
    need(mapDigest(options) === binding.session.options_sha256
      && mapDigest(profile.environment) === binding.session.environment_sha256);
  }
  function storage() {
    const info = lstatSync(input.sessionPath);
    need(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & 0o022) === 0
      && realpathSync(input.sessionPath) === input.sessionPath && info.size <= 16 * 1024 * 1024
      && hash(input.sessionPath) === binding.session.storage_identity);
    const body = readFileSync(input.sessionPath, "utf8"), after = lstatSync(input.sessionPath);
    need(info.dev === after.dev && info.ino === after.ino && info.size === after.size
      && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs);
    const lines = body.split("\n").filter(line => line.trim().length > 0);
    const first = lines[0];
    let meta: unknown = first ? JSON.parse(first) : null;
    if (before.family === "omp" && typeof meta === "object" && meta !== null && "type" in meta && meta.type === "title") {
      need("v" in meta && meta.v === 1 && "title" in meta && typeof meta.title === "string");
      meta = lines[1] ? JSON.parse(lines[1]) : null;
    }
    need(typeof meta === "object" && meta !== null && "type" in meta);
    if (before.family === "codex") {
      need(meta.type === "session_meta" && "payload" in meta && typeof meta.payload === "object" && meta.payload !== null
        && "id" in meta.payload && meta.payload.id === binding.session.full_id
        && "cwd" in meta.payload && meta.payload.cwd === binding.session.cwd
        && (!("history_mode" in meta.payload) || meta.payload.history_mode === "legacy" || meta.payload.history_mode === "paginated"));
    } else if (before.family === "claude") {
      const rows: unknown[] = lines.map(line => JSON.parse(line));
      const messages = rows.filter(row => typeof row === "object" && row !== null && "type" in row
        && (row.type === "user" || row.type === "assistant"));
      need(messages.length > 0 && messages.every(row => typeof row === "object" && row !== null
        && "sessionId" in row && row.sessionId === binding.session.full_id && "cwd" in row && row.cwd === binding.session.cwd));
    } else {
      need(meta.type === "session" && "id" in meta && meta.id === binding.session.full_id
        && "cwd" in meta && meta.cwd === binding.session.cwd && "version" in meta && meta.version === 3);
    }
    need(realpathSync(binding.session.cwd) === binding.session.cwd && lstatSync(binding.session.cwd).isDirectory());
    const wal = lstatSync(input.operationsPath);
    need(realpathSync(input.operationsPath) === input.operationsPath && wal.isFile() && wal.nlink === 1
      && wal.uid === process.getuid?.() && (wal.mode & 0o777) === 0o600);
  }
  const fence = () => { authority.fence(); retained(); storage(); authority.fence(); };
  fence(); need(isDeepStrictEqual(authority.observeBefore(), before));
  const client = new CoreOperationsClient(input.coreSocket, input.coreIdentity);
  const observed = await client.request({ action: "inspect", pane_id: binding.pane_id }, AbortSignal.timeout(5000));
  fence(); need(observed.native_qualified && !observed.recovery_required && isDeepStrictEqual(observed.binding, binding));
  const native = await createRestartLifecyclePort(client, { operationsPath: input.operationsPath,
    paneId: binding.pane_id, runtimeId: input.runtimeId, profile: input.profile, installation: before,
    observeInstallation: authority.observeAfter, observerNode: input.node.path, workWaitMs: 120_000, transitionWaitMs: 30_000 });
  const expected: RuntimeBinding = { socketId: `socket:${hash(client.socketId)}`, socketEpoch: binding.socket_epoch,
    paneId: binding.pane_id, paneGeneration: binding.generation, rootIncarnation: { pid: binding.root.pid,
      startIdentity: `${binding.root.pid}:${binding.root.start_seconds}:${binding.root.start_microseconds}`,
      executableRealpath: binding.root.executable }, session: { kind: "conversation", fullId: binding.session.full_id,
      storagePathHash: binding.session.storage_identity }, cwd: binding.session.cwd,
    optionsRef: `options:${binding.session.options_sha256}`, turnGeneration: binding.work_generation,
    resourcesFingerprint: before.resourcesFingerprint };
  fence(); need(isDeepStrictEqual(native.runtime.binding, expected) && isDeepStrictEqual(authority.observeBefore(), before));
  return { ...native, lifecycle: { ...native.lifecycle,
  async claim(target, operationId, signal) {
    try {
      fence(); need(isDeepStrictEqual(authority.observeBefore(), before));
      const current = await native.lifecycle.inspect(target, signal);
      if (!current.ok) return current;
      fence(); need(isDeepStrictEqual(authority.observeBefore(), before));
      return await native.lifecycle.claim(target, operationId, signal);
    } catch { return { ok: false as const, error: { code: "recovery_required" as const } }; }
  },
  async inspect(target, signal) {
    try {
      fence(); need(isDeepStrictEqual(authority.observeBefore(), before));
      const current = await native.lifecycle.inspect(target, signal);
      fence(); need(isDeepStrictEqual(authority.observeBefore(), before));
      return current;
    } catch { return { ok: false as const, error: { code: "recovery_required" as const } }; }
  } } satisfies typeof native.lifecycle };
}
