import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, constants, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGY_INSTALLER_SHA256, AGY_MANIFEST_CHANNEL } from "../../src/adapters/agy";
import { createAgyUpdateSpec, executeAgyUpdate, getAgyUpdateIntent, qualifyAgyUpdate } from "../../src/adapters/agy-update";
import type { NativeAgyUpdateInput } from "../../src/adapters/agy-update";
import { createCursorUpdateSpec, executeCursorUpdate, getCursorUpdateIntent, qualifyCursorUpdate } from "../../src/adapters/cursor-update";
import type { NativeCursorUpdateInput } from "../../src/adapters/cursor-update";
import type { AdapterResult, InstallationIdentity } from "../../src/adapters/types";
import { evaluateResourceGate } from "../../src/install/resources";
import type { ResourcePlan } from "../../src/install/resources";
import { loadNativeUpdateRuntime, NATIVE_UPDATE_RUNTIME_PROFILE, validateNativeUpdateRuntimeInputs } from "../../src/service/native-update-runtime";
import type { NativeUpdateRuntimeInputs } from "../../src/service/native-update-runtime";
import type { PluginRuntimeLoad } from "../../src/service/plugin-runtime";
import { artifactRoot, artifactTest } from "../fixtures/artifacts";

// Retained genuine official sources; these tests never run a native command,
// acquire network data, read credentials or assert actual update success.
const evidence = artifactRoot;
const current = join(evidence, "six-families/native-update/cursor-agy-current");
const now = 1_800_000_000_000, cursorVersion = "2026.10.01-e373342";
const hash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
let clock = spyOn(Date, "now");
let restoreHttp: (() => void) | undefined;
beforeEach(() => { clock = spyOn(Date, "now").mockReturnValue(now); });
afterEach(async () => {
  restoreHttp?.(); restoreHttp = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clock.mockRestore();
});
function value<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new TypeError(result.error.code); return result.value;
}
function configured(result: PluginRuntimeLoad) {
  if (result.kind !== "configured") throw new TypeError(JSON.stringify(result)); return result;
}
function put(path: string, body: string | Uint8Array, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body); chmodSync(path, mode);
  return { path, sha256: hash(body) };
}
function pin(path: string) { return { path, sha256: hash(readFileSync(path)) }; }
async function socket(path: string) {
  const server = createServer(peer => peer.end()), listening = once(server, "listening");
  server.listen(path); await listening; chmodSync(path, 0o600);
  cleanups.push(async () => { const closed = once(server, "close"); server.close(); await closed; });
}
function memberFiles(original: string) {
  const files: { path: string; sha256: string; bytes: number; mode: number }[] = [];
  const directories: string[] = [];
  const pending = [original];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const names = readdirSync(dir);
    if (names.length === 0) directories.push(dir.slice(original.length + 1));
    for (const name of names) {
      const file = join(dir, name), info = lstatSync(file);
      if (info.isDirectory()) pending.push(file);
      else files.push({ path: file.slice(original.length + 1), sha256: hash(readFileSync(file)), bytes: info.size, mode: info.mode & 0o777 });
    }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), directories };
}
const cursorInventory = memberFiles(join(current, "cursor/package/dist-package")), cursorFiles = cursorInventory.files;
type Profile = NativeUpdateRuntimeInputs["profiles"][number];
async function nativeProfile(base: string, family: "cursor" | "agy") {
  const scope = join(base, family), home = join(scope, "home");
  mkdirSync(scope, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  let profile: Pick<Profile, "provenance" | "sourcePins" | "expectedAfterPin"> &
    ({ family: "cursor"; update: NativeCursorUpdateInput } | { family: "agy"; update: NativeAgyUpdateInput });
  switch (family) {
    case "cursor": {
      const prefix = join(home, ".local/share/cursor-agent"), source = join(prefix, "versions/current-source");
      for (const dir of [source, join(home, ".local/bin"), ...["config", "data", "compile-cache", "tmp"].map(name => join(home, name))])
        mkdirSync(dir, { recursive: true, mode: 0o755 });
      cpSync(join(current, "cursor/package/dist-package"), source, { recursive: true, mode: constants.COPYFILE_FICLONE });
      const executable = join(source, "cursor-agent");
      for (const alias of ["agent", "cursor-agent"]) symlinkSync(executable, join(home, ".local/bin", alias));
      put(join(home, "config/cli-config.json"), readFileSync(join(current, "probe-home/config/cli-config.json")), 0o644);
      const resources = cursorFiles.map(row => ({ realpath: join(source, row.path),
        resourceId: `resource:${hash(join(source, row.path))}`, fingerprint: `sha256:${row.sha256}` }))
        .sort((a, b) => a.realpath.localeCompare(b.realpath));
      const installation: InstallationIdentity = { family, channel: "prod", executableRealpath: executable,
        installationId: `install:${hash(executable)}`, owner: { kind: "native", prefix: home,
          installerDigest: "sha256:8a2f1c777a037577596844c9759bd121970a33f1be482e9ecea1c8f0987dcbeb" },
        installedVersion: { kind: "known", version: cursorVersion }, resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
      const archive = join(scope, "supply/darwin/arm64/agent-cli-package.tar.gz");
      mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
      copyFileSync(join(current, "cursor/package.tar.gz"), archive, constants.COPYFILE_FICLONE);
      const qualification: NativeCursorUpdateInput["qualification"] = { installation, home,
        originalExecutable: join(current, "cursor/package/dist-package/cursor-agent"), beforeFiles: cursorFiles,
        beforeDirectories: cursorInventory.directories, beforeInstaller: pin(join(current, "cursor/package/dist-package/9164.index.js")),
        env: { HOME: home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin", AGENT_CLI_CREDENTIAL_STORE: "file",
          CURSOR_CONFIG_DIR: join(home, "config"), CURSOR_DATA_DIR: join(home, "data"), NODE_COMPILE_CACHE: join(home, "compile-cache") },
        manifest: put(join(scope, "manifest.json"), JSON.stringify(cursorFiles)), expectedFiles: cursorFiles,
        dependencies: ["/bin/bash", "/bin/realpath", "/bin/sh", "/usr/bin/basename", "/usr/bin/bsdtar", "/usr/bin/curl",
          "/usr/bin/dirname", "/usr/bin/env", "/usr/bin/readlink", "/usr/bin/sandbox-exec"].map(pin),
        target: { version: cursorVersion, channel: "prod", archive: pin(archive),
          release: put(join(scope, "release.json"), JSON.stringify({ method: "POST",
            url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl", request: { channel: "prod" },
            status: 200, response: { version: cursorVersion, url: `https://downloads.cursor.com/lab/${cursorVersion}/` } })),
          checkedAt: now, expiresAt: now + 300_000 } };
      const update = { qualification, receipt: put(join(scope, "receipt.json"), JSON.stringify(qualification)) };
      const issued = value(createCursorUpdateSpec(value(await qualifyCursorUpdate(update, now)), "update-only", now));
      profile = { family, update, provenance: provenance(scope, installation), sourcePins: [],
        expectedAfterPin: put(join(scope, "after.json"), JSON.stringify(issued.expectedAfter)) };
      break;
    }
    case "agy": {
      const nativeRoot = join(scope, "state"), nativeHome = join(nativeRoot, "home"), executable = join(nativeRoot, "bin/agy");
      mkdirSync(nativeRoot, { mode: 0o700 }); mkdirSync(nativeHome, { mode: 0o700 });
      mkdirSync(join(nativeRoot, "bin"), { mode: 0o755 }); mkdirSync(join(nativeHome, "tmp"), { mode: 0o755 });
      const original = join(current, "agy/update-success-r1/acquired/antigravity");
      copyFileSync(original, executable, constants.COPYFILE_FICLONE); chmodSync(executable, 0o755);
      const resources = [{ realpath: executable, resourceId: `resource:${hash(executable)}`,
        fingerprint: "sha256:d15693410c904242c1c3423a579f60a81e018444bb51fbccc6505f988b62a91d" }];
      const installation: InstallationIdentity = { family, channel: AGY_MANIFEST_CHANNEL, executableRealpath: executable,
        installationId: `install:${hash(executable)}`, owner: { kind: "native", prefix: nativeRoot, installerDigest: `sha256:${AGY_INSTALLER_SHA256}` },
        installedVersion: { kind: "known", version: "1.2.15" }, resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
      const manifest = { version: "1.2.16",
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.16-5594158052802560/darwin-arm/cli_mac_arm64.tar.gz",
        sha512: "834a62dc972cfdf09cdb001c7ba79bb5bc9ae5acdba8bd9c4d2939045b76e19c9bdb6eeac58ed88a1deaa1670fc9335eee18482fe2f32603e78224de9573b0fe" };
      const qualification: NativeAgyUpdateInput["qualification"] = { installation, root: nativeRoot, home: nativeHome,
        source: pin(original), installer: pin(join(evidence, "task-5/families/agy/boundedsource/install.sh")),
        env: { HOME: nativeHome, TMPDIR: join(nativeHome, "tmp"), PATH: "/usr/bin:/bin",
          XDG_CONFIG_HOME: join(nativeHome, ".config"), XDG_CACHE_HOME: join(nativeHome, ".cache"), XDG_DATA_HOME: join(nativeHome, ".local/share") },
        dependencies: [pin("/usr/bin/sandbox-exec")], target: { selection: "official-latest", version: "1.2.16", channel: AGY_MANIFEST_CHANNEL,
          archive: pin(join(current, "agy/package.tar.gz")), manifest: put(join(scope, "manifest.json"), JSON.stringify(manifest)),
          release: put(join(scope, "release.json"), JSON.stringify({ method: "GET", url: AGY_MANIFEST_CHANNEL,
            status: 200, checkedAt: now, response: manifest })),
          expectedFiles: [{ path: "antigravity", sha256: "7dca095cfc1df2c057a385ed88a76c7ba98dc103258a80be87a8f42e484cb3aa",
            bytes: 175966448, mode: 0o755 }], checkedAt: now, expiresAt: now + 300_000 } };
      const update = { qualification, receipt: put(join(scope, "receipt.json"), JSON.stringify(qualification)) };
      const issued = value(createAgyUpdateSpec(value(await qualifyAgyUpdate(update, now)), "update-only", now));
      profile = { family, update, provenance: provenance(scope, installation), sourcePins: [],
        expectedAfterPin: put(join(scope, "after.json"), JSON.stringify(issued.expectedAfter)) };
      break;
    }
  }
  return profile;
}
function provenance(scope: string, identity: InstallationIdentity) {
  return put(join(scope, "provenance.json"), JSON.stringify({ family: identity.family, executable: identity.executableRealpath,
    channel: identity.channel, owner: identity.owner, packageManifest: null,
    resources: identity.resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })) }));
}
async function fixture(families: readonly ("cursor" | "agy")[] = ["agy"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-runtime-"))); roots.push(root);
  const directory = join(root, "worker"); mkdirSync(directory, { mode: 0o700 });
  const ownSocket = join(directory, "updater.sock"); await socket(ownSocket);
  const profiles: Profile[] = [];
  for (const family of families) profiles.push({ ...await nativeProfile(root, family), coverage: {
    root, socketDirectory: directory, registeredSockets: [ownSocket], rootPids: [process.pid] } });
  const input: NativeUpdateRuntimeInputs = { schemaVersion: 1, profile: NATIVE_UPDATE_RUNTIME_PROFILE, ownerDirectory: directory, profiles };
  const context = { directory, coreSocket: "" };
  const save = (value: unknown = input) => put(join(root, "native.json"), JSON.stringify(value));
  const configuration = save();
  return { root, input, context, configuration, save,
    load: async () => configured(await loadNativeUpdateRuntime(context, configuration, input)) };
}
function first<T>(rows: readonly T[]): T {
  const row = rows[0]; if (!row) throw new TypeError("fixture_profile"); return row;
}

artifactTest("parses a closed family union without reading files or invoking input behavior", () => {
  // Given: hostile values at the persisted-data boundary.
  let calls = 0;
  const getter = { get profile() { calls++; return NATIVE_UPDATE_RUNTIME_PROFILE; } };
  const proxy = new Proxy({}, { ownKeys() { calls++; throw new Error("must_not_run"); } });
  // When/Then: classification never evaluates either behavior.
  for (const input of [getter, proxy, { profile: NATIVE_UPDATE_RUNTIME_PROFILE, command: "/bin/sh" }])
    expect(() => validateNativeUpdateRuntimeInputs(input)).toThrow();
  expect(calls).toBe(0);
});

artifactTest("loads both genuine native profiles without core, native execution or persistent writes", async () => {
  // Given: pinned producer records and only the updater's own socket.
  const f = await fixture(["cursor", "agy"]), before = readdirSync(f.root).sort();
  // When: the source-only composition loads.
  const runtime = await f.load();
  // Then: both profiles retain issuer transitions; queue creation remains lazy.
  expect(runtime.readers.candidates.map(row => row.family)).toEqual(["cursor", "agy"]);
  expect(runtime.runner.profiles).toHaveLength(2);
  expect(readdirSync(f.root).sort()).toEqual(before);
  expect(readdirSync(f.context.directory)).toEqual(["updater.sock"]);
  expect(runtime.runner.lifecycle).toBeUndefined(); expect(runtime.readers.sockets).toEqual([]);
  for (const p of runtime.runner.profiles ?? []) {
    expect(p.contract.runtime).toBeNull();
    for (const name of ["completion", "resume", "gracefulExit", "busySafe"] as const)
      expect(p.contract.capabilities[name].kind).toBe("unsupported");
    expect(p.adapter.updateSpec(p.contract.installation, "update-and-restart")).toEqual({ ok: false, error: { code: "unsupported" } });
  }
}, 60_000);

artifactTest.each(["cursor", "agy"] as const)("checks the %s official channel at actual completion time without a native probe", async family => {
  // Given: authenticated installed bytes and an acquired official response.
  const f = await fixture([family]), runtime = await f.load(), p = first(runtime.runner.profiles ?? []);
  clock.mockReturnValue(now + 1000);
  const response = family === "cursor" ? { version: cursorVersion, url: `https://downloads.cursor.com/lab/${cursorVersion}/` }
    : { version: "1.2.16", url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.16-5594158052802560/darwin-arm/cli_mac_arm64.tar.gz",
      sha512: "834a62dc972cfdf09cdb001c7ba79bb5bc9ae5acdba8bd9c4d2939045b76e19c9bdb6eeac58ed88a1deaa1670fc9335eee18482fe2f32603e78224de9573b0fe" };
  const testFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!(input instanceof Request)) throw new TypeError("fixture_request");
    expect(input.method).toBe(family === "cursor" ? "POST" : "GET");
    expect(input.url).toBe(family === "cursor"
      ? "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl" : AGY_MANIFEST_CHANNEL);
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error");
    if (family === "cursor") expect(await input.text()).toBe('{"channel":"prod"}');
    return Response.json(response);
  }, { preconnect: fetch.preconnect });
  const http = spyOn(globalThis, "fetch").mockImplementation(testFetch);
  restoreHttp = () => http.mockRestore();
  // When: a real Request reaches the HTTP boundary, replaced only in this test.
  const result = value(await p.adapter.check(p.contract.installation));
  // Then: Cursor's lab download URL is not its effective channel; AGY is floating.
  expect(result).toEqual(family === "cursor"
    ? { kind: "up-to-date", installedVersion: cursorVersion, checkedAt: now + 1000 }
    : { kind: "update-available", installedVersion: "1.2.15", availableVersion: "1.2.16", checkedAt: now + 1000 });
  expect(http).toHaveBeenCalledTimes(1);
  expect(p.contract.installation.channel).toBe(family === "cursor" ? "prod" : AGY_MANIFEST_CHANNEL);
  expect(first(f.input.profiles).update.qualification.target.checkedAt).toBe(now);
}, 60_000);

