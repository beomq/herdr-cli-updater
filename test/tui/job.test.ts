import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobComponent } from "../../src/tui/job";
import { JobStore } from "../../src/jobs/store";
import { JobError } from "../../src/jobs/jobs";
import type { JobChange, NewJob } from "../../src/jobs/jobs";
import type { Job, Receipt, RuntimeBinding, TargetSelection } from "../../src/protocol";

const binding: RuntimeBinding = { socketId: "socket", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
  rootIncarnation: { pid: 10, startIdentity: "PRIVATE_START", executableRealpath: "/PRIVATE_BINARY" },
  session: { kind: "conversation", fullId: "PRIVATE_SESSION", storagePathHash: "PRIVATE_HASH" },
  cwd: "/PRIVATE_CWD", optionsRef: "PRIVATE_OPTIONS", turnGeneration: 1, resourcesFingerprint: "fp" };
const target: TargetSelection = { targetId: "target:a", runtimeId: "runtime", installationId: "install",
  expectedBinding: binding };
const base = { jobId: "job", requestId: "PRIVATE_REQUEST", installation: { installationId: "install",
  resourcesFingerprint: "fp", owner: { kind: "native", installerDigest: "PRIVATE_DIGEST", prefix: "/PRIVATE_PREFIX" },
  installedVersion: { kind: "unknown", reason: "not_captured" } } } as const;
const roots: string[] = [];
const stores: JobStore[] = [];
function setup(restart = false) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), "task28-test-"));
  roots.push(parent);
  const store = new JobStore(join(parent, "owned"));
  stores.push(store);
  const spec: NewJob = restart ? { ...base, mode: "update-and-restart", selectedTargets: [target] }
    : { ...base, mode: "update-only", selectedTargets: [] };
  store.create(spec);
  const change = (input: JobChange) => store.change({ jobId: "job", expectedRevision: store.get("job").revision }, input).job;
  return { store, change };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function installed(change: (input: JobChange) => Job): Job {
  change({ kind: "intent", effect: "updated", operationId: "PRIVATE_UPDATE", targetId: null });
  change({ kind: "observe", targetId: null,
    receipt: { kind: "completed", operationId: "PRIVATE_UPDATE", effect: "updated", identity: null } });
  return change({ kind: "verify-install" });
}
function exited(change: (input: JobChange) => Job): void {
  change({ kind: "claim", targetId: target.targetId });
  change({ kind: "intent", effect: "stopped", operationId: "PRIVATE_STOP", targetId: target.targetId });
  change({ kind: "observe", targetId: target.targetId,
    receipt: { kind: "completed", operationId: "PRIVATE_STOP", effect: "stopped", identity: binding } });
}

