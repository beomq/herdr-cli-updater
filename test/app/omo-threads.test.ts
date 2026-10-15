import { expect, test } from "bun:test";
import { parseOmoThreads, omoActivity, readOmoState } from "../../src/app/omo-threads";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";

test("accepts only live TUI metadata and discards transcript and unrelated fields", () => {
  // Given
  const thread = { sessionId: "01a0fd29-2794-7e95-ab73-b7aecaa3750e", sessionPath: "/tmp/session.jsonl",
    socket: "/tmp/tui.sock", endpoint_kind: "tui", alive: true, name: "Title" } as const;
  // When
  const threads = parseOmoThreads(JSON.stringify([{ ...thread, messages: ["private"] },
    { ...thread, alive: false }, { ...thread, endpoint_kind: "rpc_host" }, { ...thread, sessionPath: "relative.jsonl" }]));
  // Then
  expect(threads).toEqual([thread]);
});

const state = { sessionId: "01a0fd29-2794-7e95-ab73-b7aecaa3750e", sessionFile: "/tmp/session.jsonl",
  isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0 };
test("missing background-work evidence never becomes idle", () => {
  expect(omoActivity(state)).toBe("unknown");
  expect(omoActivity({ ...state, hasSessionWork: false, hasActiveWakeSource: false })).toBe("idle");
  expect(omoActivity({ ...state, hasActiveWakeSource: true })).toBe("working");
  expect(omoActivity({ ...state, pendingMessageCount: 1 })).toBe("working");
  expect(omoActivity({ ...state, isStreaming: true })).toBe("working");
  expect(omoActivity({ ...state, editor_has_draft: true })).toBe("blocked");
});
test("reads authenticated socket state without exposing arbitrary response fields", async () => {
  // Given: real local socket, authenticated using the deployed 32-byte handshake.
  const directory = await mkdtemp("/tmp/omo-state-");
  const socket = `${directory}/t.sock`;
  const secret = Buffer.alloc(32, 7);
  await writeFile(`${socket}.secret`, secret);
  const server = createServer(client => {
    let buffer = Buffer.alloc(0);
    client.on("data", chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length < 32 || !buffer.subarray(32).includes(10)) return;
      expect(buffer.subarray(0, 32)).toEqual(secret);
      const request = JSON.parse(buffer.subarray(32).toString());
      expect(request.type).toBe("get_state");
      client.end(JSON.stringify({ id: request.id, success: true, data: { ...state, steering: ["private"] } }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  try {
    // When / Then
    expect(await readOmoState(socket)).toEqual(state);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