artifactTest.each(["cursor", "agy"] as const)("observes newer %s HTTP metadata independently from the qualified acquisition", async family => {
  // Given: fixed qualification plus deliberately newer wire fixtures, not actual
  // vendor release claims. Only the public HTTP boundary is replaced.
  const f = await fixture([family]), runtime = await f.load(), p = first(runtime.runner.profiles ?? []);
  const newer = family === "cursor" ? "2026.10.02-abcdef0" : "1.2.17";
  const response = family === "cursor" ? { version: newer, url: `https://downloads.cursor.com/lab/${newer}/` }
    : { version: newer, url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${newer}-123/darwin-arm/cli_mac_arm64.tar.gz`,
      sha512: "a".repeat(128) };
  const testFetch = Object.assign(async () => Response.json(response), { preconnect: fetch.preconnect });
  const http = spyOn(globalThis, "fetch").mockImplementation(testFetch);
  restoreHttp = () => http.mockRestore(); clock.mockReturnValue(now + 300_000);
  // When: a check runs even though the original update authorization has expired.
  const result = value(await p.adapter.check(p.contract.installation));
  // Then: fresh public metadata is not the old pinned response or renewed authority.
  expect(result).toEqual({ kind: "update-available", installedVersion: family === "cursor" ? cursorVersion : "1.2.15",
    availableVersion: newer, checkedAt: now + 300_000 });
  expect(http).toHaveBeenCalledTimes(1);
  expect(p.adapter.updateSpec(p.contract.installation, "update-only").ok).toBe(false);
  expect(first(f.input.profiles).update.qualification.target.checkedAt).toBe(now);
}, 60_000);

artifactTest("rejects extra fields, mixed families, arbitrary environment and duplicate installation IDs", async () => {
  // Given: one structurally valid AGY profile; structural parsing need not issue.
  const f = await fixture(), p = first(f.input.profiles);
  // When/Then: persisted JSON cannot select callbacks, modules or another issuer.
  for (const altered of [
    { ...f.input, command: "/bin/sh" },
    { ...f.input, profiles: [{ ...p, module: "anything" }] },
    { ...f.input, profiles: [{ ...p, family: "cursor" }] },
    { ...f.input, profiles: [p, p] },
    { ...f.input, profiles: [{ ...p, update: { ...p.update, qualification: {
      ...p.update.qualification, target: { ...p.update.qualification.target, selection: "fixed-version" } } } }] },
    { ...f.input, profiles: [{ ...p, update: { ...p.update, qualification: {
      ...p.update.qualification, env: { ...p.update.qualification.env, NODE_OPTIONS: "foreign" } } } }] },
  ]) expect(() => validateNativeUpdateRuntimeInputs(altered)).toThrow();
  expect(validateNativeUpdateRuntimeInputs(f.input)).toEqual(f.input);
}, 30_000);

artifactTest("requires independent expectedAfter and rejects fake before-to-after resources", async () => {
  // Given: an independently pinned document substituted with the unchanged source.
  const f = await fixture(), p = first(f.input.profiles);
  const expectedAfterPin = put(p.expectedAfterPin.path, JSON.stringify(p.update.qualification.installation));
  const altered = { ...f.input, profiles: [{ ...p, expectedAfterPin }] };
  // When: every outer pin is refreshed but the issuer's target differs.
  const result = await loadNativeUpdateRuntime(f.context, f.save(altered), altered);
  // Then: matching configuration JSON is not target authority.
  expect(result).toEqual({ kind: "unsupported", reason: "inputs" });
}, 30_000);

artifactTest.each(["provenance", "source", "release", "config", "after"] as const)("revokes issued product authority after %s changes", async change => {
  // Given: genuine qualification and an already composed adapter.
  const f = await fixture(), runtime = await f.load(), p = first(runtime.runner.profiles ?? []), input = first(f.input.profiles);
  const path = change === "provenance" ? input.provenance.path : change === "source" ? p.contract.installation.executableRealpath
    : change === "release" ? input.update.qualification.target.release.path
    : change === "after" ? input.expectedAfterPin.path : f.configuration.path;
  // When: a pinned input changes after loading.
  put(path, "changed", change === "source" ? 0o755 : 0o600);
  // Then: previously captured installation identity cannot issue authority.
  expect(p.adapter.updateSpec(p.contract.installation, "update-only").ok).toBe(false);
  expect((await p.adapter.detect(p.contract.installation.executableRealpath)).ok).toBe(false);
}, 60_000);

artifactTest("expires update capability without renewing acquisition authority", async () => {
  // Given: a previously issued fresh profile.
  const f = await fixture(), runtime = await f.load(), p = first(runtime.runner.profiles ?? []);
  clock.mockReturnValue(now + 300_000);
  // When: catalog publication asks for current capability.
  const row = value(await first(runtime.readers.candidates).read());
  // Then: installed source remains checkable but update is no longer authorized.
  expect(row.contract.capabilities.update.kind).toBe("unsupported");
  expect(p.adapter.updateSpec(p.contract.installation, "update-only").ok).toBe(false);
}, 60_000);

artifactTest("admits a native-free owner with its updater socket and complete real resource census", async () => {
  // Given: no native runtime, genuine AGY root and an existing updater socket.
  const f = await fixture(), runtime = await f.load(), p = first(runtime.runner.profiles ?? []);
  const spec = value(p.adapter.updateSpec(p.contract.installation, "update-only"));
  if (p.contract.installation.owner.kind !== "native" || !p.mutationRoots) throw new TypeError("fixture_owner");
  const plan: ResourcePlan = { contract: p.contract, mode: "update-only", selectedTargets: [],
    installerDigest: p.contract.installation.owner.installerDigest, mutationResources: spec.mutationResources,
    transition: { expectedAfter: p.expectedAfter, mutationRoots: p.mutationRoots } };
  // When: the production ps/lsof and namespace readers observe the owned scope.
  const observation = p.observe(plan);
  // Then: no fabricated runtime binding is necessary.
  expect(evaluateResourceGate(plan, observation)).toEqual({ ok: true, value: null });
}, 60_000);

artifactTest("rejects an unregistered socket anywhere in owned HOME namespaces", async () => {
  // Given: load qualified clean HOME before an unknown socket appears.
  const f = await fixture(), runtime = await f.load(), p = first(runtime.runner.profiles ?? []);
  const input = first(f.input.profiles);
  await socket(join(input.update.qualification.home, "tmp", "unknown.sock"));
  const before = p.contract.installation;
  // When/Then: static fresh qualification rejects changed HOME before resources can be admitted.
  expect(p.adapter.updateSpec(before, "update-only").ok).toBe(false);
}, 60_000);

artifactTest("rejects an unregistered socket outside HOME but within the coverage root", async () => {
  // Given: the native owner is unchanged; another covered namespace has a socket.
  const f = await fixture(), runtime = await f.load(), p = first(runtime.runner.profiles ?? []);
  mkdirSync(join(f.root, "other"), { mode: 0o700 }); await socket(join(f.root, "other", "unknown.sock"));
  const spec = value(p.adapter.updateSpec(p.contract.installation, "update-only"));
  if (p.contract.installation.owner.kind !== "native" || !p.mutationRoots) throw new TypeError("fixture_owner");
  const plan: ResourcePlan = { contract: p.contract, mode: "update-only", selectedTargets: [],
    installerDigest: p.contract.installation.owner.installerDigest, mutationResources: spec.mutationResources,
    transition: { expectedAfter: p.expectedAfter, mutationRoots: p.mutationRoots } };
  // When: all namespaces are scanned rather than only socketDirectory.
  const result = evaluateResourceGate(plan, p.observe(plan));
  // Then: the unknown socket prevents update admission.
  expect(result).toEqual({ ok: false, error: { code: "unsupported" } });
}, 60_000);

artifactTest("rejects a coverage census that omits the actual worker PID", async () => {
  // Given: matching producer data without the current worker root.
  const f = await fixture(), p = first(f.input.profiles);
  const altered = { ...f.input, profiles: [{ ...p, coverage: { ...p.coverage, rootPids: [1] } }] };
  // When: load tries to bind the stable owned root process set.
  const result = await loadNativeUpdateRuntime(f.context, f.save(altered), altered);
  // Then: an arbitrary or recycled PID cannot stand in for the worker.
  expect(result).toEqual({ kind: "unsupported", reason: "inputs" });
}, 30_000);

artifactTest.each(["cursor", "agy"] as const)("rejects %s exit-zero noops and does not expose restart authority", async family => {
  // Given: one real issuer object, with only the executor result adversarially replaced.
  const f = await fixture([family]), runtime = await f.load(), p = first(runtime.runner.profiles ?? []);
  const spec = value(p.adapter.updateSpec(p.contract.installation, "update-only")); let calls = 0;
  const run = async () => { calls++; return { status: 0, signal: null }; };
  // When: the seam claims zero exit without any source-owned transition.
  const result = family === "cursor" ? await executeCursorUpdate(spec, { now: () => now, run })
    : await executeAgyUpdate(spec, { now: () => now, run });
  // Then: the issuer requires recovery, not fabricated success or a native restart.
  expect(result).toEqual({ ok: false, error: { code: "recovery_required" } }); expect(calls).toBe(1);
  expect(family === "cursor" ? getCursorUpdateIntent({ ...spec }).ok : getAgyUpdateIntent({ ...spec }).ok).toBe(false);
  expect(() => p.observeAfter()).toThrow();
  expect(p.adapter.updateSpec(p.contract.installation, "update-only").ok).toBe(false);
}, 60_000);
