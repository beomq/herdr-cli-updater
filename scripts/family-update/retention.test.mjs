import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prunePackageCopies, releaseFailedAcquisition } from "./retention.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }); });
test("QA pruning keeps latest snapshots and old logs while releasing repeated copies", async () => {
  // Given
  const root = await realpath(await mkdtemp(join(tmpdir(), "qa-retention-"))); roots.push(root);
  for (const name of ["selected-original-1", "captured-before-1", "selected-original-2", "captured-after-2"]) {
    await mkdir(join(root, name, "prefix"), { recursive: true }); await writeFile(join(root, name, "prefix/cli"), "installation");
    await mkdir(join(root, name, "logs")); await writeFile(join(root, name, "logs/result.json"), "{}");
  }
  const kept = [join(root, "selected-original-2"), join(root, "captured-after-2")];
  // When
  const removed = await prunePackageCopies(root, kept);
  // Then
  expect(removed).toHaveLength(2);
  for (const path of kept) expect(await readFile(join(path, "prefix/cli"), "utf8")).toBe("installation");
  expect(await readFile(join(root, "selected-original-1/logs/result.json"), "utf8")).toBe("{}");
  await expect(access(join(root, "selected-original-1/prefix"))).rejects.toThrow();
  expect(await prunePackageCopies(root, kept)).toEqual([]);
});
test("failed acquisition drops archives and resolved installs but keeps metadata and logs", async () => {
  // Given
  const root = await realpath(await mkdtemp(join(tmpdir(), "failed-acquisition-"))); roots.push(root);
  await mkdir(join(root, "resolve-before/prefix"), { recursive: true });
  await writeFile(join(root, "resolve-before/prefix/cli"), "installation");
  await writeFile(join(root, "resolve-before/command.json"), "{}");
  await mkdir(join(root, "closure"));
  const stem = join(root, "closure", "a".repeat(64));
  await writeFile(`${stem}.tgz`, "archive"); await writeFile(`${stem}.json`, "metadata");
  // When
  await releaseFailedAcquisition(root);
  // Then
  await expect(access(`${stem}.tgz`)).rejects.toThrow();
  await expect(access(join(root, "resolve-before/prefix"))).rejects.toThrow();
  expect(await readFile(`${stem}.json`, "utf8")).toBe("metadata");
  expect(await readFile(join(root, "resolve-before/command.json"), "utf8")).toBe("{}");
});
