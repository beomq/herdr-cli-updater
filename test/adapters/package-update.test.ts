import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, cpSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createPackageUpdateSpec, qualifyPackageUpdate } from "../../src/adapters/package-update";
import type { PackageArtifact, PackagePrefixSnapshot, PackageUpdateInput,
  PackageUpdateQualification } from "../../src/adapters/package-update";
import { getPrivateUpdateIntent } from "../../src/adapters/update-context";
import { consumePrivateUpdate } from "../../src/install/update";
import { resourcesOverlap } from "../../src/install/resources";
import type { AdapterResult, InstallationIdentity } from "../../src/adapters/types";

const now = 1_800_000_000_000;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const rejected = { ok: false, error: { code: "verification_failed" } } as const;
const roots: string[] = [];
const tools = realpathSync(mkdtempSync(join(tmpdir(), "package-update-original-npm-")));
const npm = join(tools, "package/bin/npm-cli.js");
beforeAll(async () => {
  // Never invoke or inventory the configured operating manager in regressions.
  const response = await fetch("https://registry.npmjs.org/npm/-/npm-11.19.0.tgz", {
    credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) throw new TypeError(`official npm HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}`
    !== "sha512-SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw==")
    throw new TypeError("official npm integrity mismatch");
  await new Bun.Archive(bytes).extract(tools);
}, 60_000);
afterAll(() => rmSync(tools, { recursive: true, force: true }));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function value<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}
function confinement(root: string): NonNullable<PackageUpdateQualification["confinement"]> {
  return { root, system: { path: "/usr/bin/sandbox-exec", sha256: hash(readFileSync("/usr/bin/sandbox-exec")) } };
}
function put(path: string, body: string | Uint8Array, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body, { mode }); chmodSync(path, mode);
}
function snapshot(prefix: string): PackagePrefixSnapshot {
  const files: { path: string; sha256: string; mode: number }[] = [], links: { path: string; target: string }[] = [];
  const pending = [prefix];
  while (pending.length) {
    const dir = pending.pop(); if (!dir) throw new TypeError("fixture_directory");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), relative = path.slice(prefix.length + 1);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isSymbolicLink()) links.push({ path: relative, target: readlinkSync(path) });
      else files.push({ path: relative, sha256: hash(readFileSync(path)), mode: lstatSync(path).mode & 0o777 });
    }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), links: links.sort((a, b) => a.path.localeCompare(b.path)) };
}
const families = {
  claude: { name: "@anthropic-ai/claude-code", bin: "claude" },
  codex: { name: "@openai/codex", bin: "codex" },
  omp: { name: "@oh-my-pi/pi-coding-agent", bin: "omp" },
  grok: { name: "@xai-official/grok", bin: "grok" },
} as const;
type Family = keyof typeof families;
/** Controlled packages use real Bun and its original generated files. They are
 * regression evidence, not acquired vendor packages or operating installations.
 */
