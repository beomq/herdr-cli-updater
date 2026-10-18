import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmoAdapter } from "../../src/adapters/omo";
import type { OmoConfiguration, OmoCoreRecord, OmoRuntimeRecord } from "../../src/adapters/omo";
import type { AdapterResult } from "../../src/adapters/types";
import type { Runtime } from "../../src/protocol";
import { discoverExecutable, probeExecutable } from "../../src/discovery";
import { fixture as qualifiedFixture } from "../fixtures/evidence/task-9/update-consumer/fixture";
import { createOmoUpdateSpec, getOmoUpdateIntent } from "../../src/adapters/update-context";
import { parseAdapterContract } from "../../src/adapters/types";
import { fixture as packageFixture } from "../fixtures/evidence/task-4/check-runtime-r1/fixture";

test.each(["package", "main"] as const)("OmO %s path keeps official latest while honoring private exact target", async path => {
  const f = path === "package" ? await packageFixture("omo") : await fixture();
  try {
    const installation = "source" in f ? f.source.installation : f.installation;
    const base: OmoConfiguration = "source" in f ? {
      provenance: [], wrapperManifest: f.manifest, engineManifest: f.engine,
      checkOnly: installation, runtime: () => null, core: () => null, release: async () => null,
    } : f.config;
    const tags = { latest: "5.1.13", beta: "5.2.0-beta.1" }, selectors: string[] = [];
    const release = async (selector: string) => {
      selectors.push(selector);
      return { name: "omo-ai", version: selector === "latest" ? "5.1.13" : selector, "dist-tags": tags };
    };
    expect(await createOmoAdapter({ ...base, release }).check(installation)).toMatchObject({
      ok: true, value: { kind: "update-available", availableVersion: "5.1.13" },
    });
    expect(await createOmoAdapter({ ...base, release, targetVersion: "5.1.10" }).check(installation)).toMatchObject({
      ok: true, value: { kind: "update-available", availableVersion: "5.1.10" },
    });
    expect(selectors).toEqual(["latest", "5.1.10"]);
    expect(tags).toEqual({ latest: "5.1.13", beta: "5.2.0-beta.1" });
    for (const metadata of [{ version: "5.1.10" }, { name: "omo-ai" },
      { name: "foreign", version: "5.1.10" }, { name: "omo-ai", version: "5.1.13" }]) {
      expect(await createOmoAdapter({ ...base, targetVersion: "5.1.10",
        release: async () => metadata }).check(installation)).toEqual({ ok: false, error: { code: "verification_failed" } });
    }
    expect(await createOmoAdapter({ ...base, targetVersion: "^5.1.10", release }).check(installation))
      .toEqual({ ok: false, error: { code: "verification_failed" } });
  } finally { if ("cleanup" in f) await f.cleanup(); }
});

test("package-only comparison leaves OmO owner channel and mutation admission unchanged", async () => {
  // Given: physically bound package/dependency files, no npm owner receipt.
  const f = await packageFixture("omo"), before = structuredClone(f.source.installation);
  let target = "";
  const adapter = createOmoAdapter({ provenance: [], wrapperManifest: f.manifest, engineManifest: f.engine,
    checkOnly: f.source.installation, runtime: () => null, core: () => null,
    release: async channel => { target = channel; return { name: "omo-ai", version: "5.1.10", "dist-tags": { latest: "5.1.10" } }; } });
  try {
    // When
    const checked = await adapter.check(f.source.installation);
    // Then
    expect(checked).toMatchObject({ ok: true, value: { kind: "update-available", installedVersion: "5.1.9", availableVersion: "5.1.10" } });
    expect(target).toBe("latest");
    expect(f.source.installation).toEqual(before);
    const update = adapter.updateSpec(before, "update-only");
    expect(update.ok).toBe(false);
  } finally { await f.cleanup(); }
});

test.each(["5.1.8", "5.1.9-beta"])("package-only OmO refuses lower precedence %s", async candidate => {
  // Given: stable package bytes and no verified owner/channel.
  const f = await packageFixture("omo"), before = structuredClone(f.source);
  const adapter = createOmoAdapter({ provenance: [], wrapperManifest: f.manifest, engineManifest: f.engine,
    checkOnly: f.source.installation, runtime: () => null, core: () => null,
    release: async () => ({ name: "omo-ai", version: candidate, "dist-tags": { latest: candidate } }) });
  try {
    // When
    const checked = await adapter.check(f.source.installation);
    // Then
    expect(checked).toEqual({ ok: false, error: { code: "verification_failed" } });
    expect(f.source).toEqual(before);
    for (const pin of before.pins) expect(createHash("sha256").update(await readFile(pin.path)).digest("hex")).toBe(pin.sha256);
    expect(adapter.updateSpec(before.installation, "update-only").ok).toBe(false);
  } finally { await f.cleanup(); }
});

