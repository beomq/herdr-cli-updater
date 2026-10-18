import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Subprocess } from "bun";
import { homedir } from "node:os";

export class QaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "QaError";
  }
}

export const hashBytes = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export async function fileDigest(path: string): Promise<string> {
  return hashBytes(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

export type Paths = {
  readonly root: string;
  readonly home: string;
  readonly profile: string;
  readonly prefix: string;
  readonly core: string;
  readonly sockets: string;
  readonly ptys: string;
  readonly tmp: string;
};

export type ExecutionReceipt = {
  readonly state: "observed";
  readonly runId: string;
  readonly pid: number;
  readonly executable: string;
  readonly executableSha256: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
};

type Event = { readonly event: string; readonly value: unknown };
type Waiter = { readonly event: string; readonly resolve: (value: Event) => void; readonly reject: (error: Error) => void };

// Mutable accumulator: subscriptions are registered before the process/action starts.
class Events {
  private readonly waiters = new Set<Waiter>();
  private failure: Error | undefined;

  wait(event: string, timeoutMs: number, signal?: AbortSignal): Promise<Event> {
    return new Promise((resolve, reject) => {
      if (this.failure) { reject(this.failure); return; }
      let timer: ReturnType<typeof setTimeout>;
      const finish = (action: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", abort);
        action();
      };
      const waiter: Waiter = {
        event,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      };
      const abort = () => waiter.reject(new QaError("cancelled", "event cancelled"));
      timer = setTimeout(() => waiter.reject(new QaError("deadline", `event deadline: ${event}`)), timeoutMs);
      this.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  emit(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new QaError("malformed-event", "child emitted non-JSON event");
    }
    if (typeof value !== "object" || value === null || !("event" in value) || typeof value.event !== "string") {
      throw new QaError("malformed-event", "child event requires a string event field");
    }
    for (const waiter of this.waiters) {
      if (waiter.event === value.event) waiter.resolve({ event: value.event, value });
    }
  }

  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters) waiter.reject(error);
  }
}

function deadline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (action: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(new QaError("cancelled", "run cancelled")));
    const timer = setTimeout(() => finish(() => reject(new QaError("deadline", "run deadline"))), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

export type SpawnOptions = {
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly readyEvent?: string;
  readonly eventTimeoutMs?: number;
  readonly rustc?: string;
};

export class OwnedChild {
  readonly ready: Promise<Event> | undefined;
  readonly exited: Promise<number>;
  readonly completed: Promise<ExecutionReceipt>;
  private readonly child: Subprocess<"pipe", "pipe", "pipe">;
  private readonly events = new Events();
  private ended = false;

  constructor(
    readonly runId: string,
    readonly executable: string,
    readonly executableSha256: string,
    readonly argv: readonly [string, ...string[]],
    readonly cwd: string,
    readonly env: Readonly<Record<string, string>>,
    options: SpawnOptions,
    signal?: AbortSignal,
  ) {
    this.ready = options.readyEvent
      ? this.events.wait(options.readyEvent, options.eventTimeoutMs ?? 2000, signal)
      : undefined;
    // Prevent unhandled rejection while caller is still acquiring the handle.
    this.ready?.catch((error: unknown) => { if (!(error instanceof Error)) throw error; });
    try {
      this.child = Bun.spawn([...argv], { cwd, env: { ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      const failure = error instanceof Error ? error : new QaError("spawn", String(error));
      this.events.fail(failure);
      throw error;
    }
    this.exited = this.child.exited.then((code) => {
      this.ended = true;
      return code;
    });
    const stdout = this.readOutput(this.child.stdout, Boolean(options.readyEvent));
    const stderr = new Response(this.child.stderr).text();
    this.completed = Promise.all([stdout, stderr, this.exited]).then(([output, errorOutput, exitCode]): ExecutionReceipt => {
      this.events.fail(new QaError("exited", `child exited ${exitCode}`));
      return Object.freeze({
        state: "observed", runId, pid: this.child.pid, executable, executableSha256, cwd,
        argv: Object.freeze([...argv]), env: Object.freeze({ ...env }),
        exitCode, signal: this.child.signalCode, stdout: output, stderr: errorOutput,
        stdoutSha256: hashBytes(output), stderrSha256: hashBytes(errorOutput),
      });
    });
  }

  private async readOutput(stream: ReadableStream<Uint8Array>, parseEvents: boolean): Promise<string> {
    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    let lines = "";
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (parseEvents) {
        lines += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = lines.indexOf("\n")) !== -1) {
          const line = lines.slice(0, newline);
          lines = lines.slice(newline + 1);
          try { this.events.emit(line); }
          catch (error) {
            if (!(error instanceof Error)) throw error;
            this.events.fail(error);
          }
        }
      }
    }
    if (parseEvents && lines.trim()) this.events.fail(new QaError("malformed-event", "unterminated event"));
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  waitFor(event: string, timeoutMs = 2000, signal?: AbortSignal): Promise<Event> {
    return this.events.wait(event, timeoutMs, signal);
  }

  write(input: string): void { this.child.stdin.write(input); this.child.stdin.flush(); }
  signal(signal: NodeJS.Signals): void { if (!this.ended) this.child.kill(signal); }

  async stop(timeoutMs: number): Promise<ExecutionReceipt> {
    if (!this.ended) this.child.kill("SIGTERM");
    try { return await deadline(this.completed, timeoutMs); }
    catch (error) {
      if (!(error instanceof QaError) || error.code !== "deadline") throw error;
      // Only this retained spawn handle can be killed; never an ambient/reused PID.
      if (!this.ended) this.child.kill("SIGKILL");
      return await deadline(this.completed, timeoutMs);
    }
  }
}

export type CleanupReceipt = {
  readonly root: string;
  readonly rootRemoved: boolean;
  readonly actionState: "joined" | "pending";
  readonly processes: readonly { readonly pid: number; readonly exitCode: number; readonly signal: NodeJS.Signals | null }[];
  readonly resourcesRemaining: number;
};

export class RunFailure extends QaError {
  constructor(
    readonly original: unknown,
    readonly cleanup: CleanupReceipt,
    readonly executions: readonly ExecutionReceipt[],
    readonly finalCleanup: Promise<CleanupReceipt>,
  ) {
    super(cleanup.actionState === "pending" ? "action-unjoined" : "run-failed", original instanceof Error ? original.message : String(original));
  }
}

const scopeOwner = Symbol("QA isolation owner");

export class QaContext {
  readonly runId = crypto.randomUUID();
  readonly executions: ExecutionReceipt[] = [];
  private readonly children: OwnedChild[] = [];
  private readonly operations = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private closed = false;
  private readonly detachExternal: () => void;
  constructor(readonly paths: Paths, externalSignal: AbortSignal | undefined, authority: typeof scopeOwner) {
    if (authority !== scopeOwner) throw new QaError("scope-owner", "context requires an owned isolation scope");
    const abort = () => this.controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    this.detachExternal = () => externalSignal?.removeEventListener("abort", abort);
  }

  assertOpen(): void {
    if (this.closed) throw new QaError("closed", "owned run already closing");
    if (this.signal.aborted) throw new QaError("cancelled", "run cancelled before admission");
  }

  // Tracks admitted asynchronous effects, including acquisitions not awaited by the action.
  admit<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const pending = operation();
    this.operations.add(pending);
    pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending));
    return pending;
  }

  beginClose(reason: unknown): void {
    this.closed = true;
    this.controller.abort(reason);
    this.detachExternal();
  }

  async operationsSettled(): Promise<void> {
    await Promise.allSettled([...this.operations]);
  }

  environment(executable: string, rustc?: string): Readonly<Record<string, string>> {
    return {
      HOME: this.paths.home, USERPROFILE: this.paths.home,
      XDG_CONFIG_HOME: this.paths.profile, XDG_DATA_HOME: join(this.paths.profile, "data"),
      XDG_STATE_HOME: join(this.paths.profile, "state"), XDG_CACHE_HOME: join(this.paths.profile, "cache"),
      XDG_RUNTIME_DIR: this.paths.sockets, TMPDIR: this.paths.tmp, TMP: this.paths.tmp,
      PATH: `${dirname(executable)}:/usr/bin:/bin`, LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      CARGO_HOME: join(this.paths.home, "cargo"), RUSTUP_HOME: join(this.paths.home, "rustup"),
      CARGO_TARGET_DIR: join(this.paths.core, "target"), ZIG_GLOBAL_CACHE_DIR: join(this.paths.tmp, "zig"),
      RUSTUP_AUTO_INSTALL: "0", RUSTUP_NO_UPDATE_CHECK: "1",
      CARGO_NET_OFFLINE: "true", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0",
      ...(rustc ? { RUSTC: rustc, RUSTDOC: join(dirname(rustc), "rustdoc") } : {}),
      HERDR_SOCKET: join(this.paths.sockets, "core.sock"), QA_PREFIX: this.paths.prefix,
      QA_CORE: this.paths.core, QA_PTYS: this.paths.ptys,
    };
  }

  spawn(options: SpawnOptions): Promise<OwnedChild> {
    return this.admit(async () => {
    if (!isAbsolute(options.argv[0])) throw new QaError("executable", "absolute executable required");
    const executable = await realpath(options.argv[0]);
    const cwd = await realpath(options.cwd ?? this.paths.root);
    if (!isAbsolute(cwd) || relative(this.paths.root, cwd).startsWith("..")) {
      throw new QaError("cwd", "cwd must be task owned");
    }
    const digest = await fileDigest(executable);
    this.assertOpen();
    const child = new OwnedChild(this.runId, executable, digest,
      [executable, ...options.argv.slice(1)], cwd, this.environment(executable, options.rustc), options, this.signal);
    this.children.push(child);
    return child;
    });
  }

  async invoke(argv: readonly [string, ...string[]], timeoutMs = 15000, cwd?: string, rustc?: string): Promise<ExecutionReceipt> {
    return await this.admit(async () => {
      const child = await this.spawn({ argv, ...(cwd ? { cwd } : {}), ...(rustc ? { rustc } : {}) });
      return await deadline(child.completed, timeoutMs, this.signal);
    });
  }

  async stopChildren(): Promise<void> {
    const results = await Promise.allSettled(this.children.map((child) => child.stop(2000)));
    const failures: unknown[] = [];
    for (const result of results) {
      switch (result.status) {
        case "fulfilled": this.executions.push(result.value); break;
        case "rejected": failures.push(result.reason); break;
      }
    }
    // Do not erase the only process resource record on cleanup failure.
    if (failures.length) throw new AggregateError(failures, "owned process cleanup failed");
  }

  pendingCleanup(): CleanupReceipt {
    return {
      root: this.paths.root, rootRemoved: false, actionState: "pending",
      processes: this.executions.map(({ pid, exitCode, signal }) => ({ pid, exitCode, signal })),
      resourcesRemaining: 1,
    };
  }

  async cleanup(authority: typeof scopeOwner): Promise<CleanupReceipt> {
    if (authority !== scopeOwner) throw new QaError("scope-owner", "only the joined isolation scope may issue cleanup");
    await rm(this.paths.root, { recursive: true, force: true });
    let rootRemoved = false;
    try { await stat(this.paths.root); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") rootRemoved = true;
      else throw error;
    }
    return {
      root: this.paths.root, rootRemoved, actionState: "joined",
      processes: this.executions.map(({ pid, exitCode, signal }) => ({ pid, exitCode, signal })),
      resourcesRemaining: rootRemoved ? 0 : 1,
    };
  }
}

export async function withIsolation<T>(
  action: (context: QaContext) => Promise<T>,
  options: { readonly timeoutMs?: number; readonly joinTimeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<{ readonly value: T; readonly cleanup: CleanupReceipt; readonly executions: readonly ExecutionReceipt[] }> {
  const root = await realpath(await mkdtemp("/tmp/hq-"));
  await chmod(root, 0o700);
  const paths: Paths = {
    root, home: join(root, "h"), profile: join(root, "p"), prefix: join(root, "i"),
    core: join(root, "c"), sockets: join(root, "s"), ptys: join(root, "t"), tmp: join(root, "tmp"),
  };
  const context = new QaContext(paths, options.signal, scopeOwner);
  let outcome: { readonly value: T } | undefined;
  let failure: unknown;
  let failed = false;
  let cleanup: CleanupReceipt;
  let actionSettled: Promise<void> = Promise.resolve();
  let finalCleanup: Promise<CleanupReceipt>;
  try {
    for (const path of Object.values(paths)) await mkdir(path, { recursive: true, mode: 0o700 });
    const actionPromise = Promise.resolve().then(() => {
      context.assertOpen();
      return action(context);
    });
    actionSettled = actionPromise.then(() => undefined, () => undefined);
    outcome = { value: await deadline(actionPromise, options.timeoutMs ?? 30000, context.signal) };
  } catch (error) { failure = error; failed = true; }
  finally {
    // Closing admission and cancellation happen before any teardown or join.
    context.beginClose(failure ?? new QaError("closed", "action completed"));
    await context.stopChildren();
    const quiescence = Promise.all([actionSettled, context.operationsSettled()]);
    try {
      await deadline(quiescence, options.joinTimeoutMs ?? 2000);
      cleanup = await context.cleanup(scopeOwner);
      finalCleanup = Promise.resolve(cleanup);
    } catch (error) {
      if (!(error instanceof QaError) || error.code !== "deadline") throw error;
      cleanup = context.pendingCleanup();
      // Arbitrary JavaScript cannot be cancelled. Retain ownership until it joins.
      finalCleanup = quiescence.then(() => context.cleanup(scopeOwner));
      if (!failed) { failed = true; failure = new QaError("action-unjoined", "admitted effects have not settled"); }
    }
  }
  if (failed) throw new RunFailure(failure, cleanup, context.executions, finalCleanup);
  if (!outcome) throw new QaError("outcome", "successful action result missing");
  return { value: outcome.value, cleanup, executions: context.executions };
}

export type ArchiveReceipt = {
  readonly state: "observed";
  readonly sourceRef: string;
  readonly sourceTree: string;
  readonly sourceArchiveSha256: string;
  readonly archivePath: string;
  readonly extractedRoot: string;
  readonly sourceStatus: ExecutionReceipt;
  readonly commitObservation: ExecutionReceipt;
  readonly treeObservation: ExecutionReceipt;
  readonly archive: ExecutionReceipt;
  readonly extraction: ExecutionReceipt;
};

// Module-private observations cannot be populated by receipt JSON or callers.
const archives = new WeakMap<QaContext, Map<ArchiveReceipt, {
  readonly sourceRef: string;
  readonly sourceTree: string;
  readonly archivePath: string;
  readonly extractedRoot: string;
  readonly sourceArchiveSha256: string;
  readonly inputTreeSha256: string;
}>>();

// Bootstrap's independently acquired private compiler, not a registry/caller claim.
// Another toolchain requires a new acquisition proof, not matching version text.
const acquiredCompiler = {
  root: `${homedir()}/Desktop/herdr-updater-toolchain/rustup/toolchains/1.96.1-aarch64-apple-darwin/bin`,
  rustcSha256: "d10051fa870c54067bd21047e9709084141ffff65695537eb2c0c5d2477467d4",
  cargoSha256: "f00ad85ca0a5b0f15b2a7658f15ef3195d9a04d2763921c1f9eaaa51f0136fe8",
} as const;

async function treeDigest(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name);
      const info = await lstat(file);
      const key = relative(root, file);
      if (info.isSymbolicLink()) {
        const target = await readlink(file);
        if (relative(root, resolve(dirname(file), target)).startsWith("..")) {
          throw new QaError("source-link", "archive link escapes owned build inputs");
        }
        entries.push(`${key}:link:${target}`);
      }
      else if (info.isDirectory()) { entries.push(`${key}:dir:${info.mode & 0o777}`); await visit(file); }
      else if (info.isFile()) entries.push(`${key}:${info.mode & 0o777}:${await fileDigest(file)}`);
      else throw new QaError("source-file", "unsupported archive file type");
    }
  }
  await visit(root);
  return hashBytes(entries.join("\n"));
}

