import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPackageUpdateSpec, executePackageUpdate, qualifyPackageUpdate } from "../../src/adapters/package-update";
import type { PackagePrefixSnapshot, PackageUpdateQualification } from "../../src/adapters/package-update";
import type { AdapterResult, InstallationIdentity } from "../../src/adapters/types";
import { evaluateResourceGate, parseResourcePlan } from "../../src/install/resources";
import { loadPackageRuntime, PACKAGE_OPERATING_RUNTIME_PROFILE, PACKAGE_RUNTIME_PROFILE,
  validatePackageRuntimeInputs } from "../../src/service/package-runtime";
import type { PackageRuntimeInputs } from "../../src/service/package-runtime";
import { configurePluginRuntime, loadPluginRuntime } from "../../src/service/plugin-runtime";
import type { PluginRuntimeLoad } from "../../src/service/plugin-runtime";
import { serveDomainWorker, serveWorker, unsupportedDomainHandler } from "../../src/service/worker";
import type { RestartBinding } from "../../src/core/client";
import { readCatalog } from "../../src/catalog";
import { createDomain } from "../../src/service/domain";
import { createUpdateOnlyJobRunner } from "../../src/service/job-runner";
import { composeCodexRuntime, prepareCodexRuntime } from "../../src/service/codex-runtime";

const hash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function value<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}
function put(path: string, body: string | Uint8Array, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode }); chmodSync(path, mode);
  return { path, sha256: hash(body) };
}
async function socket(path: string) {
  const server = createServer(peer => peer.end()), listening = once(server, "listening");
  server.listen(path); await listening; chmodSync(path, 0o600);
  cleanups.push(async () => { const closed = once(server, "close"); server.close(); await closed; });
}
/** Controlled npm-shaped bytes, never an operating manager invocation or vendor
 * acquisition claim. Exact real npm/Node files are read and pinned, not run.
 */
