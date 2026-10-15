import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash, Hash } from "node:crypto";
import * as processes from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, renameSync, truncateSync, utimesSync, writeSync, openSync, closeSync } from "node:fs";
import type { BigIntStats, StatOptions, Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { discoverExecutable, probeExecutable } from "../src/discovery";
import type { DiscoveryInput } from "../src/discovery";
import { capabilitySupported, parseAdapterContract } from "../src/adapters/types";
import type { InstallationOwner } from "../src/protocol";

const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
// Mutable lifecycle registry; each test owns a fresh, isolated directory.
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "task7-discovery-")));
  roots.push(root);
  const executable = join(root, "bin", "omo");
  const manifest = join(root, "package.json");
  await mkdir(join(root, "bin"));
  await writeFile(executable, `#!${process.execPath}\nconst a=process.argv.slice(2); if(a.length!==1) process.exit(2);
if(a[0]==="--version") console.log("omo 1.2.3");
else if(a[0]==="--help") console.log(JSON.stringify({args:a,cwd:process.cwd(),env:process.env}));
else process.exit(3);\n`);
  await chmod(executable, 0o700);
  await writeFile(manifest, JSON.stringify({ name: "fixture-omo", version: "1.2.3", bin: { omo: "bin/omo" }, packageManager: "bun@1.4.2" }));
  const owner: InstallationOwner = { kind: "package", manager: "bun", packageName: "fixture-omo", prefix: root };
  const receipt: {
    family: string; executable: string; channel: string; owner: InstallationOwner;
    packageManifest: string | null; resources: { path: string; sha256: string }[];
  } = {
    family: "omo", executable, channel: "fixture", owner, packageManifest: manifest,
    resources: [
      { path: executable, sha256: hash(await readFile(executable)) },
      { path: manifest, sha256: hash(await readFile(manifest)) },
    ],
  };
  const path = join(root, "ownership.json");
  const pin = async () => {
    const body = JSON.stringify(receipt);
    await writeFile(path, body);
    return { path, sha256: hash(body) };
  };
  const provenance = [await pin()];
  const input: DiscoveryInput = { executable, family: "omo", provenance };
  return { root, executable, manifest, receipt, input, pin };
}
async function discovered(input: DiscoveryInput) {
  const result = await discoverExecutable(input);
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}

