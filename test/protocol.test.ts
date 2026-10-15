import { expect, test } from "bun:test";
import {
  isInstallSelection, isRuntimeBinding, isTargetSelection, validateRequest,
} from "../src/protocol";
import type {
  InstallSelection, RuntimeBinding, ServiceRequest, TargetSelection,
} from "../src/protocol";

// Disposable protocol fixture, not a user capability token or operating pane.
const capability = "a".repeat(64);
const installation = {
  installationId: "install-omo",
  resourcesFingerprint: "sha256:fixture",
  owner: { kind: "wrapper", packageName: "omo-ai", engineResourceId: "senpi-owned", prefix: "/qa/omo" },
  installedVersion: { kind: "known", version: "5.1.9" },
} satisfies InstallSelection;
const binding = {
  socketId: "socket-a", socketEpoch: "epoch-1", paneId: "pane-a", paneGeneration: 3,
  rootIncarnation: { pid: 123, startIdentity: "start-1", executableRealpath: "/qa/omo/bin/omo" },
  session: { kind: "file", fullId: "/qa/sessions/full.jsonl", storagePathHash: "sha256:session" },
  cwd: "/qa/project", optionsRef: "private-options-1", turnGeneration: 7,
  resourcesFingerprint: "sha256:fixture",
} satisfies RuntimeBinding;
const target = {
  targetId: "target-a", runtimeId: "runtime-a", installationId: "install-omo",
  expectedBinding: binding,
} satisfies TargetSelection;
const envelope = { version: 1, requestId: "request-1", token: capability } as const;
const restart = {
  ...envelope, operation: "create-job", mode: "update-and-restart",
  installation, selectedTargets: [target],
} satisfies ServiceRequest;
const fixtures = [
  { ...envelope, operation: "installations" },
  { ...envelope, operation: "sessions" },
  { ...envelope, operation: "runtimes" },
  { ...envelope, operation: "jobs" },
  { ...envelope, operation: "targets", installationId: "install-omo" },
  { ...envelope, operation: "check", installationId: "install-omo" },
  { ...envelope, operation: "create-job", mode: "update-only", installation, selectedTargets: [] },
  restart,
  { ...envelope, operation: "cancel-job", jobId: "job-1", expectedRevision: 0 },
  { ...envelope, operation: "inspect-job", jobId: "job-1" },
  { ...envelope, operation: "reconcile-job", jobId: "job-1", expectedRevision: 4 },
] satisfies readonly ServiceRequest[];

test.each(fixtures)("accepts parsed machine fields for $operation", fixture => {
  // Given: actual parsed wire JSON, including independent install/runtime identities.
  const input: unknown = JSON.parse(JSON.stringify(fixture));
  // When: the boundary authenticates and parses.
  const result = validateRequest(input, capability);
  // Then: every field, not just the operation or ok flag, is retained.
  expect(result).toEqual({ ok: true, value: fixture });
});

