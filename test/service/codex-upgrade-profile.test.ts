import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { prepareCodexUpgradeProfile } from "../../src/service/restart-runtime";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
test.each(["valid", "settings", "payload", "binding"] as const)("Codex upgrade profile checks %s before publication", async defect => {
  // Given: controlled loader and wire peer, not genuine native qualification.
  const root = realpathSync(mkdtempSync("/tmp/codex-upgrade-"));
  const socket = join(root, "core.sock"), executable = join(root, "codex"), profiles = join(root, "profiles");
  mkdirSync(profiles, { mode: 0o700 });
  const options = { argv_sha256: "a".repeat(64), effective_settings_sha256: "b".repeat(64),
    model_sha256: "c".repeat(64), thinking_sha256: "d".repeat(64) };
  const environment = { HOME: root };
  const body = `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(defect === "settings" ? { ...options, model_sha256: "e".repeat(64) } : options)}'\n`;
  writeFileSync(executable, body, { mode: 0o700 });
  const session = join(root, "session.jsonl"), id = "12345678-1234-1234-1234-123456789abc";
  writeFileSync(session, "saved", { mode: 0o600 });
  const profile = { qualification: { kind: "native", family: "codex", source_revision: "f".repeat(64) },
    executable, entrypoint: null, args: ["resume", id], environment, options, cwd: root,
    session_path: session, full_session_id: id, bridge_sha256: "f".repeat(64),
    closure: [{ path: executable, sha256: "f".repeat(64) }] };
  const previous = join(profiles, "old.json");
  writeFileSync(previous, JSON.stringify(profile), { mode: 0o600 });
  const processIdentity = { pid: process.pid, parent_pid: process.ppid, uid: process.getuid?.() ?? 0,
    pgid: process.pid, tty: 1, start_seconds: 1, start_microseconds: 0, executable };
  const binding = { socket_epoch: "controlled", pane_id: "pane", terminal_id: "terminal", slot: "b".repeat(64),
    generation: 1, supervisor: { ...processIdentity, pid: process.ppid }, root: processIdentity,
    work_generation: 0, input_sequence: 0, launch_ref: "c".repeat(64), session: { full_id: id,
      storage_identity: hash(session), cwd: root, options_sha256: hash(JSON.stringify(options)),
      environment_sha256: hash(JSON.stringify(environment)) } };
  let inspections = 0;
  const server = createServer(peer => {
    let buffer = "";
    peer.on("data", bytes => {
      buffer += bytes.toString(); if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0] ?? "");
      const ping = request.method === "ping";
      if (!ping) inspections++;
      peer.end(JSON.stringify({ id: request.id, result: ping
        ? { type: "pong", version: "controlled-core", protocol: 1, schemaSha256: "a".repeat(64),
          capabilities: { updater_restart_v1: true, updater_restart_schema_sha256: "a".repeat(64) } }
        : { type: "updater_restart", snapshot: { binding: defect === "binding" && inspections > 1
          ? { ...binding, generation: 2 } : binding, receipt: null, owner_token: null,
          native_qualified: true, recovery_required: false, replay_ready: false } } }) + "\n");
    });
  });
  const listening = once(server, "listening"); server.listen(socket); await listening; chmodSync(socket, 0o600);
  try {
    // When
    const result = prepareCodexUpgradeProfile({ native: { coreSocket: socket, operationsPath: join(root, "operations.jsonl"),
      runtimeId: "codex", profile: "old", sessionPath: session, paneId: "pane", node: { path: executable, sha256: hash(body) } },
      previousProfile: { path: previous, sha256: hash(JSON.stringify(profile)) },
      executable: { path: executable, sha256: defect === "payload" ? "0".repeat(64) : hash(body) }, profile: "updated" });
    // Then
    if (defect === "valid") {
      const prepared = await result;
      expect(prepared.native.profile).toBe("updated");
      expect(JSON.parse(readFileSync(prepared.profile.path, "utf8"))).toEqual({ ...profile,
        qualification: { ...profile.qualification, source_revision: hash(body) }, bridge_sha256: hash(body),
        closure: [{ path: executable, sha256: hash(body) }] });
    } else {
      await expect(result).rejects.toThrow("verification_failed");
      expect(existsSync(join(profiles, "updated.json"))).toBe(false);
    }
    expect(readFileSync(previous, "utf8")).toBe(JSON.stringify(profile));
  } finally {
    const closed = once(server, "close"); server.close(); await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
