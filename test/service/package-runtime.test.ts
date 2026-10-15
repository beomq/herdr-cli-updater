import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, closeSync, cpSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync,
  readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { PackagePrefixSnapshot, PackageUpdateQualification } from "../../src/adapters/package-update";
import type { AdapterResult, InstallationIdentity } from "../../src/adapters/types";
import { getPrivateUpdateIntent } from "../../src/adapters/update-context";
import { discoverExecutable } from "../../src/discovery";
import { evaluateResourceGate, parseResourcePlan } from "../../src/install/resources";
import { consumePrivateUpdate } from "../../src/install/update";
import { loadPackageRuntime, PACKAGE_RUNTIME_PROFILE, validatePackageRuntimeInputs } from "../../src/service/package-runtime";
import type { PackageRuntimeInputs } from "../../src/service/package-runtime";
import type { PluginRuntimeLoad } from "../../src/service/plugin-runtime";
import { createUpdateOnlyJobRunner } from "../../src/service/job-runner";
import { createDomain } from "../../src/service/domain";
import { serveWorker } from "../../src/service/worker";
import { requestPrivateSocket } from "../../src/service/socket";
import { isServiceResponse } from "../../src/service/client";
import type { Job, ServiceRequest } from "../../src/protocol";
import { createCheckRuntime } from "../../src/service/check-runtime";
import { createCheckStore } from "../../src/service/check-store";
import type { CheckStoreEntry } from "../../src/service/check-store";

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
function snapshot(prefix: string): PackagePrefixSnapshot {
  const files: { path: string; sha256: string; mode: number }[] = [], links: { path: string; target: string }[] = [];
  const pending = [prefix];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), local = path.slice(prefix.length + 1), info = lstatSync(path);
      if (info.isDirectory()) pending.push(path);
      else if (info.isSymbolicLink()) links.push({ path: local, target: readlinkSync(path) });
      else files.push({ path: local, sha256: hash(readFileSync(path)), mode: info.mode & 0o777 });
    }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), links: links.sort((a, b) => a.path.localeCompare(b.path)) };
}
async function socket(path: string) {
  const server = createServer(peer => peer.end());
  const listening = once(server, "listening"); server.listen(path); await listening;
  chmodSync(path, 0o600);
  cleanups.push(async () => { const closed = once(server, "close"); server.close(); await closed; });
}
/** Real Bun calibration of controlled packages, NOT genuine vendor acquisition,
 * native completion proof, or evidence about an operating user's installation.
 */