async function fixture(family: Family = "codex", manager: "bun" | "npm" = "bun", postinstall = false, homeOutputs = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-package-")));
  roots.push(root);
  const prefix = join(root, "prefix"), home = join(root, "home"), journal = join(root, "journal");
  for (const path of [prefix, home, journal]) mkdirSync(path, { mode: 0o700 });
  const selected = families[family];
  const managerPath = realpathSync(manager === "npm" ? npm : process.execPath);
  const node = manager === "npm" ? Bun.which("node") : null;
  if (manager === "npm" && !node) throw new TypeError("fixture_node_missing");
  const nodePath = node ? realpathSync(node) : null;
  const env = { HOME: home, PATH: [...new Set([dirname(managerPath), ...(nodePath ? [dirname(nodePath)] : [])])].join(":"),
    ...(manager === "bun" ? { BUN_INSTALL: prefix } : {}) };
  const global = manager === "bun" ? "install/global" : "lib";
  const scriptRuntime = manager === "bun" ? "bun" : "node";
  const packages = new Map<string, { readonly manifest: Record<string, unknown>; readonly bytes: Uint8Array; readonly integrity: string }>();
  const artifacts: PackageArtifact[] = [];
  async function archive(name: string, version: string, installName: string, extra: Record<string, unknown> = {}) {
    const manifest = { name, version, ...extra };
    const bytes = await new Bun.Archive({ "package/package.json": JSON.stringify(manifest),
      "package/cli.js": `#!/usr/bin/env bun\nconsole.log(${JSON.stringify(version)});\n`,
      ...(homeOutputs && name === selected.name ? { "package/entry.js": "#!/usr/bin/env node\n" } : {}) }, { compress: "gzip" }).bytes();
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    packages.set(`${name}@${version}`, { manifest, bytes, integrity });
    const archivePath = join(root, `${artifacts.length}-${hash(name + version)}.tgz`);
    const metadataPath = `${archivePath}.json`;
    put(archivePath, bytes);
    put(metadataPath, JSON.stringify({ ...manifest, dist: { integrity,
      tarball: `https://registry.npmjs.org/${name}/-/package-${version}.tgz` } }));
    const artifact = { name, installName, version, archive: { path: archivePath, sha256: hash(bytes) },
      metadata: { path: metadataPath, sha256: hash(readFileSync(metadataPath)) } };
    return artifact;
  }
  const nativeScript = `node -e "const fs=require('fs'),p=require('path'),v=require('./package.json').version;
const native='native-'+v,body='native-'+v;
fs.writeFileSync(native,body,{mode:0o755});fs.unlinkSync('entry.js');fs.symlinkSync(native,'entry.js');
const bin=p.join(process.env.HOME,'.grok/bin');fs.mkdirSync(bin,{recursive:true});
fs.writeFileSync(p.join(bin,'grok-'+v),body,{mode:0o755});
fs.rmSync(p.join(bin,'grok'),{force:true});fs.symlinkSync('grok-'+v,p.join(bin,'grok'));"`;
  const bin = { [selected.bin]: homeOutputs ? "entry.js" : "cli.js" };
  await archive(selected.name, "1.0.0", selected.name, { bin,
    ...(homeOutputs ? { scripts: { postinstall: nativeScript } }
      : postinstall ? { scripts: { postinstall: `${scriptRuntime} -e "require('fs').writeFileSync('generated.bin','original-before')"` } } : {}) });
  artifacts.push(await archive(selected.name, "1.1.0", selected.name,
    { bin, dependencies: { "fixture-leaf": "1.0.0" }, optionalDependencies: { "absent-platform": "1.0.0" },
      ...(homeOutputs ? { scripts: { postinstall: nativeScript } }
        : postinstall ? { scripts: { postinstall: `${scriptRuntime} -e "require('fs').writeFileSync('generated.bin','original-postinstall')"` } } : {}) }));
  artifacts.push(await archive("fixture-leaf", "1.0.0",
    manager === "bun" ? "fixture-leaf" : `${selected.name}/node_modules/fixture-leaf`));
  // The optional platform row is intentionally absent from both acquired and
  // installed closures. No registry fallback can satisfy it.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), name = decodeURIComponent(url.pathname.slice(1));
    const packed = packages.get(name);
    if (packed) return new Response(packed.bytes);
    const versions = Object.fromEntries([...packages].filter(([, row]) => row.manifest["name"] === name)
      .map(([key, row]) => [String(row.manifest["version"]), { ...row.manifest,
        dist: { integrity: row.integrity, tarball: `${url.origin}/${encodeURIComponent(key)}` } }]));
    return Object.keys(versions).length ? Response.json({ name, versions, "dist-tags": { latest: "1.1.0" } })
      : new Response(null, { status: 404 });
  } });
  const registry = `http://127.0.0.1:${server.port}`;
  async function original(version: string) {
    if (manager === "npm") {
      put(join(root, "user.npmrc"), "", 0o600); put(join(root, "global.npmrc"), "", 0o600);
    }
    const args = manager === "bun"
      ? ["add", "--global", `${selected.name}@${version}`, "--registry", registry, "--cache-dir",
        join(root, `original-cache-${version}`), "--force", "--linker", "hoisted",
        ...(postinstall && version === "1.0.0" ? ["--trust"] : [])]
      : ["install", "--global", "--prefix", prefix, `${selected.name}@${version}`, "--registry", registry,
        "--cache", join(root, `original-cache-${version}`), "--userconfig", join(root, "user.npmrc"),
        "--globalconfig", join(root, "global.npmrc"),
        "--no-audit", "--no-fund", "--fetch-retries", "0", "--force", "--script-shell=/bin/sh"];
    const child = Bun.spawn([managerPath, ...args], {
      cwd: prefix, env, stdout: "pipe", stderr: "pipe",
    });
    const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (status !== 0) throw new TypeError(`original_manager_${status}: ${out} ${err}`);
    if (manager === "npm") return;
    // Original canonical lock locations do not retain this fixture server.
    const path = join(prefix, "install/global/bun.lock");
    const parsed: unknown = Bun.JSON5.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("fixture_lock");
    const lock = Object.fromEntries(Object.entries(parsed));
    const rows = lock["packages"];
    if (typeof rows !== "object" || rows === null) throw new TypeError("fixture_lock");
    for (const row of Object.values(rows)) {
      if (!Array.isArray(row)) throw new TypeError("fixture_lock_row");
      const name = String(row[0]).replace(/@[^@]+$/, ""), version = String(row[0]).slice(name.length + 1);
      row[1] = `https://registry.npmjs.org/${name}/-/package-${version}.tgz`;
    }
    put(path, `${JSON.stringify(lock, null, 2)}\n`);
  }
  let before: PackagePrefixSnapshot, after: PackagePrefixSnapshot;
  let homeSnapshots: PackageUpdateQualification["home"];
  try {
    await original("1.0.0");
    before = snapshot(prefix); cpSync(prefix, join(root, "before"), { recursive: true, dereference: false, verbatimSymlinks: true });
    const beforeHome = snapshot(home);
    if (homeOutputs) cpSync(home, join(root, "before-home"), { recursive: true, dereference: false, verbatimSymlinks: true });
    // Calibration starts from this very before state and same prefix.
    await original("1.1.0");
    after = snapshot(prefix);
    if (homeOutputs) homeSnapshots = { before: beforeHome, after: snapshot(home) };
    if (manager === "bun") put(join(root, "after.lock"), readFileSync(join(prefix, "install/global/bun.lock")));
    rmSync(prefix, { recursive: true });
    cpSync(join(root, "before"), prefix, { recursive: true, dereference: false, verbatimSymlinks: true });
    if (homeOutputs) {
      rmSync(home, { recursive: true });
      cpSync(join(root, "before-home"), home, { recursive: true, dereference: false, verbatimSymlinks: true });
    }
  } finally { await server.stop(true); }
  const executable = realpathSync(join(prefix, global, "node_modules", selected.name, homeOutputs ? "entry.js" : "cli.js"));
  const resources = before.files.map(pin => ({ realpath: join(prefix, pin.path),
    resourceId: `resource:${hash(join(prefix, pin.path))}`, fingerprint: `sha256:${pin.sha256}` }))
    .sort((a, b) => a.realpath.localeCompare(b.realpath));
  const installation: InstallationIdentity = { family, channel: "stable", executableRealpath: executable,
    installationId: `install:${hash(executable)}`, installedVersion: { kind: "known", version: "1.0.0" },
    owner: { kind: "package", manager, packageName: selected.name, prefix }, resources,
    resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
  const managerRoot = dirname(dirname(managerPath));
  const managerFiles = manager === "npm" ? snapshot(managerRoot).files.map(pin =>
    ({ path: join(managerRoot, pin.path), sha256: pin.sha256 })) : [];
  const qualification: PackageUpdateQualification = { installation,
    manager: { name: manager, path: managerPath, sha256: hash(readFileSync(managerPath)), files: managerFiles,
      ...(nodePath ? { node: { path: nodePath, sha256: hash(readFileSync(nodePath)) } } : {}) }, env,
    target: { packageName: selected.name, version: "1.1.0", channel: "stable", checkedAt: now, expiresAt: now + 300_000,
      artifacts, postinstall: homeOutputs ? [{ path: join(dirname(executable), "native-1.1.0"), sha256: hash("native-1.1.0") }]
        : postinstall ? [{ path: join(dirname(executable), "generated.bin"), sha256: hash("original-postinstall") }] : [] }, before, after,
    ...(homeSnapshots ? { home: homeSnapshots, confinement: confinement(root) } : {}),
    ...(manager === "bun" ? { afterLock: { path: join(root, "after.lock"),
      sha256: hash(readFileSync(join(root, "after.lock"))) } } : {}) };
  function authorize(q = qualification): PackageUpdateInput {
    const path = join(root, "receipt.json");
    put(path, JSON.stringify(q), 0o600);
    return { qualification: q, receipt: { path, sha256: hash(readFileSync(path)) } };
  }
  const input = authorize();
  async function spec() {
    const context = value(await qualifyPackageUpdate(input, now));
    return { context, spec: value(createPackageUpdateSpec(context, "update-only", now)) };
  }
  return { root, prefix, home, journal, input, qualification, authorize, spec };
}

