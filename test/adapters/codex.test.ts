import { afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fixture, digest, threadId } from "../../.omo/evidence/herdr-cli-updater/task-13/fixture";
import { createCodexAdapter } from "../../src/adapters/codex";
import type { RuntimeIdentity } from "../../src/adapters/types";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup(manager: "npm" | "bun" = "npm", executablePadding = 0) {
  const f = await fixture(manager, executablePadding);
  fixtures.push(f);
  return f;
}
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

test("discovers physical aliases without separate shared resources", async () => {
  // Given: two names for a real isolated executable.
  const f = await setup();
  const alias = join(f.root, "codex-alias");
  symlinkSync(f.executable, alias);
  // When: the actual adapter discovers the alias through canonical discovery.
  const result = await f.adapter.detect(alias);
  // Then: owner, channel and the entire physical resource identity are retained.
  expect(result).toEqual({ ok: true, value: f.installation });
  expect(existsSync(f.callsPath)).toBe(false);
});

test("probes exact version and checks independent release registry agreement", async () => {
  // Given: disk-backed independent release/registry observations.
  const f = await setup();
  // When: actual bounded command probe runs, then metadata is parsed.
  const result = await f.adapter.check(f.installation);
  // Then: the command observation is --version only, and no mutation happened.
  expect(result).toEqual({ ok: true, value: {
    kind: "update-available", installedVersion: "0.156.0", availableVersion: "0.160.0", checkedAt: 123,
  } });
  expect(readFileSync(f.callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line)))
    .toEqual([{ args: ["--version"], cwd: f.root }]);
  expect(existsSync(f.effectPath)).toBe(false);
});

test.each(["npm", "bun"] as const)("blocks floating %s update pending immutable private context", async manager => {
  // Given: separately stored manager registration and pinned executable.
  const f = await setup(manager);
  // When: an update command spec is requested.
  const result = f.adapter.updateSpec(f.installation, "update-only");
  // Then: qualified owner alone cannot authorize a floating update target.
  expect(result).toEqual({ ok: false, error: { code: "unsupported" } });
  expect(existsSync(f.callsPath)).toBe(false);
  expect(existsSync(f.effectPath)).toBe(false);
});

test("preserves full thread identity cwd and private options in exact resume spec", async () => {
  // Given: rollout filename does not contain the thread UUID.
  const f = await setup();
  // When: real local session loader and independent preflight verify the runtime.
  const result = f.adapter.exactResume(f.runtime);
  // Then: optionsRef stays opaque in the binding; only private command spec has args.
  expect(result).toEqual({ ok: true, value: {
    command: { executable: f.executable, args: ["resume", threadId, ...f.privateData.args], cwd: f.root },
    expectedBinding: f.runtime.binding, optionsRef: f.runtime.binding.optionsRef,
  } });
  expect(existsSync(f.callsPath)).toBe(false);
});

test.each([false, true])("verifies large Codex resources including tail drift=%s", async drift => {
  // Given: discovery has qualified an executable larger than the old 64 MiB read limit.
  const f = await setup("npm", 64 * 1024 * 1024);
  if (drift) {
    const fd = openSync(f.executable, "r+");
    try { writeSync(fd, Buffer.from("!"), 0, 1, statSync(f.executable).size - 1); }
    finally { closeSync(fd); }
  }
  // When: resume rechecks the entire executable without launching it.
  const result = f.adapter.exactResume(f.runtime);
  // Then: size alone is accepted, but even a last-byte change fails closed.
  expect(result.ok ? "verified" : result.error.code).toBe(drift ? "external_writer" : "verified");
  if (result.ok) expect(result.value.command.args).toEqual(["resume", threadId, ...f.privateData.args]);
  expect(existsSync(f.callsPath)).toBe(false);
});

test("rejects changed executable bytes before exactResume without a CLI probe", async () => {
  // Given: a real executable drifts after detection; its valid version behavior is unchanged.
  const f = await setup();
  writeFileSync(f.executable, readFileSync(f.executable, "utf8") + "\n// resource drift\n");
  // When: resume runs current() freshness, not updateSpec's separate manager guard.
  const result = f.adapter.exactResume(f.runtime);
  // Then: assert the exact failure code without dumping a private spec on mutant failure.
  expect(result.ok ? null : result.error.code).toBe("external_writer");
  expect(existsSync(f.callsPath)).toBe(false);
  expect(existsSync(f.effectPath)).toBe(false);
});

