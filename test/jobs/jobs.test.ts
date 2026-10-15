import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../../src/jobs/store";
import { JobError } from "../../src/jobs/jobs";
import type { JobChange, NewJob } from "../../src/jobs/jobs";
import type { RuntimeBinding, TargetSelection, TargetTransaction } from "../../src/protocol";

const roots: string[] = [];
const stores: JobStore[] = [];
const binding: RuntimeBinding = { socketId: "socket", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
  rootIncarnation: { pid: 10, startIdentity: "old", executableRealpath: "/qa/bin/cli" },
  session: { kind: "conversation", fullId: "exact", storagePathHash: "hash" }, cwd: "/qa/project",
  optionsRef: "opaque-options", turnGeneration: 2, resourcesFingerprint: "fingerprint" };
const target: TargetSelection = { targetId: "target", runtimeId: "runtime", installationId: "install", expectedBinding: binding };
function spec(restart = false): NewJob {
  const base = { jobId: "job", requestId: "request", installation: { installationId: "install", resourcesFingerprint: "fingerprint",
    owner: { kind: "native", installerDigest: "digest", prefix: "/qa/install" }, installedVersion: { kind: "known", version: "1" } } } as const;
  return restart ? { ...base, mode: "update-and-restart", selectedTargets: [target] }
    : { ...base, mode: "update-only", selectedTargets: [] };
}
function setup(input = spec()) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), "job-state-"));
  roots.push(parent);
  const path = join(parent, "owned");
  const store = new JobStore(path);
  stores.push(store);
  store.create(input);
  const change = (event: JobChange) => store.change({ jobId: "job", expectedRevision: store.get("job").revision }, event).job;
  return { store, change, path };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function stopped(change: (event: JobChange) => unknown) {
  change({ kind: "claim", targetId: "target" });
  change({ kind: "intent", effect: "stopped", operationId: "stop", targetId: "target" });
  change({ kind: "observe", targetId: "target", receipt: { kind: "completed", operationId: "stop", effect: "stopped", identity: binding } });
}
function installed(change: (event: JobChange) => unknown) {
  change({ kind: "intent", effect: "updated", operationId: "update", targetId: null });
  change({ kind: "observe", targetId: null, receipt: { kind: "completed", operationId: "update", effect: "updated", identity: null } });
  change({ kind: "verify-install" });
}
function newBinding(): RuntimeBinding {
  return { ...binding, paneGeneration: 2, rootIncarnation: { ...binding.rootIncarnation, pid: 11, startIdentity: "new" } };
}

