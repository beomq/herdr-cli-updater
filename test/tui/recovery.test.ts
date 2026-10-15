import { expect, test } from "bun:test";
import { RecoveryComponent, RecoveryError } from "../../src/tui/recovery";
import type { Job, Receipt, RuntimeBinding, TargetSelection } from "../../src/protocol";

const binding: RuntimeBinding = { socketId: "socket:a", socketEpoch: "epoch", paneId: "pane",
  paneGeneration: 1, rootIncarnation: { pid: 10, startIdentity: "PRIVATE_START", executableRealpath: "/PRIVATE_BINARY" },
  session: { kind: "file", fullId: "/PRIVATE_SESSION", storagePathHash: "PRIVATE_HASH" },
  cwd: "/PRIVATE_CWD", optionsRef: "PRIVATE_OPTIONS", turnGeneration: 1, resourcesFingerprint: "fp" };
const target: TargetSelection = { targetId: "target:a", runtimeId: "runtime", installationId: "install", expectedBinding: binding };
function fixture(receipt: Receipt | null = null): Job & { readonly mode: "update-and-restart"; readonly status: "recovery_required" } {
  return { jobId: "job", requestId: "PRIVATE_REQUEST", revision: 1, mode: "update-and-restart",
    status: "recovery_required", failure: { code: "receipt_uncertain" }, selectedTargets: [target],
    installTxn: { selection: { installationId: "install", resourcesFingerprint: "fp",
      owner: { kind: "native", installerDigest: "PRIVATE_DIGEST", prefix: "/PRIVATE_PREFIX" },
      installedVersion: { kind: "known", version: "1.0" } }, state: "queued", receipt: null, failure: null },
    targetTxns: [{ ...target, state: "recovery_required", receipt, failure: { code: "receipt_uncertain" } }] };
}
const started: RuntimeBinding = { ...binding, paneGeneration: 2,
  rootIncarnation: { ...binding.rootIncarnation, pid: 20, startIdentity: "PRIVATE_NEW" } };

test.each([null, "absent", "in-progress", "uncertain"] as const)("keeps %s receipt unknown and unverified", kind => {
  // Given
  const job = fixture(kind === null ? null : { kind, operationId: "PRIVATE_OP" });
  // When
  const view = new RecoveryComponent(job).view;
  // Then
  expect(view.targets[0]?.effect).toBe("unknown");
  expect(view.targets[0]?.verified).toBe(false);
  expect(view.verified).toBe(false);
});
test.each(["updated", "stopped", "started"] as const)("separates known %s effect from verification", effect => {
  // Given
  const job = fixture({ kind: "completed", effect, operationId: "PRIVATE_OP",
    identity: effect === "started" ? started : binding });
  // When
  const view = new RecoveryComponent(job).view;
  // Then
  expect(view.targets[0]?.effect).toBe(effect);
  expect(view.targets[0]?.verified).toBe(false);
  expect(view.verified).toBe(false);
});
test.each([null, "absent", "in-progress", "uncertain", "completed"] as const)(
  "does not verify installation from %s receipt alone", kind => {
    // Given
    const job = fixture();
    const receipt: Receipt | null = kind === null ? null : kind === "completed"
      ? { kind, effect: "updated", operationId: "op", identity: null } : { kind, operationId: "op" };
    // When
    const component = new RecoveryComponent({ ...job, installTxn: { ...job.installTxn, state: "verifying", receipt } });
    // Then
    expect(component.view.installation.verified).toBe(false);
    expect(component.view.installation.effect).toBe(kind === "completed" ? "updated" : "unknown");
    expect(component.view.installation.beforeVersion).toEqual({ kind: "known", version: "1.0" });
    expect(component.view.installation.observedVersion).toBeNull();
  });
