import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { validateRequest } from "../protocol";
import { connectPrivateSocket, startPrivateSocket, stopPrivateSocket, TransportError } from "./socket";
import type { PrivateEndpoint, RequestHandler } from "./socket";
import { createDomain } from "./domain";
import type { CatalogReaders } from "../catalog";
import { JobError } from "../jobs/jobs";
import { createAutomaticCatalogProvider } from "./catalog-provider";
import { createCatalogSourceOwner } from "./catalog-sources";
import type { CatalogSourceEnvironment, CatalogSourceOwner } from "./catalog-sources";
import { createUpdateOnlyJobRunner } from "./job-runner";
import type { UpdateOnlyRunnerConfiguration } from "./job-runner";
import { loadPluginRuntime, PluginRuntimeError } from "./plugin-runtime";

// allow: SIZE_OK — plan4's single lifecycle owner keeps teardown and captured file identities together.
export class WorkerError extends Error {
  constructor(readonly code: "identity_mismatch" | "startup_failed" | "missing_view" | "invalid_command") {
    super(code);
    this.name = "WorkerError";
  }
}
export class WorkerShutdownError extends AggregateError {
  readonly code = "cleanup_failed";
  constructor(errors: readonly unknown[], readonly remainingOwnedPaths: readonly string[]) {
    super(errors, "cleanup_failed");
    this.name = "WorkerShutdownError";
  }
}
export type WorkerOwner = PrivateEndpoint & {
  readonly pid: number;
  readonly executableRealpath: string;
  readonly controlPath: string;
};
export const defaultWorkerDirectory = join(homedir(), ".local", "share", "herdr-cli-updater", "worker");
export type PrivateRunnerFactory = (context: {
  readonly directory: string;
  readonly owner: WorkerOwner;
  readonly coreSocket: string;
}) => Promise<{
  readonly runner: Omit<UpdateOnlyRunnerConfiguration, "store" | "owner" | "publication">;
  readonly readers: CatalogReaders | ((signal?: AbortSignal, operation?: import("../protocol").Operation) => CatalogReaders | Promise<CatalogReaders>);
}>;
function privateFactory(value: unknown): value is { readonly createPrivateRunnerConfiguration: PrivateRunnerFactory } {
  return typeof value === "object" && value !== null
    && "createPrivateRunnerConfiguration" in value && typeof value.createPrivateRunnerConfiguration === "function";
}