async function fixture(twoHopAlias = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "package-runtime-"))); roots.push(root);
  const prefix = join(root, "prefix"), home = join(root, "home"), directory = join(root, "worker"), sockets = join(root, "sockets");
  for (const path of [prefix, home, directory, sockets]) mkdirSync(path, { mode: 0o700 });
  const packageName = "@oh-my-pi/pi-coding-agent", family = "omp", channel = "stable", manager = realpathSync(process.execPath);
  const env = { HOME: home, PATH: dirname(manager), BUN_INSTALL: prefix };
  const packages = new Map<string, { manifest: { name: string; version: string; bin: { omp: string } }; bytes: Uint8Array; integrity: string }>();
  for (const version of ["1.0.0", "1.1.0"]) {
    const manifest = { name: packageName, version, bin: { omp: "cli.js" } };
    const bytes = await new Bun.Archive({ "package/package.json": JSON.stringify(manifest),
      "package/cli.js": `#!/usr/bin/env bun\nconsole.log("${version}");\n` }, { compress: "gzip" }).bytes();
    packages.set(version, { manifest, bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` });
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), row = packages.get(url.pathname.slice(1));
    if (row) return new Response(row.bytes);
    return Response.json({ name: packageName, versions: Object.fromEntries([...packages].map(([version, row]) =>
      [version, { ...row.manifest, dist: { integrity: row.integrity, tarball: `${url.origin}/${version}` } }])),
    "dist-tags": { latest: "1.1.0" } });
  } });
  async function original(version: string) {
    const child = Bun.spawn([manager, "add", "--global", `${packageName}@${version}`, "--registry", server.url.href,
      "--cache-dir", join(home, `original-cache-${version}`), "--force", "--linker", "hoisted"],
    { cwd: prefix, env, stdout: "pipe", stderr: "pipe" });
    const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (status !== 0) throw new TypeError(`original_manager_${status}: ${out} ${err}`);
    const lockPath = join(prefix, "install/global/bun.lock");
    const parsed: unknown = Bun.JSON5.parse(readFileSync(lockPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("packages" in parsed)
      || typeof parsed.packages !== "object" || parsed.packages === null) throw new TypeError("fixture_lock");
    for (const row of Object.values(parsed.packages)) {
      if (!Array.isArray(row)) throw new TypeError("fixture_lock_row");
      row[1] = `https://registry.npmjs.org/${packageName}/-/package-${version}.tgz`;
    }
    put(lockPath, `${JSON.stringify(parsed, null, 2)}\n`, 0o644);
    if (twoHopAlias) {
      const alias = join(prefix, "bin/omp"), hop = join(prefix, "bin/omp-hop");
      const target = readlinkSync(alias);
      if (lstatSync(hop, { throwIfNoEntry: false })) unlinkSync(hop);
      symlinkSync(target, hop); unlinkSync(alias); symlinkSync("omp-hop", alias);
    }
  }
  const executable = join(prefix, "install/global/node_modules", packageName, "cli.js");
  const manifest = join(dirname(executable), "package.json"), owner = { kind: "package", manager: "bun", prefix, packageName } as const;
  let before: InstallationIdentity, beforePrefix: PackagePrefixSnapshot, afterPrefix: PackagePrefixSnapshot;
  let afterLock: { path: string; sha256: string };
  const discoveryPath = join(prefix, "discovery.json");
  try {
    await original("1.0.0");
    const receipt = { family, executable, channel, owner, packageManifest: manifest,
      resources: snapshot(prefix).files.map(file => ({ path: join(prefix, file.path), sha256: file.sha256 })) };
    const provenance = put(discoveryPath, JSON.stringify(receipt));
    const discovered = await discoverExecutable({ executable, family, provenance: [provenance] });
    if (!discovered.ok || discovered.value.qualification.kind !== "known") throw new TypeError("fixture_discovery");
    before = discovered.value.installation; beforePrefix = snapshot(prefix);
    cpSync(prefix, join(root, "saved"), { recursive: true, verbatimSymlinks: true });
    await original("1.1.0");
    afterPrefix = snapshot(prefix);
    afterLock = put(join(root, "after.lock"), readFileSync(join(prefix, "install/global/bun.lock")));
    rmSync(prefix, { recursive: true });
    cpSync(join(root, "saved"), prefix, { recursive: true, verbatimSymlinks: true });
  } finally { await server.stop(true); }
  const target = packages.get("1.1.0");
  if (!target) throw new TypeError("fixture_target");
  const metadata = put(join(root, "metadata.json"), JSON.stringify({ ...target.manifest, dist: { integrity: target.integrity,
    tarball: `https://registry.npmjs.org/${packageName}/-/package-1.1.0.tgz` } }));
  const artifact = { name: packageName, installName: packageName, version: "1.1.0",
    archive: put(join(root, "target.tgz"), target.bytes), metadata };
  const now = Date.now();
  const qualification: PackageUpdateQualification = { installation: before,
    manager: { name: "bun", path: manager, sha256: hash(readFileSync(manager)), files: [] }, env,
    target: { packageName, version: "1.1.0", channel, checkedAt: now, expiresAt: now + 300_000, artifacts: [artifact], postinstall: [] },
    before: beforePrefix, after: afterPrefix, afterLock };
  const resources = before.resources.map(row => {
    const after = afterPrefix.files.find(file => join(prefix, file.path) === row.realpath);
    if (!after) throw new TypeError("fixture_after_resource");
    return { ...row, fingerprint: `sha256:${after.sha256}` };
  });
  const after: InstallationIdentity = { ...before, installedVersion: { kind: "known", version: "1.1.0" },
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  const coreSocket = join(sockets, "registered.sock"); await socket(coreSocket);
  const input: PackageRuntimeInputs = { schemaVersion: 1, profile: PACKAGE_RUNTIME_PROFILE, ownerDirectory: directory, profiles: [{
    update: { qualification, receipt: put(join(root, "qualification.json"), JSON.stringify(qualification)) },
    sourcePins: [{ path: discoveryPath, sha256: hash(readFileSync(discoveryPath)) }],
    expectedAfterPin: put(join(root, "after.json"), JSON.stringify(after)),
    acquiredReplies: [{ url: `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, status: 200, body: metadata },
      { url: `https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`, status: 200,
        body: put(join(root, "tags.json"), JSON.stringify({ latest: "1.1.0" })) }],
    coverage: { root, prefix, socketDirectory: sockets, registeredSockets: [coreSocket], rootPids: [process.pid] },
  }] };
  const configPath = join(root, "runtime.json"), context = { directory, coreSocket: "" };
  const p = input.profiles[0]; if (!p) throw new TypeError("fixture_profile");
  async function load(data: unknown = input): Promise<PluginRuntimeLoad> {
    const pin = put(configPath, JSON.stringify(data));
    const result = await loadPackageRuntime(context, pin, data, async request => {
      request.signal.throwIfAborted();
      const profiles = typeof data === "object" && data !== null && "profiles" in data && Array.isArray(data.profiles)
        ? data.profiles : [];
      const replies: PackageRuntimeInputs["profiles"][number]["acquiredReplies"][number][] =
        profiles.flatMap(row => typeof row === "object" && row !== null && "acquiredReplies" in row && Array.isArray(row.acquiredReplies)
          ? row.acquiredReplies : []);
      const reply = replies.find(row => row.url === request.url);
      if (!reply) throw new TypeError("fixture_reply_missing");
      return new Response(readFileSync(reply.body.path));
    });
    if (result.kind === "configured") cleanups.push(async () => { result.runner.queue.close(); });
    return result;
  }
  return { root, prefix, home, directory, sockets, input, p, before, after, load, configPath, artifact, context };
}
function configured(result: PluginRuntimeLoad) {
  if (result.kind !== "configured") throw new TypeError(JSON.stringify(result));
  const profile = result.runner.profiles?.[0]; if (!profile) throw new TypeError("fixture_profile_missing");
  const spec = value(profile.adapter.updateSpec(profile.contract.installation, "update-only"));
  const plan = value(parseResourcePlan({ contract: profile.contract, mode: "update-only", selectedTargets: [],
    installerDigest: hash("controlled_installer"), mutationResources: spec.mutationResources,
    transition: { expectedAfter: profile.expectedAfter, mutationRoots: profile.mutationRoots } }));
  return { result, profile, plan };
}

test("records final package check time after all acquired response times", async () => {
  // Given: a deterministic increasing wall clock, real source files and real store.
  const f = await fixture(), store = createCheckStore(f.directory), entries: CheckStoreEntry[] = [];
  let timestamp = f.p.update.qualification.target.checkedAt;
  const source = { installation: f.before, packageManifest: join(dirname(f.before.executableRealpath), "package.json"),
    engineManifest: null,
    pins: f.before.resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7), mode: lstatSync(row.realpath).mode & 0o7777 })),
    aliases: f.p.update.qualification.before.links.map(link => ({ path: join(f.prefix, link.path), target: realpathSync(join(f.prefix, link.path)) })) };
  const checker = createCheckRuntime({ clock: { now: () => timestamp++, monotonic: () => performance.now() },
    store: { get: store.get, put: async entry => { entries.push(entry); return store.put(entry); } },
    admit: async () => {
      const result = await discoverExecutable({ executable: f.before.executableRealpath, family: "omp", provenance: f.p.sourcePins });
      return result.ok && result.value.qualification.kind === "known"
        ? { ok: true, value: null } : { ok: false, error: { code: "stale_selection" } };
    },
    request: async request => {
      const reply = f.p.acquiredReplies.find(row => row.url === request.url);
      if (!reply) throw new TypeError("fixture_reply_missing");
      return new Response(readFileSync(reply.body.path));
    } });
  // When: timestamps advance by calls, never sleeps or scheduling luck.
  const result = await checker.check(source);
  // Then: a fully acquired check must be acceptable to the real store's ordering guard.
  const entry = entries[0]; if (!entry) throw new TypeError("fixture_check_not_committed");
  expect(entry.checkedAt).toBeGreaterThanOrEqual(Math.max(...entry.metadata.map(row => row.acquiredAt)));
  expect(result).toMatchObject({ ok: true, value: { kind: "update-available", availableVersion: "1.1.0" } });
});

test("qualifies a native-free product through the common checker and authentic private issuer", async () => {
  // Given: independently calibrated controlled package, no native endpoint.
  const f = await fixture(), { profile, result } = configured(await f.load());
  const before = snapshot(f.prefix);
  // When: product observation and update specification use the real data boundary.
  const observed = await result.readers.candidates[0]?.read();
  const spec = value(profile.adapter.updateSpec(f.before, "update-only"));
  // Then: runtime identity and native abilities are not fabricated.
  expect(observed).toMatchObject({ ok: true, value: { contract: { runtime: null,
    capabilities: { update: { kind: "supported" }, busySafe: { kind: "unsupported" }, completion: { kind: "unsupported" },
      resume: { kind: "unsupported" }, gracefulExit: { kind: "unsupported" } } },
  lastCheck: { result: { kind: "update-available", availableVersion: "1.1.0" } } } });
  expect(result.runner.lifecycle).toBeUndefined();
  expect(value(getPrivateUpdateIntent(spec))).toMatchObject({ family: "omp", mode: "update-only" });
  expect(getPrivateUpdateIntent(structuredClone(spec))).toEqual({ ok: false, error: { code: "verification_failed" } });
  expect(snapshot(f.prefix)).toEqual(before);
});

test("rejects restart without native contact or installed-byte effects", async () => {
  // Given
  const f = await fixture(), { profile } = configured(await f.load()), before = snapshot(f.prefix);
  // When
  const result = profile.adapter.updateSpec(f.before, "update-and-restart");
  // Then
  expect(result).toEqual({ ok: false, error: { code: "unsupported" } });
  expect(snapshot(f.prefix)).toEqual(before);
});

test("accepts independently pinned two-hop original aliases without losing literal-link checks", async () => {
  const f = await fixture(true), { profile, plan } = configured(await f.load());
  expect(evaluateResourceGate(plan, profile.observe(plan))).toEqual({ ok: true, value: null });
  unlinkSync(join(f.prefix, "bin/omp")); symlinkSync("./omp-hop", join(f.prefix, "bin/omp"));
  expect(await profile.adapter.detect(f.before.executableRealpath)).toEqual({ ok: false, error: { code: "stale_selection" } });
});

test("observes actual after bytes and aliases after the controlled durable consumer", async () => {
  // Given: this is a mechanism regression, not an actual family-update acceptance.
  const f = await fixture(), { profile, plan, result: runtime } = configured(await f.load());
  expect(evaluateResourceGate(plan, profile.observe(plan))).toEqual({ ok: true, value: null });
  const spec = value(profile.adapter.updateSpec(f.before, "update-only"));
  // When
  const result = await consumePrivateUpdate(spec, { receiptRoot: f.directory, now: Date.now });
  // Then
  expect(result).toMatchObject({ ok: true, value: { kind: "files-verified", durableReceipt: true } });
  expect(profile.observeAfter()).toEqual(f.after);
  expect(await runtime.readers.candidates[0]?.read()).toMatchObject({ ok: true, value: {
    contract: { installation: f.after, capabilities: { update: { kind: "unsupported" } } }, lastCheck: null,
  } });
  unlinkSync(join(f.prefix, "bin/omp"));
  expect(() => profile.observeAfter()).toThrow();
}, 30_000);

test("runs authenticated product selection through service create, durable package consumption, and exact after observation", async () => {
  // Given: the socket/domain/runner are production implementations, packages controlled.
  const f = await fixture();
  rmSync(f.directory, { recursive: true });
  let domain: ReturnType<typeof createDomain> | undefined;
  const worker = serveWorker(f.directory, (request, signal) => {
    if (!domain) throw new TypeError("fixture_domain_not_ready");
    return domain.handle(request, signal);
  }, async () => { await domain?.close(); });
  cleanups.push(async () => { await worker.stop(); });
  const { result, profile } = configured(await f.load());
  const completed = Promise.withResolvers<Job>(), abort = AbortSignal.timeout(15_000);
  const timeout = () => completed.reject(new TypeError("fixture_terminal_timeout"));
  abort.addEventListener("abort", timeout, { once: true });
  const publication = {
    get sequence() { return worker.transport.sequence; },
    admit: (response: Parameters<typeof worker.transport.publish>[0]) => {
      if (!worker.transport.canPublish(response)) throw new TypeError("fixture_publication");
      return null;
    },
    publish: (response: Parameters<typeof worker.transport.publish>[0]) => {
      worker.transport.publish(response);
      if (response.ok && response.operation === "inspect-job"
        && (response.result.job.status === "completed" || response.result.job.status === "failed"
          || response.result.job.installTxn.state === "recovery_required"))
        completed.resolve(response.result.job);
    },
  };
  domain = createDomain(f.directory, result.readers, publication, store => createUpdateOnlyJobRunner({
    ...result.runner, store, owner: worker.owner, publication,
  }));
  const token = readFileSync(worker.owner.tokenPath, "utf8");
  async function request(input: ServiceRequest) {
    const response = await requestPrivateSocket(worker.owner, input);
    if (!isServiceResponse(response)) throw new TypeError("fixture_wire_response");
    return response;
  }
  try {
    const targets = await request({ version: 1, token, requestId: "select", operation: "targets", installationId: f.before.installationId });
    expect(targets).toMatchObject({ ok: true, result: { targets: [], selection: { update: { kind: "supported" } } } });
    // When: no internal executor callback or native lifecycle participates.
    const response = await request({ version: 1, token, requestId: "update", operation: "create-job", mode: "update-only", selectedTargets: [],
      installation: { installationId: f.before.installationId, owner: f.before.owner, resourcesFingerprint: f.before.resourcesFingerprint,
        installedVersion: f.before.installedVersion } });
    expect(response).toMatchObject({ ok: true, result: { kind: "created" } });
    const job = await completed.promise;
    // Then: durable completion follows independent after verification, not process exit.
    expect(job.status).toBe("completed");
    expect(job.installTxn.state).toBe("succeeded");
    expect(job.targetTxns).toEqual([]);
    expect(result.runner.queue.get(job.jobId).state).toBe("completed");
    expect(profile.observeAfter()).toEqual(f.after);
    expect(await request({ version: 1, token, requestId: "old-select", operation: "targets",
      installationId: f.before.installationId })).toMatchObject({ ok: true, result: {
        targets: [],
      } });
    expect(await request({ version: 1, token, requestId: "after-installations", operation: "installations" }))
      .toMatchObject({ ok: true, result: { installations: [{ installedVersion: f.after.installedVersion }] } });
  } finally {
    abort.removeEventListener("abort", timeout);
    await worker.stop();
  }
}, 30_000);

test("keeps read-only checks available when only mutation archive bytes drift", async () => {
  // Given
  const f = await fixture(), { profile, result } = configured(await f.load());
  // When
  put(f.artifact.archive.path, "corrupted archive");
  // Then
  expect((await result.readers.candidates[0]?.read())?.ok).toBe(true);
  expect(await profile.adapter.check(f.before)).toMatchObject({ ok: true, value: { kind: "update-available" } });
  expect(profile.adapter.updateSpec(f.before, "update-only").ok).toBe(false);
});

test.each(["source", "reply", "configuration", "executable"] as const)("rejects read and mutation authority after %s drift", async kind => {
  // Given
  const f = await fixture(), { profile, result } = configured(await f.load());
  const path = kind === "source" ? f.p.sourcePins[0]?.path : kind === "reply" ? f.p.acquiredReplies[0]?.body.path
    : kind === "configuration" ? f.configPath : f.before.executableRealpath;
  if (!path) throw new TypeError("fixture_drift_path");
  // When
  put(path, `${readFileSync(path, "utf8")}\n`);
  // Then
  expect(await result.readers.candidates[0]?.read()).toEqual({ ok: false, error: { code: "stale_selection" } });
  expect(profile.adapter.updateSpec(f.before, "update-only").ok).toBe(false);
});

test("blocks a live prefix consumer despite known process ancestry", async () => {
  // Given
  const f = await fixture(), { profile, plan } = configured(await f.load());
  const fd = openSync(f.before.executableRealpath, "r");
  try {
    // When
    const observed = profile.observe(plan);
    const result = evaluateResourceGate(plan, observed);
    // Then
    expect(result.ok).toBe(false);
    expect(observed).toMatchObject({ consumers: [expect.objectContaining({ state: "running",
      consumerId: expect.stringMatching(new RegExp(`^${process.pid}:`)) })] });
  } finally { closeSync(fd); }
});

test("blocks an unregistered socket in the actual private census", async () => {
  // Given
  const f = await fixture(), { profile, plan } = configured(await f.load());
  await socket(join(f.sockets, "foreign.sock"));
  // When
  const result = evaluateResourceGate(plan, profile.observe(plan));
  // Then
  expect(result).toEqual({ ok: false, error: { code: "unsupported" } });
});

test("blocks a consumer outside the captured process subtree using the real census", async () => {
  // Given: a live owned census anchor that is not the file-holding test process.
  const f = await fixture(), anchor = spawn("/bin/cat", [], { stdio: ["pipe", "pipe", "pipe"] });
  const ready = once(anchor.stdout, "data");
  anchor.stdin.write("ready\n"); await ready;
  if (!anchor.pid) throw new TypeError("fixture_anchor_pid");
  try {
    const { profile, plan } = configured(await f.load({ ...f.input, profiles: [{ ...f.p,
      coverage: { ...f.p.coverage, rootPids: [anchor.pid] } }] }));
    const fd = openSync(f.before.executableRealpath, "r");
    try {
      // When
      const result = evaluateResourceGate(plan, profile.observe(plan));
      // Then
      expect(result).toEqual({ ok: false, error: { code: "unsupported" } });
    } finally { closeSync(fd); }
  } finally {
    const exited = once(anchor, "exit"); anchor.stdin.end(); await exited;
  }
});

test("keeps multiple exact installations selectable without collapsing their adapters", async () => {
  // Given
  const a = await fixture(), b = await fixture();
  // When
  const result = await a.load({ ...a.input, profiles: [a.p, b.p] });
  // Then
  if (result.kind !== "configured") throw new TypeError(JSON.stringify(result));
  expect(result.runner.profiles?.map(p => p.contract.installation.installationId))
    .toEqual([a.before.installationId, b.before.installationId]);
  expect(result.readers.candidates).toHaveLength(2);
  for (const p of result.runner.profiles ?? []) {
    expect((await p.adapter.detect(p.contract.installation.executableRealpath)).ok).toBe(true);
    expect(p.adapter.updateSpec(p.contract.installation, "update-and-restart")).toEqual({ ok: false, error: { code: "unsupported" } });
  }
});

test.each(["empty-roots", "empty-sockets", "foreign-home", "after-version", "expired", "unqualified-receipt"] as const)(
  "rejects %s before opening mutation storage", async kind => {
    // Given
    const f = await fixture();
    const q = f.p.update.qualification;
    const other = realpathSync(mkdtempSync(join(tmpdir(), "package-runtime-foreign-"))); roots.push(other);
    const changed = kind === "expired" ? { ...q, target: { ...q.target, checkedAt: 0, expiresAt: 1 } }
      : kind === "foreign-home" ? { ...q, env: { ...q.env, HOME: other } } : q;
    const update = { qualification: changed, receipt: kind === "unqualified-receipt" ? f.p.expectedAfterPin
      : put(f.p.update.receipt.path, JSON.stringify(changed)) };
    const expectedAfterPin = kind === "after-version"
      ? put(f.p.expectedAfterPin.path, JSON.stringify({ ...f.after, installedVersion: { kind: "known", version: "99.0.0" } }))
      : f.p.expectedAfterPin;
    const coverage = { ...f.p.coverage, ...(kind === "empty-roots" ? { rootPids: [] } : {}),
      ...(kind === "empty-sockets" ? { registeredSockets: [] } : {}) };
    // When
    const result = await f.load({ ...f.input, profiles: [{ ...f.p, update, expectedAfterPin, coverage }] });
    // Then
    expect(result.kind).toBe("unsupported");
    expect(lstatSync(join(f.directory, "mutations"), { throwIfNoEntry: false })).toBeUndefined();
  });

test("copies plain input while rejecting callback, getter, proxy, and unknown fields without executing them", async () => {
  // Given
  const f = await fixture();
  let calls = 0;
  const getter = Object.defineProperty({}, "profile", { enumerable: true, get() { calls++; return PACKAGE_RUNTIME_PROFILE; } });
  const proxy = new Proxy({}, { ownKeys() { calls++; return []; } });
  const invalid = [getter, proxy, { ...f.input, executor: () => { calls++; } },
    { ...f.input, profiles: [{ ...f.p, native: {} }] }, { ...f.input, profiles: [] }];
  // When
  const parsed = validatePackageRuntimeInputs(f.input);
  for (const data of invalid) expect(() => validatePackageRuntimeInputs(data)).toThrow();
  // Then
  expect(parsed).toEqual(f.input);
  expect(parsed.profiles[0]?.update.qualification.installation).not.toBe(f.before);
  expect(calls).toBe(0);
});
