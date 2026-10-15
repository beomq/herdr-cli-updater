import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { attachWorker, discoverWorker, serveWorker, startWorker, stopWorker, WorkerError, WorkerShutdownError } from "../../src/service/worker";
import type { WorkerOwner } from "../../src/service/worker";
import { requestPrivateSocket } from "../../src/service/socket";
import type { Job, ServiceRequest } from "../../src/protocol";
import { JobStore } from "../../src/jobs/store";
import { domainStoreDirectory } from "../../src/service/domain";
import { fork } from "node:child_process";
import { stopPrivateSocket } from "../../src/service/socket";
import { createServer } from "node:net";
import { catalogRegistryDirectory } from "../../src/service/catalog-provider";
import { pathToFileURL } from "node:url";

// allow: SIZE_OK — plan4 owns this one test file; real-process fixtures must not move into product code.
const roots: string[] = [];
const owners: WorkerOwner[] = [];
function directory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wrk-")));
  roots.push(root);
  return join(root, "worker");
}
function sourceEnvironment(path: string) {
  return { home: dirname(path), path: join(dirname(path), "bin"), prefixes: [] };
}
function childEnvironment(path: string) {
  return { ...process.env, HOME: dirname(path), PATH: join(dirname(path), "bin"),
    XDG_CONFIG_HOME: join(dirname(path), "config"), HERDR_SOCKET: "", HERDR_CLI_UPDATER_SOURCE_PREFIXES: "",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
}
async function bounded<T>(outcome: Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(2000);
  const expired = Promise.withResolvers<never>();
  const abort = () => expired.reject(new WorkerError("startup_failed"));
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([outcome, expired.promise]); }
  finally { signal.removeEventListener("abort", abort); }
}
function childWorker(path: string) {
  const child = fork(join(import.meta.dir, "../../src/service/worker.ts"), ["--worker", path], {
    execPath: process.execPath, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: childEnvironment(path),
  });
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number | null>();
  child.once("message", () => ready.resolve());
  child.once("error", ready.reject);
  child.once("exit", code => { exited.resolve(code); ready.reject(new WorkerError("startup_failed")); });
  return { child, ready: ready.promise, exited: exited.promise };
}
async function start(directoryPath = directory()): Promise<WorkerOwner> {
  const identity = await startWorker(directoryPath, sourceEnvironment(directoryPath));
  owners.push(identity);
  return identity;
}
function request(identity: WorkerOwner): ServiceRequest {
  return { version: 1, requestId: "actual-worker", operation: "jobs",
    token: readFileSync(identity.tokenPath, "utf8") };
}
function retainedJob(path: string): Job {
  using store = new JobStore(domainStoreDirectory(path));
  return store.create({ jobId: "retained", requestId: "retained-request", mode: "update-only", selectedTargets: [],
    installation: { installationId: "fixture-install", resourcesFingerprint: "fixture-fingerprint",
      owner: { kind: "unknown", reason: "unverified_owner" }, installedVersion: { kind: "unknown", reason: "not_captured" } },
  }).job;
}
function expectStoppedDomain(identity: WorkerOwner, job: Job): void {
  for (const path of [identity.socketPath, identity.controlPath, identity.tokenPath, join(identity.directory, "owner.json")])
    expect(existsSync(path)).toBe(false);
  expect(existsSync(identity.directory)).toBe(false);
  const storage = domainStoreDirectory(identity.directory);
  expect(readdirSync(join(identity.directory, "..")).sort()).toEqual(["worker.catalog", "worker.jobs"]);
  // This runtime retains both SQLite sidecars after actual last-connection close.
  const files = ["jobs.sqlite", "jobs.sqlite-shm", "jobs.sqlite-wal"] as const;
  expect(readdirSync(storage).sort()).toEqual([...files]);
  for (const file of files) {
    const stat = lstatSync(join(storage, file));
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  }
  {
    using reopened = new JobStore(storage);
    expect(reopened.get(job.jobId)).toEqual(job);
    expect(reopened.list()).toEqual([job]);
  }
  expect(readdirSync(storage).sort()).toEqual([...files]);
}
afterEach(async () => {
  for (const identity of owners.splice(0)) {
    if (existsSync(identity.directory)) {
      await stopWorker(identity);
    }
  }
  for (const root of roots.splice(0)) {
    // Only fixture containers are recursively removed. Worker cleanup is asserted first.
    expect(readdirSync(root).filter(name => name === "worker")).toEqual([]);
    rmSync(root, { recursive: true });
  }
});

