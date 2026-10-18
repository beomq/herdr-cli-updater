import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { configurePluginRuntime, loadPluginRuntime, preparePluginRuntime, PLUGIN_RUNTIME_PROFILE, QUALIFIED_PLUGIN_RUNTIME_PROFILE, RUNTIME_SET_PROFILE, PluginRuntimeError } from "../../src/service/plugin-runtime";
import type { PluginRuntimeCandidate, PluginRuntimeInputs } from "../../src/service/plugin-runtime";
import type { RestartBinding, RestartSnapshot } from "../../src/core/client";
import { getOmoUpdateIntent } from "../../src/adapters/update-context";
import type { InstallationIdentity } from "../../src/adapters/types";
import { evaluateResourceGate, parseResourcePlan } from "../../src/install/resources";
import { discoverExecutable } from "../../src/discovery";
import { fixture, hash } from "../fixtures/evidence/task22/update-only-composition-r1/implementation-r1/fixture";

// Real qualifier/adapter/queue, controlled package manager and read-only native
// wire peer. These tests do NOT attest genuine vendor or native ABI4 execution.
async function configuredFixture(beforeVersion = "5.1.9", targetVersion = "5.1.10",
  profile: PluginRuntimeInputs["profile"] = PLUGIN_RUNTIME_PROFILE) {
  const f = await fixture();
  const root = await realpath(await mkdtemp("/tmp/plugin-runtime-"));
  const directory = join(root, "worker"), coreSocket = join(root, "core.sock");
  await mkdir(directory, { mode: 0o700 });
  const operationsPath = join(root, "operations.jsonl");
  await writeFile(operationsPath, "", { mode: 0o600 });
  const node = Bun.which("node");
  if (!node) throw new TypeError("test_node_required");
  const pinned = (path: string) => ({ path, sha256: hash(readFileSync(path)) });
  const files = new Map(f.files);
  const wrapperManifest = join(f.wrapper, "package.json"), discoveryPath = join(f.prefix, "discovery.json");
  const engineManifest = join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json");
  const engineEntry = join(engineManifest, "../dist/cli.js"), engineBody = "export const controlledEngine = true;\n";
  if (beforeVersion !== "5.1.9") {
    await writeFile(wrapperManifest, JSON.stringify({ ...JSON.parse(readFileSync(wrapperManifest, "utf8")), version: beforeVersion }));
    await writeFile(join(f.prefix, "install/global/package.json"), JSON.stringify({ dependencies: { "omo-ai": beforeVersion } }));
    await mkdir(join(engineEntry, ".."), { recursive: true });
    await writeFile(engineEntry, engineBody);
    await writeFile(engineManifest, JSON.stringify({ ...JSON.parse(readFileSync(engineManifest, "utf8")),
      bin: { pi: "dist/cli.js", senpi: "dist/cli.js" } }));
    const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
    await writeFile(discoveryPath, JSON.stringify({ ...discovery, resources: [...discovery.resources, { path: engineEntry }].map((row: { readonly path: string }) =>
      ({ path: row.path, sha256: pinned(row.path).sha256 })) }));
  }
  const beforeResources = [...f.installation.resources, ...(beforeVersion !== "5.1.9"
    ? [{ resourceId: `resource:${hash(engineEntry)}`, realpath: engineEntry, fingerprint: `sha256:${hash(engineBody)}` }] : [])]
    .map(row => ({ ...row, fingerprint: `sha256:${pinned(row.realpath).sha256}` }))
    .sort((a, b) => a.realpath.localeCompare(b.realpath));
  const before: InstallationIdentity = { ...f.installation, installedVersion: { kind: "known", version: beforeVersion },
    resources: beforeResources, resourcesFingerprint: `sha256:${hash(JSON.stringify(beforeResources))}` };
  const artifacts = [];
  for (const artifact of f.input.qualification.target.artifacts) {
    const generalEngine = artifact.name === "@code-yeongyu/senpi" && beforeVersion !== "5.1.9";
    if (!generalEngine && (artifact.name !== "omo-ai" || targetVersion === artifact.version)) { artifacts.push(artifact); continue; }
    const entries = Object.fromEntries(await new Bun.Archive(readFileSync(artifact.archive.path)).files());
    const manifest = entries["package/package.json"];
    if (!manifest) throw new TypeError("test_wrapper_archive");
    const version = generalEngine ? artifact.version : targetVersion;
    const body = JSON.stringify({ ...JSON.parse(await manifest.text()), version,
      ...(generalEngine ? { bin: { pi: "dist/cli.js", senpi: "dist/cli.js" } } : {}) });
    const archive = await new Bun.Archive({ ...entries, "package/package.json": body,
      ...(generalEngine ? { "package/dist/cli.js": engineBody } : {}) }, { compress: "gzip" }).bytes();
    await writeFile(artifact.archive.path, archive);
    const metadata = JSON.parse(readFileSync(artifact.metadata.path, "utf8"));
    await writeFile(artifact.metadata.path, JSON.stringify({ ...metadata, version, dist: {
      ...metadata.dist, tarball: `https://registry.npmjs.org/${artifact.name}/-/fixture-${version}.tgz`,
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    } }));
    artifacts.push({ ...artifact, version, archive: pinned(artifact.archive.path), metadata: pinned(artifact.metadata.path) });
    files.set(generalEngine ? engineManifest : wrapperManifest, body);
    if (generalEngine) files.set(engineEntry, engineBody);
  }
  const resources = before.resources.map(row => ({
    ...row, fingerprint: files.has(row.realpath) ? `sha256:${hash(files.get(row.realpath) ?? "")}` : row.fingerprint,
  }));
  const after: InstallationIdentity = { ...before, installedVersion: { kind: "known", version: targetVersion },
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  const afterPath = join(root, "after.json");
  await writeFile(afterPath, JSON.stringify(after), { mode: 0o600 });
  const now = Date.now();
  const qualification = { ...f.input.qualification, installation: before,
    target: { ...f.input.qualification.target, version: targetVersion, artifacts, checkedAt: now, expiresAt: now + 300_000 } };
  const receiptPath = join(root, "qualification.json");
  await writeFile(receiptPath, JSON.stringify(qualification), { mode: 0o600 });
  const tagsPath = join(root, "tags.json");
  await writeFile(tagsPath, JSON.stringify({ latest: targetVersion }), { mode: 0o600 });
  const sessionPath = join(root, "saved-session");
  await writeFile(sessionPath, "saved conversation", { mode: 0o600 });
  const metadata = qualification.target.artifacts.find(row => row.name === "omo-ai")?.metadata;
  if (!metadata) throw new TypeError("test_wrapper_metadata");
  const identity = { version: "controlled-native", protocol: 1, schemaSha256: "a".repeat(64) };
  const supervisor = { pid: process.ppid, parent_pid: 1, uid: process.getuid?.() ?? 0,
    pgid: process.ppid, tty: 17, start_seconds: 10, start_microseconds: 0, executable: realpathSync(process.execPath) };
  const expectedBinding: RestartBinding = { socket_epoch: "test-core", pane_id: "pane", terminal_id: "terminal",
    slot: "b".repeat(64), generation: 1, work_generation: 0, input_sequence: 0, supervisor,
    root: { ...supervisor, pid: process.pid, parent_pid: supervisor.pid, pgid: process.pid, start_seconds: 20 },
    launch_ref: "c".repeat(64), session: { full_id: "controlled-session", storage_identity: hash(sessionPath),
      cwd: root, options_sha256: "e".repeat(64), environment_sha256: "f".repeat(64) } };
  let binding = expectedBinding;
  let nativeQualified = true, recoveryRequired = false;
  const calls: string[] = [], sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let data = "";
    socket.on("data", bytes => {
      data += bytes.toString();
      if (!data.includes("\n")) return;
      const request: unknown = JSON.parse(data.slice(0, data.indexOf("\n")));
      if (typeof request !== "object" || request === null || !("id" in request)
        || !("method" in request) || typeof request.method !== "string" || !("params" in request))
        throw new TypeError("test_wire_request");
      const params = request.params;
      calls.push(request.method === "ping" ? "ping"
        : typeof params === "object" && params !== null && "action" in params && typeof params.action === "string" ? params.action : "invalid");
      const snapshot: RestartSnapshot = { binding, receipt: null, owner_token: null,
        native_qualified: nativeQualified, recovery_required: recoveryRequired, replay_ready: false };
      socket.end(JSON.stringify({ id: request.id, result: request.method === "ping"
        ? { type: "pong", ...identity, capabilities: { updater_restart_v1: true, updater_restart_schema_sha256: identity.schemaSha256 } }
        : { type: "updater_restart", snapshot } }) + "\n");
    });
  });
  const listening = once(server, "listening");
  server.listen(coreSocket);
  await listening;
  await chmod(coreSocket, 0o600);
  const input: PluginRuntimeInputs = { schemaVersion: 1, profile, ownerDirectory: directory,
    update: { qualification, receipt: pinned(receiptPath) }, overlays: [],
    provenance: [pinned(join(f.prefix, "discovery.json"))], expectedAfterPin: pinned(afterPath),
    independentTargetPins: [...resources.map(r => ({ path: r.realpath, sha256: r.fingerprint.slice(7) })), ...qualification.target.postinstall],
    sourcePins: [], acquiredReplies: [
      { url: `https://registry.npmjs.org/omo-ai/${targetVersion}`, status: 200, body: metadata },
      { url: "https://registry.npmjs.org/-/package/omo-ai/dist-tags", status: 200, body: pinned(tagsPath) },
    ],
    native: { coreSocket, coreIdentity: identity, operationsPath, runtimeId: "owned-omo", profile: "owned-updated-pair",
      sessionPath, sourceBinding: pinned(tagsPath), node: pinned(realpathSync(node)), expectedBinding },
    coverage: { root: f.root, prefix: f.prefix, socketDirectory: root, registeredSockets: [coreSocket], rootPids: [process.pid] } };
  return { f, root, input, updatedFiles: files, context: { directory, coreSocket }, configPath: join(root, "runtime.json"), calls,
    driftSession() { binding = { ...binding, session: { ...binding.session, full_id: "another-conversation" } }; },
    unqualifyNative() { nativeQualified = false; },
    requireRecovery() { recoveryRequired = true; },
    async close() {
      for (const socket of sockets) socket.destroy();
      const closed = once(server, "close");
      server.close(); await closed;
      await rm(root, { recursive: true });
      await f.cleanup();
  } };
}

