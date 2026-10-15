import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import * as filesystem from "node:fs/promises";
import { join } from "node:path";
import { createCheckStore } from "../../src/service/check-store";
import type { CheckStoreEntry } from "../../src/service/check-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
    expect(existsSync(root)).toBe(false);
  }
});
function fixture() {
  const root = realpathSync(mkdtempSync("/tmp/check-store-r1-"));
  roots.push(root);
  const worker = join(root, "worker"), directory = `${worker}.checks`, file = join(directory, "checks.json");
  mkdirSync(worker, { mode: 0o700 });
  return { root, worker, directory, file, store: createCheckStore(worker) };
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function captured(key = "full-source-and-policy", checkedAt = 1000) {
  return {
    subjectKey: digest(key),
    installedVersion: { kind: "known" as const, version: "1.2.3" },
    checkedAt,
    result: { kind: "update-available" as const, installedVersion: "1.2.3", availableVersion: "1.3.0", checkedAt },
    metadata: [{ origin: "https://registry.npmjs.org/omo-ai/latest", method: "GET" as const,
      status: 200, bodyDigest: digest("actual response fixture"), acquiredAt: checkedAt - 1 }],
  } satisfies CheckStoreEntry;
}
function noTemporary(directory: string): void {
  expect(readdirSync(directory)).toEqual(["checks.json"]);
}

test("retains original timestamp and private receipt through a reopened owner", async () => {
  // Given
  const f = fixture(), entry = captured();
  expect(await f.store.get(entry.subjectKey)).toEqual({ ok: true, value: null });
  // When
  expect(await f.store.put(entry)).toEqual({ ok: true, value: undefined });
  const found = await createCheckStore(f.worker).get(entry.subjectKey);
  // Then: real persisted bytes, not a process-local cache.
  expect(found).toEqual({ ok: true, value: entry });
  expect(JSON.parse(readFileSync(f.file, "utf8")).entries[0].checkedAt).toBe(1000);
  expect(lstatSync(f.directory).mode & 0o7777).toBe(0o700);
  expect(lstatSync(f.file).mode & 0o7777).toBe(0o600);
  if (!found.ok || found.value === null) throw new TypeError("missing admitted entry");
  expect(Object.isFrozen(found.value)).toBe(true);
  expect(Object.isFrozen(found.value.result)).toBe(true);
  expect(Object.isFrozen(found.value.metadata[0])).toBe(true);
  noTemporary(f.directory);
});

test("isolates every exact source and policy snapshot digest", async () => {
  // Given: same installed version, different source or policy.
  const f = fixture(), first = captured("source-a/policy-a"), changed = captured("source-a/policy-b", 2000);
  expect(await f.store.put(first)).toEqual({ ok: true, value: undefined });
  // When
  expect(await f.store.put(changed)).toEqual({ ok: true, value: undefined });
  // Then
  expect(await f.store.get(first.subjectKey)).toEqual({ ok: true, value: first });
  expect(await f.store.get(changed.subjectKey)).toEqual({ ok: true, value: changed });
  expect(await f.store.get(digest("source-b/policy-a"))).toEqual({ ok: true, value: null });
  expect(await f.store.get("installation-only")).toEqual({ ok: false, error: { code: "verification_failed" } });
  noTemporary(f.directory);
});

test("retains only the 64 most recently put exact keys", async () => {
  // Given
  const f = fixture();
  for (let i = 0; i < 64; i++) expect((await f.store.put(captured(`subject-${i}`, 1000 + i))).ok).toBe(true);
  // When: refreshing key0 makes key1 the oldest, then another source arrives.
  expect((await f.store.put(captured("subject-0", 3000))).ok).toBe(true);
  expect((await f.store.put(captured("subject-64", 4000))).ok).toBe(true);
  // Then
  expect(JSON.parse(readFileSync(f.file, "utf8")).entries).toHaveLength(64);
  expect(await f.store.get(digest("subject-1"))).toEqual({ ok: true, value: null });
  expect(await f.store.get(digest("subject-0"))).toEqual({ ok: true, value: captured("subject-0", 3000) });
  noTemporary(f.directory);
});

test("clones before the first await and serializes concurrent writes without lost entries", async () => {
  // Given
  const f = fixture(), inputs = Array.from({ length: 16 }, (_, i) => captured(`parallel-${i}`, 1000 + i));
  const expected = structuredClone(inputs);
  // When: call every put before mutation; completion, not a delay, is the signal.
  const pending = inputs.map(input => f.store.put(input));
  for (const input of inputs) {
    input.result.availableVersion = "9.9.9";
    input.installedVersion.version = "8.8.8";
    if (input.metadata[0]) input.metadata[0].origin = "https://example.org/mutated";
  }
  const results = await Promise.all(pending);
  // Then
  expect(results.every(result => result.ok)).toBe(true);
  for (const entry of expected) expect(await f.store.get(entry.subjectKey)).toEqual({ ok: true, value: entry });
  expect(JSON.parse(readFileSync(f.file, "utf8")).entries).toHaveLength(16);
  noTemporary(f.directory);
});

test.each(["timestamp", "version", "future-receipt", "status", "digest", "credential", "unknown-success"] as const)(
  "rejects mismatched %s input without changing previous bytes", async invalid => {
    // Given
    const f = fixture(), first = captured();
    await f.store.put(first);
    const before = readFileSync(f.file, "utf8"), next = captured("different-source", 2000);
    let input: CheckStoreEntry = next;
    switch (invalid) {
      case "timestamp": next.result.checkedAt++; break;
      case "version": next.installedVersion.version = "9.9.9"; break;
      case "future-receipt": if (next.metadata[0]) next.metadata[0].acquiredAt = 3000; break;
      case "status": if (next.metadata[0]) next.metadata[0].status = 999; break;
      case "digest": if (next.metadata[0]) next.metadata[0].bodyDigest = "not-a-digest"; break;
      case "credential": if (next.metadata[0]) next.metadata[0].origin = "https://user:secret@example.org/"; break;
      case "unknown-success": input = { ...next, installedVersion: { kind: "unknown", reason: "not_captured" } }; break;
    }
    // When
    expect(await f.store.put(input)).toEqual({ ok: false, error: { code: "verification_failed" } });
    // Then
    expect(readFileSync(f.file, "utf8")).toBe(before);
    expect(await f.store.get(first.subjectKey)).toEqual({ ok: true, value: first });
    noTemporary(f.directory);
  },
);

test("retains a real unavailable check with unknown installed version", async () => {
  // Given
  const f = fixture(), entry: CheckStoreEntry = {
    subjectKey: digest("unavailable"), installedVersion: { kind: "unknown", reason: "probe_failed" },
    checkedAt: 42, result: { kind: "unavailable", failure: { code: "unsupported" }, checkedAt: 42 }, metadata: [],
  };
  // When
  expect((await f.store.put(entry)).ok).toBe(true);
  // Then
  expect(await createCheckStore(f.worker).get(entry.subjectKey)).toEqual({ ok: true, value: entry });
  noTemporary(f.directory);
});

test.each(["malformed", "schema", "timestamp", "version", "duplicate", "extra-field", "entry-limit"] as const)(
  "refuses persisted %s corruption instead of overwriting it", async invalid => {
    // Given: external corruption remains exactly as found.
    const f = fixture(), entry = captured();
    await f.store.put(entry);
    let body: string;
    switch (invalid) {
      case "malformed": body = "{not-json"; break;
      case "schema": body = JSON.stringify({ schemaVersion: 2, entries: [entry] }); break;
      case "timestamp": body = JSON.stringify({ schemaVersion: 1, entries: [{ ...entry, checkedAt: -1 }] }); break;
      case "version": body = JSON.stringify({ schemaVersion: 1, entries: [{ ...entry,
        installedVersion: { kind: "known", version: "9.9.9" } }] }); break;
      case "duplicate": body = JSON.stringify({ schemaVersion: 1, entries: [entry, entry] }); break;
      case "extra-field": body = JSON.stringify({ schemaVersion: 1, entries: [entry], token: "not-admitted" }); break;
      case "entry-limit": body = JSON.stringify({ schemaVersion: 1,
        entries: Array.from({ length: 65 }, (_, i) => captured(`excess-${i}`)) }); break;
    }
    writeFileSync(f.file, body);
    // When
    const expected = { ok: false, error: { code: invalid === "schema" ? "unsupported_version" : "verification_failed" } } as const;
    expect(await f.store.get(entry.subjectKey)).toEqual(expected);
    expect(await f.store.put(captured("new-key"))).toEqual(expected);
    // Then
    expect(readFileSync(f.file, "utf8")).toBe(body);
    noTemporary(f.directory);
  },
);

test.each(["file", "directory", "worker", "parent"] as const)("refuses symlinked %s ownership", async boundary => {
  // Given
  const f = fixture(), entry = captured();
  await f.store.put(entry);
  const before = readFileSync(f.file, "utf8");
  let worker = f.worker;
  switch (boundary) {
    case "file": {
      const target = join(f.root, "foreign.json");
      writeFileSync(target, before, { mode: 0o600 });
      rmSync(f.file);
      symlinkSync(target, f.file);
      break;
    }
    case "directory": {
      const target = join(f.root, "foreign");
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(join(target, "checks.json"), before, { mode: 0o600 });
      rmSync(f.directory, { recursive: true });
      symlinkSync(target, f.directory);
      break;
    }
    case "worker": rmSync(f.worker, { recursive: true }); symlinkSync(f.directory, f.worker); break;
    case "parent": {
      const alias = join(f.root, "alias");
      symlinkSync(f.root, alias);
      worker = join(alias, "worker");
      break;
    }
  }
  // When
  const store = createCheckStore(worker);
  expect(await store.get(entry.subjectKey)).toEqual({ ok: false, error: { code: "recovery_required" } });
  expect(await store.put(captured("new-key"))).toEqual({ ok: false, error: { code: "recovery_required" } });
  // Then: no foreign target content modified.
  expect(readFileSync(f.file, "utf8")).toBe(before);
  noTemporary(f.directory);
});

test.each(["file-mode", "directory-mode", "hardlink"] as const)("refuses nonprivate %s without repair", async boundary => {
  // Given
  const f = fixture(), entry = captured();
  await f.store.put(entry);
  const before = readFileSync(f.file, "utf8");
  switch (boundary) {
    case "file-mode": chmodSync(f.file, 0o644); break;
    case "directory-mode": chmodSync(f.directory, 0o755); break;
    case "hardlink": linkSync(f.file, join(f.root, "linked.json")); break;
  }
  // When
  expect(await f.store.put(captured("next"))).toEqual({ ok: false, error: { code: "recovery_required" } });
  expect(await f.store.get(entry.subjectKey)).toEqual({ ok: false, error: { code: "recovery_required" } });
  // Then
  expect(readFileSync(f.file, "utf8")).toBe(before);
  noTemporary(f.directory);
});

test("rejects oversized input and aggregate without truncating retained metadata", async () => {
  // Given
  const f = fixture(), first = captured();
  await f.store.put(first);
  const before = readFileSync(f.file, "utf8"), large = captured("too-large");
  const receipt = large.metadata[0];
  if (!receipt) throw new TypeError("missing fixture receipt");
  large.metadata = Array.from({ length: 140 }, () => ({ ...receipt, origin: `https://example.org/${"x".repeat(8000)}` }));
  // When
  expect(await f.store.put(large)).toEqual({ ok: false, error: { code: "verification_failed" } });
  // Then
  expect(readFileSync(f.file, "utf8")).toBe(before);
  const medium = { ...large, metadata: large.metadata.slice(0, 80) };
  expect((await f.store.put(medium)).ok).toBe(true);
  const retained = readFileSync(f.file, "utf8");
  expect(await f.store.put({ ...medium, subjectKey: digest("another-large-key") }))
    .toEqual({ ok: false, error: { code: "verification_failed" } });
  expect(readFileSync(f.file, "utf8")).toBe(retained);
  expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(1024 * 1024);
  noTemporary(f.directory);
});

test("refuses oversized persisted files without overwriting previous bytes", async () => {
  // Given
  const f = fixture(), entry = captured();
  await f.store.put(entry);
  const oversized = " ".repeat(1024 * 1024 + 1);
  writeFileSync(f.file, oversized);
  // When
  expect(await f.store.get(entry.subjectKey)).toEqual({ ok: false, error: { code: "recovery_required" } });
  expect(await f.store.put(captured("new"))).toEqual({ ok: false, error: { code: "recovery_required" } });
  // Then
  expect(readFileSync(f.file, "utf8")).toBe(oversized);
  noTemporary(f.directory);
});

test("preserves previous commit and cleans only its exact temporary after failed rename", async () => {
  // Given: real file already committed; only the commit syscall is faulted.
  const f = fixture(), first = captured();
  await f.store.put(first);
  const before = readFileSync(f.file, "utf8"), foreign = join(f.directory, ".foreign.tmp");
  writeFileSync(foreign, "belongs to someone else", { mode: 0o600 });
  const commit = spyOn(filesystem, "rename").mockRejectedValueOnce(Object.assign(new Error("fixture EIO"), { code: "EIO" }));
  // When
  try {
    expect(await f.store.put(captured("failed"))).toEqual({ ok: false, error: { code: "recovery_required" } });
  } finally { commit.mockRestore(); }
  // Then
  expect(readFileSync(f.file, "utf8")).toBe(before);
  expect(readFileSync(foreign, "utf8")).toBe("belongs to someone else");
  expect(readdirSync(f.directory).sort()).toEqual([".foreign.tmp", "checks.json"]);
  expect(await createCheckStore(f.worker).get(first.subjectKey)).toEqual({ ok: true, value: first });
  expect((await f.store.put(captured("after-failure"))).ok).toBe(true);
  expect(readdirSync(f.directory).sort()).toEqual([".foreign.tmp", "checks.json"]);
});

test.each(["file", "directory", "content"] as const)(
  "reports committed uncertainty when %s changes during rename completion", async boundary => {
    // Given: the actual rename completes, but its promise is held at a barrier.
    const f = fixture(), first = captured(), next = captured("next", 2000);
    await f.store.put(first);
    const renamed = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const realRename = filesystem.rename;
    const commit = spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
      await realRename(from, to);
      renamed.resolve();
      await resume.promise;
    });
    const pending = f.store.put(next);
    // When: exact completion signal, no polling or timing assumptions.
    try {
      await renamed.promise;
      switch (boundary) {
        case "file": {
          const replacement = join(f.root, "replacement.json");
          writeFileSync(replacement, JSON.stringify({ schemaVersion: 1, entries: [first] }), { mode: 0o600 });
          renameSync(replacement, f.file);
          break;
        }
        case "directory":
          renameSync(f.directory, `${f.directory}.displaced`);
          mkdirSync(f.directory, { mode: 0o700 });
          writeFileSync(f.file, JSON.stringify({ schemaVersion: 1, entries: [first] }), { mode: 0o600 });
          break;
        case "content":
          writeFileSync(f.file, JSON.stringify({ schemaVersion: 1, entries: [first] }));
          break;
      }
      resume.resolve();
      // Then: never claims the new result is currently published; no rollback of
      // a rename that already took effect or writes to the replacement owner.
      expect(await pending).toEqual({ ok: false, error: { code: "recovery_required" } });
      expect(JSON.parse(readFileSync(f.file, "utf8")).entries).toEqual([first]);
      noTemporary(f.directory);
      if (boundary === "directory") noTemporary(`${f.directory}.displaced`);
    } finally {
      resume.resolve();
      await pending;
      commit.mockRestore();
    }
  },
);