test("completes update-only only after matching receipt and explicit caller verification", () => {
  // Given
  const { store, change } = setup();
  // When
  installed(change);
  // Then
  expect(store.get("job")).toMatchObject({ status: "completed", mode: "update-only", selectedTargets: [], targetTxns: [], installTxn: { state: "succeeded" } });
});
test("completes restart only after stopped update and exact started receipt are verified", () => {
  // Given
  const { store, change } = setup(spec(true));
  stopped(change);
  installed(change);
  expect(store.get("job").status).toBe("partial");
  change({ kind: "intent", targetId: "target", operationId: "start", effect: "started" });
  change({ kind: "observe", targetId: "target", receipt: { kind: "completed", operationId: "start", effect: "started", identity: newBinding() } });
  expect(store.get("job").status).toBe("partial");
  // When
  change({ kind: "verify-target", targetId: "target" });
  // Then
  expect(store.get("job").status).toBe("completed");
});
test.each(["queued", "waiting", "claimed"])("cancels safely before any irreversible intent at %s", state => {
  // Given
  const { change } = setup(spec(true));
  if (state === "waiting") change({ kind: "wait-resources" });
  if (state === "claimed") change({ kind: "claim", targetId: "target" });
  // When
  const job = change({ kind: "cancel" });
  // Then
  expect(job.status).toBe("cancelled");
  expect(job.targetTxns[0]?.state).toBe("cancelled");
  expect(() => change({ kind: "intent", effect: "updated", operationId: "late", targetId: null })).toThrow(new JobError("invalid_transition"));
});
test.each(["updated", "stopped", "started"] as const)("rejects cancellation after %s intent", effect => {
  // Given
  const { change } = setup(spec(effect !== "updated"));
  if (effect === "stopped") change({ kind: "claim", targetId: "target" });
  if (effect === "started") { stopped(change); installed(change); }
  if (effect === "updated") change({ kind: "intent", effect, operationId: "op", targetId: null });
  else change({ kind: "intent", effect, operationId: "op", targetId: "target" });
  // When / Then
  expect(() => change({ kind: "cancel" })).toThrow(new JobError("cancel_unsafe"));
});
test.each(["absent", "in-progress", "uncertain"] as const)("keeps %s observations in recovery and never reauthorizes effects", kind => {
  // Given
  const { change } = setup();
  change({ kind: "intent", effect: "updated", operationId: "op", targetId: null });
  // When
  const job = change({ kind: "observe", targetId: null, receipt: { kind, operationId: "op" } });
  // Then
  expect(job.status).toBe("recovery_required");
  expect(() => change({ kind: "intent", effect: "updated", operationId: "retry", targetId: null })).toThrow(new JobError("invalid_transition"));
});
test.each(["operation", "effect", "identity"])("rejects mismatching install receipt %s without revision mutation", field => {
  // Given
  const { store, change } = setup();
  change({ kind: "intent", effect: "updated", operationId: "op", targetId: null });
  // When / Then
  expect(() => change({ kind: "observe", targetId: null, receipt: { kind: "completed",
    operationId: field === "operation" ? "wrong" : "op", effect: field === "effect" ? "started" : "updated",
    identity: field === "identity" ? binding : null } })).toThrow(new JobError("receipt_mismatch"));
  expect(store.get("job").revision).toBe(1);
});
test.each(["session", "cwd", "optionsRef", "epoch", "pane", "generation", "incarnation", "executable", "turn"])("rejects started receipt with wrong %s binding", field => {
  // Given
  const { change } = setup(spec(true));
  stopped(change);
  installed(change);
  change({ kind: "intent", targetId: "target", operationId: "start", effect: "started" });
  const fresh = newBinding();
  const identity = { ...fresh,
    ...(field === "session" ? { session: { ...binding.session, fullId: "different" } } : {}),
    ...(field === "cwd" ? { cwd: "/different" } : {}),
    ...(field === "optionsRef" ? { optionsRef: "different" } : {}),
    ...(field === "epoch" ? { socketEpoch: "different" } : {}),
    ...(field === "pane" ? { paneId: "different" } : {}),
    ...(field === "generation" ? { paneGeneration: 1 } : {}),
    ...(field === "incarnation" ? { rootIncarnation: binding.rootIncarnation } : {}),
    ...(field === "executable" ? { rootIncarnation: { ...fresh.rootIncarnation, executableRealpath: "/other" } } : {}),
    ...(field === "turn" ? { turnGeneration: 0 } : {}) };
  // When / Then
  expect(() => change({ kind: "observe", targetId: "target", receipt: { kind: "completed", operationId: "start", effect: "started", identity } }))
    .toThrow(new JobError("receipt_mismatch"));
});
test("never updates while a selected target has not exited", () => {
  // Given
  const { change } = setup(spec(true));
  // When / Then
  expect(() => change({ kind: "intent", effect: "updated", operationId: "update", targetId: null })).toThrow(new JobError("invalid_transition"));
});
test("never succeeds without a receipt or starts before successful install", () => {
  // Given
  const { change } = setup(spec(true));
  stopped(change);
  // When / Then
  expect(() => change({ kind: "verify-install" })).toThrow(new JobError("invalid_transition"));
  expect(() => change({ kind: "intent", effect: "started", operationId: "start", targetId: "target" })).toThrow(new JobError("invalid_transition"));
});
test("retains partial status when one of several selected targets remains unfinished", () => {
  // Given
  const input = spec(true);
  const second = { ...target, targetId: "second", runtimeId: "second", expectedBinding: { ...binding, paneId: "second" } };
  const { change, store } = setup({ ...input, mode: "update-and-restart", selectedTargets: [target, second] });
  stopped(change);
  change({ kind: "claim", targetId: "second" });
  change({ kind: "intent", effect: "stopped", operationId: "stop2", targetId: "second" });
  change({ kind: "observe", targetId: "second", receipt: { kind: "completed", operationId: "stop2", effect: "stopped", identity: second.expectedBinding } });
  installed(change);
  change({ kind: "intent", effect: "started", operationId: "start", targetId: "target" });
  change({ kind: "observe", targetId: "target", receipt: { kind: "completed", operationId: "start", effect: "started", identity: newBinding() } });
  // When
  change({ kind: "verify-target", targetId: "target" });
  // Then
  expect(store.get("job").status).toBe("partial");
});
test.each(["token", "argv", "env", "transcript"])("rejects nested %s in stored binding and receipt without leakage", field => {
  // Given
  const { store, change, path } = setup(spec(true));
  const secret = "ULW_SECRET_REDACTION_nested";
  const poisoned = { ...binding, [field]: secret };
  // When / Then
  expect(() => store.create({ ...spec(true), mode: "update-and-restart", selectedTargets: [{ ...target, expectedBinding: poisoned }] })).toThrow(new JobError("invalid_input"));
  expect(() => change({ kind: "observe", targetId: "target", receipt: { kind: "completed", operationId: "secret", effect: "stopped", identity: poisoned } })).toThrow(new JobError("invalid_input"));
  for (const name of readdirSync(path)) expect(readFileSync(join(path, name)).includes(Buffer.from(secret))).toBe(false);
});