test.each(["claude", "codex", "omp", "grok"] as const)(
  "consumes the real exact Bun package update and original closure for %s", async family => {
    // Given: original manager-calibrated before/after, with the source registry closed.
    const f = await fixture(family), before = snapshot(f.prefix);
    const { spec } = await f.spec();
    expect(snapshot(f.prefix)).toEqual(before);
    const receipts: string[] = [];
    // When: the only real mutation goes through the durable consumer.
    const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now,
      event: async receipt => { receipts.push(receipt.kind); } });
    // Then: exit status alone cannot satisfy this original full-file comparison.
    expect(result).toMatchObject({ ok: true, value: { kind: "files-verified", durableReceipt: true } });
    expect(snapshot(f.prefix)).toEqual(f.qualification.after);
    expect(receipts).toEqual(["intent", "dispatch", "launched", "exit"]);
    expect(readdirSync(f.home)).toEqual([]);
    expect((await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now })).ok).toBe(false);
  }, 120_000);

test("consumes the original npm owner with pinned Node and complete manager files", async () => {
  // Given: genuine npm layout, not a Bun-owned prefix reinterpreted as npm.
  const f = await fixture("grok", "npm"), { spec } = await f.spec();
  // When
  const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now });
  // Then
  expect(result).toMatchObject({ ok: true, value: { kind: "files-verified" } });
  expect(snapshot(f.prefix)).toEqual(f.qualification.after);
}, 120_000);

