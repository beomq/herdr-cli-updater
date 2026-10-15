import { expect, test } from "bun:test";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { assertRedacted, lifecycleMain, parseLifecycleArgs, runRedaction } from "../../scripts/qa/lifecycle";
import { dispatchArtifactCode, withIsolation } from "../../scripts/qa/runner";

const sentinel = "ULW_SECRET_REDACTION_lifecycle_test";
const command = ["--scenario", "redaction", "--secret-sentinel", sentinel, "--evidence-dir", "E/redaction"] as const;

test.each(["catalog", "private-endpoint", "redaction-misspelled"])("rejects unimplemented scenario %s before effects", async scenario => {
  // Given
  const run = await withIsolation(async context => {
    const before = await readdir(context.paths.root);
    const evidence = join(context.paths.root, "must-not-exist");
    // When
    const rejected = lifecycleMain(["--scenario", scenario, "--secret-sentinel", sentinel, "--evidence-dir", evidence]);
    // Then
    await expect(rejected).rejects.toMatchObject({ code: "invalid-command" });
    expect(await Bun.file(evidence).exists()).toBe(false);
    expect(await readdir(context.paths.root)).toEqual(before);
  });
  expect(run.executions).toHaveLength(0);
  expect(run.cleanup.resourcesRemaining).toBe(0);
});

test.each([
  command.slice(0, 4),
  [...command, "--native-pass"],
  ["--scenario", "redaction", "--secret-sentinel", "", "--evidence-dir", "E/redaction"],
  ["--scenario", "redaction", "--secret-sentinel", sentinel, "--evidence-dir", "/tmp/foreign-evidence"],
].map(args => ({ args })))("rejects malformed or foreign output arguments at admission", ({ args }) => {
  // Given / When / Then
  expect(() => parseLifecycleArgs(args)).toThrow();
});

test("maps the exact registry token only into the owned subset evidence", () => {
  // Given / When
  const parsed = parseLifecycleArgs(command);
  // Then
  expect(parsed.sentinel).toBe(sentinel);
  expect(parsed.evidenceDir).toBe(join(import.meta.dir, "../../.omo/evidence/herdr-cli-updater/task33/redaction-r1/redaction"));
});

test.each(["prompt", "transcript", "capability", "path"])("detects a supplied secret in nested %s captures", field => {
  // Given: no redaction helper is allowed to silently sanitize production output.
  const value = { observations: [{ [field]: field === "path" ? `/private/${sentinel}/session` : sentinel }] };
  // When / Then
  expect(() => assertRedacted(value, [sentinel])).toThrow(expect.objectContaining({ code: "secret-leak" }));
  expect(() => assertRedacted({ observations: [{ code: "verification_failed" }] }, [sentinel])).not.toThrow();
});

test("drives production authenticated projection cancellation events rendering and cleanup without native qualification", async () => {
  // Given / When: retained spawn readiness and subscription ACK precede every action.
  const run = await runRedaction(sentinel);
  // Then: inspect real captured values independently of the runner's success boolean.
  expect(run.result).toMatchObject({ status: "BLOCKED", FullDone: false, subsetPassed: true,
    qualification: "production-integration-subset-not-native", failureCode: null,
    dependenciesStable: true, nativeProof: null, nativeUpdateResumeCaptures: 0, cleanupResourcesRemaining: 0 });
  const observed = (action: string) => run.actions.find(entry => entry.action === action)?.observed;
  expect(observed("installations")).toMatchObject({ ok: true, result: {
    installations: [{ family: "omo", installationId: "omo-redaction-fixture" }],
  } });
  expect(observed("runtimes")).toMatchObject({ ok: true, result: { runtimes: [{
    binding: { session: { fullId: "redaction-saved-session" } },
  }] } });
  expect(observed("unqualified-targets")).toMatchObject({ ok: true, result: { targets: [] } });
  for (const name of ["prompt", "transcript", "capability", "path"])
    expect(observed(`source-${name}-rejection`)).toMatchObject({ ok: false, error: { code: "malformed_request" } });
  expect(observed("source-throw-rejection")).toMatchObject({ ok: false, error: { code: "verification_failed" } });
  expect(run.actions.filter(entry => entry.action === "wire-rejection").map(entry => entry.observed))
    .toEqual([
      { version: 1, requestId: null, ok: false, error: { code: "malformed_request" } },
      { version: 1, requestId: null, ok: false, error: { code: "unauthorized" } },
    ]);
  expect(observed("public-inspection")).toMatchObject({ ok: true, result: { targets: [{
    effect: "unknown", lastIdentity: null, safeAction: "inspect",
  }] } });
  expect(observed("public-cancel")).toMatchObject({ ok: true, result: { kind: "cancelled",
    job: { revision: 1, status: "cancelled", targetTxns: [{ state: "cancelled" }] } } });
  expect(observed("public-event")).toMatchObject({ kind: "event", sequence: 1,
    response: observed("public-cancel") });
  expect(observed("persisted-after-shutdown")).toMatchObject({ revision: 1, status: "cancelled" });
  expect(observed("forged-completion-refused")).toMatchObject({ clientAdmitted: false,
    view: { verified: false, outcome: "unverified" } });
  expect(run.actions.filter(entry => entry.action === "component-render")).toHaveLength(2);
  expect(run.actions.filter(entry => entry.action === "db-file-scan").length).toBeGreaterThan(0);
  expect(JSON.stringify(run)).not.toContain(sentinel);
  expect(run.cleanup).toMatchObject({ rootRemoved: true, actionState: "joined", resourcesRemaining: 0,
    processes: [{ exitCode: 0, signal: null }] });
  expect(await Bun.file(run.cleanup?.root ?? "").exists()).toBe(false);
  expect(run.executions).toHaveLength(1);
  expect(run.executions[0]?.env["HOME"]).toStartWith(run.cleanup?.root ?? "missing");
  expect(run.manifest.before).toEqual(run.manifest.after);
  expect(run.manifest.build?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(run.manifest.nativeBuild).toBeNull();
  expect(dispatchArtifactCode([{ path: "result.json",
    bytes: new TextEncoder().encode(JSON.stringify(run.result)) }], run.result.sourceSha256))
    .toBe("fixture-only-not-native");
}, 40000);
