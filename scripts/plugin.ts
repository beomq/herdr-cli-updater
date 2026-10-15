import { defaultWorkerDirectory, discoverWorker, startWorker, stopWorker, WorkerError } from "../src/service/worker";
import { attachAuthenticatedWorker, ClientError } from "../src/service/client";
import { JobError } from "../src/jobs/jobs";
import { HostError, openTerminalHost } from "../src/tui/host";
import { createCatalogSourceOwner } from "../src/service/catalog-sources";
import { configurePluginRuntime, preparePluginRuntime, PluginRuntimeError, RUNTIME_SET_PROFILE } from "../src/service/plugin-runtime";
import type { UpdateFilePin } from "../src/adapters/update-context";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { CoreOperationsClient, OperationFailure } from "../src/core/client";
import { prepareNpmInstallationRuntime, PackagePreparationError } from "../src/service/prepare-package-runtime";
import { prepareOmoInstallationRuntime, OmoPreparationError } from "../src/service/prepare-omo-runtime";
import { retainPreparations } from "../src/service/preparation-retention";
import type { Installation } from "../src/protocol";
import { RESTART_RUNTIME_PROFILE, validateRestartRuntimeInputs } from "../src/service/restart-runtime";

function failureText(error: unknown): string {
  return error instanceof PackagePreparationError || error instanceof OmoPreparationError
    ? `${error.reason}: ${error.detail.replace(/[\x00-\x1f\x7f]/g, " ")}`
    : error instanceof PluginRuntimeError ? `runtime_${error.reason}`
    : error instanceof OperationFailure ? error.code
    : error instanceof WorkerError || error instanceof HostError || error instanceof ClientError || error instanceof JobError
      ? error.code : "worker_unavailable";
}

function registeredPreparationRoots(runtimePath: string, parent: string): string[] {
  const value: unknown = JSON.parse(readFileSync(runtimePath, "utf8"));
  if (typeof value !== "object" || value === null || !("configurations" in value) || !Array.isArray(value.configurations))
    throw new WorkerError("invalid_command");
  return value.configurations.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("path" in entry) || typeof entry.path !== "string")
      throw new WorkerError("invalid_command");
    const root = dirname(entry.path);
    if (dirname(root) !== parent) return ""; // Independent runtime profiles are not this producer's data.
    return root;
  }).filter(Boolean);
}

function preparationAnchor(socketPath: string): number {
  const info = lstatSync(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600
    || realpathSync(dirname(socketPath)) !== dirname(socketPath)) throw new WorkerError("invalid_command");
  const options = { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" } } as const;
  const output = execFileSync("/usr/sbin/lsof", ["-n", "-U", "-Fpn"], options);
  let pid = 0;
  const owners = new Set<number>();
  for (const line of output.split("\n")) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line === `n${socketPath}`) owners.add(pid);
  }
  const owner = [...owners][0];
  if (owners.size !== 1 || owner === undefined || owner <= 1) throw new WorkerError("invalid_command");
  const match = /^(\d+)\s+(.+)$/.exec(execFileSync("/bin/ps", ["-p", String(owner), "-o", "uid=,comm="], options).trim());
  if (!match || Number(match[1]) !== process.getuid?.() || !match[2]
    || basename(realpathSync(match[2])) !== "herdr") throw new WorkerError("invalid_command");
  return owner;
}

export async function idleWorker(directory: string): Promise<void> {
  const attachment = await attachAuthenticatedWorker(directory, 20000);
  try {
    const response = await attachment.request({ operation: "jobs" });
    if (!response.ok || response.result.jobs.some(job => job.status !== "completed" && job.status !== "cancelled"))
      throw new JobError("resources_busy");
  } finally { attachment.close(); }
}

/** Only an authenticated stop permits archiving residual private journals. */
export async function retireWorker(directory: string): Promise<void> {
  const owner = discoverWorker(directory), before = lstatSync(directory);
  await stopWorker(owner);
  if (!existsSync(directory)) return;
  const after = lstatSync(directory);
  if (before.dev !== after.dev || before.ino !== after.ino || realpathSync(directory) !== directory
    || [owner.socketPath, owner.controlPath, owner.tokenPath, join(directory, "owner.json")].some(existsSync))
    throw new WorkerError("invalid_command");
  await rename(directory, `${directory}.retired-${owner.incarnation}`);
}