export async function produceArchive(context: QaContext, source: string, sourceRef: string): Promise<ArchiveReceipt> {
  return await context.admit(async () => {
  if (!isAbsolute(source) || !/^[a-f0-9]{40}$/.test(sourceRef)) throw new QaError("source", "immutable absolute source required");
  const status = await context.invoke(["/usr/bin/git", "-C", source, "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.exitCode !== 0 || status.stdout.trim()) throw new QaError("dirty-source", "source is dirty or unavailable");
  const commitObservation = await context.invoke(["/usr/bin/git", "-C", source, "rev-parse", "--verify", `${sourceRef}^{commit}`]);
  const actualRef = commitObservation.stdout.trim();
  if (commitObservation.exitCode !== 0 || actualRef !== sourceRef) throw new QaError("source-ref", "Git commit does not resolve to requested immutable object");
  const treeObservation = await context.invoke(["/usr/bin/git", "-C", source, "rev-parse", "--verify", `${actualRef}^{tree}`]);
  const sourceTree = treeObservation.stdout.trim();
  if (treeObservation.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(sourceTree)) throw new QaError("source-tree", "Git tree observation unavailable");
  const archivePath = join(context.paths.core, "source.tar");
  const archive = await context.invoke(["/usr/bin/git", "-C", source, "archive", "--format=tar", `--output=${archivePath}`, actualRef]);
  if (archive.exitCode !== 0) throw new QaError("archive", "git archive failed");
  const sourceArchiveSha256 = await fileDigest(archivePath);
  const extractedRoot = join(context.paths.core, "source");
  context.assertOpen();
  await mkdir(extractedRoot, { mode: 0o700 });
  const extraction = await context.invoke(["/usr/bin/tar", "-xf", archivePath, "-C", extractedRoot]);
  if (extraction.exitCode !== 0) throw new QaError("archive", "archive extraction failed");
  const receipt: ArchiveReceipt = {
    state: "observed", sourceRef: actualRef, sourceTree, sourceArchiveSha256, archivePath, extractedRoot,
    sourceStatus: status, commitObservation, treeObservation, archive, extraction,
  };
  let observed = archives.get(context);
  if (!observed) { observed = new Map(); archives.set(context, observed); }
  observed.set(receipt, Object.freeze({
    sourceRef: actualRef, sourceTree, archivePath, extractedRoot, sourceArchiveSha256,
    inputTreeSha256: await treeDigest(extractedRoot),
  }));
  return receipt;
  });
}

export async function produceBuild(
  context: QaContext,
  source: ArchiveReceipt,
  compiler: readonly [string, ...string[]],
  build: readonly [string, ...string[]],
  binaryRelativePath: string,
) {
  return await context.admit(async () => {
  if (isAbsolute(binaryRelativePath) || binaryRelativePath.split("/").includes("..")) throw new QaError("binary", "owned relative binary required");
  const observed = archives.get(context)?.get(source);
  if (!observed) throw new QaError("unobserved-archive", "caller receipt is not an extraction observation");
  if (source.sourceRef !== observed.sourceRef || source.sourceTree !== observed.sourceTree ||
      source.archivePath !== observed.archivePath || source.extractedRoot !== observed.extractedRoot ||
      source.sourceArchiveSha256 !== observed.sourceArchiveSha256) {
    throw new QaError("source-binding", "genuine receipt differs from producer-retained Git/archive observation");
  }
  if (await treeDigest(observed.extractedRoot) !== observed.inputTreeSha256) throw new QaError("dirty-extraction", "extracted build inputs changed");
  // A fresh source archive digest is checked against bytes, never a registry string.
  if (await fileDigest(observed.archivePath) !== observed.sourceArchiveSha256) throw new QaError("stale-archive", "archive changed");
  if (binaryRelativePath !== "target/release/herdr") throw new QaError("build-output", "only the archived herdr release output is admissible");
  const target = join(context.paths.core, "target");
  try { await lstat(target); throw new QaError("preexisting-output", "build target must not exist before compilation"); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (!isAbsolute(compiler[0]) || !isAbsolute(build[0]) ||
      compiler.length !== 2 || compiler[1] !== "--version" ||
      build.length !== 4 || build.slice(1).join("\0") !== "build\0--locked\0--release") {
    throw new QaError("build-command", "exact rustc --version and cargo build --locked --release required");
  }
  const rustc = await realpath(compiler[0]);
  const cargo = await realpath(build[0]);
  if (basename(rustc) !== "rustc" || basename(cargo) !== "cargo" || dirname(rustc) !== dirname(cargo)) {
    throw new QaError("build-command", "direct rustc and cargo from the same toolchain required");
  }
  if (rustc !== join(acquiredCompiler.root, "rustc") || cargo !== join(acquiredCompiler.root, "cargo") ||
      await fileDigest(rustc) !== acquiredCompiler.rustcSha256 || await fileDigest(cargo) !== acquiredCompiler.cargoSha256) {
    throw new QaError("compiler-acquisition", "compiler is not the independently acquired private toolchain");
  }
  const cargoSource: unknown = Bun.TOML.parse(await Bun.file(join(observed.extractedRoot, "Cargo.toml")).text());
  const pinnedToolchain: unknown = Bun.TOML.parse(await Bun.file(join(observed.extractedRoot, "rust-toolchain.toml")).text());
  if (typeof cargoSource !== "object" || cargoSource === null || !("package" in cargoSource) ||
      typeof cargoSource.package !== "object" || cargoSource.package === null || !("name" in cargoSource.package) ||
      cargoSource.package.name !== "herdr" ||
      typeof pinnedToolchain !== "object" || pinnedToolchain === null || !("toolchain" in pinnedToolchain) ||
      typeof pinnedToolchain.toolchain !== "object" || pinnedToolchain.toolchain === null ||
      !("channel" in pinnedToolchain.toolchain) || typeof pinnedToolchain.toolchain.channel !== "string") {
    throw new QaError("build-source", "actual archived herdr Cargo inputs and pinned compiler required");
  }
  const toolchain = await context.invoke([rustc, "--version"]);
  const cargoVersion = await context.invoke([cargo, "--version"]);
  const channel = pinnedToolchain.toolchain.channel;
  if (toolchain.exitCode !== 0 || !toolchain.stdout.startsWith(`rustc ${channel} (`) ||
      cargoVersion.exitCode !== 0 || !cargoVersion.stdout.startsWith(`cargo ${channel} (`)) {
    throw new QaError("compiler", "actual compiler/Cargo version differs from archived toolchain");
  }
  // Version probes must not smuggle an output into the fresh target.
  try { await lstat(target); throw new QaError("preexisting-output", "target appeared before compilation"); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const execution = await context.invoke([cargo, "build", "--locked", "--release"], 120000, observed.extractedRoot, rustc);
  if (execution.exitCode !== 0) throw new QaError("build", "build failed");
  const binaryPath = await realpath(join(context.paths.core, binaryRelativePath));
  if (relative(target, binaryPath).startsWith("..") || !(await lstat(join(context.paths.core, binaryRelativePath))).isFile()) {
    throw new QaError("binary", "compiled output must be a new regular file in the owned target");
  }
  if (await fileDigest(rustc) !== toolchain.executableSha256 || await fileDigest(cargo) !== execution.executableSha256 ||
      await fileDigest(observed.archivePath) !== observed.sourceArchiveSha256) {
    throw new QaError("build-binding", "compiler or immutable archive bytes changed during compilation");
  }
  return {
    state: "observed" as const, inputMode: "immutable-archive-only" as const,
    source: { ...source, ...observed }, compilerPaths: { rustc, cargo }, outputPreviousState: "absent" as const,
    toolchain, cargoVersion, execution, binaryPath, binarySha256: await fileDigest(binaryPath),
    qualification: "build-observed-not-family-qualified" as const,
  };
  });
}

export async function acquire(url: string, timeoutMs = 15000) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new QaError("acquisition", "HTTPS required");
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    state: "observed" as const, url, status: response.status,
    headers: Object.fromEntries(response.headers), body: new TextDecoder().decode(bytes), bodySha256: hashBytes(bytes), bytes,
    qualification: "http-observed-not-release-qualified" as const,
  };
}

export async function copyPrivateBinary(context: QaContext, source: string, expectedHash?: string) {
  return await context.admit(async () => {
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
  const digest = hashBytes(bytes);
  if (expectedHash && digest !== expectedHash) throw new QaError("stale-binary", "binary bytes changed");
  const path = join(context.paths.prefix, "herdr");
  context.assertOpen();
  await writeFile(path, bytes, { mode: 0o700, flag: "wx" });
  return { path, sha256: digest, qualification: "receipt-only" as const };
  });
}

// Dispatcher-only additions. The isolation, acquisition and build foundation above
// remains the authority for child ownership and observed execution receipts.
type DispatchOutcome = {
  readonly id: string;
  readonly status: "BLOCKED" | "FAIL" | "UNVERIFIED";
  readonly code: string;
  readonly missing: readonly string[];
  readonly exitCode: number | null;
  readonly effects: 0 | null;
  readonly sourceSha256: string | null;
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
};

export function dispatchArtifactCode(
  captures: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  sourceSha256: string,
): string {
  const resultCapture = captures.find(capture => capture.path === "result.json");
  if (!resultCapture) return "missing-actual-artifacts";
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(resultCapture.bytes)); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return "malformed-result";
  }
  if (typeof value !== "object" || value === null) return "malformed-result";
  if (Reflect.get(value, "qualification") !== "native") return "fixture-only-not-native";
  if (Reflect.get(value, "sourceSha256") !== sourceSha256 ||
      Reflect.get(value, "buildSourceSha256") !== sourceSha256) return "source-build-digest-mismatch";
  // No producer-retained native build or loader observation exists in this
  // subset. Even perfectly matching caller metadata cannot qualify a scenario.
  return "native-contract-unverified";
}

