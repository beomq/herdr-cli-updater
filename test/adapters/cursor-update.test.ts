import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, constants, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createCursorUpdateSpec, executeCursorUpdate, getCursorUpdateIntent, qualifyCursorUpdate } from "../../src/adapters/cursor-update";
import type { NativeCursorUpdateInput } from "../../src/adapters/cursor-update";
import type { AdapterResult, InstallationIdentity, PrivateUpdateCommand } from "../../src/adapters/types";

const now = 1_800_000_000_000, version = "2026.10.01-e373342";
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const rejected = { ok: false, error: { code: "verification_failed" } } as const;
const recovery = { ok: false, error: { code: "recovery_required" } } as const;
const evidence = resolve(import.meta.dir, "../../.omo/evidence/herdr-cli-updater/six-families/native-update/cursor-agy-current");
const original = join(evidence, "cursor/package/dist-package");
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
function members(source = original) {
  const files: { path: string; sha256: string; bytes: number; mode: number }[] = [];
  const directories: string[] = [];
  function visit(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.length === 0) directories.push(dir.slice(source.length + 1));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        const info = lstatSync(path);
        if (!entry.isFile()) throw new TypeError("original_link");
        files.push({ path: path.slice(source.length + 1), sha256: hash(readFileSync(path)),
          bytes: info.size, mode: info.mode & 0o777 });
      }
    }
  }
  visit(source); return { files: files.sort((a, b) => a.path.localeCompare(b.path)), directories };
}
// These are retained acquired vendor bytes, never an invented updater. The
// executor stubs below only test rejection, not a claim of native update success.
const originalInventory = members(), expectedFiles = originalInventory.files;
function fixture(legacy = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-cursor-static-"))); roots.push(root);
  const home = join(root, "home"), prefix = join(home, ".local/share/cursor-agent");
  const source = join(prefix, "versions/current-source"), target = join(prefix, "versions", version);
  mkdirSync(home, { mode: 0o700 });
  for (const path of [source, join(home, ".local/bin"), ...["config", "data", "compile-cache", "tmp"].map(p => join(home, p))])
    mkdirSync(path, { recursive: true });
  const beforeSource = legacy ? join(homedir(), ".local/share/cursor-agent/versions/2026.01.23-916f423") : original;
  const before = legacy ? members(beforeSource) : originalInventory;
  const beforeInstaller = pin(legacy ? resolve(evidence, "../../../task-5/families/cursor/boundedsource/install.sh")
    : join(original, "9164.index.js"));
  cpSync(beforeSource, source, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const executable = join(source, "cursor-agent");
  for (const alias of ["agent", "cursor-agent"]) symlinkSync(executable, join(home, ".local/bin", alias));
  put(join(home, "config/cli-config.json"), readFileSync(join(evidence, "probe-home/config/cli-config.json")));
  const resources = before.files.map(file => ({ realpath: join(source, file.path),
    resourceId: `resource:${hash(join(source, file.path))}`, fingerprint: `sha256:${file.sha256}` }))
    .sort((a, b) => a.realpath.localeCompare(b.realpath));
  const installation: InstallationIdentity = { family: "cursor", channel: "prod",
    executableRealpath: executable, installationId: `install:${hash(executable)}`,
    owner: { kind: "native", prefix: home, installerDigest: `sha256:${beforeInstaller.sha256}` },
    installedVersion: { kind: "known", version: legacy ? "2026.01.23-916f423" : version },
    resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  put(join(root, "manifest.json"), JSON.stringify(expectedFiles));
  put(join(root, "release.json"), JSON.stringify({ method: "POST",
    url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl",
    request: { channel: "prod" }, status: 200, response: { version, url: `https://downloads.cursor.com/lab/${version}/` } }));
  const archive = join(root, "supply/darwin/arm64/agent-cli-package.tar.gz");
  mkdirSync(dirname(archive), { recursive: true });
  cpSync(join(evidence, "cursor/package.tar.gz"), archive, { mode: constants.COPYFILE_FICLONE });
  const qualification: NativeCursorUpdateInput["qualification"] = { installation, home,
    originalExecutable: join(original, "cursor-agent"), beforeFiles: before.files,
    beforeDirectories: before.directories, beforeInstaller,
    env: { HOME: home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin", AGENT_CLI_CREDENTIAL_STORE: "file",
      CURSOR_CONFIG_DIR: join(home, "config"), CURSOR_DATA_DIR: join(home, "data"), NODE_COMPILE_CACHE: join(home, "compile-cache") },
    manifest: pin(join(root, "manifest.json")), expectedFiles,
    dependencies: ["/bin/bash", "/bin/realpath", "/bin/sh", "/usr/bin/basename", "/usr/bin/bsdtar", "/usr/bin/curl", "/usr/bin/dirname",
      "/usr/bin/env", "/usr/bin/readlink", "/usr/bin/sandbox-exec"].map(pin),
    target: { version, channel: "prod", archive: pin(archive), release: pin(join(root, "release.json")),
      checkedAt: now, expiresAt: now + 300_000 } };
  function authorize(q = qualification): NativeCursorUpdateInput {
    put(join(root, "receipt.json"), JSON.stringify(q), 0o600);
    return { qualification: q, receipt: pin(join(root, "receipt.json")) };
  }
  const input = authorize();
  async function issued() {
    const context = value(await qualifyCursorUpdate(input, now));
    return { context, spec: value(createCursorUpdateSpec(context, "update-only", now)) };
  }
  return { root, home, source, target, qualification, input, authorize, issued };
}
function stageOriginalAfter(home: string, target: string): void {
  // Replay acquired original output solely to exercise postflight validation.
  // This is not a process backend or evidence that this test ran the updater.
  cpSync(join(evidence, "probe-home/.local/share/cursor-agent/versions", version), target,
    { recursive: true, mode: constants.COPYFILE_FICLONE });
  for (const alias of ["agent", "cursor-agent"]) {
    const path = join(home, ".local/bin", alias); unlinkSync(path);
    symlinkSync(join(target, "cursor-agent"), path);
  }
  put(join(home, ".local/bin/cursor"), readFileSync(join(evidence, "probe-home/.local/bin/cursor")), 0o755);
}

test("issues a before-to-after native transition with distinct effective and download channels", async () => {
  // Given: pinned current original, prod POST response, lab download lane.
  const f = fixture();
  // When: private qualification issues the static spec.
  const { spec } = await f.issued();
  // Then: the real command and canonical transition are explicit, not identity-equal.
  expect(value(getCursorUpdateIntent(spec)).family).toBe("cursor");
  expect(spec.execution?.kind).toBe("cursor-original-update");
  expect(spec.command.executable).toBe("/usr/bin/sandbox-exec");
  expect(spec.command.args.slice(2)).toEqual([join(original, "cursor-agent"), "install", version, `file://${f.root}/supply`]);
  expect(spec.expectedAfter.executableRealpath).toBe(join(f.target, "cursor-agent"));
  expect(spec.expectedAfter.installationId).not.toBe(spec.expectedInstallation.installationId);
  expect(spec.expectedAfter.owner).toEqual(spec.expectedInstallation.owner);
  expect(spec.expectedAfter.channel).toBe("prod");
  expect(spec.mutationRoots).toContain(join(f.home, ".local/share/cursor-agent"));
  expect(spec.mutationRoots.every(root => spec.mutationResources.some(row => row.realpath === root
    && row.resourceId === `resource:${hash(root)}`))).toBe(true);
  expect(spec.expectedInstallation.resources.every(resource => spec.mutationResources.some(row =>
    row.realpath === resource.realpath && row.fingerprint === resource.fingerprint))).toBe(true);
}, 30_000);

test("binds the genuine January before bytes separately from the October original updater", async () => {
  // Given: a read-only copy of the existing January payload, checked against all
  // 349 official archive receipts. No operating executable is invoked or edited.
  const f = fixture(true), { spec } = await f.issued();
  // When: the acquired October after layout is independently observed.
  const result = await executeCursorUpdate(spec, { now: () => now,
    run: async () => { stageOriginalAfter(f.home, f.target); return { status: 0, signal: null }; } });
  // Then: true before/after versions differ; execution remains the current source.
  expect(spec.expectedInstallation.installedVersion).toEqual({ kind: "known", version: "2026.01.23-916f423" });
  expect(spec.expectedAfter.installedVersion).toEqual({ kind: "known", version });
  expect(spec.command.args[2]).toBe(join(original, "cursor-agent"));
  expect(spec.expectedAfter.owner).toEqual(spec.expectedInstallation.owner);
  expect(value(result).kind).toBe("files-verified");
}, 30_000);

test("rejects forged and copied specs without invoking an executor", async () => {
  // Given: a genuine issued object and structural copies.
  const f = fixture(), { spec } = await f.issued(); let calls = 0;
  // When: a copy tries to cross the private issuance boundary.
  const result = await executeCursorUpdate({ ...spec }, { now: () => now, run: async () => { calls++; return { status: 0, signal: null }; } });
  // Then: neither a copied spec nor a forged/copy context transfers authority.
  expect(result).toEqual(rejected); expect(calls).toBe(0);
  expect(getCursorUpdateIntent(structuredClone(spec))).toEqual(rejected);
  expect(createCursorUpdateSpec({ kind: "cursor-original-update" }, "update-only", now)).toEqual(rejected);
}, 30_000);

test.each(["target", "channel", "empty", "environment", "owner", "source", "archive"] as const)(
  "rejects receipt-bound but unqualified %s input", async change => {
    // Given: a private receipt cannot grant an unreviewed source/target/environment.
    const f = fixture(), q = f.qualification;
    const altered = change === "target" ? { ...q, target: { ...q.target, version: "2027.01.01-abcdef0" } }
      : change === "channel" ? { ...q, installation: { ...q.installation, channel: "lab" } }
      : change === "empty" ? { ...q, expectedFiles: [] }
      : change === "environment" ? { ...q, env: { ...q.env, NODE_OPTIONS: "--require=/tmp/foreign" } }
      : change === "owner" ? { ...q, installation: { ...q.installation,
        owner: { kind: "native" as const, prefix: f.home, installerDigest: "sha256:" + "0".repeat(64) } } }
      : change === "archive" ? { ...q, target: { ...q.target, archive: { ...q.target.archive, sha256: "0".repeat(64) } } }
      : { ...q, installation: { ...q.installation, installedVersion: { kind: "known" as const, version: "2027.01.01-abcdef0" } } };
    // When: qualification validates actual native provenance.
    const result = await qualifyCursorUpdate(f.authorize(altered), now);
    // Then: matching JSON is not sufficient authority.
    expect(result).toEqual(rejected);
  }, 30_000);

test("rejects release acquisition with a substituted request channel", async () => {
  // Given: the lab URL is unchanged but no prod-channel acquisition exists.
  const f = fixture(), path = f.qualification.target.release.path;
  const release = JSON.parse(readFileSync(path, "utf8"));
  put(path, JSON.stringify({ ...release, request: { channel: "lab" } }));
  const q = { ...f.qualification, target: { ...f.qualification.target, release: pin(path) } };
  // When/Then: even the refreshed private receipt cannot conflate the channels.
  expect(await qualifyCursorUpdate(f.authorize(q), now)).toEqual(rejected);
}, 30_000);

test("rejects an alias resolving outside its original owner", async () => {
  // Given: a byte-valid source with a substituted alias.
  const f = fixture(), alias = join(f.home, ".local/bin/agent");
  unlinkSync(alias); symlinkSync("/bin/sh", alias);
  // When/Then: ownership verification covers both aliases.
  expect(await qualifyCursorUpdate(f.input, now)).toEqual(rejected);
}, 30_000);

test("rejects selecting the old installation as the separately granted original updater", async () => {
  // Given: native ownership of before does not grant its source for execution.
  const f = fixture();
  const q = { ...f.qualification, originalExecutable: f.qualification.installation.executableRealpath };
  // When/Then: only the separately pinned outside-HOME current original may run.
  expect(await qualifyCursorUpdate(f.authorize(q), now)).toEqual(rejected);
}, 30_000);

test("rejects a preexisting target instead of reporting an installation noop", async () => {
  // Given: the original install command would reuse this directory.
  const f = fixture(); mkdirSync(f.target);
  // When/Then: this grant requires an actual before-to-after transition.
  expect(await qualifyCursorUpdate(f.input, now)).toEqual(rejected);
}, 30_000);

test("rejects exit zero without independent target and alias changes", async () => {
  // Given: an issued real command and a lying process result.
  const f = fixture(), { spec } = await f.issued(); let command: PrivateUpdateCommand | undefined;
  // When: the trusted process seam is adversarially replaced for this regression.
  const result = await executeCursorUpdate(spec, { now: () => now,
    run: async invocation => { command = invocation; return { status: 0, signal: null }; } });
  // Then: exit status alone cannot manufacture success.
  expect(result).toEqual(recovery);
  expect(command?.inheritEnv).toBe(false); expect(command?.shell).toBe(false);
  expect(command?.env).toEqual(f.qualification.env);
  expect(command?.nativeCompletion).toEqual({ kind: "cursor-detached-cleanup", home: f.home,
    executable: join(f.target, "cursor-agent"), args: ["cleanup-install-versions", version] });
  expect(Object.isFrozen(command)).toBe(true);
  expect(Object.isFrozen(command?.env)).toBe(true);
  expect(Object.isFrozen(command?.nativeCompletion)).toBe(true);
  expect(Object.isFrozen(command?.nativeCompletion?.args)).toBe(true);
}, 30_000);

test("consumes the whole context once when observation times out", async () => {
  // Given: two specs from the same qualified context.
  const f = fixture(), { context, spec } = await f.issued();
  const sibling = value(createCursorUpdateSpec(context, "update-only", now)); let calls = 0;
  const executor = { now: () => now, run: async () => { calls++; throw new DOMException("abandoned", "TimeoutError"); } };
  // When: process observation becomes uncertain (no timing sleep or retry).
  expect(await executeCursorUpdate(spec, executor)).toEqual(recovery);
  // Then: neither the same intent nor another spec can dispatch it again.
  expect(await executeCursorUpdate(sibling, executor)).toEqual(rejected);
  expect(await executeCursorUpdate(spec, executor)).toEqual(rejected);
  expect(createCursorUpdateSpec(context, "update-only", now)).toEqual(rejected);
  expect(calls).toBe(1);
}, 30_000);

test("verifies acquired original after bytes without issuing a durable process receipt", async () => {
  // Given: the retained real original after layout, used as an observation fixture.
  const f = fixture(), { spec } = await f.issued();
  // When: the private process seam is replaced with the acquired after state.
  const result = await executeCursorUpdate(spec, { now: () => now,
    run: async () => { stageOriginalAfter(f.home, f.target); return { status: 0, signal: null }; } });
  // Then: byte/alias observation succeeds but only the parent can attest execution.
  expect(value(result).kind).toBe("files-verified");
  expect(value(result).durableReceipt).toBe(false);
}, 30_000);

test.each(["target", "alias", "root"] as const)("independently rejects incorrect after %s despite exit zero", async change => {
  // Given: an issued source-bound spec. This adverse executor does not attest a
  // native update: it only stages real payload bytes then corrupts one outcome.
  const f = fixture(), { spec } = await f.issued();
  // When: a successful process result conceals target/alias/write-root drift.
  const result = await executeCursorUpdate(spec, { now: () => now, run: async () => {
    stageOriginalAfter(f.home, f.target);
    if (change === "alias") {
      const path = join(f.home, ".local/bin/agent"); unlinkSync(path);
      symlinkSync(join(f.source, "cursor-agent"), path);
    }
    if (change === "target") put(join(f.target, "9164.index.js"), "substituted");
    if (change === "root") put(join(f.home, "data/unexpected"), "unaccounted");
    return { status: 0, signal: null };
  } });
  // Then: the adapter's own full-tree observation catches each discrepancy.
  expect(result).toEqual(recovery);
}, 30_000);

test("rejects mutation from the final dispatch hook before running", async () => {
  // Given: callbacks are not attestation authorities.
  const f = fixture(), { spec } = await f.issued(); let calls = 0;
  // When: the dispatch hook replaces source bytes after issuance.
  const result = await executeCursorUpdate(spec, { now: () => now,
    event: async event => { if (event.kind === "dispatch") put(join(f.source, "9164.index.js"), "forged"); },
    run: async () => { calls++; return { status: 0, signal: null }; } });
  // Then: final source fingerprinting prevents execution.
  expect(result).toEqual(rejected); expect(calls).toBe(0);
}, 30_000);

test("rejects accessors without evaluating untrusted behavior", async () => {
  // Given: a getter where the private plain-data input should be.
  let calls = 0;
  const input = { get qualification(): never { calls++; throw new Error("must_not_run"); },
    receipt: { path: "/unused", sha256: "0".repeat(64) } };
  // When/Then: boundary classification never invokes the getter.
  expect(await qualifyCursorUpdate(input, now)).toEqual(rejected); expect(calls).toBe(0);
});
