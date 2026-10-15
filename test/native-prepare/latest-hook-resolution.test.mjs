import { expect, test } from "bun:test";
import { assertReviewedManagerRevision, latestManagerResolution, latestTypesResolution, latestRpcResolution, resolveAdditiveManagerConflicts } from "../../scripts/native-prepare/latest-hook-resolution.mjs";

function reviewedConflict() {
  return [
    "<<<<<<< upstream",
    "      stopSettlement: (taskId) => this.#stopsPending.settlement(taskId),",
    "||||||| baseline",
    '        if (live === undefined) throw new Error("Granted workpool worker lost its live handle")',
    "=======",
    "      finishNative: (taskId, epoch, outcome, handle) => this.#finishNative(taskId, epoch, outcome, handle),",
    ">>>>>>> hooked",
    "  async cancelTask(idOrName: string, reason?: string, options?: CancelOptions): Promise<CancelOutcome> {",
    "<<<<<<< upstream",
    "      // A cancelled task never runs again, so no epoch of it may keep a lane slot - including a run",
    "      // whose live handle this manager already let go of, or never had (still launching). Only a live",
    "      // handle whose abort was skipped keeps its slot until its settled outcome releases it.",
    '      if (options?.abort !== "skip" || !this.#live.has(outcome.task_id)) this.#concurrency.releaseTask(outcome.task_id)',
    "||||||| baseline",
    "  }",
    "",
    "  tryClaimEviction(taskId: string): boolean {",
    "    if ((this.#sendCounts.get(taskId) ?? 0) > 0 || this.#evicting.has(taskId)) return false",
    "=======",
    "      const record = this.#tryLoad(outcome.task_id)",
    '      if (record && this.#nativeRuns.get(`${record.task_id}:${record.notification.run_epoch}`)?.phase === "queued") {',
    '        await this.#finishNative(record.task_id, record.notification.run_epoch, "cancelled")',
    "      }",
    ">>>>>>> hooked",
    "  }",
    "",
  ].join("\n");
}

test("preserves original stop settlement and native cancellation when reviewed insertions overlap", () => {
  // Given
  const source = reviewedConflict();
  // When
  const result = resolveAdditiveManagerConflicts(source);
  // Then: assert executable source semantics, not prose.
  expect(result).toContain("stopSettlement: (taskId) => this.#stopsPending.settlement(taskId)");
  expect(result).toContain("finishNative: (taskId, epoch, outcome, handle) => this.#finishNative(taskId, epoch, outcome, handle)");
  expect(result).toContain('if (options?.abort !== "skip" || !this.#live.has(outcome.task_id)) this.#concurrency.releaseTask(outcome.task_id)');
  expect(result).toContain('await this.#finishNative(record.task_id, record.notification.run_epoch, "cancelled")');
  expect(result).not.toContain('"natural"');
  expect(result).not.toContain("<<<<<<<");
});

test.each(["version", "commit", "relativePath", "upstreamSha256", "baselineSha256", "hookedSha256"])(
  "rejects unknown revision when %s changes", field => {
    // Given
    const inputs = { ...latestManagerResolution, [field]: "unknown" };
    // When / Then
    expect(() => assertReviewedManagerRevision(inputs)).toThrow();
  });

test.each(["version", "commit", "relativePath", "upstreamSha256", "baselineSha256", "hookedSha256"])(
  "rejects unreviewed options type revision when %s changes", field => {
    // Given
    const inputs = { ...latestTypesResolution, [field]: "unknown" };
    // When / Then
    expect(() => assertReviewedManagerRevision(inputs, latestTypesResolution)).toThrow();
  });

test.each(["version", "commit", "relativePath", "upstreamSha256", "baselineSha256", "hookedSha256"])(
  "rejects unreviewed RPC import revision when %s changes", field => {
    // Given
    const inputs = { ...latestRpcResolution, [field]: "unknown" };
    // When / Then
    expect(() => assertReviewedManagerRevision(inputs, latestRpcResolution)).toThrow();
  });

test("rejects unknown hook context when cancellation classification changes", () => {
  // Given
  const source = reviewedConflict().replace('"cancelled")', '"natural")');
  // When / Then
  expect(() => resolveAdditiveManagerConflicts(source)).toThrow();
});

test("rejects extra conflicts when source has an unreviewed overlap", () => {
  // Given
  const source = reviewedConflict() + "<<<<<<< upstream\nnew\n||||||| baseline\nold\n=======\nother\n>>>>>>> hooked\n";
  // When / Then
  expect(() => resolveAdditiveManagerConflicts(source)).toThrow();
});
