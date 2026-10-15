import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import fixtures from "./fixtures/current-reviewed-sources.json" with { type: "json" };
import { currentHookResolutions, resolveCurrentHook } from "../../scripts/native-prepare/latest-hook-resolution.mjs";
import { mergeHook } from "../../scripts/native-prepare/omo.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const decode = value => gunzipSync(Buffer.from(value, "base64")).toString();
for (const fixture of fixtures) {
  const profile = currentHookResolutions.find(row => row.relativePath === fixture.relativePath);
  const input = { version: profile.version, commit: profile.commit, relativePath: profile.relativePath,
    ...Object.fromEntries(["upstream", "baseline", "hooked", "conflicted"].map(field => [field, decode(fixture[field])])) };
  test(`exact current source merge: ${fixture.relativePath}`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "herdr-reviewed-current-"));
    try {
      const result = await mergeHook(input.upstream, input.baseline, input.hooked, scratch, process.env, input);
      expect(result).toEqual(resolveCurrentHook(input));
      for (const conflict of profile.conflicts) expect(result.merged).toContain(conflict.replacement);
      expect(result.merged).not.toMatch(/^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
  test(`reject unreviewed current sources: ${fixture.relativePath}`, () => {
    for (const field of ["version", "commit", "relativePath", "upstream", "baseline", "hooked"])
      expect(() => resolveCurrentHook({ ...input, [field]: input[field] + "changed" })).toThrow();
    expect(() => resolveCurrentHook({ ...input, conflicted: "" })).toThrow();
    expect(() => resolveCurrentHook({ ...input, conflicted: input.conflicted.replace("=======", "=======\nchanged") })).toThrow();
    expect(() => resolveCurrentHook({ ...input, conflicted: input.conflicted + input.conflicted })).toThrow();
  });
}

test("upstream fallback and native engine verification both precede host open", () => {
  const fixture = fixtures.find(row => row.relativePath.endsWith("rpc-host/session-client.ts"));
  const profile = currentHookResolutions.find(row => row.relativePath === fixture.relativePath);
  const merged = resolveCurrentHook({ ...profile,
    ...Object.fromEntries(["upstream", "baseline", "hooked", "conflicted"].map(field => [field, decode(fixture[field])])) }).merged;
  expect(merged.indexOf("input.nativeRemote.verifyEngine")).toBeLessThan(merged.indexOf("const wire = toWireOpen"));
  expect(merged).toContain("toWireOpen(profileHonored ? input : withoutRetryFallback(input))");
  expect(merged).toContain("client.openSession(wire)");
});
