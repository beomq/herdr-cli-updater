import { expect, test } from "bun:test";
import { CatalogComponent } from "../../src/tui/catalog";
import { catalogColumns } from "../../src/tui/presentation";
import { readCatalog } from "../../src/catalog";
import type { CatalogSnapshot } from "../../src/catalog";
import type { AdapterCapabilities } from "../../src/adapters/types";
import type { Installation, Job, Runtime } from "../../src/protocol";

const unknown = { kind: "unknown", reason: "not_verified" } as const;
const caps: AdapterCapabilities = { check: { kind: "supported", reason: "verified", evidenceRef: "fixture" },
  update: unknown, busySafe: unknown, completion: { kind: "unknown", reason: "missing_bridge" },
  resume: unknown, gracefulExit: unknown };
function install(id: string, update = false): Installation {
  return { installationId: id, family: "codex", channel: "stable", executableRealpath: `/fixture/${id}`,
    resourcesFingerprint: `fp:${id}`, resources: [{ resourceId: id, realpath: `/fixture/${id}`, fingerprint: id }],
    owner: { kind: "native", prefix: "/fixture", installerDigest: "digest" },
    installedVersion: { kind: "known", version: "2.0.0" },
    lastCheck: update ? { checkedAt: 10, result: {
      kind: "update-available", installedVersion: "2.0.0", availableVersion: "3.0.0", checkedAt: 10,
    } } : null };
}
function runtime(installationId: string, socketId = "socket:a"): Runtime {
  return { installationId, runtimeId: "runtime", runningVersion: { kind: "known", version: "1.0.0" },
    binding: { socketId, socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
      rootIncarnation: { pid: 10, startIdentity: "start", executableRealpath: "/fixture/cli" },
      session: { kind: "conversation", fullId: "PRIVATE_SESSION", storagePathHash: "PRIVATE_HASH" },
      cwd: "/PRIVATE_CWD", optionsRef: "PRIVATE_OPTIONS", turnGeneration: 2, resourcesFingerprint: "fp" } };
}
function snapshot(installs: readonly Installation[], runtimes: readonly Runtime[] = [],
  capabilities: AdapterCapabilities = caps): CatalogSnapshot {
  return { installations: installs, runtimes, aliases: installs.map(i => ({
    installationId: i.installationId, canonicalId: i.installationId,
  })), failures: [], families: [], observations: installs.map(i => {
    const { lastCheck, ...installation } = i;
    return { sourceId: i.installationId, lastCheck,
      contract: { version: 1, family: installation.family, installation, runtime: null, capabilities } };
  }) };
}

