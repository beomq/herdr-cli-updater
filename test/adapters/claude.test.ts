import { afterEach, expect, test } from "bun:test";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createClaudeAdapter } from "../../src/adapters/claude";
import type { ClaudeCommandEvidence, ClaudeDependencies, ClaudeSavedSession } from "../../src/adapters/claude";
import { fixture, hash } from "../../.omo/evidence/herdr-cli-updater/task-12/fixture";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function owned(manager: "native" | "npm" | "bun" | "homebrew" = "native", output?: string) {
  const f = await fixture(manager, output);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) expect(await f.cleanup()).toBe(true);
});
function saved(f: Awaited<ReturnType<typeof fixture>>): ClaudeSavedSession {
  if (!f.session) throw new TypeError("missing fixture session");
  return f.session;
}
function updater(f: Awaited<ReturnType<typeof fixture>>): ClaudeCommandEvidence {
  return f.evidence(f.installation);
}

test.each(["native", "npm", "bun", "homebrew"] as const)(
  "%s fresh owner gets independently parsed exact update argv, never executes it", async manager => {
    const f = await owned(manager);
    expect(f.installation.owner.kind).toBe(manager === "native" ? "native" : "package");
    expect(f.installation.channel).toBe("latest");
    expect(await f.adapter.version(f.installation)).toEqual({ ok: true, value: { kind: "known", version: "2.1.287" } });
    const spec = f.adapter.updateSpec(f.installation, "update-only");
    expect(spec.ok).toBe(true);
    if (!spec.ok) throw new TypeError(spec.error.code);
    expect(spec.value.command).toEqual(updater(f).command);
    expect(spec.value.expectedInstallation).toEqual(f.installation);
    expect(spec.value.mutationResources).toEqual(f.installation.resources);
    expect(spec.value.command.executable).toBe(manager === "native" ? f.executable : f.managerExecutable);
    const check = await f.adapter.check(f.installation);
    expect(check.ok).toBe(true);
    if (!check.ok) throw new TypeError(check.error.code);
    expect(check.value.kind).toBe("update-available");
  },
);
test("numeric release comparison and equal version are based on pinned response bytes", async () => {
  const f = await owned();
  await writeFile(f.source, JSON.stringify({ channel: "latest", version: "2.1.287" }));
  const source = { path: f.source, sha256: hash(await readFile(f.source)) };
  const adapter = createClaudeAdapter({
    ...f.deps,
    release: installation => ({
      installation, source, version: body => {
        const row: unknown = JSON.parse(body);
        return typeof row === "object" && row !== null && "version" in row && typeof row.version === "string"
          ? row.version : null;
      },
    }),
  });
  await adapter.detect(f.executable);
  const check = await adapter.check(f.installation);
  expect(check.ok && check.value.kind).toBe("up-to-date");
  await writeFile(f.source, JSON.stringify({ channel: "latest", version: "99.0.0" }));
  expect(await adapter.check(f.installation)).toEqual({ ok: false, error: { code: "verification_failed" } });
});
test.each(["channel", "owner", "fingerprint", "family"] as const)("rejects dirty %s selection", async part => {
  const f = await owned("npm");
  const dirty = part === "channel" ? { ...f.installation, channel: "stable" }
    : part === "owner" ? { ...f.installation, owner: { kind: "package", manager: "bun", packageName: "@anthropic-ai/claude-code", prefix: f.root } as const }
      : part === "fingerprint" ? { ...f.installation, resourcesFingerprint: "other" }
        : { ...f.installation, family: "codex" as const };
  expect(f.adapter.updateSpec(dirty, "update-only")).toEqual({ ok: false, error: { code: "stale_selection" } });
  expect(await f.adapter.version(dirty)).toEqual({ ok: false, error: { code: "stale_selection" } });
});
test.each(["executable", "manifest", "ownership"] as const)("stale %s bytes block specs", async part => {
  const f = await owned("npm");
  const path = part === "executable" ? f.executable : part === "manifest" ? f.manifest : f.ownershipPath;
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(" ")]));
  expect(f.adapter.updateSpec(f.installation, "update-only")).toEqual({ ok: false, error: { code: "stale_selection" } });
  expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "stale_binding" } });
});
test("unknown owner is detection only; no capability is inferred", async () => {
  const f = await owned();
  const adapter = createClaudeAdapter({ ...f.deps, provenance: () => [] });
  const detected = await adapter.detect(f.executable);
  expect(detected.ok && detected.value.owner.kind).toBe("unknown");
  if (!detected.ok) throw new TypeError(detected.error.code);
  expect(adapter.updateSpec(detected.value, "update-only").ok).toBe(false);
  expect(await adapter.version(detected.value)).toEqual({ ok: false, error: { code: "stale_selection" } });
});
test("rejects foreign package identity despite coherent ownership digest", async () => {
  const f = await owned("npm");
  f.ownership.owner = { kind: "package", manager: "npm", packageName: "omo-ai", prefix: f.root };
  await writeFile(f.manifest, JSON.stringify({ name: "omo-ai", version: "2.1.287", bin: "bin/claude" }));
  const resource = f.ownership.resources.find(row => row.path === f.manifest);
  if (!resource) throw new TypeError("missing manifest");
  resource.sha256 = hash(await readFile(f.manifest));
  await f.repin();
  expect(await f.adapter.detect(f.executable)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
});
test.each(["unknown", "command", "parser", "manager", "environment", "floating", "target"] as const)(
  "unverified %s updater prerequisite cannot become ready", async part => {
    const f = await owned("npm");
    const e = updater(f);
    if (part === "unknown") f.setUpdate(null);
    else if (part === "command") f.setUpdate({ ...e, command: { ...e.command, args: ["update; touch sentinel"] } });
    else if (part === "parser") f.setUpdate({ ...e, parser: { ...e.parser, sha256: "0".repeat(64) } });
    else if (part === "manager") f.setUpdate({ ...e, installation: { ...e.installation, channel: "stable" } });
    else if (part === "environment") f.setUpdate({ ...e, privateContext: "required" });
    else if (part === "floating") f.setUpdate({ ...e, target: null });
    else f.setUpdate({ ...e, target: { version: "2.1.289", sha256: "b".repeat(64) } });
    expect(f.adapter.updateSpec(f.installation, "update-only").ok).toBe(false);
  },
);
test.each(["banner", "help", "stderr-like", "wrong-family", "trailing", "empty"] as const)(
  "misleading %s output cannot attest version", async kind => {
    const output = kind === "banner" ? "success\n2.1.287 (Claude Code)\n"
      : kind === "help" ? "Usage: claude --version\n"
        : kind === "stderr-like" ? "Warning: 2.1.287 (Claude Code)\n"
          : kind === "wrong-family" ? "2.1.287 (Codex)\n"
            : kind === "trailing" ? "2.1.287 (Claude Code)\nready\n" : "";
    const f = await owned("native", output);
    expect(await f.adapter.version(f.installation)).toEqual({ ok: false, error: { code: "verification_failed" } });
  },
);
test("explicit read-only authority is required, never probes operating PATH", async () => {
  const f = await owned();
  const adapter = createClaudeAdapter({ ...f.deps, probeExecutables: [] });
  await adapter.detect(f.executable);
  expect(await adapter.version(f.installation)).toEqual({ ok: false, error: { code: "unsupported" } });
});
test("exact resume resolves an opaque private record and preserves full identity/options/cwd", async () => {
  const f = await owned();
  const spec = f.adapter.exactResume(f.runtime);
  expect(spec).toEqual({
    ok: true, value: {
      command: { executable: f.executable, args: ["--resume", f.runtime.binding.session.fullId,
        "--model", "sonnet", "--permission-mode", "default"], cwd: f.root },
      expectedBinding: f.runtime.binding, optionsRef: "options-private",
    },
  });
  expect(f.storage.includes(f.runtime.binding.session.fullId)).toBe(false);
  expect(f.storage.includes(f.runtime.binding.session.storagePathHash)).toBe(false);
});
test.each(["absent", "deleted", "bytes", "symlink"] as const)("saved session %s cannot create fresh resume", async part => {
  const f = await owned();
  if (part === "absent") f.session = null;
  else if (part === "deleted") await rm(f.storage);
  else if (part === "bytes") await writeFile(f.storage, "{}");
  else {
    const aliasTarget = `${f.root}/other-record`;
    await writeFile(aliasTarget, await readFile(f.storage));
    await rm(f.storage); await symlink(aliasTarget, f.storage);
  }
  expect(f.adapter.exactResume(f.runtime).ok).toBe(false);
});
test.each(["fullId", "cwd", "options", "fingerprint", "epoch", "pid", "optionsRef", "pathHash"] as const)(
  "independent private identity blocks changed %s binding", async part => {
    const f = await owned();
    const b = f.runtime.binding;
    const binding = part === "fullId" ? { ...b, session: { ...b.session, fullId: "recent" } }
      : part === "cwd" ? { ...b, cwd: "/tmp" }
        : part === "fingerprint" ? { ...b, resourcesFingerprint: "other" }
          : part === "epoch" ? { ...b, socketEpoch: "new" }
            : part === "pid" ? { ...b, rootIncarnation: { ...b.rootIncarnation, pid: 999 } }
              : part === "optionsRef" ? { ...b, optionsRef: "unresolved" }
                : part === "pathHash" ? { ...b, session: { ...b.session, storagePathHash: "0".repeat(64) } } : b;
    if (part === "options") {
      const record = saved(f);
      f.session = { ...record, startupOptions: ["--model", "other"] };
    }
    expect(f.adapter.exactResume({ ...f.runtime, binding }).ok).toBe(false);
  },
);
test.each(["--continue", "--fork-session", "--settings", "--session-id", "--print", "--permission-mode"] as const)(
  "unsafe startup selector/options %s fail even in a coherent private record", async option => {
    const f = await owned();
    const record = saved(f);
    const options = [option, option === "--permission-mode" ? "default;touch" : "value"];
    await writeFile(f.storage, JSON.stringify({ fullId: f.runtime.binding.session.fullId, cwd: f.root, startupOptions: options }));
    f.session = {
      ...record, startupOptions: options,
      storage: { path: f.storage, sha256: hash(await readFile(f.storage)) },
      selector: { ...record.selector, command: { ...record.selector.command,
        args: ["--resume", f.runtime.binding.session.fullId, ...options] } },
    };
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "unsupported" } });
  },
);
test("saved bytes independently reject same binding with different stored identity/cwd", async () => {
  const f = await owned();
  const record = saved(f);
  await writeFile(f.storage, JSON.stringify({
    fullId: "00000000-0000-4000-8000-000000000099", cwd: "/tmp", startupOptions: record.startupOptions,
  }));
  f.session = { ...record, storage: { path: f.storage, sha256: hash(await readFile(f.storage)) } };
  expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
});
test("source-parser rejection is not replaced by help advertising resume", async () => {
  const f = await owned();
  const record = saved(f);
  f.session = { ...record, selector: { ...record.selector, command: { ...record.selector.command,
    args: ["--continue"] } } };
  expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "verification_failed" } });
});
test.each(["missing", "root-only", "unfenced", "generation", "binding", "operation", "owner"] as const)(
  "completion/graceful stop require full core attestation: %s", async part => {
    const f = await owned();
    const proof = f.core;
    if (!proof) throw new TypeError("missing core fixture");
    f.core = part === "missing" ? null : part === "root-only" ? { ...proof, allWorkDrained: false }
      : part === "unfenced" ? { ...proof, inputFenced: false }
        : part === "generation" ? { ...proof, workGeneration: 2 }
          : part === "binding" ? { ...proof, binding: { ...proof.binding, paneGeneration: 2 } }
            : part === "operation" ? { ...proof, operationId: "other" } : { ...proof, ownerTokenRef: "other" };
    if (part !== "operation" && part !== "owner") expect(f.adapter.bridge(f.runtime).ok).toBe(false);
    expect(f.adapter.gracefulExit(f.runtime, "stop-1", "owner-private").ok).toBe(false);
  },
);
test("verified fixture core produces specs only and exposes no private bytes", async () => {
  const f = await owned();
  expect(f.adapter.bridge(f.runtime)).toEqual({ ok: true, value: {
    kind: "core-attestation", evidenceRef: "fixture-core-only", expectedBinding: f.runtime.binding, workGeneration: 3,
  } });
  expect(f.adapter.gracefulExit(f.runtime, "stop-1", "owner-private")).toEqual({ ok: true, value: {
    kind: "core-stop", operationId: "stop-1", ownerTokenRef: "owner-private", expectedBinding: f.runtime.binding,
  } });
  const output = JSON.stringify([f.adapter.exactResume(f.runtime), f.adapter.bridge(f.runtime)]);
  expect(output.includes(f.storage)).toBe(false);
  expect(output.includes("inspect")).toBe(false);
  expect(output.includes("accepts")).toBe(false);
  const before = hash(await readFile(f.executable));
  f.adapter.updateSpec(f.installation, "update-and-restart");
  expect(hash(await readFile(f.executable))).toBe(before);
});

