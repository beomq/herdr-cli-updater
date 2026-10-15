import { expect, test } from "bun:test";
import { capabilitySupported, FAMILIES, isCapability, parseAdapterContract } from "../../src/adapters/types";
import type { AdapterContract, AdapterCapabilities, Capability, BusySafeCapability } from "../../src/adapters/types";

const unknown = { kind: "unknown", reason: "not_verified" } satisfies Capability;
const supported = { kind: "supported", reason: "verified", evidenceRef: "qa:fixture" } satisfies Capability;
const capabilities = {
  check: unknown, update: unknown, busySafe: unknown,
  completion: unknown, resume: unknown, gracefulExit: unknown,
} satisfies AdapterCapabilities;
const fixture = {
  version: 1, family: "omo",
  installation: {
    installationId: "install-omo", family: "omo", channel: "pinned",
    executableRealpath: "/qa/omo/bin/omo", resourcesFingerprint: "sha256:install",
    owner: { kind: "wrapper", packageName: "omo-ai", engineResourceId: "senpi-owned", prefix: "/qa/omo" },
    installedVersion: { kind: "known", version: "5.1.9" },
    resources: [
      { resourceId: "wrapper", realpath: "/qa/omo/wrapper", fingerprint: "sha256:wrapper" },
      { resourceId: "senpi-owned", realpath: "/qa/omo/engine", fingerprint: "sha256:engine" },
    ],
  },
  runtime: {
    runtimeId: "runtime-omo", installationId: "install-omo",
    runningVersion: { kind: "unknown", reason: "not_captured" },
    binding: {
      socketId: "socket-a", socketEpoch: "epoch-1", paneId: "pane-a", paneGeneration: 3,
      rootIncarnation: { pid: 123, startIdentity: "start-1", executableRealpath: "/qa/omo/bin/omo" },
      session: { kind: "file", fullId: "/qa/sessions/exact.jsonl", storagePathHash: "sha256:session" },
      cwd: "/qa/project", optionsRef: "private-options-1", turnGeneration: 7,
      resourcesFingerprint: "sha256:install",
    },
  },
  capabilities,
} satisfies AdapterContract;
const busy = {
  ...supported,
  proof: {
    installerDigest: "sha256:installer", resourcesFingerprint: "sha256:install",
    resourceIds: ["wrapper", "senpi-owned"], allConsumersKnown: true,
  },
} satisfies BusySafeCapability;

test.each([...FAMILIES])("accepts %s without treating identity as support", family => {
  // Given: a parsed family vector with no verified capabilities.
  const input: unknown = JSON.parse(JSON.stringify({
    ...fixture, family, installation: { ...fixture.installation, family },
  }));
  // When: the contract crosses the runtime boundary.
  const result = parseAdapterContract(input);
  // Then: all eight families retain distinct install/runtime identities.
  expect(result.ok).toBe(true);
  if (!result.ok) throw new TypeError(result.error.code);
  expect(result.value.family).toBe(family);
  expect(result.value.installation.installationId).not.toBe(result.value.runtime?.runtimeId);
  expect(Object.values(result.value.capabilities).map(capabilitySupported)).toEqual(Array(6).fill(false));
});

test.each([
  undefined, null, true, "supported", {}, { kind: "supported" },
  { kind: "supported", reason: "not_verified", evidenceRef: "qa:fixture" },
  { ...supported, evidenceRef: "" }, { ...supported, enabled: true },
  unknown, { kind: "missing", reason: "not_installed" },
  { kind: "unsupported", reason: "provenance_unverified" },
])("does not enable unverified or malformed capability %#", input => {
  // Given / When: classify an actual unknown machine value.
  const enabled = capabilitySupported(input);
  // Then: no truthiness or optimistic default.
  expect(enabled).toBe(false);
});
test("recognizes a supported machine capability", () => {
  // Given / When: parse a complete supported discriminant.
  const valid = isCapability(supported);
  // Then: the classifier accepts it, independently of other capabilities.
  expect(valid).toBe(true);
  expect(capabilitySupported(supported)).toBe(true);
});