test("confines only the original npm child while the real worker retains process observation", async () => {
  // Given: the exact original npm and Node are pinned, and the worker is ordinary Bun.
  const f = await fixture("codex", "npm");
  const input = f.authorize({ ...f.qualification, confinement: confinement(f.root) });
  const context = value(await qualifyPackageUpdate(input, now));
  const spec = value(createPackageUpdateSpec(context, "update-only", now));
  // When
  const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now });
  const ps = Bun.spawn(["/bin/ps", "-p", String(process.pid), "-o", "pid="], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([ps.exited, new Response(ps.stdout).text(), new Response(ps.stderr).text()]);
  // Then: real package files pass, and worker process observation was not sandboxed.
  expect(result).toMatchObject({ ok: true, value: { kind: "files-verified" } });
  expect(snapshot(f.prefix)).toEqual(f.qualification.after);
  expect(status).toBe(0); expect(stdout.trim()).toBe(String(process.pid)); expect(stderr).toBe("");
}, 120_000);

test("the static child jail refuses outside reads writes and unrelated loopback ports", async () => {
  // Given: a controlled manager process probes the boundary; it cannot attest success.
  const f = await fixture("codex", "npm"), managerRoot = join(f.root, "test-npm");
  const managerPath = join(managerRoot, "bin/npm-cli.js"), secret = join(f.root, "outside-data");
  const forbiddenWrite = join(f.root, "outside-write"), resultPath = join(f.prefix, "probe-result.json");
  put(secret, "controlled-not-credential");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not-the-leased-registry") });
  try {
    put(join(managerRoot, "package.json"), JSON.stringify({ name: "npm", type: "module" }));
    put(managerPath, `#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
const result={readBlocked:false,writeBlocked:false,networkBlocked:false};
try { fs.readFileSync(${JSON.stringify(secret)}); } catch { result.readBlocked=true; }
try { fs.writeFileSync(${JSON.stringify(forbiddenWrite)}, "forbidden"); } catch { result.writeBlocked=true; }
await new Promise(resolve=>{
  const socket=new net.Socket();
  const timer=setTimeout(()=>{socket.destroy();resolve();},5000);
  socket.once("error",()=>{result.networkBlocked=true;clearTimeout(timer);socket.destroy();resolve();});
  socket.once("connect",()=>{clearTimeout(timer);socket.destroy();resolve();});
  socket.connect(${server.port},"127.0.0.1");
});
fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result));
`, 0o755);
    const files = snapshot(managerRoot).files.map(pin => ({ path: join(managerRoot, pin.path), sha256: pin.sha256 }));
    const node = f.qualification.manager.node;
    if (!node) throw new TypeError("fixture_node");
    const q: PackageUpdateQualification = { ...f.qualification, confinement: confinement(f.root),
      manager: { ...f.qualification.manager, path: managerPath, sha256: hash(readFileSync(managerPath)), files },
      env: { ...f.qualification.env, PATH: [dirname(managerPath), dirname(node.path)].join(":") } };
    const context = value(await qualifyPackageUpdate(f.authorize(q), now));
    const spec = value(createPackageUpdateSpec(context, "update-only", now));
    // When
    const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now });
    // Then: denied attempts, authoritative real exit, and no success or replay.
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({ readBlocked: true, writeBlocked: true, networkBlocked: true });
    expect(lstatSync(forbiddenWrite, { throwIfNoEntry: false })).toBeUndefined();
    expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
    expect((await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now })).ok).toBe(false);
  } finally { await server.stop(true); }
}, 120_000);