test.each(["5.1.9", "5.1.9+build.1"])("package-only OmO retains equal precedence %s", async candidate => {
  // Given: build metadata does not change precedence of the installed stable package.
  const f = await packageFixture("omo"), before = structuredClone(f.source);
  const adapter = createOmoAdapter({ provenance: [], wrapperManifest: f.manifest, engineManifest: f.engine,
    checkOnly: f.source.installation, runtime: () => null, core: () => null,
    release: async () => ({ name: "omo-ai", version: candidate, "dist-tags": { latest: candidate } }) });
  try {
    // When
    const checked = await adapter.check(f.source.installation);
    // Then
    expect(checked).toMatchObject({ ok: true, value: { kind: "up-to-date", installedVersion: "5.1.9" } });
    expect(f.source).toEqual(before);
    for (const pin of before.pins) expect(createHash("sha256").update(await readFile(pin.path)).digest("hex")).toBe(pin.sha256);
    expect(adapter.updateSpec(before.installation, "update-only").ok).toBe(false);
  } finally { await f.cleanup(); }
});

test("package-only OmO rechecks engine dependency after its release await", async () => {
  // Given
  const f = await packageFixture("omo"), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const adapter = createOmoAdapter({ provenance: [], wrapperManifest: f.manifest, engineManifest: f.engine,
    checkOnly: f.source.installation, runtime: () => null, core: () => null, release: async () => {
      entered.resolve(); await release.promise; return { name: "omo-ai", version: "5.1.10", "dist-tags": { latest: "5.1.10" } };
    } });
  try {
    // When
    const pending = adapter.check(f.source.installation); await entered.promise;
    await writeFile(f.engine, (await readFile(f.engine, "utf8")) + " "); release.resolve();
    // Then
    expect(await pending).toEqual({ ok: false, error: { code: "stale_selection" } });
  } finally { release.resolve(); await f.cleanup(); }
});

// allow: SIZE_OK — preserve the original 54 regressions verbatim and exercise
// the same scoped family boundary with real task38 qualification fixtures.
const qualifiedCleanups: Array<() => Promise<{ effects: number }>> = [];
async function qualified() {
  const f = await qualifiedFixture();
  qualifiedCleanups.push(f.cleanup);
  return f;
}

