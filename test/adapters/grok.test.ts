import { afterEach, expect, test } from "bun:test";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, hash, PRIVATE_SENTINEL } from "../../.omo/evidence/herdr-cli-updater/task-16/fixture";
import { createGrokAdapter } from "../../src/adapters/grok";
import type { GrokConfiguration } from "../../src/adapters/grok";
import type { AdapterResult } from "../../src/adapters/types";
import type { FailureCode } from "../../src/protocol";

const owned: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of owned.splice(0)) await f.cleanup(); });
async function setup(owner: "native" | "npm" = "native") {
  const f = await fixture(createGrokAdapter, owner); owned.push(f);
  expect(await f.adapter.detect(f.binary)).toEqual({ ok: true, value: f.installation });
  return f;
}
const failure = (code: FailureCode) => ({ ok: false as const, error: { code } });
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new TypeError("fixture_record");
  return Object.fromEntries(Object.entries(value));
}

test.each(["native", "npm"] as const)("canonical %s owner and agent alias share identity without invocation", async owner => {
  const f = await setup(owner), before = await readFile(f.binary);
  expect(await f.adapter.detect(f.alias)).toEqual({ ok: true, value: f.installation });
  expect(await f.adapter.version(f.installation)).toEqual({ ok: true, value: { kind: "known", version: "1.0.46" } });
  expect(await f.adapter.check(f.installation)).toEqual({ ok: true, value: {
    kind: "update-available", installedVersion: "1.0.46", availableVersion: "1.0.48", checkedAt: 42,
  } });
  expect(await readFile(f.binary)).toEqual(before);
});
test("exact saved UUID spec preserves leader binding cwd and options without writes", async () => {
  const f = await setup(), before = await readFile(f.storagePath);
  const result = f.adapter.exactResume(f.runtime);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new TypeError(result.error.code);
  const commandFields: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(result.value.command));
  expect(commandFields).toEqual({
    executable: f.binary, args: ["--resume", f.saved.fullId], cwd: f.cwd, shell: false,
  });
  expect(result.value.expectedBinding).toEqual(f.runtime.binding);
  expect(result.value.optionsRef).toBe("private-options");
  expect(await readFile(f.storagePath)).toEqual(before);
});
test.each(["unknown", "ambiguous", "cursor", "channel", "manager"] as const)("rejects %s ownership despite familiar alias", async kind => {
  const f = await setup();
  if (kind === "ambiguous") f.state.installation = null;
  else f.state.installation = { ...f.installation,
    ...(kind === "cursor" ? { family: "cursor" as const } : {}),
    ...(kind === "channel" ? { channel: "unknown" } : {}),
    owner: kind === "manager" ? { kind: "package", manager: "bun", packageName: "@xai-official/grok", prefix: f.root }
      : kind === "unknown" ? { kind: "unknown", reason: "unverified_owner" } : f.installation.owner };
  expect((await f.adapter.detect(f.alias)).ok).toBe(false);
});
test.each(["version", "fingerprint", "missing"] as const)("requires independent %s version receipt", async part => {
  const f = await setup();
  f.state.version = part === "missing" ? null : { ...record(f.state.version),
    ...(part === "version" ? { version: "99.0.0" } : { executableFingerprint: "forged" }) };
  expect(await f.adapter.version(f.installation)).toEqual(failure("receipt_uncertain"));
});
test.each(["channel", "fingerprint", "missing", "downgrade", "prose"] as const)("rejects misleading %s release facts", async part => {
  const f = await setup();
  f.state.release = part === "missing" ? null : { ...record(f.state.release),
    ...(part === "channel" ? { channel: "alpha" } : part === "fingerprint" ? { resourcesFingerprint: "forged" }
      : { version: part === "downgrade" ? "1.0.45" : "success latest" }) };
  expect((await f.adapter.check(f.installation)).ok).toBe(false);
});
test("check recognizes an equal version without calling update --check", async () => {
  const f = await setup();
  f.state.release = { ...record(f.state.release), version: "1.0.46" };
  expect(await f.adapter.check(f.installation)).toEqual({ ok: true, value: { kind: "up-to-date", installedVersion: "1.0.46", checkedAt: 42 } });
});
test.each(["bytes", "selection", "binding", "private-options"] as const)("rejects stale %s state", async part => {
  const f = await setup();
  if (part === "bytes") await writeFile(f.binary, "external writer");
  if (part === "selection") f.state.installation = { ...f.installation, channel: "alpha" };
  if (part === "binding") f.state.live = { ...record(f.state.live), runtime: { ...f.runtime, binding: { ...f.runtime.binding, socketEpoch: "new" } } };
  if (part === "private-options") f.state.stored = { ...record(f.state.stored), optionsRef: "new" };
  const result = f.adapter.exactResume(f.runtime);
  expect(result).toEqual(failure(part === "bytes" ? "external_writer" : part === "selection" ? "stale_selection"
    : part === "binding" ? "stale_binding" : "identity_mismatch"));
});
test.each(["prefix", "title", "empty"] as const)("rejects %s resume selector", async part => {
  const f = await setup();
  const runtime = { ...f.runtime, binding: { ...f.runtime.binding,
    session: { ...f.runtime.binding.session, fullId: part === "prefix" ? "12345678" : part === "title" ? "recent session" : "" } } };
  f.state.live = { ...record(f.state.live), runtime };
  expect(f.adapter.exactResume(runtime).ok).toBe(false);
});
test.each(["path", "store", "parser", "decoder", "child", "cwd", "hash", "digest"] as const)("fails closed for %s saved session evidence", async part => {
  const f = await setup();
  if (part === "path") await rm(f.storagePath);
  if (part === "store") f.state.stored = null;
  if (part === "parser") f.state.parser = null;
  if (part === "decoder") f.config.decodeSavedSession = () => null;
  if (part === "child" || part === "cwd") {
    await writeFile(f.storagePath, JSON.stringify({ ...f.saved,
      ...(part === "child" ? { resolvedId: "aaaaaaaa-1234-4234-8234-123456789abc" } : { cwd: f.root }) }));
    const storageSha256 = hash(await readFile(f.storagePath));
    f.state.stored = { ...record(f.state.stored), storageSha256 };
    f.state.live = { ...record(f.state.live), storageSha256 };
  }
  if (part === "hash") {
    const runtime = { ...f.runtime, binding: { ...f.runtime.binding,
      session: { ...f.runtime.binding.session, storagePathHash: hash("guessed") } } };
    f.state.live = { ...record(f.state.live), runtime };
    expect(f.adapter.exactResume(runtime)).toEqual(failure("identity_mismatch")); return;
  }
  if (part === "digest") f.state.live = { ...record(f.state.live), storageSha256: "forged" };
  expect(f.adapter.exactResume(f.runtime).ok).toBe(false);
});
test.each(["--continue", "--fork-session", "--session-id", "--worktree", "--dangerously-skip-permissions", "secret"])(
  "never replays unqualified option %s", async arg => {
    const f = await setup();
    f.state.stored = { ...record(f.state.stored), args: [arg] };
    f.state.live = { ...record(f.state.live), optionsSha256: hash(JSON.stringify([arg])) };
    const result = f.adapter.exactResume(f.runtime);
    expect(result).toEqual(failure("receipt_uncertain"));
    expect(JSON.stringify(result)).not.toContain(arg);
  });