async function dispatchWrite(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

async function dispatchDirectory(path: string, root: string): Promise<void> {
  const suffix = relative(root, path);
  if (suffix.startsWith("..") || isAbsolute(suffix)) throw new QaError("evidence-path", "evidence must be task owned");
  let current = await realpath(root);
  for (const part of suffix.split("/").filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    if (!(await lstat(current)).isDirectory()) throw new QaError("evidence-path", "evidence directory cannot be a link");
  }
}

export async function dispatchRegistry(
  registryPath: string,
  evidenceDir: string,
  projectRoot = resolve(import.meta.dir, "../.."),
  scope?: "plugin-only",
) {
  const { parseDispatchRegistry, expandInvocation } = await import("./registry");
  const project = await realpath(projectRoot);
  const info = await lstat(registryPath);
  if (!info.isFile() || info.size > 1024 * 1024) throw new QaError("registry-file", "bounded regular registration file required");
  const registrationBytes = await Bun.file(registryPath).text();
  const registration = parseDispatchRegistry(JSON.parse(registrationBytes));
  if (scope !== undefined && scope !== "plugin-only") throw new QaError("invalid-scope", "unknown dispatch scope");
  // Scope never changes admission: even excluded rows must match the full registry.
  const deferred = registration.scenarios
    .filter(scenario => scope === "plugin-only" &&
      (scenario.id === "web-desktop-mobile" || scenario.id === "web-existing-regression"))
    .map(scenario => ({ id: scenario.id, status: "DEFERRED_USER_SCOPE", effects: 0, qualified: 0 } as const));
  const selected = registration.scenarios.filter(scenario => !deferred.some(entry => entry.id === scenario.id));
  const canonicalEvidence = join(project, ".omo/evidence/herdr-cli-updater");
  const ownedEvidence = join(canonicalEvidence, "task8/dispatch-r1");
  const pluginEvidence = join(canonicalEvidence, "task8/plugin-only-dispatch-r1");
  const destination = resolve(evidenceDir) === canonicalEvidence
    ? scope === "plugin-only" ? pluginEvidence : ownedEvidence
    : resolve(evidenceDir);
  if (![ownedEvidence, pluginEvidence].some(root => {
    const suffix = relative(root, destination);
    return !suffix.startsWith("..") && !isAbsolute(suffix);
  })) throw new QaError("evidence-path", "only registered task8 dispatch evidence is writable");
  await dispatchDirectory(destination, project);
  const runId = crypto.randomUUID();
  const runDir = join(destination, "runs", runId);
  await dispatchDirectory(runDir, project);
  await dispatchWrite(join(runDir, "registry.json"), registration);
  const outcomes: DispatchOutcome[] = [];
  for (const scenario of selected) {
    const output = join(runDir, scenario.id);
    await mkdir(output, { mode: 0o700 });
    const missing: string[] = [];
    let sourceBytes: Uint8Array | undefined;
    let sourceSha256: string | null = null;
    const sourcePath = join(project, scenario.source.path);
    try {
      const sourceInfo = await lstat(sourcePath);
      if (!sourceInfo.isFile() || sourceInfo.size > 1024 * 1024 ||
          await realpath(sourcePath) !== sourcePath) {
        missing.push("runner-not-owned-regular-source");
      } else {
        sourceBytes = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
        sourceSha256 = hashBytes(sourceBytes);
        if (!scenario.source.sha256) missing.push("runner-source-registration");
        else if (sourceSha256 !== scenario.source.sha256) missing.push("runner-source-digest");
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      missing.push(`missing-runner:${scenario.source.path}`);
    }
    for (const input of scenario.prerequisites.inputs) {
      try {
        const inputInfo = await lstat(join(project, input));
        if ((!inputInfo.isFile() && !inputInfo.isDirectory()) ||
            await realpath(join(project, input)) !== join(project, input)) missing.push(`unowned-input:${input}`);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        missing.push(`missing-input:${input}`);
      }
    }
    // Provenance's registered --manifest/--core-bin invocation currently rejects
    // at argument admission, before it can read a binary or create a resource.
    // Observe that real rejection; do not silently translate it into another CLI.
    const provenanceAdmission = scenario.id === "provenance-gate" &&
      sourceSha256 === scenario.source.sha256 && sourceBytes !== undefined;
    if (!provenanceAdmission) {
      if (scenario.prerequisites.build) missing.push("missing-owned-source-build-observation");
      for (const resource of scenario.prerequisites.resources) missing.push(`missing-owned-resource:${resource}`);
      if (scenario.cwd === "W") missing.push("missing-execution-owned-web-worktree");
    }
    let execution: ExecutionReceipt | undefined;
    let cleanup: CleanupReceipt | {
      readonly root: null; readonly rootRemoved: true; readonly actionState: "joined";
      readonly processes: readonly []; readonly resourcesRemaining: 0;
    } = { root: null, rootRemoved: true, actionState: "joined", processes: [], resourcesRemaining: 0 };
    let code = missing[0] ?? "missing-runner-prerequisite";
    let status: DispatchOutcome["status"] = "BLOCKED";
    const artifacts: { path: string; sha256: string }[] = [];
    if (sourceBytes && (missing.length === 0 || provenanceAdmission)) {
      const bytes = sourceBytes;
      try {
        const run = await withIsolation(async (context) => {
          const cwd = join(context.paths.root, "project");
          await mkdir(join(cwd, "scripts/qa"), { recursive: true, mode: 0o700 });
          await writeFile(join(cwd, scenario.source.path), bytes, { flag: "wx", mode: 0o600 });
          const invocation = expandInvocation(scenario, join(cwd, ".qa/herdr-updater"), context.paths.tmp);
          // E/ID expands to a fresh empty directory, never historical evidence.
          const childEvidence = join(context.paths.tmp, scenario.id);
          await mkdir(childEvidence, { mode: 0o700 });
          const observed = await context.invoke([process.execPath, ...invocation], 15000, cwd);
          const captures: { path: string; bytes: Uint8Array }[] = [];
          for (const name of scenario.artifacts) {
            const file = join(childEvidence, name);
            try {
              const artifactInfo = await lstat(file);
              if (!artifactInfo.isFile() || artifactInfo.size > 1024 * 1024 ||
                  await realpath(file) !== file) throw new QaError("artifact-file", "bounded regular actual artifact required");
              captures.push({ path: name, bytes: new Uint8Array(await Bun.file(file).arrayBuffer()) });
            } catch (error) {
              if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
            }
          }
          return { observed, captures };
        }, { timeoutMs: 20000 });
        execution = run.value.observed;
        cleanup = run.cleanup;
        const actual = join(output, "actual");
        await mkdir(actual, { mode: 0o700 });
        for (const capture of run.value.captures) {
          await writeFile(join(actual, capture.path), capture.bytes, { flag: "wx", mode: 0o600 });
          artifacts.push({ path: `actual/${capture.path}`, sha256: hashBytes(capture.bytes) });
        }
        if (await fileDigest(sourcePath) !== sourceSha256) {
          status = "FAIL"; code = "source-changed-during-run";
        } else if (execution.exitCode !== 0 || execution.signal !== null) {
          status = "FAIL";
          code = provenanceAdmission && execution.exitCode === 2 ? "invocation-contract-mismatch" : "runner-nonzero";
        } else {
          // Captured fixture/receipt claims are not native qualification. Native
          // judges belong to tasks31/32/33/34, not to this dispatcher subset.
          status = "UNVERIFIED";
          const absent = scenario.artifacts.filter(name => !run.value.captures.some(capture => capture.path === name));
          code = absent.length ? "missing-actual-artifacts" : dispatchArtifactCode(run.value.captures, hashBytes(bytes));
          if (code === "malformed-result" || code === "source-build-digest-mismatch") status = "FAIL";
          missing.push(...absent.map(name => `missing-artifact:${name}`));
        }
      } catch (error) {
        if (!(error instanceof RunFailure)) throw error;
        cleanup = await error.finalCleanup;
        execution = error.executions[0];
        status = "FAIL";
        code = error.original instanceof QaError ? error.original.code : "runner-execution-error";
      }
    }
    const outcome: DispatchOutcome = {
      id: scenario.id, status, code, missing, exitCode: execution?.exitCode ?? null,
      effects: !execution || code === "invocation-contract-mismatch" ? 0 : null,
      sourceSha256, artifacts,
    };
    await writeFile(join(output, "actions.jsonl"), JSON.stringify({
      runId, scenario: scenario.id, plannedInvocation: scenario.invocation,
      plannedCwd: scenario.cwd, sourceSha256, buildSha256: null,
      sourceBuildDigestAgreement: "UNVERIFIED", execution: execution ?? null,
    }) + "\n", { flag: "wx", mode: 0o600 });
    await dispatchWrite(join(output, "cleanup.json"), cleanup);
    await dispatchWrite(join(output, "result.json"), outcome);
    outcomes.push(outcome);
  }
  const result = {
    status: "FAIL", FullDone: false, runId, runDir,
    registrySha256: hashBytes(registrationBytes), total: outcomes.length,
    scope: scope ?? "all", admittedTotal: registration.scenarios.length, deferred,
    qualified: 0, effects: outcomes.every(outcome => outcome.effects === 0) ? 0 : null,
    outcomes,
  } as const;
  await dispatchWrite(join(runDir, "result.json"), result);
  return result;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(JSON.stringify({ status: "HELP", flags: ["--registry", "--all", "--scope", "--evidence-dir"], effects: 0 }));
    return 0;
  }
  const flags = new Map<string, string>();
  let all = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--all" && !all) { all = true; continue; }
    const value = argv[index + 1];
    if (!flag || !["--registry", "--evidence-dir", "--scope"].includes(flag) || flags.has(flag) ||
        !value || value.startsWith("--") || (flag === "--scope" ? value !== "plugin-only" : !isAbsolute(value))) {
      console.log(JSON.stringify({ status: "BLOCKED", blockedField: "runner.arguments", code: "invalid-arguments", effects: 0 }));
      return 2;
    }
    flags.set(flag, value);
    index++;
  }
  if (!all || !flags.has("--registry") || !flags.has("--evidence-dir")) {
    console.log(JSON.stringify({ status: "BLOCKED", blockedField: "runner.arguments", code: "invalid-arguments", effects: 0 }));
    return 2;
  }
  const registryPath = flags.get("--registry");
  const evidenceDir = flags.get("--evidence-dir");
  if (!registryPath || !evidenceDir) throw new QaError("arguments", "validated arguments missing");
  try {
    const scope = flags.get("--scope");
    if (scope !== undefined && scope !== "plugin-only") throw new QaError("invalid-scope", "unknown dispatch scope");
    console.log(JSON.stringify(await dispatchRegistry(registryPath, evidenceDir, undefined, scope)));
    return 1;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.log(JSON.stringify({
      status: "BLOCKED", blockedField: "runner.registry",
      code: error instanceof QaError ? error.code : "registry-io",
      effects: 0, FullDone: false,
    }));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