const malformed: readonly unknown[] = [
  null, [], {}, { ...fixture, version: "1" }, { ...fixture, version: -1 },
  { ...fixture, family: "other" }, { ...fixture, shell: "echo success" },
  { ...fixture, installation: { ...fixture.installation, owner: undefined } },
  { ...fixture, installation: { ...fixture.installation, channel: "" } },
  { ...fixture, installation: { ...fixture.installation, resources: [] } },
  { ...fixture, installation: { ...fixture.installation, resources: [fixture.installation.resources[0], fixture.installation.resources[0]] } },
  { ...fixture, capabilities: { ...capabilities, update: true } },
  { ...fixture, capabilities: { ...capabilities, check: undefined } },
  { ...fixture, capabilities: { ...capabilities, busySafe: supported } },
  { ...fixture, capabilities: { ...capabilities, busySafe: { ...busy, proof: { ...busy.proof, allConsumersKnown: false } } } },
  { ...fixture, runtime: { ...fixture.runtime, binding: { ...fixture.runtime.binding, session: null } } },
  { ...fixture, runtime: { ...fixture.runtime, binding: { ...fixture.runtime.binding, optionsRef: "" } } },
  { ...fixture, runtime: { ...fixture.runtime, binding: { ...fixture.runtime.binding, argv: ["ULW_SECRET_REDACTION_6fb9"] } } },
];
test.each(malformed.map(input => ({ input })))("rejects malformed contract %# without echoing input", ({ input }) => {
  // Given / When: malformed machine data crosses the parser.
  const result = parseAdapterContract(input);
  // Then: the failure has no actionable contract or raw payload.
  expect(result).toEqual({ ok: false, error: { code: "malformed_contract" } });
});

