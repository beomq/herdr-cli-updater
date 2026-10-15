import { expect, test } from "bun:test";
import { EventEmitter, once } from "node:events";
import { isCheckResult, readCatalog, validateCatalogSelection } from "../src/catalog";
import type { CatalogObservation, CatalogReaders, CoreObservation } from "../src/catalog";
import { FAMILIES } from "../src/adapters/types";
import type { AdapterCapabilities } from "../src/adapters/types";
import type { Family, Runtime } from "../src/protocol";
import manifest from "./fixtures/provenance.json";

const unknown = { kind: "unknown", reason: "not_verified" } as const;

test("check result admission rejects contradictory machine fields and invalid attempt time", () => {
  // Given / When / Then: the same validator protects private dispatch and retained metadata.
  expect(isCheckResult({ kind: "unavailable", failure: { code: "receipt_uncertain" }, checkedAt: 123 })).toBe(true);
  expect(isCheckResult({ kind: "up-to-date", installedVersion: "5.1.9", checkedAt: Number.NaN })).toBe(false);
  expect(isCheckResult({ kind: "unavailable", failure: { code: "receipt_uncertain" }, availableVersion: "invented", checkedAt: 123 })).toBe(false);
});
const capabilities: AdapterCapabilities = {
  check: unknown, update: { kind: "unsupported", reason: "unverified_owner" },
  busySafe: { kind: "unknown", reason: "unsafe_installer" },
  completion: { kind: "unknown", reason: "missing_bridge" }, resume: unknown, gracefulExit: unknown,
};
function observation(family: Family): CatalogObservation {
  return {
    contract: {
      version: 1, family, capabilities, runtime: null,
      installation: {
        installationId: `install:${family}`, family, channel: "unknown",
        executableRealpath: `/fixture/${family}`, owner: { kind: "unknown", reason: "unverified_owner" },
        installedVersion: { kind: "unknown", reason: "not_captured" },
        resourcesFingerprint: `sha256:${family}`,
        resources: [{ resourceId: `resource:${family}`, realpath: `/fixture/${family}`, fingerprint: `sha256:${family}` }],
      },
    },
    lastCheck: null,
  };
}
function runtime(row: CatalogObservation, socketId: string, paneId: string): CatalogObservation {
  return {
    ...row, contract: { ...row.contract, runtime: {
      runtimeId: `runtime:${paneId}`, installationId: row.contract.installation.installationId,
      runningVersion: { kind: "unknown", reason: "not_captured" },
      binding: {
        socketId, socketEpoch: `epoch:${socketId}`, paneId, paneGeneration: 1,
        rootIncarnation: { pid: 123, startIdentity: `start:${paneId}`, executableRealpath: row.contract.installation.executableRealpath },
        session: { kind: "conversation", fullId: `session:${paneId}`, storagePathHash: `sha256:${paneId}` },
        cwd: "/fixture/workspace", optionsRef: `options:${paneId}`, turnGeneration: 2,
        resourcesFingerprint: row.contract.installation.resourcesFingerprint,
      },
    } },
  };
}
function readers(rows: readonly CatalogObservation[], sockets: readonly CatalogObservation[] = []): CatalogReaders {
  const socketIds = [...new Set(sockets.map(row => row.contract.runtime?.binding.socketId))];
  return {
    candidates: rows.map((value, index) => ({
      candidateId: `candidate:${index}`, family: value.contract.family,
      read: async () => ({ ok: true, value }),
    })),
    sockets: socketIds.flatMap(socketId => socketId === undefined ? [] : [{
      socketId, socketEpoch: `epoch:${socketId}`,
      read: async () => ({ ok: true, value: sockets.filter(row => row.contract.runtime?.binding.socketId === socketId) }),
    }]),
  };
}
function installed(family: Family, update: boolean): CatalogObservation {
  const row = observation(family);
  return {
    contract: { ...row.contract, installation: {
      ...row.contract.installation, installedVersion: { kind: "known", version: "1.0.0" },
    } },
    lastCheck: { checkedAt: 10, result: update
      ? { kind: "update-available", installedVersion: "1.0.0", availableVersion: "2.0.0", checkedAt: 10 }
      : { kind: "up-to-date", installedVersion: "1.0.0", checkedAt: 10 } },
  };
}
function wrapper(id: string, family: "omo" | "pi" = "omo"): CatalogObservation {
  const row = observation(family);
  return { ...row, contract: { ...row.contract, installation: {
    ...row.contract.installation, installationId: id, executableRealpath: `/fixture/${id}`,
    channel: "pinned", resourcesFingerprint: "sha256:owned",
    owner: { kind: "wrapper", packageName: "omo-ai", prefix: "/fixture/owned", engineResourceId: "resource:engine" },
    resources: [{ resourceId: "resource:engine", realpath: "/fixture/owned/engine", fingerprint: "sha256:engine" }],
  } } };
}

