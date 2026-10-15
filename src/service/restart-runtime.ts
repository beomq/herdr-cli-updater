import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parseAdapterContract } from "../adapters/types";
import type { InstallationIdentity } from "../adapters/types";
import { discoverExecutable } from "../discovery";
import { MutationQueue } from "../install/queue";
import { composeCodexRuntime, prepareCodexRuntime } from "./codex-runtime";
import { RestartError } from "./restart-runner";
import type { RestartSource } from "./restart-runner";
import type { PluginRuntimeContext, PluginRuntimeLoad } from "./plugin-runtime";
import type { UpdateFilePin } from "../adapters/update-context";

export const RESTART_RUNTIME_PROFILE = "qualified-codex-restart-v1" as const;
const path = z.string().startsWith("/").refine(value => !/[\x00-\x1f\x7f]/.test(value));
const pinSchema = z.object({ path, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const candidateSchema = z.object({
  coreSocket: path, operationsPath: path, runtimeId: z.string().min(1).max(128),
  profile: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sessionPath: path,
  node: pinSchema, paneId: z.string().min(1).max(128),
}).strict();
const inputSchema = z.object({
  schemaVersion: z.literal(1), profile: z.literal(RESTART_RUNTIME_PROFILE),
  ownerDirectory: path, installation: z.unknown(), provenance: z.array(pinSchema).min(1).max(32),
  native: candidateSchema,
}).strict();
const unsupported = { kind: "unsupported", reason: "not_verified" } as const;
function need(condition: boolean): asserts condition {
  if (!condition) throw new RestartError("verification_failed");
}
function digest(file: string, singleLink = true): string {
  need(realpathSync(file) === file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    need(before.isFile() && before.uid === BigInt(process.getuid?.() ?? -1)
      && (!singleLink || before.nlink === 1n) && (before.mode & 0o022n) === 0n && before.size <= 2n * 1024n ** 3n);
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < Number(before.size);) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      need(count > 0); hash.update(buffer.subarray(0, count)); offset += count;
    }
    for (const info of [fstatSync(fd, { bigint: true }), lstatSync(file, { bigint: true })])
      need(info.dev === before.dev && info.ino === before.ino && info.size === before.size
        && info.mode === before.mode && info.mtimeNs === before.mtimeNs && info.ctimeNs === before.ctimeNs);
    need(realpathSync(file) === file);
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
function privateDirectory(directory: string) {
  const info = lstatSync(directory);
  need(realpathSync(directory) === directory && info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700);
}
function parse(value: unknown) {
  const input = inputSchema.parse(value);
  const family = z.object({ family: z.enum(["codex", "omp", "pi", "omo", "claude"]) }).parse(input.installation).family;
  const contract = parseAdapterContract({ version: 1, family, installation: input.installation, runtime: null,
    capabilities: { check: unsupported, update: unsupported, busySafe: unsupported,
      completion: unsupported, resume: unsupported, gracefulExit: unsupported } });
  need(contract.ok && ((contract.value.installation.owner.kind === "package"
    && contract.value.installation.owner.packageName === { codex: "@openai/codex", omp: "@oh-my-pi/pi-coding-agent",
      pi: "@code-yeongyu/senpi", omo: "omo-ai", claude: "@anthropic-ai/claude-code" }[family])
    || (family === "codex" && contract.value.installation.owner.kind === "native")));
  return { ...input, installation: contract.value.installation };
}
export function validateRestartRuntimeInputs(value: unknown) { return parse(value); }

/** After installation replacement, validate the new Codex loader against the
 * retained conversation before publishing a separate start profile. The live
 * process keeps its original profile and binding until authenticated restart. */
export async function prepareCodexUpgradeProfile(input: {
  readonly native: z.infer<typeof candidateSchema>;
  readonly previousProfile: UpdateFilePin;
  readonly executable: UpdateFilePin;
  readonly profile: string;
}) {
  const native = candidateSchema.parse(input.native);
  const name = candidateSchema.shape.profile.parse(input.profile);
  need(name !== native.profile);
  const previous = await prepareCodexRuntime(native);
  need(isDeepStrictEqual(previous.sourceBinding, input.previousProfile));
  const profileSchema = z.object({
    qualification: z.object({ kind: z.literal("native"), family: z.literal("codex"),
      source_revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }).strict(),
    executable: path, entrypoint: z.null(), args: z.array(z.string()).max(256),
    environment: z.record(z.string(), z.string()), options: z.object({
      argv_sha256: pinSchema.shape.sha256, effective_settings_sha256: pinSchema.shape.sha256,
      model_sha256: pinSchema.shape.sha256, thinking_sha256: pinSchema.shape.sha256,
    }).strict(), cwd: path, session_path: path, full_session_id: z.string(),
    bridge_sha256: pinSchema.shape.sha256, closure: z.array(pinSchema).length(1),
  }).strict();
  const retained = profileSchema.parse(JSON.parse(readFileSync(previous.sourceBinding.path, "utf8")));
  need(retained.executable === input.executable.path && retained.executable === previous.expectedBinding.root.executable
    && retained.closure[0]?.path === retained.executable
    && retained.closure[0]?.sha256 === retained.bridge_sha256
    && retained.bridge_sha256 !== input.executable.sha256
    && retained.full_session_id === previous.expectedBinding.session.full_id
    && retained.session_path === native.sessionPath && retained.cwd === previous.expectedBinding.session.cwd
    && !Object.hasOwn(retained.environment, "HERDR_UPDATER_FD")
    && !Object.hasOwn(retained.environment, "HERDR_UPDATER_PREFLIGHT"));
  const mapHash = (value: Readonly<Record<string, string>>) => createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))))
    .digest("hex");
  need(mapHash(retained.options) === previous.expectedBinding.session.options_sha256
    && mapHash(retained.environment) === previous.expectedBinding.session.environment_sha256);
  const fence = () => {
    need(digest(previous.sourceBinding.path) === previous.sourceBinding.sha256
      && digest(input.executable.path, false) === input.executable.sha256
      && (lstatSync(input.executable.path).mode & 0o111) !== 0);
  };
  fence();
  const child = Bun.spawn([retained.executable, ...retained.args], { cwd: retained.cwd,
    env: { ...retained.environment, HERDR_UPDATER_PREFLIGHT: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let status: number, stdout: string;
  try {
    [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  } finally { clearTimeout(deadline); }
  need(status === 0 && isDeepStrictEqual(profileSchema.shape.options.parse(JSON.parse(stdout)), retained.options));
  fence();
  const fresh = await prepareCodexRuntime(native);
  need(isDeepStrictEqual(fresh, previous));
  const directory = dirname(previous.sourceBinding.path);
  privateDirectory(directory);
  const updated = { ...retained, qualification: { ...retained.qualification, source_revision: input.executable.sha256 },
    bridge_sha256: input.executable.sha256, closure: [input.executable] };
  const target = join(directory, `${name}.json`);
  writeFileSync(target, JSON.stringify(updated), { mode: 0o600, flag: "wx" });
  return { native: { ...native, profile: name }, profile: { path: target, sha256: digest(target) } };
}

/** Preparation is read-only toward the installation/core. It captures the
 * CURRENT installed payload, not a future version or an update qualification. */
export async function prepareRestartRuntime(configurationPath: string, input: {
  readonly ownerDirectory: string;
  readonly executable: string;
  readonly family?: "codex" | "omp" | "pi" | "omo" | "claude";
  readonly provenance: readonly UpdateFilePin[];
  readonly native: z.infer<typeof candidateSchema>;
}): Promise<UpdateFilePin> {
  privateDirectory(dirname(configurationPath));
  let discovered = await discoverExecutable({ executable: input.executable, family: input.family ?? "codex", provenance: input.provenance });
  if (discovered.ok && discovered.value.installation.family === "codex" && discovered.value.installation.owner.kind === "native")
    discovered = await discoverExecutable({ executable: input.executable, family: "codex", provenance: input.provenance,
      probe: { cwd: dirname(configurationPath) } });
  need(discovered.ok && discovered.value.qualification.kind === "known");
  const value = parse({ schemaVersion: 1, profile: RESTART_RUNTIME_PROFILE,
    ownerDirectory: input.ownerDirectory, installation: discovered.value.installation,
    provenance: input.provenance, native: input.native });
  // No qualification renewal: a missing/expired core qualification fails closed.
  await prepareCodexRuntime(value.native);
  for (const reference of [...value.provenance, value.native.node]) need(digest(reference.path) === reference.sha256);
  writeFileSync(configurationPath, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  return { path: configurationPath, sha256: digest(configurationPath) };
}

export function createRestartSource(context: PluginRuntimeContext, configuration: UpdateFilePin, value: unknown) {
  const input = parse(value), installed = input.installation;
  need(input.ownerDirectory === context.directory && input.native.coreSocket === context.coreSocket);
  privateDirectory(context.directory); privateDirectory(dirname(configuration.path));
  const pins = [configuration, ...input.provenance, input.native.node];
  const fence = () => {
    for (const reference of pins) need(digest(reference.path) === reference.sha256);
  };
  const observe = (): InstallationIdentity => {
    fence();
    const resources = installed.resources.map(resource => ({ ...resource,
      fingerprint: `sha256:${digest(resource.realpath, false)}` }));
    // Manifest is a discovery resource; installation version cannot change
    // without failing its pinned payload fingerprint.
    need(isDeepStrictEqual(resources, installed.resources));
    return installed;
  };
  fence(); observe();
  const source: RestartSource = { installationId: installed.installationId, read: async signal => {
    signal.throwIfAborted(); fence(); observe();
    const discovered = await discoverExecutable({ executable: installed.executableRealpath, family: installed.family, provenance: input.provenance,
      ...(installed.owner.kind === "native" ? { probe: { cwd: context.directory } } : {}) });
    need(discovered.ok && discovered.value.qualification.kind === "known");
    const observed = discovered.value.installation;
    const resources = observed.resources.filter(row => installed.resources.some(resource => resource.realpath === row.realpath)
      || !input.provenance.some(reference => reference.path === row.realpath));
    need(isDeepStrictEqual({ ...observed, resources,
      resourcesFingerprint: `sha256:${createHash("sha256").update(JSON.stringify(resources)).digest("hex")}` }, installed));
    // Refresh from source explicitly, then compare the caller's selected binding
    // in the runner. Old target DTOs cannot authorize a new generation.
    const native = await prepareCodexRuntime(input.native);
    const nativeFence = () => {
      need((lstatSync(native.sourceBinding.path).mode & 0o777) === 0o600);
      fence(); need(digest(native.sourceBinding.path) === native.sourceBinding.sha256);
      // Same-version restart is not installation upgrade adoption. The retained
      // core profile must still cover the current executable and closure before
      // claim/stop. A changed installation needs an independently qualified
      // profile handover; neither a fresh inspect nor new disk metadata grants it.
      const profile = z.object({ executable: path, closure: z.array(pinSchema).min(1).max(256) })
        .parse(JSON.parse(readFileSync(native.sourceBinding.path, "utf8")));
      need(profile.executable === native.expectedBinding.root.executable
        && installed.resources.some(resource => resource.realpath === profile.executable)
        && profile.closure.some(reference => reference.path === profile.executable));
      for (const reference of profile.closure) need(digest(reference.path, false) === reference.sha256);
      need(digest(native.sourceBinding.path) === native.sourceBinding.sha256); fence();
    };
    const composed = await composeCodexRuntime(native, { context, installation: installed,
      fence: nativeFence, observeBefore: observe, observeAfter: observe });
    signal.throwIfAborted(); nativeFence();
    return { ...composed, runtime: { ...composed.runtime,
      runningVersion: { kind: "unknown" as const, reason: "not_captured" as const } },
      installation: installed, evidenceRef: native.sourceBinding.path,
      fence: nativeFence, observe };
  } };
  return { source, installed, observe };
}

export async function loadRestartRuntime(context: PluginRuntimeContext, configuration: UpdateFilePin,
  value: unknown): Promise<PluginRuntimeLoad> {
  const { source, installed, observe } = createRestartSource(context, configuration, value);
  return { kind: "configured", readers: { sockets: [], candidates: [{
    candidateId: `restart:${installed.installationId}`, installationId: installed.installationId, family: "codex",
    read: async () => {
      try {
        observe();
        return { ok: true, value: { contract: { version: 1, family: "codex", installation: installed, runtime: null,
          capabilities: { check: unsupported, update: unsupported, busySafe: unsupported,
            completion: unsupported, resume: unsupported, gracefulExit: unsupported } }, lastCheck: null } };
      } catch { return { ok: false, error: { code: "stale_selection" } }; }
    },
  }] }, runner: { queue: new MutationQueue(`${context.directory}-mutations`),
    receiptRoot: context.directory, restartSources: [source] } };
}
