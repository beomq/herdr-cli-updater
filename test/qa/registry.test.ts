import { expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registry, parseDispatchRegistry, expandInvocation } from "../../scripts/qa/registry";
import { dispatchRegistry, dispatchArtifactCode, fileDigest, withIsolation } from "../../scripts/qa/runner";

test("registration admits only the exact fixed 24 command templates", () => {
  // Given
  const input: unknown = JSON.parse(JSON.stringify(registry));
  // When
  const parsed = parseDispatchRegistry(input);
  // Then
  expect(parsed.scenarios).toHaveLength(24);
  expect(new Set(parsed.scenarios.map(scenario => scenario.id)).size).toBe(24);
  expect(parsed.scenarios.every(scenario => scenario.artifacts.includes("result.json"))).toBe(true);
  expect(parsed.scenarios.every(scenario => scenario.contract.cleanupResourcesRemaining === 0)).toBe(true);
});

test.each([["extra"], ["omitted"], ["command"], ["digest"]] as const)("rejects %s registration without command evaluation", (change) => {
  // Given: mutations cross the unknown-file boundary, not the typed registry.
  const input = structuredClone(registry);
  switch (change) {
    case "extra": Reflect.set(input, "command", ["sh", "-c", "touch /tmp/unowned"]); break;
    case "omitted": Reflect.set(input, "scenarios", input.scenarios.slice(1)); break;
    case "command": Reflect.set(input.scenarios[0], "argv", ["-e", "process.exit(0)"]); break;
    case "digest": Reflect.set(input.scenarios[22].source, "sha256", "0".repeat(64)); break;
    default: throw new Error("unknown test mutation");
  }
  // When / Then
  expect(() => parseDispatchRegistry(input)).toThrow(expect.objectContaining({ code: "registry-mismatch" }));
});

test("expansion keeps quoted input literal and expands every socket token", () => {
  // Given
  const selection = registry.scenarios[1];
  const dual = registry.scenarios[12];
  // When
  const selectionArgs = expandInvocation(selection, "/private/qa", "/private/evidence");
  const dualArgs = expandInvocation(dual, "/private/qa", "/private/evidence");
  // Then
  expect(selectionArgs).toContain("{Enter}");
  expect(selectionArgs).toContain("/private/evidence/stale-selection");
  expect(dualArgs).toContain("/private/qa/core/a.sock,/private/qa/core/b.sock");
  expect(registry.scenarios[17].prelude?.argv).toEqual(["run", "test:ui"]);
});

test("provenance registration expands the actual CLI source contract", async () => {
  // Given
  const canonical: unknown = JSON.parse(await readFile(new URL("../../.omo/evidence/herdr-cli-updater/registry.json", import.meta.url), "utf8"));
  const provenance = parseDispatchRegistry(canonical).scenarios[22];
  // When
  const argv = expandInvocation(provenance, "/private/qa", "/private/evidence");
  // Then
  expect(argv).toEqual([
    "scripts/qa/provenance.ts", "--registry", "test/fixtures/provenance.json",
    "--core-source", "/private/qa/core/source", "--evidence-dir", "/private/evidence/provenance-gate",
  ]);
  expect(provenance.prerequisites.resources).toEqual(["QA/core/source"]);
  expect(provenance.prerequisites.build).toBe("owned-source-build-observation");
  expect(provenance.source.sha256).toBe("5cdad7053216e39729b1e978fac238d306fb3f4249c8fc027abdc7f9fec5d18d");
  expect(provenance.artifacts).toEqual(["actions.jsonl", "result.json", "cleanup.json"]);
  expect(provenance.contract).toEqual({
    status: "PASS", qualification: "native",
    assertions: ["immutableSourceBuildAgreement", "mismatchRejectsBeforeEffect"],
    captures: 1, sourceBuildDigestAgreement: true, cleanupResourcesRemaining: 0,
  });
});

