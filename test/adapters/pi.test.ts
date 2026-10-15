import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, hash } from "../../.omo/evidence/herdr-cli-updater/task-11/fixture";
import { probeExecutable } from "../../src/discovery";
import { createPiAdapter } from "../../src/adapters/pi";
import type { FailureCode } from "../../src/protocol";
import { fixture as packageFixture } from "../../.omo/evidence/herdr-cli-updater/task-4/check-runtime-r1/fixture";

test("package-only Pi comparison preserves unknown owner channel and denies mutation", async () => {
  // Given
  const f = await packageFixture(), before = structuredClone(f.source.installation);
  let target = "";
  const adapter = createPiAdapter({ provenance: [], engineManifest: f.manifest, checkOnly: f.source.installation,
    qualification: () => null, runtime: () => null, core: () => null, update: () => null,
    release: async channel => { target = channel; return { name: "@code-yeongyu/senpi", version: "2026.10.1-4", "dist-tags": { latest: "2026.10.1-4" } }; } });
  try {
    // When
    const checked = await adapter.check(f.source.installation);
    // Then
    expect(checked).toMatchObject({ ok: true, value: { kind: "update-available", installedVersion: "2026.10.1-3", availableVersion: "2026.10.1-4" } });
    expect(target).toBe("latest");
    expect(f.source.installation).toEqual(before);
    expect(adapter.updateSpec(before, "update-only").ok).toBe(false);
  } finally { await f.cleanup(); }
});

