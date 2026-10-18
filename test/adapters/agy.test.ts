import { afterEach, expect, spyOn, test } from "bun:test";
import { Hash } from "node:crypto";
import * as filesystem from "node:fs";
import type { BigIntStats, StatOptions, Stats } from "node:fs";
import { closeSync, copyFileSync, mkdirSync, openSync, renameSync, truncateSync, utimesSync, writeSync } from "node:fs";
import { lstat, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgyAdapter, AGY_INSTALLER_SHA256 } from "../../src/adapters/agy";
import { digest, fixture, sourceRoot } from "../fixtures/evidence/task-14/fixture";
import type { FailureCode } from "../../src/protocol";
import { hostileThrowKinds, privacyProbe, throwKinds } from "../fixtures/evidence/task-14/privacy";
import { manualProbe } from "../fixtures/evidence/task-14/manual";
import { largeResource, loadAdapter, nativeSize } from "../fixtures/evidence/task-14/r4/resource-fixture";
import { concurrentManualCheck } from "../fixtures/evidence/task-14/r4/cleanup-overlap";
import { artifactTest } from "../fixtures/artifacts";

// Each actual filesystem/probe is isolated; no installed binary is ever invoked.
const roots: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of roots.splice(0)) {
    await f.cleanup();
    await expect(lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
async function isolated() {
  const f = await fixture();
  roots.push(f);
  return f;
}
const failed = (code: FailureCode) => ({ ok: false, error: { code } } as const);

test("observes native fixture bytes and bare machine version using direct argv", async () => {
  const f = await isolated();
  // The path has spaces and a semicolon; a shell launch or extra argv exits 71.
  const i = await f.installation();
  expect(i.owner.kind).toBe("native");
  expect(i.installedVersion).toEqual({ kind: "known", version: "1.2.12" });
  expect(await f.adapter.version(i)).toEqual({ ok: true, value: i.installedVersion });
  expect(await f.adapter.check(i)).toEqual({
    ok: true, value: { kind: "update-available", installedVersion: "1.2.12", availableVersion: "1.2.15", checkedAt: 123 },
  });
  f.release.version = "1.2.12";
  f.release.url = f.release.url.replace("1.2.15-", "1.2.12-");
  await f.repinManifest();
  expect(await f.adapter.check(i)).toEqual({
    ok: true, value: { kind: "up-to-date", installedVersion: "1.2.12", checkedAt: 123 },
  });
});
test("missing executable and unpinned ownership never imply readiness", async () => {
  const f = await isolated();
  expect(await f.adapter.detect(join(f.root, "missing"))).toEqual(failed("not_found"));
  f.setPins([]);
  const i = await f.installation();
  expect(i.owner).toEqual({ kind: "unknown", reason: "unverified_owner" });
  expect(i.installedVersion).toEqual({ kind: "unknown", reason: "not_captured" });
  expect(await f.adapter.version(i)).toEqual(failed("identity_mismatch"));
  expect(f.adapter.updateSpec(i, "update-only")).toEqual(failed("identity_mismatch"));
});
test.each(["owner", "channel", "family"] as const)("rejects dirty %s provenance", async part => {
  const f = await isolated();
  if (part === "owner") f.receipt.owner = { kind: "native", prefix: f.root, installerDigest: "sha256:other" };
  if (part === "channel") f.receipt.channel = "stable";
  if (part === "family") f.receipt.family = "grok";
  await f.repin();
  expect(await f.adapter.detect(f.executable)).toEqual(failed(part === "family" ? "verification_failed" : "identity_mismatch"));
});
test("similarly named package is not Google native ownership", async () => {
  const f = await isolated();
  f.receipt.owner = { kind: "package", manager: "bun", prefix: f.root, packageName: "agy" };
  await f.repin();
  expect(await f.adapter.detect(f.executable)).toEqual(failed("verification_failed"));
});
test.each(["executable", "receipt", "pin"] as const)("rehashes stale %s before specs or version probes", async part => {
  const f = await isolated();
  const i = await f.installation();
  const r = await f.runtime(i);
  if (part === "pin") f.setPins([]);
  else {
    const path = part === "executable" ? f.executable : f.receiptPath;
    await writeFile(path, (await readFile(path, "utf8")) + " ");
  }
  const code = part === "pin" ? "stale_selection" : "external_writer";
  expect(await f.adapter.version(i)).toEqual(failed(code));
  expect(f.adapter.updateSpec(i, "update-only")).toEqual(failed(code));
  expect(f.adapter.exactResume(r)).toEqual(failed(code));
});
test("forged selection, duplicate owner pins and canonical alias are distinguished", async () => {
  const f = await isolated();
  const i = await f.installation();
  expect(f.adapter.updateSpec({ ...i, channel: "beta" }, "update-only")).toEqual(failed("stale_selection"));
  const pin = f.config.provenance(f.executable)[0];
  if (!pin) throw new TypeError("fixture_pin");
  f.setPins([pin, pin]);
  expect(f.adapter.updateSpec(i, "update-only")).toEqual(failed("stale_selection"));
  f.setPins([pin]);
  const alias = join(f.root, "agy");
  await symlink(f.executable, alias);
  expect(await f.adapter.detect(alias)).toEqual({ ok: true, value: i });
});
test.each(["prefixed", "notice", "stderr", "version"] as const)("rejects misleading %s machine output", async kind => {
  const f = await isolated();
  const output = kind === "prefixed" ? "agy 1.2.12\n" : kind === "notice" ? "updated successfully\n1.2.12\n" : "1.2.12\n";
  await writeFile(f.executable, f.program(output, kind === "stderr" ? "warning\n" : ""));
  f.receipt.resources[0] = { path: f.executable, sha256: digest(await readFile(f.executable)) };
  await f.repin();
  if (kind === "version") {
    const i = await f.installation();
    expect(await f.adapter.version({ ...i, installedVersion: { kind: "known", version: "1.2.15" } }))
      .toEqual(failed("stale_selection"));
  } else expect(await f.adapter.detect(f.executable)).toEqual(failed("verification_failed"));
});
test.each(["digest", "host", "version", "checksum", "clock", "rollback", "absent"] as const)(
  "rejects misleading or stale manifest %s", async kind => {
    const f = await isolated();
    const i = await f.installation();
    if (kind === "absent") f.setManifest(null);
    else if (kind === "digest") await writeFile(f.manifestPath, "{}");
    else if (kind === "clock") f.setClock(Number.NaN);
    else {
      if (kind === "host") f.release.url = f.release.url.replace("storage.googleapis.com", "example.com");
      if (kind === "version") f.release.version = "latest";
      if (kind === "checksum") f.release.sha512 = "abc";
      if (kind === "rollback") {
        f.release.version = "1.2.11";
        f.release.url = f.release.url.replace("1.2.15-", "1.2.11-");
      }
      await f.repinManifest();
    }
    expect(await f.adapter.check(i)).toEqual(failed(kind === "absent" ? "receipt_uncertain" : "verification_failed"));
  },
);
test("existing conversation is independently preflighted; help and fixture do not qualify resume", async () => {
  const f = await isolated();
  const i = await f.installation(), r = await f.runtime(i);
  expect(f.adapter.exactResume(r)).toEqual(failed("receipt_uncertain"));
  // Removing the real file makes the independent reader fail, before any new launch.
  await rm(f.sessionPath);
  expect(f.adapter.exactResume(r)).toEqual(failed("missing_session"));
  expect(f.adapter.bridge(r)).toEqual(failed("missing_session"));
});
test.each(["id", "cwd", "optionsRef", "path", "hash", "bytes", "startup", "fingerprint", "incarnation", "prefix"] as const)(
  "rejects independently mismatching full identity %s", async part => {
    const f = await isolated();
    const i = await f.installation();
    let r = await f.runtime(i);
    let code: FailureCode = "identity_mismatch";
    if (part === "id") await f.patch(f.sessionPath, { fullId: "22222222-2222-4222-8222-222222222222" });
    if (part === "cwd") await f.patch(f.sessionPath, { cwd: "/other" });
    if (part === "optionsRef") await f.patch(f.privatePath, { optionsRef: "private:other" });
    if (part === "path") await f.patch(f.privatePath, { storagePath: join(f.root, "guessed") });
    if (part === "hash") r = { ...r, binding: { ...r.binding, session: { ...r.binding.session, storagePathHash: "wrong" } } };
    if (part === "bytes") { await writeFile(f.sessionPath, (await readFile(f.sessionPath, "utf8")) + " "); code = "stale_binding"; }
    if (part === "startup") await f.patch(f.startupPath, { args: ["--model", "other"] });
    if (part === "fingerprint") { r = { ...r, binding: { ...r.binding, resourcesFingerprint: "wrong" } }; code = "stale_binding"; }
    if (part === "incarnation") { await f.patch(f.bindingPath, { paneGeneration: 99 }); code = "stale_binding"; }
    if (part === "prefix") r = { ...r, binding: { ...r.binding, session: { ...r.binding.session, fullId: "11111111" } } };
    if (part === "hash") {
      await writeFile(f.bindingPath, JSON.stringify(r.binding));
    }
    expect(f.adapter.exactResume(r)).toEqual(failed(code));
  },
);
test.each([["--continue"], ["-c"], ["--conversation", "other"], ["--project", "title"],
  ["--model", "x"], ["--prompt", "$(touch unwanted)"], ["--"], ["--fork"], [""], ["--agent\n"]])(
  "rejects unsafe startup arguments %j", async (...args) => {
    const f = await isolated();
    const r = await f.runtime(await f.installation());
    await f.patch(f.privatePath, { args });
    expect(f.adapter.exactResume(r)).toEqual(failed("malformed_request"));
    expect(await lstat(f.root)).toBeDefined();
  },
);
test("missing private snapshot or opaque optionsRef does not guess a path", async () => {
  const f = await isolated();
  const r = await f.runtime(await f.installation());
  await rm(f.privatePath);
  expect(f.adapter.exactResume(r)).toEqual(failed("missing_session"));
  const missing = createAgyAdapter({ ...f.config, privateRuntime: () => null });
  const i = await missing.detect(f.executable);
  if (!i.ok) throw new TypeError(i.error.code);
  expect(missing.exactResume(r)).toEqual(failed("missing_session"));
});
artifactTest("reviewed bootstrap is not an updater and never proves busy-safe or core drain", async () => {
  const f = await isolated();
  const i = await f.installation(), r = await f.runtime(i);
  expect(f.adapter.updateSpec(i, "update-only")).toEqual(failed("receipt_uncertain"));
  expect(f.adapter.updateSpec(i, "update-and-restart")).toEqual(failed("receipt_uncertain"));
  expect(f.adapter.bridge(r)).toEqual(failed("receipt_uncertain"));
  expect(f.adapter.gracefulExit(r, "op", "private:token")).toEqual(failed("receipt_uncertain"));
  expect(f.adapter.gracefulExit(r, "", "private:token")).toEqual(failed("malformed_request"));
  const installer = join(f.root, "installer.sh");
  await writeFile(installer, "#!/bin/bash\nexit 0\n");
  f.setInstaller({ path: installer, sha256: AGY_INSTALLER_SHA256 });
  expect(f.adapter.updateSpec(i, "update-only")).toEqual(failed("verification_failed"));
  f.setInstaller(null);
  expect(f.adapter.updateSpec(i, "update-only")).toEqual(failed("receipt_uncertain"));
});
artifactTest("actual pinned installer parser rejects invented flags and missing dir without executing installation", async () => {
  const source = await readFile(join(sourceRoot, "boundedsource/install.sh"));
  expect(digest(source)).toBe(AGY_INSTALLER_SHA256);
  const path = join(sourceRoot, "boundedsource/install.sh");
  for (const args of [["--help"], ["--dir", "/never-written", "--help"], ["--dir"],
    ["--skip-path"], ["--skip-aliases"], ["--version", "1.2.15"], ["--channel", "stable"]]) {
    // Each parser branch exits before platform/network/write stages. No shell text.
    const child = Bun.spawn(["/bin/bash", path, ...args], { cwd: sourceRoot, env: { HOME: sourceRoot, PATH: "/usr/bin:/bin" },
      stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit).toBe(args.includes("--help") ? 0 : 1);
    expect(stdout.length + stderr.length).toBeGreaterThan(0);
  }
});
artifactTest("streams native sized resource with bounded chunks without inflating capabilities", async () => {
  const f = await largeResource();
  roots.push(f);
  expect((await lstat(f.nativePath)).size).toBe(nativeSize);
  expect(f.observedInstallation.resources.find(row => row.realpath === f.nativePath)?.fingerprint).toBe(`sha256:${f.expected}`);
  const update = Hash.prototype.update;
  let maxChunk = 0, chunks = 0;
  const observer = spyOn(Hash.prototype, "update").mockImplementation(function (this: Hash, data, encoding) {
    if (data instanceof Uint8Array) {
      maxChunk = Math.max(maxChunk, data.byteLength);
      if (data.byteLength === 64 * 1024) chunks++;
    }
    return update.call(this, data, encoding);
  });
  try { expect(f.adapter.updateSpec(f.observedInstallation, "update-only")).toEqual(failed("receipt_uncertain")); }
  finally { observer.mockRestore(); }
  expect(maxChunk).toBe(64 * 1024);
  expect(chunks).toBe(Math.floor(nativeSize / (64 * 1024)));
  const r = await f.runtime(f.observedInstallation);
  expect(f.adapter.exactResume(r)).toEqual(failed("receipt_uncertain"));
  expect(f.adapter.bridge(r)).toEqual(failed("receipt_uncertain"));
  expect(f.adapter.gracefulExit(r, "op", "private:owner")).toEqual(failed("receipt_uncertain"));
});

test("rejects stale native sized resource bytes", async () => {
  const f = await largeResource();
  roots.push(f);
  const fd = openSync(f.nativePath, "r+");
  try { writeSync(fd, Buffer.from([1]), 0, 1, 0); } finally { closeSync(fd); }
  expect(f.adapter.updateSpec(f.observedInstallation, "update-only")).toEqual(failed("external_writer"));
});

test.each(["changed", "grown", "truncated"] as const)("rejects native resource %s at actual hash-update barrier", async action => {
  const f = await largeResource();
  roots.push(f);
  const before = await lstat(f.nativePath);
  const update = Hash.prototype.update;
  let mutations = 0;
  const barrier = spyOn(Hash.prototype, "update").mockImplementation(function (this: Hash, data, encoding) {
    const result = update.call(this, data, encoding);
    if (mutations === 0 && data instanceof Uint8Array && data.byteLength === 64 * 1024) {
      mutations++;
      if (action === "changed") {
        const fd = openSync(f.nativePath, "r+");
        try { writeSync(fd, Buffer.from([1]), 0, 1, 0); } finally { closeSync(fd); }
        utimesSync(f.nativePath, before.atime, before.mtime);
      } else truncateSync(f.nativePath, action === "grown" ? nativeSize + 1 : 1);
    }
    return result;
  });
  let result;
  try { result = f.adapter.updateSpec(f.observedInstallation, "update-only"); }
  finally { barrier.mockRestore(); }
  expect(mutations).toBe(1);
  expect(result).toEqual(failed("external_writer"));
});

test.each(["before-open", "after-fstat"] as const)("rejects native pathname replacement %s", async timing => {
  const f = await largeResource();
  roots.push(f);
  const replacement = join(f.root, "replacement");
  copyFileSync(f.nativePath, replacement);
  const actualOpen = filesystem.openSync, actualStat = filesystem.fstatSync;
  let targetFd = -1, snapshots = 0, mutations = 0, flagsObserved = 0;
  const opened: number[] = [];
  const openBarrier = spyOn(filesystem, "openSync").mockImplementation((path, flags, mode) => {
    if (path === f.nativePath && timing === "before-open" && mutations === 0) {
      mutations++;
      renameSync(replacement, f.nativePath);
    }
    const fd = actualOpen(path, flags, mode);
    if (path === f.nativePath) { targetFd = fd; flagsObserved = typeof flags === "number" ? flags : 0; opened.push(fd); }
    return fd;
  });
  function observedStat(fd: number, options?: StatOptions & { bigint?: false | undefined }): Stats;
  function observedStat(fd: number, options: StatOptions & { bigint: true }): BigIntStats;
  function observedStat(fd: number, options?: StatOptions): Stats | BigIntStats;
  function observedStat(fd: number, options?: StatOptions): Stats | BigIntStats {
    const snapshot = actualStat(fd, options);
    if (fd === targetFd && options?.bigint && ++snapshots === 2 && timing === "after-fstat" && mutations === 0) {
      mutations++;
      renameSync(replacement, f.nativePath);
    }
    return snapshot;
  }
  const statBarrier = spyOn(filesystem, "fstatSync").mockImplementation(observedStat);
  let result;
  try { result = f.adapter.updateSpec(f.observedInstallation, "update-only"); }
  finally { openBarrier.mockRestore(); statBarrier.mockRestore(); }
  expect(mutations).toBe(1);
  expect(result).toEqual(failed("external_writer"));
  expect(flagsObserved & filesystem.constants.O_NOFOLLOW).toBe(filesystem.constants.O_NOFOLLOW);
  expect(flagsObserved & filesystem.constants.O_NONBLOCK).toBe(filesystem.constants.O_NONBLOCK);
  expect(opened).toHaveLength(1);
  for (const fd of opened) expect(() => actualStat(fd)).toThrow();
});

test("rejects nonregular native resource before opening", async () => {
  const f = await largeResource();
  roots.push(f);
  await rm(f.nativePath);
  mkdirSync(f.nativePath);
  const actualOpen = filesystem.openSync;
  let attempts = 0;
  const observer = spyOn(filesystem, "openSync").mockImplementation((path, flags, mode) => {
    if (path === f.nativePath) attempts++;
    return actualOpen(path, flags, mode);
  });
  let result;
  try { result = f.adapter.updateSpec(f.observedInstallation, "update-only"); }
  finally { observer.mockRestore(); }
  expect(result).toEqual(failed("verification_failed"));
  expect(attempts).toBe(0);
});

artifactTest("hashes actual acquired agy bytes without invocation or ownership qualification", async () => {
  const loaded = await loadAdapter();
  const path = join(sourceRoot, "acquired/extracted/antigravity");
  const before = await lstat(path, { bigint: true });
  expect(before.isFile()).toBe(true);
  expect(before.size).toBe(174613232n);
  expect(loaded.resourceDigest(path)).toEqual({
    ok: true, value: "d15693410c904242c1c3423a579f60a81e018444bb51fbccc6505f988b62a91d",
  });
  const after = await lstat(path, { bigint: true });
  expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs])
    .toEqual([before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs]);
});

test("keeps installer and session metadata limits despite resource streaming", async () => {
  const f = await isolated(), i = await f.installation();
  const installer = join(f.root, "oversized-installer");
  await writeFile(installer, "");
  await truncate(installer, 64 * 1024 + 1);
  f.setInstaller({ path: installer, sha256: AGY_INSTALLER_SHA256 });
  expect(f.adapter.updateSpec(i, "update-only")).toEqual(failed("verification_failed"));
  const r = await f.runtime(i);
  await truncate(f.sessionPath, 4 * 1024 * 1024 + 1);
  const binding = r.binding;
  const loaded = createAgyAdapter({
    ...f.config,
    privateRuntime: () => ({ storagePath: f.sessionPath, storageSha256: "unqualified",
      fullId: binding.session.fullId, cwd: binding.cwd, optionsRef: binding.optionsRef, args: [] }),
    preflight: () => ({ binding, storagePath: f.sessionPath, storageSha256: "unqualified",
      fullId: binding.session.fullId, cwd: binding.cwd, optionsRef: binding.optionsRef, optionsSha256: digest("[]") }),
  });
  const detected = await loaded.detect(f.executable);
  if (!detected.ok) throw new TypeError(detected.error.code);
  expect(loaded.exactResume(r)).toEqual(failed("verification_failed"));
});

test.each([...throwKinds])("private %s callback throws settle as enum-only failures", async kind => {
  const rows = await privacyProbe(kind);
  expect(rows).toHaveLength(15);
  for (const row of rows) {
    expect(row.settled).toBe(true);
    expect(row.enumOnly).toBe(true);
    expect(row.sentinelAbsent).toBe(true);
  }
});

artifactTest("manual serializes only safe codes invariants and digests", async () => {
  const report = await manualProbe();
  expect(Object.keys(report).sort()).toEqual(["FullDone", "cleanup", "codes", "digests", "invariants", "mechanismOnly"]);
  expect(report.codes).toEqual({
    version: "ok", check: "ok", exactResume: "receipt_uncertain", updateOnly: "receipt_uncertain",
    updateAndRestart: "receipt_uncertain", bridge: "receipt_uncertain", gracefulExit: "receipt_uncertain",
  });
  expect(Object.values(report.invariants).every(value => value === true)).toBe(true);
  expect(report.cleanup).toEqual({ rootRemoved: true, rootsEmpty: true, PIDs: 0 });
  expect(report.digests.manifest).toMatch(/^[a-f0-9]{64}$/);
  expect(report.digests.resources).toMatch(/^sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(report);
  for (const privateField of ["/Users/", "storagePath", "optionsRef", "expectedBinding", "command", "executableRealpath", "private:"]) {
    expect(serialized.includes(privateField)).toBe(false);
  }
});

artifactTest("manual cleans only its invocation while foreign fixture survives concurrently", async () => {
  const result = await concurrentManualCheck();
  expect(result.report.cleanup).toEqual({ rootRemoved: true, rootsEmpty: true, PIDs: 0 });
  expect(result.ownedRootObserved).toBe(true);
  expect(result.ownedRootAbsent).toBe(true);
  expect(result.foreignDuring).toBe(true);
  expect(result.foreignAfter).toBe(true);
  expect(result.observedOwnedProcesses).toBeGreaterThan(0);
  expect(result.remainingOwnedPIDs).toBe(0);
});

test.each([...hostileThrowKinds])("hostile %s callback throws settle without caught-value inspection", async kind => {
  const rows = await privacyProbe(kind);
  expect(rows).toHaveLength(15);
  for (const row of rows) {
    expect(row.settled).toBe(true);
    expect(row.enumOnly).toBe(true);
    expect(row.sentinelAbsent).toBe(true);
    expect(row.caughtValueUninspected).toBe(true);
  }
});