test("preserves all eight fixture families without promoting observed source receipts to support", async () => {
  // Given: synthetic identity vectors; manifest is inventory, not installed-owner proof.
  expect(manifest.installers.map(row => row.family).sort()).toEqual([...FAMILIES].sort());
  const rows = FAMILIES.map(observation);
  // When: aggregate only explicitly supplied candidates.
  const catalog = await readCatalog(readers(rows));
  // Then: unknown versions/ownership and unsupported reasons survive unchanged.
  expect(catalog.installations).toHaveLength(8);
  expect(catalog.failures).toEqual([]);
  expect(catalog.families.map(row => row.observationCount)).toEqual(Array(8).fill(1));
  expect(catalog.observations.every(row => row.contract.capabilities.update.kind === "unsupported")).toBe(true);
  expect(catalog.installations.every(row => row.installedVersion.kind === "unknown" && row.owner.kind === "unknown")).toBe(true);
});

test("deduplicates shared engine wrappers while preserving every pane and socket runtime", async () => {
  // Given: two OmO wrappers and its owned Pi view, plus an unrelated standalone Pi.
  const a = wrapper("install:a"), b = wrapper("install:b"), pi = wrapper("install:owned-pi", "pi");
  const live = [runtime(a, "socket:a", "pane:a"), runtime(b, "socket:a", "pane:b"),
    runtime(pi, "socket:b", "pane:a")];
  // When: installation equivalence is aggregated independently of runtime identity.
  const catalog = await readCatalog(readers([b, observation("pi"), pi, a], live));
  // Then: one owned install, one standalone, three uncollapsed runtimes.
  expect(catalog.installations).toHaveLength(2);
  expect(catalog.runtimes).toHaveLength(3);
  expect(catalog.runtimes.map(row => row.installationId)).toEqual(Array(3).fill("install:a"));
  expect(catalog.runtimes.map(row => [row.binding.socketId, row.binding.paneId])).toEqual([
    ["socket:a", "pane:a"], ["socket:a", "pane:b"], ["socket:b", "pane:a"],
  ]);
  expect(catalog.runtimes.map(row => row.binding.session.fullId)).toEqual(["session:pane:a", "session:pane:b", "session:pane:a"]);
  expect(catalog.aliases).toContainEqual({ installationId: "install:b", canonicalId: "install:a" });
  expect(catalog.failures).toEqual([]);
});

test("orders running first then update available then stable family name", async () => {
  // Given: installed update candidates and live version evidence captured separately.
  const a = installed("agy", true), c = installed("claude", false), o = installed("omo", true);
  // When: discovery order is intentionally reversed.
  const catalog = await readCatalog(readers([o, c, a], [runtime(c, "socket:a", "pane:a")]));
  // Then: live Claude is ahead of the update-only candidates.
  expect(catalog.installations.map(row => row.family)).toEqual(["claude", "agy", "omo"]);
  expect(catalog.runtimes[0]?.runningVersion).toEqual({ kind: "unknown", reason: "not_captured" });
});

