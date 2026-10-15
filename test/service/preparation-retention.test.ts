import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseFailedPreparation, releasePreparationScratch, retainPreparations } from "../../src/service/preparation-retention";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retention-"))); roots.push(root); return root;
}
function preparation(parent: string, name: string, id: string, time: number): string {
  const root = join(parent, name); mkdirSync(root);
  mkdirSync(join(root, "acquired")); writeFileSync(join(root, "acquired/vendor.tgz"), "vendor");
  mkdirSync(join(root, "calibration-a/prefix"), { recursive: true });
  writeFileSync(join(root, "calibration-a/prefix/cli"), "clone");
  writeFileSync(join(root, "calibration-a/stdout.txt"), "diagnostic");
  writeFileSync(join(root, "qualification.json"), JSON.stringify({ installation: { installationId: id }, target: { checkedAt: time } }));
  writeFileSync(join(root, "omo-runtime.json"), "{}");
  return root;
}
test("scratch release keeps runtime artifacts and calibration logs", () => {
  // Given
  const root = preparation(fixture(), "omo-A", "install-a", 1);
  // When
  releasePreparationScratch(root);
  // Then
  expect(existsSync(join(root, "calibration-a/prefix"))).toBe(false);
  expect(readFileSync(join(root, "calibration-a/stdout.txt"), "utf8")).toBe("diagnostic");
  expect(readFileSync(join(root, "acquired/vendor.tgz"), "utf8")).toBe("vendor");
});
test("repeated preparations keep current and one previous per installation", () => {
  // Given
  const parent = fixture(), old = preparation(parent, "omo-A", "install-a", 1), previous = preparation(parent, "omo-B", "install-a", 2),
    current = preparation(parent, "omo-C", "install-a", 3), independent = preparation(parent, "omo-D", "install-b", 1);
  // When
  retainPreparations(parent, [current, independent]);
  // Then
  expect(existsSync(join(old, "acquired"))).toBe(false);
  for (const root of [previous, current, independent]) expect(existsSync(join(root, "acquired/vendor.tgz"))).toBe(true);
  expect(existsSync(join(old, "qualification.json"))).toBe(true);
});
test("failed preparation releases downloads but retains diagnostics", () => {
  // Given
  const root = preparation(fixture(), "omo-A", "install-a", 1); rmSync(join(root, "omo-runtime.json"));
  // When
  releaseFailedPreparation(root);
  // Then
  expect(existsSync(join(root, "acquired"))).toBe(false);
  expect(existsSync(join(root, "calibration-a/stdout.txt"))).toBe(true);
});
test("scratch symlink cannot redirect cleanup to an installation", () => {
  // Given
  const root = fixture(), installation = fixture(); writeFileSync(join(installation, "cli"), "operating");
  symlinkSync(installation, join(root, "calibration-a"));
  // When / Then
  expect(() => releasePreparationScratch(root)).toThrow("unsafe preparation scratch");
  expect(readFileSync(join(installation, "cli"), "utf8")).toBe("operating");
});