test("distinguishes persisted waiting resources from selected work completion", () => {
  // Given
  const { change } = setup(true);
  // When
  const job = change({ kind: "wait-resources" });
  const component = new JobComponent(job);
  component.input("d");
  const frame = component.render(120, 40);
  // Then: phase identifiers, not whole-copy snapshots.
  expect(frame).toContain(job.status);
  expect(frame).toContain(job.installTxn.state);
  expect(frame).toContain(job.targetTxns[0]?.state ?? "missing");
  expect(component.canCancel).toBe(true);
});
test.each(["queued", "waiting", "claimed"])("emits safe cancel for %s without claiming cancellation", phase => {
  // Given
  const { store, change } = setup(true);
  if (phase === "waiting") change({ kind: "wait-resources" });
  if (phase === "claimed") change({ kind: "claim", targetId: target.targetId });
  const component = new JobComponent(store.get("job"));
  const before = component.render(80, 24);
  const persisted = store.get("job");
  // When
  const action = component.input("c");
  // Then
  expect(action).toEqual({ ok: true, value: { operation: "cancel-job", jobId: "job", expectedRevision: persisted.revision } });
  expect(component.render(80, 24)).toBe(before);
  expect(store.get("job")).toEqual(persisted);
  expect(store.get("job").status).not.toBe("cancelled");
});
test.each(["updated", "stopped", "started"] as const)("rejects cancel after %s intent under the actual store contract", effect => {
  // Given
  const { store, change } = setup(effect !== "updated");
  if (effect === "stopped") change({ kind: "claim", targetId: target.targetId });
  if (effect === "started") { exited(change); installed(change); }
  if (effect === "updated") change({ kind: "intent", operationId: "op", effect, targetId: null });
  else change({ kind: "intent", operationId: "op", effect, targetId: target.targetId });
  const component = new JobComponent(store.get("job"));
  // When
  const result = component.input("c");
  // Then
  expect(result).toEqual({ ok: false, error: { code: "cancel_unsafe" } });
  expect(() => change({ kind: "cancel" })).toThrow(new JobError("cancel_unsafe"));
  component.input("d");
  expect(component.render(120, 40)).toContain("uncertain");
  expect(component.render(120, 40)).not.toContain("result: completed");
});
test("updates to cancelled only from a new persisted observation", () => {
  // Given
  const { change, store } = setup(true);
  const component = new JobComponent(store.get("job"));
  const cancelled = change({ kind: "cancel" });
  // When
  const result = component.refresh(cancelled);
  // Then
  expect(result).toEqual({ ok: true, value: { jobId: "job", expectedRevision: cancelled.revision } });
  expect(component.render(80, 24)).toContain("result: cancelled");
  expect(component.canCancel).toBe(false);
});
test.each(["absent", "in-progress", "uncertain"] as const)("does not turn %s receipt into success", kind => {
  // Given: public DTO can contain pending receipt even though current store folds it to uncertain.
  const { store } = setup();
  const job = store.get("job");
  if (job.mode !== "update-only") throw new JobError("invalid_transition");
  const receipt: Receipt = { kind, operationId: "PRIVATE_RECEIPT" };
  const observation: Job = { ...job, status: "running", installTxn: { ...job.installTxn, state: "updating", receipt } };
  // When
  const component = new JobComponent(observation);
  component.input("d");
  const frame = component.render(120, 40);
  // Then
  expect(frame).toContain(kind);
  expect(frame).toContain("unknown");
  expect(frame).not.toContain("result: completed");
  expect(component.canCancel).toBe(false);
});
test("preserves target failure and known stopped effect in partial public results", () => {
  // Given
  const { change } = setup(true);
  exited(change);
  const job = installed(change);
  if (job.mode !== "update-and-restart") throw new JobError("invalid_transition");
  const observation: Job = { ...job, status: "partial", targetTxns: job.targetTxns.map(t => ({
    ...t, state: "recovery_required", failure: { code: "verification_failed" },
  })) };
  // When
  const component = new JobComponent(observation);
  expect(component.render(120, 40)).not.toContain(target.targetId);
  component.input("d");
  const frame = component.render(120, 40);
  // Then
  expect(frame).toContain("result: partial");
  expect(frame).toContain(target.targetId);
  expect(frame).toContain("verification_failed");
  expect(frame).toContain("stopped");
  expect(frame).not.toContain("result: completed");
});
test("shows store recovery and failed outcomes separately from completed", () => {
  // Given
  const { change } = setup();
  change({ kind: "intent", operationId: "op", effect: "updated", targetId: null });
  const recovery = change({ kind: "observe", targetId: null, receipt: { kind: "in-progress", operationId: "op" } });
  change({ kind: "observe", targetId: null, receipt: { kind: "completed", operationId: "op", effect: "updated", identity: null } });
  const failed = change({ kind: "fail-install" });
  // When
  const recoveryFrame = new JobComponent(recovery).render(120, 40);
  const failedFrame = new JobComponent(failed).render(120, 40);
  // Then
  expect(recoveryFrame).toContain("result: recovery_required");
  expect(recoveryFrame).toContain("receipt_uncertain");
  expect(failedFrame).toContain("result: failed");
  expect(failedFrame).toContain("update_failed");
});
test("shows completed only after persisted verification, not the completed receipt", () => {
  // Given
  const { change } = setup();
  change({ kind: "intent", operationId: "op", effect: "updated", targetId: null });
  const verifying = change({ kind: "observe", targetId: null,
    receipt: { kind: "completed", operationId: "op", effect: "updated", identity: null } });
  const complete = change({ kind: "verify-install" });
  // When / Then
  expect(new JobComponent(verifying).render(80, 24)).not.toContain("result: completed");
  expect(new JobComponent(complete).render(80, 24)).toContain("result: completed");
  expect(new JobComponent(complete).canCancel).toBe(false);
});
test("rejects a claimed completed outcome whose receipt is still uncertain", () => {
  // Given
  const { change } = setup();
  const job = installed(change);
  if (job.status !== "completed" || job.mode === "restart-only") throw new JobError("invalid_transition");
  const inconsistent: Job = { ...job, installTxn: { ...job.installTxn,
    receipt: { kind: "uncertain", operationId: "PRIVATE_RECEIPT" } } };
  // When / Then
  expect(new JobComponent(inconsistent).render(120, 40)).not.toContain("result: completed");
});
test("rejects stale identity and revision for both caller actions after refresh", () => {
  // Given
  const { store, change } = setup();
  const component = new JobComponent(store.get("job"));
  const stale = component.observation;
  component.refresh(change({ kind: "wait-resources" }));
  // When / Then
  for (const key of ["c", "i"]) {
    expect(component.input(key, stale)).toEqual({ ok: false, error: { code: "revision_conflict" } });
    expect(component.input(key, { ...component.observation, jobId: "other" }))
      .toEqual({ ok: false, error: { code: "stale_selection" } });
  }
  expect(component.input("i")).toEqual({ ok: true, value: { operation: "inspect-job", ...component.observation } });
});
test("rejects older conflicting and different job observations without replacing current state", () => {
  // Given
  const { store, change } = setup();
  const initial = store.get("job");
  const current = change({ kind: "wait-resources" });
  const component = new JobComponent(current);
  const before = component.render(80, 24);
  // When / Then
  expect(component.refresh(initial)).toEqual({ ok: false, error: { code: "revision_conflict" } });
  expect(component.refresh({ ...current, status: "failed" })).toEqual({ ok: false, error: { code: "revision_conflict" } });
  expect(component.refresh({ ...current, jobId: "other" })).toEqual({ ok: false, error: { code: "stale_selection" } });
  expect(component.render(80, 24)).toBe(before);
});
test("never serializes private bindings receipts or extra credential fields into frames or actions", () => {
  // Given
  const { change } = setup(true);
  exited(change);
  const job = installed(change);
  const enriched = { ...job, token: "PRIVATE_TOKEN", argv: ["PRIVATE_ARGV"],
    env: { secret: "PRIVATE_ENV" }, transcript: "PRIVATE_TRANSCRIPT" };
  const component = new JobComponent(enriched);
  component.input("d");
  // When
  const output = component.render(120, 40) + JSON.stringify(component.input("i"));
  // Then
  expect(output).not.toContain("PRIVATE_");
  expect(component.input("u")).toBeNull();
  expect(component.input("r")).toBeNull();
});
test.each([80, 120, 1, 2])("bounds CJK and hostile control data to %i columns", width => {
  // Given: host observations are typed, but display data must still be sanitized.
  const { store } = setup();
  const job = store.get("job");
  if (job.mode !== "update-only") throw new JobError("invalid_transition");
  const name = `한글频道${"경로".repeat(100)}\x1b[31m\x1b]0;TITLE\x07\r\n\t\u009b31m\u202e`;
  const component = new JobComponent({ ...job, status: "queued", installTxn: { ...job.installTxn,
    selection: { ...job.installTxn.selection, installationId: name } } });
  component.input("d");
  // When
  const frame = component.render(width, 24);
  // Then
  expect(frame.split("\n").every(line => Bun.stringWidth(line) <= width)).toBe(true);
  expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  expect(frame).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
  expect(frame).not.toContain("TITLE");
  if (width >= 80) expect(frame).toContain("한글频道");
});
test("scrolls large target results while keeping the current outcome and actions visible", () => {
  // Given
  const { store } = setup(true);
  const job = store.get("job");
  if (job.mode !== "update-and-restart") throw new JobError("invalid_transition");
  const component = new JobComponent({ ...job, status: "queued", targetTxns: Array.from({ length: 30 }, (_, i) => ({
    ...target, targetId: `target:${i}`, state: "waiting_completion", receipt: null, failure: null,
  })) });
  component.input("d");
  // When
  for (let i = 0; i < 60; i++) component.input("PageDown");
  const frame = component.render(80, 24);
  // Then
  expect(frame).toContain("target:29");
  expect(frame).toContain("result: pending");
  expect(frame.split("\n").length).toBe(24);
});