const source = join(import.meta.dir, "../fixtures/evidence/task-5/families/omo/boundedsource");
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const cleanup of qualifiedCleanups.splice(0)) expect((await cleanup()).effects).toBe(0);
});
function value<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "task9-omo-")));
  roots.push(root);
  await mkdir(join(root, "bin"));
  const executable = join(root, "bin/omo");
  const wrapperManifest = join(root, "package.json");
  const engineManifest = join(root, "engine.json");
  const sessionPath = join(root, "exact session.jsonl");
  const observations = join(root, "observations.jsonl");
  // Only this task-owned process can be probed; lifecycle arguments fail.
  await writeFile(executable, `#!${process.execPath}
import {appendFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(observations)},JSON.stringify({args,cwd:process.cwd()})+"\\n");
if(args.length===1 && args[0]==="--help") console.log(JSON.stringify({args,cwd:process.cwd()}));
else { console.log("omo 5.1.9 (engine: senpi 2026.10.1-3)"); process.exit(23); }
`);
  await chmod(executable, 0o700);
  const wrapper = { name: "omo-ai", version: "5.1.9", bin: { omo: "bin/omo" },
    dependencies: { "@code-yeongyu/senpi": "2026.10.1-3" } };
  await writeFile(wrapperManifest, JSON.stringify(wrapper));
  await writeFile(engineManifest, JSON.stringify({ name: "@code-yeongyu/senpi", version: "2026.10.1-3" }));
  const owner = { kind: "wrapper", packageName: "omo-ai",
    engineResourceId: `resource:${hash(engineManifest)}`, prefix: root } as const;
  const receipt = { family: "omo", executable, channel: "latest", owner, packageManifest: wrapperManifest,
    resources: await Promise.all([executable, wrapperManifest, engineManifest].map(async path => ({ path, sha256: hash(await readFile(path)) }))) };
  const receiptPath = join(root, "ownership.json");
  const receiptBody = JSON.stringify(receipt);
  await writeFile(receiptPath, receiptBody);
  const runtimePath = join(root, "private-runtime.json");
  const corePath = join(root, "private-core.json");
  const runtime = (): OmoRuntimeRecord | null => {
    const body: unknown = JSON.parse(readFileSync(runtimePath, "utf8"));
    // This is the private fixture store, not a success stub: data are changed on disk.
    if (!body || typeof body !== "object" || !("runtime" in body) || !("installation" in body)
      || !("sessionPath" in body) || !("options" in body)) return null;
    return record;
  };
  // Records are captured objects; accessors read disk and compare bytes before returning.
  let record: OmoRuntimeRecord;
  let coreRecord: OmoCoreRecord | null = null;
  const config: OmoConfiguration = {
    provenance: [{ path: receiptPath, sha256: hash(receiptBody) }], wrapperManifest, engineManifest,
    release: async () => JSON.parse(await readFile(join(root, "release.json"), "utf8")),
    runtime: () => {
      const loaded = runtime();
      return loaded && JSON.stringify(loaded) === readFileSync(runtimePath, "utf8") ? loaded : null;
    },
    core: () => coreRecord && JSON.stringify(coreRecord) === readFileSync(corePath, "utf8") ? coreRecord : null,
  };
  const adapter = createOmoAdapter(config);
  const installation = value(await adapter.detect(executable));
  const binding = {
    socketId: "socket", socketEpoch: "epoch", paneId: "pane", paneGeneration: 4,
    rootIncarnation: { pid: 99, startIdentity: "start", executableRealpath: executable },
    session: { kind: "conversation", fullId: "durable-full-id", storagePathHash: `sha256:${hash(sessionPath)}` },
    cwd: root, optionsRef: "private-options", turnGeneration: 8, resourcesFingerprint: installation.resourcesFingerprint,
  } as const;
  const expected: Runtime = { runtimeId: "runtime", installationId: installation.installationId,
    binding, runningVersion: { kind: "unknown", reason: "not_captured" } };
  record = { runtime: expected, installation, sessionPath, options: ["--provider", "test", "--model", "model/full", "--thinking", "high"] };
  const header = { type: "session", version: 3, id: binding.session.fullId, cwd: root };
  await writeFile(sessionPath, JSON.stringify(header) + "\n");
  await writeFile(runtimePath, JSON.stringify(record));
  await writeFile(join(root, "release.json"), JSON.stringify({ name: "omo-ai", version: "5.1.10", "dist-tags": { latest: "5.1.10" } }));
  return { root, adapter, installation, expected, sessionPath, observations, executable, wrapperManifest,
    receiptPath, config, header, wrapper,
    async setRecord(next: OmoRuntimeRecord) { record = next; await writeFile(runtimePath, JSON.stringify(next)); },
    get record() { return record; },
    async setCore(next: OmoCoreRecord) { coreRecord = next; await writeFile(corePath, JSON.stringify(next)); } };
}

