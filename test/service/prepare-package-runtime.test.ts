import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PackagePrefixSnapshot } from "../../src/adapters/package-update";
import { createPackageUpdateSpec, executePackageUpdate, qualifyPackageUpdate } from "../../src/adapters/package-update";
import type { Job, ServiceRequest } from "../../src/protocol";
import { isServiceResponse } from "../../src/service/client";
import { createDomain } from "../../src/service/domain";
import { createUpdateOnlyJobRunner } from "../../src/service/job-runner";
import { loadPackageRuntime, PACKAGE_OPERATING_RUNTIME_PROFILE, PACKAGE_RUNTIME_PROFILE,
  validatePackageRuntimeInputs } from "../../src/service/package-runtime";
import { prepareNpmInstallationRuntime } from "../../src/service/prepare-package-runtime";
import { requestPrivateSocket } from "../../src/service/socket";
import { serveWorker } from "../../src/service/worker";

const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const node = realpathSync("/Users/beomseok/.nvm/versions/node/v24.20.0/bin/node");
const tools = realpathSync(mkdtempSync(join(tmpdir(), "prepare-original-npm-")));
const npm = join(tools, "package/bin/npm-cli.js");
beforeAll(async () => {
  // Exact official original npm, not a filtered copy of a configured manager.
  // The installed nvm npm has .npmrc; npm-global has generated .bin symlinks.
  // The config is outside this producer's no-config-read policy; the symlinks
  // are outside the existing issuer's regular-file-only manager contract.
  const response = await fetch("https://registry.npmjs.org/npm/-/npm-11.19.0.tgz", {
    credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) throw new TypeError(`official npm HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== "sha512-SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw==")
    throw new TypeError("official npm integrity mismatch");
  await new Bun.Archive(bytes).extract(tools);
}, 60_000);
afterAll(() => rmSync(tools, { recursive: true, force: true }));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function mkdir(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }
function put(path: string, bytes: string | Uint8Array, mode = 0o600): void {
  mkdir(dirname(path)); writeFileSync(path, bytes, { mode }); chmodSync(path, mode);
}
function snapshot(root: string, opaquePath?: string): PackagePrefixSnapshot {
  const files: { path: string; sha256: string; mode: number }[] = [], links: { path: string; target: string }[] = [];
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry), local = path.slice(root.length + 1), stat = lstatSync(path);
      if (path === opaquePath) continue;
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isSymbolicLink()) links.push({ path: local, target: readlinkSync(path) });
      else files.push({ path: local, sha256: hash(readFileSync(path)), mode: stat.mode & 0o777 });
    }
  }
  const stat = opaquePath ? lstatSync(opaquePath, { bigint: true }) : undefined;
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), links: links.sort((a, b) => a.path.localeCompare(b.path)),
    ...(opaquePath && stat ? { opaque: [{ path: opaquePath, dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid),
      nlink: String(stat.nlink), mode: Number(stat.mode & 0o7777n), size: String(stat.size),
      mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }] } : {}) };
}
/** Real selected original npm, controlled package bytes. No vendor acquisition
 * claim, simulated manager, historical QA input or operating installation. */
async function fixture(opaqueManager = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prepare-npm-"))); roots.push(root);
  const prefix = join(root, "installed"), directory = join(root, "prepare"), home = join(root, "seed-home");
  const ownerDirectory = join(root, "worker"), socketDirectory = ownerDirectory;
  for (const path of [prefix, directory, home, ownerDirectory, socketDirectory]) mkdir(path);
  chmodSync(prefix, 0o755);
  const packageName = "@openai/codex", platform = `${packageName}-darwin-${process.arch}`;
  const oldManifest = { name: packageName, version: "1.0.0", bin: { codex: "bin/codex.js" } };
  const oldBytes = await new Bun.Archive({ "package/package.json": JSON.stringify(oldManifest),
    "package/bin/codex.js": '#!/usr/bin/env node\nconsole.log("controlled-before");\n' }, { compress: "gzip" }).bytes();
  const oldArchive = join(root, "old.tgz"); put(oldArchive, oldBytes);
  const userconfig = join(root, "user.npmrc"), globalconfig = join(root, "global.npmrc");
  put(userconfig, ""); put(globalconfig, "");
  const child = Bun.spawn([node, npm, "install", "--global", "--prefix", prefix, oldArchive,
    "--cache", join(root, "seed-cache"), "--userconfig", userconfig, "--globalconfig", globalconfig,
    "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: root, env: { HOME: home, PATH: `${dirname(npm)}:${dirname(node)}` }, stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new TypeError(`original seed npm ${status}: ${stdout} ${stderr}`);
  put(join(prefix, "lib/node_modules/neighbor/package.json"), JSON.stringify({ name: "neighbor", version: "1.0.0", bin: { neighbor: "cli.js" } }), 0o644);
  put(join(prefix, "lib/node_modules/neighbor/cli.js"), "#!/usr/bin/env node\n", 0o751);
  symlinkSync("../lib/node_modules/neighbor/cli.js", join(prefix, "bin/neighbor"));
  const managerRoot = join(prefix, "lib/node_modules/npm"), opaquePath = opaqueManager ? join(managerRoot, ".npmrc") : undefined;
  if (opaquePath) {
    cpSync(dirname(dirname(npm)), managerRoot, { recursive: true, verbatimSymlinks: true });
    // Controlled config, never read: these values would break the calibration
    // if npm loaded its root project file as user/global/builtin config.
    put(opaquePath, "registry=https://not-authorized.invalid\nprefix=/not-authorized\nscript-shell=/not-authorized\n", 0o644);
  }
  const sources = new Map<string, Uint8Array>();
  const manifest = { name: packageName, version: "1.1.0", bin: { codex: "bin/codex.js" },
    optionalDependencies: { [platform]: `npm:${packageName}@1.1.0-darwin-${process.arch}` } };
  const platformManifest = { name: packageName, version: `1.1.0-darwin-${process.arch}`, os: ["darwin"], cpu: [process.arch] };
  let metadata: Record<string, unknown> | undefined;
  for (const pkg of [manifest, platformManifest]) {
    const bytes = await new Bun.Archive({ "package/package.json": JSON.stringify(pkg),
      ...(pkg === manifest ? { "package/bin/codex.js": '#!/usr/bin/env node\nconsole.log("controlled-after");\n' }
        : { "package/vendor/payload": "controlled native payload, never invoked\n" }) }, { compress: "gzip" }).bytes();
    const tarball = `https://registry.npmjs.org/${packageName}/-/codex-${pkg.version}.tgz`;
    const row = { ...pkg, dist: { tarball, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } };
    sources.set(tarball, bytes);
    sources.set(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${pkg.version}`, Buffer.from(JSON.stringify(row)));
    if (pkg === manifest) metadata = row;
  }
  if (!metadata) throw new TypeError("fixture metadata");
  const latest = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
  sources.set(latest, Buffer.from(JSON.stringify(metadata)));
  sources.set(`https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`, Buffer.from('{"latest":"1.1.0"}'));
  sources.set("https://api.github.com/repos/openai/codex/releases/latest", Buffer.from('{"tag_name":"rust-v1.1.0","draft":false,"prerelease":false}'));
  const socket = join(socketDirectory, "registered.sock"), server = createServer(peer => peer.end());
  const listening = once(server, "listening"); server.listen(socket); await listening;
  chmodSync(socket, 0o600);
  cleanups.push(async () => { const closed = once(server, "close"); server.close(); await closed; });
  const options = { directory, prefix, executable: join(prefix, "bin/codex"), npm: opaquePath ? join(managerRoot, "bin/npm-cli.js") : npm, node,
    ownerDirectory, socketDirectory, registeredSockets: [socket], rootPids: [process.pid] };
  const request = async (request: Request) => {
    request.signal.throwIfAborted();
    const body = sources.get(request.url);
    if (!body) throw new TypeError(`unexpected acquisition ${request.url}`);
    return new Response(body);
  };
  return { root, options, sources, request, latest, metadata, opaquePath };
}

test.each([false, true])("prepares a whole original npm prefix and completes its real update-only job (opaque: %s)", async opaque => {
  // Given: a 0755 prefix with a real npm-installed controlled Codex and an
  // unrelated package, plus live worker/socket coverage outside that prefix.
  const f = await fixture(opaque), before = snapshot(f.options.prefix, f.opaquePath);
  const opens = spyOn(fs, "openSync"), reads = spyOn(fs, "readFileSync");
  cleanups.push(async () => { opens.mockRestore(); reads.mockRestore(); });
  rmSync(f.options.ownerDirectory, { recursive: true });
  let domain: ReturnType<typeof createDomain> | undefined;
  const worker = serveWorker(f.options.ownerDirectory, (request, signal) => {
    if (!domain) throw new TypeError("domain not ready");
    return domain.handle(request, signal);
  }, async () => { await domain?.close(); });
  cleanups.push(async () => { await worker.stop(); });
  // When: the product producer calibrates independent clones, then the existing
  // runtime/worker/job engine consumes the returned data without test executors.
  const prepared = await prepareNpmInstallationRuntime({ ...f.options,
    registeredSockets: [worker.owner.socketPath, worker.owner.controlPath] }, { request: f.request });
  expect(snapshot(f.options.prefix, f.opaquePath)).toEqual(before);
  expect(prepared.inputs.profile).toBe(PACKAGE_OPERATING_RUNTIME_PROFILE);
  const loaded = await loadPackageRuntime({ directory: f.options.ownerDirectory, coreSocket: "" },
    prepared.configurationPin, prepared.inputs, f.request);
  if (loaded.kind !== "configured") throw new TypeError(`runtime ${JSON.stringify(loaded)}`);
  const profile = loaded.runner.profiles?.[0], q = prepared.inputs.profiles[0]?.update.qualification;
  if (!profile || !q) throw new TypeError("missing profile");
  if (f.opaquePath) {
    expect(q.before.opaque).toEqual(before.opaque);
    expect(q.after.opaque).toEqual(before.opaque);
    expect(q.manager.files.some(pin => pin.path === f.opaquePath)).toBe(false);
    for (const label of ["calibration-a", "calibration-b"])
      expect(lstatSync(join(f.options.directory, label, "prefix/lib/node_modules/npm/.npmrc"), { throwIfNoEntry: false })).toBeUndefined();
  }
  const completed = Promise.withResolvers<Job>(), timeout = AbortSignal.timeout(30_000);
  const onTimeout = () => completed.reject(new TypeError("job terminal timeout"));
  timeout.addEventListener("abort", onTimeout, { once: true });
  const publication = {
    get sequence() { return worker.transport.sequence; },
    admit(response: Parameters<typeof worker.transport.publish>[0]) {
      if (!worker.transport.canPublish(response)) throw new TypeError("publication rejected");
      return null;
    },
    publish(response: Parameters<typeof worker.transport.publish>[0]) {
      worker.transport.publish(response);
      if (response.ok && response.operation === "inspect-job"
        && (response.result.job.status === "completed" || response.result.job.status === "failed"
          || response.result.job.installTxn.state === "recovery_required")) completed.resolve(response.result.job);
    },
  };
  domain = createDomain(f.options.ownerDirectory, loaded.readers, publication, store => createUpdateOnlyJobRunner({
    ...loaded.runner, store, owner: worker.owner, publication,
  }));
  const token = readFileSync(worker.owner.tokenPath, "utf8");
  async function request(input: ServiceRequest) {
    const response = await requestPrivateSocket(worker.owner, input);
    if (!isServiceResponse(response)) throw new TypeError("wire response");
    return response;
  }
  try {
    const installation = profile.contract.installation;
    expect(await request({ version: 1, token, requestId: "select", operation: "targets", installationId: installation.installationId }))
      .toMatchObject({ ok: true, result: { targets: [], selection: { update: { kind: "supported" } } } });
    expect(await request({ version: 1, token, requestId: "update", operation: "create-job", mode: "update-only", selectedTargets: [],
      installation: { installationId: installation.installationId, owner: installation.owner,
        resourcesFingerprint: installation.resourcesFingerprint, installedVersion: installation.installedVersion } }))
      .toMatchObject({ ok: true, result: { kind: "created" } });
    const job = await completed.promise;
    // Then: exact before remains until the user-like job trigger; after is the
    // independently observed full inventory, including neighbor bytes/modes/links.
    expect(job.status).toBe("completed");
    expect(job.installTxn.state).toBe("succeeded");
    expect(job.targetTxns).toEqual([]);
    expect(snapshot(f.options.prefix, f.opaquePath)).toEqual(q.after);
    expect(profile.observeAfter()).toEqual(profile.expectedAfter);
    expect(readFileSync(join(f.options.prefix, "lib/node_modules/neighbor/cli.js"), "utf8")).toBe("#!/usr/bin/env node\n");
    expect(lstatSync(f.options.prefix).mode & 0o777).toBe(0o755);
    if (f.opaquePath) {
      expect(opens.mock.calls.some(args => args[0] === f.opaquePath)).toBe(false);
      expect(reads.mock.calls.some(args => args[0] === f.opaquePath)).toBe(false);
      // After real consumption, only metadata changes: the runtime must reject
      // an otherwise exact after inventory without ever opening the config.
      const info = lstatSync(f.opaquePath);
      utimesSync(f.opaquePath, info.atime, new Date(info.mtimeMs + 1000));
      expect(() => profile.observeAfter()).toThrow();
    }
  } finally {
    timeout.removeEventListener("abort", onTimeout);
    await worker.stop();
  }
}, 120_000);

test("rejects opaque metadata drift at the last dispatch and never invokes npm", async () => {
  // Given: real original manager calibration with an untouched root config.
  const f = await fixture(true), prepared = await prepareNpmInstallationRuntime(f.options, { request: f.request });
  const update = prepared.inputs.profiles[0]?.update;
  if (!update || !f.opaquePath) throw new TypeError("opaque fixture");
  const opaquePath = f.opaquePath;
  const qualified = await qualifyPackageUpdate(update, Date.now());
  if (!qualified.ok) throw new TypeError("qualification");
  const spec = createPackageUpdateSpec(qualified.value, "update-only", Date.now());
  if (!spec.ok) throw new TypeError("spec");
  let runs = 0;
  // When: a changed nanosecond stat is observed at the final dispatch fence.
  const result = await executePackageUpdate(spec.value, { now: Date.now, run: async () => {
    runs++; return { status: 0, signal: null };
  }, event: async event => {
    if (event.kind === "dispatch") {
      const info = lstatSync(opaquePath);
      utimesSync(opaquePath, info.atime, new Date(info.mtimeMs + 1000));
    }
  } });
  // Then: no child starts, and stale metadata cannot be requalified.
  expect(runs).toBe(0);
  expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
  expect((await qualifyPackageUpdate(update, Date.now())).ok).toBe(false);
}, 120_000);

test("calibration and static consumer jails deny reading the exact opaque source config", async () => {
  // Given: a real original npm root selected from a disposable prefix.
  const f = await fixture(true), prepared = await prepareNpmInstallationRuntime(f.options, { request: f.request });
  const update = prepared.inputs.profiles[0]?.update;
  if (!update || !f.opaquePath) throw new TypeError("opaque fixture");
  const script = `const fs=require('node:fs');try{fs.readFileSync(${JSON.stringify(f.opaquePath)});process.exitCode=2}
catch(e){if(e.code!=='EPERM'&&e.code!=='EACCES')throw e;console.log('READ_DENIED')}`;
  const qualified = await qualifyPackageUpdate(update, Date.now());
  if (!qualified.ok) throw new TypeError("qualification");
  const spec = createPackageUpdateSpec(qualified.value, "update-only", Date.now());
  if (!spec.ok) throw new TypeError("spec");
  const statuses: number[] = [], outputs: string[] = [];
  // When: real child read probes run under the emitted calibration policies
  // and the actual static consumer policy, not an independently invented jail.
  async function probe(policy: string, cwd: string, env: Readonly<Record<string, string>>) {
    const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", policy, node, "-e", script],
      { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    statuses.push(status); outputs.push(stdout.trim() || stderr);
  }
  for (const label of ["calibration-a", "calibration-b"])
    await probe(readFileSync(join(f.options.directory, label, "sandbox.sb"), "utf8"),
      join(f.options.directory, label), update.qualification.env);
  await executePackageUpdate(spec.value, { now: Date.now, run: async command => {
    const policy = command.args[1];
    if (command.executable !== "/usr/bin/sandbox-exec" || command.args[0] !== "-p" || !policy)
      throw new TypeError("static sandbox missing");
    await probe(policy, command.cwd, command.env);
    return { status: 1, signal: null };
  } });
  // Then: all three deny the data read while retaining ordinary metadata access.
  expect(statuses).toEqual([0, 0, 0]);
  expect(outputs).toEqual(["READ_DENIED", "READ_DENIED", "READ_DENIED"]);
}, 120_000);

test.each(["mode", "symlink", "hardlink"] as const)("refuses unsafe opaque source %s without content reads", async defect => {
  // Given
  const f = await fixture(true), config = f.opaquePath;
  if (!config) throw new TypeError("opaque fixture");
  if (defect === "mode") chmodSync(config, 0o664);
  if (defect === "hardlink") linkSync(config, join(f.root, "linked-config"));
  if (defect === "symlink") {
    unlinkSync(config); put(join(f.root, "other-config"), "unread controlled config");
    symlinkSync(join(f.root, "other-config"), config);
  }
  const reads = spyOn(fs, "readFileSync"), opens = spyOn(fs, "openSync");
  try {
    // When / Then
    await expect(prepareNpmInstallationRuntime(f.options, { request: f.request })).rejects.toThrow();
    expect(reads.mock.calls.some(args => args[0] === config)).toBe(false);
    expect(opens.mock.calls.some(args => args[0] === config)).toBe(false);
    expect(readdirSync(f.options.directory)).toEqual([]);
  } finally { reads.mockRestore(); opens.mockRestore(); }
});

test("opaque markers cannot admit foreign config paths or the private profile", async () => {
  // Given
  const f = await fixture(true), prepared = await prepareNpmInstallationRuntime(f.options, { request: f.request });
  const profile = prepared.inputs.profiles[0], row = profile?.update.qualification.before.opaque?.[0];
  if (!profile || !row) throw new TypeError("opaque fixture");
  const config = join(f.options.prefix, "lib/node_modules/neighbor/.npmrc");
  put(config, "unread controlled config"); chmodSync(config, 0);
  // When / Then: matching before/after rows do not grant arbitrary skip authority.
  const q = profile.update.qualification, forged = { ...row, path: config };
  const qualification = { ...q, before: { ...q.before, opaque: [forged] }, after: { ...q.after, opaque: [forged] } };
  const inputs = { ...prepared.inputs, profiles: [{ ...profile, update: { ...profile.update, qualification } }] };
  expect(() => validatePackageRuntimeInputs(inputs)).toThrow();
  expect(() => validatePackageRuntimeInputs({ ...prepared.inputs, profile: PACKAGE_RUNTIME_PROFILE })).toThrow();
  const receipt = join(f.root, "forged.json");
  put(receipt, JSON.stringify(qualification));
  expect((await qualifyPackageUpdate({ qualification, receipt: { path: receipt, sha256: hash(JSON.stringify(qualification)) } }, Date.now())).ok).toBe(false);
}, 120_000);

test("refuses a foreign nested config even with an admitted manager root config", async () => {
  // Given
  const f = await fixture(true);
  put(join(f.options.prefix, "lib/node_modules/neighbor/.npmrc"), "unread controlled config", 0);
  let requests = 0;
  // When / Then
  await expect(prepareNpmInstallationRuntime(f.options, { request: async () => {
    requests++; throw new TypeError("unexpected acquisition");
  } })).rejects.toThrow("configuration:");
  expect(requests).toBe(0);
  expect(readdirSync(f.options.directory)).toEqual([]);
});
test("refuses an operating-style shim before network, copying, or npm", async () => {
  // Given
  const f = await fixture();
  unlinkSync(f.options.executable); put(f.options.executable, "#!/bin/sh\nexit 0\n", 0o755);
  const before = snapshot(f.options.prefix);
  let requests = 0;
  // When / Then
  await expect(prepareNpmInstallationRuntime(f.options, { request: async () => { requests++; throw new TypeError("unexpected"); } }))
    .rejects.toThrow("wrappers unsupported");
  expect(requests).toBe(0);
  expect(snapshot(f.options.prefix)).toEqual(before);
  expect(readdirSync(f.options.directory)).toEqual([]);
});

test("refuses prefix config without reading or copying its contents", async () => {
  // Given
  const f = await fixture(), config = join(f.options.prefix, ".npmrc");
  put(config, "unread test config"); chmodSync(config, 0);
  // When / Then: configuration, not a read-permission failure, is the reason.
  await expect(prepareNpmInstallationRuntime(f.options, { request: f.request })).rejects.toThrow("configuration:");
  expect(readdirSync(f.options.directory)).toEqual([]);
});

test("refuses absolute prefix links rather than rebasing their targets", async () => {
  // Given
  const f = await fixture();
  symlinkSync(join(f.options.prefix, "lib/node_modules/neighbor/cli.js"), join(f.options.prefix, "bin/absolute-neighbor"));
  // When / Then
  await expect(prepareNpmInstallationRuntime(f.options, { request: f.request })).rejects.toThrow("nonportable link");
  expect(readdirSync(f.options.directory)).toEqual([]);
});

test("rejects target integrity mismatch before invoking the original manager", async () => {
  // Given
  const f = await fixture(), before = snapshot(f.options.prefix);
  const archive = [...f.sources.keys()].find(url => url.endsWith("/codex-1.1.0.tgz"));
  if (!archive) throw new TypeError("target archive");
  f.sources.set(archive, Buffer.from("corrupted"));
  // When / Then
  await expect(prepareNpmInstallationRuntime(f.options, { request: f.request })).rejects.toThrow("archive integrity mismatch");
  expect(snapshot(f.options.prefix)).toEqual(before);
  expect(readdirSync(f.options.directory)).not.toContain("calibration-a");
});

test("rejects lifecycle hooks rather than projecting machine-specific output", async () => {
  // Given
  const f = await fixture(), before = snapshot(f.options.prefix);
  f.sources.set(f.latest, Buffer.from(JSON.stringify({ ...f.metadata, scripts: { postinstall: "node write-absolute-path.js" } })));
  // When / Then
  await expect(prepareNpmInstallationRuntime(f.options, { request: f.request })).rejects.toThrow("lifecycle:");
  expect(snapshot(f.options.prefix)).toEqual(before);
  expect(readdirSync(f.options.directory)).not.toContain("calibration-a");
});

test("rejects an operating prefix changed after the initial whole-prefix observation", async () => {
  // Given
  const f = await fixture();
  let changed = false;
  const request = async (request: Request) => {
    if (!changed) { changed = true; put(join(f.options.prefix, "lib/node_modules/neighbor/extra.txt"), "external change"); }
    return f.request(request);
  };
  // When / Then
  await expect(prepareNpmInstallationRuntime(f.options, { request })).rejects.toMatchObject({ reason: "source_changed" });
  expect(lstatSync(join(f.options.directory, "package-runtime.json"), { throwIfNoEntry: false })).toBeUndefined();
  expect(readFileSync(join(f.options.prefix, "lib/node_modules/neighbor/extra.txt"), "utf8")).toBe("external change");
});