test("returns typed recovery_required when exact temporary cleanup fails", async () => {
  // Given: failed precommit and a failing unlink syscall, both deterministic.
  const f = fixture(), first = captured();
  await f.store.put(first);
  const before = readFileSync(f.file, "utf8");
  const commit = spyOn(filesystem, "rename").mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
  const cleanup = spyOn(filesystem, "unlink").mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
  // When
  try {
    expect(await f.store.put(captured("failed-cleanup")))
      .toEqual({ ok: false, error: { code: "recovery_required" } });
  } finally {
    commit.mockRestore();
    cleanup.mockRestore();
  }
  // Then: prior commit intact; cleanup failure is surfaced, not hidden/rejected.
  expect(readFileSync(f.file, "utf8")).toBe(before);
  const leftovers = readdirSync(f.directory).filter(name => name !== "checks.json");
  expect(leftovers).toHaveLength(1);
  expect(leftovers[0]).toMatch(/^\.checks-[a-f0-9-]+\.tmp$/);
  // afterEach removes this fixture, including the deliberately refused temp,
  // and asserts the root is absent; production has no cleanup retry timer.
});

test.each(["malformed-json", "schema-version", "invalid-entry"] as const)(
  "returns recovery_required for postcommit %s admission failure", async boundary => {
    // Given: register exact completion signals before triggering put.
    const f = fixture(), first = captured(), next = captured(`postcommit-${boundary}`, 2000);
    expect((await f.store.put(first)).ok).toBe(true);
    const committed = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const realRename = filesystem.rename;
    const seam = spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
      await realRename(from, to);
      committed.resolve();
      await resume.promise;
    });
    let pending: ReturnType<typeof f.store.put> | undefined;
    try {
      // When: mutate the actual committed inode only after observing the rename.
      pending = f.store.put(next);
      await committed.promise;
      expect(JSON.parse(readFileSync(f.file, "utf8")).entries).toEqual([first, next]);
      const corruption = boundary === "malformed-json" ? "{broken"
        : JSON.stringify({ schemaVersion: boundary === "schema-version" ? 2 : 1,
          entries: boundary === "invalid-entry" ? [{ ...next, checkedAt: -1 }] : [first, next] });
      writeFileSync(f.file, corruption);
      resume.resolve();
      // Then: the same decoder now reports committed uncertainty, not refusal.
      expect(await pending).toEqual({ ok: false, error: { code: "recovery_required" } });
      expect(readFileSync(f.file, "utf8")).toBe(corruption);
      noTemporary(f.directory);
      // A separate read has no new commit: its precommit decoder codes stay intact.
      expect(await f.store.get(next.subjectKey)).toEqual({ ok: false, error: {
        code: boundary === "schema-version" ? "unsupported_version" : "verification_failed",
      } });
    } finally {
      resume.resolve();
      if (pending) await pending;
      seam.mockRestore();
    }
  }, 5000,
);