test.each(["fingerprint", "channel", "resource", "owner", "version"] as const)(
  "blocks conflicting %s without losing the runtime or selecting the newest check", async field => {
    // Given: conflicting observations of one owned resource.
    const a = wrapper("install:a"), b = wrapper("install:b");
    const changed = { ...b.contract.installation,
      ...(field === "fingerprint" ? { resourcesFingerprint: "sha256:changed" } : {}),
      ...(field === "channel" ? { channel: "beta" } : {}),
      ...(field === "resource" ? { resources: [{ resourceId: "resource:engine", realpath: "/fixture/owned/engine", fingerprint: "sha256:changed" }] } : {}),
      ...(field === "owner" ? { owner: { kind: "wrapper" as const, packageName: "other", prefix: "/fixture/owned", engineResourceId: "resource:engine" } } : {}),
      ...(field === "version" ? { installedVersion: { kind: "known" as const, version: "2.0.0" } } : {}),
    };
    const conflicted: CatalogObservation = { ...b, contract: { ...b.contract, installation: changed } };
    // When: include a runtime referencing the earlier observation.
    const catalog = await readCatalog(readers([a, conflicted], [runtime(a, "socket:a", "pane:a")]));
    // Then: there is no selectable installation, but its runtime is still visible.
    expect(catalog.installations).toEqual([]);
    expect(catalog.runtimes).toHaveLength(1);
    expect(catalog.failures.every(row => row.error.code === "stale_selection")).toBe(true);
    expect(catalog.failures.length).toBeGreaterThan(0);
  },
);

test("rejects contradictory checks even when a first observation has no check", async () => {
  // Given: same installed snapshot with two contradictory recorded checks.
  const a = installed("omo", false), b = installed("omo", true);
  // When: a null-check observation is also present.
  const catalog = await readCatalog(readers([{ ...a, lastCheck: null }, a, b]));
  // Then: no latest-timestamp or first-observation fallback.
  expect(catalog.installations).toEqual([]);
  expect(catalog.failures).toHaveLength(3);
});

test("keeps missing families and explicit busy socket failure honest", async () => {
  // Given: no installs for seven families; runtime access is explicitly busy.
  const input = readers([observation("agy")]);
  // When: the registered socket fails to yield a snapshot.
  const catalog = await readCatalog({ ...input, sockets: [{
    socketId: "socket:a", socketEpoch: "epoch:socket:a",
    read: async () => ({ ok: false, error: { code: "resources_busy" } }),
  }] });
  // Then: no idle/core claims, placeholders or invented missing installations.
  expect(catalog.installations).toHaveLength(1);
  expect(catalog.runtimes).toEqual([]);
  expect(catalog.failures).toEqual([{ sourceId: "socket:a", error: { code: "resources_busy" } }]);
  expect(catalog.families.filter(row => row.observationCount === 0)).toHaveLength(7);
});

test("freezes captured snapshots before a later private reader mutates its source", async () => {
  // Given: independently read candidates; later reader can mutate shared inputs.
  const source = observation("omo");
  // When: mutation occurs only after the first read has been captured.
  const catalog = await readCatalog({ candidates: [
    { candidateId: "candidate:a", family: "omo", read: async () => ({ ok: true, value: source }) },
    { candidateId: "candidate:b", family: "pi", read: async () => {
      Object.assign(source.contract.installation, { channel: "changed" });
      return { ok: true, value: observation("pi") };
    } },
  ], sockets: [] });
  // Then: snapshot and its nested identities are immutable and detached.
  expect(catalog.installations.find(row => row.family === "omo")?.channel).toBe("unknown");
  expect(Object.isFrozen(catalog)).toBe(true);
  expect(Object.isFrozen(catalog.installations[0]?.resources)).toBe(true);
  expect(Object.isFrozen(catalog.observations[0]?.contract.installation.owner)).toBe(true);
});

test.each(["socketEpoch", "paneGeneration", "turnGeneration", "optionsRef", "session", "rootIncarnation"] as const)(
  "fails closed for a stale selected runtime %s", async field => {
    // Given: an exact selected installation and runtime from one snapshot.
    const row = observation("omo"), live = runtime(row, "socket:a", "pane:a");
    const catalog = await readCatalog(readers([row], [live]));
    const install = catalog.installations[0], current = catalog.runtimes[0];
    if (!install || !current) throw new TypeError("fixture missing");
    const binding: Runtime["binding"] = { ...current.binding,
      ...(field === "socketEpoch" ? { socketEpoch: "epoch:new" } : {}),
      ...(field === "paneGeneration" ? { paneGeneration: 99 } : {}),
      ...(field === "turnGeneration" ? { turnGeneration: 99 } : {}),
      ...(field === "optionsRef" ? { optionsRef: "options:new" } : {}),
      ...(field === "session" ? { session: { ...current.binding.session, fullId: "session:new" } } : {}),
      ...(field === "rootIncarnation" ? { rootIncarnation: { ...current.binding.rootIncarnation, startIdentity: "start:new" } } : {}),
    };
    // When: submit a stale binding against the fresh snapshot.
    const result = validateCatalogSelection(catalog, install, [{ ...current, binding }]);
    // Then: only the exact incarnation can pass.
    expect(result).toEqual({ ok: false, error: { code: "stale_binding" } });
  },
);