function runtimeCandidate(input: PluginRuntimeInputs): PluginRuntimeCandidate {
  const { receipt: _receipt, ...update } = input.update;
  const { expectedBinding, ...native } = input.native;
  return { ...input, update, native: { ...native, paneId: expectedBinding.pane_id } };
}

test("runtime set preserves its native profile lifecycle and all configuration pins", async () => {
  // Given a qualified controlled native child wrapped by the production runtime set.
  const t = await configuredFixture();
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    configurePluginRuntime(t.configPath, t.input);
    const setPath = join(t.root, "runtime-set.json");
    const childPin = { path: t.configPath, sha256: hash(readFileSync(t.configPath)) };
    configurePluginRuntime(setPath, { schemaVersion: 1, profile: RUNTIME_SET_PROFILE, configurations: [childPin] });
    loaded = await loadPluginRuntime(t.context, setPath);
    if (loaded.kind !== "configured") throw new TypeError("test_runtime_set_not_configured");
    const profile = loaded.runner.profiles?.[0];
    if (!profile?.lifecycle || !profile.contract.runtime) throw new TypeError("test_native_lifecycle_missing");
    const runtime = profile.contract.runtime;
    const target = { targetId: `target:${hash(JSON.stringify([runtime.binding.socketId, runtime.runtimeId]))}`,
      runtimeId: runtime.runtimeId, installationId: runtime.installationId, expectedBinding: runtime.binding };
    // When inspected through the composed profile, the original wire identity survives.
    expect(await profile.lifecycle.inspect(target, new AbortController().signal))
      .toMatchObject({ ok: true, value: { binding: target.expectedBinding } });
    expect(loaded.runner.lifecycle).toBeUndefined();
    expect(loaded.runner.profiles).toHaveLength(1);
    expect(profile.sourcePins).toContainEqual(childPin);
    expect(profile.sourcePins).toContainEqual({ path: setPath, sha256: hash(readFileSync(setPath)) });
  } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
});