test("binds original Grok bin links and HOME outputs across a real native path transition", async () => {
  // Given: original before/after calibration includes literal links and both roots.
  const f = await fixture("grok", "npm", false, true), { spec } = await f.spec();
  const home = f.qualification.home;
  if (!home) throw new TypeError("fixture_home");
  const beforeExecutable = f.qualification.installation.executableRealpath;
  expect(spec.mutationResources.some(row => row.realpath === f.prefix)).toBe(true);
  expect(spec.mutationResources.some(row => row.realpath === f.home)).toBe(true);
  // When: only the real child is confined; the original manager performs the update.
  let dispatchObserved = false;
  const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now,
    event: async receipt => {
      if (receipt.kind === "dispatch") {
        expect(snapshot(f.home)).toEqual(home.before);
        dispatchObserved = true;
      }
    } });
  // Then: hashes and literal symlinks match both independently observed originals.
  expect(dispatchObserved).toBe(true);
  expect(result).toMatchObject({ ok: true, value: { kind: "files-verified" } });
  expect(snapshot(f.prefix)).toEqual(f.qualification.after);
  expect(snapshot(f.home)).toEqual(home.after);
  expect(realpathSync(join(f.prefix, "bin/grok"))).not.toBe(beforeExecutable);
  expect(readlinkSync(join(f.home, ".grok/bin/grok"))).toBe("grok-1.1.0");
}, 120_000);

test.each(["system-path", "system-pin", "wider-root", "profile-text", "missing-home", "home-link"] as const)(
  "rejects unbound native confinement or output scope: %s", async defect => {
    // Given: changing a source receipt cannot turn caller descriptors into command authority.
    const f = await fixture("grok", "npm", false, true), q = structuredClone(f.qualification);
    const originalHome = f.qualification.home;
    if (!q.confinement || !q.home || !originalHome) throw new TypeError("fixture_native_scope");
    switch (defect) {
      case "system-path": Reflect.set(q.confinement.system, "path", "/bin/sh"); break;
      case "system-pin": Reflect.set(q.confinement.system, "sha256", "0".repeat(64)); break;
      case "wider-root": Reflect.set(q.confinement, "root", dirname(f.root)); break;
      case "profile-text": Reflect.set(q.confinement, "profile", "(allow default)"); break;
      case "missing-home": Reflect.deleteProperty(q, "home"); break;
      case "home-link": Reflect.set(q.home.after, "links", [{ path: ".grok/bin/grok", target: "../../../outside" }]); break;
    }
    // When / Then
    expect(await qualifyPackageUpdate(f.authorize(q), now)).toEqual(rejected);
    expect(readdirSync(f.journal)).toEqual([]);
    expect(snapshot(f.prefix)).toEqual(f.qualification.before);
    expect(snapshot(f.home)).toEqual(originalHome.before);
  }, 120_000);

test("ignores ancestor npm config in global mode while running the explicit original lifecycle shell", async () => {
  // Given: no system shell directory in PATH, and an ancestor config that would
  // redirect installation and disable scripts if the manager actually loaded it.
  const f = await fixture("claude", "npm", true);
  put(join(f.root, ".npmrc"), "ignore-scripts=true\nscript-shell=/not-authorized\nprefix=/not-authorized\n");
  put(join(f.root, ".bunfig.toml"), "[install]\nregistry='https://example.invalid'\n");
  const { spec } = await f.spec(), shell = process.env["SHELL"];
  process.env["SHELL"] = "/not-authorized";
  try {
    // When: explicit private configs/env, global prefix and /bin/sh are used.
    const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now });
    // Then: the original lifecycle really ran rather than accepting exit0 alone.
    expect(result).toMatchObject({ ok: true, value: { kind: "files-verified" } });
    expect(snapshot(f.prefix)).toEqual(f.qualification.after);
  } finally {
    if (shell === undefined) delete process.env["SHELL"]; else process.env["SHELL"] = shell;
  }
}, 120_000);

test("keeps Bun ancestor configuration outside the admitted boundary", async () => {
  // Given: Bun still performs ancestor discovery; npm's exception must not leak.
  const f = await fixture();
  put(join(f.root, ".npmrc"), "ignore-scripts=true\n");
  // When / Then
  expect(await qualifyPackageUpdate(f.input, now)).toEqual(rejected);
  expect(readdirSync(f.journal)).toEqual([]);
}, 120_000);

test.each(["contents", "hardlink"] as const)("rejects %s drift of explicit private npm configs", async defect => {
  // Given
  const f = await fixture("codex", "npm"), { spec } = await f.spec();
  let launches = 0;
  // When: a notification tampers with the exact config selected by CLI and env.
  const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now,
    event: async event => {
      if (event.kind === "launched") launches++;
      if (event.kind !== "dispatch") return;
      const cache = readdirSync(f.home).find(name => name.startsWith(".herdr-update-cache-"));
      if (!cache) throw new TypeError("fixture_cache_missing");
      const config = join(f.home, cache, "user.npmrc");
      if (defect === "contents") put(config, "ignore-scripts=true\n", 0o600);
      else linkSync(config, join(f.root, "config-link"));
    } });
  // Then: single-link empty config pins are enforced immediately before spawn.
  expect(result).toEqual(rejected); expect(launches).toBe(0);
}, 120_000);