const privatePayloadKinds = ["error", "object", "string", "null"] as const;
type PrivatePayloadKind = typeof privatePayloadKinds[number];
function throwPrivate(kind: PrivatePayloadKind): never {
  const sentinel = "TASK12_PRIVATE_EXCEPTION_SENTINEL";
  switch (kind) {
    case "error": throw new Error(sentinel);
    case "object": throw { privateValue: sentinel };
    case "string": throw sentinel;
    case "null": throw null;
  }
}
const privatePaths = [
  "provenance", "session", "core", "stop-core", "update", "saved-inspector",
  "resume-parser", "update-parser", "release", "release-parser",
  "config-provenance", "config-cwd", "config-probes", "config-release",
  "config-session", "config-core", "runtime-binding", "proof-generation",
] as const;
for (const kind of privatePayloadKinds) {
  test.each(privatePaths.map((path): readonly [typeof path] => [path]))("private %s exception is code-only: " + kind, async path => {
    const f = await owned();
    const deps: ClaudeDependencies = { ...f.deps };
    const adapter = createClaudeAdapter(deps);
    const detected = await adapter.detect(f.executable);
    expect(detected.ok).toBe(true);
    const record = saved(f);
    const proof = f.core;
    if (!proof) throw new TypeError("missing fixture core");
    const reject = (): never => throwPrivate(kind);
    const runtime = { ...f.runtime };
    const trap = (target: object, key: string): void => {
      Object.defineProperty(target, key, { get: reject });
    };
    switch (path) {
      case "provenance": Object.defineProperty(deps, "provenance", { value: reject }); break;
      case "session": Object.defineProperty(deps, "session", { value: reject }); break;
      case "core":
      case "stop-core": Object.defineProperty(deps, "core", { value: reject }); break;
      case "update": Object.defineProperty(deps, "update", { value: reject }); break;
      case "saved-inspector": f.session = { ...record, inspect: reject }; break;
      case "resume-parser": f.session = { ...record, selector: { ...record.selector, accepts: reject } }; break;
      case "update-parser": f.setUpdate({ ...updater(f), accepts: reject }); break;
      case "release": Object.defineProperty(deps, "release", { value: reject }); break;
      case "release-parser": Object.defineProperty(deps, "release", { value: () => {
        const release = f.deps.release?.(f.installation);
        if (!release) throw new TypeError("missing fixture release");
        return { ...release, version: reject };
      } }); break;
      case "config-provenance": trap(deps, "provenance"); break;
      case "config-cwd": trap(deps, "cwd"); break;
      case "config-probes": trap(deps, "probeExecutables"); break;
      case "config-release": trap(deps, "release"); break;
      case "config-session": trap(deps, "session"); break;
      case "config-core": trap(deps, "core"); break;
      case "runtime-binding": trap(runtime, "binding"); break;
      case "proof-generation": {
        const guarded = { ...proof };
        trap(guarded, "workGeneration");
        f.core = guarded;
        break;
      }
    }
    // Capture escapes without formatting private thrown values into test output.
    async function invoke(): Promise<unknown> {
      try {
        switch (path) {
          case "provenance":
          case "config-provenance": return await adapter.detect(f.executable);
          case "release":
          case "release-parser":
          case "config-release": return await adapter.check(f.installation);
          case "config-cwd":
          case "config-probes": return await adapter.version(f.installation);
          case "core":
          case "config-core":
          case "proof-generation": return adapter.bridge(runtime);
          case "stop-core": return adapter.gracefulExit(runtime, "stop-1", "owner-private");
          case "update":
          case "update-parser": return adapter.updateSpec(f.installation, "update-only");
          case "session":
          case "saved-inspector":
          case "resume-parser":
          case "config-session":
          case "runtime-binding": return adapter.exactResume(runtime);
        }
      } catch { // Deliberately never inspect or print the synthetic private payload.
        return { escapedPrivateException: true, path, kind };
      }
    }
    const outcome = await invoke();
    expect(outcome).toEqual({ ok: false, error: { code: "verification_failed" } });
    expect(JSON.stringify(outcome).includes("TASK12_PRIVATE_EXCEPTION_SENTINEL")).toBe(false);
  });
}

test("private thrown payload properties are never inspected during normalization", async () => {
  const f = await owned();
  let reads = 0;
  const payload = new Error("TASK12_PRIVATE_EXCEPTION_SENTINEL");
  Object.defineProperty(payload, "code", { get: () => {
    reads++;
    throw "TASK12_PRIVATE_NESTED_SENTINEL";
  } });
  f.session = { ...saved(f), inspect: () => { throw payload; } };
  let result: unknown;
  try { result = f.adapter.exactResume(f.runtime); }
  catch { result = { escapedPrivateException: true }; }
  expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
  expect(reads).toBe(0);
});