test("accepts exact selection and rejects channel or fingerprint drift", async () => {
  // Given: an immutable installation snapshot.
  const catalog = await readCatalog(readers([observation("omo")]));
  const install = catalog.installations[0];
  if (!install) throw new TypeError("fixture missing");
  // When / Then: exact selection succeeds; neither stale channel nor stale resources do.
  expect(validateCatalogSelection(catalog, install, [])).toEqual({ ok: true, value: null });
  expect(validateCatalogSelection(catalog, { ...install, channel: "beta" }, [])).toEqual({ ok: false, error: { code: "stale_selection" } });
  expect(validateCatalogSelection(catalog, { ...install, resourcesFingerprint: "sha256:new" }, [])).toEqual({ ok: false, error: { code: "stale_selection" } });
});

test("discards arbitrary thrown values without exception inspection or coercion", async () => {
  // Given: private readers throwing hostile payloads, synchronously or asynchronously.
  let accesses = 0;
  const poison = new Proxy({}, { get() { accesses++; throw new TypeError("poison"); },
    getPrototypeOf() { accesses++; throw new TypeError("poison"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const payloads = [new Error("PRIVATE_SENTINEL"), "PRIVATE_SENTINEL", null, poison, revoked.proxy];
  // When: capture all failures through the reader boundary.
  const catalog = await readCatalog({
    candidates: payloads.map((payload, index) => ({
      candidateId: `candidate:${index}`, family: "omo",
      read: () => { throw payload; },
    })),
    sockets: payloads.map((payload, index) => ({
      socketId: `socket:${index}`, socketEpoch: `epoch:${index}`,
      read: async () => { throw payload; },
    })),
  });
  // Then: only fixed public codes are returned; no hooks, exceptions or secret text.
  expect(catalog.failures).toHaveLength(10);
  expect(catalog.failures.every(row => row.error.code === "verification_failed")).toBe(true);
  expect(accesses).toBe(0);
  expect(JSON.stringify(catalog)).not.toContain("PRIVATE_SENTINEL");
});

test("rejects malformed reader output and private startup fields without projection", async () => {
  // Given: a malformed success value and a contract carrying private options/env.
  const a = observation("omo"), live = runtime(a, "socket:a", "pane:a");
  if (!live.contract.runtime) throw new TypeError("fixture missing");
  const injected = { ...live, contract: { ...live.contract,
    runtime: { ...live.contract.runtime, environment: { TOKEN: "PRIVATE_SENTINEL" }, options: ["PRIVATE_SENTINEL"] },
  } };
  // When: both cross the private reader output boundary.
  const catalog = await readCatalog({
    candidates: [{ candidateId: "candidate:a", family: "omo", read: async () => JSON.parse("null") }],
    sockets: [{ socketId: "socket:a", socketEpoch: "epoch:socket:a", read: async () => ({ ok: true, value: [injected] }) }],
  });
  // Then: malformed records cannot become public DTOs or logs.
  expect(catalog.installations).toEqual([]);
  expect(catalog.runtimes).toEqual([]);
  expect(catalog.failures.map(row => row.error.code)).toEqual(["malformed_request", "malformed_request"]);
  expect(JSON.stringify(catalog)).not.toContain("PRIVATE_SENTINEL");
});

test("rejects a mismatching socket epoch while preserving another socket snapshot", async () => {
  // Given: two registered sockets with one stale observation.
  const a = observation("omo"), good = runtime(a, "socket:a", "pane:a");
  const stale = runtime(a, "socket:b", "pane:b");
  // When: the observed epoch differs from the explicitly registered one.
  const input = readers([a], [good, stale]);
  const catalog = await readCatalog({ ...input,
    sockets: input.sockets.map(row => row.socketId === "socket:b" ? { ...row, socketEpoch: "epoch:new" } : row),
  });
  // Then: no stale runtime is adopted and no independent socket row is lost.
  expect(catalog.runtimes).toHaveLength(1);
  expect(catalog.runtimes[0]?.binding.socketId).toBe("socket:a");
  expect(catalog.failures).toEqual([{ sourceId: "socket:b", error: { code: "stale_binding" } }]);
});

test("captures reader result accessors once before validating the immutable record", async () => {
  // Given: a getter would return private malformed data on its second invocation.
  let accesses = 0;
  const safe = observation("omo");
  const output = { ok: true as const, get value() {
    accesses++;
    return accesses === 1 ? safe : { ...safe, token: "PRIVATE_SENTINEL" };
  } };
  // When: capture and then validate the result.
  const catalog = await readCatalog({ candidates: [
    { candidateId: "candidate:a", family: "omo", read: async () => output },
  ], sockets: [] });
  // Then: parsing uses exactly the captured value, with no second getter access.
  expect(accesses).toBe(1);
  expect(catalog.installations).toHaveLength(1);
  expect(JSON.stringify(catalog)).not.toContain("PRIVATE_SENTINEL");
});

test("contains throwing private reader accessors inside the opaque boundary", async () => {
  // Given: merely retrieving the injected reader may throw a private value.
  const input = readers([observation("omo")], [runtime(observation("omo"), "socket:a", "pane:a")]);
  const candidate = input.candidates[0], socket = input.sockets[0];
  if (!candidate || !socket) throw new TypeError("fixture missing");
  Object.defineProperty(candidate, "read", { get() { throw "PRIVATE_SENTINEL"; } });
  Object.defineProperty(socket, "read", { get() { throw "PRIVATE_SENTINEL"; } });
  // When: invoke the private boundary.
  const catalog = await readCatalog(input);
  // Then: no escaped exception or private payload.
  expect(catalog.failures.map(row => row.error.code)).toEqual(["verification_failed", "verification_failed"]);
  expect(JSON.stringify(catalog)).not.toContain("PRIVATE_SENTINEL");
});

test.each(["runtimeId", "turnGeneration", "rootIncarnation", "paneGeneration"] as const)(
  "rejects both retained physical pane rows when %s conflicts", async field => {
    // Given: two observed identities occupying the same physical socket/pane.
    const install = observation("omo"), first = runtime(install, "socket:a", "pane:shared");
    const original = first.contract.runtime;
    if (!original) throw new TypeError("fixture missing");
    const second: CatalogObservation = { ...first, contract: { ...first.contract, runtime: {
      ...original,
      ...(field === "runtimeId" ? { runtimeId: "runtime:other" } : {}),
      binding: { ...original.binding,
        ...(field === "turnGeneration" ? { turnGeneration: original.binding.turnGeneration + 1 } : {}),
        ...(field === "rootIncarnation" ? { rootIncarnation: { ...original.binding.rootIncarnation, startIdentity: "start:new" } } : {}),
        ...(field === "paneGeneration" ? { paneGeneration: original.binding.paneGeneration + 1 } : {}),
      },
    } } };
    const catalog = await readCatalog(readers([install], [first, second]));
    const selectedInstall = catalog.installations[0], a = catalog.runtimes[0], b = catalog.runtimes[1];
    if (!selectedInstall || !a || !b) throw new TypeError("fixture missing");
    // When: validate either exact row against the complete observed context.
    const results = [a, b].map(row => validateCatalogSelection(catalog, selectedInstall, [row]));
    // Then: no oldest/newest winner, no lost observations, and no collection failure masking F1.
    expect(results).toEqual(Array(2).fill({ ok: false, error: { code: "stale_binding" } }));
    expect(catalog.runtimes).toHaveLength(2);
    expect(catalog.observations.filter(row => row.contract.runtime !== null)).toHaveLength(2);
    expect(catalog.failures).toEqual([]);
  },
);

test("rejects physical pane ambiguity across retained socket epochs", async () => {
  // Given: observations of the same physical socket/pane from two explicit epochs.
  const install = observation("omo"), first = runtime(install, "socket:a", "pane:shared");
  const original = first.contract.runtime;
  if (!original) throw new TypeError("fixture missing");
  const second: CatalogObservation = { ...first, contract: { ...first.contract,
    runtime: { ...original, binding: { ...original.binding, socketEpoch: "epoch:new" } },
  } };
  const input = readers([install], [first]);
  const catalog = await readCatalog({ ...input, sockets: [...input.sockets, {
    socketId: "socket:a", socketEpoch: "epoch:new", read: async () => ({ ok: true, value: [second] }),
  }] });
  const selectedInstall = catalog.installations[0], selected = catalog.runtimes[0];
  if (!selectedInstall || !selected) throw new TypeError("fixture missing");
  // When: select the old exact row with another epoch still observed.
  const result = validateCatalogSelection(catalog, selectedInstall, [selected]);
  // Then: changing epoch is not a way to silently choose one physical pane record.
  expect(result).toEqual({ ok: false, error: { code: "stale_binding" } });
  expect(catalog.runtimes).toHaveLength(2);
  expect(catalog.failures).toEqual([]);
});

test("retains identical duplicate rows and keeps their existing selection rejection", async () => {
  // Given: the same complete runtime DTO observed twice.
  const install = observation("omo"), live = runtime(install, "socket:a", "pane:shared");
  const catalog = await readCatalog(readers([install], [live, live]));
  const selectedInstall = catalog.installations[0], selected = catalog.runtimes[0];
  if (!selectedInstall || !selected) throw new TypeError("fixture missing");
  // When: select the duplicated exact identity.
  const result = validateCatalogSelection(catalog, selectedInstall, [selected]);
  // Then: existing duplicate semantics remain fail-closed, not deduped.
  expect(result).toEqual({ ok: false, error: { code: "stale_binding" } });
  expect(catalog.runtimes).toHaveLength(2);
  expect(catalog.observations.filter(row => row.contract.runtime !== null)).toHaveLength(2);
});

test("accepts exact rows on unrelated physical panes even when runtime IDs match", async () => {
  // Given: socket-local IDs collide, but physical socket/pane contexts do not.
  const install = observation("omo");
  const catalog = await readCatalog(readers([install], [
    runtime(install, "socket:a", "pane:shared"), runtime(install, "socket:b", "pane:shared"),
  ]));
  const selectedInstall = catalog.installations[0];
  if (!selectedInstall) throw new TypeError("fixture missing");
  // When: validate the exact two rows through the catalog primitive only.
  const result = validateCatalogSelection(catalog, selectedInstall, catalog.runtimes);
  // Then: F1 is physical-context based; protocol's separate F2 remains outside this fix.
  expect(result).toEqual({ ok: true, value: null });
  expect(catalog.runtimes).toHaveLength(2);
});

test("preserves incomplete core facts separately from public runtime identities", async () => {
  // Given: actual core fields lack native pane/turn generations and storage linkage.
  const partial: CoreObservation = {
    paneId: "pane:a", terminalId: "terminal:a", agent: "codex", cwd: "/workspace", session: null, revision: 88,
    completion: { generation: 4, sequence: 7, binding: {
      socket_id: "/core.sock", socket_epoch: "epoch:a", pane_id: "pane:a", pane_incarnation: "string-incarnation",
      root_pid: 123, root_start_identity: null, root_executable: null, session: null, cwd: "/workspace", options_ref: null,
    } },
  };
  // When
  const snapshot = await readCatalog({ ...readers([observation("codex")]), runtimeSources: [{
    socketId: "/core.sock", read: async () => ({ ok: true, value: {
      kind: "unavailable", reason: "identity_incomplete", observations: [partial],
    } }),
  }] });
  // Then: no conversion of revision, incarnation, completion lease or nullable data.
  expect(snapshot.installations).toHaveLength(1);
  expect(snapshot.runtimes).toEqual([]);
  expect(snapshot.failures).toEqual([]);
  expect(snapshot.runtimeAvailability).toEqual([{ sourceId: "/core.sock", kind: "unavailable",
    reason: "identity_incomplete", observations: [partial] }]);
  const installation = snapshot.installations[0];
  if (!installation) throw new TypeError("missing installation");
  expect(validateCatalogSelection(snapshot, installation, [])).toEqual({ ok: false, error: { code: "unsupported" } });
  expect(Object.isFrozen(snapshot.runtimeAvailability[0]?.observations[0])).toBe(true);
});

test("keeps independent installations after an unavailable runtime source", async () => {
  // Given
  const input = readers([observation("omo"), observation("codex")]);
  // When
  const snapshot = await readCatalog({ ...input, runtimeSources: [{
    socketId: "/unavailable.sock", read: async () => ({ ok: false, error: { code: "resources_busy" } }),
  }] });
  // Then: unavailable runtimes are not installation failures or an empty success.
  expect(snapshot.installations).toHaveLength(2);
  expect(snapshot.failures).toEqual([]);
  expect(snapshot.runtimeReadiness).toBe("unavailable");
  expect(snapshot.runtimeAvailability[0]).toMatchObject({ sourceId: "/unavailable.sock", kind: "unavailable" });
});

test.each(["extra", "wrong-socket", "bad-revision"] as const)("rejects malformed private core projection %s without retaining arbitrary diagnostics", async variant => {
  // Given
  const partial: CoreObservation = {
    paneId: "pane:a", terminalId: "terminal:a", agent: "codex", cwd: null, session: null, revision: 1,
    completion: { generation: 0, sequence: 0, binding: {
      socket_id: variant === "wrong-socket" ? "/different.sock" : "/core.sock",
      socket_epoch: "epoch", pane_id: "pane:a", pane_incarnation: "opaque",
      root_pid: 123, root_start_identity: null, root_executable: null, session: null, cwd: null, options_ref: null,
    } },
  };
  const invalid = { ...partial, ...(variant === "extra" ? { diagnostic: "PRIVATE_SENTINEL" } : {}),
    ...(variant === "bad-revision" ? { revision: -1 } : {}) };
  // When
  const snapshot = await readCatalog({ ...readers([observation("codex")]), runtimeSources: [{
    socketId: "/core.sock", read: async () => ({ ok: true, value: {
      kind: "unavailable", reason: "identity_incomplete", observations: [invalid],
    } }),
  }] });
  // Then
  expect(snapshot.installations).toHaveLength(1);
  expect(snapshot.runtimeAvailability).toEqual([{
    sourceId: "/core.sock", kind: "unavailable", reason: "source_unavailable", observations: [],
  }]);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_SENTINEL");
});

test("accepts a complete private observed variant without upgrading capabilities", async () => {
  // Given
  const installed = observation("codex"), live = runtime(installed, "socket:core", "pane:a");
  if (!live.contract.runtime) throw new TypeError("missing runtime");
  // When
  const snapshot = await readCatalog({ ...readers([installed]), runtimeSources: [{
    socketId: "socket:core", read: async () => ({ ok: true, value: { kind: "observed", observations: [live] } }),
  }] });
  // Then: a genuine complete reader remains possible; production currently cannot supply it.
  expect(snapshot.runtimeReadiness).toBe("observed");
  expect(snapshot.runtimes).toEqual([live.contract.runtime]);
  expect(snapshot.observations.every(row => row.contract.capabilities.resume.kind !== "supported")).toBe(true);
});

test("starts independent runtime reads without waiting for another source to settle", async () => {
  // Given: first source completes only after the second has actually started.
  const events = new EventEmitter();
  const secondStarted = once(events, "second", { signal: AbortSignal.timeout(2000) });
  // When
  const snapshot = await readCatalog({ ...readers([observation("codex")]), runtimeSources: [
    { socketId: "/first.sock", read: async () => {
      await secondStarted;
      return { ok: true, value: { kind: "unavailable", reason: "identity_incomplete", observations: [] } };
    } },
    { socketId: "/second.sock", read: async () => {
      events.emit("second");
      return { ok: true, value: { kind: "unavailable", reason: "identity_incomplete", observations: [] } };
    } },
  ] });
  // Then: both sources were reached causally, not by a polling or timing window.
  expect(snapshot.runtimeAvailability).toEqual(["/first.sock", "/second.sock"].map(sourceId => ({
    sourceId, kind: "unavailable", reason: "identity_incomplete", observations: [],
  })));
  expect(snapshot.runtimeReadiness).toBe("unavailable");
});