test("package-only Pi refuses changed bin bytes after its release await", async () => {
  // Given
  const f = await packageFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const adapter = createPiAdapter({ provenance: [], engineManifest: f.manifest, checkOnly: f.source.installation,
    qualification: () => null, runtime: () => null, core: () => null, update: () => null, release: async () => {
      entered.resolve(); await release.promise; return { name: "@code-yeongyu/senpi", version: "2026.10.1-4", "dist-tags": { latest: "2026.10.1-4" } };
    } });
  try {
    // When
    const pending = adapter.check(f.source.installation); await entered.promise;
    await writeFile(f.executable, "changed"); release.resolve();
    // Then
    expect(await pending).toEqual({ ok: false, error: { code: "stale_selection" } });
  } finally { release.resolve(); await f.cleanup(); }
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function ownedFixture() { const f = await fixture(); roots.push(f.root); return f; }
const failure = (code: FailureCode) => ({ ok: false as const, error: { code } });

test("detects both actual aliases and reads installed version without launching", async () => {
  // Given: independently pinned physical package and two real symlinks.
  const f = await ownedFixture();
  // When: public adapter methods operate on real files.
  const aliases = await Promise.all(["pi", "senpi"].map(name => f.adapter.detect(join(f.root, name))));
  // Then: no basename inference, duplicate install or invented running version.
  expect(aliases).toEqual([{ ok: true, value: f.installation }, { ok: true, value: f.installation }]);
  expect(await f.adapter.version(f.installation)).toEqual({ ok: true, value: { kind: "known", version: "2026.10.1-3" } });
});
test.each(["2026.10.1-4", "2026.10.1-3", "2026.10.1-2"])("checks CalVer ordinal %s rather than semver prerelease", async candidate => {
  // Given: real installed metadata and authoritative registry data.
  const f = await ownedFixture();
  f.state.release = { name: "@code-yeongyu/senpi", version: candidate, "dist-tags": { latest: candidate } };
  // When / Then: an older registry response is not an update.
  expect(await f.adapter.check(f.installation)).toMatchObject({ ok: true, value: candidate.endsWith("-4")
    ? { kind: "update-available", availableVersion: candidate } : { kind: "up-to-date" } });
});
test.each(["name", "channel", "output"])("rejects misleading registry %s", async part => {
  // Given: wrong vendor, wrong dist-tag, or help-shaped successful response.
  const f = await ownedFixture();
  f.state.release = part === "output" ? { stdout: "senpi latest", exitCode: 0 }
    : { name: part === "name" ? "@earendil-works/pi-coding-agent" : "@code-yeongyu/senpi",
      version: "2026.10.1-4", "dist-tags": { latest: part === "channel" ? "2026.10.1-2" : "2026.10.1-4" } };
  // When / Then: success-looking text never becomes a machine release.
  expect(await f.adapter.check(f.installation)).toEqual(failure("verification_failed"));
});
test.each(["executable", "manifest", "receipt", "source"] as const)("rejects stale %s bytes despite unchanged metadata", async part => {
  // Given: pinned bytes have drifted.
  const f = await ownedFixture();
  const path = part === "executable" ? f.executable : part === "manifest" ? f.manifest : part === "receipt" ? f.pinPath : f.sourcePath;
  await writeFile(path, (await readFile(path, "utf8")) + " ");
  // When / Then: revalidation does not trust prior digest or help output.
  expect(await f.adapter.version(f.installation)).toEqual(failure("verification_failed"));
  expect(f.adapter.exactResume(f.runtime)).toEqual(failure("stale_binding"));
});
test.each(["owner", "channel", "package"] as const)("rejects dirty %s even with newly pinned local bytes", async part => {
  // Given: a matching digest is insufficient for the family contract.
  const f = await ownedFixture();
  if (part === "owner") f.receipt.owner = { kind: "unknown", reason: "unverified_owner" };
  if (part === "channel") f.receipt.channel = "beta";
  if (part === "package") {
    await writeFile(f.manifest, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "2026.10.1-3",
      bin: { pi: "bin/engine", senpi: "bin/engine" } }));
    f.receipt.resources[1] = { path: f.manifest, sha256: hash(await readFile(f.manifest)) };
  }
  await f.repin();
  // When / Then: standalone Senpi cannot borrow upstream Pi's semantics.
  expect(await f.adapter.detect(f.executable)).toEqual(failure("verification_failed"));
});
test("constructs shell-free exact resume with independently stored full identity and options", async () => {
  // Given: filename deliberately differs from the durable session id.
  const f = await ownedFixture();
  // When: no process effects, just the actual imported adapter's spec.
  const result = f.adapter.exactResume(f.runtime);
  // Then: full path and original options survive, not an id/picker fallback.
  expect(result).toMatchObject({ ok: true, value: { command: { executable: f.executable, cwd: f.root,
    args: ["--model", "vendor/model", "--mode", "rpc", "--thinking", "max", "--tools", "read,bash", "--session", f.sessionPath] },
    expectedBinding: f.runtime.binding, optionsRef: "private:options" } });
});
test.each(["missing", "empty", "headerless", "prefix", "cwd", "type", "version"] as const)(
  "blocks actual session %s before launch", async part => {
    // Given: an actual file cannot attest the requested durable identity.
    const f = await ownedFixture();
    if (part === "missing") await rm(f.sessionPath);
    else {
      const header = { ...f.header, ...(part === "prefix" ? { id: "0199" } : {}),
        ...(part === "cwd" ? { cwd: "/" } : {}), ...(part === "type" ? { type: "message" } : {}),
        ...(part === "version" ? { version: 2 } : {}) };
      await writeFile(f.sessionPath, part === "empty" ? "" : part === "headerless" ? '{"type":"message"}\n' : JSON.stringify(header) + "\n");
    }
    // When / Then: missing files are never initialized or guessed.
    expect(f.adapter.exactResume(f.runtime)).toEqual(failure(["missing", "empty"].includes(part) ? "missing_session" : "identity_mismatch"));
  });