test("deduplicates target sets regardless of object key or selection order", () => {
  // Given
  const second = { ...target, targetId: "second", runtimeId: "second", expectedBinding: { ...binding, paneId: "second" } };
  const input: NewJob = { ...spec(true), mode: "update-and-restart", selectedTargets: [target, second] };
  const { store } = setup(input);
  // When
  const repeated = store.create({ ...input, selectedTargets: [second, target],
    installation: { installedVersion: input.installation.installedVersion, owner: input.installation.owner,
      resourcesFingerprint: input.installation.resourcesFingerprint, installationId: input.installation.installationId } });
  // Then
  expect(repeated.kind).toBe("existing");
  expect(repeated.job.revision).toBe(0);
});

test("keeps a failed or explicitly recovered install from authorizing a retry", () => {
  // Given
  const { change } = setup();
  change({ kind: "intent", targetId: null, effect: "updated", operationId: "op" });
  // When
  const failed = change({ kind: "fail-install" });
  const recovered = change({ kind: "recover" });
  // Then
  expect(failed.status).not.toBe("completed");
  expect(recovered.status).toBe("recovery_required");
  expect(() => change({ kind: "intent", targetId: null, effect: "updated", operationId: "retry" })).toThrow(new JobError("invalid_transition"));
});

test("retains the stopped receipt when a later start becomes uncertain", () => {
  // Given
  const { change, store } = setup(spec(true));
  stopped(change);
  installed(change);
  // When
  change({ kind: "intent", effect: "started", operationId: "start", targetId: "target" });
  // Then
  expect(store.operation("stop")).toEqual({ jobId: "job", targetId: "target", effect: "stopped",
    receipt: { kind: "completed", operationId: "stop", effect: "stopped", identity: binding } });
  expect(store.operation("start").receipt.kind).toBe("uncertain");
  expect(store.get("job").status).toBe("recovery_required");
});

function crossSocketSpec(): NewJob {
  return { ...spec(true), mode: "update-and-restart", selectedTargets: [
    target, { ...target, targetId: "target-other", expectedBinding: { ...binding, socketId: "socket-other", socketEpoch: "epoch-other" } },
  ] };
}
test("persists reused runtime and pane IDs on two sockets across reopen", () => {
  // Given
  const input = crossSocketSpec();
  const { store, path } = setup(input);
  store.close();
  // When
  using reopened = new JobStore(path);
  const job: { readonly selectedTargets: readonly TargetSelection[]; readonly targetTxns: readonly TargetTransaction[]; readonly status: string } = reopened.get("job");
  // Then
  expect(job.selectedTargets).toEqual(input.selectedTargets);
  expect(job.targetTxns).toHaveLength(2);
  expect(job.targetTxns.map(item => item.state)).toEqual(["waiting_completion", "waiting_completion"]);
  expect(job.status).toBe("queued");
});
test("deduplicates the same cross socket request after reopen and target reordering", () => {
  // Given
  const input = crossSocketSpec();
  const { store, path } = setup(input);
  store.close();
  using reopened = new JobStore(path);
  const [first, second] = input.selectedTargets;
  if (!first || !second) throw new JobError("invalid_input");
  // When
  const repeated = reopened.create({ ...input, mode: "update-and-restart", selectedTargets: [second, first] });
  // Then
  expect(repeated.kind).toBe("existing");
  expect(repeated.job.revision).toBe(0);
  expect(repeated.job.selectedTargets).toEqual(input.selectedTargets);
});
test("rejects a namespace identity change for the same durable request", () => {
  // Given
  const input = crossSocketSpec();
  const { store } = setup(input);
  const [first, second] = input.selectedTargets;
  if (!first || !second) throw new JobError("invalid_input");
  // When / Then
  expect(() => store.create({ ...input, mode: "update-and-restart", selectedTargets: [
    first, { ...second, expectedBinding: { ...second.expectedBinding, socketId: "replacement-socket" } },
  ] })).toThrow(new JobError("request_conflict"));
  expect(store.get("job").selectedTargets).toEqual(input.selectedTargets);
});
test.each([
  { kind: "runtime-on-same-socket", second: { ...target, targetId: "target-other", expectedBinding: { ...binding, paneId: "other-pane" } } },
  { kind: "physical-pane-across-generations", second: { ...target, targetId: "target-other", runtimeId: "runtime-other", expectedBinding: { ...binding, paneGeneration: 2 } } },
  { kind: "mixed-epochs-on-same-socket", second: { ...target, targetId: "target-other", runtimeId: "runtime-other", expectedBinding: { ...binding, paneId: "other-pane", socketEpoch: "other-epoch" } } },
  { kind: "global-target-id", second: { ...target, expectedBinding: { ...binding, socketId: "other-socket" } } },
])("rejects $kind without persisting the invalid selection", ({ second }) => {
  // Given
  const { store } = setup();
  // When / Then
  expect(() => store.create({ ...spec(true), mode: "update-and-restart", jobId: "invalid", requestId: "invalid",
    selectedTargets: [target, second] })).toThrow(new JobError("invalid_input"));
  expect(() => store.get("invalid")).toThrow(new JobError("not_found"));
  expect(store.get("job").revision).toBe(0);
});