test.each([false, true])("admits redundant source manifest pins only when unchanged: forged=%s", async forged => {
  // Given: acquisition may report unchanged dependency files as postinstall rows.
  const f = await fixture(), path = "install/global/node_modules/fixture-leaf/package.json";
  const original = f.qualification.after.files.find(pin => pin.path === path);
  if (!original) throw new TypeError("fixture_manifest");
  const pin = { ...original, sha256: forged ? hash("forged-identity") : original.sha256 };
  const q: PackageUpdateQualification = { ...f.qualification,
    after: { ...f.qualification.after, files: f.qualification.after.files.map(row => row.path === path ? pin : row) },
    target: { ...f.qualification.target, postinstall: [{ path: join(f.prefix, path), sha256: pin.sha256 }] } };
  // When / Then: original manifest bytes, not the output callback, remain authority.
  const result = await qualifyPackageUpdate(f.authorize(q), now);
  if (forged) expect(result).toEqual(rejected); else expect(result.ok).toBe(true);
}, 120_000);

test.each(["bin-dot", "bin-string", "registry-default-scripts", "lifecycle-drift", "bin-traversal"] as const)(
  "compares original registry normalization without changing archive authority: %s", async normalization => {
    // Given: original npm metadata can normalize bin shorthand and non-install scripts.
    const f = await fixture(), artifact = f.qualification.target.artifacts[0];
    if (!artifact) throw new TypeError("fixture_artifact");
    const meta: Record<string, unknown> = JSON.parse(readFileSync(artifact.metadata.path, "utf8"));
    switch (normalization) {
      case "bin-dot": meta["bin"] = { codex: "./cli.js" }; break;
      case "bin-string": meta["bin"] = "./cli.js"; break;
      case "registry-default-scripts": meta["scripts"] = { start: "node server.js", build: "tsc" }; break;
      case "lifecycle-drift": meta["scripts"] = { postinstall: "node /not-authorized" }; break;
      case "bin-traversal": meta["bin"] = { codex: "../cli.js" }; break;
    }
    put(artifact.metadata.path, JSON.stringify(meta));
    const changed = { ...artifact, metadata: { ...artifact.metadata, sha256: hash(readFileSync(artifact.metadata.path)) } };
    const q = { ...f.qualification, target: { ...f.qualification.target,
      artifacts: f.qualification.target.artifacts.map(row => row === artifact ? changed : row) } };
    // When / Then: lifecycle and path mutations cannot hide behind normalization.
    const result = await qualifyPackageUpdate(f.authorize(q), now);
    if (normalization === "lifecycle-drift" || normalization === "bin-traversal") expect(result).toEqual(rejected);
    else expect(result.ok).toBe(true);
    expect(snapshot(f.prefix)).toEqual(f.qualification.before);
  }, 120_000);

test("covers disjoint installed files sharing the original owned prefix", async () => {
  // Given: an existing unrelated dependency is absent from the selected identity.
  const f = await fixture(), other = await fixture("claude");
  const sibling = join(f.prefix, "install/global/node_modules/unselected/package.json");
  put(sibling, JSON.stringify({ name: "unselected", version: "1.0.0" }));
  const pin = { path: sibling.slice(f.prefix.length + 1), sha256: hash(readFileSync(sibling)), mode: 0o644 };
  const q = { ...f.qualification, before: snapshot(f.prefix),
    after: { ...f.qualification.after, files: [...f.qualification.after.files, pin] } };
  const context = value(await qualifyPackageUpdate(f.authorize(q), now));
  const siblingResources = [{ resourceId: `resource:${hash(sibling)}`, realpath: sibling, fingerprint: `sha256:${pin.sha256}` }];
  expect(resourcesOverlap(q.installation.resources, siblingResources)).toBe(false);
  // When: the authentic issuer adds scope without changing file-based identity.
  const spec = value(createPackageUpdateSpec(context, "update-only", now));
  // Then: every consumer in the shared prefix overlaps, but a separate prefix does not.
  expect(spec.expectedInstallation).toEqual(q.installation);
  expect(spec.mutationResources).toEqual([...q.installation.resources, {
    resourceId: `resource:${hash(f.prefix)}`, realpath: f.prefix,
    fingerprint: `sha256:${hash(JSON.stringify(q.before))}`,
  }]);
  expect(resourcesOverlap(spec.mutationResources, siblingResources)).toBe(true);
  expect(resourcesOverlap(spec.mutationResources, (await other.spec()).spec.mutationResources)).toBe(false);
  expect(getPrivateUpdateIntent(spec).ok).toBe(true);
}, 120_000);