test.each(["legacy", "paginated", "future"])("checks original Codex history mode %s", async history_mode => {
  const f = await setup();
  writeFileSync(f.sessionPath, JSON.stringify({ ...f.meta, payload: { ...f.meta.payload, history_mode } }) + "\n");
  const result = f.adapter.exactResume(f.runtime);
  expect(result.ok).toBe(history_mode !== "future");
  if (!result.ok) expect(result.error.code).toBe("identity_mismatch");
});

test("rejects changed executable bytes before version without a CLI probe", async () => {
  // Given: a real executable drifts while still able to print the expected version.
  const f = await setup();
  writeFileSync(f.executable, readFileSync(f.executable, "utf8") + "\n// resource drift\n");
  // When: version must verify installation resources before spawning the child.
  const result = await f.adapter.version(f.installation);
  // Then: a probe-and-verify-later implementation is also a regression.
  expect(result.ok ? null : result.error.code).toBe("external_writer");
  expect(existsSync(f.callsPath)).toBe(false);
  expect(existsSync(f.effectPath)).toBe(false);
});

test.each(["manager", "channel", "owner", "resource", "pin"] as const)("rejects stale %s before update spec", async part => {
  // Given: an actual authority or resource changes after detection.
  const f = await setup();
  if (part === "resource") writeFileSync(f.executable, "changed resource");
  if (part === "pin") f.pin.sha256 = "0".repeat(64);
  if (part === "manager") writeFileSync(f.managerPath, JSON.stringify({ owner: f.installation.owner, channel: f.installation.channel }));
  const installation = part === "channel" ? { ...f.installation, channel: "unknown" }
    : part === "owner" ? { ...f.installation, owner: { kind: "unknown", reason: "unverified_owner" } as const } : f.installation;
  // When: adapter attempts spec construction.
  const result = f.adapter.updateSpec(installation, "update-only");
  // Then: no spec or command exists.
  expect(result).toEqual({ ok: false, error: { code: part === "resource" ? "external_writer"
    : part === "manager" ? "identity_mismatch" : "stale_selection" } });
  expect(existsSync(f.callsPath)).toBe(false);
});

test("blocks unknown installation provenance rather than accepting manifest hints", async () => {
  // Given: a genuine manifest but no independently verified owning manager/channel.
  const f = await setup();
  const adapter = createCodexAdapter({
    probeCwd: "/tmp", provenance: () => [], privateRuntime: () => null,
    preflight: () => null, manager: () => null, releases: async () => null, now: () => 0,
  });
  const found = await adapter.detect(f.executable);
  if (!found.ok) throw new TypeError(found.error.code);
  // When: mutation is requested.
  const result = adapter.updateSpec(found.value, "update-only");
  // Then: metadata has not been promoted to readiness.
  expect(result).toEqual({ ok: false, error: { code: "unsupported" } });
});

test.each(["epoch", "pane", "pid", "start", "turn", "cwd", "identity", "options", "fingerprint"] as const)(
  "blocks stale full runtime %s independently of saved private data", async field => {
    // Given: the authoritative observation changed independently.
    const f = await setup();
    const binding = structuredClone(f.runtime.binding);
    const live = { ...binding };
    switch (field) {
      case "epoch": live.socketEpoch = "epoch-2"; break;
      case "pane": live.paneGeneration++; break;
      case "pid": live.rootIncarnation = { ...live.rootIncarnation, pid: 124 }; break;
      case "start": live.rootIncarnation = { ...live.rootIncarnation, startIdentity: "start-2" }; break;
      case "turn": live.turnGeneration++; break;
      case "cwd": live.cwd = "/tmp"; break;
      case "identity": live.session = { ...live.session, fullId: "0199ad22-1388-7a11-8baa-222222222222" }; break;
      case "options": live.optionsRef = "different-private-options"; break;
      case "fingerprint": live.resourcesFingerprint = "sha256:changed"; break;
    }
    writeFileSync(f.preflightPath, JSON.stringify({ ...f.preflight, binding: live }));
    // When: the expected binding is requested.
    const result = f.adapter.exactResume(f.runtime);
    // Then: every component is compared before producing a launch spec.
    expect(result).toEqual({ ok: false, error: { code: "stale_binding" } });
  },
);