test("preserves the original manager node pin in private runtime configuration", async () => {
  const t = await configuredFixture();
  try {
    const manager = t.input.update.qualification.manager;
    const node = t.input.native.node;
    const qualification = { ...t.input.update.qualification, manager: { ...manager, node },
      env: { ...t.input.update.qualification.env, PATH: [join(manager.path, ".."), join(node.path, "..")].join(":") } };
    const receiptPath = join(t.root, "node-qualification.json");
    const receiptBody = JSON.stringify(qualification);
    await writeFile(receiptPath, receiptBody, { mode: 0o600 });
    const input = { ...t.input, update: { qualification, receipt: { path: receiptPath, sha256: hash(receiptBody) } } };
    configurePluginRuntime(t.configPath, input);
    const configured = JSON.parse(await readFile(t.configPath, "utf8"));
    expect(configured.update.qualification.manager.node).toEqual(node);
    expect(() => configurePluginRuntime(join(t.root, "invalid-node.json"), {
      ...input, update: { ...input.update, qualification: { ...qualification, manager: { ...qualification.manager,
        node: { ...node, extra: true } } } },
    })).toThrow(PluginRuntimeError);
  } finally { await t.close(); }
});

test("controlled candidate prepare leaves worker creation to startup and captures exact qualification and fresh binding", async () => {
  // Given: an owned private candidate and absent worker path, not actual native proof.
  const t = await configuredFixture("5.2.0", "5.2.1", QUALIFIED_PLUGIN_RUNTIME_PROFILE);
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    await rmdir(t.context.directory);
    const candidate = runtimeCandidate(t.input), inputPath = join(t.root, "candidate.json");
    await writeFile(inputPath, JSON.stringify(candidate), { mode: 0o600 });
    t.driftSession();
    // When: the production producer reads the live wire peer and runs the real qualifier.
    await preparePluginRuntime(inputPath, t.configPath, t.context);
    const stored: PluginRuntimeInputs = JSON.parse(readFileSync(t.configPath, "utf8"));
    // Then: exact input times survive, and authority is captured rather than accepted from candidate JSON.
    expect(stored.update.qualification).toEqual(candidate.update.qualification);
    expect(stored.update.receipt.path).toBe(`${t.configPath}.qualification.json`);
    expect(JSON.parse(readFileSync(stored.update.receipt.path, "utf8"))).toEqual(candidate.update.qualification);
    expect(stored.update.receipt.sha256).toBe(hash(readFileSync(stored.update.receipt.path)));
    expect(lstatSync(stored.update.receipt.path).mode & 0o777).toBe(0o600);
    expect(stored.native.expectedBinding.session.full_id).toBe("another-conversation");
    expect(stored.sourcePins).toContainEqual({ path: inputPath, sha256: hash(readFileSync(inputPath)) });
    expect(t.calls).toEqual(["ping", "inspect"]);
    expect(lstatSync(t.context.directory, { throwIfNoEntry: false })).toBeUndefined();
    // Worker startup, not prepare, owns creating its private storage.
    await mkdir(t.context.directory, { mode: 0o700 });
    loaded = await loadPluginRuntime(t.context, t.configPath);
    if (loaded.kind !== "configured" || !loaded.runner.profile) throw new TypeError("test_prepared_configuration_failed");
    const runtime = loaded.runner.profile;
    const parsed = parseResourcePlan({ contract: runtime.contract, mode: "update-only", selectedTargets: [],
      mutationResources: runtime.contract.installation.resources, installerDigest: hash("prepared-plan") });
    if (!parsed.ok) throw new TypeError(parsed.error.code);
    expect(evaluateResourceGate(parsed.value, runtime.observe(parsed.value))).toEqual({ ok: false, error: { code: "resources_busy" } });
    expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
    // Persisted candidate bytes remain fenced after prepare.
    await writeFile(inputPath, JSON.stringify(candidate) + "\n");
    expect(await loaded.readers.candidates[0]?.read()).toEqual({ ok: false, error: { code: "stale_selection" } });
  } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
});

