import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { catalogRegistryDirectory, createAutomaticCatalogProvider, createCatalogProvider, parseCatalogRegistration, registerCatalog } from "../../src/service/catalog-provider";
import { createCatalogSourceOwner } from "../../src/service/catalog-sources";
import type { CatalogRegistration, SourceReference } from "../../src/service/catalog-provider";
import { readCatalog, validateCatalogSelection } from "../../src/catalog";
import { FAMILIES } from "../../src/adapters/types";
import type { Family } from "../../src/protocol";
import { serveDomainWorker, startWorker, stopWorker } from "../../src/service/worker";
import { requestPrivateSocket } from "../../src/service/socket";
import { attachAuthenticatedWorker, isServiceResponse } from "../../src/service/client";
import { digest as packageDigest, fixture as packageFixture } from "../../.omo/evidence/herdr-cli-updater/task-4/check-runtime-r1/fixture";

test("explicit production checker retains exact-source lastCheck across provider reconstruction", async () => {
  // Given: actual file refs/registry, HTTP wire and metadata owner.
  const f = await packageFixture(), directory = join(f.root, "worker");
  chmodSync(f.manifest, 0o644);
  registerCatalog(directory, JSON.stringify({ version: 1, candidates: [{ family: "pi",
    executable: { path: f.executable, sha256: packageDigest(readFileSync(f.executable)) }, provenance: null,
    sources: [{ role: "engine-manifest", path: f.manifest, sha256: packageDigest(readFileSync(f.manifest)) }] }], sockets: [] }));
  try {
    const provider = createCatalogProvider(directory, { request: f.request });
    const before = await readCatalog(provider()), installation = before.installations[0];
    expect(installation).toBeDefined();
    if (!installation) throw new Error("actual package missing");
    const { lastCheck: _lastCheck, ...identity } = installation;
    // When
    const checked = await provider().check?.(identity);
    // Then
    expect(checked).toMatchObject({ ok: true, value: { kind: "update-available", installedVersion: "2026.10.1-3", availableVersion: "2026.10.1-4" } });
    if (!checked?.ok) throw new Error("actual check failed");
    const after = await readCatalog(createCatalogProvider(directory, { request: f.request })());
    expect(after.installations[0]?.lastCheck).toEqual({ checkedAt: checked.value.checkedAt, result: checked.value });
    expect(after.installations[0]?.owner).toEqual(installation.owner);
    expect(after.installations[0]?.channel).toBe(installation.channel);
    expect(f.requests).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test("automatic refresh snapshot is shared by checks while candidate pins remain live", async () => {
  const f = await packageFixture(), directory = join(f.root, "worker");
  const owner = createCatalogSourceOwner(directory, { home: f.root, path: f.root, prefixes: [] });
  let scans = 0;
  const provider = createAutomaticCatalogProvider(directory, { ...owner, refresh: async signal => {
    scans++;
    return owner.refresh(signal);
  } }, { request: f.request });
  try {
    const initial = new AbortController();
    const first = await provider(initial.signal, "installations");
    expect((await readCatalog(first)).installations).toHaveLength(1);
    initial.abort();
    const [check, sessions, targets] = await Promise.all([provider(undefined, "check"), provider(undefined, "sessions"), provider(undefined, "targets")]);
    expect(check).toBe(first);
    expect(sessions).toBe(first);
    expect(targets).toBe(first);
    expect(scans).toBe(1);
    expect((await readCatalog(check)).installations).toHaveLength(1);
    writeFileSync(f.manifest, JSON.stringify({ name: "@openai/codex", version: "changed" }));
    expect((await readCatalog(check)).installations).toEqual([]);
    await provider(undefined, "installations");
    expect(scans).toBe(2);
  } finally { await owner.close(); await f.cleanup(); }
});

test("default automatic provider uses actual source pins without granting new capabilities", async () => {
  // Given: source owner reads a real task-owned PATH alias and package.
  const f = await packageFixture(), directory = join(f.root, "worker");
  const source = createCatalogSourceOwner(directory, { home: f.root, path: f.root, prefixes: [] });
  const provider = createAutomaticCatalogProvider(directory, source, { request: f.request });
  try {
    const readers = await provider(), before = await readCatalog(readers), installation = before.installations[0];
    expect(installation).toBeDefined();
    if (!installation) throw new Error("automatic package missing");
    const beforeCapabilities = before.observations.map(row => row.contract.capabilities);
    const { lastCheck: _lastCheck, ...identity } = installation;
    // When
    const checked = await readers.check?.(identity);
    // Then
    expect(checked).toMatchObject({ ok: true, value: { kind: "update-available" } });
    if (!checked?.ok) throw new Error("automatic check failed");
    const after = await readCatalog(await provider());
    expect(after.installations[0]?.lastCheck).toEqual({ checkedAt: checked.value.checkedAt, result: checked.value });
    expect(after.observations.map(row => row.contract.capabilities)).toEqual(beforeCapabilities);
    expect(after.installations[0]?.owner).toEqual({ kind: "unknown", reason: "unverified_owner" });
    expect(after.installations[0]?.channel).toBe("unknown");
  } finally { await source.close(); await f.cleanup(); }
});

test("an explicit refusal published during latest read cannot attach a check result", async () => {
  // Given
  const f = await packageFixture(), directory = join(f.root, "worker"), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  registerCatalog(directory, JSON.stringify({ version: 1, candidates: [{ family: "pi",
    executable: { path: f.executable, sha256: packageDigest(readFileSync(f.executable)) }, provenance: null,
    sources: [{ role: "engine-manifest", path: f.manifest, sha256: packageDigest(readFileSync(f.manifest)) }] }], sockets: [] }));
  const provider = createCatalogProvider(directory, { request: async input => { entered.resolve(); await release.promise; return f.request(input); } });
  try {
    const readers = provider(), installation = (await readCatalog(readers)).installations[0];
    if (!installation || !readers.check) throw new Error("actual package missing");
    const { lastCheck: _lastCheck, ...identity } = installation;
    const pending = readers.check(identity); await entered.promise;
    // When
    writeFileSync(join(catalogRegistryDirectory(directory), "sources.json"), "invalid", { mode: 0o600 });
    release.resolve();
    // Then
    expect((await pending).ok).toBe(false);
    expect(provider().registrationFailure).toEqual({ code: "verification_failed" });
  } finally { release.resolve(); await f.cleanup(); }
});

test.each(["quiet", "background", "wrong-entry", "wrong-package"] as const)("quiet OmO display requires a live foreground package process: %s", async variant => {
  const directory = root(), path = join(directory, "worker"), row = input("omo", directory);
  const manifestPath = join(directory, "omo/package.json"), plugin = join(directory, "omo/plugin");
  const engine = join(directory, "@code-yeongyu/senpi");
  mkdirSync(engine, { recursive: true, mode: 0o700 });
  const entry = artifact(join(engine, "cli.js"), "// owned engine\n", true);
  artifact(join(engine, "package.json"), JSON.stringify({ name: variant === "wrong-package" ? "other" : "@code-yeongyu/senpi", bin: { senpi: "cli.js" } }));
  artifact(manifestPath, JSON.stringify({ name: "omo-ai", dependencies: { "@code-yeongyu/senpi": "1.0.0" } }));
  const process = { name: "bun", argv: ["bun", variant === "wrong-entry" ? "/foreign/cli.js" : entry.path, "--extension", plugin, "PRIVATE_ARGV"] };
  const observed = await core(directory, [], { stock: true, agents: [], panes: [
    { pane_id: "quiet:1", terminal_id: "terminal:quiet", revision: 0, agent_status: "unknown", cwd: directory },
    { pane_id: "shell:1", terminal_id: "terminal:shell", revision: 0, agent_status: "unknown", cwd: directory },
  ], processInfo: pane => ({ pane_id: pane, foreground_processes: pane === "quiet:1" && variant !== "background" ? [process] : [],
    background_processes: variant === "background" ? [process] : [] }) });
  registerCatalog(path, registration([{ ...row, sources: [{ path: manifestPath, sha256: hash(readFileSync(manifestPath)), role: "wrapper-manifest" }] }], [observed.path]));
  const worker = await serveDomainWorker(path);
  shutdowns.push(worker.stop);
  const response = await readRequest(worker)("sessions");
  expect(response).toMatchObject({ ok: true, result: { unavailableSources: 0, sessions: variant === "quiet"
    ? [{ socketId: `socket:${hash(observed.path)}`, paneId: "quiet:1", family: "omo", status: "unknown", workComplete: null }] : [] } });
  expect(JSON.stringify(response)).not.toContain("PRIVATE_ARGV");
  expect(observed.methods.filter(method => method === "pane.process_info")).toHaveLength(2);
  const snapshot = await readCatalog(createCatalogProvider(path)());
  expect(snapshot.runtimes).toEqual([]);
  expect(snapshot.runtimeReadiness).toBe("unavailable");
});

test("detected Pi using another genuine OmO prefix remains an OmO display session", async () => {
  const directory = root(), path = join(directory, "worker"), row = input("omo", directory);
  const known = join(directory, "omo/package.json");
  const wrapper = join(directory, "other/node_modules/omo-ai"), engine = join(directory, "other/node_modules/@code-yeongyu/senpi");
  mkdirSync(wrapper, { recursive: true, mode: 0o700 });
  mkdirSync(engine, { recursive: true, mode: 0o700 });
  artifact(join(wrapper, "package.json"), JSON.stringify({ name: "omo-ai", dependencies: { "@code-yeongyu/senpi": "1.0.0" } }));
  artifact(join(engine, "package.json"), JSON.stringify({ name: "@code-yeongyu/senpi", bin: { senpi: "cli.js" } }));
  const entry = artifact(join(engine, "cli.js"), "// owned runtime\n", true);
  const observed = await core(directory, ["pi"], { stock: true, processInfo: pane => ({ pane_id: pane,
    foreground_processes: [{ argv: ["bun", entry.path, "--extension", join(wrapper, "plugin")] }] }) });
  registerCatalog(path, registration([{ ...row, sources: [{ path: known, sha256: hash(readFileSync(known)), role: "wrapper-manifest" }] }], [observed.path]));
  const worker = await serveDomainWorker(path);
  shutdowns.push(worker.stop);
  expect(await readRequest(worker)("sessions")).toMatchObject({ ok: true, result: { sessions: [{ family: "omo", paneId: "pane:pi" }] } });
  expect((await readCatalog(createCatalogProvider(path)())).runtimes).toEqual([]);
});

const roots: string[] = [];
const shutdowns: (() => Promise<void>)[] = [];
const hash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
function root(): string {
  const value = realpathSync(mkdtempSync("/tmp/cpr-"));
  roots.push(value);
  return value;
}
function artifact(path: string, body: string, executable = false): SourceReference {
  writeFileSync(path, body, { mode: executable ? 0o700 : 0o600 });
  return { path, sha256: hash(body) };
}
function input(family: Family, parent: string, name = family): CatalogRegistration["candidates"][number] {
  const directory = join(parent, name);
  mkdirSync(directory, { mode: 0o700 });
  const executable = artifact(join(directory, family === "cursor" ? "cursor-agent" : "cli"),
    "#!/usr/bin/env bun\nthrow new Error('must not execute registered binaries');\n", true);
  const packages: Partial<Record<Family, string>> = {
    omo: "omo-ai", omp: "@oh-my-pi/pi-coding-agent", pi: "@code-yeongyu/senpi",
    claude: "@anthropic-ai/claude-code", codex: "@openai/codex", grok: "@xai-official/grok",
  };
  if (packages[family]) artifact(join(directory, "package.json"), JSON.stringify({
    name: packages[family], version: "1.2.3", bin: { [family]: "cli" },
  }));
  return { family, executable, provenance: null, sources: [] };
}
function registration(candidates: CatalogRegistration["candidates"], sockets: readonly string[] = []): string {
  return JSON.stringify({ version: 1, candidates, sockets } satisfies CatalogRegistration);
}
function readRequest(worker: Awaited<ReturnType<typeof serveDomainWorker>>) {
  const token = readFileSync(worker.owner.tokenPath, "utf8");
  return (operation: "installations" | "sessions" | "runtimes" | "jobs") => requestPrivateSocket(worker.owner,
    { version: 1, requestId: operation, operation, token }, AbortSignal.timeout(3000));
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function core(parent: string, families: readonly Family[] = ["codex"], options: {
  readonly stock?: boolean;
  readonly producerComplete?: boolean;
  readonly agents?: readonly Record<string, unknown>[];
  readonly panes?: readonly Record<string, unknown>[];
  readonly processInfo?: (paneId: unknown) => Record<string, unknown>;
} = {}) {
  const path = join(parent, "core.sock");
  const connections = new Set<Socket>(), methods: string[] = [];
  const server = createServer(socket => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      data += chunk;
      if (!data.includes("\n")) return;
      const request: unknown = JSON.parse(data.slice(0, data.indexOf("\n")));
      if (!object(request) || typeof request["id"] !== "string" || typeof request["method"] !== "string"
        || !object(request["params"])) throw new TypeError("invalid core request");
      const method = request["method"], params = request["params"];
      methods.push(method);
      let result: unknown;
      switch (method) {
        case "agent.list": result = { type: "agent_list", agents: options.agents ?? families.map(family => ({
          terminal_id: `terminal:${family}`, pane_id: `pane:${family}`, agent: family, cwd: parent, revision: 71,
          agent_session: { source: "test-core", agent: family, kind: "conversation", value: `session:${family}` },
          tokens: { PRIVATE_SENTINEL: "must never leave core" }, title: "not a runtime identity",
        })) }; break;
        case "ping": result = { type: "pong", version: "test-core", protocol: 1,
          capabilities: options.stock ? {} : { updater_completion_v1: true } }; break;
        case "pane.list": result = { type: "pane_list", panes: options.panes ?? [] }; break;
        case "pane.process_info":
          expect(Object.keys(params)).toEqual(["pane_id"]);
          result = { type: "pane_process_info", process_info: options.processInfo?.(params["pane_id"])
            ?? { pane_id: params["pane_id"], foreground_processes: [] } };
          break;
        case "updater.completion.v1": {
          expect(params["operation"]).toEqual({ action: "inspect" });
          expect(params["owner"]).toBeNull();
          const family = params["family"];
          result = { type: "updater_completion", snapshot: {
            binding: { socket_id: path, socket_epoch: "actual-test-epoch", pane_id: params["pane_id"],
              pane_incarnation: "opaque-incarnation-not-a-number", root_pid: process.pid,
              root_start_identity: null, root_executable: null, session: null, cwd: parent, options_ref: null },
            family, generation: 3, sequence: 9,
            required_producers: ["root", "tool", "subagent", "background", "monitor", "continuation"],
            connected_producers: [], missing_producers: ["root", "tool", "subagent", "background", "monitor", "continuation"],
            producers: options.producerComplete ? [{ id: "root", kind: "root", parent: null,
              admitted_sequence: 1, finished_sequence: 2, outcome: "natural", sealed: true }] : [],
            runtime_source: "app.terminal_runtimes+PaneDied", producer_work_complete: options.producerComplete ?? false,
            admission_locked: false, lease_valid: false, runtime_alive: true, all_work_drained: false, input_fenced: false,
          } }; break;
        }
        default: throw new TypeError("mutating or unregistered core method");
      }
      socket.end(`${JSON.stringify({ id: request["id"], result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  shutdowns.push(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const connection of connections) connection.destroy();
    await closed;
  });
  return { path, methods, connections };
}
afterEach(async () => {
  for (const close of shutdowns.splice(0).reverse()) await close();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("invalid explicit publication cannot fall back to an automatically discovered package", async () => {
  // Given: automatically discoverable Codex and a present invalid explicit file.
  const directory = root(), path = join(directory, "worker"), row = input("codex", directory);
  mkdirSync(join(directory, "bin"), { mode: 0o700 });
  symlinkSync(row.executable.path, join(directory, "bin", "codex"));
  const source = createCatalogSourceOwner(path, { home: directory, path: join(directory, "bin"), prefixes: [] });
  const provider = createAutomaticCatalogProvider(path, source);
  try {
    expect((await readCatalog(await provider())).installations[0]?.family).toBe("codex");
    const explicitPath = join(catalogRegistryDirectory(path), "sources.json");
    writeFileSync(explicitPath, "invalid explicit input", { mode: 0o600 });
    // When
    const current = await provider();
    // Then
    expect(current.registrationFailure).toEqual({ code: "verification_failed" });
    expect(current.candidates).toEqual([]);
    expect(readFileSync(explicitPath, "utf8")).toBe("invalid explicit input");
  } finally { await source.close(); }
});

test("publishes a strict owner-private registry outside worker lifetime", async () => {
  // Given: real files, not injected catalog readers.
  const directory = root(), workerPath = join(directory, "worker"), row = input("codex", directory);
  registerCatalog(workerPath, registration([row]));
  const worker = await serveDomainWorker(workerPath);
  shutdowns.push(worker.stop);
  // When: read through the authenticated production domain and retire its owner.
  const response = await readRequest(worker)("installations");
  await worker.stop();
  // Then: registration survives and the ephemeral owner does not.
  expect(response).toMatchObject({ ok: true, result: { installations: [{
    family: "codex", executableRealpath: row.executable.path, installedVersion: { kind: "known", version: "1.2.3" },
  }] } });
  const registry = catalogRegistryDirectory(workerPath);
  expect(lstatSync(registry).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(registry, "sources.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(registry)).toEqual(["sources.json"]);
  expect(existsSync(workerPath)).toBe(false);
  expect(parseCatalogRegistration(readFileSync(join(registry, "sources.json"), "utf8")).candidates).toEqual([row]);
});

test("reloads atomic registration in an already running default worker", async () => {
  // Given: no registry at boot; the worker must not capture an empty static reader.
  const directory = root(), path = join(directory, "worker");
  const worker = await serveDomainWorker(path, undefined, { home: directory, path: "", prefixes: [] });
  shutdowns.push(worker.stop);
  expect(await readRequest(worker)("installations")).toMatchObject({ ok: true, result: { installations: [] } });
  // When: the bootstrap API publishes a candidate after boot.
  const row = input("claude", directory);
  registerCatalog(path, registration([row]));
  // Then: the same owner consumes it without restart or injected configuration.
  expect(await readRequest(worker)("installations")).toMatchObject({ ok: true, result: { installations: [{ family: "claude" }] } });
  expect(await readRequest(worker)("runtimes")).toMatchObject({ ok: false, error: { code: "unsupported" } });
});

test.each(["token", "runtime", "capabilities", "owner", "version"])("rejects registry authority or invalid schema field %s before publication", field => {
  // Given
  const directory = root(), path = join(directory, "worker"), row = input("codex", directory);
  registerCatalog(path, registration([row]));
  const registry = join(catalogRegistryDirectory(path), "sources.json"), before = readFileSync(registry);
  // When / Then
  expect(() => registerCatalog(path, JSON.stringify({ version: 1, candidates: [row], sockets: [], [field]: "forged" })))
    .toThrow();
  expect(readFileSync(registry)).toEqual(before);
});

test.each(["candidate-extra", "reference-extra", "relative", "duplicate", "digest", "socket-extra"] as const)(
  "rejects malformed registered source %s", variant => {
    // Given
    const directory = root(), row = input("codex", directory), path = join(directory, "worker");
    const changed = variant === "candidate-extra" ? { ...row, runtime: {} }
      : variant === "reference-extra" ? { ...row, executable: { ...row.executable, token: "forged" } }
      : variant === "relative" ? { ...row, executable: { ...row.executable, path: "./cli" } }
      : variant === "digest" ? { ...row, executable: { ...row.executable, sha256: "x" } } : row;
    // When / Then
    expect(() => registerCatalog(path, JSON.stringify({ version: 1,
      candidates: variant === "duplicate" ? [changed, changed] : [changed],
      sockets: variant === "socket-extra" ? [{ path: "/tmp/core", ownerToken: "forged" }] : [],
    }))).toThrow();
    expect(existsSync(catalogRegistryDirectory(path))).toBe(false);
  },
);

test.each(["directory-mode", "registry-mode", "registry-symlink"] as const)("rejects unsafe registry ownership shape %s", async variant => {
  // Given
  const directory = root(), path = join(directory, "worker"), row = input("codex", directory);
  registerCatalog(path, registration([row]));
  const registry = catalogRegistryDirectory(path), file = join(registry, "sources.json");
  if (variant === "directory-mode") chmodSync(registry, 0o755);
  if (variant === "registry-mode") chmodSync(file, 0o644);
  if (variant === "registry-symlink") {
    const foreign = artifact(join(directory, "foreign.json"), registration([row]));
    rmSync(file);
    symlinkSync(foreign.path, file);
  }
  // When
  const snapshot = await readCatalog(createCatalogProvider(path)());
  // Then
  expect(snapshot.installations).toEqual([]);
  expect(snapshot.failures).toEqual([{ sourceId: "registry", error: { code: "verification_failed" } }]);
  expect(() => registerCatalog(path, registration([row]))).toThrow();
});

test("rejects changed executable hashes without rewriting the registration", async () => {
  // Given
  const directory = root(), path = join(directory, "worker"), row = input("codex", directory);
  registerCatalog(path, registration([row]));
  const registry = join(catalogRegistryDirectory(path), "sources.json"), before = readFileSync(registry);
  writeFileSync(row.executable.path, "changed executable bytes");
  // When
  const snapshot = await readCatalog(createCatalogProvider(path)());
  // Then
  expect(snapshot.installations).toEqual([]);
  expect(snapshot.failures[0]?.error.code).toBe("verification_failed");
  expect(() => registerCatalog(path, registration([row]))).toThrow();
  expect(readFileSync(registry)).toEqual(before);
  expect(readdirSync(catalogRegistryDirectory(path))).toEqual(["sources.json"]);
});

test("discovers all eight configured families without launching a CLI or inventing native versions", async () => {
  // Given: owned executable files intentionally throw if executed.
  const directory = root(), path = join(directory, "worker");
  registerCatalog(path, registration(FAMILIES.map(family => input(family, directory))));
  // When
  const snapshot = await readCatalog(createCatalogProvider(path)());
  // Then: physical discovery is not native qualification.
  expect(snapshot.failures).toEqual([]);
  expect(snapshot.installations.map(row => row.family).sort()).toEqual([...FAMILIES].sort());
  expect(snapshot.installations.filter(row => row.family === "agy" || row.family === "cursor")
    .every(row => row.installedVersion.kind === "unknown")).toBe(true);
  expect(snapshot.observations.every(row => Object.values(row.contract.capabilities).every(cap => cap.kind !== "supported"))).toBe(true);
  expect(snapshot.runtimeReadiness).toBe("unavailable");
});

test("does not classify a Grok package as Cursor from the agent alias hint", async () => {
  // Given: a bound Grok package, explicitly but incorrectly configured as Cursor.
  const directory = root(), path = join(directory, "worker"), grok = input("grok", directory);
  registerCatalog(path, registration([{ ...grok, family: "cursor" }]));
  // When
  const snapshot = await readCatalog(createCatalogProvider(path)());
  // Then
  expect(snapshot.installations).toEqual([]);
  expect(snapshot.failures[0]?.error.code).toBe("identity_mismatch");
});

test("rejects an unqualified native agent alias rather than guessing Cursor or Grok", async () => {
  // Given
  const directory = root(), path = join(directory, "worker");
  const executable = artifact(join(directory, "agent"), "native bytes not an identity", true);
  registerCatalog(path, registration([{ family: "cursor", executable, provenance: null, sources: [] }]));
  // When
  const snapshot = await readCatalog(createCatalogProvider(path)());
  // Then
  expect(snapshot.installations).toEqual([]);
  expect(snapshot.failures[0]?.error.code).toBe("identity_mismatch");
});

test("maps a Pi engine view to its proven OmO wrapper resources", async () => {
  // Given: a hash-bound receipt for the exact wrapper and shared engine.
  const directory = root(), path = join(directory, "worker"), prefix = join(directory, "owned");
  mkdirSync(prefix, { mode: 0o700 });
  const wrapper = artifact(join(prefix, "omo"), "wrapper bytes", true);
  const engine = artifact(join(prefix, "pi"), "engine bytes", true);
  const wrapperManifest = artifact(join(prefix, "wrapper.json"), JSON.stringify({
    name: "omo-ai", version: "5.1.9", bin: { omo: "omo" }, dependencies: { "@code-yeongyu/senpi": "2026.10.2" },
  }));
  const engineManifest = artifact(join(prefix, "engine.json"), JSON.stringify({
    name: "@code-yeongyu/senpi", version: "2026.10.2", bin: { pi: "pi", senpi: "pi" },
  }));
  const receipt = artifact(join(prefix, "provenance.json"), JSON.stringify({
    family: "omo", executable: wrapper.path, channel: "latest",
    owner: { kind: "wrapper", packageName: "omo-ai", prefix, engineResourceId: `resource:${hash(engineManifest.path)}` },
    packageManifest: wrapperManifest.path, resources: [wrapper, engine, wrapperManifest, engineManifest],
  }));
  registerCatalog(path, registration([
    { family: "omo", executable: wrapper, provenance: receipt, sources: [
      { role: "wrapper-manifest", ...wrapperManifest }, { role: "engine-manifest", ...engineManifest },
    ] },
    { family: "pi", executable: engine, provenance: receipt, sources: [{ role: "engine-manifest", ...engineManifest }] },
  ]));
  // When
  const snapshot = await readCatalog(createCatalogProvider(path)());
  // Then: one real shared installation; not two updater authorities.
  expect(snapshot.failures).toEqual([]);
  expect(snapshot.installations).toHaveLength(1);
  expect(snapshot.observations).toHaveLength(2);
  expect(snapshot.installations[0]).toMatchObject({ family: "omo", executableRealpath: wrapper.path,
    installedVersion: { kind: "known", version: "5.1.9" }, owner: { kind: "wrapper" } });
});

test("retains eight incomplete core observations privately while authenticated installations remain readable", async () => {
  // Given: actual socket exchanges through the production registry/provider/domain.
  const directory = root(), path = join(directory, "worker"), observedCore = await core(directory, FAMILIES);
  registerCatalog(path, registration([input("codex", directory)], [observedCore.path]));
  const worker = await serveDomainWorker(path);
  shutdowns.push(worker.stop);
  // When
  const snapshot = await readCatalog(createCatalogProvider(path)());
  const installations = await readRequest(worker)("installations"), runtimes = await readRequest(worker)("runtimes");
  // Then: public v1 remains unchanged; source metadata is not runtime authority.
  expect(installations).toMatchObject({ ok: true, result: { installations: [{ family: "codex" }] } });
  expect(runtimes).toEqual({ version: 1, requestId: "runtimes", operation: "runtimes", ok: false, error: { code: "unsupported" } });
  const availability = snapshot.runtimeAvailability[0];
  expect(observedCore.methods).toContain("agent.list");
  expect(availability?.kind).toBe("unavailable");
  if (availability?.kind !== "unavailable") throw new TypeError("missing unavailable observation");
  expect(availability.observations).toHaveLength(8);
  expect(availability.observations[0]?.completion).toMatchObject({
    generation: 3, sequence: 9, binding: { pane_incarnation: "opaque-incarnation-not-a-number", root_start_identity: null },
  });
  expect(availability.observations[0]?.revision).toBe(71);
  expect(snapshot.runtimes).toEqual([]);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_SENTINEL");
  expect(JSON.stringify(snapshot)).not.toContain("paneGeneration");
  const installation = snapshot.installations[0];
  if (!installation) throw new TypeError("missing installation");
  expect(validateCatalogSelection(snapshot, installation, [])).toEqual({ ok: false, error: { code: "unsupported" } });
  expect(new Set(observedCore.methods)).toEqual(new Set(["agent.list", "ping", "updater.completion.v1"]));
  const token = readFileSync(worker.owner.tokenPath, "utf8");
  expect(await requestPrivateSocket(worker.owner, { version: 1, requestId: "targets", token,
    operation: "targets", installationId: installation.installationId })).toMatchObject({ ok: false, error: { code: "unsupported" } });
});

test("stock core sessions succeed over authenticated UDS without qualifying runtimes targets or jobs", async () => {
  // Given: stock core's 12 physical Pi rows, including a duplicate wire row.
  const directory = root(), path = join(directory, "worker");
  const agents = Array.from({ length: 12 }, (_, index) => ({
    pane_id: `pane:${index}`, terminal_id: `terminal:${index}`, agent: "pi",
    agent_status: index < 2 ? "working" : index === 11 ? "done" : "idle", revision: 1,
    title: "PRIVATE_SENTINEL", tokens: { private: "PRIVATE_SENTINEL" },
  }));
  const observed = await core(directory, [], { stock: true, agents: [...agents, ...agents.slice(0, 1)] });
  registerCatalog(path, registration([input("codex", directory)], [observed.path]));
  const worker = await serveDomainWorker(path);
  shutdowns.push(worker.stop);
  const client = await attachAuthenticatedWorker(path);
  try {
    // When: the real strict client admits the new operation.
    const response = await client.request({ operation: "sessions" });
    // Then: display success requires neither identity attestation nor restart authority.
    expect(response.ok).toBe(true);
    if (!response.ok) throw new TypeError("sessions rejected");
    expect(response.result.unavailableSources).toBe(0);
    expect(response.result.sessions).toHaveLength(12);
    expect(response.result.sessions.filter(row => row.status === "working")).toHaveLength(2);
    expect(response.result.sessions.filter(row => row.status === "idle")).toHaveLength(9);
    expect(response.result.sessions.filter(row => row.status === "done")).toHaveLength(1);
    expect(response.result.sessions.every(row => row.family === "pi")).toBe(true);
    expect(Object.keys(response.result)).toEqual(["sessions", "unavailableSources"]);
    expect(Object.keys(response.result.sessions[0] ?? {}).sort()).toEqual(["family", "paneId", "socketId", "status", "workComplete"]);
    expect(response.result.sessions.every(row => row.workComplete === null)).toBe(true);
    expect(JSON.stringify(response)).not.toContain("PRIVATE_SENTINEL");
    expect(await client.request({ operation: "runtimes" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const installations = await client.request({ operation: "installations" });
    if (!installations.ok || !installations.result.installations[0]) throw new TypeError("installation missing");
    const installation = installations.result.installations[0];
    expect(await client.request({ operation: "targets", installationId: installation.installationId }))
      .toMatchObject({ ok: false, error: { code: "unsupported" } });
    const { lastCheck: _lastCheck, family: _family, channel: _channel, executableRealpath: _executable, resources: _resources,
      ...selection } = installation;
    expect(await client.request({ operation: "create-job", mode: "update-only", installation: selection, selectedTargets: [] }))
      .toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(new Set(observed.methods)).toEqual(new Set(["agent.list", "ping"]));
  } finally { client.close(); }
});

test.each(["exact", "basename", "equals", "wrong-flag", "background", "wrong-pane", "missing-argv", "changed-manifest", "no-candidate"] as const)(
  "classifies physical Pi display only with discovered exact OmO extension: %s", async variant => {
    // Given: candidate package identity and a real read-only pane API exchange.
    const directory = root(), path = join(directory, "worker"), row = input("omo", directory);
    const manifestPath = join(directory, "omo", "package.json");
    const manifest = { path: manifestPath, sha256: hash(readFileSync(manifestPath)) };
    const plugin = join(directory, "omo", "plugin");
    const argv = ["bun", "/physical/senpi/dist/bundle/cli.js", "--extension", plugin, "PRIVATE_ARGV"];
    if (variant === "basename") argv[3] = "/different/omo-ai/plugin";
    if (variant === "equals") argv.splice(2, 2, `--extension=${plugin}`);
    if (variant === "wrong-flag") argv[2] = "--not-extension";
    const process = variant === "missing-argv" ? { name: "omo", cmdline: argv.join(" ") } : { name: "bun", argv };
    const observed = await core(directory, ["pi"], { stock: true, processInfo: paneId => ({
      pane_id: variant === "wrong-pane" ? "another-pane" : paneId,
      foreground_processes: variant === "background" ? [] : [process],
      background_processes: variant === "background" ? [process] : [],
    }) });
    registerCatalog(path, registration(variant === "no-candidate" ? [] : [
      { ...row, sources: [{ ...manifest, role: "wrapper-manifest" }] },
    ], [observed.path]));
    if (variant === "changed-manifest") writeFileSync(manifestPath, JSON.stringify({ name: "other-package" }));
    const worker = await serveDomainWorker(path);
    shutdowns.push(worker.stop);
    // When
    const response = await readRequest(worker)("sessions");
    // Then: only exact foreground argv matching the pinned package plugin upgrades display.
    expect(response).toMatchObject({ ok: true, result: { unavailableSources: 0, sessions: [{
      socketId: `socket:${hash(observed.path)}`, paneId: "pane:pi", family: variant === "exact" ? "omo" : "pi", status: "unknown", workComplete: null,
    }] } });
    expect(isServiceResponse(response)).toBe(true);
    expect(JSON.stringify(response)).not.toContain("PRIVATE_ARGV");
    expect(JSON.stringify(response)).not.toContain("argv");
    expect(new Set(observed.methods)).toEqual(new Set(variant === "changed-manifest" || variant === "no-candidate"
      ? ["agent.list", "ping"] : ["agent.list", "ping", "pane.list", "pane.process_info"]));
    const snapshot = await readCatalog(createCatalogProvider(path)());
    expect(snapshot.runtimes).toEqual([]);
    expect(snapshot.runtimeReadiness).toBe("unavailable");
  },
);

test("sessions retain healthy sources and count unavailable sources without counting identity gaps", async () => {
  // Given: one stock core and one missing socket; unknown detector values are display-only.
  const directory = root(), path = join(directory, "worker");
  const observed = await core(directory, [], { stock: true, agents: [{
    pane_id: "pane", terminal_id: "terminal", agent: "unrecognized-agent", agent_status: "future-status", revision: 0,
  }] });
  registerCatalog(path, registration([], [observed.path, join(directory, "absent.sock")]));
  const worker = await serveDomainWorker(path);
  shutdowns.push(worker.stop);
  // When / Then
  expect(await readRequest(worker)("sessions")).toMatchObject({ ok: true, result: {
    sessions: [{ socketId: `socket:${hash(observed.path)}`, paneId: "pane", family: null, status: "unknown" }], unavailableSources: 1,
  } });
});

test("producer-local completion with missing hooks does not become whole-work evidence", async () => {
  // Given: parsed completion says one root completed, but all six hooks are missing.
  const directory = root(), path = join(directory, "worker");
  const observed = await core(directory, ["codex"], { producerComplete: true, agents: [{
    pane_id: "pane:codex", terminal_id: "terminal", agent: "codex", agent_status: "idle", revision: 1,
  }] });
  registerCatalog(path, registration([], [observed.path]));
  const worker = await serveDomainWorker(path);
  shutdowns.push(worker.stop);
  // When
  const response = await readRequest(worker)("sessions");
  // Then: neither idle nor producer-local completion certifies all work.
  expect(response).toMatchObject({ ok: true, result: { unavailableSources: 0, sessions: [{
    status: "idle", workComplete: null,
  }] } });
  const snapshot = await readCatalog(createCatalogProvider(path)());
  const source = snapshot.runtimeAvailability[0];
  if (source?.kind !== "unavailable") throw new TypeError("observation missing");
  expect(source.observations[0]?.completion).not.toBeNull();
  expect(snapshot.runtimes).toEqual([]);
});

test.each(["missing", "wrong-mode", "empty-list"] as const)("does not hide %s runtime source as an empty success", async variant => {
  // Given
  const directory = root(), path = join(directory, "worker");
  const socket = variant === "missing" ? join(directory, "absent.sock") : (await core(directory, [])).path;
  if (variant === "wrong-mode") chmodSync(socket, 0o666);
  registerCatalog(path, registration([input("codex", directory)], [socket]));
  const worker = await serveDomainWorker(path);
  shutdowns.push(worker.stop);
  // When / Then
  expect(await readRequest(worker)("installations")).toMatchObject({ ok: true });
  expect(await readRequest(worker)("runtimes")).toMatchObject({ ok: false, error: { code: "unsupported" } });
});

test("returns installations without connecting an unrelated incomplete core source", async () => {
  // Given: a real registered core listener can causally record every connection.
  const directory = root(), path = join(directory, "worker"), observedCore = await core(directory);
  registerCatalog(path, registration([input("codex", directory)], [observedCore.path]));
  const worker = await serveDomainWorker(path);
  shutdowns.push(worker.stop);
  // When
  const response = await readRequest(worker)("installations");
  // Then: installation success is independent of runtime timing and completeness.
  expect(response).toMatchObject({ ok: true, result: { installations: [{ family: "codex" }] } });
  expect(observedCore.methods).toEqual([]);
  expect(observedCore.connections.size).toBe(0);
});

test("starts the real child worker on persisted registration and authenticates reads", async () => {
  // Given: no test reader enters the child process.
  const directory = root(), path = join(directory, "worker");
  registerCatalog(path, registration([input("codex", directory)]));
  const owner = await startWorker(path);
  shutdowns.push(async () => { if (existsSync(path)) await stopWorker(owner); });
  const token = readFileSync(owner.tokenPath, "utf8");
  // When
  const response = await requestPrivateSocket(owner, { version: 1, requestId: "child", operation: "installations", token });
  // Then
  expect(owner.pid).not.toBe(process.pid);
  expect(response).toMatchObject({ ok: true, result: { installations: [{ family: "codex" }] } });
  expect(await requestPrivateSocket(owner, { version: 1, requestId: "forged", operation: "installations", token: "0".repeat(64) }))
    .toMatchObject({ ok: false, error: { code: "unauthorized" } });
  await stopWorker(owner);
  expect(existsSync(path)).toBe(false);
});

test.each([...FAMILIES])("rejects a physical package disproving the %s family through a literal exec shim", async family => {
  // Given: the physical bin has a positively known, different package family.
  const directory = root(), path = join(directory, "worker");
  const actual = input(family === "grok" ? "codex" : family === "omp" ? "pi" : "grok", directory);
  const shim = artifact(join(directory, "launch"), `#!/bin/sh\nexec "${actual.executable.path}" "$@"\n`, true);
  registerCatalog(path, registration([{ family, executable: shim, provenance: null, sources: [] }]));
  // When
  const snapshot = await readCatalog(createCatalogProvider(path)());
  // Then: adapter rejection cannot erase physical package-family disproof.
  expect(snapshot.installations).toEqual([]);
  expect(snapshot.failures[0]?.error.code).toBe("identity_mismatch");
});

test("rejects an ambiguous physical agent behind a differently named literal exec shim", async () => {
  // Given
  const directory = root(), path = join(directory, "worker");
  const target = artifact(join(directory, "agent"), "unqualified physical bytes", true);
  const shim = artifact(join(directory, "launch"), `#!/bin/sh\nexec "${target.path}" "$@"\n`, true);
  registerCatalog(path, registration([{ family: "cursor", executable: shim, provenance: null, sources: [] }]));
  // When
  const snapshot = await readCatalog(createCatalogProvider(path)());
  // Then
  expect(snapshot.installations).toEqual([]);
  expect(snapshot.failures[0]?.error.code).toBe("identity_mismatch");
});

test.each(["replace", "rewrite", "unsafe-mode", "safe-mode"] as const)(
  "blocks resolved executable %s with unchanged registered shim and registry bytes", async change => {
    // Given: an honestly named physical package behind a valid literal launcher.
    const directory = root(), path = join(directory, "worker"), actual = input("codex", directory);
    const shim = artifact(join(directory, "launch"), `#!/bin/sh\nexec "${actual.executable.path}" "$@"\n`, true);
    registerCatalog(path, registration([{ ...actual, executable: shim }]));
    const registry = join(catalogRegistryDirectory(path), "sources.json"), before = readFileSync(registry);
    const baseline = await readCatalog(createCatalogProvider(path)());
    expect(baseline.installations[0]).toMatchObject({ family: "codex", executableRealpath: actual.executable.path });
    // When: only the resolved dependency changes.
    switch (change) {
      case "replace": {
        const replacement = artifact(join(directory, "replacement"), "different physical bytes", true);
        renameSync(replacement.path, actual.executable.path);
        break;
      }
      case "rewrite": writeFileSync(actual.executable.path, "different physical bytes"); break;
      case "unsafe-mode": chmodSync(actual.executable.path, 0o777); break;
      case "safe-mode": chmodSync(actual.executable.path, 0o500); break;
    }
    const snapshot = await readCatalog(createCatalogProvider(path)());
    // Then: no newly adopted target fingerprint or mode from unchanged registration.
    expect(snapshot.installations).toEqual([]);
    expect(snapshot.failures[0]?.error.code).toBe("verification_failed");
    expect(readFileSync(registry)).toEqual(before);
    expect(hash(readFileSync(shim.path))).toBe(shim.sha256);
  },
);

test("registers every literal exec dependency and rejects an intermediate mode change", async () => {
  // Given: a two-hop launcher, with no caller-provided target authority.
  const directory = root(), path = join(directory, "worker"), actual = input("codex", directory);
  const middle = artifact(join(directory, "middle"), `#!/bin/sh\nexec "${actual.executable.path}" "$@"\n`, true);
  const shim = artifact(join(directory, "launch"), `#!/bin/sh\nexec "${middle.path}" "$@"\n`, true);
  registerCatalog(path, registration([{ ...actual, executable: shim }]));
  const registry = join(catalogRegistryDirectory(path), "sources.json");
  expect(parseCatalogRegistration(readFileSync(registry, "utf8"))).toMatchObject({ candidates: [{
    resolvedExecutables: [{ ...middle, mode: 0o700 }, { ...actual.executable, mode: 0o700 }],
  }] });
  // When
  chmodSync(middle.path, 0o500);
  const snapshot = await readCatalog(createCatalogProvider(path)());
  // Then
  expect(snapshot.installations).toEqual([]);
  expect(snapshot.failures[0]?.error.code).toBe("verification_failed");
});

test("refuses an unsafe resolved executable before replacing a valid publication", () => {
  // Given
  const directory = root(), path = join(directory, "worker"), actual = input("codex", directory);
  registerCatalog(path, registration([actual]));
  const registry = join(catalogRegistryDirectory(path), "sources.json"), before = readFileSync(registry);
  const shim = artifact(join(directory, "launch"), `#!/bin/sh\nexec "${actual.executable.path}" "$@"\n`, true);
  chmodSync(actual.executable.path, 0o777);
  // When / Then
  expect(() => registerCatalog(path, registration([{ ...actual, executable: shim }]))).toThrow();
  expect(readFileSync(registry)).toEqual(before);
});

test("never learns missing resolved pins while reading a legacy shim registration", async () => {
  // Given: the prior exact registry format named only the launcher.
  const directory = root(), path = join(directory, "worker"), actual = input("codex", directory);
  const shim = artifact(join(directory, "launch"), `#!/bin/sh\nexec "${actual.executable.path}" "$@"\n`, true);
  const legacy = registration([{ ...actual, executable: shim }]);
  registerCatalog(path, legacy);
  const registry = join(catalogRegistryDirectory(path), "sources.json");
  writeFileSync(registry, legacy);
  // When
  const snapshot = await readCatalog(createCatalogProvider(path)());
  // Then: only explicit bootstrap publication can capture current target refs.
  expect(snapshot.installations).toEqual([]);
  expect(snapshot.failures[0]?.error.code).toBe("verification_failed");
  expect(readFileSync(registry, "utf8")).toBe(legacy);
});

test.each(["bytes", "mode"] as const)("does not silently repin supplied resolved references after %s drift", change => {
  // Given: a bootstrap caller resubmits an immutable captured reference set.
  const directory = root(), path = join(directory, "worker"), actual = input("codex", directory);
  const shim = artifact(join(directory, "launch"), `#!/bin/sh\nexec "${actual.executable.path}" "$@"\n`, true);
  registerCatalog(path, registration([{ ...actual, executable: shim }]));
  const registry = join(catalogRegistryDirectory(path), "sources.json"), before = readFileSync(registry, "utf8");
  if (change === "bytes") writeFileSync(actual.executable.path, "new target bytes");
  else chmodSync(actual.executable.path, 0o500);
  // When / Then
  expect(() => registerCatalog(path, before)).toThrow();
  expect(readFileSync(registry, "utf8")).toBe(before);
});

test("does not follow an unregistered symlink dependency during bootstrap", () => {
  // Given
  const directory = root(), path = join(directory, "worker"), actual = input("codex", directory);
  const alias = join(directory, "target-link");
  symlinkSync(actual.executable.path, alias);
  const shim = artifact(join(directory, "launch"), `#!/bin/sh\nexec "${alias}" "$@"\n`, true);
  // When / Then: canonical refs are required, not a movable alias plus a learned hash.
  expect(() => registerCatalog(path, registration([{ ...actual, executable: shim }]))).toThrow();
  expect(existsSync(catalogRegistryDirectory(path))).toBe(false);
});
