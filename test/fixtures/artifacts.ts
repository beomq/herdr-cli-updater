import { test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Vendor packages and binaries cannot be committed to this public repository.
// Tests that need them run only when the local artifact directory is present;
// `bun run test:artifacts` requires it and fails with the missing paths.
export const artifactRoot = resolve(process.env["CLI_UPDATER_TEST_ARTIFACTS"]
  ?? join(import.meta.dir, "../../.omo/evidence/herdr-cli-updater"));
const required = [
  "six-families/native-update/cursor-agy-current",
  "task-5/families/agy/acquired/extracted/antigravity",
  "task-5/families/agy/boundedsource/install.sh",
  "task-5/families/agy/officialresponse/darwin_arm64.json",
  "task-5/families/cursor/boundedsource/install.sh",
  "task-5/families/cursor/boundedsource/installed-wrapper.sh",
  "task-5/families/codex/task-cache/extracted/codex-aarch64-apple-darwin",
  "task-5/families/omo/acquired/omo-ai-5.1.9.tgz",
  "task-5/families/omo/acquired/senpi-2026.10.1-3.tgz",
];
const missing = required.filter(path => !existsSync(join(artifactRoot, path)));
if (missing.length && process.env["CLI_UPDATER_REQUIRE_ARTIFACTS"] === "1")
  throw new Error(`Missing test artifacts under ${artifactRoot}: ${missing.join(", ")}. Set CLI_UPDATER_TEST_ARTIFACTS to the artifact directory.`);

export const artifactPath = (path: string) => join(artifactRoot, path);
export const artifactTest = test.skipIf(missing.length > 0);