async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "op-"))); roots.push(base);
  const root = join(base, "preparation"), prefix = join(base, "selected-npm");
  mkdirSync(root, { mode: 0o700 }); mkdirSync(prefix, { mode: 0o755 });
  const home = join(root, "home"), directory = join(root, "worker");
  mkdirSync(home, { mode: 0o700 });
  const sockets = directory, runtimeCleanups: (() => void)[] = [];
  let worker = serveWorker(directory, unsupportedDomainHandler);
  cleanups.push(async () => { await worker.stop(); });
  const npm = Bun.which("npm"), node = Bun.which("node");
  if (!npm || !node) throw new TypeError("fixture_original_manager_missing");
  const originalManager = realpathSync(npm), nodePath = realpathSync(node);
  const managerRoot = join(root, "original-npm");
  // npm's distributed root .npmrc is not a content pin. This controlled fixture
  // uses a private original-manager tree without loading or copying config.
  cpSync(dirname(dirname(originalManager)), managerRoot, { recursive: true,
    filter: path => !path.endsWith("/.npmrc") });
  const managerPath = join(managerRoot, "bin/npm-cli.js");
  const managerFiles: { path: string; sha256: string }[] = [], pending = [managerRoot];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) pending.push(path);
      else managerFiles.push({ path, sha256: hash(readFileSync(path)) });
    }
  }
  const packageName = "@openai/codex", localManifest = `lib/node_modules/${packageName}/package.json`;
  const localBin = `lib/node_modules/${packageName}/bin/codex.js`, executable = join(prefix, localBin);
  const manifest = (version: string) => JSON.stringify({ name: packageName, version, bin: { codex: "bin/codex.js" } });
  const beforeBody = "#!/usr/bin/env node\nconsole.log('1.0.0');\n";
  const afterBody = "#!/usr/bin/env node\nconsole.log('1.1.0');\n";
  put(join(prefix, localManifest), manifest("1.0.0"), 0o644); put(executable, beforeBody, 0o755);
  const sibling = put(join(prefix, "lib/node_modules/unrelated/keep.txt"), "unchanged sibling", 0o644);
  mkdirSync(join(prefix, "bin"), { mode: 0o755 }); symlinkSync(`../${localBin}`, join(prefix, "bin/codex"));
  const links = [{ path: "bin/codex", target: `../${localBin}` }];
  const beforeSnapshot: PackagePrefixSnapshot = { files: [
    { path: localManifest, sha256: hash(manifest("1.0.0")), mode: 0o644 },
    { path: localBin, sha256: hash(beforeBody), mode: 0o755 },
    { path: sibling.path.slice(prefix.length + 1), sha256: sibling.sha256, mode: 0o644 },
  ], links };
  const afterSnapshot: PackagePrefixSnapshot = { files: beforeSnapshot.files.map(row =>
    row.path === localManifest ? { ...row, sha256: hash(manifest("1.1.0")) }
      : row.path === localBin ? { ...row, sha256: hash(afterBody) } : row), links };
  const resources = beforeSnapshot.files.map(row => ({ resourceId: `resource:${hash(join(prefix, row.path))}`,
    realpath: join(prefix, row.path), fingerprint: `sha256:${row.sha256}` })).sort((a, b) => a.realpath.localeCompare(b.realpath));
  const owner = { kind: "package", manager: "npm", prefix, packageName } as const;
  const before: InstallationIdentity = { family: "codex", channel: "stable/npm-latest", executableRealpath: executable,
    installationId: `install:${hash(executable)}`, owner, installedVersion: { kind: "known", version: "1.0.0" },
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  const afterResources = resources.map(row => {
    const after = afterSnapshot.files.find(file => join(prefix, file.path) === row.realpath);
    if (!after) throw new TypeError("fixture_after_resource");
    return { ...row, fingerprint: `sha256:${after.sha256}` };
  });
  const after: InstallationIdentity = { ...before, installedVersion: { kind: "known", version: "1.1.0" },
    resources: afterResources, resourcesFingerprint: `sha256:${hash(JSON.stringify(afterResources))}` };
  const archive = await new Bun.Archive({ "package/package.json": manifest("1.1.0"),
    "package/bin/codex.js": afterBody }, { compress: "gzip" }).bytes();
  const metadata = put(join(root, "metadata.json"), JSON.stringify({ name: packageName, version: "1.1.0",
    bin: { codex: "bin/codex.js" }, dist: { integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.1.0.tgz" } }));
  const now = Date.now(), q: PackageUpdateQualification = { installation: before,
    manager: { name: "npm", path: managerPath, sha256: hash(readFileSync(managerPath)), files: managerFiles,
      node: { path: nodePath, sha256: hash(readFileSync(nodePath)) } },
    env: { HOME: home, PATH: [...new Set([dirname(managerPath), dirname(nodePath)])].join(":") },
    target: { packageName, version: "1.1.0", channel: "stable/npm-latest", checkedAt: now, expiresAt: now + 300_000,
      artifacts: [{ name: packageName, installName: packageName, version: "1.1.0",
        archive: put(join(root, "target.tgz"), archive), metadata }], postinstall: [] },
    before: beforeSnapshot, after: afterSnapshot,
    confinement: { kind: "operating-prefix", root,
      system: { path: "/usr/bin/sandbox-exec", sha256: hash(readFileSync("/usr/bin/sandbox-exec")) } } };
  const provenance = put(join(root, "discovery.json"), JSON.stringify({ family: "codex", executable, channel: "stable/npm-latest",
    owner, packageManifest: join(prefix, localManifest),
    resources: resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })) }));
  function authorize(qualification = q) {
    return { qualification, receipt: put(join(root, "qualification.json"), JSON.stringify(qualification)) };
  }
  const input: PackageRuntimeInputs = { schemaVersion: 1, profile: PACKAGE_OPERATING_RUNTIME_PROFILE,
    ownerDirectory: directory, profiles: [{ update: authorize(), sourcePins: [provenance],
      expectedAfterPin: put(join(root, "after.json"), JSON.stringify(after)),
      acquiredReplies: [{ url: `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, status: 200, body: metadata },
        { url: `https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`, status: 200,
          body: put(join(root, "tags.json"), JSON.stringify({ latest: "1.1.0" })) },
        { url: "https://api.github.com/repos/openai/codex/releases/latest", status: 200,
          body: put(join(root, "github.json"), JSON.stringify({ tag_name: "rust-v1.1.0", draft: false, prerelease: false })) }],
      coverage: { root, prefix, socketDirectory: sockets,
        registeredSockets: [worker.owner.socketPath, worker.owner.controlPath], rootPids: [process.pid] } }] };
  const p = input.profiles[0]; if (!p) throw new TypeError("fixture_profile");
  const replies = p.acquiredReplies;
  const context = { directory, coreSocket: "" };
  async function load(data: PackageRuntimeInputs = input) {
    const result = await loadPackageRuntime(context, put(join(root, "runtime.json"), JSON.stringify(data)), data, async request => {
      const reply = replies.find(row => row.url === request.url);
      if (!reply) throw new TypeError("fixture_reply");
      return new Response(readFileSync(reply.body.path));
    });
    if (result.kind === "configured") {
      let active = true;
      const close = () => { if (active) { result.runner.queue.close(); active = false; } };
      runtimeCleanups.push(close); cleanups.push(async () => { close(); });
    }
    return result;
  }
  async function restart() {
    for (const close of runtimeCleanups) close();
    await worker.stop();
    expect(existsSync(directory)).toBe(false);
    worker = serveWorker(directory, unsupportedDomainHandler);
  }
  return { base, root, prefix, home, sockets, directory, context, input, p, q, before, now, authorize, load,
    restart, owner: () => worker.owner };
}
function configured(result: PluginRuntimeLoad) {
  if (result.kind !== "configured") throw new TypeError(JSON.stringify(result));
  const profile = result.runner.profiles?.[0]; if (!profile) throw new TypeError("fixture_profile");
  const spec = value(profile.adapter.updateSpec(profile.contract.installation, "update-only"));
  const plan = value(parseResourcePlan({ contract: profile.contract, mode: "update-only", selectedTargets: [],
    installerDigest: hash("controlled_installer"), mutationResources: spec.mutationResources,
    transition: { expectedAfter: profile.expectedAfter, mutationRoots: profile.mutationRoots } }));
  return { profile, plan };
}

/** Controlled wire peer only; genuine Codex/native qualification belongs to the
 * separately acquired integration evidence, not these regression fixtures. */
async function nativeFixture(family: "codex" | "omp" | "pi" | "omo" | "claude" = "codex") {
  const f = await fixture(), coreSocket = join(f.root, "core.sock"), operationsPath = join(f.root, "operations.jsonl");
  put(operationsPath, "");
  const sessionPath = join(f.root, "rollout.jsonl"), id = "12345678-1234-1234-1234-123456789abc";
  put(sessionPath, (family === "omp" ? JSON.stringify({ type: "title", v: 1, title: "saved" }) + "\n" : "") + JSON.stringify(family === "codex"
    ? { type: "session_meta", payload: { id, cwd: f.root, history_mode: "paginated" } }
    : family === "claude" ? { type: "user", sessionId: id, cwd: f.root, message: { role: "user", content: "saved" } }
      : { type: "session", version: 3, id, cwd: f.root }) + "\n");
  const options = family === "codex"
    ? { argv_sha256: "a".repeat(64), effective_settings_sha256: "b".repeat(64), model_sha256: "c".repeat(64), thinking_sha256: "d".repeat(64) }
    : { argv: "a".repeat(64), effective_settings: "b".repeat(64), model: "c".repeat(64), thinking: "d".repeat(64) };
  const environment = { HOME: f.home };
  const identity = { version: "controlled-core", protocol: 1, schemaSha256: "a".repeat(64) };
  const root = { pid: process.pid, parent_pid: process.ppid, uid: process.getuid?.() ?? 0, pgid: process.pid,
    tty: 1, start_seconds: 1, start_microseconds: 0, executable: f.before.executableRealpath };
  const expectedBinding: RestartBinding = { socket_epoch: "controlled", pane_id: "pane", terminal_id: "terminal",
    slot: "b".repeat(64), generation: 1, supervisor: { ...root, pid: process.ppid }, root,
    work_generation: 0, input_sequence: 0, launch_ref: "c".repeat(64), session: { full_id: id,
      storage_identity: hash(sessionPath), cwd: f.root, options_sha256: hash(JSON.stringify(options)),
      environment_sha256: hash(JSON.stringify(environment)) } };
  const sourceBinding = put(join(f.root, "profiles/codex.json"), JSON.stringify({
    qualification: { kind: "native", family, source_revision: "a".repeat(64) },
    ...(family === "codex" ? {} : { entrypoint: root.executable }),
    executable: root.executable, session_path: sessionPath, full_session_id: id, cwd: f.root, options, environment }));
  let binding = expectedBinding, qualified = true, recovery = false;
  const calls: string[] = [];
  const server = createServer(peer => {
    let data = "";
    peer.on("data", bytes => {
      data += bytes.toString(); if (!data.includes("\n")) return;
      const request = JSON.parse(data.slice(0, data.indexOf("\n")));
      const action = request.method === "ping" ? "ping" : request.params.action;
      calls.push(action);
      peer.end(JSON.stringify({ id: request.id, result: action === "ping"
        ? { type: "pong", ...identity, capabilities: { updater_restart_v1: true, updater_restart_schema_sha256: identity.schemaSha256 } }
        : { type: "updater_restart", snapshot: { binding, receipt: null, owner_token: null,
          native_qualified: qualified, recovery_required: recovery, replay_ready: false } } }) + "\n");
    });
  });
  const listening = once(server, "listening"); server.listen(coreSocket); await listening; chmodSync(coreSocket, 0o600);
  cleanups.push(async () => { const closed = once(server, "close"); server.close(); await closed; });
  const node = f.q.manager.node; if (!node) throw new TypeError("fixture_node");
  const native = { coreSocket, coreIdentity: identity, operationsPath, runtimeId: "owned-codex", profile: "codex",
    sessionPath, sourceBinding, node, expectedBinding };
  const input: PackageRuntimeInputs = { ...f.input, profiles: [{ ...f.p, native }] };
  async function load() {
    return loadPackageRuntime({ ...f.context, coreSocket }, put(join(f.root, "runtime.json"), JSON.stringify(input)), input,
      async request => {
        const reply = f.p.acquiredReplies.find(row => row.url === request.url);
        if (!reply) throw new TypeError("fixture_reply");
        return new Response(readFileSync(reply.body.path));
      });
  }
  return { ...f, input, native, calls, load, drift: () => { binding = { ...binding, generation: binding.generation + 1 }; },
    unqualify: () => { qualified = false; }, recover: () => { recovery = true; } };
}

test.each(["omp", "pi", "omo", "claude"] as const)("composes native %s only with exact interpreter session evidence", async family => {
  const f = await nativeFixture(family), installation = { ...f.before, family };
  const composed = await composeCodexRuntime(f.native, { context: { ...f.context, coreSocket: f.native.coreSocket },
    installation, fence: () => {}, observeBefore: () => installation, observeAfter: () => installation });
  expect((await composed.lifecycle.inspect(composed.target, AbortSignal.timeout(5000))).ok).toBe(true);
  put(f.native.sessionPath, JSON.stringify({ type: "session", version: 3, id: "different", cwd: f.root }) + "\n");
  expect((await composed.lifecycle.inspect(composed.target, AbortSignal.timeout(5000))).ok).toBe(false);
}, 30_000);

test.each(["qualified", "unqualified", "recovery"] as const)("prepares Codex native evidence from fresh %s core", async state => {
  const f = await nativeFixture();
  const { coreIdentity: _coreIdentity, expectedBinding, sourceBinding: _sourceBinding, ...candidate } = f.native;
  if (state === "unqualified") f.unqualify();
  if (state === "recovery") f.recover();
  const prepared = prepareCodexRuntime({ ...candidate, paneId: expectedBinding.pane_id });
  if (state === "qualified") expect(await prepared).toEqual(f.native);
  else await expect(prepared).rejects.toThrow("native");
}, 30_000);

test("exposes a fresh Codex target while retaining operating installation update-only authority", async () => {
  // Given
  const f = await nativeFixture();
  // When
  const loaded = await f.load();
  if (loaded.kind !== "configured") throw new TypeError(JSON.stringify(loaded));
  try {
    const catalog = await readCatalog(loaded.readers), profile = loaded.runner.profiles?.[0];
    const domain = createDomain(f.directory, loaded.readers, undefined, store => createUpdateOnlyJobRunner({
      ...loaded.runner, store, owner: f.owner(), publication: { sequence: 0, admit: () => null, publish: () => {} } }));
    try {
      const targets = await domain.handle({ version: 1, token: "", requestId: "select-codex", operation: "targets",
        installationId: f.before.installationId }, new AbortController().signal);
      expect(targets).toMatchObject({ ok: true, result: { targets: [{ runtimeId: "owned-codex" }],
        selection: { targets: [{ readiness: { kind: "supported" } }] } } });
    } finally { await domain.close(); }
    // Then
    expect(catalog.runtimes).toHaveLength(1);
    expect(catalog.runtimes[0]).toMatchObject({ runtimeId: "owned-codex", binding: {
      session: { fullId: f.native.expectedBinding.session.full_id }, optionsRef: `options:${f.native.expectedBinding.session.options_sha256}` } });
    expect(catalog.failures).toEqual([]);
    expect(profile?.lifecycle).toBeDefined();
    expect(profile?.adapter.updateSpec(f.before, "update-only").ok).toBe(true);
    expect(profile?.adapter.updateSpec(f.before, "update-and-restart")).toEqual({ ok: false, error: { code: "unsupported" } });
    expect(f.calls.every(action => action === "ping" || action === "inspect")).toBe(true);
  } finally { loaded.runner.queue.close(); }
}, 30_000);

test.each(["binding", "qualification", "recovery", "session", "history-mode", "profile-pin", "installation"] as const)(
  "revokes the Codex target after fresh %s drift", async kind => {
    // Given
    const f = await nativeFixture(), loaded = await f.load();
    if (loaded.kind !== "configured") throw new TypeError(JSON.stringify(loaded));
    try {
      switch (kind) {
        case "binding": f.drift(); break;
        case "qualification": f.unqualify(); break;
        case "recovery": f.recover(); break;
        case "session": put(f.native.sessionPath, JSON.stringify({ type: "session_meta", payload: { id: "other", cwd: f.root } })); break;
        case "history-mode": put(f.native.sessionPath, JSON.stringify({ type: "session_meta", payload: {
          id: f.native.expectedBinding.session.full_id, cwd: f.root, history_mode: "future" } })); break;
        case "profile-pin": put(f.native.sourceBinding.path, "{}"); break;
        case "installation": put(f.before.executableRealpath, "changed", 0o755); break;
      }
      // When
      const catalog = await readCatalog(loaded.readers);
      // Then
      expect(catalog.runtimes).toEqual([]);
      expect(catalog.runtimeAvailability).toMatchObject([{ kind: "unavailable", reason: "source_unavailable" }]);
      expect(f.calls.every(action => action === "ping" || action === "inspect")).toBe(true);
    } finally { loaded.runner.queue.close(); }
  }, 30_000);

test.each(["options", "storage", "unqualified", "pin", "unknown-key"] as const)(
  "rejects persisted Codex %s mismatch before exposing a target", async kind => {
    // Given
    const f = await nativeFixture();
    const native = kind === "options" ? { ...f.native, expectedBinding: { ...f.native.expectedBinding,
      session: { ...f.native.expectedBinding.session, options_sha256: "0".repeat(64) } } }
      : kind === "storage" ? { ...f.native, sessionPath: f.q.manager.path }
      : kind === "pin" ? { ...f.native, sourceBinding: { ...f.native.sourceBinding, sha256: "0".repeat(64) } }
      : kind === "unknown-key" ? { ...f.native, command: "/bin/true" } : f.native;
    if (kind === "unqualified") f.unqualify();
    const input = { ...f.input, profiles: [{ ...f.p, native }] };
    // When
    const loaded = await loadPackageRuntime({ ...f.context, coreSocket: f.native.coreSocket },
      put(join(f.root, "runtime.json"), JSON.stringify(input)), input);
    // Then
    expect(loaded.kind).toBe("unsupported");
  }, 30_000);

test.each([0o755, 0o700])("admits explicit original npm prefix mode %s outside preparation without widening mutation scope", async mode => {
  // Given
  const f = await fixture(); chmodSync(f.prefix, mode);
  // When
  const result = await f.load(), { profile, plan } = configured(result);
  const observed = profile.observe(plan);
  // Then
  expect(evaluateResourceGate(plan, observed).ok).toBe(true);
  expect(profile.mutationRoots).toEqual([f.prefix]);
  expect(profile.mutationScopeRoot).toBeUndefined();
  expect(profile.adapter.updateSpec(f.before, "update-and-restart").ok).toBe(false);
  expect(observed).toMatchObject({ allSocketsKnown: true, outsideConsumersKnown: true, consumers: [] });
  expect(validatePackageRuntimeInputs(f.input)).toEqual(f.input);
});

test("denies restart at the operating qualifier issuer itself", async () => {
  // Given
  const f = await fixture(), context = value(await qualifyPackageUpdate(f.p.update, f.now));
  // When
  const result = createPackageUpdateSpec(context, "update-and-restart", f.now);
  // Then
  expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
});

test("retains static child confinement and exact manager arguments without invoking a manager", async () => {
  // Given
  const f = await fixture(), context = value(await qualifyPackageUpdate(f.p.update, f.now));
  const spec = value(createPackageUpdateSpec(context, "update-only", f.now));
  let calls = 0;
  // When: inspect the dispatch boundary; never launch the operating command.
  const result = await executePackageUpdate(spec, { now: () => f.now, run: async command => {
    calls++;
    expect(command.executable).toBe("/usr/bin/sandbox-exec");
    expect(command.args[0]).toBe("-p");
    expect(command.args[2]).toBe(f.q.manager.path);
    expect(command.args.slice(3, 8)).toEqual(["install", "--global", "--prefix", f.prefix, "@openai/codex@1.1.0"]);
    expect(f.prefix).toBe(command.cwd);
    expect(command.inheritEnv).toBe(false);
    expect(command.env["HOME"]).toBe(f.home);
    expect(command.env["PATH"]).toBe(f.q.env["PATH"]);
    const cache = command.env["npm_config_cache"];
    if (!cache) throw new TypeError("fixture_dispatch_cache");
    const writes = command.args[1]?.split("\n").find(line => line.startsWith("(allow file-write* "));
    expect(writes).toBe(`(allow file-write* (subpath ${JSON.stringify(f.prefix)}) (subpath ${JSON.stringify(dirname(cache))}))`);
    for (const key of ["npm_config_userconfig", "npm_config_globalconfig"]) {
      const path = command.env[key]; if (!path) throw new TypeError("fixture_dispatch_config");
      expect(readFileSync(path, "utf8")).toBe("");
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
    return { status: 1, signal: null };
  } });
  // Then: a refused dispatch cannot masquerade as verified after bytes.
  expect(calls).toBe(1);
  expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
  expect(readdirSync(f.home)).toEqual([]);
});

test.each(["private-profile", "missing-kind", "missing-confinement", "unknown-kind", "bun", "grok", "home-output"] as const)(
  "rejects operating profile mismatch %s before qualification", async defect => {
    // Given
    const f = await fixture(), input = structuredClone(f.input), p = input.profiles[0];
    if (!p || !p.update.qualification.confinement) throw new TypeError("fixture_scope");
    const q = p.update.qualification, scope = p.update.qualification.confinement;
    switch (defect) {
      case "private-profile": Reflect.set(input, "profile", PACKAGE_RUNTIME_PROFILE); break;
      case "missing-kind": Reflect.deleteProperty(scope, "kind"); break;
      case "missing-confinement": Reflect.deleteProperty(q, "confinement"); break;
      case "unknown-kind": Reflect.set(scope, "kind", "private-prefix"); break;
      case "bun": Reflect.set(q.manager, "name", "bun"); Reflect.set(q, "env", { ...q.env, BUN_INSTALL: f.prefix }); break;
      case "grok": Reflect.set(q.installation, "family", "grok"); break;
      case "home-output": Reflect.set(q, "home", { before: { files: [], links: [] }, after: { files: [], links: [] } }); break;
    }
    // When / Then
    expect(() => validatePackageRuntimeInputs(input)).toThrow();
  });

test.each(["mode-775", "mode-702", "mode-750", "mode-special", "prep-755", "home-755", "prefix-in-prep",
  "prep-in-prefix", "prefix-is-prep", "home-sibling", "home-prefix", "root-prefix", "foreign-owner", "prefix-symlink",
  "mutable-config", "mutable-global-config", "unlisted-file", "inventory-escape", "bin-escape", "manager-pin",
  "node-pin", "manager-files", "closure", "sibling-after", "system-pin", "profile-text"] as const)(
  "preserves qualifier refusal for operating scope defect %s", async defect => {
    // Given
    const f = await fixture(), q = structuredClone(f.q), scope = q.confinement, owner = q.installation.owner;
    if (!scope || owner.kind !== "package" || !q.manager.node) throw new TypeError("fixture_scope");
    switch (defect) {
      case "mode-775": chmodSync(f.prefix, 0o775); break;
      case "mode-702": chmodSync(f.prefix, 0o702); break;
      case "mode-750": chmodSync(f.prefix, 0o750); break;
      case "mode-special": chmodSync(f.prefix, 0o1755); break;
      case "prep-755": chmodSync(f.root, 0o755); break;
      case "home-755": chmodSync(f.home, 0o755); break;
      case "prefix-in-prep": Reflect.set(scope, "root", f.base); break;
      case "prep-in-prefix": Reflect.set(owner, "prefix", f.base); break;
      case "prefix-is-prep": Reflect.set(scope, "root", f.prefix); break;
      case "home-sibling": {
        const home = join(f.root, "other-home"); mkdirSync(home, { mode: 0o700 }); Reflect.set(q.env, "HOME", home); break;
      }
      case "home-prefix": Reflect.set(owner, "prefix", homedir()); break;
      case "root-prefix": Reflect.set(owner, "prefix", "/"); break;
      case "foreign-owner": Reflect.set(owner, "prefix", "/usr"); break;
      case "prefix-symlink": {
        const alias = join(f.base, "alias"); symlinkSync(f.prefix, alias); Reflect.set(owner, "prefix", alias); break;
      }
      case "mutable-config": put(join(f.prefix, ".npmrc"), "registry=https://example.invalid\n"); break;
      case "mutable-global-config": put(join(f.prefix, "etc/npmrc"), "prefix=/tmp\n"); break;
      case "unlisted-file": put(join(f.prefix, "unexpected.txt"), "not in before"); break;
      case "inventory-escape": Reflect.set(q.before, "files", [...q.before.files, { path: "../outside", sha256: hash("x"), mode: 0o600 }]); break;
      case "bin-escape": Reflect.set(q.after, "links", [{ path: "bin/codex", target: "../../../outside" }]); break;
      case "manager-pin": Reflect.set(q.manager, "sha256", "0".repeat(64)); break;
      case "node-pin": Reflect.set(q.manager.node, "sha256", "0".repeat(64)); break;
      case "manager-files": Reflect.set(q.manager, "files", []); break;
      case "closure": Reflect.set(q.target, "artifacts", []); break;
      case "sibling-after": Reflect.set(q.after, "files", q.after.files.map(row => row.path.endsWith("keep.txt")
        ? { ...row, sha256: hash("silently modified sibling") } : row)); break;
      case "system-pin": Reflect.set(scope.system, "sha256", "0".repeat(64)); break;
      case "profile-text": Reflect.set(scope, "profile", "(allow default)"); break;
    }
    // When
    const result = await qualifyPackageUpdate(f.authorize(q), f.now);
    // Then
    expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
  });

test.each(["root", "prefix", "socket-mode", "empty-roots", "socket-directory"] as const)(
  "rejects substituted operating coverage %s", async defect => {
    // Given
    const f = await fixture(), coverage = { ...f.p.coverage };
    switch (defect) {
      case "root": coverage.root = f.base; break;
      case "prefix": coverage.prefix = f.root; break;
      case "socket-mode": chmodSync(f.sockets, 0o755); break;
      case "empty-roots": coverage.rootPids = []; break;
      case "socket-directory": coverage.socketDirectory = f.root; break;
    }
    // When
    const result = await f.load({ ...f.input, profiles: [{ ...f.p, coverage }] });
    // Then
    expect(result.kind).toBe("unsupported");
    expect(lstatSync(join(f.directory, "mutations"), { throwIfNoEntry: false })).toBeUndefined();
  });

test("censuses actual operating prefix outside preparation and blocks its live consumer", async () => {
  // Given
  const f = await fixture(), { profile, plan } = configured(await f.load());
  const fd = openSync(f.before.executableRealpath, "r");
  try {
    // When
    const observed = profile.observe(plan);
    // Then
    expect(observed).toMatchObject({ consumers: [expect.objectContaining({ consumerId: expect.stringMatching(new RegExp(`^${process.pid}:`)) })] });
    expect(evaluateResourceGate(plan, observed).ok).toBe(false);
  } finally { closeSync(fd); }
}, 30_000);

test("requires exact current worker socket census for operating profile", async () => {
  // Given
  const f = await fixture(), { profile, plan } = configured(await f.load());
  await socket(join(f.sockets, "unregistered.sock"));
  // When
  const observed = profile.observe(plan);
  // Then
  expect(observed).toMatchObject({ allSocketsKnown: false });
  expect(evaluateResourceGate(plan, observed)).toEqual({ ok: false, error: { code: "unsupported" } });
});

test("rebinds operating coverage to a new owned worker incarnation while fencing the old runtime", async () => {
  // Given: stale preparation names are not authoritative for the new worker.
  const f = await fixture(), oldOwner = f.owner(), first = configured(await f.load());
  const input = { ...f.input, profiles: [{ ...f.p, coverage: { ...f.p.coverage,
    registeredSockets: [oldOwner.socketPath, join(f.directory, `c${oldOwner.incarnation.slice(0, 8)}`)] } }] };
  await f.restart();
  // When
  const second = configured(await f.load(input));
  const observed = second.profile.observe(second.plan);
  // Then
  expect(f.owner().incarnation).not.toBe(oldOwner.incarnation);
  expect(() => first.profile.observe(first.plan)).toThrow();
  expect(observed).toMatchObject({ allSocketsKnown: true, outsideConsumersKnown: true, consumers: [] });
  expect(evaluateResourceGate(second.plan, observed).ok).toBe(true);
  expect(input.profiles[0]?.coverage.rootPids).toEqual([process.pid]);
}, 30_000);

test("binds only the current incarnation control alias canonical socket", async () => {
  // Given: support the exact owner control alias, never arbitrary socket links.
  const f = await fixture(), owner = f.owner(), target = join(f.directory, `c${owner.incarnation.slice(0, 8)}`);
  renameSync(owner.controlPath, target); symlinkSync(target, owner.controlPath);
  // When
  const { profile, plan } = configured(await f.load());
  const observed = profile.observe(plan);
  // Then
  expect(observed).toMatchObject({ allSocketsKnown: true, outsideConsumersKnown: true });
  expect(evaluateResourceGate(plan, observed).ok).toBe(true);
});

test.each(["unknown-socket", "unrelated-alias", "wrong-control-target", "foreign-worker", "owner-mode"] as const)(
  "rejects unowned operating worker coordinates %s at load", async defect => {
    // Given
    const f = await fixture(), owner = f.owner();
    switch (defect) {
      case "unknown-socket": await socket(join(f.directory, "extra.sock")); break;
      case "unrelated-alias": symlinkSync(owner.socketPath, join(f.directory, "alias.sock")); break;
      case "wrong-control-target": {
        const target = join(f.directory, "c00000000");
        renameSync(owner.controlPath, target); symlinkSync(target, owner.controlPath); break;
      }
      case "foreign-worker": put(join(f.directory, "owner.json"), JSON.stringify({ ...owner, pid: process.pid + 1 })); break;
      case "owner-mode": chmodSync(join(f.directory, "owner.json"), 0o644); break;
    }
    // When
    const result = await f.load();
    // Then
    expect(result.kind).toBe("unsupported");
    expect(lstatSync(join(f.directory, "mutations"), { throwIfNoEntry: false })).toBeUndefined();
  });

test("routes explicit operating configuration through plugin loading without native contact", async () => {
  // Given: expiry stops this routing check before any registry request or queue.
  const f = await fixture(), q = { ...f.q, target: { ...f.q.target, checkedAt: 0, expiresAt: 1 } };
  const input = { ...f.input, profiles: [{ ...f.p, update: f.authorize(q) }] }, path = join(f.root, "configured.json");
  // When
  configurePluginRuntime(path, input);
  const result = await loadPluginRuntime(f.context, path);
  // Then
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(input);
  expect(result).toEqual({ kind: "unsupported", reason: "qualification" });
  expect(lstatSync(join(f.directory, "mutations"), { throwIfNoEntry: false })).toBeUndefined();
});

test("does not silently downgrade an operating prefix to the old private confinement", async () => {
  // Given
  const f = await fixture(), q = structuredClone(f.q);
  if (!q.confinement) throw new TypeError("fixture_scope");
  Reflect.deleteProperty(q.confinement, "kind");
  const input = { ...f.input, profile: PACKAGE_RUNTIME_PROFILE, profiles: [{ ...f.p, update: f.authorize(q) }] };
  // When
  const result = await f.load(input);
  // Then
  expect(result).toEqual({ kind: "unsupported", reason: "qualification" });
});

test("keeps worker read-only after persisted operating update authority expires", async () => {
  // Given: exact owned worker coordinates, but no current mutation authority.
  const f = await fixture(), directory = join(f.root, "expired-worker");
  const q = { ...f.q, target: { ...f.q.target, checkedAt: 0, expiresAt: 1 } };
  const input = { ...f.input, ownerDirectory: directory, profiles: [{ ...f.p,
    update: f.authorize(q), coverage: { ...f.p.coverage, socketDirectory: directory } }] };
  const path = join(f.root, "expired-runtime.json");
  configurePluginRuntime(path, input);
  const previous = process.env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"];
  process.env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"] = path;
  try {
    // When: the real domain worker loads the refused configuration.
    const worker = await serveDomainWorker(directory, undefined,
      { home: f.root, path: "", prefixes: [], socket: "" });
    try {
      // Then: readiness and read-only service survive without mutation storage.
      expect(worker.owner.directory).toBe(directory);
      expect(existsSync(`${directory}-mutations`)).toBe(false);
    } finally { await worker.stop(); }
    expect(existsSync(directory)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"];
    else process.env["HERDR_CLI_UPDATER_RUNTIME_CONFIG"] = previous;
  }
});