test("missing saved thread blocks rather than selecting last or creating fresh", async () => {
  // Given: private reference and live observation remain, but session is deleted.
  const f = await setup();
  rmSync(f.sessionPath);
  // When: exact resume verifies the authoritative file.
  const result = f.adapter.exactResume(f.runtime);
  // Then: no new session or launch command.
  expect(result).toEqual({ ok: false, error: { code: "missing_session" } });
  expect(existsSync(f.sessionPath)).toBe(false);
  expect(existsSync(f.callsPath)).toBe(false);
});

test.each([
  ["--last"], ["--all"], ["--worktree"], ["--profile", "private"], ["--config", "cwd=\"/tmp\""],
  ["--remote", "https://example.invalid"], ["initial prompt"], ["--model=private"],
  ["--cd", "/tmp"], ["--cd", "/tmp", "--cd", "/tmp"], ["--model"], ["--sandbox", "invented"],
].map(args => ({ args })))("rejects unsafe or unsupported private option vector %#", async ({ args }) => {
  // Given: private store and independently captured options agree, but grammar is unsafe.
  const f = await setup();
  writeFileSync(f.privatePath, JSON.stringify({ ...f.privateData, args }));
  writeFileSync(f.preflightPath, JSON.stringify({ ...f.preflight, optionsDigest: `sha256:${digest(JSON.stringify(args))}` }));
  // When: adapter parses private options.
  const result = f.adapter.exactResume(f.runtime);
  // Then: even matching hashes cannot authorize a selector, prompt, or cwd override.
  expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
});

test.each(["name", "prefix", "last"] as const)("rejects non UUID %s identity", async selector => {
  // Given: caller supplies an upstream-valid but non-exact selector.
  const f = await setup();
  const runtime: RuntimeIdentity = { ...f.runtime, binding: { ...f.runtime.binding,
    session: { ...f.runtime.binding.session, fullId: selector } } };
  // When: spec construction examines full identity.
  const result = f.adapter.exactResume(runtime);
  // Then: no fallback lookup.
  expect(result).toEqual({ ok: false, error: { code: "identity_mismatch" } });
});

test.each(["thread", "cwd", "hash", "options", "metadata", "malformed", "private"] as const)(
  "rejects conflicting or malformed authoritative %s without leaking private data", async part => {
    // Given: concrete saved data corruption, not a successful mocked loader.
    const f = await setup();
    switch (part) {
      case "thread": writeFileSync(f.sessionPath, JSON.stringify({ ...f.meta, payload: { ...f.meta.payload, id: "0199ad22-1388-7a11-8baa-222222222222" } })); break;
      case "cwd": writeFileSync(f.sessionPath, JSON.stringify({ ...f.meta, payload: { ...f.meta.payload, cwd: "/tmp" } })); break;
      case "hash": writeFileSync(f.privatePath, JSON.stringify({ ...f.privateData, sessionPath: f.manifest })); break;
      case "options": writeFileSync(f.preflightPath, JSON.stringify({ ...f.preflight, optionsDigest: "sha256:wrong" })); break;
      case "metadata": writeFileSync(f.sessionPath, JSON.stringify({ type: "response_item", payload: {} })); break;
      case "malformed": writeFileSync(f.sessionPath, "PRIVATE_SECRET_INVALID_JSON"); break;
      case "private": writeFileSync(f.privatePath, JSON.stringify({ args: true, sessionPath: f.sessionPath })); break;
    }
    // When: actual parser/loader verifies.
    const result = f.adapter.exactResume(f.runtime);
    // Then: public failure contains only an enum code.
    expect(result.ok).toBe(false);
    if (result.ok) throw new TypeError("unexpected_success");
    expect(Object.keys(result.error)).toEqual(["code"]);
    expect(JSON.stringify(result)).not.toContain(f.root);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET_INVALID_JSON");
  },
);

test.each(["registry", "missing-dist", "prerelease", "malformed"] as const)("does not report false check success for %s", async part => {
  // Given: real release evidence is malformed or disagrees.
  const f = await setup();
  const input = {
    github: { tag_name: "rust-v0.160.0", draft: false, prerelease: part === "prerelease" },
    npm: { "dist-tags": { latest: part === "registry" ? "0.159.0" : "0.160.0" },
      versions: { "0.160.0": { dist: part === "missing-dist" ? {} : { tarball: "url", integrity: "digest" } } } },
  };
  writeFileSync(f.releasePath, JSON.stringify(part === "malformed" ? [] : input));
  // When: bounded version probe completes then independent evidence is checked.
  const result = await f.adapter.check(f.installation);
  // Then: no up-to-date/update-ready success from exit zero alone.
  expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
  expect(existsSync(f.effectPath)).toBe(false);
});

