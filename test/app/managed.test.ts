import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedSessions } from "../../src/app/managed";
import { AppError, type ManagedSession } from "../../src/app/types";
import type { Installation } from "../../src/protocol";

const installation: Installation = {
  installationId: "owned-fixture", family: "omo", channel: "stable",
  executableRealpath: join(import.meta.dir, "fixtures/managed-rpc.ts"), resourcesFingerprint: "fixture",
  resources: [], owner: { kind: "unknown", reason: "unverified_owner" },
  installedVersion: { kind: "known", version: "wrapper-3" }, lastCheck: null,
};
function setup(mode = "normal") {
  const directory = mkdtempSync(join(tmpdir(), "managed-rpc-test-"));
  const listeners = new Set<() => void>();
  const manager = createManagedSessions({ directory, env: { FIXTURE_MODE: mode },
    onChange: () => { for (const listener of listeners) listener(); } });
  function observe(predicate: (session: ManagedSession) => boolean): Promise<ManagedSession> {
    const result = Promise.withResolvers<ManagedSession>();
    const timer = setTimeout(() => { listeners.delete(check); result.reject(new AppError("timeout")); }, 2000);
    const check = () => {
      const found = manager.list().find(predicate);
      if (found) { clearTimeout(timer); listeners.delete(check); result.resolve(found); }
    };
    listeners.add(check);
    check();
    return result.promise;
  }
  return { directory, manager, observe, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
async function code(promise: Promise<unknown>, expected: AppError["code"]) {
  try { await promise; throw new Error("expected_rejection"); }
  catch (error) { expect(error).toBeInstanceOf(AppError); if (error instanceof AppError) expect(error.code).toBe(expected); }
}

test("resumes durable identity in a new owned host and rejects stale generations", async () => {
  // Given: a real JSONL subprocess with distinct wrapper and engine versions.
  const f = setup("duplicate");
  try {
    const first = await f.manager.launch(installation, f.directory);
    // When: a quiet session restarts.
    const second = await f.manager.restart(first.id, first.generation, installation);
    // Then: durable identity survives, routing/host ownership and generation do not.
    expect(second.durableSessionId).toBe(first.durableSessionId);
    expect(second.pid).not.toBe(first.pid);
    expect(second.generation).toBe(2);
    expect(second.launchedVersion).toBe("wrapper-3");
    expect(second.engineVersion).toBe("engine-7");
    await code(f.manager.send(first.id, first.generation, "stale"), "conflict");
    await f.manager.close();
    expect(f.manager.list()[0]?.state).toBe("stopped");
  } finally { f.cleanup(); }
});

test("busy stop and close leave work alive while sealed admission allows deliberate approval", async () => {
  // Given: subscribe before triggering a prompt with a pending approval.
  const f = setup();
  try {
    const first = await f.manager.launch(installation, f.directory);
    const waiting = f.observe(s => s.state === "waiting");
    await f.manager.send(first.id, 1, "private-user-message");
    await waiting;
    // When: stop attempts atomic quiet release while the work is active.
    await code(f.manager.stop(first.id, 1), "busy");
    await code(f.manager.stop(first.id, 1), "busy");
    await code(f.manager.close(), "busy");
    f.manager.setAdmission(first.installationId, false);
    // Then: admission is sealed, but the active request can still be explicitly approved.
    expect(f.manager.list()[0]?.pid).toBe(first.pid);
    await code(f.manager.send(first.id, 1, "new-message"), "busy");
    await code(f.manager.launch(installation, f.directory), "busy");
    await code(f.manager.respond(first.id, 1, "wrong-id", true), "conflict");
    const quiet = f.observe(s => s.state === "ready");
    await f.manager.respond(first.id, 1, "approval-1", false);
    await quiet;
    await f.manager.stop(first.id, 1);
    const metadata = readdirSync(f.directory).find(name => name.endsWith(".metadata.json"));
    if (!metadata) throw new Error("missing_metadata");
    const stored = readFileSync(join(f.directory, metadata), "utf8");
    expect(stored).not.toContain("private-user-message");
    expect(stored).not.toContain("approval-1");
    await f.manager.close();
  } finally { f.cleanup(); }
});

test("refuses unsupported protocol before opening and tears down the empty child", async () => {
  // Given: a public RPC host with a newer unsupported protocol.
  const f = setup("unsupported");
  try {
    // When: startup negotiates capabilities.
    await code(f.manager.launch(installation, f.directory), "unsupported");
    // Then: no conversation is opened, and the owned process actually exited.
    expect(f.manager.list()[0]?.state).toBe("failed");
    expect(f.manager.list()[0]?.pid).toBeNull();
    expect(readdirSync(f.directory).filter(name => name.endsWith(".jsonl"))).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("lost effect response remains unknown without an automatic duplicate launch", async () => {
  // Given: a fixture that exits after accepting prompt input, before acknowledging it.
  const f = setup("lost");
  try {
    const first = await f.manager.launch(installation, f.directory);
    const unknown = f.observe(s => s.state === "unknown");
    // When: the acknowledged-effect boundary is lost.
    await code(f.manager.send(first.id, 1, "do-work"), "uncertain");
    await unknown;
    // Then: restart and close do not pretend that stopping was verified.
    await code(f.manager.restart(first.id, 1, installation), "uncertain");
    await code(f.manager.close(), "uncertain");
    expect(f.manager.list()).toHaveLength(1);
    const recovered = createManagedSessions({ directory: f.directory, onChange: () => {} });
    expect(recovered.list()[0]?.state).toBe("unknown");
    expect(recovered.list()[0]?.pid).toBeNull();
    await code(recovered.stop(first.id, 1), "uncertain");
  } finally { f.cleanup(); }
});

test("recovers only verified stopped metadata and resumes the same identity deliberately", async () => {
  // Given: a released, exited session persisted without a live child handle.
  const f = setup();
  try {
    const first = await f.manager.launch(installation, f.directory);
    await f.manager.stop(first.id, 1);
    const recovered = createManagedSessions({ directory: f.directory, onChange: () => {} });
    // When: explicit restart opens the saved path on a fresh process.
    const resumed = await recovered.restart(first.id, 1, installation);
    // Then: saved PIDs were never adopted, and durable identity was verified.
    expect(resumed.durableSessionId).toBe(first.durableSessionId);
    expect(resumed.generation).toBe(2);
    await recovered.close();
    await f.manager.close();
  } finally { f.cleanup(); }
});

test("rejects a response from a different routing handle as an uncertain effect", async () => {
  // Given: the subprocess echoes a valid request id under a foreign session handle.
  const f = setup("mismatch");
  try {
    const first = await f.manager.launch(installation, f.directory);
    // When: a deliberate input receives mismatched identity evidence.
    await code(f.manager.send(first.id, 1, "input"), "uncertain");
    // Then: the matching request id alone cannot authorize success or resume.
    expect(f.manager.list()[0]?.state).toBe("unknown");
    await code(f.manager.restart(first.id, 1, installation), "uncertain");
  } finally { f.cleanup(); }
});

test("admits only one concurrent restart for a recorded generation", async () => {
  // Given: one quiet session and two commands referencing the same generation.
  const f = setup();
  try {
    const first = await f.manager.launch(installation, f.directory);
    // When: restart overlaps another restart before child exit.
    const restarting = f.manager.restart(first.id, 1, installation);
    await code(f.manager.restart(first.id, 1, installation), "busy");
    await code(f.manager.launch(installation, f.directory), "busy");
    const result = await restarting;
    // Then: precisely one fresh host is launched for the next generation.
    expect(result.generation).toBe(2);
    expect(f.manager.list()).toHaveLength(1);
    await f.manager.close();
  } finally { f.cleanup(); }
});

test("duplicate prompt replies cannot consume a deliberate approval response", async () => {
  // Given: duplicated responses cross the same real JSONL stream.
  const f = setup("duplicate");
  try {
    const first = await f.manager.launch(installation, f.directory);
    const waiting = f.observe(s => s.state === "waiting");
    await f.manager.send(first.id, 1, "input");
    await waiting;
    const quiet = f.observe(s => s.state === "ready");
    // When: approval uses its own correlation id and the dialog's uiRequestId.
    await f.manager.respond(first.id, 1, "approval-1", true);
    await quiet;
    // Then: late duplicates cannot approve the dialog twice.
    await code(f.manager.respond(first.id, 1, "approval-1", true), "conflict");
    await f.manager.close();
  } finally { f.cleanup(); }
});

test("a release response with a foreign route cannot become verified shutdown", async () => {
  const f = setup("release-route");
  try {
    const first = await f.manager.launch(installation, f.directory);
    await code(f.manager.stop(first.id, 1), "uncertain");
    expect(f.manager.list()[0]?.state).toBe("unknown");
    await code(f.manager.restart(first.id, 1, installation), "uncertain");
    expect(f.manager.list()).toHaveLength(1);
  } finally { f.cleanup(); }
});
