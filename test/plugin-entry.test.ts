import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { omoPreparationInputs, runPlugin } from "../scripts/plugin";
import { attachAuthenticatedWorker } from "../src/service/client";
import { discoverWorker, serveWorker, stopWorker, WorkerError } from "../src/service/worker";
import { domainStoreDirectory } from "../src/service/domain";
import { JobStore } from "../src/jobs/store";

const root = new URL("../", import.meta.url).pathname;
const manifest: unknown = Bun.TOML.parse(await Bun.file(join(root, "herdr-plugin.toml")).text());
function argv(kind: "startup" | "panes"): readonly string[] {
  if (typeof manifest !== "object" || manifest === null) throw new WorkerError("invalid_command");
  const entries = kind === "startup"
    ? ("startup" in manifest ? manifest.startup : undefined)
    : ("panes" in manifest ? manifest.panes : undefined);
  if (!Array.isArray(entries)) throw new WorkerError("invalid_command");
  const entry: unknown = entries[0];
  if (typeof entry !== "object" || entry === null || !("command" in entry)) {
    throw new WorkerError("invalid_command");
  }
  const command = entry.command;
  if (!Array.isArray(command)) throw new WorkerError("invalid_command");
  return command.map((value: unknown) => {
    if (typeof value !== "string") throw new WorkerError("invalid_command");
    return value;
  });
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WorkerError("startup_failed")), 5000);
  })]).finally(() => clearTimeout(timer));
}
function entryEnvironment(directory: string) {
  return { ...process.env, HOME: dirname(directory), PATH: dirname(process.execPath),
    XDG_CONFIG_HOME: join(dirname(directory), "config"), HERDR_SOCKET: "", HERDR_SOCKET_PATH: "",
    HERDR_CLI_UPDATER_SOURCE_PREFIXES: "", HERDR_CLI_UPDATER_DIRECTORY: directory };
}
async function invoke(command: readonly string[], directory: string, timeout = 5000) {
  const child = Bun.spawn([...command], {
    cwd: root, env: entryEnvironment(directory),
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("non-terminal entry exposes the typed failure without stopping the real worker", async () => {
  // Given: actual manifest startup, isolated from every operating worker.
  const container = mkdtempSync(join(realpathSync(tmpdir()), "entry-"));
  const directory = join(container, "w");
  try {
    expect(await invoke(argv("startup"), directory)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const owner = discoverWorker(directory);
    // When: the actual pane command has no TTY.
    const result = await invoke(argv("panes"), directory);
    // Then: enum-only failure and the same authenticated worker still responds.
    expect(result).toEqual({ stdout: "", stderr: "not_terminal\n", exitCode: 1 });
    const attachment = await attachAuthenticatedWorker(directory);
    try {
      expect(attachment.incarnation).toBe(owner.incarnation);
      expect(await attachment.request({ operation: "jobs" })).toMatchObject({ ok: true, result: { jobs: [] } });
    } finally { attachment.close(); }
  } finally {
    if (existsSync(directory)) await stopWorker(discoverWorker(directory));
    rmSync(container, { recursive: true });
  }
});

test.each([[80, 24], [120, 40]])("actual %ix%i pane closes, reopens and leaves durable work alive until owned stop", async (cols, rows) => {
  // Given: real startup process and a real durable job, with no injected engine.
  const container = mkdtempSync(join(realpathSync(tmpdir()), "entry-"));
  const directory = join(container, "w");
  let pane: ReturnType<typeof Bun.spawn> | undefined;
  try {
    expect(await invoke(argv("startup"), directory)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const owner = discoverWorker(directory);
    {
      using store = new JobStore(domainStoreDirectory(directory));
      store.create({ jobId: "entry-retained", requestId: "entry-seed", mode: "update-only", selectedTargets: [],
        installation: { installationId: "entry-install", resourcesFingerprint: "entry-fingerprint",
          owner: { kind: "unknown", reason: "unverified_owner" },
          installedVersion: { kind: "unknown", reason: "not_captured" } } });
    }
    // When: two actual manifest panes open and close through their PTYs.
    for (let generation = 0; generation < 2; generation++) {
      const ready = Promise.withResolvers<void>(), jobs = Promise.withResolvers<void>();
      const decoder = new TextDecoder();
      let raw = "";
      // Subscribe to PTY output before spawning or sending input.
      pane = Bun.spawn([...argv("panes")], {
        cwd: root, env: entryEnvironment(directory),
        terminal: { cols, rows, data(_terminal, bytes) {
          raw += decoder.decode(bytes, { stream: true });
          const screen = Bun.stripANSI(raw);
          if (screen.includes("Read-only |") && screen.includes("CLI CATALOG")) ready.resolve();
          if (screen.includes("JOBS 1") && screen.includes("/ queued")) jobs.resolve();
        } },
      });
      const exited = pane.exited;
      await bounded(ready.promise);
      expect(pane.exitCode).toBeNull();
      const terminal = pane.terminal;
      if (!terminal) throw new WorkerError("startup_failed");
      terminal.write("2");
      await bounded(jobs.promise);
      terminal.write("q");
      expect(await bounded(exited)).toBe(0);
      terminal.close();
      pane = undefined;
      // Then: closing the entry did not own or replace the worker or its job.
      expect(discoverWorker(directory)).toEqual(owner);
      const attachment = await attachAuthenticatedWorker(directory);
      try {
        const response = await attachment.request({ operation: "jobs" });
        expect(response).toMatchObject({ ok: true, result: { jobs: [{
          jobId: "entry-retained", status: "queued", revision: 0,
        }] } });
      } finally { attachment.close(); }
    }
    expect(await invoke(argv("startup"), directory)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(discoverWorker(directory)).toEqual(owner);
    expect(await invoke(["bun", "scripts/plugin.ts", "stop"], directory))
      .toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(existsSync(directory)).toBe(false);
    using store = new JobStore(domainStoreDirectory(directory));
    expect(store.get("entry-retained").status).toBe("queued");
  } finally {
    if (pane) { pane.terminal?.close(); pane.kill(); await bounded(pane.exited); }
    if (existsSync(directory)) await stopWorker(discoverWorker(directory));
    rmSync(container, { recursive: true });
  }
}, 20000);

test("reload replaces only an empty plugin worker", async () => {
  // Given: an isolated authenticated worker without jobs.
  const container = mkdtempSync(join(realpathSync(tmpdir()), "entry-")), directory = join(container, "w");
  try {
    expect((await invoke(argv("startup"), directory)).exitCode).toBe(0);
    const before = discoverWorker(directory);
    // When: reload uses the real product entry.
    // Reload includes authenticated retirement and a separate readiness event.
    expect((await invoke(["bun", "scripts/plugin.ts", "reload"], directory, 15000)).exitCode).toBe(0);
    // Then: a new worker owns the same directory and still serves the empty store.
    expect(discoverWorker(directory).incarnation).not.toBe(before.incarnation);
    const attachment = await attachAuthenticatedWorker(directory);
    try { expect(await attachment.request({ operation: "jobs" })).toMatchObject({ ok: true, result: { jobs: [] } }); }
    finally { attachment.close(); }
  } finally {
    if (existsSync(directory)) await stopWorker(discoverWorker(directory));
    rmSync(container, { recursive: true });
  }
}, 20000);

test.each(["queued", "uncertain"] as const)("reload refuses to retire a worker with durable %s jobs", async state => {
  // Given: an isolated worker with a real retained job.
  const container = mkdtempSync(join(realpathSync(tmpdir()), "entry-")), directory = join(container, "w");
  try {
    expect((await invoke(argv("startup"), directory)).exitCode).toBe(0);
    const before = discoverWorker(directory);
    using store = new JobStore(domainStoreDirectory(directory));
    store.create({ jobId: "reload-retained", requestId: "reload-seed", mode: "update-only", selectedTargets: [],
      installation: { installationId: "reload-install", resourcesFingerprint: "reload-fingerprint",
        owner: { kind: "unknown", reason: "unverified_owner" }, installedVersion: { kind: "unknown", reason: "not_captured" } } });
    if (state === "uncertain") store.change({ jobId: "reload-retained", expectedRevision: 0 },
      { kind: "intent", effect: "updated", operationId: "uncertain-op", targetId: null });
    const retained = store.get("reload-retained");
    // When / Then: real entry refuses instead of dropping work or replacing its owner.
    expect(await invoke(["bun", "scripts/plugin.ts", "reload"], directory)).toMatchObject({ exitCode: 1, stderr: "resources_busy\n" });
    expect(discoverWorker(directory)).toEqual(before);
    expect(store.get("reload-retained")).toEqual(retained);
  } finally {
    if (existsSync(directory)) await stopWorker(discoverWorker(directory));
    rmSync(container, { recursive: true });
  }
}, 20000);

test("reload preserves completed jobs and archives residual mutation history after authenticated stop", async () => {
  const container = mkdtempSync(join(realpathSync(tmpdir()), "entry-")), directory = join(container, "w");
  try {
    expect((await invoke(argv("startup"), directory)).exitCode).toBe(0);
    const before = discoverWorker(directory);
    using store = new JobStore(domainStoreDirectory(directory));
    store.create({ jobId: "completed", requestId: "completed-seed", mode: "update-only", selectedTargets: [],
      installation: { installationId: "completed-install", resourcesFingerprint: "fp",
        owner: { kind: "unknown", reason: "unverified_owner" }, installedVersion: { kind: "unknown", reason: "not_captured" } } });
    store.change({ jobId: "completed", expectedRevision: 0 }, { kind: "intent", effect: "updated", operationId: "completed-op", targetId: null });
    store.change({ jobId: "completed", expectedRevision: 1 }, { kind: "observe", targetId: null,
      receipt: { kind: "completed", operationId: "completed-op", effect: "updated", identity: null } });
    store.change({ jobId: "completed", expectedRevision: 2 }, { kind: "verify-install" });
    const saved = store.get("completed");
    writeFileSync(join(directory, "retained-journal"), "history", { mode: 0o600 });
    expect((await invoke(["bun", "scripts/plugin.ts", "reload"], directory, 15000)).exitCode).toBe(0);
    expect(discoverWorker(directory).incarnation).not.toBe(before.incarnation);
    expect(store.get("completed")).toEqual(saved);
    expect(readFileSync(join(`${directory}.retired-${before.incarnation}`, "retained-journal"), "utf8")).toBe("history");
    const attachment = await attachAuthenticatedWorker(directory);
    try { expect(await attachment.request({ operation: "jobs" })).toMatchObject({ ok: true, result: { jobs: [saved] } }); }
    finally { attachment.close(); }
  } finally {
    if (existsSync(directory)) await stopWorker(discoverWorker(directory));
    rmSync(container, { recursive: true });
  }
}, 20000);

test("OmO bootstrap derives only the exact Bun default and original binary without modifying globals", () => {
  const container = mkdtempSync(join(realpathSync(tmpdir()), "omo-inputs-"));
  const prefix = join(container, ".bun"), executable = join(prefix, "install/global/node_modules/omo-ai/bin/omo.js");
  const previous = { home: process.env["HOME"], bun: process.env["BUN_INSTALL"] };
  try {
    mkdirSync(dirname(executable), { recursive: true }); mkdirSync(join(prefix, "bin"));
    writeFileSync(executable, "source"); symlinkSync(process.execPath, join(prefix, "bin/bun"));
    writeFileSync(join(prefix, "install/global/other-global"), "unchanged");
    process.env["HOME"] = container; delete process.env["BUN_INSTALL"];
    expect(omoPreparationInputs()).toEqual({ prefix, bun: realpathSync(process.execPath) });
    process.env["BUN_INSTALL"] = prefix;
    expect(omoPreparationInputs()).toEqual({ prefix, bun: realpathSync(process.execPath) });
    const installation = { installationId: "omo", resourcesFingerprint: "fp", family: "omo", channel: "stable",
      executableRealpath: executable, resources: [], lastCheck: null,
      owner: { kind: "package", manager: "npm", packageName: "omo-ai", prefix },
      installedVersion: { kind: "unknown", reason: "not_captured" } } as const;
    expect(() => omoPreparationInputs(installation)).toThrow(WorkerError);
    expect(readFileSync(executable, "utf8")).toBe("source");
    expect(readFileSync(join(prefix, "install/global/other-global"), "utf8")).toBe("unchanged");
    expect(readdirSync(join(prefix, "install/global"))).toEqual(["node_modules", "other-global"]);
  } finally {
    if (previous.home === undefined) delete process.env["HOME"]; else process.env["HOME"] = previous.home;
    if (previous.bun === undefined) delete process.env["BUN_INSTALL"]; else process.env["BUN_INSTALL"] = previous.bun;
    rmSync(container, { recursive: true });
  }
});

test("preparation rejection stays visible and returns to the catalog without a job or installation change", async () => {
  // Given: an actual plugin PTY and worker without a herdr socket, so preparation is rejected before any runner exists.
  const container = realpathSync(mkdtempSync(join(tmpdir(), "prepare-recovery-")));
  const directory = join(container, "worker"), prefix = join(container, "prefix");
  const executable = join(prefix, "install/global/node_modules/omo-ai/bin/omo.js");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "unchanged-installation", { mode: 0o700 });
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const resources = [{ resourceId: `resource:${digest(executable)}`, realpath: executable,
    fingerprint: `sha256:${digest("unchanged-installation")}` }];
  const installation = { installationId: `install:${digest(executable)}`, family: "omo", executableRealpath: executable,
    installedVersion: { kind: "known", version: "5.1.21" }, channel: "latest",
    owner: { kind: "unknown", reason: "unverified_owner" }, resources,
    resourcesFingerprint: `sha256:${digest(JSON.stringify(resources))}`, lastCheck: null } as const;
  let writes = 0;
  const worker = serveWorker(directory, request => {
    const envelope = { version: 1, requestId: request.requestId } as const;
    switch (request.operation) {
      case "installations": return { ...envelope, operation: "installations", ok: true, result: { installations: [installation] } };
      case "sessions": return { ...envelope, operation: "sessions", ok: true, result: { sessions: [], unavailableSources: 0 } };
      case "jobs": return { ...envelope, operation: "jobs", ok: true, result: { jobs: [] } };
      case "create-job": writes++; return { ...envelope, operation: "create-job", ok: false, error: { code: "unsupported" } };
      default: return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
    }
  });
  let pane: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const ready = Promise.withResolvers<void>(), failed = Promise.withResolvers<void>();
    const reopened = Promise.withResolvers<void>(), jobs = Promise.withResolvers<void>();
    let raw = "";
    const stage = async (name: string, promise: Promise<unknown>) => {
      try { return await bounded(promise); }
      catch (error) { throw new Error(`${name}: ${Bun.stripANSI(raw).slice(-2000)}`, { cause: error }); }
    };
    pane = Bun.spawn(["bun", "scripts/plugin.ts", "open"], {
      cwd: root, env: entryEnvironment(directory),
      terminal: { cols: 120, rows: 40, data(_terminal, bytes) {
        raw += new TextDecoder().decode(bytes);
        const screen = Bun.stripANSI(raw.slice(raw.lastIndexOf("\x1b[H\x1b[2J")));
        const catalogReady = screen.includes("5.1.21") && screen.includes("Read-only |");
        if (catalogReady) ready.resolve();
        if (raw.includes("Preparation failed: invalid_command")) failed.resolve();
        if ((raw.match(/\x1b\[\?1049h/g)?.length ?? 0) >= 2 && catalogReady) reopened.resolve();
        if (screen.includes("JOBS 0")) jobs.resolve();
      } },
    });
    await stage("initial catalog", ready.promise);
    const terminal = pane.terminal;
    if (!terminal) throw new WorkerError("startup_failed");
    // When: preparation fails and the user returns instead of losing the pane.
    terminal.write("\r"); await stage("preparation rejection", failed.promise);
    terminal.write("\r");
    await stage("catalog recovery", Promise.race([reopened.promise, pane.exited.then(code => {
      throw new Error(`plugin exited before recovery: ${code}`);
    })]));
    terminal.write("2"); await stage("recovered jobs", jobs.promise);
    // Then: no installer/job ran, the worker survived and normal close still works.
    expect(writes).toBe(0);
    expect(readFileSync(executable, "utf8")).toBe("unchanged-installation");
    expect(discoverWorker(directory)).toEqual(worker.owner);
    terminal.write("q"); expect(await bounded(pane.exited)).toBe(0);
    terminal.close(); pane = undefined;
  } finally {
    if (pane) { pane.terminal?.close(); pane.kill(); await bounded(pane.exited); }
    await worker.stop(); rmSync(container, { recursive: true });
  }
}, 20000);

test("imported plugin rejects unknown commands with its typed enum", async () => {
  // Given / When: the actual module is called without a valid command.
  // Then: validation rejects before any default worker directory is touched.
  await expect(runPlugin("update", "/unused-entry-directory")).rejects.toBeInstanceOf(WorkerError);
  await expect(runPlugin("unknown", "/unused-entry-directory")).rejects.toMatchObject({ code: "invalid_command" });
});

test("imported non-terminal entry rejects the actual HostError class before attachment", async () => {
  // Given: an actual module consumer with pipes and an uncreated private path.
  const container = mkdtempSync(join(realpathSync(tmpdir()), "entry-"));
  const directory = join(container, "w");
  try {
    // When: the consumer verifies the thrown class, not just a matching message.
    const result = await invoke([process.execPath, "-e",
      'import assert from "node:assert/strict"; import { runPlugin } from "./scripts/plugin.ts";'
      + ' import { HostError } from "./src/tui/host.ts";'
      + ' await assert.rejects(runPlugin("tui", process.env.HERDR_CLI_UPDATER_DIRECTORY), HostError);'], directory);
    // Then: the typed rejection was observed with no worker bootstrap.
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(container, { recursive: true }); }
});

test("importing the plugin is silent and does not bootstrap a worker", async () => {
  // Given / When: import.meta.main is false in an actual subprocess.
  const container = mkdtempSync(join(realpathSync(tmpdir()), "entry-"));
  const directory = join(container, "w");
  try {
    const result = await invoke([process.execPath, "-e", 'await import("./scripts/plugin.ts")'], directory);
    // Then: no output, process failure, or worker ownership files.
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(container, { recursive: true }); }
});

test("managed launch rejects arbitrary command paths before opening a worker", async () => {
  const container = mkdtempSync(join(realpathSync(tmpdir()), "launch-entry-"));
  const directory = join(container, "w");
  try {
    await expect(runPlugin("launch", directory, ["w:p", "/tmp/command"])).rejects.toMatchObject({ code: "invalid_command" });
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(container, { recursive: true }); }
});

test("prepare rejects a missing candidate without opening a worker", async () => {
  const container = mkdtempSync(join(realpathSync(tmpdir()), "prepare-entry-"));
  const directory = join(container, "w");
  try {
    await expect(runPlugin("prepare", directory, [])).rejects.toMatchObject({ code: "invalid_command" });
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(container, { recursive: true }); }
});

test("prepare-npm rejects missing or relative installation inputs before opening a worker", async () => {
  const container = mkdtempSync(join(realpathSync(tmpdir()), "prepare-npm-entry-")), directory = join(container, "w");
  try {
    for (const args of [[], ["relative", "/tmp/codex", "/tmp/npm", "/tmp/node"]])
      await expect(runPlugin("prepare-npm", directory, args)).rejects.toMatchObject({ code: "invalid_command" });
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(container, { recursive: true }); }
});

test("prepare-omo rejects incomplete or relative explicit inputs before opening a worker", async () => {
  const container = mkdtempSync(join(realpathSync(tmpdir()), "prepare-omo-entry-")), directory = join(container, "w");
  try {
    for (const args of [["/tmp/prefix"], ["relative", "/tmp/bun"]])
      await expect(runPlugin("prepare-omo", directory, args)).rejects.toMatchObject({ code: "invalid_command" });
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(container, { recursive: true }); }
});

test("standard worker rejects unsupported product configuration without loading a factory", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "configured-entry-")));
  const config = join(directory, "unsupported-runtime.json"), workerPath = join(directory, "worker");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, profile: "unsupported" }), { mode: 0o600 });
  try {
    const child = Bun.spawn([process.execPath, join(root, "scripts/plugin.ts"), "start"], {
      env: { ...process.env, HERDR_CLI_UPDATER_DIRECTORY: workerPath,
        HERDR_CLI_UPDATER_RUNTIME_CONFIG: config, HERDR_SOCKET: join(directory, "core.sock"),
        HERDR_CLI_UPDATER_RUNNER_FACTORY: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(1);
    expect(error.trim()).toBe("runtime_configuration");
    expect(existsSync(join(workerPath, "worker.json"))).toBe(false);
  } finally { rmSync(directory, { recursive: true }); }
});

test("configure rejects executable-shaped JSON without creating runtime authority", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "configure-entry-")));
  const input = join(directory, "input.json"), output = join(directory, "runtime.json");
  writeFileSync(input, JSON.stringify({ module: join(directory, "module.ts") }), { mode: 0o600 });
  try {
    const child = Bun.spawn([process.execPath, join(root, "scripts/plugin.ts"), "configure", input], {
      env: { ...process.env, HERDR_CLI_UPDATER_DIRECTORY: join(directory, "worker"),
        HERDR_CLI_UPDATER_RUNTIME_CONFIG: output }, stdout: "pipe", stderr: "pipe",
    });
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(1);
    expect(error.trim()).toBe("runtime_configuration");
    expect(existsSync(output)).toBe(false);
  } finally { rmSync(directory, { recursive: true }); }
});

test("workspace action uses the host-provided herdr binary without a PATH lookup", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "action-entry-")));
  const peer = join(directory, "herdr-peer");
  writeFileSync(peer, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  try {
    const child = Bun.spawn([process.execPath, join(root, "scripts/plugin.ts"), "action"], {
      env: { ...process.env, PATH: "", HERDR_BIN_PATH: peer, HERDR_CLI_UPDATER_RUNTIME_CONFIG: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, body, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit).toBe(0);
    expect(error).toBe("");
    expect(JSON.parse(body)).toEqual(["plugin", "pane", "open", "--plugin", "beomq.cli-updater",
      "--entrypoint", "updater", "--placement", "overlay", "--focus"]);
    expect(existsSync(join(directory, "worker"))).toBe(false);
  } finally { rmSync(directory, { recursive: true }); }
});