test("does not interpret successful process exit with wrong stdout as a version", async () => {
  // Given: actual program exits zero but prints an invalid banner; newly pinned bytes.
  const f = await setup();
  writeFileSync(f.executable, `#!${process.execPath}\nconsole.log("success");\n`);
  const receipt = {
    family: "codex", executable: f.executable, channel: f.installation.channel, owner: f.installation.owner,
    packageManifest: f.manifest, resources: [
      { path: f.executable, sha256: digest(readFileSync(f.executable)) },
      { path: f.manifest, sha256: digest(readFileSync(f.manifest)) },
    ],
  };
  writeFileSync(f.receiptPath, JSON.stringify(receipt));
  f.pin.sha256 = digest(readFileSync(f.receiptPath));
  const detected = await f.adapter.detect(f.executable);
  if (!detected.ok) throw new TypeError(detected.error.code);
  // When: actual child exits zero.
  const result = await f.adapter.version(detected.value);
  // Then: parsed version still fails.
  expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
});

test("does not promote TurnComplete plus background work into bridge or stop", async () => {
  // Given: authoritative binding plus display-level event, one background terminal.
  const f = await setup();
  writeFileSync(f.preflightPath, JSON.stringify({ ...f.preflight, event: "TurnComplete", backgroundTerminals: 1, displayIdle: true }));
  // When: core specs are requested.
  const results = [f.adapter.bridge(f.runtime), f.adapter.gracefulExit(f.runtime, "operation-1", "owner-token-ref")];
  // Then: no qualified core producer exists; no root/tool/child fence is fabricated.
  expect(results).toEqual(Array(2).fill({ ok: false, error: { code: "unsupported" } }));
  expect(existsSync(f.callsPath)).toBe(false);
});

test("maps malformed private release JSON to typed failure without exposing parser input", async () => {
  // Given: authority reader actually throws from private malformed data.
  const f = await setup();
  writeFileSync(f.releasePath, "PRIVATE_RELEASE_SECRET_INVALID_JSON");
  // When: read-only check parses it after actual version observation.
  const result = await f.adapter.check(f.installation);
  // Then: no raw SyntaxError escapes the public boundary.
  expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
});

test("maps malformed provenance JSON to typed discovery failure", async () => {
  // Given: acquisition provenance was corrupted on disk.
  const f = await setup();
  writeFileSync(f.receiptPath, "PRIVATE_OWNER_SECRET_INVALID_JSON");
  // When: real canonical discovery reads it.
  const result = await f.adapter.detect(f.executable);
  // Then: no private parser input appears in the result.
  expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
});

test("preserves native no-daemon routing only with matching private options evidence", async () => {
  const f = await setup();
  const args = [...f.privateData.args, "--no-daemon"];
  writeFileSync(f.privatePath, JSON.stringify({ ...f.privateData, args }));
  // A different route must not inherit the prior option attestation.
  expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
  writeFileSync(f.preflightPath, JSON.stringify({ ...f.preflight,
    optionsDigest: `sha256:${digest(JSON.stringify(args))}` }));
  const result = f.adapter.exactResume(f.runtime);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.command.args).toEqual(["resume", threadId, ...args]);
  expect(existsSync(f.callsPath)).toBe(false);
});

test("qualified official parser accepts constructed local resume grammar without resuming", async () => {
  // Given: actual acquired task5 official binary, isolated fixture-only session.
  const f = await setup();
  const spec = f.adapter.exactResume(f.runtime);
  if (!spec.ok) throw new TypeError(spec.error.code);
  const binary = join(import.meta.dir, "../../.omo/evidence/herdr-cli-updater/task-5/families/codex/task-cache/extracted/codex-aarch64-apple-darwin");
  // When: --help triggers the real parser but never opens/resumes a conversation.
  const child = Bun.spawn([binary, ...spec.value.command.args, "--help"], {
    cwd: f.root, env: { HOME: f.root, CODEX_HOME: f.root, LANG: "C" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  // Then: actual parser acceptance, not successful identity/drain/resume evidence.
  expect(exit).toBe(0);
  expect(stdout.length).toBeGreaterThan(0);
  expect(stderr).not.toContain("error:");
  expect(existsSync(f.effectPath)).toBe(false);
});
