import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, constants, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createCursorUpdateSpec, qualifyCursorUpdate } from "../../src/adapters/cursor-update";
import type { NativeCursorUpdateInput } from "../../src/adapters/cursor-update";
import { executePrivateUpdate, getPrivateUpdateIntent } from "../../src/adapters/update-context";
import type { AdapterResult, InstallationIdentity } from "../../src/adapters/types";
import { consumePrivateUpdate } from "../../src/install/update";
import type { PrivateConsumerReceipt } from "../../src/install/update";

const now = 1_800_000_000_000, version = "2026.10.01-e373342";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const evidence = resolve(import.meta.dir, "../../.omo/evidence/herdr-cli-updater/six-families/native-update/cursor-agy-current");
const original = join(evidence, "cursor/package/dist-package");
const rejected = { ok: false, error: { code: "verification_failed" } } as const;
const recovery = { ok: false, error: { code: "recovery_required" } } as const;
function value<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TypeError("native_fixture_event_timeout")), 20_000);
    promise.then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); reject(error); });
  });
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-native-consumer-")));
  const home = join(root, "home"), journal = join(root, "journal");
  const prefix = join(home, ".local/share/cursor-agent"), source = join(prefix, "versions/current-source");
  const target = join(prefix, "versions", version);
  for (const path of [home, journal]) mkdirSync(path, { mode: 0o700 });
  for (const path of [source, join(home, ".local/bin"), ...["config", "data", "compile-cache", "tmp"].map(p => join(home, p))])
    mkdirSync(path, { recursive: true });
  cpSync(original, source, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const expectedFiles: { path: string; sha256: string; bytes: number; mode: number }[] = [];
  const beforeDirectories: string[] = [];
  const pending = [source];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.length === 0) beforeDirectories.push(dir.slice(source.length + 1));
    for (const item of entries) {
      const path = join(dir, item.name);
      if (item.isDirectory()) pending.push(path);
      else {
        const stat = lstatSync(path);
        expectedFiles.push({ path: path.slice(source.length + 1), sha256: hash(readFileSync(path)),
          bytes: stat.size, mode: stat.mode & 0o777 });
      }
    }
  }
  expectedFiles.sort((a, b) => a.path.localeCompare(b.path));
  function put(path: string, body: string | Uint8Array, mode = 0o644): void {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); chmodSync(path, mode);
  }
  const pin = (path: string) => ({ path, sha256: hash(readFileSync(path)) });
  const executable = join(source, "cursor-agent");
  for (const alias of ["agent", "cursor-agent"]) symlinkSync(executable, join(home, ".local/bin", alias));
  put(join(home, "config/cli-config.json"), readFileSync(join(evidence, "probe-home/config/cli-config.json")));
  const resources = expectedFiles.map(file => ({ realpath: join(source, file.path),
    resourceId: `resource:${hash(join(source, file.path))}`, fingerprint: `sha256:${file.sha256}` }))
    .sort((a, b) => a.realpath.localeCompare(b.realpath));
  const installation: InstallationIdentity = { family: "cursor", channel: "prod",
    executableRealpath: executable, installationId: `install:${hash(executable)}`,
    owner: { kind: "native", prefix: home, installerDigest: "sha256:8a2f1c777a037577596844c9759bd121970a33f1be482e9ecea1c8f0987dcbeb" },
    installedVersion: { kind: "known", version }, resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  put(join(root, "manifest.json"), JSON.stringify(expectedFiles));
  put(join(root, "release.json"), JSON.stringify({ method: "POST",
    url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl",
    request: { channel: "prod" }, status: 200, response: { version, url: `https://downloads.cursor.com/lab/${version}/` } }));
  const archive = join(root, "supply/darwin/arm64/agent-cli-package.tar.gz");
  mkdirSync(dirname(archive), { recursive: true });
  cpSync(join(evidence, "cursor/package.tar.gz"), archive, { mode: constants.COPYFILE_FICLONE });
  const qualification: NativeCursorUpdateInput["qualification"] = { installation, home,
    originalExecutable: join(original, "cursor-agent"), beforeFiles: expectedFiles,
    beforeDirectories, beforeInstaller: pin(join(original, "9164.index.js")),
    env: { HOME: home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin", AGENT_CLI_CREDENTIAL_STORE: "file",
      CURSOR_CONFIG_DIR: join(home, "config"), CURSOR_DATA_DIR: join(home, "data"), NODE_COMPILE_CACHE: join(home, "compile-cache") },
    manifest: pin(join(root, "manifest.json")), expectedFiles,
    dependencies: ["/bin/bash", "/bin/realpath", "/bin/sh", "/usr/bin/basename", "/usr/bin/bsdtar", "/usr/bin/curl", "/usr/bin/dirname",
      "/usr/bin/env", "/usr/bin/readlink", "/usr/bin/sandbox-exec"].map(pin),
    target: { version, channel: "prod", archive: pin(archive), release: pin(join(root, "release.json")),
      checkedAt: now, expiresAt: now + 300_000 } };
  put(join(root, "receipt.json"), JSON.stringify(qualification), 0o600);
  const input: NativeCursorUpdateInput = { qualification, receipt: pin(join(root, "receipt.json")) };
  function rows(): PrivateConsumerReceipt[] {
    return readdirSync(journal).flatMap(file => readFileSync(join(journal, file), "utf8").trim().split("\n")
      .filter(Boolean).map(line => JSON.parse(line)));
  }
  return { root, home, journal, target, input, rows, async issued() {
    const context = value(await qualifyCursorUpdate(input, now));
    return { context, spec: value(createCursorUpdateSpec(context, "update-only", now)) };
  }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test("joins the original detached cleanup before durable native success", async () => {
  // Given: actual pinned vendor source; a foreign owner has an independently held child.
  const f = fixture();
  const foreign = spawn("/bin/cat", [], { stdio: ["pipe", "ignore", "ignore"] });
  const foreignExit = once(foreign, "exit");
  let foreignExited = false; void foreignExit.then(() => { foreignExited = true; });
  let postflight = false;
  try {
    const { spec } = await f.issued();
    // When: the common consumer spawns the unchanged sandbox command.
    const result = await bounded(consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now,
      event: async row => { if (row.kind === "exit") postflight = true; } }));
    // Then: cleanup incarnation is observed and joined before postflight succeeds.
    expect({ result, postflight, receipts: f.rows(),
      markers: readdirSync(join(f.target, ".running")) }).toMatchObject({ result: { ok: true }, postflight: true });
    const rows = f.rows(), observed = rows.find(row => row.kind === "cleanup-observed");
    expect(observed?.pid).toBeGreaterThan(1);
    expect(observed?.processVersion).toBeGreaterThan(0);
    expect(rows.find(row => row.kind === "cleanup-exit")).toMatchObject({
      pid: observed?.pid, processVersion: observed?.processVersion,
    });
    const kinds = rows.map(row => row.kind);
    expect(kinds.slice(0, 3)).toEqual(["intent", "dispatch", "launched"]);
    expect(kinds.at(-1)).toBe("files-verified");
    expect(kinds.indexOf("cleanup-exit")).toBeGreaterThan(kinds.indexOf("cleanup-observed"));
    expect(kinds.indexOf("files-verified")).toBeGreaterThan(kinds.indexOf("cleanup-exit"));
    expect(rows.find(row => row.kind === "exit")).toMatchObject({ status: 0, signal: null });
    expect(realpathSync(join(f.home, ".local/bin/agent"))).toBe(join(f.target, "cursor-agent"));
    expect(foreignExited).toBe(false);
    expect(await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now })).toEqual(rejected);
  } finally {
    foreign.stdin.end(); await bounded(foreignExit); f.cleanup();
  }
}, 60_000);