test.each(["expired", "artifact-metadata", "after-version", "independent-pins", "source-drift",
  "native-unqualified", "native-recovery", "extra-receipt", "extra-binding", "public-candidate", "existing-worker"] as const)(
  "controlled candidate prepare rejects %s without publishing configuration or a receipt", async defect => {
    // Given: one private general candidate with a specific qualification or boundary defect.
    const t = await configuredFixture("5.2.0", "5.2.1", QUALIFIED_PLUGIN_RUNTIME_PROFILE);
    try {
      if (defect !== "existing-worker") await rmdir(t.context.directory);
      let candidate = runtimeCandidate(t.input);
      const inputPath = join(t.root, "candidate.json");
      switch (defect) {
        case "expired": candidate = { ...candidate, update: { qualification: { ...candidate.update.qualification,
          target: { ...candidate.update.qualification.target, checkedAt: 1, expiresAt: 2 } } } }; break;
        case "artifact-metadata": {
          const q = candidate.update.qualification, wrapper = q.target.artifacts.find(row => row.name === "omo-ai");
          if (!wrapper) throw new TypeError("test_wrapper_metadata");
          const body = JSON.stringify({ ...JSON.parse(readFileSync(wrapper.metadata.path, "utf8")), version: "5.2.2" });
          await writeFile(wrapper.metadata.path, body);
          const pin = { ...wrapper.metadata, sha256: hash(body) };
          candidate = { ...candidate, update: { qualification: { ...q, target: { ...q.target,
            artifacts: q.target.artifacts.map(row => row === wrapper ? { ...row, metadata: pin } : row) } } },
          acquiredReplies: candidate.acquiredReplies.map(row => row.body.path === pin.path ? { ...row, body: pin } : row) };
          break;
        }
        case "after-version": {
          const after: InstallationIdentity = JSON.parse(readFileSync(candidate.expectedAfterPin.path, "utf8"));
          const body = JSON.stringify({ ...after, installedVersion: { kind: "known", version: "5.2.2" } });
          await writeFile(candidate.expectedAfterPin.path, body);
          candidate = { ...candidate, expectedAfterPin: { ...candidate.expectedAfterPin, sha256: hash(body) } };
          break;
        }
        case "independent-pins": candidate = { ...candidate, independentTargetPins: [] }; break;
        case "source-drift": await writeFile(candidate.native.sourceBinding.path, '{"latest":"changed"}'); break;
        case "native-unqualified": t.unqualifyNative(); break;
        case "native-recovery": t.requireRecovery(); break;
        case "extra-receipt": case "extra-binding": case "public-candidate": case "existing-worker": break;
      }
      const value = defect === "extra-receipt" ? { ...candidate, update: { ...candidate.update, receipt: t.input.update.receipt } }
        : defect === "extra-binding" ? { ...candidate, native: { ...candidate.native, expectedBinding: t.input.native.expectedBinding } } : candidate;
      await writeFile(inputPath, JSON.stringify(value), { mode: defect === "public-candidate" ? 0o644 : 0o600 });
      // When / Then: bad data never becomes newly approved authority.
      await expect(preparePluginRuntime(inputPath, t.configPath, t.context)).rejects.toBeInstanceOf(PluginRuntimeError);
      expect(lstatSync(t.configPath, { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(`${t.configPath}.qualification.json`, { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(join(t.context.directory, "mutations"), { throwIfNoEntry: false })).toBeUndefined();
      if (defect === "existing-worker") {
        expect(lstatSync(t.context.directory).isDirectory()).toBe(true);
        expect(t.calls).toEqual([]);
      } else expect(lstatSync(t.context.directory, { throwIfNoEntry: false })).toBeUndefined();
    } finally { await t.close(); }
  },
);

test("configuration profile routing rejects proxies and getters without calling them", async () => {
  const root = await realpath(await mkdtemp("/tmp/profile-routing-"));
  await chmod(root, 0o700);
  let calls = 0;
  const input = Object.defineProperty({}, "profile", { enumerable: true, get() { calls++; return "qualified-package-update-only-v1"; } });
  const path = join(root, "runtime.json");
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { calls++; throw new TypeError("must_not_execute"); } });
  try {
    expect(() => configurePluginRuntime(path, input)).toThrow(PluginRuntimeError);
    expect(() => configurePluginRuntime(path, proxy)).toThrow(PluginRuntimeError);
    expect(calls).toBe(0);
  } finally { await rm(root, { recursive: true }); }
});

test("returns unconfigured without creating storage when no owned configuration exists", async () => {
  // Given: no registered private configuration.
  const context = { directory: "/missing-worker", coreSocket: "/missing-core.sock" };
  // When: the normal worker loads its optional product configuration.
  const result = await loadPluginRuntime(context, "/missing-plugin-config/runtime.json");
  // Then: neither automatic mutation authority nor queue storage is invented.
  expect(result).toEqual({ kind: "unconfigured" });
  expect(lstatSync(context.directory, { throwIfNoEntry: false })).toBeUndefined();
});

test.each([PLUGIN_RUNTIME_PROFILE, QUALIFIED_PLUGIN_RUNTIME_PROFILE])(
  "controlled fixture qualifies 5.2.0 to 5.2.1 with profile %s, not actual native execution", async profile => {
    // Given: independently pinned controlled packages and a read-only wire peer.
    const t = await configuredFixture("5.2.0", "5.2.1", profile);
    let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
    try {
      configurePluginRuntime(t.configPath, t.input);
      // When: the worker reconstructs authority through the real qualifier.
      loaded = await loadPluginRuntime(t.context, t.configPath);
      if (loaded.kind !== "configured" || !loaded.runner.profile) throw new TypeError("test_configuration_failed");
      const runtime = loaded.runner.profile;
      const spec = runtime.adapter.updateSpec(runtime.contract.installation, "update-and-restart");
      // Then: issuance and the catalog check use the qualified target, not a fixed release.
      expect(spec).toMatchObject({ ok: true, value: { command: { args: ["add", "-g", "omo-ai@5.2.1"] } } });
      expect(runtime.contract.installation.installedVersion).toEqual({ kind: "known", version: "5.2.0" });
      expect(runtime.expectedAfter.installedVersion).toEqual({ kind: "known", version: "5.2.1" });
      expect(await loaded.readers.check?.(runtime.contract.installation, AbortSignal.timeout(5000)))
        .toMatchObject({ ok: true, value: { kind: "update-available", installedVersion: "5.2.0", availableVersion: "5.2.1" } });
      expect(t.calls).toEqual(["ping", "inspect", "ping", "inspect"]);
      expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
    } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
  },
);

test("verified updated installation stays readable across worker reload without new mutation authority", async () => {
  const t = await configuredFixture("5.2.0", "5.2.1", QUALIFIED_PLUGIN_RUNTIME_PROFILE);
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  let reloaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    configurePluginRuntime(t.configPath, t.input);
    loaded = await loadPluginRuntime(t.context, t.configPath);
    if (loaded.kind !== "configured" || !loaded.runner.profile) throw new TypeError("test_configuration_failed");
    const after = loaded.runner.profile.expectedAfter;
    for (const [path, body] of t.updatedFiles) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, body);
    }
    const wrapper = join(t.f.wrapper, "package.json");
    expect(await loaded.readers.candidates[0]?.read()).toMatchObject({ ok: true, value: {
      contract: { installation: after, runtime: null, capabilities: { update: { kind: "unknown" } } }, lastCheck: null,
    } });
    loaded.runner.queue.close();
    loaded = undefined;
    const calls = t.calls.length;
    reloaded = await loadPluginRuntime(t.context, t.configPath);
    if (reloaded.kind !== "configured") throw new TypeError("test_reload_failed");
    expect(reloaded.runner.profile).toBeUndefined();
    expect(await reloaded.readers.candidates[0]?.read()).toMatchObject({ ok: true, value: { contract: { installation: after } } });
    expect(t.calls.length).toBe(calls);
    await writeFile(wrapper, "{}");
    expect(await reloaded.readers.candidates[0]?.read()).toEqual({ ok: false, error: { code: "stale_selection" } });
  } finally {
    if (loaded?.kind === "configured") loaded.runner.queue.close();
    if (reloaded?.kind === "configured") reloaded.runner.queue.close();
    await t.close();
  }
});