export function omoPreparationInputs(installation?: Installation): { readonly prefix: string; readonly bun: string } {
  const suffix = "/install/global/node_modules/omo-ai/bin/omo.js";
  let prefix: string;
  if (installation) {
    const executable = installation.executableRealpath;
    if (installation.family !== "omo" || !executable.endsWith(suffix)
      || !isAbsolute(executable) || realpathSync(executable) !== executable
      || (installation.owner.kind === "package" && installation.owner.manager !== "bun"))
      throw new WorkerError("invalid_command");
    prefix = executable.slice(0, -suffix.length);
  } else {
    const home = process.env["HOME"], configured = process.env["BUN_INSTALL"];
    if (!configured && !home) throw new WorkerError("invalid_command");
    prefix = configured ?? join(home ?? "", ".bun");
    if (!isAbsolute(prefix) || realpathSync(join(prefix, suffix.slice(1))) !== join(prefix, suffix.slice(1)))
      throw new WorkerError("invalid_command");
  }
  if (realpathSync(prefix) !== prefix) throw new WorkerError("invalid_command");
  const candidate = existsSync(join(prefix, "bin/bun")) ? join(prefix, "bin/bun") : Bun.which("bun");
  if (!candidate || !isAbsolute(candidate)) throw new WorkerError("invalid_command");
  const bun = realpathSync(candidate);
  if (basename(bun) !== "bun" || !lstatSync(bun).isFile()) throw new WorkerError("invalid_command");
  return { prefix, bun };
}

async function openPluginHost(directory: string): Promise<void> {
  for (;;) {
    let requested: Installation | undefined;
    const host = await openTerminalHost({ directory, afterSequence: "current",
      onPrepareInstallation: installation => { requested = installation; } });
    await host.closed;
    if (!requested) return;
    try {
      const { prefix, bun } = omoPreparationInputs(requested);
      process.stdout.write("Preparing isolated OmO update runner. No update submitted.\n");
      await runPlugin("prepare-omo", directory, [prefix, bun]);
      process.stdout.write("Preparation finished. Select the installation again and confirm the update in the UI.\n");
    } catch (error) {
      console.error(`Preparation failed: ${failureText(error).slice(0, 2048)}`);
      process.stdout.write("No update was submitted. Existing installations and jobs were not retried.\n");
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if ((await prompt.question("Press Enter to return to the catalog, or q then Enter to close: ")).trim().toLowerCase() === "q")
          return;
      } finally { prompt.close(); }
    }
  }
}

export async function registerPreparedRuntime(runtimePath: string, prepared: UpdateFilePin): Promise<void> {
  const ids = (value: unknown): string[] => {
    if (typeof value !== "object" || value === null) throw new WorkerError("invalid_command");
    if ("profile" in value && value.profile === RESTART_RUNTIME_PROFILE)
      return [validateRestartRuntimeInputs(value).installation.installationId];
    if ("profiles" in value && Array.isArray(value.profiles)) return value.profiles.flatMap(ids);
    if (!("update" in value)) throw new WorkerError("invalid_command");
    const update = value.update as { qualification?: { installation?: { installationId?: unknown } } };
    const id = update.qualification?.installation?.installationId;
    if (typeof id !== "string") throw new WorkerError("invalid_command");
    return [id];
  };
  const freshIds = ids(JSON.parse(readFileSync(prepared.path, "utf8"))), configurations: UpdateFilePin[] = [];
  if (existsSync(runtimePath)) {
    const bytes = readFileSync(runtimePath), previous: unknown = JSON.parse(bytes.toString("utf8"));
    const archived = `${runtimePath}.${randomUUID()}.previous`;
    if (typeof previous === "object" && previous !== null && "profile" in previous
      && previous.profile === RUNTIME_SET_PROFILE && "configurations" in previous && Array.isArray(previous.configurations)) {
      for (const entry of previous.configurations as UpdateFilePin[]) {
        const content = readFileSync(entry.path);
        if (createHash("sha256").update(content).digest("hex") !== entry.sha256) throw new WorkerError("invalid_command");
        if (!ids(JSON.parse(content.toString("utf8"))).some(id => freshIds.includes(id))) configurations.push(entry);
      }
    } else if (!ids(previous).some(id => freshIds.includes(id))) configurations.push({ path: archived,
      sha256: createHash("sha256").update(bytes).digest("hex") });
    await rename(runtimePath, archived);
  }
  configurations.push(prepared);
  configurePluginRuntime(runtimePath, { schemaVersion: 1, profile: RUNTIME_SET_PROFILE, configurations });
}

