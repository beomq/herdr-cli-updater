import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHerdrPaneClient } from "../../src/app/herdr-panes";

type Handler = (method: string, params: Record<string, unknown>) => unknown;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function fakeHerdr(handler: Handler): Promise<{ socketPath: string; calls: { method: string; params: Record<string, unknown> }[] }> {
  const root = mkdtempSync("/tmp/hp-");
  const socketPath = join(root, "herdr.sock");
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      const request = JSON.parse(buffer.slice(0, boundary)) as { id: string; method: string; params: Record<string, unknown> };
      calls.push({ method: request.method, params: request.params });
      const result = handler(request.method, request.params);
      const reply = result instanceof Error ? { id: request.id, error: { code: result.message, message: result.message } } : { id: request.id, result };
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanups.push(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
  return { socketPath, calls };
}
const agentRow = (paneId: string, status: string, extra: Record<string, unknown> = {}) => ({
  pane_id: paneId, workspace_id: paneId.split(":")[0], terminal_id: `term_${paneId}`, agent: "pi",
  agent_status: status, state_change_seq: 7, cwd: "/work/project", title: "task", ...extra,
});

test("agents() joins agent.list rows with each pane's foreground PIDs", async () => {
  // Given
  const { socketPath, calls } = await fakeHerdr((method, params) => {
    if (method === "agent.list") return { type: "agent_list", agents: [agentRow("w1:p1", "idle"), agentRow("w1:p2", "working"), { bogus: true }] };
    if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: params["pane_id"],
      foreground_processes: [{ pid: params["pane_id"] === "w1:p1" ? 101 : 202, argv: ["bun", "cli.js"] }] } };
    return new Error("invalid_request");
  });
  // When
  const agents = await createHerdrPaneClient(socketPath).agents();
  // Then
  expect(agents.map(row => [row.paneId, row.status, [...row.foregroundPids]])).toEqual([["w1:p1", "idle", [101]], ["w1:p2", "working", [202]]]);
  expect(calls.map(row => row.method)).toEqual(["agent.list", "pane.process_info", "pane.process_info"]);
});

test("sendLine sends text then Enter, and refuses multi-line input before touching the pane", async () => {
  const { socketPath, calls } = await fakeHerdr(() => ({ type: "ok" }));
  const client = createHerdrPaneClient(socketPath);
  await client.sendLine("w1:p1", "/exit");
  expect(calls).toEqual([{ method: "pane.send_text", params: { pane_id: "w1:p1", text: "/exit" } },
    { method: "pane.send_keys", params: { pane_id: "w1:p1", keys: ["Enter"] } }]);
  await expect(client.sendLine("w1:p1", "a\nb")).rejects.toMatchObject({ detail: "herdr_multiline_input" });
  expect(calls).toHaveLength(2);
});

test("wait returns null on timeout or missing agent and the parsed agent on success", async () => {
  let mode: "timeout" | "missing" | "ok" = "timeout";
  const { socketPath } = await fakeHerdr((method, params) => {
    if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: params["pane_id"], foreground_processes: [{ pid: 9 }] } };
    if (method !== "agent.wait") return new Error("invalid_request");
    if (mode === "timeout") return new Error("timeout");
    if (mode === "missing") return new Error("agent_not_found");
    return { type: "agent", agent: agentRow("w1:p1", "idle") };
  });
  const client = createHerdrPaneClient(socketPath);
  expect(await client.wait("w1:p1", ["idle", "done"], 100)).toBeNull();
  mode = "missing";
  expect(await client.wait("w1:p1", ["idle", "done"], 100)).toBeNull();
  mode = "ok";
  expect(await client.wait("w1:p1", ["idle", "done"], 100)).toMatchObject({ paneId: "w1:p1", status: "idle", foregroundPids: [9] });
});

test("other server errors and a closed socket surface as unavailable", async () => {
  const { socketPath } = await fakeHerdr(() => new Error("unauthorized"));
  await expect(createHerdrPaneClient(socketPath).agents()).rejects.toMatchObject({ code: "unavailable", detail: "herdr_unauthorized" });
  await expect(createHerdrPaneClient(join(socketPath, "..", "missing.sock")).agents()).rejects.toMatchObject({ code: "unavailable" });
});