test("rejects symlink substitution and decoder-time session mutation", async () => {
  const f = await setup();
  const alias = join(f.storageRoot, "alias"); await symlink(f.storagePath, alias);
  f.state.stored = { ...record(f.state.stored), storagePath: alias };
  expect(f.adapter.exactResume(f.runtime)).toEqual(failure("identity_mismatch"));
  f.state.stored = { ...record(f.state.stored), storagePath: f.storagePath };
  f.config.decodeSavedSession = body => {
    f.state.live = { ...record(f.state.live), optionsSha256: "changed" };
    return JSON.parse(Buffer.from(body).toString());
  };
  expect(f.adapter.exactResume(f.runtime)).toEqual(failure("stale_binding"));
});
test("false idle forged drain and relaunch acknowledgment never enable core effects", async () => {
  const f = await setup();
  f.state.live = { ...record(f.state.live), displayIdle: true, allWork: true, kind: "core-attestation",
    root: 0, tools: 0, subagents: 0, background: 0, monitors: 0, relaunching: true };
  expect(f.adapter.bridge(f.runtime)).toEqual(failure("receipt_uncertain"));
  expect(f.adapter.gracefulExit(f.runtime, "operation", "owner")).toEqual(failure("receipt_uncertain"));
  expect(f.adapter.gracefulExit(f.runtime, "", "owner")).toEqual(failure("malformed_request"));
});
test.each(["native", "npm"] as const)("known %s owner does not authorize floating unsafe updates", async owner => {
  const f = await setup(owner), before = await readFile(f.binary);
  expect(f.adapter.updateSpec(f.installation, "update-only")).toEqual(failure("receipt_uncertain"));
  expect(f.adapter.updateSpec(f.installation, "update-and-restart")).toEqual(failure("receipt_uncertain"));
  expect(await readFile(f.binary)).toEqual(before);
});