test("current qualified native installation loads without issuing an unnecessary update", async () => {
  const t = await configuredFixture("5.2.1", "5.2.1", QUALIFIED_PLUGIN_RUNTIME_PROFILE);
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    configurePluginRuntime(t.configPath, t.input);
    loaded = await loadPluginRuntime(t.context, t.configPath);
    if (loaded.kind !== "configured" || !loaded.runner.profile) throw new TypeError("test_current_configuration_failed");
    const runtime = loaded.runner.profile;
    expect(await loaded.readers.check?.(runtime.contract.installation, AbortSignal.timeout(5000)))
      .toMatchObject({ ok: true, value: { kind: "up-to-date", installedVersion: "5.2.1" } });
    expect(runtime.adapter.updateSpec(runtime.contract.installation, "update-and-restart"))
      .toEqual({ ok: false, error: { code: "unsupported" } });
    expect(t.calls).toEqual(["ping", "inspect", "ping", "inspect"]);
    expect(loaded.readers.sockets).toEqual([]);
    expect(await loaded.readers.runtimeSources?.[0]?.read())
      .toMatchObject({ ok: true, value: { kind: "observed", observations: [{ contract: { runtime: runtime.contract.runtime } }] } });
    expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
  } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
});

test.each(["target-version", "after-version", "after-resource-pin", "artifact-metadata", "acquired-metadata"] as const)(
  "controlled general pair rejects mismatched %s before native inspection", async defect => {
    // Given: a general version pair with one repinned but contradictory evidence item.
    const t = await configuredFixture("5.2.0", "5.2.1", QUALIFIED_PLUGIN_RUNTIME_PROFILE);
    try {
      let input = t.input;
      if (defect === "target-version" || defect === "artifact-metadata") {
        let qualification = input.update.qualification;
        if (defect === "target-version") qualification = { ...qualification, target: { ...qualification.target, version: "5.2.2" } };
        else {
          const wrapper = qualification.target.artifacts.find(row => row.name === "omo-ai");
          if (!wrapper) throw new TypeError("test_wrapper_metadata");
          const body = JSON.stringify({ ...JSON.parse(readFileSync(wrapper.metadata.path, "utf8")), version: "5.2.2" });
          await writeFile(wrapper.metadata.path, body);
          qualification = { ...qualification, target: { ...qualification.target, artifacts: qualification.target.artifacts.map(row =>
            row === wrapper ? { ...row, metadata: { ...row.metadata, sha256: hash(body) } } : row) } };
          input = { ...input, acquiredReplies: input.acquiredReplies.map(row => row.body.path === wrapper.metadata.path
            ? { ...row, body: { ...row.body, sha256: hash(body) } } : row) };
        }
        const body = JSON.stringify(qualification);
        await writeFile(input.update.receipt.path, body);
        input = { ...input, update: { qualification, receipt: { ...input.update.receipt, sha256: hash(body) } } };
      } else if (defect === "after-version" || defect === "after-resource-pin") {
        const after: InstallationIdentity = JSON.parse(readFileSync(input.expectedAfterPin.path, "utf8"));
        const resources = after.resources.map((row, index) => index === 0 && defect === "after-resource-pin"
          ? { ...row, fingerprint: `sha256:${"0".repeat(64)}` } : row);
        const body = JSON.stringify({ ...after,
          installedVersion: { kind: "known", version: defect === "after-version" ? "5.2.2" : "5.2.1" },
          resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` });
        await writeFile(input.expectedAfterPin.path, body);
        input = { ...input, expectedAfterPin: { ...input.expectedAfterPin, sha256: hash(body) } };
      } else {
        const body = JSON.stringify({ name: "omo-ai", version: "5.2.2" }), path = join(t.root, "wrong-release.json");
        await writeFile(path, body, { mode: 0o600 });
        input = { ...input, acquiredReplies: input.acquiredReplies.map(row => row.url.endsWith("/omo-ai/5.2.1")
          ? { ...row, body: { path, sha256: hash(body) } } : row) };
      }
      // When / Then: matching hashes alone never authorize a contradictory target.
      if (defect === "artifact-metadata" || defect === "acquired-metadata") {
        configurePluginRuntime(t.configPath, input);
        expect(await loadPluginRuntime(t.context, t.configPath)).toEqual({
          kind: "unsupported", reason: defect === "artifact-metadata" ? "qualification" : "inputs",
        });
      } else {
        expect(() => configurePluginRuntime(t.configPath, input)).toThrow(PluginRuntimeError);
        expect(lstatSync(t.configPath, { throwIfNoEntry: false })).toBeUndefined();
      }
      expect(t.calls).toEqual([]);
      expect(lstatSync(join(t.context.directory, "mutations"), { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
    } finally { await t.close(); }
  },
);

test("persists a genuine package-sized independent target pin list", async () => {
  const t = await configuredFixture();
  try {
    const source = t.input, config = t.configPath;
    const independentTargetPins = [...source.independentTargetPins,
      ...Array.from({ length: 4097 }, () => source.independentTargetPins[0])];
    configurePluginRuntime(config, { ...source, independentTargetPins });
    const stored = JSON.parse(readFileSync(config, "utf8"));
    expect(stored.independentTargetPins).toHaveLength(independentTargetPins.length);
    expect(stored.independentTargetPins.at(-1)).toEqual(source.independentTargetPins[0]);
    expect(lstatSync(config).mode & 0o777).toBe(0o600);
  } finally { await t.close(); }
});

test("loads a package configuration larger than eight megabytes", async () => {
  const t = await configuredFixture();
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    const independentTargetPins = [...t.input.independentTargetPins,
      ...Array.from({ length: 28_000 }, (_, index) => ({
        path: join(t.root, `${index}-${"p".repeat(260)}`), sha256: "0".repeat(64),
      }))];
    configurePluginRuntime(t.configPath, { ...t.input, independentTargetPins });
    expect(lstatSync(t.configPath).size).toBeGreaterThan(8 * 1024 * 1024);
    loaded = await loadPluginRuntime(t.context, t.configPath);
    expect(loaded.kind).toBe("configured");
    expect(t.calls).toEqual(["ping", "inspect", "ping", "inspect"]);
    expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
  } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
});

test("reconstructs genuine local authority from private JSON without executing updates or native mutations", async () => {
  // Given: controlled pinned packages and the real qualifier/native client.
  const t = await configuredFixture();
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    configurePluginRuntime(t.configPath, t.input);
    // When: a normal worker loads the persisted product configuration.
    loaded = await loadPluginRuntime(t.context, t.configPath);
    expect(loaded.kind).toBe("configured");
    if (loaded.kind !== "configured" || !loaded.runner.profile) throw new TypeError("test_configuration_failed");
    const profile = loaded.runner.profile;
    const spec = profile.adapter.updateSpec(profile.contract.installation, "update-and-restart");
    if (!spec.ok) throw new TypeError(spec.error.code);
    // Then: the issuer recognizes process-local authority, without any dispatch.
    expect(getOmoUpdateIntent(spec.value)).toMatchObject({ ok: true, value: { mode: "update-and-restart" } });
    expect(getOmoUpdateIntent(structuredClone(spec.value))).toMatchObject({ ok: false });
    expect(profile.contract.runtime?.binding.session).toMatchObject({ fullId: "controlled-session" });
    expect(t.calls).toEqual(["ping", "inspect", "ping", "inspect"]);
    expect(lstatSync(t.configPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
  } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
});

test("catalog reads avoid target payloads while mutation still rejects changed payload bytes", async () => {
  const t = await configuredFixture("5.2.0", "5.2.1", QUALIFIED_PLUGIN_RUNTIME_PROFILE);
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    configurePluginRuntime(t.configPath, t.input);
    loaded = await loadPluginRuntime(t.context, t.configPath);
    if (loaded.kind !== "configured" || !loaded.runner.profile) throw new TypeError("test_configuration_failed");
    const artifact = t.input.update.qualification.target.artifacts[0];
    if (!artifact) throw new TypeError("test_artifact_missing");
    expect(await discoverExecutable({ family: "omo", executable: t.input.update.qualification.installation.executableRealpath,
      provenance: t.input.provenance })).toMatchObject({ ok: true,
        value: { installation: t.input.update.qualification.installation } });
    expect(await loaded.readers.candidates[0]?.read()).toMatchObject({ ok: true });
    await writeFile(artifact.archive.path, "changed target payload after qualification");
    const observed = await loaded.readers.candidates[0]?.read();
    expect(observed).toMatchObject({ ok: true });
    const profile = loaded.runner.profile;
    const plan = parseResourcePlan({ contract: profile.contract, mode: "update-only", selectedTargets: [],
      mutationResources: profile.contract.installation.resources, installerDigest: hash("payload-plan") });
    if (!plan.ok) throw new TypeError(plan.error.code);
    expect(() => profile.observe(plan.value)).toThrow();
    expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
  } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
});

test("refuses changed captured conversation before exposing a runnable profile", async () => {
  // Given: configuration captured for one exact native conversation.
  const t = await configuredFixture();
  try {
    configurePluginRuntime(t.configPath, t.input);
    t.driftSession();
    // When: the live core reports another session for the same pane.
    const loaded = await loadPluginRuntime(t.context, t.configPath);
    // Then: native drift does not become a newly selected target.
    expect(loaded).toEqual({ kind: "unsupported", reason: "native" });
    expect(t.calls).toEqual(["ping", "inspect"]);
    expect(lstatSync(join(t.context.directory, "mutations"), { throwIfNoEntry: false })).toBeUndefined();
  } finally { await t.close(); }
});

test("preserves expired qualification instead of minting a fresh approval at worker startup", async () => {
  // Given: a correctly pinned but expired original qualification.
  const t = await configuredFixture();
  try {
    const qualification = { ...t.input.update.qualification,
      target: { ...t.input.update.qualification.target, checkedAt: 1, expiresAt: 2 } };
    const body = JSON.stringify(qualification);
    await writeFile(t.input.update.receipt.path, body, { mode: 0o600 });
    configurePluginRuntime(t.configPath, { ...t.input, update: {
      qualification, receipt: { path: t.input.update.receipt.path, sha256: hash(body) },
    } });
    // When: the worker invokes the real qualifier.
    const loaded = await loadPluginRuntime(t.context, t.configPath);
    // Then: no new timestamp, queue or native inspection bypasses it.
    expect(loaded).toEqual({ kind: "unsupported", reason: "qualification" });
    expect(t.calls).toEqual([]);
  } finally { await t.close(); }
});

test.each(["extra-port", "mode", "link", "source-drift"] as const)("refuses %s at the owned configuration boundary", async defect => {
  // Given: one valid configuration with one specific trust-boundary defect.
  const t = await configuredFixture();
  try {
    configurePluginRuntime(t.configPath, t.input);
    switch (defect) {
      case "extra-port": await writeFile(t.configPath, JSON.stringify({ ...t.input, lifecycle: { module: "/arbitrary.ts" } })); break;
      case "mode": await chmod(t.configPath, 0o644); break;
      case "link": {
        const alias = join(t.root, "alias.json");
        await symlink(t.configPath, alias);
        // When / Then: alias identity cannot select the same approval.
        expect(await loadPluginRuntime(t.context, alias)).toEqual({ kind: "unsupported", reason: "configuration" });
        return;
      }
      case "source-drift": await writeFile(t.input.native.sourceBinding.path, '{"latest":"changed"}'); break;
    }
    // When: the product loader encounters unapproved fields/bytes/permissions.
    const loaded = await loadPluginRuntime(t.context, t.configPath);
    // Then: no executable JSON field, stale pin or public file is accepted.
    expect(loaded).toEqual({ kind: "unsupported", reason: defect === "source-drift" ? "inputs" : "configuration" });
    expect(t.calls).toEqual([]);
  } finally { await t.close(); }
});

test("requires independent after-image pins before persisting configuration", async () => {
  // Given: a claimed target missing independently acquired output pins.
  const t = await configuredFixture();
  try {
    // When: the owner attempts to configure that incomplete target.
    expect(() => configurePluginRuntime(t.configPath, { ...t.input, independentTargetPins: [] })).toThrow(PluginRuntimeError);
    // Then: no persisted approval or native effect exists.
    expect(lstatSync(t.configPath, { throwIfNoEntry: false })).toBeUndefined();
    expect(t.calls).toEqual([]);
  } finally { await t.close(); }
});

test.each(["plain", "file-and-socket-alias", "directory-alias"] as const)("uses real %s census and keeps a live selected process blocked", async mode => {
  // Given: real OS/socket census, with this live test process as the controlled target.
  const t = await configuredFixture();
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    if (mode === "file-and-socket-alias") {
      await symlink(t.input.native.sessionPath, join(t.root, "session-alias"));
      await symlink(t.input.native.coreSocket, join(t.root, "socket-alias"));
    } else if (mode === "directory-alias") {
      await symlink(t.input.coverage.root, join(t.root, "directory-alias"));
    }
    configurePluginRuntime(t.configPath, t.input);
    loaded = await loadPluginRuntime(t.context, t.configPath);
    if (loaded.kind !== "configured" || !loaded.runner.profile) throw new TypeError("test_configuration_failed");
    const profile = loaded.runner.profile, runtime = profile.contract.runtime;
    if (!runtime) throw new TypeError("test_runtime_missing");
    const parsed = parseResourcePlan({ contract: profile.contract, mode: "update-only", selectedTargets: [],
      mutationResources: profile.contract.installation.resources, installerDigest: hash("test-plan") });
    if (!parsed.ok) throw new TypeError(parsed.error.code);
    // When: the genuine gate evaluates the product's live resource observation.
    if (mode === "directory-alias") {
      expect(() => profile.observe(parsed.value)).toThrow();
      return;
    }
    const gate = evaluateResourceGate(parsed.value, profile.observe(parsed.value));
    // Then: configuration/catalog support cannot stand in for process exit.
    expect(gate).toEqual({ ok: false, error: { code: "resources_busy" } });
  } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
});

test("fences callback use after the persisted owned configuration changes", async () => {
  // Given: genuine issued authority and immutable source pins including config.
  const t = await configuredFixture();
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    configurePluginRuntime(t.configPath, t.input);
    loaded = await loadPluginRuntime(t.context, t.configPath);
    if (loaded.kind !== "configured" || !loaded.runner.profile) throw new TypeError("test_configuration_failed");
    const body = await readFile(t.configPath, "utf8");
    await writeFile(t.configPath, body + "\n");
    // When: a previously returned catalog reader is used after config drift.
    const observed = await loaded.readers.candidates[0]?.read();
    // Then: stale callbacks do not continue advertising supported installation.
    expect(observed).toEqual({ ok: false, error: { code: "stale_selection" } });
  } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
});

test("inspects an existing conversation outside the installation root using its exact storage identity", async () => {
  const t = await configuredFixture();
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    expect(t.input.native.sessionPath.startsWith(`${t.input.coverage.root}/`)).toBe(false);
    configurePluginRuntime(t.configPath, t.input);
    loaded = await loadPluginRuntime(t.context, t.configPath);
    if (loaded.kind !== "configured" || !loaded.runner.profile?.contract.runtime || !loaded.runner.lifecycle)
      throw new TypeError("test_configuration_failed");
    const runtime = loaded.runner.profile.contract.runtime;
    const target = { targetId: `target:${hash(JSON.stringify([runtime.binding.socketId, runtime.runtimeId]))}`, runtimeId: runtime.runtimeId,
      installationId: runtime.installationId, expectedBinding: runtime.binding };
    expect(hash(t.input.native.sessionPath)).toBe(runtime.binding.session.kind === "conversation"
      ? runtime.binding.session.storagePathHash : "");
    expect(realpathSync(t.input.native.sessionPath)).toBe(t.input.native.sessionPath);
    expect(lstatSync(t.input.native.sessionPath).mode & 0o022).toBe(0);
    expect(await loaded.runner.lifecycle.inspect(target, AbortSignal.timeout(5000)))
      .toMatchObject({ ok: true, value: { binding: runtime.binding } });
    const wrong = join(t.root, "another-session");
    await writeFile(wrong, "another conversation", { mode: 0o600 });
    loaded.runner.queue.close();
    const wrongConfig = join(t.root, "another-session-runtime.json");
    configurePluginRuntime(wrongConfig, { ...t.input, native: { ...t.input.native, sessionPath: wrong } });
    loaded = await loadPluginRuntime(t.context, wrongConfig);
    if (loaded.kind !== "configured" || !loaded.runner.lifecycle) throw new TypeError("test_configuration_failed");
    expect(await loaded.runner.lifecycle.inspect(target, AbortSignal.timeout(5000)))
      .toEqual({ ok: false, error: { code: "recovery_required" } });
  } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
});

test("refuses lifecycle inspection when the saved conversation is missing", async () => {
  const t = await configuredFixture();
  let loaded: Awaited<ReturnType<typeof loadPluginRuntime>> | undefined;
  try {
    configurePluginRuntime(t.configPath, t.input);
    loaded = await loadPluginRuntime(t.context, t.configPath);
    if (loaded.kind !== "configured" || !loaded.runner.profile || !loaded.runner.lifecycle)
      throw new TypeError("test_configuration_failed");
    const runtime = loaded.runner.profile.contract.runtime;
    if (!runtime) throw new TypeError("test_runtime_missing");
    await unlink(t.input.native.sessionPath);
    expect(await loaded.runner.lifecycle.inspect({ targetId: "missing-session", runtimeId: runtime.runtimeId,
      installationId: runtime.installationId, expectedBinding: runtime.binding }, AbortSignal.timeout(5000)))
      .toEqual({ ok: false, error: { code: "recovery_required" } });
    expect(t.calls).toEqual(["ping", "inspect", "ping", "inspect"]);
    expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
  } finally { if (loaded?.kind === "configured") loaded.runner.queue.close(); await t.close(); }
});