function owner(value: unknown, directory: string): WorkerOwner {
  if (typeof value !== "object" || value === null
    || !("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !("incarnation" in value) || typeof value.incarnation !== "string" || !/^[a-f0-9-]{36}$/.test(value.incarnation)
    || !("executableRealpath" in value) || typeof value.executableRealpath !== "string"
    || !("directory" in value) || value.directory !== directory
    || !("socketPath" in value) || value.socketPath !== join(directory, "service.sock")
    || !("tokenPath" in value) || value.tokenPath !== join(directory, "capability")
    || !("controlPath" in value) || value.controlPath !== join(directory, "control.sock")) {
    throw new WorkerError("identity_mismatch");
  }
  return { directory, socketPath: value.socketPath, tokenPath: value.tokenPath,
    controlPath: value.controlPath, incarnation: value.incarnation, pid: value.pid,
    executableRealpath: value.executableRealpath };
}
function privateFile(path: string, mode: number): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== mode) {
    throw new WorkerError("identity_mismatch");
  }
}
export function discoverWorker(directory = defaultWorkerDirectory): WorkerOwner {
  privateFile(directory, 0o700);
  privateFile(join(directory, "owner.json"), 0o600);
  return owner(JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")), directory);
}
async function control(expected: WorkerOwner, action: "status" | "stop"): Promise<WorkerOwner> {
  privateFile(expected.tokenPath, 0o600);
  privateFile(expected.controlPath, 0o600);
  const response = await fetch("http://worker/lifecycle", {
    unix: expected.controlPath, method: "POST", signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ action, incarnation: expected.incarnation, pid: expected.pid,
      executableRealpath: expected.executableRealpath,
      token: readFileSync(expected.tokenPath, "utf8") }),
  });
  if (!response.ok) throw new WorkerError("identity_mismatch");
  const actual = owner(await response.json(), expected.directory);
  if (actual.incarnation !== expected.incarnation || actual.pid !== expected.pid
    || actual.executableRealpath !== expected.executableRealpath) throw new WorkerError("identity_mismatch");
  return actual;
}
export async function attachWorker(directory = defaultWorkerDirectory) {
  const identity = await control(discoverWorker(directory), "status");
  const client = await connectPrivateSocket(identity.socketPath, new AbortController().signal);
  return { owner: identity, client, close: () => client.close() };
}
/** Stop addresses the authenticated incarnation, never a discovered/reused PID. */
export async function stopWorker(identity: WorkerOwner): Promise<void> {
  const paths = [identity.socketPath, identity.tokenPath, identity.controlPath, join(identity.directory, "owner.json")];
  const owned = paths.map(path => ({ path, stat: lstatSync(path) }));
  const removed = Promise.withResolvers<void>();
  const signal = AbortSignal.timeout(5000);
  const retired = () => {
    if (owned.every(({ path, stat }) => {
      const current = lstatSync(path, { throwIfNoEntry: false });
      return !current || current.dev !== stat.dev || current.ino !== stat.ino;
    })) removed.resolve();
  };
  const watchers = [watch(dirname(identity.directory), retired), watch(identity.directory, retired),
    watch(identity.tokenPath, retired), watch(join(identity.directory, "owner.json"), retired)];
  const abort = () => removed.reject(new WorkerError("startup_failed"));
  signal.addEventListener("abort", abort, { once: true });
  // Observe file retirement before triggering shutdown. No PID kill or retry.
  try {
    await Promise.all([control(identity, "stop").then(() => { retired(); }, error => {
      removed.reject(error);
      throw error;
    }), removed.promise]);
  } finally {
    for (const watcher of watchers) watcher.close();
    signal.removeEventListener("abort", abort);
  }
}

/** Handler work belongs to the worker, not the socket consumer's abort signal.
 * The caller must connect real durable domain storage; this layer has no job model.
 */