test("sorts running before installed and updates first within each group", () => {
  // Given
  const input = snapshot([install("z"), install("live"), install("a"), install("update", true), install("live-update", true)],
    [runtime("live"), runtime("live-update")]);
  // When
  const component = new CatalogComponent(input);
  // Then
  expect(component.rows.map(row => row.installation.installationId)).toEqual(["live-update", "live", "update", "a", "z"]);
  expect(input.installations.map(row => row.installationId)).toEqual(["z", "live", "a", "update", "live-update"]);
});
test("keeps one row per installation while moving focus", () => {
  const component = new CatalogComponent(snapshot([install("a"), install("b")], [runtime("a")]));
  const before = component.render(120, 24).split("\n").filter(line => line.trim());
  component.input("ArrowDown");
  const after = component.render(120, 24).split("\n").filter(line => line.trim());
  expect(after).toHaveLength(before.length);
  expect(after.filter(line => /^[ >] codex/.test(line))).toHaveLength(2);
  expect(after.some(line => line.includes("/fixture/") || line.includes("2.0.0") && line.startsWith("    "))).toBe(false);
});
test("renders installed and captured running versions separately with check time and path", () => {
  // Given
  const component = new CatalogComponent(snapshot([install("a", true)], [runtime("a")]));
  component.input("d");
  // When
  const frame = component.render(120, 40);
  // Then: fixture values, not prose copy.
  for (const value of ["2.0.0", "1.0.0", "3.0.0", "1970-01-01T00:00:00.010Z", "/fixture/a"])
    expect(frame).toContain(value);
});
test("preserves unknown evidence and capability reasons without inferring readiness", () => {
  // Given
  const i = { ...install("a"), installedVersion: { kind: "unknown", reason: "probe_failed" } as const };
  const r = { ...runtime("a"), runningVersion: { kind: "unknown", reason: "not_captured" } as const };
  const component = new CatalogComponent(snapshot([i], [r], { ...caps, check: unknown }));
  component.input("d");
  // When
  const frame = component.render(120, 40);
  // Then
  for (const reason of ["probe_failed", "not_captured", "missing_bridge", "not_verified"])
    expect(frame).toContain(reason);
  expect(component.input("c")).toBeNull();
});
test("refresh retains identity when ordering changes instead of using the row index", () => {
  // Given
  const component = new CatalogComponent(snapshot([install("a"), install("b")]));
  component.input("j");
  // When
  component.refresh(snapshot([install("b", true), install("a")]));
  // Then
  expect(component.selectedInstallationId).toBe("b");
  expect(component.input("c")).toEqual({ operation: "check", installationId: "b" });
});
test("refresh clears disappeared identity rather than checking a neighbor", () => {
  // Given
  const component = new CatalogComponent(snapshot([install("a"), install("b")]));
  // When
  component.refresh(snapshot([install("b")]));
  // Then
  expect(component.selectedInstallationId).toBeNull();
  expect(component.input("c")).toBeNull();
});
test("expands and collapses socket-local runtimes without exposing bindings", () => {
  // Given
  const component = new CatalogComponent(snapshot([install("a")], [runtime("a"), runtime("a", "socket:b")]));
  expect(component.render(120, 40)).not.toContain("socket:a/pane");
  // When
  component.input("Enter");
  // Then
  const frame = component.render(120, 40);
  expect(frame).toContain("socket:a/pane");
  expect(frame).toContain("socket:b/pane");
  for (const secret of ["PRIVATE_SESSION", "PRIVATE_HASH", "PRIVATE_CWD", "PRIVATE_OPTIONS"])
    expect(frame).not.toContain(secret);
});
test("collapses expanded runtimes on the second input", () => {
  // Given
  const component = new CatalogComponent(snapshot([install("a")], [runtime("a")]));
  component.input("Enter");
  // When
  component.input(" ");
  // Then
  expect(component.render(120, 40)).not.toContain("socket:a/pane");
});
test("returns only the public read-only check intent and ignores effect keys", () => {
  // Given
  const component = new CatalogComponent(snapshot([install("a")]));
  // When
  const action = component.input("c");
  // Then
  expect(action).toEqual({ operation: "check", installationId: "a" });
  for (const key of ["u", "r", "create-job", "\x1b[31m"]) expect(component.input(key)).toBeNull();
});
test("missing observations cannot enable check", () => {
  // Given
  const component = new CatalogComponent({ ...snapshot([install("a")]), observations: [] });
  // When / Then
  expect(component.input("c")).toBeNull();
});
test("check failures render their public code without replacing installed evidence", () => {
  // Given
  const i: Installation = { ...install("a"), lastCheck: { checkedAt: 20,
    result: { kind: "unavailable", failure: { code: "verification_failed" }, checkedAt: 20 } } };
  // When
  const component = new CatalogComponent(snapshot([i]));
  component.input("d");
  const frame = component.render(80, 24);
  // Then
  expect(frame).toContain("verification_failed");
  expect(frame).toContain("2.0.0");
});
test("unsupported check result preserves its public code in the latest column", () => {
  // Given
  const i: Installation = { ...install("a"), lastCheck: { checkedAt: 20,
    result: { kind: "unavailable", failure: { code: "unsupported" }, checkedAt: 20 } } };
  // When
  const component = new CatalogComponent(snapshot([i]));
  const frame = component.render(120, 24);
  // Then
  expect(frame).toContain("unsupported");
  expect(frame).toContain("2.0.0");
});
test("consumes catalog alias grouping and remaps selection on canonical refresh", async () => {
  // Given: actual catalog17 aggregation, two identities sharing one resource.
  const a = install("a"), b = { ...a, installationId: "b" };
  const observations = snapshot([a, b]).observations;
  const catalog = await readCatalog({ candidates: observations.map(row => ({
    candidateId: row.sourceId, family: row.contract.family, read: async () => ({ ok: true, value: {
      contract: row.contract, lastCheck: row.lastCheck,
    } }),
  })), sockets: [] });
  const component = new CatalogComponent(catalog);
  expect(component.rows).toHaveLength(1);
  expect(component.rows[0]?.aliases).toEqual(["b"]);
  component.input("Enter");
  // When
  component.refresh({ ...snapshot([b], [runtime("b")]), aliases: [{ installationId: "a", canonicalId: "b" }] });
  // Then
  expect(component.selectedInstallationId).toBe("b");
  expect(component.render(120, 40)).toContain("socket:a/pane");
  expect(component.input("c")).toEqual({ operation: "check", installationId: "b" });
});
test("conflicting alias capability observations never enable check", () => {
  // Given
  const a = install("a"), b = { ...a, installationId: "b" };
  const input = snapshot([a]);
  const other = snapshot([b], [], { ...caps, check: unknown }).observations;
  const component = new CatalogComponent({ ...input, observations: [...input.observations, ...other],
    aliases: [{ installationId: "b", canonicalId: "a" }] });
  // When / Then
  expect(component.input("c")).toBeNull();
});
test.each([80, 120])("keeps CJK, long paths and hostile control fields within %i columns", columns => {
  // Given
  const i = { ...install("a"), channel: "한글频道",
    executableRealpath: `/한글/路径/${"아".repeat(200)}\x1b[31m\x1b]0;TITLE\x07\r\n\t\u009b31m\u202e` };
  const component = new CatalogComponent(snapshot([i]));
  component.input("d");
  // When
  const frame = component.render(columns, 24);
  // Then
  expect(frame).toContain("한글频道");
  expect(frame).toContain("/한글/路径/");
  expect(frame.split("\n").every(line => Bun.stringWidth(line) <= columns)).toBe(true);
  expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  expect(frame).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
  expect(frame).not.toContain("TITLE");
});
test("empty catalog cannot produce a check action", () => {
  // Given
  const component = new CatalogComponent(snapshot([]));
  // When
  const frame = component.render(80, 24);
  // Then
  expect(frame.length).toBeGreaterThan(0);
  expect(component.selectedInstallationId).toBeNull();
  expect(component.input("j")).toBeNull();
  expect(component.input("c")).toBeNull();
});
test("shows public Job state without converting waiting into ready or serializing bindings", () => {
  // Given
  const i = install("a");
  const job: Job = { jobId: "job:waiting", requestId: "request", revision: 0, mode: "update-only",
    selectedTargets: [], targetTxns: [], status: "waiting", failure: null,
    installTxn: { selection: i, state: "waiting_resources", receipt: null, failure: null } };
  // When
  const component = new CatalogComponent(snapshot([i]), [job]);
  expect(component.render(120, 40)).not.toContain(job.jobId);
  component.input("d");
  const frame = component.render(120, 40);
  // Then
  expect(frame).toContain("job:waiting");
  expect(frame).toContain("waiting_resources");
});
test("paging reaches expanded panes beyond a small viewport", () => {
  // Given
  const component = new CatalogComponent(snapshot([install("a")], Array.from({ length: 30 },
    (_, index) => runtime("a", `socket:${index}`))));
  component.input("Enter");
  const before = component.render(80, 24);
  // When
  component.input("PageDown");
  // Then
  const after = component.render(80, 24);
  expect(after).not.toEqual(before);
  expect(after).toContain("socket:10/pane");
  expect(after.split("\n").every(line => Bun.stringWidth(line) <= 80)).toBe(true);
});
test("renders protocol-valid timestamps beyond the Date range without throwing", () => {
  // Given: protocol counters permit safe integers beyond ECMAScript Date range.
  const checkedAt = 8_640_000_000_000_001;
  const i: Installation = { ...install("a"), lastCheck: { checkedAt,
    result: { kind: "unavailable", checkedAt, failure: { code: "verification_failed" } } } };
  // When
  const component = new CatalogComponent(snapshot([i]));
  component.input("d");
  const frame = component.render(80, 24);
  // Then
  expect(frame).toContain(String(checkedAt));
});