test.each(["record", "path", "optionsRef", "fingerprint", "binding"] as const)("rejects missing or stale private %s", async part => {
  // Given: core's independently stored private record disagrees with the request.
  const f = await ownedFixture(), record = f.state.runtime;
  if (!record) throw new TypeError("fixture record");
  switch (part) {
    case "record": f.state.runtime = null; break;
    case "path": f.state.runtime = { ...record, sessionPath: "0199" }; break;
    case "optionsRef": f.state.runtime = { ...record, optionsRef: "private:other" }; break;
    case "fingerprint": f.state.runtime = { ...record, options: ["--model", "different/model"] }; break;
    case "binding": f.state.runtime = { ...record, runtime: { ...record.runtime,
      binding: { ...record.runtime.binding, paneGeneration: 2 } } }; break;
  }
  // When / Then: public path hash cannot discover a backing path or options.
  expect(f.adapter.exactResume(f.runtime)).toEqual(failure(part === "path" ? "missing_session" : "stale_binding"));
});
test.each(["fullId", "pathHash", "resourceFingerprint", "executable", "installationId"] as const)(
  "independently verifies %s even when private runtime snapshot agrees", async part => {
    // Given: both runtime snapshots agree, but the independent file/install record does not.
    const f = await ownedFixture(), record = f.state.runtime;
    if (!record) throw new TypeError("fixture record");
    const binding = { ...f.runtime.binding,
      session: { ...f.runtime.binding.session, ...(part === "fullId" ? { fullId: "0199" } : {}),
        ...(part === "pathHash" ? { storagePathHash: "sha256:other" } : {}) },
      ...(part === "resourceFingerprint" ? { resourcesFingerprint: "sha256:other" } : {}),
      rootIncarnation: { ...f.runtime.binding.rootIncarnation, ...(part === "executable" ? { executableRealpath: "/bin/other" } : {}) } };
    const runtime = { ...f.runtime, binding, ...(part === "installationId" ? { installationId: "install:other" } : {}) };
    f.state.runtime = { ...record, runtime: structuredClone(runtime) };
    // When / Then: equality alone cannot attest durable identity or current resources.
    expect(f.adapter.exactResume(runtime)).toEqual(failure(part === "fullId" ? "identity_mismatch"
      : part === "pathHash" ? "missing_session" : "stale_binding"));
  });
test.each([["--session-id", "0199"], ["--continue"], ["--fork", "/x"], ["--resume"], ["--session", "/x"],
  ["--model", "$(touch /x)"], ["--api-key", "not-a-secret"], ["--model"], ["prompt"], ["--mode", "shell"],
  ["--model", "a", "--model", "b"], ["--thinking", "invalid"]].map(options => ({ options })))("rejects unsafe option vector %j", async ({ options }) => {
  // Given: real options and a matching private fingerprint, so the option guard is decisive.
  const f = await ownedFixture(), record = f.state.runtime;
  if (!record) throw new TypeError("fixture record");
  f.state.runtime = { ...record, options, startupOptionsFingerprint: `sha256:${hash(JSON.stringify(options))}` };
  // When / Then: no prompt, secret, shell text or alternate selector enters specs.
  expect(f.adapter.exactResume(f.runtime)).toEqual(failure("unsupported"));
});
test.each(["commit", "signature", "source"] as const)("keeps %s provenance blocked after successful parser and help", async part => {
  // Given: mismatch/drift is independent of the working binary.
  const f = await ownedFixture(), evidence = f.state.qualification;
  if (!evidence) throw new TypeError("fixture qualification");
  if (part === "commit") f.state.qualification = { ...evidence, tagCommit: "b".repeat(40) };
  if (part === "signature") f.state.qualification = { ...evidence, signatureVerified: false };
  if (part === "source") f.state.qualification = { ...evidence,
    sourcePins: [{ path: f.sourcePath, sha256: "0".repeat(64) }] };
  expect((await probeExecutable({ executable: f.executable, cwd: f.root, argument: "--help" })).ok).toBe(true);
  // When / Then: a successful readonly probe cannot erase provenance failures.
  expect(f.adapter.exactResume(f.runtime)).toEqual(failure("verification_failed"));
});
test.each(["missing", "root", "tools", "subagents", "monitors", "continuations", "fence", "generation", "binding"] as const)(
  "requires actual complete core attestation rather than %s idle", async part => {
    // Given: missing/busy/stale authoritative core data.
    const f = await ownedFixture(), core = f.state.core;
    if (!core) throw new TypeError("fixture core");
    if (part === "missing") f.state.core = null;
    else if (["root", "tools", "subagents", "monitors", "continuations"].includes(part))
      f.state.core = { ...core, activeWork: { ...core.activeWork, [part]: 1 } };
    else if (part === "fence") f.state.core = { ...core, admission: "open" };
    else if (part === "generation") f.state.core = { ...core, workGeneration: 3 };
    else f.state.core = { ...core, expectedBinding: { ...core.expectedBinding, socketEpoch: "epoch:2" } };
    // When / Then: display idle cannot produce a completion or stop spec.
    expect(f.adapter.bridge(f.runtime)).toEqual(failure(part === "missing" ? "unsupported" : "resources_busy"));
    expect(f.adapter.gracefulExit(f.runtime, "operation:1", "owner:1")).toEqual(failure(part === "missing" ? "unsupported" : "resources_busy"));
  });