type Method = "detect" | "version" | "check" | "exactResume" | "updateSpec" | "bridge" | "gracefulExit";
const callbackMethods = [
  ["installation", "detect"], ["installation", "version"], ["installation", "check"],
  ["installation", "exactResume"], ["installation", "updateSpec"], ["installation", "bridge"], ["installation", "gracefulExit"],
  ["versionReceipt", "detect"], ["versionReceipt", "version"], ["versionReceipt", "check"], ["versionReceipt", "exactResume"],
  ["release", "check"], ["parserReceipt", "exactResume"], ["privateRuntime", "exactResume"], ["decodeSavedSession", "exactResume"],
  ["preflight", "exactResume"], ["preflight", "bridge"], ["preflight", "gracefulExit"], ["now", "check"],
] as const satisfies readonly (readonly [keyof GrokConfiguration, Method])[];
const exceptionKinds = ["Error", "object", "string", "null", "revokedProxy", "poisonCodeGetter", "poisonPrototype", "coercionTrap", "fakeENOENT"] as const;
async function invoke(f: Awaited<ReturnType<typeof fixture>>, method: Method): Promise<AdapterResult<unknown>> {
  switch (method) {
    case "detect": return f.adapter.detect(f.binary);
    case "version": return f.adapter.version(f.installation);
    case "check": return f.adapter.check(f.installation);
    case "updateSpec": return f.adapter.updateSpec(f.installation, "update-only");
    case "gracefulExit": return f.adapter.gracefulExit(f.runtime, "operation", "owner");
    case "exactResume": return f.adapter.exactResume(f.runtime);
    case "bridge": return f.adapter.bridge(f.runtime);
  }
}
test.each(callbackMethods.flatMap(([callback, method]) => exceptionKinds.map(kind => [callback, method, kind] as const)))(
  "%s thrown %s %s is enum-only without exception inspection", async (callback, method, kind) => {
    // Given: real owned resources, then a private callback throws an opaque value.
    const f = await setup();
    let inspectionCalls = 0, coercionCalls = 0;
    let thrown: unknown;
    switch (kind) {
      case "Error": thrown = new Error(PRIVATE_SENTINEL); break;
      case "object": thrown = { private: PRIVATE_SENTINEL }; break;
      case "string": thrown = PRIVATE_SENTINEL; break;
      case "null": thrown = null; break;
      case "fakeENOENT": thrown = Object.assign(new Error(PRIVATE_SENTINEL), { code: "ENOENT" }); break;
      case "revokedProxy": {
        const pair = Proxy.revocable({}, {}); pair.revoke(); thrown = pair.proxy; break;
      }
      case "poisonCodeGetter": {
        thrown = Object.defineProperty(new Error(PRIVATE_SENTINEL), "code", {
          get() { inspectionCalls++; throw PRIVATE_SENTINEL; },
        }); break;
      }
      case "poisonPrototype": thrown = new Proxy({}, {
        getPrototypeOf() { inspectionCalls++; throw PRIVATE_SENTINEL; },
      }); break;
      case "coercionTrap": thrown = {
        [Symbol.toPrimitive]() { coercionCalls++; throw PRIVATE_SENTINEL; },
      }; break;
    }
    f.config[callback] = () => { throw thrown; };
    // When: each public method crosses its actual callback and filesystem path.
    const result = await invoke(f, method);
    // Then: exact safe result, no rejected promise/throw, getter or coercion.
    expect(result).toEqual(failure("verification_failed"));
    expect(inspectionCalls).toBe(0);
    expect(coercionCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_SENTINEL);
  });

test.each(["versionReceipt", "release", "parserReceipt", "privateRuntime", "preflight", "decodeSavedSession"] as const)(
  "returned poisoned %s metadata cannot escape", async callback => {
    const f = await setup();
    const property = callback === "preflight" ? "runtime" : callback === "decodeSavedSession" ? "fullId"
      : callback === "parserReceipt" ? "sourceRef" : "evidenceRef";
    f.config[callback] = () => Object.defineProperty({}, property, {
      enumerable: true, get() { throw PRIVATE_SENTINEL; },
    });
    const result = await invoke(f, callback === "release" ? "check" : callback === "versionReceipt" ? "version" : "exactResume");
    expect(result).toEqual(failure("verification_failed"));
  });
test("actual missing executable stays not_found without callback classification", async () => {
  const f = await setup();
  expect(await f.adapter.detect(join(f.root, "absent"))).toEqual(failure("not_found"));
});
test("actual missing saved file stays missing_session", async () => {
  const f = await setup();
  await rm(f.storagePath);
  expect(f.adapter.exactResume(f.runtime)).toEqual(failure("missing_session"));
});
test("manual stdout excludes private sentinels spec and binding", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", ".omo/evidence/herdr-cli-updater/task-16/verify.ts"], {
    cwd: new URL("../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exit).toBe(0);
  expect(stderr.length).toBe(0);
  for (const privateValue of [PRIVATE_SENTINEL, "/Users/", "12345678-1234-4234-8234-123456789abc", JSON.stringify("private-options")])
    expect(stdout.includes(privateValue)).toBe(false);
  const documents: unknown[] = stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(documents.length).toBe(6);
  const manual = record(documents[0]);
  expect(Object.keys(manual).sort()).toEqual([
    "bindingVerified", "childPIDCount", "effects", "identityVerified", "manual",
    "optionsVerified", "shellFalse", "specSha256", "uuidVerified",
  ].sort());
  expect(manual["manual"]).toBe("PASS");
  expect(record(documents[5])).toEqual({ cleanup: "PASS", ownedRootsRemaining: 0, childPIDCount: 0, effects: 0 });
});