test.each([20, 80, 120].flatMap(columns => ["한", "界", "🙂"].map(glyph => ({ columns, glyph }))))
("r2 excludes a wide glyph crossing the clipping boundary %p", ({ columns, glyph }) => {
  // Given: prefix leaves one cell for a two-cell glyph before the ellipsis budget.
  const i = { ...install("a"), executableRealpath: "/" + "x".repeat(columns - 15) + glyph + "x".repeat(20) };
  // When
  const frame = new CatalogComponent(snapshot([i])).render(columns, 24);
  // Then
  expect(frame.split("\n").every(line => Bun.stringWidth(line) <= columns)).toBe(true);
});
test.each([1, 2].flatMap(columns => [0, 1, 2, 3, 4, 24].map(height => ({ columns, height }))))
("r2 bounds very narrow columns and short height %p", ({ columns, height }) => {
  // Given
  const i = { ...install("a"), channel: "한界🙂", executableRealpath: "/한界🙂" };
  // When
  const frame = new CatalogComponent(snapshot([i]), []).render(columns, height);
  // Then
  expect(frame.split("\n").every(line => Bun.stringWidth(line) <= columns)).toBe(true);
  expect(frame === "" ? 0 : frame.split("\n").length).toBeLessThanOrEqual(height);
});
test.each(["duplicate", "incarnation"])("r2 distinguishes one physical pane from two %s observations", kind => {
  // Given: every observation is retained even when the physical pane is ambiguous.
  const first = runtime("a");
  const second = kind === "duplicate" ? first : { ...first, runtimeId: "other",
    runningVersion: { kind: "known", version: "9.0.0" } as const,
    binding: { ...first.binding, paneGeneration: 2,
      rootIncarnation: { ...first.binding.rootIncarnation, pid: 11, startIdentity: "new" } } };
  const component = new CatalogComponent(snapshot([install("a")], [first, second]));
  // When
  component.input("Enter");
  // Then: parse numeric displayed fields, not the surrounding copy.
  const frame = component.render(120, 40);
  const widths = catalogColumns(120);
  const start = widths.slice(0, 3).reduce((sum, width) => sum + width + 1, 0);
  const row = frame.split("\n").find(line => line.startsWith("> ")) ?? "";
  expect(Number(Bun.sliceAnsi(row, start, start + (widths[3] ?? 0)).trim())).toBe(1);
  expect(component.rows[0]?.runtimes).toEqual([first, second]);
  expect(frame.split("\n").filter(line => line.includes("[ambiguous]"))).toHaveLength(2);
  expect(frame.split("\n").filter(line => line.includes("socket:a/pane"))).toHaveLength(2);
  if (kind === "incarnation") expect(frame).toContain("9.0.0");
});
test("r2 keeps equal pane IDs on different sockets as two physical panes", () => {
  // Given
  const a = runtime("a"), b = runtime("a", "socket:b");
  const component = new CatalogComponent(snapshot([install("a")], [a, b]));
  // When
  component.input("Enter");
  // Then
  const frame = component.render(120, 40);
  const widths = catalogColumns(120);
  const start = widths.slice(0, 3).reduce((sum, width) => sum + width + 1, 0);
  const row = frame.split("\n").find(line => line.startsWith("> ")) ?? "";
  expect(Number(Bun.sliceAnsi(row, start, start + (widths[3] ?? 0)).trim())).toBe(2);
  expect(component.rows[0]?.runtimes).toEqual([a, b]);
  expect(frame).not.toContain("[ambiguous]");
});
test.each([80, 120])("r2 strips controls from short public fields at %i columns", async columns => {
  // Given: both fields fit without truncation, so omission cannot pass by clipping.
  const i = { ...install("a"), channel: "stable\u202e", executableRealpath: "/fixture/cli\u009b" };
  const catalog = await readCatalog({ candidates: snapshot([i]).observations.map(row => ({
    candidateId: row.sourceId, family: row.contract.family,
    read: async () => ({ ok: true, value: { contract: row.contract, lastCheck: row.lastCheck } }),
  })), sockets: [] });
  expect(catalog.failures).toEqual([]);
  // When
  const component = new CatalogComponent(catalog);
  component.input("d");
  const frame = component.render(columns, 24);
  // Then
  expect(frame).toContain("/fixture/cli");
  expect(frame.split("\n").every(line => !/[\p{Cc}\p{Cf}]/u.test(line))).toBe(true);
});