test.each(["remove", "widen", "fingerprint"] as const)(
  "rejects caller attempts to %s the issuer-bound prefix resource", async defect => {
    // Given: the root row exists only on the exact private issued spec.
    const f = await fixture(), { spec } = await f.spec();
    const root = spec.mutationResources.find(row => row.realpath === f.prefix);
    if (!root) throw new TypeError("fixture_prefix_resource");
    const mutationResources = defect === "remove" ? [...f.qualification.installation.resources]
      : spec.mutationResources.map(row => row !== root ? row : defect === "widen"
        ? { ...row, realpath: f.root, resourceId: `resource:${hash(f.root)}` }
        : { ...row, fingerprint: `sha256:${"0".repeat(64)}` });
    Reflect.set(spec, "mutationResources", mutationResources);
    // When / Then: neither the descriptor nor retaining spec identity grants scope.
    expect(getPrivateUpdateIntent(spec)).toEqual(rejected);
    expect(await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now })).toEqual(rejected);
    expect(readdirSync(f.journal)).toEqual([]); expect(readdirSync(f.home)).toEqual([]);
    expect(snapshot(f.prefix)).toEqual(f.qualification.before);
  }, 120_000);

test("verifies original package postinstall outputs through the actual manager", async () => {
  // Given: independent calibration ran the original trusted lifecycle script.
  const f = await fixture("omp", "bun", true), { spec } = await f.spec();
  // When
  const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now });
  // Then: neither a callback nor a manufactured target file supplies this output.
  expect(snapshot(f.prefix)).toEqual(f.qualification.after);
  expect(result).toMatchObject({ ok: true, value: { kind: "files-verified" } });
}, 120_000);

test("refuses an actual zero-exit no-change manager and never retries it", async () => {
  // Given: a pinned controlled process, not a callback certifying its own success.
  const f = await fixture(), manager = join(f.root, "no-change");
  put(manager, `#!${process.execPath}\nprocess.exit(0);\n`, 0o755);
  const q = { ...f.qualification, manager: { name: "bun", path: manager, sha256: hash(readFileSync(manager)), files: [] } as const,
    env: { ...f.qualification.env, PATH: dirname(manager) } };
  const context = value(await qualifyPackageUpdate(f.authorize(q), now));
  const spec = value(createPackageUpdateSpec(context, "update-only", now));
  let launches = 0, exits = 0;
  // When
  const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now,
    event: async receipt => { if (receipt.kind === "launched") launches++; if (receipt.kind === "exit") exits++; } });
  // Then
  expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
  expect(launches).toBe(1); expect(exits).toBe(1);
  expect((await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now })).ok).toBe(false);
  expect(launches).toBe(1);
}, 120_000);

test("does not certify actual zero exit when installed payload files mismatch", async () => {
  // Given
  const f = await fixture(), { spec } = await f.spec();
  // When: a post-exit write changes only a payload file, not package metadata.
  const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now,
    event: async receipt => { if (receipt.kind === "exit") put(f.qualification.installation.executableRealpath, "changed"); } });
  // Then
  expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
}, 120_000);

test("qualifies a large hardlinked native postinstall leaf without relaxing control file links", async () => {
  // Given: a sparse native output larger than the old blanket 256 MiB ceiling.
  const f = await fixture(), path = join(dirname(f.qualification.installation.executableRealpath), "native-leaf");
  const size = 257 * 1024 * 1024, fd = openSync(path, "wx", 0o755);
  try { ftruncateSync(fd, size); } finally { closeSync(fd); }
  linkSync(path, join(f.root, "native-cache-link"));
  const sha = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024);
  for (let offset = 0; offset < size; offset += chunk.length) sha.update(chunk);
  const pin = { path: path.slice(f.prefix.length + 1), sha256: sha.digest("hex"), mode: 0o755 };
  const q: PackageUpdateQualification = { ...f.qualification,
    before: { ...f.qualification.before, files: [...f.qualification.before.files, pin] },
    after: { ...f.qualification.after, files: [...f.qualification.after.files, pin] },
    target: { ...f.qualification.target, postinstall: [{ path, sha256: pin.sha256 }] } };
  // When / Then: bounded read-only streaming accepts the actual hardlinked file.
  expect((await qualifyPackageUpdate(f.authorize(q), now)).ok).toBe(true);
  // Private control files keep their single-link boundary.
  linkSync(join(f.root, "receipt.json"), join(f.root, "receipt-alias"));
  expect(await qualifyPackageUpdate({ qualification: q, receipt: { path: join(f.root, "receipt.json"),
    sha256: hash(readFileSync(join(f.root, "receipt.json"))) } }, now)).toEqual(rejected);
}, 120_000);