const malformed: readonly unknown[] = [
  null, [], [envelope], true, 1, "{}", {},
  { ...envelope, operation: "unknown" },
  { ...envelope, operation: "jobs", version: null },
  { ...envelope, operation: "jobs", version: "1" },
  { ...envelope, operation: "jobs", version: 1.5 },
  { ...envelope, operation: "jobs", version: -1 },
  { ...envelope, operation: "jobs", requestId: null },
  { ...envelope, operation: "jobs", requestId: "" },
  { ...envelope, operation: "jobs", requestId: "bad\nid" },
  { ...envelope, operation: "jobs", requestId: "x".repeat(129) },
  { ...envelope, operation: "jobs", token: null },
  { ...envelope, operation: "jobs", token: "" },
  { ...envelope, operation: "jobs", token: "a".repeat(63) },
  { ...envelope, operation: "jobs", token: "z".repeat(64) },
  { ...envelope, operation: "jobs", token: [] },
  { ...envelope, operation: "jobs", extra: true },
  { ...envelope, operation: "targets" },
  { ...envelope, operation: "targets", installationId: [] },
  { ...envelope, operation: "check", installationId: "" },
  { ...envelope, operation: "inspect-job" },
  { ...envelope, operation: "cancel-job", jobId: "job-1" },
  { ...envelope, operation: "cancel-job", jobId: "job-1", expectedRevision: -1 },
  { ...envelope, operation: "reconcile-job", jobId: "job-1", expectedRevision: 0.5 },
  { ...envelope, operation: "reconcile-job", jobId: "job-1", expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
  { ...envelope, operation: "inspect-job", jobId: "job-1", expectedRevision: 0 },
  { ...restart, mode: null },
  { ...restart, mode: "update" },
  { ...restart, selectedTargets: null },
  { ...restart, selectedTargets: {} },
  { ...restart, selectedTargets: [null] },
  { ...restart, selectedTargets: [[]] },
  { ...restart, selectedTargets: [] },
  { ...restart, mode: "update-only" },
  { ...restart, selectedTargets: [target, target] },
  { ...restart, selectedTargets: [target, { ...target, targetId: "target-b" }] },
  { ...restart, selectedTargets: [target, { ...target, targetId: "target-b", runtimeId: "runtime-b" }] },
  { ...restart, selectedTargets: [{ ...target, installationId: "other-install" }] },
  { ...restart, installation: null },
  { ...restart, installation: [] },
  { ...restart, installation: { ...installation, owner: { kind: "package", manager: "guess", packageName: "x", prefix: "/qa" } } },
  { ...restart, installation: { ...installation, installedVersion: { kind: "known" } } },
  { ...restart, installation: { ...installation, installedVersion: { kind: "unknown", reason: "anything" } } },
  { ...restart, installation: { ...installation, token: capability } },
  { ...restart, selectedTargets: [{ ...target, expectedBinding: { ...binding, paneGeneration: -1 } }] },
  { ...restart, selectedTargets: [{ ...target, expectedBinding: { ...binding, turnGeneration: 0.2 } }] },
  { ...restart, selectedTargets: [{ ...target, expectedBinding: { ...binding, cwd: "relative" } }] },
  { ...restart, selectedTargets: [{ ...target, expectedBinding: { ...binding, optionsRef: {} } }] },
  { ...restart, selectedTargets: [{ ...target, expectedBinding: { ...binding, rootIncarnation: { ...binding.rootIncarnation, pid: 0 } } }] },
  { ...restart, selectedTargets: [{ ...target, expectedBinding: { ...binding, rootIncarnation: { ...binding.rootIncarnation, executableRealpath: "omo" } } }] },
  { ...restart, selectedTargets: [{ ...target, expectedBinding: { ...binding, session: { ...binding.session, fullId: "last" } } }] },
  { ...restart, selectedTargets: [{ ...target, expectedBinding: { ...binding, session: { ...binding.session, kind: "picker" } } }] },
  { ...restart, selectedTargets: [{ ...target, token: capability }] },
];

test.each(malformed.map((input, index) => ({ input, index })))("rejects malformed case $index without a request value", ({ input }) => {
  // Given: malformed wire data; no dispatcher or side-effect capability is supplied.
  const before = JSON.stringify(input);
  // When: the actual boundary parses it.
  const result = validateRequest(input, capability);
  // Then: no actionable request or echoed credentials escape, and input is unchanged.
  expect(result).toEqual({ ok: false, error: { code: "malformed_request" } });
  expect(JSON.stringify(input)).toBe(before);
});

test.each([0, 2, 999])("rejects unsupported version %i before returning an actionable request", version => {
  // Given: even an otherwise valid mutating request uses an unrecognized version.
  const input = { ...restart, version };
  // When: version negotiation runs.
  const result = validateRequest(input, capability);
  // Then: the code differs from malformed/auth failure and has no request value.
  expect(result).toEqual({ ok: false, error: { code: "unsupported_version" } });
});

test.each(["b".repeat(64), ""])("rejects a mismatched or unconfigured server capability", expected => {
  // Given: a valid request and wrong/unconfigured server capability.
  const input = restart;
  // When: authentication runs.
  const result = validateRequest(input, expected);
  // Then: authentication failure does not echo the input or credential.
  expect(result).toEqual({ ok: false, error: { code: "unauthorized" } });
});

test.each(["version", "requestId", "token", "operation"])("rejects missing envelope field %s", field => {
  // Given: a parsed wire object missing one required envelope field.
  const input = Object.fromEntries(Object.entries({ ...envelope, operation: "jobs" }).filter(([key]) => key !== field));
  // When: the boundary parses it.
  const result = validateRequest(input, capability);
  // Then: omitted machine fields never default into an actionable request.
  expect(result).toEqual({ ok: false, error: { code: "malformed_request" } });
});

test.each(["token", "argv", "env", "prompt", "transcript", "normalizedStartupOptions"])("rejects secret-bearing binding field %s", field => {
  // Given: a private-store reference is accompanied by an unsafe raw projection.
  const input = { ...binding, [field]: "ULW_SECRET_REDACTION_fixture" };
  // When: the shared binding guard runs.
  const accepted = isRuntimeBinding(input);
  // Then: persisted/public binding schema cannot accept raw credential/work content.
  expect(accepted).toBe(false);
});

test("retains generation and revision snapshots without claiming freshness", () => {
  // Given: a stale-looking snapshot is structurally valid; only the worker knows current state.
  const input = {
    ...restart, selectedTargets: [{ ...target, expectedBinding: { ...binding, socketEpoch: "old-epoch", paneGeneration: 0, turnGeneration: 0 } }],
  } satisfies ServiceRequest;
  // When: the boundary parses, but never compares or executes a process operation.
  const result = validateRequest(input, capability);
  // Then: expected identities remain available for later authoritative CAS rejection.
  expect(result).toEqual({ ok: true, value: input });
});

test.each([
  { kind: "package", manager: "npm", packageName: "@scope/cli", prefix: "/qa/npm" },
  { kind: "package", manager: "bun", packageName: "cli", prefix: "/qa/bun" },
  { kind: "package", manager: "homebrew", packageName: "cli", prefix: "/qa/brew" },
  { kind: "native", installerDigest: "sha256:installer", prefix: "/qa/native" },
  installation.owner,
  { kind: "unknown", reason: "unverified_owner" },
])("accepts explicit installation owner $kind without enabling an updater", owner => {
  // Given: supported ownership evidence variants, including explicit unknown.
  const input = { ...installation, owner, installedVersion: { kind: "unknown", reason: "not_captured" } };
  // When: the selection guard runs.
  const accepted = isInstallSelection(input);
  // Then: evidence can be represented; no updater implementation or support is implied.
  expect(accepted).toBe(true);
});

test("accepts exact conversation identity separately from a file session", () => {
  // Given: an exact conversation ID rather than a title/last/picker selector.
  const input = { ...target, expectedBinding: { ...binding, session: { kind: "conversation", fullId: "a1b2-exact-id", storagePathHash: "sha256:session" } } };
  // When: the shared target guard runs.
  const accepted = isTargetSelection(input);
  // Then: the complete bound target is valid.
  expect(accepted).toBe(true);
});

test("accepts unchanged socket-local runtime and pane IDs on distinct sockets", () => {
  // Given: two sockets independently use the same local runtime and pane IDs.
  const input = {
    ...restart,
    selectedTargets: [
      target,
      { ...target, targetId: "target-b", expectedBinding: { ...binding, socketId: "socket-b", socketEpoch: "epoch-b" } },
    ],
  } satisfies ServiceRequest;
  const parsed: unknown = JSON.parse(JSON.stringify(input));
  // When: the real request boundary parses the multi-socket selection.
  const result = validateRequest(parsed, capability);
  // Then: both original local IDs and exact bindings survive without qualification.
  expect(result).toEqual({ ok: true, value: input });
});

test.each([
  {
    kind: "same socket and runtime ID on different panes",
    other: { ...target, targetId: "target-b", expectedBinding: { ...binding, paneId: "pane-b" } },
  },
  {
    kind: "same physical pane with different runtime IDs",
    other: { ...target, targetId: "target-b", runtimeId: "runtime-b" },
  },
  {
    kind: "same physical pane with different pane generations",
    other: { ...target, targetId: "target-b", runtimeId: "runtime-b", expectedBinding: { ...binding, paneGeneration: 4 } },
  },
  {
    kind: "same physical pane with different process incarnations and turn generations",
    other: {
      ...target, targetId: "target-b", runtimeId: "runtime-b",
      expectedBinding: { ...binding, turnGeneration: 8, rootIncarnation: { ...binding.rootIncarnation, pid: 124, startIdentity: "start-2" } },
    },
  },
  {
    kind: "same physical pane with different socket epochs",
    other: { ...target, targetId: "target-b", runtimeId: "runtime-b", expectedBinding: { ...binding, socketEpoch: "epoch-2" } },
  },
  {
    kind: "different panes on one socket with mixed socket epochs",
    other: {
      ...target, targetId: "target-b", runtimeId: "runtime-b",
      expectedBinding: { ...binding, paneId: "pane-b", socketEpoch: "epoch-2" },
    },
  },
  {
    kind: "globally duplicate target ID on distinct sockets",
    other: { ...target, expectedBinding: { ...binding, socketId: "socket-b", socketEpoch: "epoch-b" } },
  },
])("rejects ambiguous selection: $kind", ({ other }) => {
  // Given: uniqueness or coherent-epoch constraints are violated by a second target.
  const input = { ...restart, selectedTargets: [target, other] } satisfies ServiceRequest;
  const parsed: unknown = JSON.parse(JSON.stringify(input));
  // When: the actual request parser validates the selection as a whole.
  const result = validateRequest(parsed, capability);
  // Then: no actionable create-job request is returned for an ambiguous binding.
  expect(result).toEqual({ ok: false, error: { code: "malformed_request" } });
});

test("importing protocol produces no success output or process exit", async () => {
  // Given: a real consumer importing the protocol module, not the CLI entrypoint.
  const child = Bun.spawn([process.execPath, "-e", 'await import("./src/protocol.ts")'], {
    cwd: new URL("../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  // When: the import completes via its bounded process exit event.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  // Then: import cannot look like a completed update or terminate the consumer.
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});