test("real owned provenance invocation and missing runners produce 24 honest outcomes", async () => {
  // Given: only the genuine registered source is available, with no native
  // binaries, operating sockets or fixture-success receipts.
  const run = await withIsolation(async context => {
    const project = join(context.paths.root, "owned-project");
    await mkdir(join(project, "scripts/qa"), { recursive: true });
    const source = await readFile(new URL("../../scripts/qa/provenance.ts", import.meta.url));
    await writeFile(join(project, "scripts/qa/provenance.ts"), source);
    await mkdir(join(project, "test/fixtures"), { recursive: true });
    await writeFile(join(project, "test/fixtures/provenance.json"),
      await readFile(new URL("../fixtures/provenance.json", import.meta.url)));
    const registration = join(project, "registry.json");
    await writeFile(registration, JSON.stringify(registry));
    const evidence = join(project, ".omo/evidence/herdr-cli-updater/task8/dispatch-r1");
    // When
    const result = await dispatchRegistry(registration, evidence, project);
    // Then: stdout and exit are from a true spawn, not a substituted callback.
    expect(result.total).toBe(24);
    expect(result.qualified).toBe(0);
    expect(result.FullDone).toBe(false);
    expect(result.effects).toBeNull();
    expect(result.outcomes.filter(outcome => outcome.status === "BLOCKED")).toHaveLength(23);
    const provenance = result.outcomes.find(outcome => outcome.id === "provenance-gate");
    expect(provenance).toMatchObject({ status: "FAIL", code: "runner-nonzero", exitCode: 1, effects: null });
    const actions: unknown = JSON.parse(await readFile(join(result.runDir, "provenance-gate/actions.jsonl"), "utf8"));
    expect(actions).toMatchObject({
      execution: {
        exitCode: 1,
        argv: expect.arrayContaining(["--registry", "--core-source"]),
        stdout: expect.stringContaining('"status":"BLOCKED"'),
      },
      sourceBuildDigestAgreement: "UNVERIFIED",
    });
    const actual: unknown = JSON.parse(await readFile(join(result.runDir, "provenance-gate/actual/result.json"), "utf8"));
    expect(actual).toMatchObject({
      status: "BLOCKED", supportEnabled: false, blockedField: "artifact.io",
      updaterInvocations: 0, restartInvocations: 0,
    });
    const cleanup: unknown = JSON.parse(await readFile(join(result.runDir, "provenance-gate/cleanup.json"), "utf8"));
    expect(cleanup).toMatchObject({ rootRemoved: true, actionState: "joined", resourcesRemaining: 0 });
    const sourceHash = await fileDigest(join(project, "scripts/qa/provenance.ts"));
    expect(sourceHash).toBe(registry.scenarios[22].source.sha256);
    return result;
  });
  expect(run.cleanup.resourcesRemaining).toBe(0);
  await expect(stat(run.cleanup.root)).rejects.toHaveProperty("code", "ENOENT");
}, 15000);

test("separate runs preserve previous result bytes instead of recycling outcomes", async () => {
  // Given: no owned runners are present.
  const run = await withIsolation(async context => {
    const project = join(context.paths.root, "owned-project");
    await mkdir(project);
    const registration = join(project, "registry.json");
    await writeFile(registration, JSON.stringify(registry));
    const evidence = join(project, ".omo/evidence/herdr-cli-updater/task8/dispatch-r1");
    const first = await dispatchRegistry(registration, evidence, project);
    const firstHash = await fileDigest(join(first.runDir, "result.json"));
    // When
    const second = await dispatchRegistry(registration, evidence, project);
    // Then
    expect(first.runDir).not.toBe(second.runDir);
    expect(await fileDigest(join(first.runDir, "result.json"))).toBe(firstHash);
    expect(second.outcomes.every(outcome => outcome.status === "BLOCKED")).toBe(true);
  });
  expect(run.cleanup.resourcesRemaining).toBe(0);
});

test("unsafe evidence destination is rejected before output creation", async () => {
  // Given
  const run = await withIsolation(async context => {
    const registration = join(context.paths.root, "registry.json");
    await writeFile(registration, JSON.stringify(registry));
    // When / Then
    await expect(dispatchRegistry(registration, context.paths.prefix, context.paths.root))
      .rejects.toHaveProperty("code", "evidence-path");
    await expect(stat(join(context.paths.prefix, "runs"))).rejects.toHaveProperty("code", "ENOENT");
  });
  expect(run.cleanup.resourcesRemaining).toBe(0);
});

test.each([
  ["fixture-only-not-native", { status: "PASS", qualification: "fixture" }],
  ["source-build-digest-mismatch", { status: "PASS", qualification: "native", sourceSha256: "a", buildSourceSha256: "b" }],
  ["native-contract-unverified", { status: "PASS", qualification: "native", sourceSha256: "a", buildSourceSha256: "a" }],
] as const)("captured claims remain %s without producer-retained native proof", (code, claim) => {
  // Given
  const captures = [{ path: "result.json", bytes: new TextEncoder().encode(JSON.stringify(claim)) }];
  // When
  const observed = dispatchArtifactCode(captures, "a");
  // Then
  expect(observed).toBe(code);
});