test.each(["copy", "json", "context", "command", "intent"] as const)(
  "rejects forged package %s authority before any consumer effects", async defect => {
    // Given
    const f = await fixture(), { context, spec } = await f.spec();
    // When
    switch (defect) {
      case "copy": expect(await consumePrivateUpdate({ ...spec }, { receiptRoot: f.journal, now: () => now })).toEqual(rejected); break;
      case "json": expect(await consumePrivateUpdate(JSON.parse(JSON.stringify(spec)), { receiptRoot: f.journal, now: () => now })).toEqual(rejected); break;
      case "context":
        Reflect.set(spec, "execution", { ...context });
        expect(await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now })).toEqual(rejected); break;
      case "command":
        Reflect.set(spec.command, "args", ["add", "--global", "@openai/codex@99.0.0"]);
        expect(await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now })).toEqual(rejected); break;
      case "intent":
        expect(createPackageUpdateSpec(context, { ...value(getPrivateUpdateIntent(spec)), targetFingerprint: "forged" }, now)).toEqual(rejected); break;
    }
    // Then
    expect(readdirSync(f.journal)).toEqual([]); expect(readdirSync(f.home)).toEqual([]);
    expect(snapshot(f.prefix)).toEqual(f.qualification.before);
  }, 120_000);

test.each(["owner", "family", "native", "archive", "sri", "metadata", "closure", "before", "after", "lock"] as const)(
  "rejects package acquisition %s mismatch without effects", async defect => {
    // Given: independently repinning the outer receipt cannot repair contradictory evidence.
    const f = await fixture();
    let q = f.qualification;
    const artifact = q.target.artifacts[0]; if (!artifact) throw new TypeError("fixture_artifact");
    switch (defect) {
      case "owner": q = { ...q, manager: { ...q.manager, name: "npm" } }; break;
      case "family": q = { ...q, installation: { ...q.installation, family: "claude" } }; break;
      case "native": q = { ...q, installation: { ...q.installation, owner: { kind: "native", prefix: f.prefix, installerDigest: "source" } } }; break;
      case "archive": put(artifact.archive.path, "not-the-pinned-archive"); break;
      case "sri": {
        const bytes = Buffer.concat([readFileSync(artifact.archive.path), Buffer.from([0])]);
        put(artifact.archive.path, bytes);
        q = { ...q, target: { ...q.target, artifacts: q.target.artifacts.map(row => row === artifact
          ? { ...row, archive: { ...row.archive, sha256: hash(bytes) } } : row) } };
        break;
      }
      case "metadata": put(artifact.metadata.path, JSON.stringify({ name: artifact.name, version: "99.0.0" })); break;
      case "closure": q = { ...q, target: { ...q.target, artifacts: [artifact] } }; break;
      case "before": q = { ...q, before: { ...q.before, files: q.before.files.slice(1) } }; break;
      case "after": q = { ...q, after: { ...q.after, files: q.after.files.slice(1) } }; break;
      case "lock": {
        if (!q.afterLock) throw new TypeError("fixture_lock");
        put(q.afterLock.path, "{}"); break;
      }
    }
    // When / Then
    expect(await qualifyPackageUpdate(f.authorize(q), now)).toEqual(rejected);
    expect(readdirSync(f.journal)).toEqual([]); expect(readdirSync(f.home)).toEqual([]);
  }, 120_000);

test.each(["config", "slot", "target"] as const)(
  "refuses %s drift in the final dispatch notification before manager spawn", async defect => {
    // Given
    const f = await fixture(), { spec } = await f.spec();
    let launches = 0;
    // When
    const result = await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now,
      event: async receipt => {
        if (receipt.kind === "launched") launches++;
        if (receipt.kind !== "dispatch") return;
        if (defect === "config") put(join(f.home, ".npmrc"), "registry=https://example.invalid");
        if (defect === "target") put(f.input.qualification.target.artifacts[0]?.archive.path ?? "", "drift");
        if (defect === "slot") {
          const path = join(f.prefix, "install/global/node_modules/fixture-leaf");
          const outside = join(f.root, "outside"); mkdirSync(outside); symlinkSync(outside, path);
        }
      } });
    // Then
    expect(result).toEqual(rejected); expect(launches).toBe(0);
    expect((await consumePrivateUpdate(spec, { receiptRoot: f.journal, now: () => now })).ok).toBe(false);
  }, 120_000);