test("discovers compound alias identity and reads installed version without spawning wrapper", async () => {
  // Given
  const f = await fixture();
  const alias = join(f.root, "pi");
  await symlink(f.executable, alias);
  // When
  const found = value(await f.adapter.detect(alias));
  // Then
  expect(found).toEqual(f.installation);
  expect(value(await f.adapter.version(found))).toEqual({ kind: "known", version: "5.1.9" });
  await expect(readFile(f.observations)).rejects.toMatchObject({ code: "ENOENT" });
});
test("checks actual registry data without invented check argv", async () => {
  // Given
  const f = await fixture();
  // When
  const checked = value(await f.adapter.check(f.installation));
  // Then
  expect(checked).toMatchObject({ kind: "update-available", installedVersion: "5.1.9", availableVersion: "5.1.10" });
  await expect(readFile(f.observations)).rejects.toMatchObject({ code: "ENOENT" });
});
test.each([null, {}, { name: "omo-ai", version: "success" }, { name: "senpi", version: "5.1.10", "dist-tags": { latest: "5.1.10" } }])(
  "blocks malformed or misleading release data %#", async release => {
    // Given
    const f = await fixture();
    await writeFile(join(f.root, "release.json"), JSON.stringify(release));
    // When / Then
    expect(await f.adapter.check(f.installation)).toEqual({ ok: false, error: { code: "verification_failed" } });
  },
);
test.each(["channel", "owner", "fingerprint"] as const)("blocks stale %s selections", async field => {
  // Given
  const f = await fixture();
  const installation = field === "channel" ? { ...f.installation, channel: "beta" }
    : field === "owner" ? { ...f.installation, owner: { ...f.installation.owner, prefix: "/wrong" } }
      : { ...f.installation, resourcesFingerprint: "sha256:stale" };
  // When / Then
  expect(await f.adapter.version(installation)).toEqual({ ok: false, error: { code: "stale_selection" } });
});
test("constructs shell-free resume with exact cwd id options and private path resolution", async () => {
  // Given
  const f = await fixture();
  // When
  const spec = value(f.adapter.exactResume(f.expected));
  // Then
  expect<string>(spec.command.executable).toBe(f.executable);
  expect<string>(spec.command.cwd).toBe(f.root);
  expect(spec.command.args).toEqual(["--provider", "test", "--model", "model/full", "--thinking", "high", "--session", f.sessionPath]);
  expect(spec.expectedBinding).toEqual(f.expected.binding);
  expect(spec.optionsRef).toBe("private-options");
  expect(JSON.stringify(f.expected.binding)).not.toContain(f.sessionPath);
  await expect(readFile(f.observations)).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["missing", "empty", "headerless", "wrong-id", "wrong-cwd", "wrong-version", "malformed"] as const)(
  "blocks %s files before loader fallback", async kind => {
    // Given
    const f = await fixture();
    if (kind === "missing") await rm(f.sessionPath);
    else await writeFile(f.sessionPath, kind === "empty" ? "" : kind === "headerless" ? '{"type":"message"}\n'
      : kind === "malformed" ? "{broken}\n" : JSON.stringify({ ...f.header,
        ...(kind === "wrong-id" ? { id: "other" } : kind === "wrong-cwd" ? { cwd: "/other" } : { version: 2 }) }) + "\n");
    // When / Then
    expect(f.adapter.exactResume(f.expected).ok).toBe(false);
    await expect(readFile(f.observations)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
test.each(["--session-id", "--continue", "--fork", "--api-key", "--unknown", "--session", "--resume"])(
  "blocks unsafe selector or secret option %s without echoing private values", async flag => {
    // Given
    const f = await fixture();
    await f.setRecord({ ...f.record, options: [flag, "SECRET_SENTINEL"] });
    // When / Then
    expect(f.adapter.exactResume(f.expected)).toEqual({ ok: false, error: { code: "unsupported" } });
  },
);
test.each(["socketEpoch", "paneGeneration", "turnGeneration", "optionsRef", "cwd"] as const)(
  "blocks changed binding %s against authoritative record", async field => {
    // Given
    const f = await fixture();
    const binding = { ...f.expected.binding, [field]: field.endsWith("Generation") ? 99 : "changed" };
    // When / Then
    expect(f.adapter.exactResume({ ...f.expected, binding }).ok).toBe(false);
  },
);
test("detects external resource writer before specs", async () => {
  // Given
  const f = await fixture();
  await writeFile(f.wrapperManifest, JSON.stringify({ ...f.wrapper, version: "5.1.10" }));
  // When / Then
  expect(f.adapter.exactResume(f.expected)).toEqual({ ok: false, error: { code: "stale_binding" } });
  expect(f.adapter.updateSpec(f.installation, "update-only")).toEqual({ ok: false, error: { code: "stale_selection" } });
});
test("requires authoritative drain and matching fenced claim rather than display idle", async () => {
  // Given
  const f = await fixture();
  const core: OmoCoreRecord = { expectedBinding: f.expected.binding, evidenceRef: "fixture-core",
    workGeneration: 8, admission: "fenced", activeWork: { root: 0, tools: 0, subagents: 0, monitors: 0, continuations: 0 },
    claim: { operationId: "stop-1", ownerTokenRef: "owner-1" } };
  await f.setCore(core);
  // When / Then
  expect(value(f.adapter.bridge(f.expected)).workGeneration).toBe(8);
  expect(value(f.adapter.gracefulExit(f.expected, "stop-1", "owner-1")).kind).toBe("core-stop");
  expect(f.adapter.gracefulExit(f.expected, "stop-2", "owner-1")).toEqual({ ok: false, error: { code: "unauthorized" } });
});
test.each(["root", "tools", "subagents", "monitors", "continuations"] as const)("rejects active %s work", async work => {
  // Given
  const f = await fixture();
  await f.setCore({ expectedBinding: f.expected.binding, evidenceRef: "fixture-core", workGeneration: 8, admission: "fenced",
    activeWork: { root: 0, tools: 0, subagents: 0, monitors: 0, continuations: 0, [work]: 1 }, claim: null });
  // When / Then
  expect(f.adapter.bridge(f.expected)).toEqual({ ok: false, error: { code: "resources_busy" } });
});
test.each(["epoch", "generation", "admission"] as const)("rejects stale core %s evidence", async kind => {
  // Given
  const f = await fixture();
  await f.setCore({ expectedBinding: { ...f.expected.binding, ...(kind === "epoch" ? { socketEpoch: "old" } : {}) },
    evidenceRef: "fixture-core", workGeneration: kind === "generation" ? 7 : 8,
    admission: kind === "admission" ? "open" : "fenced",
    activeWork: { root: 0, tools: 0, subagents: 0, monitors: 0, continuations: 0 }, claim: null });
  // When / Then
  expect(f.adapter.bridge(f.expected)).toEqual({ ok: false, error: { code: "resources_busy" } });
});
test("blocks absent core and unrepresentable wrapper update context", async () => {
  // Given
  const f = await fixture();
  // When / Then
  expect(f.adapter.bridge(f.expected)).toEqual({ ok: false, error: { code: "unsupported" } });
  expect(f.adapter.gracefulExit(f.expected, "stop", "owner")).toEqual({ ok: false, error: { code: "unsupported" } });
  expect(f.adapter.updateSpec(f.installation, "update-and-restart")).toEqual({ ok: false, error: { code: "unsupported" } });
});
test("probes only an isolated command and rejects exit failure despite plausible stdout", async () => {
  // Given
  const f = await fixture();
  // When
  const help = await probeExecutable({ executable: f.executable, cwd: f.root, argument: "--help" });
  const version = await probeExecutable({ executable: f.executable, cwd: f.root, argument: "--version" });
  // Then
  expect(help.ok).toBe(true);
  expect(version).toEqual({ ok: false, error: { code: "probe_failed" } });
  const observations = (await readFile(f.observations, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(observations).toEqual([{ args: ["--help"], cwd: f.root }, { args: ["--version"], cwd: f.root }]);
});
test("uses acquired pure wrapper parser and actual permissive JSONL parser as counterexample", async () => {
  // Given: no operating CLI or loader success mock. Extract exactly the self-contained exported parser.
  const parserModule = await import(join(source, "omo/bin/lib/update-args.js"));
  const loader = await readFile(join(source, "senpi/dist/core/session-manager.js"), "utf8");
  const start = loader.indexOf("export function parseSessionEntries(content) {");
  const end = loader.indexOf("export function getLatestCompactionEntry", start);
  if (start < 0 || end < 0) throw new TypeError("source function missing");
  const parse: (content: string) => unknown = new Function(loader.slice(start, end).replace("export ", "") + "; return parseSessionEntries;")();
  const f = await fixture();
  await writeFile(f.sessionPath, '{"type":"message"}\n');
  // When / Then: official parser accepts an entry that does not carry a stable header; adapter blocks it.
  expect(parse(await readFile(f.sessionPath, "utf8"))).toEqual([{ type: "message" }]);
  expect(f.adapter.exactResume(f.expected)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
  expect(parserModule.isSelfUpdate(["update"])).toBe(true);
  expect(parserModule.updateUsageAnswer(["update", "--check"])).toMatchObject({ exitCode: 2 });
});

test.each(
  (["runtime", "core", "provenance", "release"] as const).flatMap(seam =>
    (["object", "string", "null"] as const).map(kind => ({ seam, kind }))),
)("normalizes arbitrary throw at $seam for $kind without private exposure", async ({ seam, kind }) => {
  // Given: callbacks/getters can throw any JS value; coercing the object is itself unsafe.
  const f = await fixture();
  let inspections = 0;
  const payload = kind === "null" ? null : kind === "string" ? "SYNTHETIC_PRIVATE_THROW" : {
    privateValue: "SYNTHETIC_PRIVATE_THROW",
    toJSON() { inspections++; throw null; },
    toString() { inspections++; throw null; },
  };
  const reject = (): never => { throw payload; };
  const config: OmoConfiguration = {
    ...f.config,
    ...(seam === "runtime" ? { runtime: reject } : {}),
    ...(seam === "core" ? { core: reject } : {}),
    ...(seam === "release" ? { release: async () => reject() } : {}),
    get provenance() { return seam === "provenance" ? reject() : f.config.provenance; },
  };
  const adapter = createOmoAdapter(config);
  // When: consume escape without logging/serializing payload, so a RED run is safe.
  const result = await Promise.resolve().then((): unknown => {
    if (seam === "runtime") return adapter.exactResume(f.expected);
    if (seam === "core") return adapter.bridge(f.expected);
    if (seam === "release") return adapter.check(f.installation);
    return adapter.detect(f.executable);
  }).catch(() => ({ escaped: true }));
  // Then: exact public failure, never arbitrary rejection/throw or coercion.
  expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
  expect(inspections).toBe(0);
});

test.each(["update-only", "update-and-restart"] as const)("consumes exact qualified %s operation without promotion", async mode => {
  // Given: actual archive/receipt/source-qualified context, not a capability flag.
  const f = await qualified();
  await f.check();
  const expected = f.operations.get(mode);
  if (!expected) throw new TypeError("fixture_operation_missing");
  // When
  const spec = value(f.adapter.updateSpec(f.installation, mode));
  // Then: issued spec and intent preserve wrapper plus owned engine; private env stays opaque.
  expect(spec).toEqual(expected.spec);
  expect(value(getOmoUpdateIntent(spec))).toEqual(expected.intent);
  expect(spec.execution).toBe(f.context);
  expect(JSON.stringify(spec.execution)).toBe('{"kind":"omo-official-update"}');
  expect(JSON.stringify(spec)).not.toContain('"HOME"');
  expect(JSON.stringify(spec)).not.toContain('"BUN_INSTALL"');
  const owner = f.installation.owner;
  if (owner.kind !== "wrapper") throw new TypeError("fixture_owner_mismatch");
  expect(spec.mutationResources.some(row => row.resourceId === owner.engineResourceId)).toBe(true);
});
test.each(["no-check", "no-provider", "no-qualification", "up-to-date"] as const)("blocks %s without losing safe check semantics", async state => {
  // Given
  const f = await qualified();
  const { updateAuthority: _authority, ...withoutAuthority } = f.config;
  const adapter = state === "no-provider" ? createOmoAdapter(withoutAuthority)
    : state === "no-qualification" ? createOmoAdapter({ ...f.config, updateAuthority: { now: f.authority.now, read: () => null } })
      : f.adapter;
  if (state === "up-to-date") await writeFile(f.releasePath, '{"name":"omo-ai","version":"5.1.9","dist-tags":{"latest":"5.1.9"}}');
  if (state !== "no-check") expect((value(await adapter.check(f.installation))).kind).toBe(state === "up-to-date" ? "up-to-date" : "update-available");
  // When / Then
  expect(adapter.updateSpec(f.installation, "update-only")).toEqual({ ok: false, error: { code: "unsupported" } });
});
test.each(["owner", "resources", "fingerprint", "channel", "installed-version"] as const)("rejects mismatched selected %s before authority", async field => {
  // Given
  const f = await qualified();
  await f.check();
  const selected = field === "owner" ? { ...f.installation, owner: { kind: "unknown", reason: "unverified_owner" } as const }
    : field === "resources" ? { ...f.installation, resources: f.installation.resources.slice(1) }
      : field === "fingerprint" ? { ...f.installation, resourcesFingerprint: "sha256:stale" }
        : field === "channel" ? { ...f.installation, channel: "beta" }
          : { ...f.installation, installedVersion: { kind: "known", version: "5.1.10" } as const };
  // When / Then
  expect(f.adapter.updateSpec(selected, "update-only")).toEqual({ ok: false, error: { code: "stale_selection" } });
});
test.each(["forged-context", "mode", "target", "expired", "check-failed"] as const)("rejects %s qualified operation mismatch", async risk => {
  // Given
  const f = await qualified();
  const operation = f.operations.get("update-only");
  if (!operation) throw new TypeError("fixture_operation_missing");
  const adapter = createOmoAdapter({ ...f.config, updateAuthority: { now: f.authority.now,
    read: () => ({ context: risk === "forged-context" ? { kind: "omo-official-update" } : f.context,
      intent: { ...operation.intent, ...(risk === "mode" ? { mode: "update-and-restart" } : {}) } }) } });
  if (risk === "target") await writeFile(f.releasePath, '{"name":"omo-ai","version":"5.1.11","dist-tags":{"latest":"5.1.11"}}');
  value(await adapter.check(f.installation));
  if (risk === "expired") f.setClock(f.input.qualification.target.expiresAt);
  if (risk === "check-failed") {
    await writeFile(f.releasePath, "null");
    expect((await adapter.check(f.installation)).ok).toBe(false);
  }
  // When / Then
  expect(adapter.updateSpec(f.installation, "update-only")).toEqual({ ok: false, error: {
    code: risk === "check-failed" ? "unsupported" : "verification_failed" } });
});
test.each(["object", "string", "null", "revoked-proxy", "getter"] as const)("sanitizes hostile update provider %s", async kind => {
  // Given
  const f = await qualified();
  const operation = f.operations.get("update-only");
  if (!operation) throw new TypeError("fixture_operation_missing");
  const proxy = Proxy.revocable({ context: f.context, intent: operation.intent }, {});
  proxy.revoke();
  const payload = kind === "null" ? null : kind === "string" ? "PRIVATE_PROVIDER_SENTINEL" : { private: "PRIVATE_PROVIDER_SENTINEL" };
  const adapter = createOmoAdapter({ ...f.config, updateAuthority: { now: f.authority.now,
    read() {
      if (kind === "revoked-proxy") return proxy.proxy;
      if (kind === "getter") return { get context(): never { throw payload; }, intent: operation.intent };
      throw payload;
    } } });
  value(await adapter.check(f.installation));
  // When / Then: no thrown payload or classifier access crosses the public boundary.
  expect(adapter.updateSpec(f.installation, "update-only")).toEqual({ ok: false, error: { code: "verification_failed" } });
});
test("uses final private clock and file observations rather than cached readiness", async () => {
  // Given
  const f = await qualified();
  const operation = f.operations.get("update-only");
  if (!operation) throw new TypeError("fixture_operation_missing");
  let phase: "check" | "update" = "check";
  const adapter = createOmoAdapter({ ...f.config, updateAuthority: { read: () => operation,
    now() {
      if (phase === "update") {
        // Exact r3 late-private-observation adversary: source qualifier owns final read.
        writeFileSync(join(f.home, ".bunfig.toml"), "private-sentinel");
      }
      return f.authority.now();
    } } });
  value(await adapter.check(f.installation));
  phase = "update";
  // When / Then
  expect(adapter.updateSpec(f.installation, "update-only")).toEqual({ ok: false, error: { code: "verification_failed" } });
});
test("does not promote shared engine or adapter capabilities from provider presence", async () => {
  // Given
  const f = await qualified();
  await f.check();
  const discovered = await discoverExecutable({ executable: f.installation.executableRealpath,
    family: "pi", provenance: f.config.provenance });
  if (!discovered.ok) throw new TypeError(discovered.error.code);
  // When / Then: actual structural contract remains unsupported independently of spec issuance.
  expect(parseAdapterContract({ version: 1, family: "omo", installation: f.installation, runtime: null,
    capabilities: discovered.value.capabilities }).ok).toBe(true);
  expect(discovered.value.installation.family).toBe("omo");
  expect(discovered.value.capabilities.update.kind).toBe("unknown");
  expect(discovered.value.capabilities.busySafe.kind).toBe("unknown");
  expect(f.adapter.updateSpec({ ...f.installation, family: "pi" }, "update-only")).toEqual({ ok: false, error: { code: "stale_selection" } });
});
test("rejects independently qualified authority for another installation", async () => {
  // Given
  const f = await qualified();
  const other = await qualified();
  const operation = other.operations.get("update-only");
  if (!operation) throw new TypeError("fixture_operation_missing");
  const adapter = createOmoAdapter({ ...f.config, updateAuthority: { now: f.authority.now, read: () => operation } });
  value(await adapter.check(f.installation));
  // When / Then
  expect(adapter.updateSpec(f.installation, "update-only")).toEqual({ ok: false, error: { code: "verification_failed" } });
});
test("rejects engine resource drift introduced by private provider before final issuance", async () => {
  // Given
  const f = await qualified();
  const operation = f.operations.get("update-only");
  if (!operation) throw new TypeError("fixture_operation_missing");
  const adapter = createOmoAdapter({ ...f.config, updateAuthority: { now: f.authority.now,
    read() {
      writeFileSync(f.config.engineManifest, '{"name":"@code-yeongyu/senpi","version":"changed"}');
      return operation;
    } } });
  value(await adapter.check(f.installation));
  // When / Then
  expect(adapter.updateSpec(f.installation, "update-only")).toEqual({ ok: false, error: { code: "verification_failed" } });
});
test("retains detached checked target when caller mutates a public check result", async () => {
  // Given
  const f = await qualified();
  const checked = await f.check();
  Reflect.set(checked, "availableVersion", "5.1.11");
  // When / Then: the authoritative query still carries the exact captured check.
  expect(value(f.adapter.updateSpec(f.installation, "update-only")).command.args).toEqual(["add", "-g", "omo-ai@5.1.10"]);
});

test.each(["caller-family", "provider-channel"] as const)("F3 prevents postissuer original selection getter %s", async writer => {
  // Given: exact independent setups, using the actual qualified fixture and issuer.
  const f = await qualified();
  const operation = f.operations.get("update-only");
  if (!operation) throw new TypeError("fixture_operation_missing");
  let clockReached = false, updatePhase = false, lateWrites = 0, getterCalls = 0;
  const installGetter = () => Object.defineProperty(f.installation, writer === "caller-family" ? "family" : "channel", {
    enumerable: true, configurable: true,
    get() {
      getterCalls++;
      if (clockReached) {
        lateWrites++;
        writeFileSync(writer === "caller-family" ? join(f.home, ".env") : f.config.engineManifest,
          writer === "caller-family" ? "synthetic-owned-drift" : '{"name":"@code-yeongyu/senpi","version":"late-drift"}');
      }
      return writer === "caller-family" ? "omo" : "latest";
    },
  });
  const adapter = createOmoAdapter({ ...f.config, updateAuthority: {
    now() { if (updatePhase) clockReached = true; return f.authority.now(); },
    read() { if (writer === "provider-channel") installGetter(); return operation; },
  } });
  value(await adapter.check(f.installation));
  if (writer === "caller-family") installGetter();
  updatePhase = true;
  // When
  const result = adapter.updateSpec(f.installation, "update-only");
  // Then: reject without invoking the accessor or accepting any changed file.
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("verification_failed");
  expect(getterCalls).toBe(0);
  expect(lateWrites).toBe(0);
  expect(createOmoUpdateSpec(f.context, operation.intent, f.authority.now()).ok).toBe(true);
});
test.each(["prototype", "owner-accessor", "resource-accessor", "array-accessor", "proxy", "symbol", "unexpected-field"] as const)(
  "rejects nondata selection %s without caller or authority hooks", async kind => {
    // Given: only ordinary enumerable plain contract data may cross this boundary.
    const f = await qualified();
    const operation = f.operations.get("update-only");
    if (!operation) throw new TypeError("fixture_operation_missing");
    let selected = structuredClone(f.installation), hooks = 0, reads = 0;
    const first = selected.resources[0];
    if (!first) throw new TypeError("fixture_resource_missing");
    if (kind === "prototype") Object.setPrototypeOf(selected, { get family() { hooks++; return "omo"; } });
    if (kind === "owner-accessor") Object.defineProperty(selected.owner, "prefix", { enumerable: true, get() { hooks++; return f.prefix; } });
    if (kind === "resource-accessor") {
      const path = first.realpath;
      Object.defineProperty(first, "realpath", { enumerable: true, get() { hooks++; return path; } });
    }
    if (kind === "array-accessor") Object.defineProperty(selected.resources, "0", { enumerable: true, get() { hooks++; return first; } });
    if (kind === "proxy") selected = new Proxy(selected, {
      get(target, key, receiver) { hooks++; return Reflect.get(target, key, receiver); },
      getPrototypeOf(target) { hooks++; return Reflect.getPrototypeOf(target); },
      ownKeys(target) { hooks++; return Reflect.ownKeys(target); },
    });
    if (kind === "symbol") Object.defineProperty(selected, Symbol.toPrimitive, { get() { hooks++; throw null; } });
    if (kind === "unexpected-field") Reflect.set(selected, "extra", "caller-data");
    const adapter = createOmoAdapter({ ...f.config, updateAuthority: {
      now: f.authority.now, read() { reads++; return operation; },
    } });
    value(await adapter.check(f.installation));
    // When / Then
    const result = adapter.updateSpec(selected, "update-only");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("verification_failed");
    expect(hooks).toBe(0);
    expect(reads).toBe(0);
  },
);