test.each(["copy", "context", "nativeCompletion"] as const)("rejects native %s spoofing before any process", async spoof => {
  // Given: only object identity in the static issuer grants authority.
  const f = fixture();
  try {
    const { spec } = await f.issued();
    const candidate = spoof === "copy" ? { ...spec } : spec;
    if (spoof === "context") Reflect.set(candidate, "execution", { kind: "cursor-original-update" });
    if (spoof === "nativeCompletion") Reflect.set(candidate.command, "nativeCompletion", {
      kind: "cursor-detached-cleanup", executable: "/bin/true", args: [], home: f.home,
    });
    // When/Then: serialized process metadata cannot grant either dispatch or signals.
    expect(await consumePrivateUpdate(candidate, { receiptRoot: f.journal, now: () => now })).toEqual(rejected);
    expect(f.rows()).toEqual([]);
  } finally { f.cleanup(); }
}, 60_000);

test("rejects zero-exit native noop through the common static dispatcher", async () => {
  // Given: a genuine native issuance, with no installation mutation.
  const f = fixture();
  try {
    const { spec } = await f.issued();
    expect(value(getPrivateUpdateIntent(spec)).family).toBe("cursor");
    // When: the process seam lies about a zero exit.
    const result = await executePrivateUpdate(spec, { now: () => now, run: async () => ({ status: 0, signal: null }) });
    // Then: independent native postflight rejects it.
    expect(result).toEqual(recovery);
    expect(f.rows()).toEqual([]);
  } finally { f.cleanup(); }
}, 60_000);

test("retains cleanup observation after abandonment and never replays the native effect", async () => {
  // Given: subscribe to the exact operation journal before launching.
  const f = fixture(), abandoned = new AbortController(), complete = Promise.withResolvers<void>();
  const watcher = watch(f.journal, () => {
    const rows = f.rows();
    if (rows.some(row => row.kind === "exit") && rows.at(-1)?.kind === "recovery_required") complete.resolve();
  });
  try {
    const { context, spec } = await f.issued();
    const duplicate = value(createCursorUpdateSpec(context, "update-only", now));
    // When: abandon only after the actual suspended launch was armed and resumed.
    const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now, signal: abandoned.signal,
      event: async row => { if (row.kind === "launched") abandoned.abort(); } });
    // Then: timeout/abort does not relaunch or turn a later cleanup into success.
    expect(result).toEqual(recovery);
    await bounded(complete.promise);
    expect(f.rows().some(row => row.kind === "cleanup-exit")).toBe(true);
    expect(f.rows().some(row => row.kind === "files-verified")).toBe(false);
    expect(await consumePrivateUpdate(duplicate, { receiptRoot: f.journal, now: () => now })).toEqual(rejected);
    expect(f.rows().filter(row => row.kind === "launched")).toHaveLength(1);
  } finally { watcher.close(); f.cleanup(); }
}, 60_000);