export function serveWorker(directory: string, handler: RequestHandler, closeDomain?: () => void | Promise<void>) {
  const controller = new AbortController();
  const active = new Set<Promise<unknown>>();
  let stopping = false;
  const transport = startPrivateSocket(directory, (request) => {
    if (stopping) return { version: 1, requestId: request.requestId, operation: request.operation,
      ok: false, error: { code: "resources_busy" } };
    const work = Promise.resolve().then(() => handler(request, controller.signal));
    active.add(work);
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  });
  const identity: WorkerOwner = { ...transport.endpoint, pid: process.pid,
    executableRealpath: realpathSync(process.execPath), controlPath: join(directory, "control.sock") };
  const registryPath = join(directory, "owner.json");
  const directoryIdentity = lstatSync(directory);
  const serviceIdentity = lstatSync(identity.socketPath);
  const tokenIdentity = lstatSync(identity.tokenPath);
  const capability = readFileSync(identity.tokenPath, "utf8");
  const bindPath = join(directory, `c${identity.incarnation.slice(0, 8)}`);
  let registryIdentity: ReturnType<typeof lstatSync> | undefined;
  let controlIdentity: ReturnType<typeof lstatSync> | undefined;
  const done = Promise.withResolvers<void>();
  // Completion remains rejected for callers, even when only stop() is awaited.
  void done.promise.catch(error => {
    if (!(error instanceof WorkerShutdownError)) throw error;
  });
  let http: ReturnType<typeof Bun.serve> | undefined;
  function removeOwned(path: string, saved: ReturnType<typeof lstatSync> | undefined): void {
    if (!saved) return;
    const currentDirectory = lstatSync(directory, { throwIfNoEntry: false });
    if (!currentDirectory || currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino) return;
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (current?.dev === saved.dev && current.ino === saved.ino) unlinkSync(path);
  }
  async function shutdown(): Promise<void> {
    const errors: unknown[] = [];
    try {
      controller.abort();
      await Promise.allSettled([...active]);
      await http?.stop(false);
    } catch (error) { errors.push(error); }
    finally {
      // A failure retiring one resource must not skip the other owned resources.
      for (const cleanup of [
        () => closeDomain?.(),
        () => removeOwned(identity.controlPath, controlIdentity),
        () => removeOwned(registryPath, registryIdentity),
        () => stopPrivateSocket(transport),
        () => removeOwned(identity.socketPath, serviceIdentity),
        () => removeOwned(identity.tokenPath, tokenIdentity),
      ]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }
    if (errors.length) {
      const remaining: string[] = [];
      for (const [path, saved] of [
        [identity.controlPath, controlIdentity], [registryPath, registryIdentity],
        [identity.socketPath, serviceIdentity], [identity.tokenPath, tokenIdentity],
      ] as const) {
        try {
          const current = lstatSync(path, { throwIfNoEntry: false });
          if (saved && current?.dev === saved.dev && current.ino === saved.ino) remaining.push(path);
        } catch (error) { errors.push(error); remaining.push(path); }
      }
      throw new WorkerShutdownError(errors, remaining);
    }
  }
  function stop(): Promise<void> {
    if (!stopping) {
      stopping = true;
      void shutdown().then(done.resolve, done.reject);
    }
    return done.promise;
  }
  const onSignal = () => { void stop(); };
  try {
    http = Bun.serve({
      unix: bindPath,
      async fetch(request) {
        const input: unknown = await request.json().catch(() => null);
        if (typeof input !== "object" || input === null || !("token" in input)
          || !("incarnation" in input) || input.incarnation !== identity.incarnation
          || !("pid" in input) || input.pid !== identity.pid
          || !("executableRealpath" in input) || input.executableRealpath !== identity.executableRealpath
          || !("action" in input) || (input.action !== "status" && input.action !== "stop")
          || Object.keys(input).length !== 5
          || !validateRequest({ version: 1, requestId: "lifecycle", operation: "jobs", token: input.token },
            capability).ok) return new Response(null, { status: 403 });
        if (input.action === "stop") void stop();
        return Response.json(identity, { headers: { connection: "close" } });
      },
    });
    chmodSync(bindPath, 0o600);
    controlIdentity = lstatSync(bindPath);
    renameSync(bindPath, identity.controlPath);
    writeFileSync(registryPath, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
    registryIdentity = lstatSync(registryPath);
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  } catch (error) {
    void stop();
    throw error;
  }
  return { owner: identity, transport, stop, closed: done.promise };
}

export const unsupportedDomainHandler: RequestHandler = request => ({
  version: 1, requestId: request.requestId, operation: request.operation,
  ok: false, error: { code: "unsupported" },
});

/** Acquire socket ownership before opening durable storage. Startup failure
 * retires this worker only; a foreign owner never authorizes a database open.
 */
export async function serveDomainWorker(directory: string,
  readers?: CatalogReaders | ((signal?: AbortSignal, operation?: import("../protocol").Operation) => CatalogReaders | Promise<CatalogReaders>),
  environment: CatalogSourceEnvironment = {
    home: homedir(), path: process.env["PATH"] ?? "",
    prefixes: process.env["HERDR_CLI_UPDATER_SOURCE_PREFIXES"] === undefined
      ? ["/opt/homebrew", "/usr/local"] : (process.env["HERDR_CLI_UPDATER_SOURCE_PREFIXES"] ?? "").split(":").filter(Boolean),
    ...(process.env["XDG_CONFIG_HOME"] ? { configHome: process.env["XDG_CONFIG_HOME"] } : {}),
    ...(process.env["HERDR_SOCKET"] ? { socket: process.env["HERDR_SOCKET"] } : {}),
  }, runnerConfiguration?: Omit<UpdateOnlyRunnerConfiguration, "store" | "owner" | "publication">,
  runtimeLoader: typeof loadPluginRuntime = loadPluginRuntime) {
  let domain: ReturnType<typeof createDomain> | undefined;
  let sources: CatalogSourceOwner | undefined;
  let configured = runnerConfiguration;
  const worker = serveWorker(directory, (request, signal) => {
    if (!domain) throw new WorkerError("startup_failed");
    return domain.handle(request, signal);
  }, async () => {
    try { await domain?.close(); }
    finally { try { await sources?.close(); } finally { configured?.queue.close(); } }
  });
  try {
    let privateReaders: CatalogReaders | ((signal?: AbortSignal, operation?: import("../protocol").Operation) => CatalogReaders | Promise<CatalogReaders>) | undefined;
    const factoryPath = process.env["HERDR_CLI_UPDATER_RUNNER_FACTORY"];
    const runtimePath = process.env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"];
    if (!configured && !factoryPath && runtimePath) {
      const runtime = await runtimeLoader({ directory, coreSocket: environment.socket ?? "" }, runtimePath);
      if (runtime.kind === "configured") {
        configured = runtime.runner;
        privateReaders = runtime.readers;
      } else if (runtime.kind === "unsupported" && (runtime.reason === "qualification" || runtime.reason === "inputs")) {
        // Expired/refused update authority must not prevent read-only discovery.
        // No runner or private candidates survive this refusal.
        console.error(`runtime_${runtime.reason}: updater is read-only; prepare fresh runtime inputs`);
      } else throw new PluginRuntimeError(runtime.kind === "unsupported" ? runtime.reason : "configuration");
    }
    if (!configured && factoryPath) {
      // Only an explicitly approved owned executable configuration is imported.
      // Wire/catalog JSON never selects a module or constructs this authority.
      const stat = lstatSync(factoryPath), parent = lstatSync(dirname(factoryPath));
      if (!factoryPath.startsWith("/") || realpathSync(factoryPath) !== factoryPath
        || !/\.(?:mjs|ts)$/.test(factoryPath) || !stat.isFile() || stat.nlink !== 1
        || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
        || !parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700
        || !environment.socket?.startsWith("/")) throw new WorkerError("startup_failed");
      const exported: unknown = await import(pathToFileURL(factoryPath).href);
      if (!privateFactory(exported)) throw new WorkerError("startup_failed");
      const result = await exported.createPrivateRunnerConfiguration({ directory, owner: worker.owner, coreSocket: environment.socket });
      configured = result.runner;
      privateReaders = result.readers;
    }
    let provider = readers ?? privateReaders;
    if (!readers) {
      const privateMutationRoots = configured?.profiles?.flatMap(profile =>
        [...(profile.mutationRoots ?? []), ...(profile.catalogRoots ?? [])]) ?? [];
      const automatic = createAutomaticCatalogProvider(directory,
        sources = createCatalogSourceOwner(directory, environment, undefined, privateMutationRoots));
      if (!privateReaders) provider = automatic;
      else {
        const approved = privateReaders;
        provider = async (signal, operation) => {
          const primary = typeof approved === "function" ? await approved(signal, operation) : approved;
          const secondary = await automatic(signal, operation);
          const primaryValues = await Promise.all(primary.candidates.map(row => row.installationId === undefined ? row.read() : undefined));
          const identities = new Set(primary.candidates.flatMap((row, index) => row.installationId !== undefined ? [row.installationId]
            : primaryValues[index]?.ok ? [primaryValues[index]!.value.contract.installation.installationId] : []));
          return { candidates: [
            ...primary.candidates.map((row, index) => primaryValues[index] === undefined ? row : ({ ...row, read: async () => primaryValues[index]! })),
            ...secondary.candidates.filter(row => row.installationId === undefined || !identities.has(row.installationId)),
          ], sockets: [...primary.sockets, ...secondary.sockets.filter(row => !primary.sockets.some(p => p.socketId === row.socketId))],
          runtimeSources: [...(primary.runtimeSources ?? []), ...(secondary.runtimeSources ?? [])
            .filter(row => !primary.runtimeSources?.some(p => p.socketId === row.socketId
              || p.socketId === `socket:${createHash("sha256").update(row.socketId).digest("hex")}`))],
          displaySources: [...(primary.displaySources ?? []), ...(secondary.displaySources ?? []),
            ...(secondary.runtimeSources ?? []).filter(row => primary.runtimeSources?.some(p => p.socketId === row.socketId
              || p.socketId === `socket:${createHash("sha256").update(row.socketId).digest("hex")}`))],
          ...(primary.registrationFailure || secondary.registrationFailure
            ? { registrationFailure: primary.registrationFailure ?? secondary.registrationFailure } : {}),
          check: (installation, checkSignal) => identities.has(installation.installationId)
            ? primary.check?.(installation, checkSignal) ?? Promise.resolve({ ok: false as const, error: { code: "unsupported" as const } })
            : secondary.check?.(installation, checkSignal) ?? Promise.resolve({ ok: false as const, error: { code: "unsupported" as const } }),
          };
        };
      }
    }
    // Initial source acquisition precedes IPC-ready. Explicit registries skip it.
    if (!readers && typeof provider === "function") await provider();
    const publication = {
      get sequence() { return worker.transport.sequence; },
      admit: response => {
        if (!worker.transport.canPublish(response)) throw new JobError("resources_busy");
        return null;
      },
      publish: response => { worker.transport.publish(response); },
    } satisfies UpdateOnlyRunnerConfiguration["publication"];
    const runner = configured;
    domain = createDomain(directory, provider, publication, runner
      ? store => createUpdateOnlyJobRunner({ ...runner, store, owner: worker.owner, publication })
      : undefined);
    return worker;
  } catch (error) {
    await worker.stop();
    throw error;
  }
}

/** Readiness is a child IPC event. Disconnect/unref only after authenticated ready.
 * Existing/dirty ownership is never blindly unlinked or inferred dead from PID.
 */
export async function startWorker(directory = defaultWorkerDirectory, sources?: CatalogSourceEnvironment,
  options: { readonly entrypoint?: string; readonly runtimeConfiguration?: string | null } = {}): Promise<WorkerOwner> {
  if (existsSync(directory)) {
    const identity = discoverWorker(directory);
    return control(identity, "status");
  }
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, ...(sources ? { HOME: sources.home, PATH: sources.path,
    HERDR_CLI_UPDATER_SOURCE_PREFIXES: sources.prefixes.join(":"),
    XDG_CONFIG_HOME: sources.configHome ?? join(sources.home, ".config"),
    HERDR_SOCKET: sources.socket ?? "" } : {}) };
  if (options.runtimeConfiguration === null) delete env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"];
  else if (options.runtimeConfiguration !== undefined) env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"] = options.runtimeConfiguration;
  const child = fork(options.entrypoint ?? import.meta.path, ["--worker", directory], {
    execPath: process.execPath, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env,
  });
  const ready = Promise.withResolvers<WorkerOwner>();
  // Private startup qualifies the complete installed update payload before ready.
  const timeout = AbortSignal.timeout(env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"] ? 180_000 : 30_000);
  const abort = () => ready.reject(new WorkerError("startup_failed"));
  timeout.addEventListener("abort", abort, { once: true });
  child.once("message", message => {
    if (typeof message === "object" && message !== null && "runtimeError" in message) {
      const reasons = ["profile", "platform", "configuration", "inputs", "qualification", "native"] as const;
      const reason = reasons.find(value => value === message.runtimeError);
      if (reason) { ready.reject(new PluginRuntimeError(reason)); return; }
    }
    try { ready.resolve(owner(message, directory)); } catch (error) { ready.reject(error); }
  });
  child.once("error", ready.reject);
  const closed = Promise.withResolvers<void>();
  child.once("close", () => closed.resolve());
  child.once("exit", () => {
    ready.reject(new WorkerError("startup_failed"));
  });
  try {
    const identity = await ready.promise;
    await control(identity, "status");
    child.disconnect();
    child.unref();
    return identity;
  } catch (error) {
    // The live child handle is exact, unlike a PID read from a stale registry.
    child.kill("SIGTERM");
    await closed.promise;
    throw error;
  } finally {
    timeout.removeEventListener("abort", abort);
  }
}

if (import.meta.main) {
  try {
    const directory = process.argv[3];
    if (process.argv[2] !== "--worker" || !directory || !directory.startsWith("/")) {
      throw new WorkerError("invalid_command");
    }
    const worker = await serveDomainWorker(directory);
    process.send?.(worker.owner);
    process.once("disconnect", () => { /* Parent readiness channel is not worker ownership. */ });
    await worker.closed;
  } catch (error) {
    if (error instanceof PluginRuntimeError) process.send?.({ runtimeError: error.reason });
    process.exitCode = error instanceof TransportError || error instanceof WorkerError ? 2 : 1;
  }
}
