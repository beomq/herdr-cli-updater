import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, lstatSync, openSync, readFileSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { AdapterResult, InstallationIdentity } from "../../src/adapters/types";
import { getOmoUpdateIntent } from "../../src/adapters/update-context";
import { consumePrivateUpdate } from "../../src/install/update";
import { evaluateResourceGate, parseResourcePlan } from "../../src/install/resources";
import { configurePluginRuntime, loadPluginRuntime, PluginRuntimeError, RUNTIME_SET_PROFILE } from "../../src/service/plugin-runtime";
import type { PluginRuntimeLoad } from "../../src/service/plugin-runtime";
import { OMO_UPDATE_RUNTIME_PROFILE, validateOmoUpdateRuntimeInputs } from "../../src/service/omo-update-runtime";
import type { OmoUpdateRuntimeInputs } from "../../src/service/omo-update-runtime";
import { serveWorker, unsupportedDomainHandler } from "../../src/service/worker";
import { fixture, hash, now } from "../fixtures/evidence/task22/update-only-composition-r1/implementation-r1/fixture";

// Real issuer, adapter, OS census and private consumer; the fixture's manager is
// controlled. This does not attest an operating installation or vendor update.
let clock = spyOn(Date, "now");
beforeEach(() => { clock = spyOn(Date, "now").mockReturnValue(now); });
afterEach(() => { clock.mockRestore(); });
function value<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}
async function setup() {
  const f = await fixture();
  const root = await realpath(await mkdtemp("/tmp/omo-only-"));
  const directory = join(root, "worker"), worker = serveWorker(directory, unsupportedDomainHandler);
  const pinned = (path: string) => ({ path, sha256: hash(readFileSync(path)) });
  const files = new Map(f.files);
  // Include the engine's real pi/senpi entry relationship required by the
  // existing check-only boundary, rather than weakening it for the old fixture.
  const engine = join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi");
  const manifestPath = join(engine, "package.json"), entry = join(engine, "dist/cli.js");
  const body = JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")),
    bin: { pi: "dist/cli.js", senpi: "dist/cli.js" } });
  const engineBody = "export const controlledEngine = true;\n";
  await mkdir(join(engine, "dist"), { recursive: true });
  await writeFile(manifestPath, body); await writeFile(entry, engineBody);
  files.set(manifestPath, body); files.set(entry, engineBody);
  const artifacts = [];
  for (const artifact of f.input.qualification.target.artifacts) {
    if (artifact.name !== "@code-yeongyu/senpi") { artifacts.push(artifact); continue; }
    const entries = Object.fromEntries(await new Bun.Archive(readFileSync(artifact.archive.path)).files());
    const archive = await new Bun.Archive({ ...entries, "package/package.json": body,
      "package/dist/cli.js": engineBody }, { compress: "gzip" }).bytes();
    await writeFile(artifact.archive.path, archive);
    const metadata = JSON.parse(readFileSync(artifact.metadata.path, "utf8"));
    await writeFile(artifact.metadata.path, JSON.stringify({ ...metadata, dist: { ...metadata.dist,
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` } }));
    artifacts.push({ ...artifact, archive: pinned(artifact.archive.path), metadata: pinned(artifact.metadata.path) });
  }
  const discoveryPath = join(f.prefix, "discovery.json");
  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
  await writeFile(discoveryPath, JSON.stringify({ ...discovery, resources: [...discovery.resources, { path: entry }]
    .map((row: { readonly path: string }) => ({ path: row.path, sha256: pinned(row.path).sha256 })) }));
  const beforeResources = [...f.installation.resources,
    { resourceId: `resource:${hash(entry)}`, realpath: entry, fingerprint: `sha256:${hash(engineBody)}` }]
    .map(row => ({ ...row, fingerprint: `sha256:${pinned(row.realpath).sha256}` })).sort((a, b) => a.realpath.localeCompare(b.realpath));
  const before: InstallationIdentity = { ...f.installation, resources: beforeResources,
    resourcesFingerprint: `sha256:${hash(JSON.stringify(beforeResources))}` };
  const qualification = { ...f.input.qualification, installation: before,
    target: { ...f.input.qualification.target, artifacts } };
  await writeFile(f.input.receipt.path, JSON.stringify(qualification));
  const fixturePlanPath = join(f.root, "fixture-plan.json");
  await writeFile(fixturePlanPath, JSON.stringify({ ...JSON.parse(readFileSync(fixturePlanPath, "utf8")), files: [...files] }));
  const resources = before.resources.map(row => ({ ...row,
    fingerprint: files.has(row.realpath) ? `sha256:${hash(files.get(row.realpath) ?? "")}` : row.fingerprint }));
  const after: InstallationIdentity = { ...before, installedVersion: { kind: "known", version: "5.1.10" },
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  const afterPath = join(root, "after.json"), tags = join(root, "tags.json");
  await writeFile(afterPath, JSON.stringify(after), { mode: 0o600 });
  await writeFile(tags, '{"latest":"5.1.10"}', { mode: 0o600 });
  const metadata = f.input.qualification.target.artifacts.find(row => row.name === "omo-ai")?.metadata;
  if (!metadata) throw new TypeError("fixture_wrapper_metadata");
  const input: OmoUpdateRuntimeInputs = { schemaVersion: 1, profile: OMO_UPDATE_RUNTIME_PROFILE,
    ownerDirectory: directory, update: { qualification, receipt: pinned(f.input.receipt.path) },
    overlays: [], provenance: [pinned(discoveryPath)],
    expectedAfterPin: pinned(afterPath), sourcePins: [],
    independentTargetPins: [...resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })),
      ...f.input.qualification.target.postinstall],
    acquiredReplies: [{ url: "https://registry.npmjs.org/omo-ai/5.1.10", status: 200, body: metadata },
      { url: "https://registry.npmjs.org/-/package/omo-ai/dist-tags", status: 200, body: pinned(tags) }],
    coverage: { root: f.root, prefix: f.prefix, socketDirectory: root, registeredSockets: [], rootPids: [process.pid] } };
  const configPath = join(root, "runtime.json"), context = { directory, coreSocket: join(root, "absent-native.sock") };
  const loaded: Extract<PluginRuntimeLoad, { readonly kind: "configured" }>[] = [];
  async function load(data: unknown = input) {
    configurePluginRuntime(configPath, data);
    const result = await loadPluginRuntime(context, configPath);
    if (result.kind === "configured") loaded.push(result);
    return result;
  }
  return { f, root, directory, input, before, after, configPath, context, load, loaded,
    async close() {
      for (const result of loaded) result.runner.queue.close();
      await worker.stop();
      await rm(root, { recursive: true, force: true });
      await f.cleanup();
    } };
}
function configured(result: PluginRuntimeLoad) {
  if (result.kind !== "configured") throw new TypeError(JSON.stringify(result));
  const profile = result.runner.profiles?.[0];
  if (!profile) throw new TypeError("fixture_missing_profile");
  const plan = value(parseResourcePlan({ contract: profile.contract, mode: "update-only", selectedTargets: [],
    mutationResources: profile.contract.installation.resources, installerDigest: hash("owned-original-plan") }));
  return { result, profile, plan };
}

async function officialAfter(t: Awaited<ReturnType<typeof setup>>, version = "5.1.19") {
  const sourceDirectory = join(import.meta.dir, "fixtures/omo-shim");
  const build = await Bun.build({ entrypoints: [join(sourceDirectory, "bun-bin-shim.js")], target: "bun" });
  const output = build.outputs[0];
  if (!build.success || !output) throw new TypeError("fixture_generator");
  const official: { bunBinShimScript: (entry: string, bun: string) => string;
    ensureBunBinShim: (input: { scriptPath: string; env: { BUN_INSTALL: string }; homedir: () => string }) => unknown } =
    await import(`data:text/javascript;base64,${Buffer.from(await output.text()).toString("base64")}`);
  const plan: { readonly files: readonly (readonly [string, string])[] } =
    JSON.parse(readFileSync(join(t.f.root, "fixture-plan.json"), "utf8"));
  for (const [path, body] of plan.files) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, body);
  }
  const modules = join(t.f.prefix, "install/global/node_modules"), wrapper = join(modules, "omo-ai");
  const manifestPath = join(wrapper, "package.json");
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), version }));
  const managerPath = join(t.f.root, "qualified-bun");
  await rename(t.f.manager, managerPath); await symlink(managerPath, t.f.manager);
  const shim = join(t.f.prefix, "bin/omo"), second = join(modules, ".bin/omo");
  await mkdir(join(modules, ".bin"), { recursive: true });
  const baseline = official.bunBinShimScript(t.after.executableRealpath, managerPath);
  await writeFile(shim, baseline); await writeFile(second, baseline);
  const sourcePins = [];
  for (const name of ["bun-bin-shim.js", "bun-runtime.js", "child-process.js"]) {
    const body = readFileSync(join(sourceDirectory, name));
    const path = join(t.root, name);
    await writeFile(path, body);
    await writeFile(join(wrapper, "bin/lib", name), body);
    sourcePins.push({ path, sha256: hash(body) });
  }
  const resources = t.after.resources.map(row => ({ ...row,
    fingerprint: `sha256:${hash(readFileSync(row.realpath))}` }));
  const after = { ...t.after, installedVersion: { kind: "known", version } as const,
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  await writeFile(t.input.expectedAfterPin.path, JSON.stringify(after));
  const qualification = { ...t.input.update.qualification,
    manager: { ...t.input.update.qualification.manager, path: managerPath },
    target: { ...t.input.update.qualification.target, version,
      postinstall: [{ path: shim, sha256: hash(baseline) }, { path: second, sha256: hash(baseline) }] } };
  await writeFile(t.input.update.receipt.path, JSON.stringify(qualification));
  const pinned = (path: string) => ({ path, sha256: hash(readFileSync(path)) });
  const input = { ...t.input, update: { qualification, receipt: pinned(t.input.update.receipt.path) },
    expectedAfterPin: pinned(t.input.expectedAfterPin.path), sourcePins,
    independentTargetPins: [...resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })),
      ...qualification.target.postinstall] };
  return { input, official, shim, second, wrapper, after };
}

test.each([
  ["5.1.19", "both"], ["5.1.19", "primary"], ["5.1.19", "secondary"],
  ["5.1.27", "both"], ["5.1.27", "primary"], ["5.1.27", "secondary"],
] as const)("keeps %s after catalog when official launcher regenerates %s shim", async (version, bins) => {
  // Given: immutable qualified after image with canonical Bun spelling.
  const t = await setup();
  try {
    const f = await officialAfter(t, version);
    const loaded = await t.load(f.input);
    if (loaded.kind !== "configured") throw new TypeError(JSON.stringify(loaded));
    const baseline = readFileSync(f.shim);
    // When: the real pinned upstream implementation repairs the launch bins.
    f.official.ensureBunBinShim({ scriptPath: t.after.executableRealpath,
      env: { BUN_INSTALL: t.f.prefix }, homedir: () => t.f.home });
    if (bins === "primary") await writeFile(f.second, baseline);
    if (bins === "secondary") await writeFile(f.shim, baseline);
    // Then: live and fresh load both retain catalog visibility, no new authority.
    expect(await loaded.readers.candidates[0]?.read()).toMatchObject({ ok: true,
      value: { contract: { installation: { installedVersion: { version } }, capabilities: { update: { kind: "unsupported" } } } } });
    const reloaded = await loadPluginRuntime(t.context, t.configPath);
    expect(reloaded.kind).toBe("configured");
    if (reloaded.kind === "configured") { t.loaded.push(reloaded); expect(reloaded.runner.profiles).toEqual([]); }
    expect(hash(readFileSync(t.input.expectedAfterPin.path))).toBe(f.input.expectedAfterPin.sha256);
  } finally { await t.close(); }
});

test.each(["shim", "secondary", "source", "installed-source", "bun-target", "mode", "other-resource", "missing-pin"] as const)(
  "rejects after catalog when regenerated launcher has %s drift", async defect => {
    // Given
    const t = await setup();
    try {
      const f = await officialAfter(t);
      let input = f.input;
      f.official.ensureBunBinShim({ scriptPath: t.after.executableRealpath,
        env: { BUN_INSTALL: t.f.prefix }, homedir: () => t.f.home });
      // When
      switch (defect) {
        case "shim": await writeFile(f.shim, readFileSync(f.shim, "utf8") + "exit 0\n"); break;
        case "secondary": await writeFile(f.second, "#!/bin/sh\nexit 0\n"); break;
        case "source": await writeFile(join(t.root, "bun-bin-shim.js"), "changed"); break;
        case "installed-source": await writeFile(join(f.wrapper, "bin/lib/bun-bin-shim.js"), "changed"); break;
        case "bun-target": await rm(t.f.manager); await symlink(process.execPath, t.f.manager); break;
        case "mode": await chmod(f.shim, 0o777); break;
        case "other-resource": await writeFile(join(f.wrapper, "bin/omo.js"), "changed"); break;
        case "missing-pin": input = { ...input, sourcePins: input.sourcePins.slice(1) }; break;
      }
      // Then
      expect((await t.load(input)).kind).toBe("unsupported");
      expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
    } finally { await t.close(); }
  });

test("keeps a separately bound foreign secondary launcher exact instead of repairing it", async () => {
  // Given: the official updater leaves a user's non-marker secondary script alone.
  const t = await setup();
  try {
    const f = await officialAfter(t, "5.1.28");
    const foreign = "#!/bin/sh\nexec /other-install/bin/omo \"$@\"\n";
    await writeFile(f.second, foreign);
    const qualification = { ...f.input.update.qualification, target: { ...f.input.update.qualification.target,
      postinstall: f.input.update.qualification.target.postinstall.map(pin => pin.path === f.second ? { ...pin, sha256: hash(foreign) } : pin),
    } };
    await writeFile(f.input.update.receipt.path, JSON.stringify(qualification));
    const input = { ...f.input, update: { qualification, receipt: { ...f.input.update.receipt,
      sha256: hash(readFileSync(f.input.update.receipt.path)) } },
      independentTargetPins: f.input.independentTargetPins.map(pin => pin.path === f.second ? { ...pin, sha256: hash(foreign) } : pin) };
    const loaded = await t.load(input);
    if (loaded.kind !== "configured") throw new TypeError("foreign_launcher_fixture");
    // When: the real pinned upstream helper repairs the primary only.
    f.official.ensureBunBinShim({ scriptPath: t.after.executableRealpath,
      env: { BUN_INSTALL: t.f.prefix }, homedir: () => t.f.home });
    // Then: primary repair is valid and the foreign secondary remains byte-exact.
    expect(await loaded.readers.candidates[0]?.read()).toMatchObject({ ok: true });
    expect(readFileSync(f.second, "utf8")).toBe(foreign);
    await writeFile(f.second, `${foreign}exit 0\n`);
    expect(await loaded.readers.candidates[0]?.read()).toEqual({ ok: false, error: { code: "stale_selection" } });
  } finally { await t.close(); }
});

test("composes independent qualified installations and dispatches checks to their exact members", async () => {
  // Given: distinct physical prefixes with real issuer/checker boundaries.
  const first = await setup(), second = await setup();
  try {
    const memberA = join(first.root, "member-a.json"), memberB = join(first.root, "member-b.json");
    configurePluginRuntime(memberA, first.input);
    configurePluginRuntime(memberB, { ...second.input, ownerDirectory: first.directory,
      coverage: { ...second.input.coverage, socketDirectory: first.root } });
    const pinned = (path: string) => ({ path, sha256: hash(readFileSync(path)) });
    // When
    const { result } = configured(await first.load({ schemaVersion: 1, profile: RUNTIME_SET_PROFILE,
      configurations: [pinned(memberA), pinned(memberB)] }));
    // Then: neither member replaces the other, and the dispatcher reaches both.
    expect(result.runner.profiles?.map(profile => profile.contract.installation.installationId))
      .toEqual([first.before.installationId, second.before.installationId]);
    const observed = await Promise.all(result.readers.candidates.map(candidate => candidate.read()));
    expect(observed.map(row => value(row).contract.installation.installationId))
      .toEqual([first.before.installationId, second.before.installationId]);
    for (const identity of [first.before, second.before]) {
      expect(await result.readers.check?.(identity)).toMatchObject({ ok: true,
        value: { kind: "update-available", availableVersion: "5.1.10" } });
      const profile = result.runner.profiles?.find(row => row.contract.installation.installationId === identity.installationId);
      if (!profile) throw new TypeError("fixture_member_missing");
      expect(profile.sourcePins).toContainEqual(pinned(first.configPath));
      expect(profile.adapter.updateSpec(identity, "update-and-restart").ok).toBe(false);
      expect(profile.adapter.updateSpec(identity, "update-only").ok).toBe(true);
    }
  } finally { await second.close(); await first.close(); }
});

test("loads pinned runtime members without letting a refused member hide verified authority", async () => {
  const t = await setup();
  try {
    const good = join(t.root, "member-good.json"), refused = join(t.root, "member-refused.json");
    configurePluginRuntime(good, t.input);
    const expired = { ...t.input, update: { ...t.input.update,
      qualification: { ...t.input.update.qualification,
        target: { ...t.input.update.qualification.target, checkedAt: 0, expiresAt: 1 } } } };
    configurePluginRuntime(refused, expired);
    const pinned = (path: string) => ({ path, sha256: hash(readFileSync(path)) });
    const input = { schemaVersion: 1, profile: RUNTIME_SET_PROFILE,
      configurations: [pinned(good), pinned(refused)] };
    const { result } = configured(await t.load(input));
    expect(result.readers.candidates).toHaveLength(1);
    expect(result.runner.profiles).toHaveLength(1);
    expect(result.runner.profiles?.[0]?.sourcePins).toContainEqual(pinned(t.configPath));
    await writeFile(refused, "changed pinned configuration", { mode: 0o600 });
    expect(await loadPluginRuntime(t.context, t.configPath)).toEqual({ kind: "unsupported", reason: "inputs" });
  } finally { await t.close(); }
});

test("loads original update-only authority with registry-derived worker sockets and no native host", async () => {
  // Given
  const t = await setup();
  try {
    // When
    const { result, profile, plan } = configured(await t.load());
    // Then
    expect(validateOmoUpdateRuntimeInputs(t.input)).toEqual(t.input);
    expect(lstatSync(t.f.prefix).mode & 0o777).toBe(0o755);
    expect(result.runner.lifecycle).toBeUndefined();
    expect(profile.catalogRoots).toEqual([join(t.f.prefix, "install/global"), join(t.f.prefix, "bin")]);
    expect(profile.mutationRoots).toBeUndefined();
    expect(profile.contract.runtime).toBeNull();
    expect(profile.contract.capabilities.resume.kind).toBe("unsupported");
    expect(result.readers.sockets).toEqual([]);
    expect(result.readers.candidates[0]?.installationId).toBe(t.before.installationId);
    expect(evaluateResourceGate(plan, profile.observe(plan))).toEqual({ ok: true, value: null });
    expect(profile.adapter.updateSpec(t.before, "update-and-restart").ok).toBe(false);
    const spec = value(profile.adapter.updateSpec(t.before, "update-only"));
    expect(parseResourcePlan({ contract: profile.contract, mode: "update-only", selectedTargets: [],
      mutationResources: spec.mutationResources, installerDigest: plan.installerDigest,
      ...(profile.mutationRoots ? { transition: { expectedAfter: profile.expectedAfter,
        mutationRoots: profile.mutationRoots } } : {}) }).ok).toBe(true);
    expect(value(getOmoUpdateIntent(spec)).mode).toBe("update-only");
    expect(await result.readers.candidates[0]?.read()).toMatchObject({ ok: true,
      value: { contract: { capabilities: { update: { kind: "supported" } } } } });
    expect(lstatSync(t.context.coreSocket, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
  } finally { await t.close(); }
});

test("actual private consumer keeps the after catalog and never grants restart or replays consumed authority", async () => {
  // Given
  const t = await setup();
  try {
    const { result, profile } = configured(await t.load());
    const first = value(profile.adapter.updateSpec(t.before, "update-only"));
    const second = value(profile.adapter.updateSpec(t.before, "update-only"));
    // When: only the owned controlled manager executes, through the real kernel consumer.
    const consumed = await consumePrivateUpdate(first, { receiptRoot: t.f.journal, now: () => now });
    // Then: changed original bytes remain visible without regenerating authority.
    expect(consumed).toMatchObject({ ok: true, value: { kind: "files-verified" } });
    expect(profile.observeAfter()).toEqual(t.after);
    expect(await result.readers.candidates[0]?.read()).toMatchObject({ ok: true,
      value: { contract: { installation: t.after, runtime: null, capabilities: { update: { kind: "unsupported" } } } } });
    const requested: string[] = [];
    const latestFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      return Response.json(url.endsWith("/dist-tags") ? { latest: "5.1.11" } : { name: "omo-ai", version: "5.1.11" });
    }, { preconnect: fetch.preconnect }));
    try {
      expect(await result.readers.check?.(t.after)).toMatchObject({ ok: true, value: {
        kind: "update-available", installedVersion: "5.1.10", availableVersion: "5.1.11",
      } });
      expect(requested).toEqual(["https://registry.npmjs.org/-/package/omo-ai/dist-tags", "https://registry.npmjs.org/omo-ai/5.1.11"]);
    } finally { latestFetch.mockRestore(); }
    expect(await consumePrivateUpdate(second, { receiptRoot: t.f.journal, now: () => now })).toEqual({
      ok: false, error: { code: "verification_failed" } });
    expect(profile.adapter.updateSpec(t.before, "update-only").ok).toBe(false);
    expect(readFileSync(t.f.effects, "utf8").trim().split("\n")).toHaveLength(1);
    // Startup observes the independently pinned after state, not old qualification.
    const reloaded = await loadPluginRuntime(t.context, t.configPath);
    if (reloaded.kind !== "configured") throw new TypeError(JSON.stringify(reloaded));
    t.loaded.push(reloaded);
    expect(reloaded.runner.profiles).toEqual([]);
    expect(await reloaded.readers.candidates[0]?.read()).toMatchObject({ ok: true,
      value: { contract: { installation: t.after, capabilities: { update: { kind: "unsupported" } } } } });
  } finally { await t.close(); }
});

test("denies an actual live prefix consumer even when its PID is covered", async () => {
  // Given
  const t = await setup();
  const fd = openSync(t.f.installation.executableRealpath, "r");
  try {
    // When
    const { result, profile, plan } = configured(await t.load());
    const observation = profile.observe(plan);
    // Then
    // Darwin lsof may return partial records with status 1. Such coverage is
    // unsupported, never upgraded to complete merely because this PID is known.
    expect(observation).toMatchObject({ allSocketsKnown: true,
      consumers: [expect.objectContaining({ binding: null, state: "running" })] });
    expect(evaluateResourceGate(plan, observation).ok).toBe(false);
    expect(profile.adapter.updateSpec(t.before, "update-only")).toEqual({ ok: false, error: { code: "resources_busy" } });
    expect(await result.readers.candidates[0]?.read()).toMatchObject({ ok: true,
      value: { contract: { capabilities: { update: { kind: "unsupported" } } } } });
    expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
  } finally { closeSync(fd); await t.close(); }
});

test("ignores untouched Bun cache readers while still detecting external hardlink readers of installed files", async () => {
  const t = await setup();
  const cachePath = join(t.f.prefix, "install/cache/untouched");
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, "unchanged-cache");
  const cacheFd = openSync(cachePath, "r");
  let aliasFd: number | undefined;
  try {
    const { profile, plan } = configured(await t.load());
    expect(evaluateResourceGate(plan, profile.observe(plan))).toEqual({ ok: true, value: null });
    const installedPath = join(t.f.prefix, "install/global/node_modules/open-file");
    const outside = join(t.root, "external-hardlink");
    await writeFile(installedPath, "held-installation-file");
    await link(installedPath, outside);
    aliasFd = openSync(outside, "r");
    const observed = profile.observe(plan);
    expect(observed).toMatchObject({ consumers: [expect.objectContaining({ state: "running" })] });
    expect(evaluateResourceGate(plan, observed).ok).toBe(false);
    expect(readFileSync(cachePath, "utf8")).toBe("unchanged-cache");
    expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
  } finally {
    if (aliasFd !== undefined) closeSync(aliasFd);
    closeSync(cacheFd); await t.close();
  }
});

test("rejects an exact unknown socket instead of treating the namespace as known", async () => {
  // Given
  const t = await setup(), server = createServer();
  const listening = once(server, "listening");
  server.listen(join(t.root, "unknown.sock")); await listening;
  try {
    // When
    const { result, profile, plan } = configured(await t.load());
    // Then
    expect(evaluateResourceGate(plan, profile.observe(plan))).toEqual({ ok: false, error: { code: "unsupported" } });
    expect(profile.adapter.updateSpec(t.before, "update-only").ok).toBe(false);
    expect(await result.readers.candidates[0]?.read()).toMatchObject({ ok: true,
      value: { contract: { capabilities: { update: { kind: "unsupported" } } } } });
  } finally {
    const closed = once(server, "close"); server.close(); await closed; await t.close();
  }
});

test("pins the optional original postinstall Node before dispatch", async () => {
  const t = await setup(), node = join(t.root, "node");
  try {
    await writeFile(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const input: OmoUpdateRuntimeInputs = { ...t.input, update: { ...t.input.update, qualification: {
      ...t.input.update.qualification, manager: { ...t.input.update.qualification.manager,
        node: { path: node, sha256: hash(readFileSync(node)) } },
      env: { ...t.input.update.qualification.env, PATH: `${t.input.update.qualification.env["PATH"]}:${t.root}` },
    } } };
    await writeFile(input.update.receipt.path, JSON.stringify(input.update.qualification));
    const pinnedInput = { ...input, update: { ...input.update,
      receipt: { path: input.update.receipt.path, sha256: hash(readFileSync(input.update.receipt.path)) } } };
    const { profile, plan } = configured(await t.load(pinnedInput));
    expect(profile.adapter.updateSpec(t.before, "update-only").ok).toBe(true);
    await writeFile(node, "#!/bin/sh\nexit 1\n");
    expect(profile.adapter.updateSpec(t.before, "update-only").ok).toBe(false);
    expect(() => profile.observe(plan)).toThrow();
    expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
  } finally { await t.close(); }
});

test.each(["configuration", "manager", "home-config", "global-config", "kernel-interpreter"] as const)(
  "retains original configuration and kernel manager guards for %s drift", async defect => {
    // Given
    const t = await setup();
    try {
      const { result, profile, plan } = configured(await t.load());
      const spec = value(profile.adapter.updateSpec(t.before, "update-only"));
      // When
      switch (defect) {
        case "configuration": await writeFile(t.configPath, readFileSync(t.configPath, "utf8") + "\n"); break;
        case "manager": await writeFile(t.f.manager, "#!/bin/sh\nexit 1\n"); break;
        case "home-config": await writeFile(join(t.f.home, ".npmrc"), "fixture-config"); break;
        case "global-config": await writeFile(join(t.f.prefix, "install/global/bunfig.toml"), "fixture-config"); break;
        case "kernel-interpreter": await chmod(t.f.manager, 0o600); break;
      }
      // Then
      expect(profile.adapter.updateSpec(t.before, "update-only").ok).toBe(false);
      if (defect === "configuration") {
        expect(() => profile.observe(plan)).toThrow();
        expect(await result.readers.candidates[0]?.read()).toEqual({ ok: false, error: { code: "stale_selection" } });
      } else {
        expect((await consumePrivateUpdate(spec, { receiptRoot: t.f.journal, now: () => now })).ok).toBe(false);
      }
      expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
    } finally { await t.close(); }
  });

test.each(["expired", "independent-target", "after-version", "root-anchor", "receipt", "source"] as const)(
  "rejects incomplete or stale runtime input %s before update support", async defect => {
    // Given
    const t = await setup();
    try {
      let input = t.input;
      switch (defect) {
        case "expired": {
          const qualification = { ...input.update.qualification,
            target: { ...input.update.qualification.target, checkedAt: 1, expiresAt: 2 } };
          const body = JSON.stringify(qualification);
          await writeFile(input.update.receipt.path, body);
          input = { ...input, update: { qualification, receipt: { ...input.update.receipt, sha256: hash(body) } } };
          break;
        }
        case "independent-target": input = { ...input, independentTargetPins: [] }; break;
        case "after-version": {
          const body = JSON.stringify({ ...t.after, installedVersion: { kind: "known", version: "5.1.11" } });
          await writeFile(input.expectedAfterPin.path, body);
          input = { ...input, expectedAfterPin: { ...input.expectedAfterPin, sha256: hash(body) } }; break;
        }
        case "root-anchor": input = { ...input, coverage: { ...input.coverage, rootPids: [] } }; break;
        case "receipt": await writeFile(input.update.receipt.path, "{}"); break;
        case "source": {
          const artifact = input.update.qualification.target.artifacts[0];
          if (!artifact) throw new TypeError("fixture_artifact");
          await writeFile(artifact.archive.path, "changed"); break;
        }
      }
      // When
      const loaded = await t.load(input);
      // Then
      expect(loaded.kind).toBe("unsupported");
      expect(lstatSync(join(t.directory, "mutations"), { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(t.f.effects, { throwIfNoEntry: false })).toBeUndefined();
    } finally { await t.close(); }
  });

test("rejects native ports and callback-bearing configuration without evaluating getters", async () => {
  // Given
  const t = await setup();
  let calls = 0;
  try {
    const injected = { ...t.input, get native() { calls++; return {}; } };
    // When / Then
    expect(() => validateOmoUpdateRuntimeInputs(injected)).toThrow(PluginRuntimeError);
    expect(() => configurePluginRuntime(t.configPath, { ...t.input, native: {} })).toThrow(PluginRuntimeError);
    expect(calls).toBe(0);
    expect(lstatSync(t.configPath, { throwIfNoEntry: false })).toBeUndefined();
  } finally { await t.close(); }
});