/** Manifest adapter; the host owns attachment, not worker lifetime. */
export async function runPlugin(command: string | undefined, directory = defaultWorkerDirectory,
  args: readonly string[] = process.argv.slice(3)): Promise<void> {
  const runtimePath = process.env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"] ?? join(directory, "..", "runtime.json");
  if (existsSync(runtimePath)) process.env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"] = runtimePath;
  if (!process.env["HERDR_SOCKET"] && process.env["HERDR_SOCKET_PATH"])
    process.env["HERDR_SOCKET"] = process.env["HERDR_SOCKET_PATH"];
  switch (command) {
    case "prepare": {
      const input = args[0], socket = process.env["HERDR_SOCKET"];
      if (!input || args.length !== 1 || !socket) throw new WorkerError("invalid_command");
      await preparePluginRuntime(input, runtimePath, { directory, coreSocket: socket });
      process.stdout.write(`runtime prepared: ${runtimePath}\n`);
      return;
    }
    case "launch": {
      const socket = process.env["HERDR_SOCKET"], pane = args[0], profile = args[1];
      if (!socket || !pane || !profile || args.length !== 2
        || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(pane) || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile))
        throw new WorkerError("invalid_command");
      const signal = AbortSignal.timeout(30_000);
      const core = await CoreOperationsClient.discover(socket, signal);
      await core.request({ action: "inspect", pane_id: pane }, signal);
      const connection: unknown = JSON.parse(process.env["HERDR_UPDATER_CONNECTION_JSON"] ?? "null");
      if (typeof connection !== "object" || connection === null || !("native_abi" in connection)
        || connection.native_abi !== 4 || !("native_launch_v1" in connection) || connection.native_launch_v1 !== true
        || !("operations_directory" in connection) || typeof connection.operations_directory !== "string"
        || !connection.operations_directory.startsWith("/") || !("profiles_directory" in connection)
        || connection.profiles_directory !== join(connection.operations_directory, "profiles"))
        throw new WorkerError("invalid_command");
      const operations = join(connection.operations_directory, "operations.jsonl");
      const operationId = `plugin-launch-${randomUUID()}`;
      const observer = core.observeOperation(operationId, operations, signal, Bun.which("node") ?? undefined);
      try {
        await observer.ready;
        const launched = await core.request({ action: "launch", operation_id: operationId, pane_id: pane, profile }, signal);
        const completed = launched.receipt?.status === "in_progress" ? await observer.completed : launched;
        if (!completed.native_qualified || completed.recovery_required || !completed.binding
          || completed.receipt?.status !== "completed") throw new OperationFailure("native_launch_incomplete");
        process.stdout.write(JSON.stringify({ kind: "managed-session", paneId: completed.binding.pane_id,
          conversationId: completed.binding.session.full_id, generation: completed.binding.generation }) + "\n");
      } finally { await observer.close(); }
      return;
    }
    case "action": {
      const binary = process.env["HERDR_BIN_PATH"];
      if (!binary || !binary.startsWith("/")) throw new WorkerError("invalid_command");
      const child = Bun.spawn([binary, "plugin", "pane", "open", "--plugin", "beomq.cli-updater",
        "--entrypoint", "updater", "--placement", "overlay", "--focus"],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
      if (await child.exited !== 0) throw new WorkerError("startup_failed");
      return;
    }
    case "configure": {
      const inputPath = process.argv[3];
      if (!inputPath || process.argv.length !== 4 || !inputPath.startsWith("/"))
        throw new WorkerError("invalid_command");
      const input = lstatSync(inputPath);
      if (realpathSync(inputPath) !== inputPath || !input.isFile() || input.nlink !== 1
        || input.uid !== process.getuid?.() || (input.mode & 0o777) !== 0o600)
        throw new PluginRuntimeError("configuration");
      const data: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
      configurePluginRuntime(runtimePath, data);
      console.log(`Runtime configuration saved: ${runtimePath}\nRestart the updater worker to apply it.`);
      return;
    }
    case "doctor": {
      const root = await realpath(await mkdtemp(join(tmpdir(), "updater-doctor-")));
      const source = createCatalogSourceOwner(join(root, "worker"), {
        home: process.env["HOME"] ?? dirname(directory), path: process.env["PATH"] ?? "",
        prefixes: (process.env["HERDR_CLI_UPDATER_SOURCE_PREFIXES"] ?? "").split(":").filter(Boolean),
        ...(process.env["HERDR_SOCKET"] ? { socket: process.env["HERDR_SOCKET"] } : {}),
        ...(process.env["XDG_CONFIG_HOME"] ? { configHome: process.env["XDG_CONFIG_HOME"] } : {}),
      });
      try {
        const observed = await source.refresh();
        console.log(`CLI discovery: ${observed.state} | ${observed.candidates.length} verified installations`);
        for (const row of observed.candidates) console.log(`  ${row.installation.family}: ${row.installation.executableRealpath}`);
        for (const row of observed.failures) console.log(`  ${row.code}: ${row.sourcePath}`);
        if (observed.state !== "complete" && observed.failures.length === 0)
          console.log("Discovery stopped at its time or size limit. Run doctor again after other work finishes.");
        console.log("No update was executed. Run `bun scripts/plugin.ts open` to open the UI, or press u there to retry.");
        if (observed.state !== "complete") process.exitCode = 1;
      } finally {
        await source.close();
        await rm(root, { recursive: true });
      }
      return;
    }
    case undefined:
    case "open": {
      await startWorker(directory);
      await openPluginHost(directory);
      return;
    }
    case "start":
      await startWorker(directory);
      return;
    case "prepare-omo": {
      if (!process.env["HERDR_SOCKET"]) throw new WorkerError("invalid_command");
      const defaults = args.length === 0 ? omoPreparationInputs() : undefined;
      const prefix = defaults?.prefix ?? args[0], bun = defaults?.bun ?? args[1], socket = process.env["HERDR_SOCKET"];
      if ((args.length !== 0 && args.length !== 2) || !prefix || !bun || !socket || !isAbsolute(prefix) || !isAbsolute(bun))
        throw new WorkerError("invalid_command");
      const anchor = preparationAnchor(socket);
      await startWorker(directory);
      await idleWorker(directory);
      const parent = `${directory}-preparations`;
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700
        || realpathSync(parent) !== parent) throw new WorkerError("invalid_command");
      const lock = join(parent, ".preparing");
      await mkdir(lock, { mode: 0o700 });
      try {
      const preparation = await mkdtemp(join(parent, "omo-"));
      process.stdout.write("Preparing OmO source, isolated copies and runner qualification. Operating globals unchanged.\n");
      const prepared = await prepareOmoInstallationRuntime({ directory: preparation, prefix, bun,
        ownerDirectory: directory, socketDirectory: directory, registeredSockets: [], rootPids: [anchor] },
      { keepFailedArtifacts: process.env["HERDR_CLI_UPDATER_KEEP_FAILED_PREPARATION"] === "1" });
      await idleWorker(directory);
      process.stdout.write("Registering prepared runner after authenticated idle-worker retirement.\n");
      await registerPreparedRuntime(runtimePath, prepared.configurationPin);
      process.env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"] = runtimePath;
      await retireWorker(directory);
      await startWorker(directory);
      await idleWorker(directory);
      retainPreparations(parent, registeredPreparationRoots(runtimePath, parent));
      process.stdout.write(`OmO update-only registration prepared. Operating installation unchanged.\n${prepared.configurationPin.path}\n`);
      } finally { await rm(lock, { recursive: true }); }
      return;
    }
    case "prepare-npm": {
      const [prefix, executable, npm, node] = args;
      const socket = process.env["HERDR_SOCKET"];
      if (args.length !== 4 || !prefix || !executable || !npm || !node || !socket
        || [prefix, executable, npm, node].some(path => !isAbsolute(path))) throw new WorkerError("invalid_command");
      const anchor = preparationAnchor(socket);
      await startWorker(directory);
      await idleWorker(directory);
      const owner = discoverWorker(directory), parent = `${directory}-preparations`;
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700
        || realpathSync(parent) !== parent) throw new WorkerError("invalid_command");
      const lock = join(parent, ".preparing");
      await mkdir(lock, { mode: 0o700 });
      try {
      const preparation = await mkdtemp(join(parent, "npm-"));
      const control = lstatSync(owner.controlPath).isSymbolicLink()
        ? resolve(directory, readlinkSync(owner.controlPath))
        : owner.controlPath;
      if (control !== owner.controlPath && control !== join(directory, `c${owner.incarnation.slice(0, 8)}`))
        throw new WorkerError("invalid_command");
      const prepared = await prepareNpmInstallationRuntime({ directory: preparation, prefix, executable, npm, node,
        ownerDirectory: directory, socketDirectory: directory,
        registeredSockets: [owner.socketPath, control], rootPids: [anchor] });
      await idleWorker(directory);
      await registerPreparedRuntime(runtimePath, prepared.configurationPin);
      process.env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"] = runtimePath;
      await retireWorker(directory);
      await startWorker(directory);
      await idleWorker(directory);
      retainPreparations(parent, registeredPreparationRoots(runtimePath, parent));
      process.stdout.write(`Update-only registration prepared. Operating installation unchanged.\n${prepared.configurationPin.path}\n`);
      } finally { await rm(lock, { recursive: true }); }
      return;
    }
    case "reload": {
      if (existsSync(directory)) {
        await idleWorker(directory);
        await retireWorker(directory);
      }
      await startWorker(directory);
      return;
    }
    case "tui": {
      await openPluginHost(directory);
      return;
    }
    case "stop":
      await stopWorker(discoverWorker(directory));
      return;
    default:
      throw new WorkerError("invalid_command");
  }
}
if (import.meta.main) {
  try {
    await runPlugin(process.argv[2], process.env["HERDR_CLI_UPDATER_DIRECTORY"] ?? defaultWorkerDirectory);
  } catch (error) {
    console.error(failureText(error));
    process.exitCode = 1;
  } finally {
    // The host restores the flowing baseline; this CLI owns stdin's process ref.
    if ((process.argv[2] === undefined || process.argv[2] === "open" || process.argv[2] === "tui") && process.stdin.isTTY) {
      process.stdin.pause();
      process.stdin.unref();
    }
  }
}