test("emits core specs only for full generation and matching exclusive claim", async () => {
  // Given: explicit complete, fenced core fixture; never a real attestation claim.
  const f = await ownedFixture();
  // When / Then: specs carry the full binding and reject a foreign claim.
  expect(f.adapter.bridge(f.runtime)).toMatchObject({ ok: true, value: { kind: "core-attestation", workGeneration: 4, expectedBinding: f.runtime.binding } });
  expect(f.adapter.gracefulExit(f.runtime, "operation:1", "owner:1")).toMatchObject({ ok: true, value: { kind: "core-stop" } });
  expect(f.adapter.gracefulExit(f.runtime, "operation:1", "owner:other")).toEqual(failure("unauthorized"));
});
test("blocks npm updates with the frozen environment and full mutation inventory gap", async () => {
  // Given: even pinned target and manager bytes do not bind npm's config or global writes.
  const f = await ownedFixture();
  // When / Then: no fake executable update readiness.
  expect(f.adapter.updateSpec(f.installation, "update-only")).toEqual(failure("unsupported"));
});
test.each(["manager", "target", "consumers", "fingerprint"] as const)("rejects unsafe private update %s before the API gap", async part => {
  // Given: individually invalid installer evidence, not a generic unsupported stub.
  const f = await ownedFixture(), record = f.state.update;
  if (!record) throw new TypeError("fixture update");
  if (part === "manager") await writeFile(f.managerPath, (await readFile(f.managerPath, "utf8")) + " ");
  if (part === "target") f.state.update = { ...record, release: { stdout: "latest", exitCode: 0 } };
  if (part === "consumers") f.state.update = { ...record, consumerInstallationIds: [f.installation.installationId, "install:other"] };
  if (part === "fingerprint") f.state.update = { ...record, resourcesFingerprint: "sha256:other" };
  // When / Then: stale evidence has a verification failure, not fake readiness.
  expect(f.adapter.updateSpec(f.installation, "update-only")).toEqual(failure("verification_failed"));
});
test("never separately updates an OmO-owned engine", async () => {
  // Given: the actual discovery compound owner route, not a standalone-looking basename.
  const f = await ownedFixture();
  const wrapper = join(f.root, "bin", "omo");
  const wrapperManifest = join(f.root, "wrapper.json");
  await writeFile(wrapper, `#!${process.execPath}\nthrow new Error("wrapper must not execute");\n`);
  const { chmod } = await import("node:fs/promises");
  await chmod(wrapper, 0o700);
  await writeFile(wrapperManifest, JSON.stringify({ name: "omo-ai", version: "5.1.9", bin: { omo: "bin/omo" },
    dependencies: { "@code-yeongyu/senpi": "2026.10.1-3" } }));
  f.receipt.family = "omo"; f.receipt.executable = wrapper; f.receipt.packageManifest = wrapperManifest;
  f.receipt.owner = { kind: "wrapper", packageName: "omo-ai", prefix: f.root, engineResourceId: `resource:${hash(f.manifest)}` };
  f.receipt.resources.push({ path: wrapper, sha256: hash(await readFile(wrapper)) },
    { path: wrapperManifest, sha256: hash(await readFile(wrapperManifest)) });
  await f.repin();
  // When: pi resolves to compound OmO ownership.
  const detected = await createPiAdapter(f.config).detect(join(f.root, "pi"));
  // Then: engine updater never receives a spec.
  expect(detected.ok).toBe(true);
  if (!detected.ok) throw new TypeError(detected.error.code);
  expect(detected.value.family).toBe("omo");
  expect(f.adapter.updateSpec(detected.value, "update-and-restart")).toEqual(failure("unsupported"));
});
test("runs shipped source parser in isolated fixture without operating CLI startup", async () => {
  // Given: the pinned actual parser body; no environment/profile imports.
  const f = await ownedFixture();
  // When: direct shell-free argv observes parser machine fields.
  const child = Bun.spawn([f.executable, "--session", f.sessionPath, "--model", "vendor/model", "--thinking", "max"],
    { cwd: f.root, env: {}, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then: semantic fields, not a successful exit alone.
  expect({ exit, stderr, parsed: JSON.parse(stdout) }).toMatchObject({ exit: 0, stderr: "", parsed: {
    session: f.sessionPath, model: "vendor/model", thinking: "max", messages: [], fileArgs: [], unknownFlags: {}, diagnostics: [] } });
});
test("observes misleading zero exit retaining unknown session selector in actual parser", async () => {
  // Given: parser treats equals syntax as unknown, unlike exact --session.
  const f = await ownedFixture();
  // When: exact external parser function executes in a task-owned binary.
  const child = Bun.spawn([f.executable, `--session=${f.sessionPath}`, "--latest"],
    { cwd: f.root, env: {}, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  // Then: no exact session identity, despite exit zero.
  expect({ exit, parsed: JSON.parse(stdout) }).toMatchObject({ exit: 0, parsed: {
    unknownFlags: { session: f.sessionPath, latest: true } } });
  expect(JSON.parse(stdout).session).toBeUndefined();
});

test.each((["runtime", "qualification", "core", "update", "release", "provenance"] as const).flatMap(source =>
  (["object", "string", "null"] as const).map(kind => ({ source, kind }))))(
  "normalizes arbitrary private callback exception $source $kind", async ({ source, kind }) => {
    // Given: an actual private callback throws one audited non-Error value.
    const f = await ownedFixture();
    let coercions = 0;
    const thrown = kind === "null" ? null : kind === "string" ? "PRIVATE_FIXTURE_NOT_A_SECRET" : {
      privateData: "PRIVATE_FIXTURE_NOT_A_SECRET",
      [Symbol.toPrimitive]() { coercions++; return "PRIVATE_FIXTURE_NOT_A_SECRET"; },
      toJSON() { coercions++; return "PRIVATE_FIXTURE_NOT_A_SECRET"; },
    };
    const throwing = (): never => { throw thrown; };
    const config = { ...f.config };
    switch (source) {
      case "runtime": config.runtime = throwing; break;
      case "qualification": config.qualification = throwing; break;
      case "core": config.core = throwing; break;
      case "update": config.update = throwing; break;
      case "release": config.release = throwing; break;
      case "provenance": Object.defineProperty(config, "provenance", { get: throwing }); break;
    }
    const adapter = createPiAdapter(config);
    // When: sync accessors and async entrypoints cross their real family boundary.
    const result = source === "core" ? adapter.bridge(f.runtime)
      : source === "update" ? adapter.updateSpec(f.installation, "update-only")
      : source === "release" ? await adapter.check(f.installation)
      : source === "provenance" ? await adapter.detect(f.executable)
      : adapter.exactResume(f.runtime);
    // Then: only the enum is returned; no inspection/coercion of the thrown value.
    expect(result).toEqual(failure("verification_failed"));
    expect(coercions).toBe(0);
  });
test.each(["object", "string", "null"] as const)("normalizes asynchronous private release rejection %s", async kind => {
  // Given: an awaited private producer rejects instead of throwing synchronously.
  const f = await ownedFixture();
  let coercions = 0;
  const thrown = kind === "null" ? null : kind === "string" ? "PRIVATE_FIXTURE_NOT_A_SECRET" : {
    [Symbol.toPrimitive]() { coercions++; return "PRIVATE_FIXTURE_NOT_A_SECRET"; },
    toJSON() { coercions++; return "PRIVATE_FIXTURE_NOT_A_SECRET"; },
  };
  const adapter = createPiAdapter({ ...f.config, release: async () => { throw thrown; } });
  // When / Then: the exact rejection is consumed, not leaked or serialized.
  expect(await adapter.check(f.installation)).toEqual(failure("verification_failed"));
  expect(coercions).toBe(0);
});