test.each([0o600, 0o644])("default worker loads only approved private runner factory mode %o", async mode => {
  // Given: actual detached worker/plugin entry, an owned source module and real
  // queue/domain composition. No profile is invented; no installer/native runs.
  const path = directory(), root = dirname(path), modulePath = join(root, "runner.mjs");
  const observedPath = join(root, "factory-context.json"), coreSocket = join(root, "owned-core.sock");
  const queueModule = pathToFileURL(join(import.meta.dir, "../../src/install/queue.ts")).href;
  writeFileSync(modulePath, `import {MutationQueue} from ${JSON.stringify(queueModule)};
import {writeFileSync} from "node:fs";
export async function createPrivateRunnerConfiguration({directory,owner,coreSocket}) {
  writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({directory,coreSocket,pid:owner.pid}), {mode:0o600});
  return {runner:{queue:new MutationQueue(${JSON.stringify(join(root, "queue"))}),receiptRoot:${JSON.stringify(root)}},
    readers:{candidates:[],sockets:[]}};
}`, { mode });
  const previous = process.env["HERDR_CLI_UPDATER_RUNNER_FACTORY"];
  process.env["HERDR_CLI_UPDATER_RUNNER_FACTORY"] = modulePath;
  try {
    // When: the real child consumes the same env/private-owner path as plugin start.
    const pending = startWorker(path, { ...sourceEnvironment(path), socket: coreSocket });
    if (mode === 0o644) {
      await expect(pending).rejects.toMatchObject({ code: "startup_failed" });
      expect(existsSync(observedPath)).toBe(false);
      expect(existsSync(path)).toBe(false);
      return;
    }
    const identity = await pending;
    owners.push(identity);
    // Then: exact owner/core context and actual domain read, not unsupported success.
    expect(JSON.parse(readFileSync(observedPath, "utf8"))).toEqual({ directory: path, coreSocket, pid: identity.pid });
    expect(await requestPrivateSocket(identity, request(identity))).toMatchObject({ ok: true, result: { jobs: [] } });
    await stopWorker(identity);
    expect(existsSync(identity.directory)).toBe(false);
    expect(lstatSync(join(root, "queue", "queue.sqlite")).mode & 0o777).toBe(0o600);
  } finally {
    if (previous === undefined) delete process.env["HERDR_CLI_UPDATER_RUNNER_FACTORY"];
    else process.env["HERDR_CLI_UPDATER_RUNNER_FACTORY"] = previous;
  }
});

test("worker survives actual startup terminal exit and consumer close/reopen", async () => {
  // Given: manifest startup launches a separate detached Bun owner.
  const path = directory();
  const terminal = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/plugin.ts"), "start"], {
    env: { ...childEnvironment(path), HERDR_CLI_UPDATER_DIRECTORY: path }, stdout: "pipe", stderr: "pipe",
  });
  const terminalExit = terminal.exited;
  expect(await terminalExit).toBe(0);
  const identity = discoverWorker(path);
  owners.push(identity);
  const pane = await attachWorker(path);
  const first = pane.client.next();
  pane.client.send(request(identity));
  expect(await first).toEqual({ version: 1, requestId: "actual-worker", operation: "jobs",
    ok: true, result: { jobs: [] } });
  // When: the terminal is already gone and its consumer is closed then reopened.
  pane.close();
  const reopened = await attachWorker(path);
  try {
    // Then: authenticated control identity and real response come from the same child.
    expect(reopened.owner).toEqual(identity);
    expect(identity.pid).not.toBe(process.pid);
    const response = reopened.client.next();
    reopened.client.send(request(identity));
    expect(await response).toEqual({ version: 1, requestId: "actual-worker", operation: "jobs",
      ok: true, result: { jobs: [] } });
    expect(lstatSync(path).mode & 0o777).toBe(0o700);
    for (const file of ["capability", "owner.json", "control.sock", "service.sock"]) {
      expect(lstatSync(join(path, file)).mode & 0o777).toBe(0o600);
    }
  } finally { reopened.close(); }
});

test("duplicate startup attaches without unlinking the live owner", async () => {
  // Given
  const identity = await start();
  const inode = lstatSync(identity.socketPath).ino;
  // When
  const duplicate = await startWorker(identity.directory);
  // Then
  expect(duplicate).toEqual(identity);
  expect(lstatSync(identity.socketPath).ino).toBe(inode);
});

