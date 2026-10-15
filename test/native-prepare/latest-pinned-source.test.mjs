import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import fixtures from "./fixtures/latest-reviewed-sources.json" with { type: "json" };
import { latestManagerResolution, latestTypesResolution, latestRpcResolution, latestEngineResolutions,
  resolveLatestManager, resolveLatestTypes, resolveLatestRpc, resolveLatestEngineHook } from "../../scripts/native-prepare/latest-hook-resolution.mjs";

const profiles = [latestManagerResolution, latestTypesResolution, latestRpcResolution, ...latestEngineResolutions];
const decode = value => gunzipSync(Buffer.from(value, "base64"));
function inputs(fixture) {
  const profile = profiles.find(row => row.relativePath === fixture.relativePath);
  if (!profile) throw new Error("Unknown exact source fixture");
  return { version: profile.version, commit: profile.commit, relativePath: fixture.relativePath,
    upstream: decode(fixture.upstream), baseline: decode(fixture.baseline), hooked: decode(fixture.hooked),
    conflicted: decode(fixture["merge.json.stdout.txt"]).toString("utf8") };
}
function resolve(input) {
  if (input.relativePath === latestManagerResolution.relativePath) return resolveLatestManager(input);
  if (input.relativePath === latestTypesResolution.relativePath) return resolveLatestTypes(input);
  if (input.relativePath === latestRpcResolution.relativePath) return resolveLatestRpc(input);
  return resolveLatestEngineHook(input);
}

for (const fixture of fixtures) {
  test(`resolves the exact reviewed original source for ${fixture.relativePath}`, () => {
    // Given
    const input = inputs(fixture);
    // When
    const result = resolve(input);
    // Then
    expect(result.resolution.relativePath).toBe(fixture.relativePath);
    expect(result.resolution.commit).toBe(input.commit);
    expect(result.merged).not.toMatch(/^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m);
    if (fixture.relativePath === latestManagerResolution.relativePath) {
      const cancel = /  async cancelTask\([\s\S]*?\n  }\n/.exec(result.merged)?.[0];
      expect(cancel).toBeDefined();
      expect(cancel).toContain('if (options?.abort !== "skip" || !this.#live.has(outcome.task_id)) this.#concurrency.releaseTask(outcome.task_id)');
      expect(cancel).toContain('await this.#finishNative(record.task_id, record.notification.run_epoch, "cancelled")');
      expect(cancel).not.toContain('"natural"');
      expect(result.merged).toContain("stopSettlement: (taskId) => this.#stopsPending.settlement(taskId)");
      expect(result.merged).toContain("finishNative: (taskId, epoch, outcome, handle) => this.#finishNative(taskId, epoch, outcome, handle)");
    }
  });

  for (const field of ["upstream", "baseline", "hooked"]) {
    test(`rejects mutated ${field} bytes for ${fixture.relativePath}`, () => {
      // Given
      const input = inputs(fixture);
      const changed = Buffer.from(input[field]);
      changed[0] ^= 1;
      // When / Then
      expect(() => resolve({ ...input, [field]: changed })).toThrow();
    });
  }

  for (const field of ["version", "commit", "relativePath"]) {
    test(`rejects unknown ${field} for the exact ${fixture.relativePath} fixture`, () => {
      // Given
      const input = inputs(fixture);
      const resolver = fixture.relativePath === latestManagerResolution.relativePath ? resolveLatestManager
        : fixture.relativePath === latestTypesResolution.relativePath ? resolveLatestTypes
          : fixture.relativePath === latestRpcResolution.relativePath ? resolveLatestRpc : resolveLatestEngineHook;
      // When / Then
      expect(() => resolver({ ...input, [field]: "unknown" })).toThrow();
    });
  }

  test(`rejects changed conflict context for ${fixture.relativePath}`, () => {
    // Given: source bytes remain exact; only the diff3 conflict context changes.
    const input = inputs(fixture);
    const changed = input.conflicted.replace(/^=======\n/m, "=======\nunknown();\n");
    // When / Then
    expect(() => resolve({ ...input, conflicted: changed })).toThrow();
  });
}