const inconsistent: readonly unknown[] = [
  { ...fixture, family: "pi" },
  { ...fixture, installation: { ...fixture.installation, resources: [fixture.installation.resources[0]] } },
  { ...fixture, installation: { ...fixture.installation, owner: { kind: "unknown", reason: "unverified_owner" } }, capabilities: { ...capabilities, update: supported } },
  { ...fixture, family: "pi", installation: { ...fixture.installation, family: "pi" }, capabilities: { ...capabilities, update: supported } },
  { ...fixture, runtime: { ...fixture.runtime, installationId: "different-install" } },
  { ...fixture, runtime: { ...fixture.runtime, binding: { ...fixture.runtime.binding, resourcesFingerprint: "sha256:stale" } } },
  ...(["completion", "resume", "gracefulExit"] as const).map(key => ({
    ...fixture, runtime: null, capabilities: { ...capabilities, [key]: supported },
  })),
  { ...fixture, capabilities: { ...capabilities, busySafe: busy } },
  { ...fixture, capabilities: { ...capabilities, update: supported, busySafe: { ...busy, proof: { ...busy.proof, resourceIds: ["wrapper"] } } } },
  { ...fixture, capabilities: { ...capabilities, update: supported, busySafe: { ...busy, proof: { ...busy.proof, resourcesFingerprint: "sha256:stale" } } } },
];
test.each(inconsistent.map(input => ({ input })))("rejects inconsistent support vector %#", ({ input }) => {
  // Given / When: advertised support contradicts ownership/resources/binding.
  const result = parseAdapterContract(input);
  // Then: no supported contract is returned.
  expect(result).toEqual({ ok: false, error: { code: "inconsistent_capabilities" } });
});
test.each([0, 2, 999])("rejects unsupported contract version %s", version => {
  // Given / When: future or obsolete version.
  const result = parseAdapterContract({ ...fixture, version });
  // Then: no current-version coercion.
  expect(result).toEqual({ ok: false, error: { code: "unsupported_version" } });
});
test.each(["check", "update", "completion", "resume", "gracefulExit"] as const)(
  "keeps %s independent of other capabilities", key => {
    // Given / When: only one capability has verification evidence.
    const result = parseAdapterContract({ ...fixture, capabilities: { ...capabilities, [key]: supported } });
    // Then: no unrelated capability is inferred.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError(result.error.code);
    expect(Object.entries(result.value.capabilities).filter(([, cap]) => capabilitySupported(cap)).map(([name]) => name)).toEqual([key]);
  },
);
test("accepts a compound owned write set without enabling engine self update", () => {
  // Given / When: wrapper updater covers wrapper and owned engine.
  const result = parseAdapterContract({ ...fixture, capabilities: { ...capabilities, update: supported, busySafe: busy } });
  // Then: both mutation resources belong to the one owner, not the runtime.
  expect(result.ok).toBe(true);
  if (!result.ok) throw new TypeError(result.error.code);
  expect(result.value.installation.resources.map(item => item.resourceId)).toEqual(["wrapper", "senpi-owned"]);
  expect(result.value.capabilities.busySafe.kind).toBe("supported");
  expect(capabilitySupported(result.value.capabilities.busySafe)).toBe(true);
});
test("retains old runtime generations rather than claiming freshness", () => {
  // Given: structurally valid but old epoch/generations.
  const runtime = { ...fixture.runtime, binding: { ...fixture.runtime.binding, socketEpoch: "old-epoch", paneGeneration: 0, turnGeneration: 0 } };
  // When: parsing snapshots.
  const result = parseAdapterContract({ ...fixture, runtime });
  // Then: worker/core must compare the retained binding before effects.
  expect(result.ok).toBe(true);
  if (!result.ok) throw new TypeError(result.error.code);
  expect(result.value.runtime).toEqual(runtime);
});
test("accepts standalone pi with a distinct verified owner prefix", () => {
  // Given: no wrapper ownership or shared engine resource.
  const installation = {
    ...fixture.installation, family: "pi", installationId: "pi-standalone",
    owner: { kind: "package", manager: "bun", packageName: "senpi", prefix: "/qa/standalone" },
    executableRealpath: "/qa/standalone/bin/pi",
    resources: [{ resourceId: "standalone-engine", realpath: "/qa/standalone/engine", fingerprint: "sha256:standalone" }],
  } as const;
  // When: a standalone install advertises update without runtime restart support.
  const result = parseAdapterContract({
    ...fixture, family: "pi", installation, runtime: null,
    capabilities: { ...capabilities, update: supported },
  });
  // Then: only that owner can be independently updated.
  expect(result.ok).toBe(true);
  if (!result.ok) throw new TypeError(result.error.code);
  expect(result.value.installation.owner).toEqual(installation.owner);
  expect(result.value.runtime).toBeNull();
});
test("keeps unknown ownership displayable without enabling mutations", () => {
  // Given / When: discovery found an install but not its owner.
  const result = parseAdapterContract({
    ...fixture, installation: { ...fixture.installation, owner: { kind: "unknown", reason: "unverified_owner" } },
  });
  // Then: unknown capability remains false rather than guessed support.
  expect(result.ok).toBe(true);
  if (!result.ok) throw new TypeError(result.error.code);
  expect(capabilitySupported(result.value.capabilities.update)).toBe(false);
});
test("rejects native busy safety with the wrong installer digest", () => {
  // Given / When: a proof was captured for a different native installer.
  const result = parseAdapterContract({
    ...fixture,
    installation: { ...fixture.installation, owner: { kind: "native", prefix: "/qa/omo", installerDigest: "sha256:different" } },
    capabilities: { ...capabilities, update: supported, busySafe: busy },
  });
  // Then: that proof cannot authorize live mutation.
  expect(result).toEqual({ ok: false, error: { code: "inconsistent_capabilities" } });
});
test.each(["socketEpoch", "paneGeneration", "rootIncarnation", "session", "cwd", "optionsRef", "turnGeneration"] as const)(
  "requires runtime binding field %s", key => {
    // Given: a complete binding with one machine field removed.
    const binding: { [key: string]: unknown } = { ...fixture.runtime.binding };
    delete binding[key];
    // When: classifying the incomplete runtime.
    const result = parseAdapterContract({ ...fixture, runtime: { ...fixture.runtime, binding } });
    // Then: no fallback identity or selector is generated.
    expect(result).toEqual({ ok: false, error: { code: "malformed_contract" } });
  },
);

test("rejects private update context and environment on public adapter records", () => {
  // Given / When: execution-only fields cannot cross the public structural boundary.
  const result = parseAdapterContract({ ...fixture,
    execution: { kind: "omo-official-update" }, env: { TOKEN: "PRIVATE_SENTINEL" } });
  // Then: no private payload is echoed.
  expect(result).toEqual({ ok: false, error: { code: "malformed_contract" } });
});