test("collapses real symlink and qualified literal shim aliases", async () => {
  // Given: three names for one physical executable.
  const f = await fixture();
  const alias = join(f.root, "alias");
  const shim = join(f.root, "shim");
  await symlink(f.executable, alias);
  await writeFile(shim, `#!/bin/sh\nexec "${f.executable}" "$@"\n`);
  await chmod(shim, 0o700);
  // When: production discovery reads actual filesystem targets.
  const rows = await Promise.all([f.executable, alias, shim].map(executable => discovered({ ...f.input, executable })));
  // Then: aliases have the same stable identity and fingerprint, no duplicate resource.
  expect(new Set(rows.map(row => row.installation.installationId)).size).toBe(1);
  expect(new Set(rows.map(row => row.installation.resourcesFingerprint)).size).toBe(1);
  expect(rows.map(row => row.installation.executableRealpath)).toEqual(Array(3).fill(f.executable));
});
test.each(["npm", "bun", "homebrew"] as const)("reads pinned %s ownership without implying support", async manager => {
  // Given: digest-pinned isolated ownership metadata.
  const f = await fixture();
  f.receipt.owner = { kind: "package", manager, packageName: "fixture-omo", prefix: f.root };
  const provenance = [await f.pin()];
  // When: observed files are qualified.
  const row = await discovered({ ...f.input, provenance });
  // Then: machine fields agree but no capability is inferred from identity.
  expect(row.qualification).toEqual({ kind: "known" });
  expect(row.installation.owner).toEqual(f.receipt.owner);
  expect(row.installation.channel).toBe("fixture");
  expect(Object.values(row.capabilities).map(capabilitySupported)).toEqual(Array(6).fill(false));
  expect(parseAdapterContract({ version: 1, family: "omo", installation: row.installation, runtime: null, capabilities: row.capabilities }).ok).toBe(true);
});
test("keeps manager and channel unknown despite packageManager metadata", async () => {
  // Given: package metadata but no independently pinned owner.
  const f = await fixture();
  // When: discovery reads the bin-bound manifest.
  const row = await discovered({ executable: f.executable, family: "omo", probe: { cwd: f.root } });
  // Then: manifest version is installed evidence, not manager/channel qualification.
  expect(row.qualification).toEqual({ kind: "unknown", reason: "unverified_owner" });
  expect(row.installation.owner).toEqual({ kind: "unknown", reason: "unverified_owner" });
  expect(row.installation.channel).toBe("unknown");
  expect(row.installation.installedVersion).toEqual({ kind: "known", version: "1.2.3" });
});
test.each([false, true])("canonicalizes symlink manifest resources with pinned owner %s", async pinned => {
  // Given: package.json is an alias of physical metadata.json; executable has an alias too.
  const f = await fixture();
  const metadata = join(f.root, "metadata.json");
  const alias = join(f.root, "omo-alias");
  await rename(f.manifest, metadata);
  await symlink(metadata, f.manifest);
  await symlink(f.executable, alias);
  const metadataHash = hash(await readFile(metadata));
  const input: DiscoveryInput = pinned ? f.input : { executable: f.executable, family: "omo" };
  // When: actual discovery reads both executable names and the symlinked manifest.
  const [direct, linked] = await Promise.all([
    discovered(input), discovered({ ...input, executable: alias }),
  ]);
  // Then: only physical metadata is a resource, with stable canonical alias identity.
  const receiptPath = f.input.provenance?.[0]?.path;
  if (!receiptPath) throw new TypeError("fixture missing receipt");
  expect(direct.installation.resources.map(row => row.realpath).sort())
    .toEqual([f.executable, metadata, ...(pinned ? [receiptPath] : [])].sort());
  expect(direct.installation.resources.find(row => row.realpath === metadata)).toEqual({
    resourceId: `resource:${hash(metadata)}`, realpath: metadata, fingerprint: `sha256:${metadataHash}`,
  });
  expect(linked.installation).toEqual(direct.installation);
});
test("qualifies pinned native ownership and observed version without package guesses", async () => {
  // Given: native provenance binds actual executable bytes, not a package name.
  const f = await fixture();
  f.receipt.owner = { kind: "native", installerDigest: "sha256:fixture", prefix: f.root };
  f.receipt.packageManifest = null;
  // When: the owned executable's readonly version runs.
  const row = await discovered({ ...f.input, provenance: [await f.pin()], probe: { cwd: f.root } });
  // Then: pinned identity and installed version agree, still no update support.
  expect(row.qualification).toEqual({ kind: "known" });
  expect(row.installation.owner).toEqual(f.receipt.owner);
  expect(row.installation.installedVersion).toEqual({ kind: "known", version: "1.2.3" });
});
test("binds a literal package bin symlink to the independently declared native bytes", async () => {
  const f = await fixture(), alias = join(f.root, "bin", "launcher");
  await symlink("omo", alias);
  await writeFile(f.manifest, JSON.stringify({ name: "fixture-omo", version: "1.2.3", bin: { omo: "bin/launcher" } }));
  f.receipt.resources[1] = { path: f.manifest, sha256: hash(await readFile(f.manifest)) };
  const result = await discovered({ ...f.input, provenance: [await f.pin()] });
  expect(result.installation.executableRealpath).toBe(f.executable);
  expect(result.installation.owner).toEqual(f.receipt.owner);
  expect(result.installation.installedVersion).toEqual({ kind: "known", version: "1.2.3" });
});
test.each(["channel", "manifest", "unrelated-bin"] as const)("rejects unqualified %s claims", async part => {
  // Given: malformed channel, package ownership mismatch, or unrelated bin binding.
  const f = await fixture();
  if (part === "channel") f.receipt.channel = "unknown";
  else {
    await writeFile(f.manifest, JSON.stringify({ name: part === "manifest" ? "other" : "fixture-omo", version: "1.2.3", bin: "bin/unrelated" }));
    f.receipt.resources[1] = { path: f.manifest, sha256: hash(await readFile(f.manifest)) };
  }
  // When / Then: a matching digest alone cannot qualify mismatched ownership.
  expect(await discoverExecutable({ ...f.input, provenance: [await f.pin()] }))
    .toEqual({ ok: false, error: { code: "invalid_provenance" } });
});
test("blocks ambiguous ownership without probing executable", async () => {
  // Given: conflicting sources and a version program that would fail if launched.
  const f = await fixture();
  await writeFile(f.executable, `#!${process.execPath}\nthrow new Error("must not probe");\n`);
  // When: both owner candidates are presented.
  const row = await discovered({ ...f.input, provenance: [...f.input.provenance ?? [], ...f.input.provenance ?? []], probe: { cwd: f.root } });
  // Then: ambiguity remains visible, with unknown owner and capabilities.
  expect(row.qualification).toEqual({ kind: "unknown", reason: "ambiguous_owner" });
  expect(row.installation.owner.kind).toBe("unknown");
  expect(row.capabilities.update.kind).toBe("unknown");
});
test.each(["missing", "broken_link", "link_loop", "not_executable", "unverified_shim"] as const)(
  "classifies actual %s filesystem failure", async code => {
    // Given: concrete filesystem failure, not a mocked realpath call.
    const f = await fixture();
    const path = join(f.root, "candidate");
    switch (code) {
      case "missing": break;
      case "broken_link": await symlink(join(f.root, "absent"), path); break;
      case "link_loop": await symlink(path, path); break;
      case "not_executable": await writeFile(path, "data"); break;
      case "unverified_shim": await writeFile(path, '#!/bin/sh\necho fake-owner\n'); await chmod(path, 0o700); break;
    }
    // When / Then: no actionable installation or probe is returned.
    expect(await discoverExecutable({ executable: path, family: "omo" })).toEqual({ ok: false, error: { code } });
  },
);
test("rejects an executable exec-shim cycle", async () => {
  // Given: literal shims refer to each other.
  const f = await fixture();
  const a = join(f.root, "a"), b = join(f.root, "b");
  await writeFile(a, `#!/bin/sh\nexec "${b}" "$@"\n`);
  await writeFile(b, `#!/bin/sh\nexec "${a}" "$@"\n`);
  await chmod(a, 0o700); await chmod(b, 0o700);
  // When / Then: bounded resolution rejects the cycle.
  expect(await discoverExecutable({ executable: a, family: "omo" })).toEqual({ ok: false, error: { code: "link_loop" } });
});
test("classifies a literal shim pointing to a missing executable as broken", async () => {
  // Given: qualified grammar references an absent physical target.
  const f = await fixture();
  const shim = join(f.root, "broken-shim");
  await writeFile(shim, `#!/bin/sh\nexec "${join(f.root, "absent")}" "$@"\n`);
  await chmod(shim, 0o700);
  // When / Then: missing install and broken wrapper remain distinguishable.
  expect(await discoverExecutable({ executable: shim, family: "omo" }))
    .toEqual({ ok: false, error: { code: "broken_link" } });
});
test.each(["executable", "manifest", "receipt"] as const)("rejects stale %s digest", async part => {
  // Given: an artifact changed after the source was pinned.
  const f = await fixture();
  const path = part === "executable" ? f.executable : part === "manifest" ? f.manifest : f.input.provenance?.[0]?.path;
  if (!path) throw new TypeError("fixture missing path");
  await writeFile(path, (await readFile(path, "utf8")) + " ");
  // When / Then: actual bytes, not mtime or a cached version, invalidate provenance.
  expect(await discoverExecutable(f.input)).toEqual({ ok: false, error: { code: "stale_provenance" } });
});
test("changes fingerprint but not physical identity after installed version drift", async () => {
  // Given: same physical package with a changed bin-bound manifest.
  const f = await fixture();
  const old = await discovered({ executable: f.executable, family: "omo" });
  await writeFile(f.manifest, JSON.stringify({ name: "fixture-omo", version: "2.0.0", bin: "bin/omo" }));
  // When: it is rediscovered.
  const current = await discovered({ executable: f.executable, family: "omo" });
  // Then: stale selections differ; no runningVersion/binding was invented.
  expect(current.installation.installationId).toBe(old.installation.installationId);
  expect(current.installation.resourcesFingerprint).not.toBe(old.installation.resourcesFingerprint);
  expect(current.installation.installedVersion).toEqual({ kind: "known", version: "2.0.0" });
  expect(Object.keys(current.installation).sort()).toEqual(["channel", "executableRealpath", "family", "installationId", "installedVersion", "owner", "resources", "resourcesFingerprint"]);
});
test("invalidates qualification when actual version disagrees with manifest", async () => {
  // Given: digest-consistent executable reports a different installed version.
  const f = await fixture();
  await writeFile(f.executable, `#!${process.execPath}\nconsole.log("omo 9.0.0");\n`);
  f.receipt.resources[0] = { path: f.executable, sha256: hash(await readFile(f.executable)) };
  // When: the readonly executable probe actually runs.
  const row = await discovered({ ...f.input, provenance: [await f.pin()], probe: { cwd: f.root } });
  // Then: neither stale manifest nor current process output becomes runtime evidence.
  expect(row.qualification).toEqual({ kind: "unknown", reason: "stale_provenance" });
  expect(row.installation.installedVersion).toEqual({ kind: "unknown", reason: "probe_failed" });
  expect(row.capabilities.update.kind).toBe("unknown");
});
test("collapses OmO and owned Senpi into one compound installation", async () => {
  // Given: an owned engine resource is attested by the same pinned owner.
  const f = await fixture();
  const engine = join(f.root, "bin", "pi");
  await writeFile(engine, `#!${process.execPath}\nconsole.log("pi 7.0.0");\n`);
  await chmod(engine, 0o700);
  f.receipt.resources.push({ path: engine, sha256: hash(await readFile(engine)) });
  f.receipt.owner = { kind: "wrapper", packageName: "fixture-omo", prefix: f.root, engineResourceId: `resource:${hash(engine)}` };
  const provenance = [await f.pin()];
  // When: both entrypoints are discovered.
  const [wrapper, owned] = await Promise.all([
    discovered({ ...f.input, provenance }),
    discovered({ executable: engine, family: "pi", provenance }),
  ]);
  // Then: engine does not become an independently updatable install.
  expect(owned.installation).toEqual(wrapper.installation);
  expect(owned.installation.family).toBe("omo");
  expect(owned.capabilities.update.kind).toBe("unknown");
});
test("executes explicit readonly argv with cwd and allowlisted environment", async () => {
  // Given: real executable whose help exposes its effective invocation.
  const f = await fixture();
  // When: direct help probe receives only allowed settings.
  const result = await probeExecutable({ executable: f.executable, argument: "--help", cwd: f.root, environment: { LANG: "C" } });
  // Then: no inherited secret env, prompt or additional argument enters the child.
  expect(result.ok).toBe(true);
  if (!result.ok) throw new TypeError(result.error.code);
  expect(JSON.parse(result.value.stdout)).toEqual({ args: ["--help"], cwd: f.root, env: { LANG: "C", LC_ALL: "C" } });
});
test("rejects secret environment keys before spawning", async () => {
  // Given: unknown caller data adds an unallowlisted secret field.
  const f = await fixture();
  const environment = { LANG: "C", API_TOKEN: "ULW_SECRET_REDACTION_6fb9" };
  // When / Then: invalid boundary input yields only a safe code.
  expect(await probeExecutable({ executable: f.executable, argument: "--version", cwd: f.root, environment }))
    .toEqual({ ok: false, error: { code: "invalid_probe" } });
});
test("bounds actual child timeout and waits for exit", async () => {
  // Given: a real child that cannot complete; elapsed time is the behavior under test.
  const f = await fixture();
  await writeFile(f.executable, `#!${process.execPath}\nwhile(true) {}\n`);
  // When: the production deadline stops the actual child.
  const result = await probeExecutable({ executable: f.executable, argument: "--version", cwd: f.root, timeoutMs: 500, maxBytes: 1024 });
  // Then: completion occurs only after child close, without raw output on failure.
  expect(result).toEqual({ ok: false, error: { code: "timeout" } });
});
test.each(["output_limit", "probe_failed"] as const)("bounds actual child %s and waits for exit", async code => {
  // Given: a real child waits for a test-owned input after announcing READY.
  const f = await fixture();
  const action = code === "output_limit" ? 'process.stdout.write("x".repeat(100000));' : "process.exit(3);";
  await writeFile(f.executable, `#!${process.execPath}\nprocess.stdin.once("data",()=>{${action}});process.stdout.write("READY\\n");\n`);
  const child = processes.spawn(f.executable, ["--version"], {
    cwd: f.root, env: { LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const ready = once(lines, "line", { signal: AbortSignal.timeout(5000) });
  const closed = once(child, "close", { signal: AbortSignal.timeout(10000) }).then(
    value => ({ kind: "closed", value } as const),
    (error: unknown) => ({ kind: "failed", error } as const),
  );
  // Only the creation seam is redirected; bytes, events, exit and kill are genuine.
  const redirect = spyOn(processes, "spawn").mockReturnValue(child);
  try {
    expect(await ready).toEqual(["READY"]);
    lines.close();
    // When: production listeners attach before the child is told to fail.
    // This deadline bounds awaiting the outcome, not this child's startup.
    const pending = probeExecutable({ executable: f.executable, argument: "--version", cwd: f.root, timeoutMs: 5000, maxBytes: 1024 });
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(f.executable, ["--version"], {
      cwd: f.root, env: { LANG: "C", LC_ALL: "C" }, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    // readline.close() pauses its input; restore flowing mode after executor listeners attach.
    child.stdout.resume();
    child.stdin.write("GO\n");
    const result = await pending;
    const outcome = await closed;
    if (outcome.kind === "failed") throw outcome.error;
    // Then: actual nonzero exit or output-limit kill determines the exact result.
    expect(outcome.value).toEqual(code === "probe_failed" ? [3, null] : [null, "SIGKILL"]);
    expect(result).toEqual({ ok: false, error: { code } });
  } finally {
    redirect.mockRestore();
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const outcome = await closed;
    if (outcome.kind === "failed") throw outcome.error;
  }
}, 15000);

async function largeNative(size: number) {
  const f = await fixture();
  await rm(f.manifest);
  const handle = await open(f.executable, "w");
  try { await handle.truncate(size); } finally { await handle.close(); }
  // Independent expected digest: zero-filled sparse file, 1 MiB oracle chunks.
  const oracle = createHash("sha256");
  const zeros = Buffer.alloc(1024 * 1024);
  for (let offset = 0; offset < size; offset += zeros.length)
    oracle.update(zeros.subarray(0, Math.min(zeros.length, size - offset)));
  const sha256 = oracle.digest("hex");
  f.receipt.owner = { kind: "native", installerDigest: "sha256:fixture", prefix: f.root };
  f.receipt.packageManifest = null;
  f.receipt.resources = [{ path: f.executable, sha256 }];
  const input = { ...f.input, provenance: [await f.pin()] };
  return { ...f, input, sha256 };
}

test.each([237989072, 227827120, 186868816])("streams pinned native resource of %s bytes without probing", async size => {
  // Given: actual native-sized regular files, without any runnable program or probe.
  const f = await largeNative(size);
  // When: production discovery hashes both the entrypoint and the pinned resource.
  const row = await discovered(f.input);
  // Then: exact independent SHA256 and pinned owner qualify, not updater support.
  expect(row.qualification).toEqual({ kind: "known" });
  expect(row.installation.resources.find(row => row.realpath === f.executable)?.fingerprint)
    .toBe(`sha256:${f.sha256}`);
  expect(row.installation.owner).toEqual(f.receipt.owner);
  expect(row.installation.installedVersion).toEqual({ kind: "unknown", reason: "not_captured" });
  expect(Object.values(row.capabilities).map(capabilitySupported)).toEqual(Array(6).fill(false));
});

test("rejects stale digest of a resource above 64 MiB", async () => {
  // Given: a pinned large native file with a wrong expected digest.
  const f = await largeNative(64 * 1024 * 1024 + 17);
  f.receipt.resources[0] = { path: f.executable, sha256: "f".repeat(64) };
  // When / Then: streaming does not weaken provenance comparison.
  expect(await discoverExecutable({ ...f.input, provenance: [await f.pin()] }))
    .toEqual({ ok: false, error: { code: "stale_provenance" } });
});

test.each(["changed", "replaced", "truncated", "nonregular"] as const)(
  "rejects %s resource during incremental hashing", async action => {
    // Given: real filesystem mutation at the first synchronous hash-update barrier.
    const f = await largeNative(64 * 1024 * 1024 + 17);
    const replacement = join(f.root, "replacement");
    if (action === "replaced") copyFileSync(f.executable, replacement);
    const before = await lstat(f.executable);
    const update = Hash.prototype.update;
    let mutations = 0;
    const barrier = spyOn(Hash.prototype, "update").mockImplementation(function (this: Hash, data, encoding) {
      const result = update.call(this, data, encoding);
      if (mutations === 0 && data instanceof Uint8Array && data.byteLength === 64 * 1024) {
        mutations++;
        if (action === "changed") {
          const fd = openSync(f.executable, "r+");
          try { writeSync(fd, Buffer.from([1]), 0, 1, 0); } finally { closeSync(fd); }
          // Already-hashed byte changed, original mtime restored: ctime still exposes it.
          utimesSync(f.executable, before.atime, before.mtime);
        } else if (action === "replaced") renameSync(replacement, f.executable);
        else if (action === "truncated") truncateSync(f.executable, 1);
        else {
          renameSync(f.executable, replacement);
          // Replace the pathname with a directory at the synchronous barrier.
          mkdirSync(f.executable);
        }
      }
      return result;
    });
    let result;
    try {
      // When: actual descriptor reads and SHA256 updates traverse the mutation.
      // No second provenance read may mask a missing snapshot guard.
      result = await discoverExecutable({ executable: f.executable, family: "omo" });
    } finally { barrier.mockRestore(); }
    // Then: the barrier ran once and exact failure prevents a qualified snapshot.
    expect(mutations).toBe(1);
    expect(result).toEqual({ ok: false, error: { code: "stale_provenance" } });
  },
);

test.each(["manifest", "receipt"] as const)("keeps %s JSON bounded to 64 KiB", async part => {
  // Given: valid JSON made oversized by insignificant whitespace.
  const f = await fixture();
  const path = part === "manifest" ? f.manifest : f.input.provenance?.[0]?.path;
  if (!path) throw new TypeError("fixture missing receipt");
  await writeFile(path, (await readFile(path, "utf8")) + " ".repeat(64 * 1024));
  // When / Then: resource streaming does not increase metadata limits.
  expect(await discoverExecutable(f.input)).toEqual({ ok: false, error: { code: "invalid_provenance" } });
});

test("rejects pathname replacement after final descriptor snapshot", async () => {
  // Given: an exact barrier after the real post-read fstat, before the pathname check.
  const f = await largeNative(64 * 1024 * 1024 + 17);
  const replacement = join(f.root, "replacement");
  copyFileSync(f.executable, replacement);
  const actualOpen = filesystem.open;
  const handles: FileHandle[] = [];
  const restores: (() => void)[] = [];
  let mutations = 0;
  const barrier = spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await actualOpen(path, flags, mode);
    handles.push(handle);
    const actualStat = handle.stat.bind(handle);
    let snapshots = 0;
    function observedStat(options?: StatOptions & { bigint?: false }): Promise<Stats>;
    function observedStat(options: StatOptions & { bigint: true }): Promise<BigIntStats>;
    function observedStat(options?: StatOptions): Promise<Stats | BigIntStats>;
    async function observedStat(options?: StatOptions): Promise<Stats | BigIntStats> {
      const snapshot = await actualStat(options);
      if (options?.bigint && ++snapshots === 2 && mutations === 0) {
        mutations++;
        renameSync(replacement, f.executable);
      }
      return snapshot;
    }
    const intercepted = spyOn(handle, "stat").mockImplementation(observedStat);
    restores.push(() => intercepted.mockRestore());
    return handle;
  });
  let result;
  try {
    // When: production reads a stable descriptor whose pathname is then replaced.
    result = await discoverExecutable({ executable: f.executable, family: "omo" });
  } finally { barrier.mockRestore(); for (const restore of restores) restore(); }
  // Then: a valid digest on the old inode cannot validate the replacement.
  expect(mutations).toBe(1);
  expect(result).toEqual({ ok: false, error: { code: "stale_provenance" } });
  for (const handle of handles) await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
});

test("rejects a nonregular pinned resource before opening it", async () => {
  // Given: provenance declares a directory as a mutation resource.
  const f = await fixture();
  f.receipt.resources.push({ path: join(f.root, "bin"), sha256: "0".repeat(64) });
  // When / Then: nonregular resources cannot be fingerprinted or qualify ownership.
  expect(await discoverExecutable({ ...f.input, provenance: [await f.pin()] }))
    .toEqual({ ok: false, error: { code: "invalid_provenance" } });
});
