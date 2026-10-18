import { afterEach, expect } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { AGY_INSTALLER_SHA256, AGY_MANIFEST_CHANNEL } from "../../src/adapters/agy";
import { createAgyUpdateSpec, executeAgyUpdate, getAgyUpdateIntent, observeAgyUpdate, qualifyAgyUpdate } from "../../src/adapters/agy-update";
import type { NativeAgyUpdateInput } from "../../src/adapters/agy-update";
import type { AdapterResult, InstallationIdentity, PrivateUpdateCommand, PrivateUpdateEvent } from "../../src/adapters/types";
import { artifactRoot, artifactTest } from "../fixtures/artifacts";

// Mechanism tests use acquired genuine source bytes and a bounded real controlled
// child at the executor seam. That child is NOT the vendor updater. Actual vendor
// success is the separately retained update-success-r1/REPORT.md, not these tests.
// No production network, credential, operating install or model call is made.
const evidence = artifactRoot;
const current = join(evidence, "six-families/native-update/cursor-agy-current/agy");
const now = 1_800_000_000_000, oldHash = "d15693410c904242c1c3423a579f60a81e018444bb51fbccc6505f988b62a91d";
const newHash = "7dca095cfc1df2c057a385ed88a76c7ba98dc103258a80be87a8f42e484cb3aa";
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const rejected = { ok: false, error: { code: "verification_failed" } } as const;
const recovery = { ok: false, error: { code: "recovery_required" } } as const;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function value<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}
function put(path: string, body: string | Uint8Array, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); chmodSync(path, mode);
}
function pin(path: string) { return { path, sha256: hash(readFileSync(path)) }; }
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "herdr-agy-static-"))); roots.push(dir);
  const root = join(dir, "state"), home = join(root, "home"), executable = join(root, "bin/agy");
  mkdirSync(root, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(root, "bin"), { mode: 0o755 }); mkdirSync(join(home, "tmp"), { mode: 0o755 });
  const original = join(current, "update-success-r1/acquired/antigravity");
  copyFileSync(original, executable, constants.COPYFILE_FICLONE); chmodSync(executable, 0o755);
  const source = pin(original), installer = pin(join(evidence, "task-5/families/agy/boundedsource/install.sh"));
  const resources = [{ realpath: executable, resourceId: `resource:${hash(executable)}`, fingerprint: `sha256:${oldHash}` }];
  const installation: InstallationIdentity = { family: "agy", channel: AGY_MANIFEST_CHANNEL, executableRealpath: executable,
    installationId: `install:${hash(executable)}`, owner: { kind: "native", prefix: root, installerDigest: `sha256:${AGY_INSTALLER_SHA256}` },
    installedVersion: { kind: "known", version: "1.2.15" }, resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  const manifest = { version: "1.2.16",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.16-5594158052802560/darwin-arm/cli_mac_arm64.tar.gz",
    sha512: "834a62dc972cfdf09cdb001c7ba79bb5bc9ae5acdba8bd9c4d2939045b76e19c9bdb6eeac58ed88a1deaa1670fc9335eee18482fe2f32603e78224de9573b0fe" };
  put(join(dir, "manifest.json"), JSON.stringify(manifest));
  put(join(dir, "release.json"), JSON.stringify({ method: "GET", url: AGY_MANIFEST_CHANNEL, status: 200, checkedAt: now, response: manifest }));
  const qualification: NativeAgyUpdateInput["qualification"] = { installation, root, home, source, installer,
    env: { HOME: home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share") },
    dependencies: [pin("/usr/bin/sandbox-exec")],
    target: { selection: "official-latest", version: "1.2.16", channel: AGY_MANIFEST_CHANNEL,
      manifest: pin(join(dir, "manifest.json")), release: pin(join(dir, "release.json")),
      archive: pin(join(current, "package.tar.gz")),
      expectedFiles: [{ path: "antigravity", sha256: newHash, bytes: 175966448, mode: 0o755 }],
      checkedAt: now, expiresAt: now + 300_000 } };
  function authorize(q = qualification): NativeAgyUpdateInput {
    put(join(dir, "receipt.json"), JSON.stringify(q), 0o600); return { qualification: q, receipt: pin(join(dir, "receipt.json")) };
  }
  const input = authorize();
  async function issue() {
    const context = value(await qualifyAgyUpdate(input, now));
    return { context, spec: value(createAgyUpdateSpec(context, "update-only", now)) };
  }
  return { dir, root, home, executable, qualification, manifest, input, authorize, issue };
}
type Fixture = ReturnType<typeof fixture>;
/** Await an exact child exit with a bounded cancellation signal, never a sleep.
 * Writes here intentionally model output cases; production never copies files. */
async function controlled(f: Fixture, mode: "success" | "noop" | "drift" | "backup" | "status" | "extra" | "symlink") {
  const script = `
    import {chmodSync,copyFileSync,mkdirSync,renameSync,symlinkSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const [root,payload,mode]=process.argv.slice(1);
    if(mode==='noop') process.exit(0);
    const exe=join(root,'bin/agy'), backup=exe+'.1791173933682305000.old';
    renameSync(exe,backup);
    if(mode==='symlink') symlinkSync(payload,exe);
    else { copyFileSync(payload,exe); chmodSync(exe,0o755); }
    if(mode==='drift') writeFileSync(exe,'other official version is not the checked payload');
    if(mode==='backup') writeFileSync(backup,'wrong backup');
    const state=join(root,'home/.gemini/antigravity-cli/updater');
    mkdirSync(state,{recursive:true,mode:0o755});
    writeFileSync(join(state,'update.lock'),'',{mode:0o600});
    writeFileSync(join(state,'update_status.json'),JSON.stringify({success:mode!=='status',message:'Update successful, restart CLI to use'}),{mode:0o600});
    if(mode==='extra') writeFileSync(join(root,'home/tmp/unexpected'),'unplanned');
  `;
  const child = Bun.spawn([process.execPath, "-e", script, f.root, join(current, "package/antigravity"), mode], {
    cwd: f.root, env: { HOME: f.home, TMPDIR: join(f.home, "tmp"), PATH: "/usr/bin:/bin" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10_000),
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stdout).toBe(""); expect(stderr).toBe("");
  return { status, signal: child.signalCode ?? null };
}

artifactTest("issues only floating update with a complete before root and planned backup/status", async () => {
  // Given: genuine old original and independently acquired current latest.
  const f = fixture();
  // When: effect-free qualification and issuance run.
  const { context, spec } = await f.issue();
  // Then: no native process or persistent output was created.
  expect(readdirSync(join(f.root, "bin"))).toEqual(["agy"]);
  expect(readdirSync(f.home)).toEqual(["tmp"]);
  expect(spec.targetSelection).toBe("official-latest");
  expect(spec.execution?.kind).toBe("agy-original-update");
  expect(spec.command.args.slice(2)).toEqual([f.executable, "update"]);
  expect(spec.command.executable).toBe("/usr/bin/sandbox-exec");
  expect(spec.mutationRoots).toEqual([f.root]);
  expect(spec.mutationResources.map(row => row.realpath)).toEqual([f.root, f.executable]);
  expect(spec.expectedAfter.resources.map(row => row.realpath)).toEqual([
    f.root, f.executable, join(f.home, ".gemini/antigravity-cli/updater/update_status.json"),
    join(f.home, ".gemini/antigravity-cli/updater/update.lock"),
  ].sort((a, b) => a.localeCompare(b)));
  expect(spec.expectedAfter.resources.find(row => row.realpath === f.root)?.fingerprint)
    .not.toBe(spec.mutationResources.find(row => row.realpath === f.root)?.fingerprint);
  expect(spec.expectedAfter.resources.find(row => row.realpath.endsWith("/update_status.json"))?.fingerprint)
    .toBe(`sha256:${pin(join(current, "update-success-r1/state/home/.gemini/antigravity-cli/updater/update_status.json")).sha256}`);
  expect(createAgyUpdateSpec(context, "update-and-restart", now)).toEqual({ ok: false, error: { code: "unsupported" } });
}, 30_000);

artifactTest("mechanism: exact controlled outputs verify after intent and one direct child", async () => {
  // Given: an issued command and controlled real process, not vendor-success evidence.
  const f = fixture(), { spec } = await f.issue(), events: PrivateUpdateEvent["kind"][] = [];
  let calls = 0, invocation: PrivateUpdateCommand | undefined;
  // When: the worker seam completes the original-shaped file transition.
  const result = await executeAgyUpdate(spec, { now: () => now, event: async event => { events.push(event.kind); },
    run: async command => { calls++; invocation = command; expect(events).toEqual(["intent", "dispatch"]); return controlled(f, "success"); } });
  // Then: independent bytes, old backup, status and whole root agree.
  expect(result).toEqual({ ok: true, value: { kind: "files-verified", intent: value(getAgyUpdateIntent(spec)), durableReceipt: false } });
  expect(value(observeAgyUpdate(spec, now))).toEqual(spec.expectedAfter);
  expect(events).toEqual(["intent", "dispatch", "exit"]); expect(calls).toBe(1);
  expect(invocation?.shell).toBe(false); expect(invocation?.inheritEnv).toBe(false);
  expect(invocation?.env).toEqual(f.qualification.env);
  expect(Object.isFrozen(invocation)).toBe(true); expect(Object.isFrozen(invocation?.env)).toBe(true);
  expect(Object.isFrozen(invocation?.args)).toBe(true);
}, 30_000);

artifactTest.each(["noop", "drift", "backup", "status", "extra", "symlink"] as const)(
  "mechanism: %s output requires recovery and never retries", async mode => {
    // Given: two authenticated specs share one context.
    const f = fixture(), { context, spec } = await f.issue();
    const sibling = value(createAgyUpdateSpec(context, "update-only", now)); let calls = 0;
    const executor = { now: () => now, run: async () => { calls++; return controlled(f, mode); } };
    // When: a bounded child exits zero with a nonmatching observed effect.
    const result = await executeAgyUpdate(spec, executor);
    // Then: neither this intent nor a sibling can retry the possibly changed install.
    expect(result).toEqual(recovery);
    expect(await executeAgyUpdate(spec, executor)).toEqual(rejected);
    expect(await executeAgyUpdate(sibling, executor)).toEqual(rejected);
    expect(createAgyUpdateSpec(context, "update-only", now)).toEqual(rejected);
    expect(calls).toBe(1);
  }, 30_000);

artifactTest.each(["owner", "source", "environment", "archive", "expectedFiles", "expiry", "manifest"] as const)(
  "rejects receipt-bound but unqualified %s data", async change => {
    // Given: matching receipt JSON is not itself executable provenance.
    const f = fixture(), q = f.qualification;
    const altered = change === "owner" ? { ...q, installation: { ...q.installation,
      owner: { kind: "native" as const, prefix: f.dir, installerDigest: `sha256:${AGY_INSTALLER_SHA256}` } } }
      : change === "source" ? { ...q, source: { ...q.source, sha256: "0".repeat(64) } }
      : change === "environment" ? { ...q, env: { ...q.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" } }
      : change === "archive" ? { ...q, target: { ...q.target, archive: { ...q.target.archive, sha256: "0".repeat(64) } } }
      : change === "expectedFiles" ? { ...q, target: { ...q.target, expectedFiles: [] } }
      : change === "expiry" ? { ...q, target: { ...q.target, expiresAt: now } }
      : { ...q, target: { ...q.target, manifest: { ...q.target.manifest, sha256: "0".repeat(64) } } };
    // When/Then: qualification refuses the mismatching observation.
    expect(await qualifyAgyUpdate(f.authorize(altered), now)).toEqual(rejected);
  }, 30_000);

artifactTest("rejects a symlink destination before any executor can run", async () => {
  // Given: a source-shaped alias points to the genuine external binary.
  const f = fixture(); unlinkSync(f.executable); symlinkSync(f.qualification.source.path, f.executable);
  // When/Then: bytes resolving through an alias do not grant write ownership.
  expect(await qualifyAgyUpdate(f.input, now)).toEqual(rejected);
}, 30_000);

artifactTest("rejects a matching archive SHA256 with a substituted manifest SHA512", async () => {
  // Given: refreshed local pins cannot remove the publisher's SHA512 check.
  const f = fixture(), q = f.qualification;
  const manifest = { ...f.manifest, sha512: "0".repeat(128) };
  put(q.target.manifest.path, JSON.stringify(manifest));
  put(q.target.release.path, JSON.stringify({ method: "GET", url: AGY_MANIFEST_CHANNEL, status: 200, checkedAt: now, response: manifest }));
  // When/Then: archive inspection detects the disagreement before issuance.
  expect(await qualifyAgyUpdate(f.authorize({ ...q, target: { ...q.target,
    manifest: pin(q.target.manifest.path), release: pin(q.target.release.path) } }), now)).toEqual(rejected);
}, 30_000);

artifactTest("rejects symlink archive members despite coherent local digest pins", async () => {
  // Given: a tar header changed to a link with a corrected tar checksum.
  const f = fixture(), q = f.qualification, tar = gunzipSync(readFileSync(q.target.archive.path));
  tar[156] = 50; tar.fill(32, 148, 156);
  const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  tar.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const archive = join(f.dir, "link.tar.gz"), bytes = gzipSync(tar); put(archive, bytes);
  const manifest = { ...f.manifest, sha512: createHash("sha512").update(bytes).digest("hex") };
  put(q.target.manifest.path, JSON.stringify(manifest));
  put(q.target.release.path, JSON.stringify({ method: "GET", url: AGY_MANIFEST_CHANNEL, status: 200, checkedAt: now, response: manifest }));
  // When/Then: no archive entry can redirect the destination.
  expect(await qualifyAgyUpdate(f.authorize({ ...q, target: { ...q.target, archive: pin(archive),
    manifest: pin(q.target.manifest.path), release: pin(q.target.release.path) } }), now)).toEqual(rejected);
}, 30_000);

artifactTest("rejects stale manifest mutation at the final dispatch hook without launch", async () => {
  // Given: a fresh issued spec.
  const f = fixture(), { spec } = await f.issue(); let calls = 0;
  // When: a supplied hook invalidates the latest selection after durable dispatch.
  const result = await executeAgyUpdate(spec, { now: () => now,
    event: async event => { if (event.kind === "dispatch") put(f.qualification.target.manifest.path, "{}"); },
    run: async () => { calls++; return { status: 0, signal: null }; } });
  // Then: the final fresh check refuses the original launch.
  expect(result).toEqual(rejected); expect(calls).toBe(0);
}, 30_000);

artifactTest("consumes context before accessing a throwing executor getter", async () => {
  // Given: the executor is trusted by contract but its hooks may still fail.
  const f = fixture(), { context, spec } = await f.issue(); let calls = 0;
  // When: accessing a supplied hook fails.
  const result = await executeAgyUpdate(spec, { get now(): never { calls++; throw new Error("hook"); },
    run: async () => ({ status: 0, signal: null }) });
  // Then: no sibling context issuance or automatic reattempt is permitted.
  expect(result).toEqual(rejected); expect(calls).toBe(1);
  expect(createAgyUpdateSpec(context, "update-only", now)).toEqual(rejected);
}, 30_000);

artifactTest("rejects copied contexts, specs and forged intents", async () => {
  // Given: real opaque object identities.
  const f = fixture(), { context, spec } = await f.issue(), intent = value(getAgyUpdateIntent(spec));
  // When/Then: data copies and mismatched intent identity have no authority.
  expect(createAgyUpdateSpec({ ...context }, "update-only", now)).toEqual(rejected);
  expect(getAgyUpdateIntent({ ...spec })).toEqual(rejected);
  expect(createAgyUpdateSpec(context, { ...intent, targetFingerprint: "0".repeat(64) }, now)).toEqual(rejected);
}, 30_000);

artifactTest("rejects getters, nested proxies and revoked proxies without invoking traps", async () => {
  // Given: all input-bearing paths are required to be plain data.
  const f = fixture(); let calls = 0;
  const accessor = { receipt: f.input.receipt, get qualification(): never { calls++; throw new Error("getter"); } };
  const nested = { ...f.input, qualification: new Proxy(f.qualification, {
    get() { calls++; throw new Error("get"); }, getOwnPropertyDescriptor() { calls++; throw new Error("descriptor"); },
    ownKeys() { calls++; throw new Error("keys"); }, getPrototypeOf() { calls++; throw new Error("prototype"); },
  }) };
  const revoked = Proxy.revocable(f.input, {}); revoked.revoke();
  // When/Then: classification refuses executable behavior without observing it.
  for (const input of [accessor, nested, revoked.proxy]) expect(await qualifyAgyUpdate(input, now)).toEqual(rejected);
  expect(calls).toBe(0);
}, 30_000);

artifactTest("detects bystander files in the entire approved prefix", async () => {
  // Given: the before state contains an unrelated file outside the executable.
  const f = fixture(); put(join(f.home, "tmp/bystander"), "must not be ignored");
  // When/Then: whole-root qualification cannot silently widen write ownership.
  expect(await qualifyAgyUpdate(f.input, now)).toEqual(rejected);
  expect(lstatSync(join(f.home, "tmp/bystander")).size).toBe(19);
}, 30_000);

artifactTest("mechanism: the issued static sandbox denies outside writes and personal content reads", async () => {
  // Given: an owned probe executable, not a credential or operating CLI. The
  // harmless AGENTS.md stands in for personal content covered by the same rule.
  const f = fixture(), { spec } = await f.issue();
  const outside = join(f.dir, "outside"), personal = join(homedir(), "AGENTS.md");
  put(outside, "unchanged");
  expect(lstatSync(personal).isFile()).toBe(true);
  let observed: { status: number; stdout: string; stderr: string } | undefined;
  // When: the controlled child runs with the EXACT issued profile and env.
  const result = await executeAgyUpdate(spec, { now: () => now, run: async command => {
    const probe = join(f.root, "bin/probe");
    // Copy the development runtime, not Apple's platform-signed /bin/sh:
    // macOS kills a relocated platform executable before the policy probe runs.
    copyFileSync(process.execPath, probe, constants.COPYFILE_FICLONE); chmodSync(probe, 0o755);
    const profile = command.args[1]; if (profile === undefined) throw new TypeError("missing_profile");
    const script = `
      import {readFileSync,writeFileSync} from 'node:fs';
      const [outside,personal]=process.argv.slice(1);
      let deniedWrite=false,deniedRead=false;
      try {writeFileSync(outside,'bad')} catch(error) {if(error.code!=='EPERM'&&error.code!=='EACCES')throw error;deniedWrite=true}
      try {readFileSync(personal)} catch(error) {if(error.code!=='EPERM'&&error.code!=='EACCES')throw error;deniedRead=true}
      if(!deniedWrite||!deniedRead)process.exit(41);
      writeFileSync(process.env.HOME+'/tmp/probe','allowed');
    `;
    const child = Bun.spawn([command.executable, "-p", profile, probe, "-e", script, outside, personal], {
      cwd: command.cwd, env: { ...command.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      signal: AbortSignal.timeout(10_000),
    });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    observed = { status, stdout, stderr }; return { status, signal: child.signalCode ?? null };
  } });
  // Then: policy enforced both denies and the allowed root write. Extra probe
  // files intentionally make native postflight fail rather than fabricate success.
  expect(observed).toEqual({ status: 0, stdout: "", stderr: "" }); expect(result).toEqual(recovery);
  expect(readFileSync(outside, "utf8")).toBe("unchanged");
  expect(readFileSync(join(f.home, "tmp/probe"), "utf8")).toBe("allowed");
}, 30_000);
