import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerPreparedRuntime } from "../../scripts/plugin";
import { RUNTIME_SET_PROFILE } from "../../src/service/plugin-runtime";

test("re-registration replaces one installation pin without dropping another installation", async () => {
  // These are registration-only data fixtures, never qualified or executed.
  const root = realpathSync(mkdtempSync("/tmp/app-registration-"));
  const pin = (name: string, installationId: string) => {
    const path = join(root, `${name}.json`);
    const body = JSON.stringify({ update: { qualification: { installation: { installationId } } } });
    writeFileSync(path, body, { mode: 0o600 });
    return { path, sha256: createHash("sha256").update(body).digest("hex") };
  };
  try {
    const first = pin("first", "installation-a"), other = pin("other", "installation-b"), next = pin("next", "installation-a");
    const runtime = join(root, "runtime.json");
    await registerPreparedRuntime(runtime, first);
    await registerPreparedRuntime(runtime, other);
    await registerPreparedRuntime(runtime, next);
    expect(JSON.parse(readFileSync(runtime, "utf8"))).toEqual({
      schemaVersion: 1, profile: RUNTIME_SET_PROFILE, configurations: [other, next],
    });
    const before = readFileSync(runtime, "utf8");
    writeFileSync(other.path, "{}");
    await expect(registerPreparedRuntime(runtime, first)).rejects.toThrow();
    expect(readFileSync(runtime, "utf8")).toBe(before);
  } finally { rmSync(root, { recursive: true }); }
});
