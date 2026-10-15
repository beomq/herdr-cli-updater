import { expect, test } from "bun:test";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { FenceClient, parseFence } from "../../src/core/fence";
import type { FenceSnapshot } from "../../src/core/fence";

function snapshot(): FenceSnapshot {
  return {
    restart_claimed: false,
    completion: {
      binding: { socket_id: "/tmp/core.sock", socket_epoch: "epoch", pane_id: "w1:p1",
        pane_incarnation: "term:42", root_pid: 42, root_start_identity: null, root_executable: null,
        session: null, cwd: "/tmp", options_ref: null },
      family: "omo", generation: 1, sequence: 2,
      required_producers: ["root", "tool", "subagent", "background", "monitor", "continuation"],
      connected_producers: [],
      missing_producers: ["root", "tool", "subagent", "background", "monitor", "continuation"],
      producers: [], runtime_source: "app.terminal_runtimes+PaneDied", producer_work_complete: false,
      admission_locked: true, lease_valid: true, runtime_alive: true, all_work_drained: false, input_fenced: false,
    },
    input: { phase: "held", queue_id: "queue-test", accepted_sequence: 3, cutoff_sequence: 2,
      queued_bytes: 3, journal_bytes: 1024, rejected: 0, pending_starts: 0,
      entries: [{ sequence: 3, kind: "data", bytes: 3, sha256: "a".repeat(64) }],
      physical_barrier: true, consuming_ack: false, replay_ready: false },
  };
}

test("physical barrier and durable queue never imply native claim or consumption", () => {
  const result = parseFence(snapshot(), "omo");
  expect(result.input.entries.map(e => e.sequence)).toEqual([3]);
  expect(result.input.physical_barrier).toBe(true);
  expect(result.input.consuming_ack).toBe(false);
  expect(result.restart_claimed).toBe(false);
});

for (const [name, change] of [
  ["phase array", { phase: ["held"] }],
  ["kind array", { entries: [{ ...snapshot().input.entries[0], kind: ["data"] }] }],
  ["digest array", { entries: [{ ...snapshot().input.entries[0], sha256: ["a".repeat(64)] }] }],
  ["missing row", { entries: [] }],
  ["reordered row", { entries: [{ ...snapshot().input.entries[0], sequence: 2 }] }],
  ["partial bytes", { queued_bytes: 4 }],
  ["native ack forgery", { consuming_ack: true }],
  ["replay forgery", { replay_ready: true }],
  ["pending spawn with barrier", { pending_starts: 1 }],
  ["barrier without hold", { phase: "open" }],
  ["missing journal", { queue_id: null }],
  ["open with retained journal", { phase: "open", physical_barrier: false }],
  ["held without durable header", { journal_bytes: 0 }],
  ["unsafe sequence", { accepted_sequence: Number.MAX_SAFE_INTEGER + 1 }],
] as const) {
  test(`rejects ${name}`, () => {
    expect(() => parseFence({ ...snapshot(), input: { ...snapshot().input, ...change } }, "omo")).toThrow();
  });
}

test("rejects claimed restart without native enrollment", () => {
  expect(() => parseFence({ ...snapshot(), restart_claimed: true }, "omo")).toThrow();
});

test("rejects a held actor with reopened work admission", () => {
  expect(() => parseFence({ ...snapshot(), completion: { ...snapshot().completion, admission_locked: false } }, "omo")).toThrow("partial_fence");
});

async function withPeer(
  response: (method: string, index: number, initial: FenceSnapshot) => unknown,
  exercise: (client: FenceClient, methods: string[]) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp("/tmp/fence-");
  const path = join(root, "core.sock"), methods: string[] = [];
  const fixture = snapshot();
  const initial: FenceSnapshot = {
    ...fixture, completion: { ...fixture.completion, binding: { ...fixture.completion.binding, socket_id: path } },
  };
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", data => {
      input += data;
      if (!input.includes("\n")) return;
      const request: unknown = JSON.parse(input.trim());
      if (typeof request !== "object" || request === null || !("method" in request)
        || !("id" in request) || typeof request.method !== "string") {
        socket.destroy(); return;
      }
      methods.push(request.method);
      socket.end(`${JSON.stringify({ id: request.id, result: response(request.method, methods.length, initial) })}\n`);
    });
  });
  const listening = once(server, "listening");
  server.listen(path);
  await listening;
  await chmod(path, 0o600);
  try { await exercise(new FenceClient(path, initial.completion, "owner"), methods); }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true });
  }
}

test("old core is not sent a fence method without negotiation", async () => {
  await withPeer(() => ({ type: "pong", capabilities: {} }), async (client, methods) => {
    await expect(client.request("prepare")).rejects.toThrow("unsupported");
    expect(methods).toEqual(["ping"]);
  });
});

for (const field of ["socket_epoch", "pane_incarnation", "root_pid"] as const) {
  test(`client rejects replaced ${field} on the same socket`, async () => {
    await withPeer((method, index, initial) => method === "ping"
      ? { type: "pong", capabilities: { updater_fence_v1: true } }
      : { type: "updater_fence", snapshot: index <= 2 ? initial : {
        ...initial, completion: { ...initial.completion, binding: {
          ...initial.completion.binding, [field]: field === "root_pid" ? 43 : "replacement",
        } },
      } }, async client => {
      await client.request("inspect");
      await expect(client.request("queue")).rejects.toThrow("stale_fence");
    });
  });
}

test("client rejects a reordered durable queue snapshot", async () => {
  await withPeer((method, index, initial) => method === "ping"
    ? { type: "pong", capabilities: { updater_fence_v1: true } }
    : { type: "updater_fence", snapshot: index <= 2 ? initial : {
      ...initial, input: { ...initial.input, accepted_sequence: 2, queued_bytes: 0, entries: [] },
    } }, async client => {
    await client.request("queue");
    await expect(client.request("queue")).rejects.toThrow("stale_fence");
  });
});

test("client serializes mutations and retains current completion", async () => {
  await withPeer((method, _index, initial) => method === "ping"
    ? { type: "pong", capabilities: { updater_fence_v1: true } }
    : { type: "updater_fence", snapshot: initial }, async (client, methods) => {
    const first = client.request("inspect");
    await expect(client.request("prepare")).rejects.toThrow("concurrent_request");
    const result = await first;
    expect(result.input.physical_barrier).toBe(true);
    expect(result.restart_claimed).toBe(false);
    expect(methods).toEqual(["ping", "updater.fence.v1"]);
  });
});

test("client rejects a mutation without the next completion sequence", async () => {
  await withPeer((method, _index, initial) => method === "ping"
    ? { type: "pong", capabilities: { updater_fence_v1: true } }
    : { type: "updater_fence", snapshot: initial }, async client => {
    await expect(client.request("prepare")).rejects.toThrow("stale_fence");
  });
});
