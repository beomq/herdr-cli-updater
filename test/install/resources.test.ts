import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateResourceGate, parseResourcePlan, resourcesOverlap } from "../../src/install/resources";
import type { InstallationIdentity, MutationResource } from "../../src/adapters/types";
import type { ResourcePlan, ResourceObservation } from "../../src/install/resources";
import { MutationQueue, QueueError } from "../../src/install/queue";

const roots: string[] = [];
const queues: MutationQueue[] = [];
const digest = `sha256:${"a".repeat(64)}`;
const unknown = { kind: "unknown", reason: "not_verified" } as const;
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "resources21-"));
  roots.push(root);
  const executable = join(root, "cli");
  writeFileSync(executable, "fixture", { mode: 0o600 });
  const plan: ResourcePlan = {
    mode: "update-only", selectedTargets: [], installerDigest: digest,
    contract: {
      version: 1, family: "codex", runtime: null,
      capabilities: { check: unknown, update: { kind: "supported", reason: "verified", evidenceRef: "fixture-only" },
        busySafe: unknown, completion: unknown, resume: unknown, gracefulExit: unknown },
      installation: {
        installationId: "install", family: "codex", channel: "stable", executableRealpath: executable,
        resourcesFingerprint: "fp", installedVersion: { kind: "known", version: "1" },
        owner: { kind: "native", prefix: root, installerDigest: digest },
        resources: [{ resourceId: "resource", realpath: executable, fingerprint: "file-fp" }],
      },
    },
    mutationResources: [{ resourceId: "resource", realpath: executable, fingerprint: "file-fp" }],
  };
  const observation: ResourceObservation = {
    installation: plan.contract.installation, installerDigest: digest, mutationResources: plan.mutationResources,
    allSocketsKnown: true, outsideConsumersKnown: true, consumers: [], busySafety: null,
  };
  const path = join(root, "queue");
  const queue = new MutationQueue(path);
  queues.push(queue);
  return { root, path, plan, observation, queue };
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function identified(installation: InstallationIdentity): InstallationIdentity {
  const resources = [...installation.resources].sort((a, b) => a.realpath.localeCompare(b.realpath));
  return { ...installation, installationId: `install:${hash(installation.executableRealpath)}`, resources,
    resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
}
function transitionFixture() {
  const f = fixture();
  const versions = join(f.root, "versions");
  mkdirSync(versions);
  const future = join(versions, "2", "cursor-agent");
  const row = (realpath: string, bytes: string): MutationResource =>
    ({ resourceId: `resource:${hash(realpath)}`, realpath, fingerprint: `sha256:${hash(bytes)}` });
  const before = identified({ ...f.plan.contract.installation, family: "cursor",
    resources: [row(f.plan.contract.installation.executableRealpath, "fixture")] });
  const expectedAfter = identified({ ...before, executableRealpath: future,
    installedVersion: { kind: "known", version: "2" }, resources: [row(future, "next")] });
  const mutationResources = [...before.resources, ...expectedAfter.resources];
  const plan = { ...f.plan, contract: { ...f.plan.contract, family: "cursor" as const, installation: before },
    mutationResources, transition: { expectedAfter, mutationRoots: mutationResources.map(r => r.realpath) } };
  const observation: ResourceObservation = { ...f.observation, installation: before, mutationResources };
  return { ...f, plan, observation, expectedAfter, versions, future };
}
function enqueue(queue: MutationQueue, plan: ResourcePlan, jobId = "job", requestId = "request") {
  return queue.enqueue({ jobId, requestId, plan });
}
function acquire(queue: MutationQueue, plan: ResourcePlan, observation: ResourceObservation, jobId = "job") {
  enqueue(queue, plan, jobId, `request:${jobId}`);
  return queue.acquire(jobId, 0, () => observation);
}
afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("admits declared future Cursor paths beneath an existing owned canonical parent", () => {
  // Given
  const { plan, observation, future } = transitionFixture();
  // When / Then
  expect(existsSync(future)).toBe(false);
  expect(parseResourcePlan(plan).ok).toBe(true);
  expect(evaluateResourceGate(plan, observation)).toEqual({ ok: true, value: null });
});

test("admits a declared version directory scope containing future executable leaves", () => {
  // Given: the write scope itself must be a mutation resource, not an implicit parent.
  const { plan, observation, versions } = transitionFixture();
  const scope = join(versions, "2");
  const mutationResources = [...plan.contract.installation.resources,
    { resourceId: `resource:${hash(scope)}`, realpath: scope, fingerprint: digest }];
  const scoped = { ...plan, mutationResources, transition: { ...plan.transition, mutationRoots: [scope] } };
  // When / Then
  expect(evaluateResourceGate(scoped, { ...observation, mutationResources })).toEqual({ ok: true, value: null });
});

test("supports a package target with the same executable and a different generated resource set", () => {
  // Given
  const { plan, queue, observation, future } = transitionFixture();
  const owner = { kind: "package" as const, manager: "npm" as const, packageName: "cursor-fixture",
    prefix: plan.contract.installation.owner.kind === "unknown" ? "" : plan.contract.installation.owner.prefix };
  const before = identified({ ...plan.contract.installation, owner });
  const added = { resourceId: `resource:${hash(future)}`, realpath: future, fingerprint: digest };
  const expectedAfter = identified({ ...before, installedVersion: { kind: "known", version: "2" },
    resources: [...before.resources.map(r => ({ ...r, fingerprint: digest })), added] });
  const mutationResources = [...before.resources, added];
  const updated = { ...plan, contract: { ...plan.contract, installation: before }, mutationResources,
    transition: { expectedAfter, mutationRoots: mutationResources.map(r => r.realpath) } };
  const permit = acquire(queue, updated, { ...observation, installation: before, mutationResources });
  // When / Then
  expect(queue.complete(permit, expectedAfter, () => expectedAfter).state).toBe("completed");
});

test.each(["owner", "channel", "family", "id", "path", "aggregate", "resource-id", "unknown-version"] as const)(
  "rejects forged transition after %s before enqueue", field => {
    // Given
    const { plan, expectedAfter, queue } = transitionFixture();
    const after = { ...expectedAfter,
      ...(field === "owner" ? { owner: { kind: "native", prefix: "/foreign", installerDigest: digest } } : {}),
      ...(field === "channel" ? { channel: "other" } : {}),
      ...(field === "family" ? { family: "grok" } : {}),
      ...(field === "id" ? { installationId: "forged" } : {}),
      ...(field === "path" ? { executableRealpath: `${expectedAfter.executableRealpath}/../cursor-agent` } : {}),
      ...(field === "aggregate" ? { resourcesFingerprint: digest } : {}),
      ...(field === "resource-id" ? { resources: expectedAfter.resources.map(r => ({ ...r, resourceId: "forged" })) } : {}),
      ...(field === "unknown-version" ? { installedVersion: { kind: "unknown", reason: "not_captured" } } : {}),
    };
    // When / Then
    expect(() => queue.enqueue({ jobId: "job", requestId: "request",
      plan: { ...plan, transition: { ...plan.transition, expectedAfter: after } } })).toThrow();
    expect(() => queue.get("job")).toThrow(new QueueError("not_found"));
  },
);

test.each(["omitted-source", "source-fingerprint", "source-path", "omitted-root", "foreign-root", "duplicate-root",
  "relative-root", "broad-root", "unsupported", "installer"] as const)(
  "rejects transition with %s without weakening existing selection guards", field => {
    // Given
    const { plan } = transitionFixture();
    const mutationResources = field === "omitted-source" ? plan.mutationResources.slice(1)
      : field === "source-fingerprint" ? plan.mutationResources.map((r, i) => i === 0 ? { ...r, fingerprint: digest } : r)
      : field === "source-path" ? plan.mutationResources.map((r, i) => i === 0 ? { ...r, realpath: "/foreign" } : r)
      : field === "omitted-root" ? plan.mutationResources.slice(0, 1) : plan.mutationResources;
    const mutationRoots = field === "foreign-root" ? ["/foreign"]
      : field === "duplicate-root" ? [...plan.transition.mutationRoots, ...plan.transition.mutationRoots]
      : field === "relative-root" ? ["versions/2"]
      : field === "broad-root" ? ["/"] : plan.transition.mutationRoots;
    const bad = { ...plan, mutationResources, transition: { ...plan.transition, mutationRoots },
      ...(field === "unsupported" ? { contract: { ...plan.contract,
        capabilities: { ...plan.contract.capabilities, update: unknown } } } : {}),
      ...(field === "installer" ? { installerDigest: `sha256:${"b".repeat(64)}` } : {}),
    };
    // When / Then
    expect(parseResourcePlan(bad).ok).toBe(false);
  },
);

test("admits only Grok's declared private prefix and sibling HOME as a complete owner scope", () => {
  const f = fixture(), prefix = join(f.root, "prefix"), home = join(f.root, "home");
  mkdirSync(prefix, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  const executable = join(prefix, "grok"); writeFileSync(executable, "before", { mode: 0o700 });
  const before = identified({ ...f.plan.contract.installation, family: "grok", executableRealpath: executable,
    owner: { kind: "package", manager: "npm", packageName: "@xai-official/grok", prefix },
    resources: [{ resourceId: `resource:${hash(executable)}`, realpath: executable, fingerprint: `sha256:${hash("before")}` }] });
  const after = identified({ ...before, installedVersion: { kind: "known", version: "2" } });
  const mutationResources = [...before.resources, ...[prefix, home].map(realpath => ({ realpath,
    resourceId: `resource:${hash(realpath)}`, fingerprint: `sha256:${hash(realpath)}` }))];
  const plan = { ...f.plan, contract: { ...f.plan.contract, family: "grok" as const, installation: before }, mutationResources,
    transition: { expectedAfter: after, mutationRoots: [prefix, home], scopeRoot: f.root } };
  expect(parseResourcePlan(plan).ok).toBe(true);
  expect(evaluateResourceGate(plan, { ...f.observation, installation: before, mutationResources })).toEqual({ ok: true, value: null });
  expect(parseResourcePlan({ ...plan, transition: { ...plan.transition, scopeRoot: home } })).toMatchObject({ ok: false });
  expect(parseResourcePlan({ ...plan, transition: { ...plan.transition, mutationRoots: [prefix, f.root] } })).toMatchObject({ ok: false });
});

test("rejects a foreign root even when its exact identity is included in the mutation scope", () => {
  // Given
  const { plan } = transitionFixture();
  const other = fixture();
  const foreign = { resourceId: `resource:${hash(other.root)}`, realpath: other.root, fingerprint: digest };
  // When / Then
  expect(parseResourcePlan({ ...plan, mutationResources: [...plan.mutationResources, foreign],
    transition: { ...plan.transition, mutationRoots: [...plan.transition.mutationRoots, other.root] } }))
    .toEqual({ ok: false, error: { code: "unsupported" } });
});

test("rejects an uncovered target even when its installation identity hashes are canonical", () => {
  // Given
  const { plan, root, expectedAfter } = transitionFixture();
  const outsideScope = join(root, "unplanned");
  const after = identified({ ...expectedAfter, executableRealpath: outsideScope,
    resources: [{ resourceId: `resource:${hash(outsideScope)}`, realpath: outsideScope, fingerprint: digest }] });
  // When / Then
  expect(parseResourcePlan({ ...plan, transition: { ...plan.transition, expectedAfter: after } }))
    .toEqual({ ok: false, error: { code: "unsupported" } });
});

test("transition parser remains data-only and captures a deeply frozen copy", () => {
  // Given
  const { plan, root } = transitionFixture();
  rmSync(join(root, "versions"), { recursive: true });
  // When
  const parsed = parseResourcePlan(plan);
  // Then
  expect(parsed.ok).toBe(true);
  if (!parsed.ok || !parsed.value.transition) throw new Error("fixture");
  expect(Object.isFrozen(parsed.value.transition)).toBe(true);
  expect(Object.isFrozen(parsed.value.transition.expectedAfter.resources)).toBe(true);
  expect(Object.isFrozen(parsed.value.transition.mutationRoots)).toBe(true);
  expect(parsed.value.transition.expectedAfter).not.toBe(plan.transition.expectedAfter);
});

test("transition parser refuses nested getter and unknown fields without running caller hooks", () => {
  // Given
  const { plan } = transitionFixture();
  let reads = 0;
  const transition = { ...plan.transition, get expectedAfter() { reads++; return plan.transition.expectedAfter; } };
  // When / Then
  expect(parseResourcePlan({ ...plan, transition }).ok).toBe(false);
  expect(parseResourcePlan({ ...plan, transition: { ...plan.transition, extra: true } }).ok).toBe(false);
  expect(reads).toBe(0);
});

test("transition gate checks future union consumers and never infers an empty census", () => {
  // Given
  const { plan, observation, expectedAfter } = transitionFixture();
  // When / Then
  expect(evaluateResourceGate(plan, { ...observation, allSocketsKnown: false }).ok).toBe(false);
  expect(evaluateResourceGate(plan, { ...observation, outsideConsumersKnown: false }).ok).toBe(false);
  expect(evaluateResourceGate(plan, { ...observation, consumers: [{
    consumerId: "future", binding: null, resources: expectedAfter.resources, state: "running",
  }] })).toEqual({ ok: false, error: { code: "resources_busy" } });
});

test("future paths do not turn a verified unrelated consumer into an overlap", () => {
  // Given
  const { plan, observation } = transitionFixture();
  const unrelated = fixture();
  // When / Then
  expect(evaluateResourceGate(plan, { ...observation, consumers: [{
    consumerId: "unrelated", binding: null, resources: unrelated.plan.mutationResources, state: "running",
  }] })).toEqual({ ok: true, value: null });
});

test.each(["symlink", "missing-owner", "writable-parent"] as const)(
  "refuses a future leaf under a %s parent", kind => {
    // Given
    const { plan, observation, versions, root } = transitionFixture();
    if (kind === "symlink") { rmSync(versions, { recursive: true }); symlinkSync(root, versions); }
    if (kind === "missing-owner") {
      if (plan.contract.installation.owner.kind === "unknown") throw new Error("fixture");
      const owner = { ...plan.contract.installation.owner, prefix: join(root, "absent") };
      const before = { ...plan.contract.installation, owner };
      const bad = { ...plan, contract: { ...plan.contract, installation: before },
        transition: { ...plan.transition, expectedAfter: { ...plan.transition.expectedAfter, owner } } };
      // When / Then
      expect(evaluateResourceGate(bad, { ...observation, installation: before }).ok).toBe(false);
      return;
    }
    if (kind === "writable-parent") chmodSync(versions, 0o777);
    // When / Then
    expect(evaluateResourceGate(plan, observation).ok).toBe(false);
  },
);

test("queue completes the captured Cursor target despite source object mutation", () => {
  // Given
  const { queue, plan, observation, expectedAfter } = transitionFixture();
  const permit = acquire(queue, plan, observation);
  const expected = structuredClone(expectedAfter);
  Object.assign(plan.transition.expectedAfter, { channel: "forged" });
  plan.transition.mutationRoots.push("/foreign");
  // When
  const completed = queue.complete(permit, expected, () => structuredClone(expected));
  // Then
  expect(completed.state).toBe("completed");
});

test.each(["late-expected", "observed-drift"] as const)("queue rejects %s against the enqueued target", kind => {
  // Given
  const { queue, plan, observation, expectedAfter } = transitionFixture();
  const permit = acquire(queue, plan, observation);
  const drift = { ...expectedAfter, installedVersion: { kind: "known" as const, version: "3" } };
  let reads = 0;
  // When / Then
  expect(() => queue.complete(permit, kind === "late-expected" ? drift : expectedAfter, () => { reads++; return drift; }))
    .toThrow(new QueueError(kind === "late-expected" ? "identity_mismatch" : "external_writer"));
  expect(reads).toBe(kind === "late-expected" ? 0 : 1);
  expect(queue.get("job").state).toBe("recovery_required");
});

test("queue fingerprint includes the complete transition target and root set", () => {
  // Given
  const { queue, plan, expectedAfter } = transitionFixture();
  enqueue(queue, plan);
  // When / Then
  expect(() => enqueue(queue, { ...plan, transition: { ...plan.transition,
    expectedAfter: { ...expectedAfter, installedVersion: { kind: "known", version: "3" } } } })).toThrow(new QueueError("request_conflict"));
  expect(() => enqueue(queue, { ...plan, transition: { ...plan.transition,
    mutationRoots: plan.transition.mutationRoots.slice(1) } })).toThrow(new QueueError("request_conflict"));
});

test("waits for process exit even if a consumer reports no current work", () => {
  // Given: idle is deliberately not part of the resource-exit contract.
  const { plan, observation } = fixture();
  const consumer = { consumerId: "outside:incarnation", binding: null, resources: plan.mutationResources, state: "running" as const };
  // When / Then
  expect(evaluateResourceGate(plan, { ...observation, consumers: [consumer] })).toEqual({ ok: false, error: { code: "resources_busy" } });
  expect(evaluateResourceGate(plan, { ...observation, consumers: [{ ...consumer, state: "exited" }] })).toEqual({ ok: true, value: null });
});

test.each(["allSocketsKnown", "outsideConsumersKnown"] as const)("blocks incomplete %s even with no listed consumers", field => {
  // Given
  const { plan, observation } = fixture();
  // When / Then
  expect(evaluateResourceGate(plan, { ...observation, [field]: false })).toEqual({ ok: false, error: { code: "unsupported" } });
});

test("matches busy safety against independent immutable digest and entire write set", () => {
  // Given: advertised support alone cannot admit a live consumer.
  const { plan, observation } = fixture();
  const proof = { installerDigest: digest, resourcesFingerprint: "fp", resourceIds: ["resource"], allConsumersKnown: true } as const;
  const safe: ResourcePlan = { ...plan, contract: { ...plan.contract, capabilities: { ...plan.contract.capabilities,
    busySafe: { kind: "supported", reason: "verified", evidenceRef: "claim", proof } } } };
  const busy: ResourceObservation = { ...observation,
    consumers: [{ consumerId: "live", binding: null, resources: plan.mutationResources, state: "running" }] };
  // When / Then
  expect(evaluateResourceGate(safe, busy)).toEqual({ ok: false, error: { code: "resources_busy" } });
  expect(evaluateResourceGate(safe, { ...busy, busySafety: proof })).toEqual({ ok: true, value: null });
});

test.each(["digest", "fingerprint", "write-set", "completeness"])("rejects independent busy proof with wrong %s", field => {
  // Given
  const { plan, observation } = fixture();
  const proof = { installerDigest: digest, resourcesFingerprint: "fp", resourceIds: ["resource"], allConsumersKnown: true } as const;
  const safe = { ...plan, contract: { ...plan.contract, capabilities: { ...plan.contract.capabilities,
    busySafe: { kind: "supported", reason: "verified", evidenceRef: "claim", proof } } } };
  const changed = { ...proof, ...(field === "digest" ? { installerDigest: `sha256:${"b".repeat(64)}` } : {}),
    ...(field === "fingerprint" ? { resourcesFingerprint: "other" } : {}),
    ...(field === "write-set" ? { resourceIds: ["other"] } : {}),
    ...(field === "completeness" ? { allConsumersKnown: false } : {}) };
  // When / Then: unknown input tests the actual boundary, not a cast.
  expect(evaluateResourceGate(safe, { ...observation, busySafety: changed,
    consumers: [{ consumerId: "live", binding: null, resources: plan.mutationResources, state: "running" }] }).ok).toBe(false);
});

test.each(["owner", "channel", "aggregate", "resource", "installer", "write-set"])("reports preflight %s drift as external writer", field => {
  // Given
  const { plan, observation } = fixture();
  const installation = { ...observation.installation,
    ...(field === "owner" ? { owner: { kind: "native" as const, prefix: "/different", installerDigest: digest } } : {}),
    ...(field === "channel" ? { channel: "other" } : {}),
    ...(field === "aggregate" ? { resourcesFingerprint: "different" } : {}),
    ...(field === "resource" ? { resources: plan.mutationResources.map(r => ({ ...r, fingerprint: "different" })) } : {}) };
  // When / Then
  expect(evaluateResourceGate(plan, { ...observation, installation,
    ...(field === "installer" ? { installerDigest: `sha256:${"b".repeat(64)}` } : {}),
    ...(field === "write-set" ? { mutationResources: [] } : {}) })).toEqual({ ok: false, error: { code: "external_writer" } });
});

test("canonical overlap catches aliases hardlinks and ancestors without prefix false positives", () => {
  // Given
  const { root, plan } = fixture();
  const real = plan.mutationResources[0];
  if (!real) throw new Error("fixture");
  const alias = join(root, "alias"), hard = join(root, "hard");
  symlinkSync(real.realpath, alias);
  linkSync(real.realpath, hard);
  const sibling = join(root, "cli-other");
  writeFileSync(sibling, "other");
  const resource = (path: string) => ({ ...real, resourceId: "different", realpath: path });
  // When / Then
  expect(resourcesOverlap([real], [resource(alias)])).toBe(true);
  expect(resourcesOverlap([real], [resource(hard)])).toBe(true);
  expect(resourcesOverlap([real], [resource(root)])).toBe(true);
  expect(resourcesOverlap([real], [resource(sibling)])).toBe(false);
  expect(resourcesOverlap([real], [resource(join(root, "missing"))])).toBe(true);
});

test("unknown consumer state and inaccessible resource geometry cannot become idle", () => {
  // Given
  const { root, plan, observation } = fixture();
  // When / Then
  expect(evaluateResourceGate(plan, { ...observation, consumers: [{
    consumerId: "unknown", binding: null, state: "unknown",
    resources: [{ resourceId: "other", realpath: join(root, "missing"), fingerprint: "other" }],
  }] })).toEqual({ ok: false, error: { code: "resources_busy" } });
});

test("restart never invents selected drain claim or exit authority", () => {
  // Given
  const { plan, observation, queue } = fixture();
  const binding = { socketId: "a", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
    rootIncarnation: { pid: 123, startIdentity: "start", executableRealpath: plan.contract.installation.executableRealpath },
    session: { kind: "conversation" as const, fullId: "session", storagePathHash: "hash" },
    cwd: "/fixture", optionsRef: "options", turnGeneration: 1, resourcesFingerprint: "fp" };
  const restart: ResourcePlan = { ...plan, mode: "update-and-restart",
    selectedTargets: [{ targetId: "target", runtimeId: "runtime", installationId: "install", expectedBinding: binding }] };
  // When / Then: even claimed/exited job-like data cannot mint core19 authority.
  expect(evaluateResourceGate(restart, observation)).toEqual({ ok: false, error: { code: "unsupported" } });
  enqueue(queue, restart);
  expect(() => queue.acquire("job", 0, () => observation)).toThrow(new QueueError("unsupported"));
  expect(queue.get("job").revision).toBe(0);
});

test("nonselected live consumers block restart across another socket", () => {
  // Given
  const { plan, observation } = fixture();
  const binding = { socketId: "a", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
    rootIncarnation: { pid: 123, startIdentity: "start", executableRealpath: plan.contract.installation.executableRealpath },
    session: { kind: "conversation" as const, fullId: "session", storagePathHash: "hash" },
    cwd: "/fixture", optionsRef: "options", turnGeneration: 1, resourcesFingerprint: "fp" };
  // When / Then
  expect(evaluateResourceGate({ ...plan, mode: "update-and-restart",
    selectedTargets: [{ targetId: "target", runtimeId: "runtime", installationId: "install", expectedBinding: binding }] },
  { ...observation, consumers: [{ consumerId: "other", binding: { ...binding, socketId: "b" },
    resources: plan.mutationResources, state: "running" }] })).toEqual({ ok: false, error: { code: "resources_busy" } });
});

test("durably deduplicates job and request identities with the full plan", () => {
  // Given
  const { path, plan, queue } = fixture();
  enqueue(queue, plan);
  queue.close();
  const reopened = new MutationQueue(path);
  queues.push(reopened);
  // When / Then
  expect(enqueue(reopened, plan, "candidate", "request")).toMatchObject({ kind: "existing", entry: { jobId: "job" } });
  expect(enqueue(reopened, plan, "job", "alias")).toMatchObject({ kind: "existing" });
  expect(() => enqueue(reopened, { ...plan, installerDigest: `sha256:${"b".repeat(64)}` }, "job", "new")).toThrow(new QueueError("request_conflict"));
  expect(() => enqueue(reopened, { ...plan, contract: { ...plan.contract,
    installation: { ...plan.contract.installation, channel: "beta" } } }, "candidate", "request")).toThrow(new QueueError("request_conflict"));
});

test("commits exactly one CAS owner and never authorizes an intent twice", () => {
  // Given
  const { path, queue, plan, observation } = fixture();
  enqueue(queue, plan);
  const other = new MutationQueue(path); queues.push(other);
  // When
  const permit = queue.acquire("job", 0, () => observation);
  // Then
  expect(permit.kind).toBe("mutation-ownership");
  expect(() => other.acquire("job", 0, () => observation)).toThrow(new QueueError("revision_conflict"));
  expect(() => other.acquire("job", 1, () => observation)).toThrow(new QueueError("recovery_required"));
  using db = new Database(join(path, "queue.sqlite"), { readonly: true });
  expect(db.query("SELECT count(*) AS n FROM entries WHERE slot=1").get()).toEqual({ n: 1 });
});

test("serializes different resources globally until the first verified outcome", () => {
  // Given
  const { root, queue, plan, observation } = fixture();
  const otherFile = join(root, "other"); writeFileSync(otherFile, "other");
  const resources = [{ resourceId: "other", realpath: otherFile, fingerprint: "other-fp" }];
  const other: ResourcePlan = { ...plan, contract: { ...plan.contract,
    installation: { ...plan.contract.installation, installationId: "other", executableRealpath: otherFile,
      resourcesFingerprint: "other-fp", resources } }, mutationResources: resources };
  enqueue(queue, plan);
  enqueue(queue, other, "other", "other-request");
  const owner = queue.acquire("job", 0, () => observation);
  const otherObservation = { ...observation, installation: other.contract.installation, mutationResources: resources };
  // When / Then
  expect(() => queue.acquire("other", 0, () => otherObservation)).toThrow(new QueueError("resources_busy"));
  queue.complete(owner, plan.contract.installation, () => plan.contract.installation);
  expect(queue.acquire("other", 0, () => otherObservation).kind).toBe("mutation-ownership");
});

test("cancel before intent prevents acquisition without invoking the observation reader", () => {
  // Given
  const { queue, plan } = fixture();
  enqueue(queue, plan);
  queue.cancel("job", 0);
  let reads = 0;
  // When / Then
  expect(() => queue.acquire("job", 1, () => { reads++; throw new Error("must not run"); })).toThrow(new QueueError("cancel_unsafe"));
  expect(reads).toBe(0);
  expect(queue.get("job").state).toBe("cancelled");
});

test("interrupted intent survives reopen without reclaim replay or late cancellation", () => {
  // Given
  const { queue, path, plan, observation } = fixture();
  acquire(queue, plan, observation);
  queue.close();
  const next = new MutationQueue(path); queues.push(next);
  // When / Then
  expect(next.get("job").state).toBe("recovery_required");
  expect(() => next.acquire("job", 1, () => observation)).toThrow(new QueueError("recovery_required"));
  expect(() => next.cancel("job", 1)).toThrow(new QueueError("cancel_unsafe"));
  enqueue(next, plan, "next", "next-request");
  expect(() => next.acquire("next", 0, () => observation)).toThrow(new QueueError("resources_busy"));
});

test("copied ownership and foreign queue ownership cannot release a writer", () => {
  // Given
  const { queue, path, plan, observation } = fixture();
  const owner = acquire(queue, plan, observation);
  const next = new MutationQueue(path); queues.push(next);
  // When / Then
  expect(() => queue.complete({ ...owner }, plan.contract.installation, () => plan.contract.installation)).toThrow(new QueueError("unauthorized"));
  expect(() => next.complete(owner, plan.contract.installation, () => plan.contract.installation)).toThrow(new QueueError("unauthorized"));
  expect(next.get("job").state).toBe("recovery_required");
});

test("postflight mismatch reserves the global writer and exposes only external_writer", () => {
  // Given
  const { queue, plan, observation } = fixture();
  const owner = acquire(queue, plan, observation);
  // When / Then
  expect(() => queue.complete(owner, plan.contract.installation, () => ({
    ...plan.contract.installation, resourcesFingerprint: "outsider",
  }))).toThrow(new QueueError("external_writer"));
  expect(queue.get("job").state).toBe("recovery_required");
  enqueue(queue, plan, "next", "next");
  expect(() => queue.acquire("next", 0, () => observation)).toThrow(new QueueError("resources_busy"));
});

test("rolls back reservation if the actual SQLite CAS update fails", () => {
  // Given
  const { queue, path, plan, observation } = fixture();
  enqueue(queue, plan);
  using db = new Database(join(path, "queue.sqlite"));
  db.exec("CREATE TRIGGER fail_intent BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'PRIVATE_SQL'); END");
  // When / Then
  expect(() => queue.acquire("job", 0, () => observation)).toThrow(new QueueError("verification_failed"));
  expect(db.query("SELECT count(*) AS n FROM entries WHERE slot=1").get()).toEqual({ n: 0 });
  expect(queue.get("job").revision).toBe(0);
});

test("keeps database and sidecars private and refuses permission repair", () => {
  // Given
  const { queue, path, plan } = fixture();
  enqueue(queue, plan);
  // When / Then
  expect(lstatSync(path).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(path)) expect(lstatSync(join(path, name)).mode & 0o777).toBe(0o600);
  chmodSync(path, 0o755);
  expect(() => queue.get("job")).toThrow(new QueueError("unauthorized"));
  expect(lstatSync(path).mode & 0o777).toBe(0o755);
});

test.each(["root", "database", "wal", "shm", "hardlink", "foreign", "schema"])("refuses hostile %s without clobber", variation => {
  // Given
  const { queue, path, root } = fixture();
  queue.close();
  const foreign = join(root, "foreign"); writeFileSync(foreign, "preserve", { mode: 0o600 });
  if (variation === "root") { rmSync(path, { recursive: true }); symlinkSync(root, path); }
  if (variation === "database" || variation === "hardlink") {
    rmSync(join(path, "queue.sqlite"));
    if (variation === "database") symlinkSync(foreign, join(path, "queue.sqlite"));
    else linkSync(foreign, join(path, "queue.sqlite"));
  }
  if (variation === "wal" || variation === "shm") {
    const sidecar = join(path, `queue.sqlite-${variation}`);
    if (existsSync(sidecar)) rmSync(sidecar);
    symlinkSync(foreign, sidecar);
  }
  if (variation === "foreign") {
    rmSync(join(path, "queue.sqlite"));
    using db = new Database(join(path, "queue.sqlite"));
    db.exec("CREATE TABLE precious(value TEXT)"); chmodSync(join(path, "queue.sqlite"), 0o600);
  }
  if (variation === "schema") {
    using db = new Database(join(path, "queue.sqlite"));
    db.exec("DROP INDEX single_mutation");
  }
  // When / Then
  expect(() => new MutationQueue(path)).toThrow();
  expect(readFileSync(foreign, "utf8")).toBe("preserve");
});

test("does not run caller hooks or persist private extra fields", () => {
  // Given
  const { queue, path, plan } = fixture();
  let hooks = 0;
  const bad = { jobId: "job", requestId: "request", plan, token: "PRIVATE_SENTINEL" };
  const proxy = new Proxy({}, { get() { hooks++; throw new Error("PRIVATE_SENTINEL"); },
    getPrototypeOf() { hooks++; throw new Error("PRIVATE_SENTINEL"); } });
  // When / Then
  expect(() => queue.enqueue(bad)).toThrow(new QueueError("malformed_request"));
  expect(() => queue.enqueue(proxy)).toThrow(new QueueError("malformed_request"));
  expect(hooks).toBe(0);
  for (const name of readdirSync(path)) expect(readFileSync(join(path, name)).includes(Buffer.from("PRIVATE_SENTINEL"))).toBe(false);
});

test("failed observation readers cannot leak thrown objects or reserve a slot", () => {
  // Given
  const { queue, plan, path } = fixture();
  enqueue(queue, plan);
  let hooks = 0;
  const poison = new Proxy({}, { getPrototypeOf() { hooks++; throw new Error("PRIVATE"); } });
  // When / Then
  expect(() => queue.acquire("job", 0, () => { throw poison; })).toThrow(new QueueError("verification_failed"));
  expect(hooks).toBe(0);
  expect(queue.get("job").revision).toBe(0);
  expect(existsSync(path)).toBe(true);
});

test("missing real reader remains unsupported and leaves a durable queued request", () => {
  // Given
  const { queue, plan } = fixture();
  enqueue(queue, plan);
  // When / Then
  expect(() => queue.acquire("job", 0)).toThrow(new QueueError("unsupported"));
  expect(queue.get("job")).toMatchObject({ state: "queued", revision: 0, operationId: null });
});

test("snapshot and stored plan cannot be changed by the final reader", () => {
  // Given
  const { queue, plan, observation } = fixture();
  enqueue(queue, plan);
  // When / Then
  expect(() => queue.acquire("job", 0, current => {
    Object.assign(current.contract, { capabilities: { ...current.contract.capabilities, update: unknown } });
    return observation;
  })).toThrow(new QueueError("verification_failed"));
  expect(queue.get("job").revision).toBe(0);
});

test("schema requires every uncertain intent to retain its global slot", () => {
  // Given
  const { queue, path, plan, observation } = fixture();
  acquire(queue, plan, observation);
  using db = new Database(join(path, "queue.sqlite"));
  // When / Then
  expect(() => db.exec("UPDATE entries SET slot=NULL WHERE state='intent'")).toThrow();
  expect(db.query("SELECT count(*) AS n FROM entries WHERE slot=1").get()).toEqual({ n: 1 });
});

test("failed postflight readers retain the intent even after ownership cannot settle", () => {
  // Given
  const { queue, plan, observation } = fixture();
  const permit = acquire(queue, plan, observation);
  // When / Then
  expect(() => queue.complete(permit, plan.contract.installation, () => { throw new Error("PRIVATE"); }))
    .toThrow(new QueueError("verification_failed"));
  expect(queue.get("job").state).toBe("recovery_required");
  expect(() => queue.complete(permit, plan.contract.installation, () => plan.contract.installation))
    .toThrow(new QueueError("unauthorized"));
});

test("postflight cannot release ownership for another installation or write set", () => {
  // Given
  const { queue, plan, observation } = fixture();
  const permit = acquire(queue, plan, observation);
  const other = { ...plan.contract.installation, installationId: "other" };
  // When / Then
  expect(() => queue.complete(permit, other, () => other)).toThrow(new QueueError("identity_mismatch"));
  expect(queue.get("job").state).toBe("recovery_required");
});

test("cancelled head admits the next request but later requests cannot jump the queue", () => {
  // Given
  const { queue, plan, observation } = fixture();
  enqueue(queue, plan);
  enqueue(queue, plan, "next", "next");
  // When / Then
  expect(() => queue.acquire("next", 0, () => observation)).toThrow(new QueueError("resources_busy"));
  queue.cancel("job", 0);
  expect(queue.acquire("next", 0, () => observation).kind).toBe("mutation-ownership");
});

test("queue never commits an intent while an overlapping consumer is running", () => {
  // Given
  const { queue, plan, observation, path } = fixture();
  enqueue(queue, plan);
  // When / Then
  expect(() => queue.acquire("job", 0, () => ({ ...observation, consumers: [{
    consumerId: "live", binding: null, resources: plan.mutationResources, state: "running",
  }] }))).toThrow(new QueueError("resources_busy"));
  using db = new Database(join(path, "queue.sqlite"), { readonly: true });
  expect(db.query("SELECT count(*) AS n FROM entries WHERE operation_id IS NOT NULL").get()).toEqual({ n: 0 });
  expect(queue.get("job").revision).toBe(0);
});

test("queue reports observed external writer drift without allocating an operation", () => {
  // Given
  const { queue, plan, observation } = fixture();
  enqueue(queue, plan);
  // When / Then
  expect(() => queue.acquire("job", 0, () => ({ ...observation,
    installation: { ...observation.installation, resourcesFingerprint: "external" },
  }))).toThrow(new QueueError("external_writer"));
  expect(queue.get("job")).toMatchObject({ state: "queued", revision: 0, operationId: null });
});