test("preserves partial and failed outcomes even with a verified installation", () => {
  // Given
  const job = fixture({ kind: "completed", effect: "stopped", operationId: "PRIVATE_OP", identity: binding });
  const installTxn = { ...job.installTxn, state: "succeeded", receipt: {
    kind: "completed", effect: "updated", operationId: "PRIVATE_UPDATE", identity: null,
  }, failure: null } as const;
  // When
  const views = (["partial", "failed"] as const).map(status => new RecoveryComponent({ ...job, status, installTxn }).view);
  // Then
  expect(views.map(view => view.outcome)).toEqual(["partial", "failed"]);
  expect(views.every(view => view.installation.verified && !view.verified)).toBe(true);
});
test("requires matching session socket epoch and new generation for verified start", () => {
  // Given
  const job = fixture();
  const installTxn = { ...job.installTxn, state: "succeeded", failure: null,
    receipt: { kind: "completed", effect: "updated", operationId: "PRIVATE_UPDATE", identity: null } } as const;
  const identities = [started, { ...started, socketId: "socket:b" }, { ...started, socketEpoch: "other" },
    { ...started, paneGeneration: 1 }, { ...started, session: { ...binding.session, fullId: "/OTHER" } },
    { ...started, optionsRef: "other" }, { ...started, cwd: "/OTHER" },
    { ...started, rootIncarnation: binding.rootIncarnation }];
  // When
  const views = identities.map(identity => new RecoveryComponent({ ...job, status: "completed", failure: null,
    installTxn, targetTxns: [{ ...target, state: "completed", failure: null,
      receipt: { kind: "completed", effect: "started", operationId: "PRIVATE_START_OP", identity } }] }).view);
  // Then
  expect(views.map(view => view.verified)).toEqual([true, false, false, false, false, false, false, false]);
  expect(views[0]?.targets[0]?.identity).toBe("verified");
});
test("distinguishes absent identity from a matching stopped session", () => {
  // Given
  const receipts: Receipt[] = [ { kind: "completed", effect: "stopped", operationId: "op", identity: null },
    { kind: "completed", effect: "stopped", operationId: "op", identity: binding } ];
  // When
  const views = receipts.map(receipt => new RecoveryComponent(fixture(receipt)).view);
  // Then
  expect(views.map(view => view.targets[0]?.identity)).toEqual(["absent", "verified"]);
  expect(views.every(view => !view.targets[0]?.verified)).toBe(true);
});
test("selects equal pane IDs on distinct sockets without changing the job", () => {
  // Given
  const job = fixture();
  const second = { ...target, targetId: "target:b", expectedBinding: { ...binding, socketId: "socket:b" } };
  const component = new RecoveryComponent({ ...job, selectedTargets: [target, second],
    targetTxns: [...job.targetTxns, { ...second, state: "waiting_completion", failure: null, receipt: null }] });
  // When
  component.input("ArrowDown");
  // Then
  expect(component.view.selectedTargetId).toBe("target:b");
  expect(component.input("i")).toEqual({ ok: true, value: { operation: "inspect-job", jobId: "job", expectedRevision: 1 } });
  expect(component.view.targets.map(t => t.socketId)).toEqual(["socket:a", "socket:b"]);
});
test("invalidates stale inspect intent and clears full-binding changed selection", () => {
  // Given
  const job = fixture();
  const component = new RecoveryComponent(job);
  const stale = component.observation;
  const changed = { ...target, expectedBinding: { ...binding, socketEpoch: "new" } };
  // When
  const refreshed = component.refresh({ ...job, revision: 2, selectedTargets: [changed],
    targetTxns: [{ ...job.targetTxns[0], ...changed, state: "recovery_required", receipt: null, failure: null }] });
  // Then
  expect(refreshed.ok).toBe(true);
  expect(component.view.selectedTargetId).toBeNull();
  expect(component.input("i", stale)).toEqual({ ok: false, error: { code: "revision_conflict" } });
});
test("rejects conflicting observations without replacing the snapshot", () => {
  // Given
  const job = fixture();
  const component = new RecoveryComponent(job);
  // When
  const results = [component.refresh({ ...job, status: "failed" }),
    component.refresh({ ...job, revision: 0 }), component.refresh({ ...job, jobId: "other" })];
  // Then
  expect(results.map(r => r.ok ? null : r.error.code)).toEqual(["revision_conflict", "revision_conflict", "stale_selection"]);
  expect(component.view.outcome).toBe("recovery_required");
});
test("detaches caller mutation and rejects getters without evaluating them", () => {
  // Given
  const job = fixture();
  const component = new RecoveryComponent(job);
  let calls = 0;
  const hostile = { ...job };
  Object.defineProperty(hostile.installTxn, "state", { enumerable: true, get() { calls++; return "succeeded"; } });
  // When / Then
  expect(() => new RecoveryComponent(hostile)).toThrow(RecoveryError);
  expect(() => component.refresh(hostile)).toThrow(RecoveryError);
  expect(calls).toBe(0);
  expect(component.view.installation.verified).toBe(false);
  const ordinary = fixture();
  const detached = new RecoveryComponent(ordinary);
  Object.defineProperty(ordinary, "status", { value: "completed" });
  expect(detached.view.outcome).toBe("recovery_required");
});
test("allowlists displayed data and emits only inspect or local back intents", () => {
  // Given
  const job = fixture({ kind: "completed", effect: "stopped", operationId: "PRIVATE_OP", identity: binding });
  const enriched = { ...job, argv: ["PRIVATE_ARGV"], token: "PRIVATE_TOKEN", prompt: "PRIVATE_PROMPT",
    env: { secret: "PRIVATE_ENV" }, failure: { code: "missing_session", message: "PRIVATE_ERROR" } } as const;
  const component = new RecoveryComponent(enriched);
  // When
  const output = component.render(120, 40) + JSON.stringify(component.view) + JSON.stringify(component.input("i"));
  // Then
  expect(output).not.toContain("PRIVATE_");
  expect(component.view.diagnostic).toBe("missing_session");
  expect(["r", "u", "c", "s"].map(key => component.input(key))).toEqual([null, null, null, null]);
  expect(component.input("Enter")).toEqual({ ok: true, value: { operation: "inspect-job", jobId: "job", expectedRevision: 1 } });
  component.input("d");
  expect(component.render(120, 40)).not.toContain("PRIVATE_");
  expect(component.input("Escape")).toEqual({ ok: true, value: { operation: "back" } });
});
test.each([1, 2, 20, 80, 120])("sanitizes controls and CJK crossing cuts at width %i", width => {
  // Given
  const job = fixture();
  const component = new RecoveryComponent({ ...job, jobId: "j\u202e\u009b\x1b]0;PRIVATE_OSC\x07",
    installTxn: { ...job.installTxn, selection: { ...job.installTxn.selection, installedVersion: {
      kind: "known", version: "x".repeat(Math.max(0, width - 20)) + "한" + "x".repeat(200),
    } } } });
  // When
  const frame = component.render(width, 24);
  // Then
  expect(frame.split("\n").every(line => Bun.stringWidth(line) <= width)).toBe(true);
  expect(frame).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  expect(frame).not.toContain("PRIVATE_OSC");
});
test("keeps overall failure visible through bounded target detail scrolling", () => {
  // Given
  const job = fixture();
  const component = new RecoveryComponent(job);
  const before = component.render(80, 8);
  // When
  for (let i = 0; i < 30; i++) component.input("PageDown");
  const after = component.render(80, 8);
  // Then
  expect(after.split("\n").length).toBeLessThanOrEqual(8);
  expect(after.split("\n")[0]).toBe(before.split("\n")[0]);
  expect(after).not.toBe(before);
  expect(component.view.verified).toBe(false);
});