test("actual child control stop exits zero after owner resource retirement", async () => {
  // Given: listeners for readiness and exit are registered before child actions.
  const path = directory();
  const job = retainedJob(path);
  const { child, ready, exited } = childWorker(path);
  await bounded(ready);
  child.disconnect();
  const identity = discoverWorker(path);
  owners.push(identity);
  try {
    // When
    await stopWorker(identity);
    // Then
    expect(await bounded(exited)).toBe(0);
    expectStoppedDomain(identity, job);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await bounded(exited);
    }
  }
});

test("actual default child acquires PATH sources and both core roots without a preseeded registry", async () => {
  // Given: task-owned executable references and metadata-only core sources.
  const path = directory(), home = dirname(path), bin = join(home, "bin"), pkg = join(home, "package");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(pkg, { mode: 0o700 });
  const executable = join(pkg, "cli"), marker = join(home, "operating-execution");
  writeFileSync(executable, `#!/usr/bin/env bun\nBun.write(${JSON.stringify(marker)}, "wrong");\n`, { mode: 0o700 });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@openai/codex", version: "8.9.10", bin: { codex: "cli" },
  }), { mode: 0o600 });
  symlinkSync(executable, join(bin, "codex"));
  symlinkSync(executable, join(bin, "agent-alias"));
  const methods: string[] = [], servers: ReturnType<typeof createServer>[] = [];
  for (const suffix of ["herdr/herdr.sock", "herdr/sessions/second/herdr.sock"]) {
    const socketPath = join(home, "config", suffix);
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    const server = createServer(socket => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        data += chunk;
        if (!data.includes("\n")) return;
        const request: unknown = JSON.parse(data.slice(0, data.indexOf("\n")));
        if (typeof request !== "object" || request === null || !("id" in request) || !("method" in request))
          throw new TypeError("malformed owned core request");
        methods.push(`${suffix}:${String(request.method)}`);
        socket.end(`${JSON.stringify({ id: request.id, result: request.method === "agent.list"
          ? { type: "agent_list", agents: [] } : { type: "pong", capabilities: {} } })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
    servers.push(server);
  }
  expect(existsSync(catalogRegistryDirectory(path))).toBe(false);
  const { child, ready, exited } = childWorker(path);
  try {
    // When: actual --worker entry, no injected reader or explicit registration.
    await bounded(ready);
    child.disconnect();
    const identity = discoverWorker(path);
    owners.push(identity);
    const token = readFileSync(identity.tokenPath, "utf8");
    const installations = await requestPrivateSocket(identity, {
      version: 1, requestId: "automatic", operation: "installations", token,
    }, AbortSignal.timeout(3000));
    const runtimes = await requestPrivateSocket(identity, {
      version: 1, requestId: "automatic-runtime", operation: "runtimes", token,
    }, AbortSignal.timeout(3000));
    // Then
    expect(installations).toMatchObject({ ok: true, result: { installations: [{
      family: "codex", executableRealpath: executable, installedVersion: { kind: "known", version: "8.9.10" },
      owner: { kind: "unknown" },
    }] } });
    expect(runtimes).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(methods.filter(method => method.endsWith(":agent.list"))).toHaveLength(2);
    expect(existsSync(join(catalogRegistryDirectory(path), "sources.json"))).toBe(false);
    expect(existsSync(join(catalogRegistryDirectory(path), "auto-sources.json"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    await stopWorker(identity);
    expect(await bounded(exited)).toBe(0);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await bounded(exited); }
    for (const server of servers) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test.each(["SIGTERM", "SIGINT"] as const)("graceful %s removes only this worker's resources", async signal => {
  // Given: actual handler readiness and exact child exit are subscribed before signaling.
  const path = directory();
  const job = retainedJob(path);
  const { child, ready, exited } = childWorker(path);
  await bounded(ready);
  child.disconnect();
  const identity = discoverWorker(path);
  owners.push(identity);
  try {
    expect(await requestPrivateSocket(identity, request(identity))).toEqual({
      version: 1, requestId: "actual-worker", operation: "jobs", ok: true, result: { jobs: [job] },
    });
    // When
    child.kill(signal);
    // Then: exit receipt, not parent fs.watch timing, proves completed cleanup.
    expect(await bounded(exited)).toBe(0);
    expectStoppedDomain(identity, job);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await bounded(exited); }
  }
});

test.each(["pid", "incarnation", "executableRealpath"] as const)("misleading %s identity cannot stop the real worker", async field => {
  // Given
  const identity = await start();
  const misleading = { ...identity,
    ...(field === "pid" ? { pid: process.pid } : field === "incarnation"
      ? { incarnation: "00000000-0000-0000-0000-000000000000" } : { executableRealpath: "/wrong/bun" }) };
  // When
  await expect(stopWorker(misleading)).rejects.toBeInstanceOf(WorkerError);
  // Then: the original authenticated owner still responds.
  const pane = await attachWorker(identity.directory);
  expect(pane.owner).toEqual(identity);
  pane.close();
});

test("dirty owner directory is refused without deleting foreign files", async () => {
  // Given
  const path = directory();
  mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(path, "foreign"), "preserve");
  // When
  await expect(startWorker(path)).rejects.toThrow();
  // Then
  expect(readFileSync(join(path, "foreign"), "utf8")).toBe("preserve");
  rmSync(path, { recursive: true });
});

test("stop retires owned files while preserving a dirty foreign boundary", async () => {
  // Given
  const identity = await start();
  writeFileSync(join(identity.directory, "foreign"), "preserve");
  // When
  await stopWorker(identity);
  // Then
  expect(readdirSync(identity.directory)).toEqual(["foreign"]);
  expect(readFileSync(join(identity.directory, "foreign"), "utf8")).toBe("preserve");
  rmSync(identity.directory, { recursive: true });
});

test("stale registry never authorizes unlink or reused PID signals", async () => {
  // Given
  const path = directory();
  mkdirSync(path, { mode: 0o700 });
  const stale = { directory: path, socketPath: join(path, "service.sock"), tokenPath: join(path, "capability"),
    controlPath: join(path, "control.sock"), incarnation: "00000000-0000-0000-0000-000000000000",
    pid: process.pid, executableRealpath: process.execPath };
  writeFileSync(join(path, "owner.json"), JSON.stringify(stale), { mode: 0o600 });
  // When
  await expect(startWorker(path)).rejects.toThrow();
  // Then
  expect(JSON.parse(readFileSync(join(path, "owner.json"), "utf8"))).toEqual(stale);
  rmSync(path, { recursive: true });
});

test("forged capability cannot invoke lifecycle stop", async () => {
  // Given
  const identity = await start();
  // When
  const response = await fetch("http://worker/lifecycle", { unix: identity.controlPath, method: "POST",
    body: JSON.stringify({ action: "stop", incarnation: identity.incarnation, pid: identity.pid,
      executableRealpath: identity.executableRealpath, token: "0".repeat(64) }) });
  // Then
  expect(response.status).toBe(403);
  const pane = await attachWorker(identity.directory);
  expect(pane.owner).toEqual(identity);
  pane.close();
});

test("non-terminal pane entry fails while leaving the authenticated worker alive", async () => {
  // Given: a real owned worker, independent of the test runner's terminal.
  const identity = await start();
  // When: the actual plugin entrypoint receives pipes rather than a PTY.
  const entry = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/plugin.ts"), "tui"], {
    env: { ...process.env, HERDR_CLI_UPDATER_DIRECTORY: identity.directory },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(entry.stdout).text(), new Response(entry.stderr).text(), entry.exited,
  ]);
  // Then: typed enum failure cannot terminate or replace the authenticated owner.
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "", stderr: "not_terminal\n", exitCode: 1 });
  const pane = await attachWorker(identity.directory);
  expect(pane.owner).toEqual(identity);
  pane.close();
});

test("consumer close does not abort injected in-flight handler work", async () => {
  // Given: real handler completion barrier, not a fake product job/updater.
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const worker = serveWorker(directory(), async (req, signal) => {
    entered.resolve(signal);
    await release.promise;
    completed.resolve();
    return { version: 1, requestId: req.requestId, operation: req.operation,
      ok: false, error: { code: "not_found" } };
  });
  try {
    const pane = await attachWorker(worker.owner.directory);
    pane.client.send(request(worker.owner));
    const signal = await entered.promise;
    // When
    pane.close();
    release.resolve();
    await completed.promise;
    // Then
    expect(signal.aborted).toBe(false);
    expect(await requestPrivateSocket(worker.owner, request(worker.owner))).toMatchObject({ error: { code: "not_found" } });
  } finally { release.resolve(); await worker.stop(); }
});

test("replacement capability and registry cannot steal control or be deleted by old owner", async () => {
  // Given: distinct file incarnations, not in-place writes to an owner's inode.
  const worker = serveWorker(directory(), req => ({ version: 1, requestId: req.requestId,
    operation: req.operation, ok: false, error: { code: "unsupported" } }));
  const identity = worker.owner;
  const replacementToken = join(identity.directory, "replacement-token");
  const replacementOwner = join(identity.directory, "replacement-owner");
  writeFileSync(replacementToken, "0".repeat(64), { mode: 0o600 });
  writeFileSync(replacementOwner, "foreign", { mode: 0o600 });
  renameSync(replacementToken, identity.tokenPath);
  renameSync(replacementOwner, join(identity.directory, "owner.json"));
  try {
    // When: replacement file credentials try to stop the original live owner.
    const response = await fetch("http://worker/lifecycle", { unix: identity.controlPath, method: "POST",
      body: JSON.stringify({ action: "stop", incarnation: identity.incarnation, pid: identity.pid,
        executableRealpath: identity.executableRealpath, token: "0".repeat(64) }) });
    // Then: authentication remains tied to the original in-memory capability.
    expect(response.status).toBe(403);
  } finally { await worker.stop(); }
  expect(readFileSync(identity.tokenPath, "utf8")).toBe("0".repeat(64));
  expect(readFileSync(join(identity.directory, "owner.json"), "utf8")).toBe("foreign");
  expect(existsSync(identity.socketPath)).toBe(false);
  rmSync(identity.directory, { recursive: true });
});

test("permission failure settles duplicate stop and closed with the same failure", async () => {
  // Given: actual EACCES, and all promise observers exist before the failure.
  const path = directory();
  const termBefore = process.listeners("SIGTERM");
  const intBefore = process.listeners("SIGINT");
  const worker = serveWorker(path, req => ({ version: 1, requestId: req.requestId,
    operation: req.operation, ok: false, error: { code: "unsupported" } }));
  const saved = ["control.sock", "owner.json", "service.sock", "capability"]
    .map(name => ({ path: join(path, name), stat: lstatSync(join(path, name)) }));
  const abort = AbortSignal.timeout(1000);
  const bounded = Promise.withResolvers<never>();
  const expire = () => bounded.reject(new WorkerError("startup_failed"));
  abort.addEventListener("abort", expire, { once: true });
  const closed = worker.closed;
  const closedOutcome = closed.then(() => ({ status: "fulfilled" as const }),
    reason => ({ status: "rejected" as const, reason }));
  try {
    // When
    chmodSync(path, 0o500);
    const first = worker.stop();
    const duplicate = worker.stop();
    const outcomes = await Promise.race([Promise.allSettled([first, duplicate]), bounded.promise]);
    const completion = await Promise.race([closedOutcome, bounded.promise]);
    // Then: cleanup failure is a settled failure, not successful teardown or a hang.
    expect(outcomes[0]?.status).toBe("rejected");
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(completion.status).toBe("rejected");
    if (outcomes[0]?.status !== "rejected" || completion.status !== "rejected") throw new Error("expected real cleanup failure");
    expect(completion.reason).toBe(outcomes[0].reason);
    expect(completion.reason).toBeInstanceOf(WorkerShutdownError);
    if (!(completion.reason instanceof WorkerShutdownError)) throw new Error("expected cleanup receipt");
    expect(completion.reason.errors.some(error => error instanceof Error && "code" in error && error.code === "EACCES")).toBe(true);
    expect([...completion.reason.remainingOwnedPaths].sort()).toEqual(saved.map(entry => entry.path).sort());
    expect(first).toBe(duplicate);
    expect(first).toBe(closed);
    chmodSync(path, 0o700);
    await expect(worker.stop()).rejects.toBe(outcomes[0].reason);
  } finally {
    abort.removeEventListener("abort", expire);
    chmodSync(path, 0o700);
    // Stable failure is not retried. Fixture owner retires only its saved inodes.
    stopPrivateSocket(worker.transport);
    for (const entry of saved) {
      const current = lstatSync(entry.path, { throwIfNoEntry: false });
      if (current?.dev === entry.stat.dev && current.ino === entry.stat.ino) unlinkSync(entry.path);
    }
    for (const listener of process.listeners("SIGTERM")) if (!termBefore.includes(listener)) process.removeListener("SIGTERM", listener);
    for (const listener of process.listeners("SIGINT")) if (!intBefore.includes(listener)) process.removeListener("SIGINT", listener);
    rmdirSync(path);
  }
});
