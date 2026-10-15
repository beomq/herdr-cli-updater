import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionClient, parseCompletion } from "../../src/core/completion";
import type { CompletionSnapshot } from "../../src/core/completion";

function snapshot(socket = "/private/core.sock"): CompletionSnapshot {
  return {
    family: "omo", generation: 1, sequence: 4,
    binding: {
      socket_id: socket, socket_epoch: "boot-a", pane_id: "w1:p1",
      pane_incarnation: "term-a:42", root_pid: 42, root_start_identity: null,
      root_executable: null, session: null, cwd: "/tmp/project", options_ref: null,
    },
    required_producers: ["root", "tool", "subagent", "background", "monitor", "continuation"],
    connected_producers: [],
    missing_producers: ["root", "tool", "subagent", "background", "monitor", "continuation"],
    producers: [{
      id: "root-a", kind: "root", parent: null, admitted_sequence: 2,
      finished_sequence: 3, outcome: "natural", sealed: true,
    }],
    runtime_source: "app.terminal_runtimes+PaneDied", producer_work_complete: true,
    admission_locked: false, lease_valid: true, runtime_alive: true,
    all_work_drained: false, input_fenced: false,
  };
}

describe("completion production response boundary", () => {
  for (const outcome of ["natural", "error", "cancelled"] as const) {
    test(`rejects outcome array ${outcome} with an unsealed producer`, () => {
      const value = snapshot();
      expect(() => parseCompletion({
        ...value, producer_work_complete: false,
        producers: value.producers.map(p => ({ ...p, sealed: false, outcome: [outcome] })),
      }, "omo")).toThrow("malformed_completion");
    });
  }
  for (const outcome of ["natural", "error", "cancelled", null] as const) {
    test(`accepts canonical outcome ${outcome} with an unsealed producer`, () => {
      const value = snapshot();
      const result = parseCompletion({
        ...value, producer_work_complete: false,
        producers: value.producers.map(p => ({
          ...p, sealed: false, outcome, finished_sequence: outcome === null ? null : 3,
        })),
      }, "omo");
      expect(result.producers[0]?.outcome).toBe(outcome);
      expect(result.all_work_drained).toBe(false);
    });
  }
  for (const [name, change] of [
    ["family", { family: ["omo"] }],
    ["producer kind", { producers: [{ ...snapshot().producers[0], kind: ["root"] }] }],
    ["required kind", { required_producers: snapshot().required_producers.map(k => [k]) }],
    ["connected kind", { connected_producers: [["root"]] }],
    ["missing kind", { missing_producers: snapshot().missing_producers.map(k => [k]) }],
  ] as const) {
    test(`rejects non-string enum ${name} at the decoding boundary`, () => {
      expect(() => parseCompletion({ ...snapshot(), ...change }, "omo")).toThrow("malformed_completion");
    });
  }
  test("retains unknown hooks even after every reported producer finishes", () => {
    const result = parseCompletion(snapshot(), "omo");
    expect(result.producer_work_complete).toBe(true);
    expect(result.all_work_drained).toBe(false);
    expect(result.missing_producers).toHaveLength(6);
  });
  for (const [name, change] of [
    ["claimed readiness", { all_work_drained: true }],
    ["empty required manifest", { required_producers: [] }],
    ["missing continuation", { missing_producers: ["root", "tool", "subagent", "background", "monitor"] }],
    ["fixture enrollment", { connected_producers: ["root"], missing_producers: ["tool", "subagent", "background", "monitor", "continuation"] }],
    ["unsafe sequence", { sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing runtime", { runtime_source: undefined }],
    ["input fence claim", { input_fenced: true }],
    ["wrong family", { family: "pi" }],
    ["partial finish", { producers: [{ ...snapshot().producers[0], finished_sequence: null }] }],
    ["missing parent", { producers: [{ ...snapshot().producers[0], parent: "absent" }] }],
    ["false complete", { producer_work_complete: false }],
    ["non-root with no parent", { producers: [{ ...snapshot().producers[0], kind: "tool" }] }],
  ] as const) {
    test(`rejects ${name}`, () => {
      expect(() => parseCompletion({ ...snapshot(), ...change }, "omo")).toThrow();
    });
  }
});

async function withPeer(
  response: (method: string, index: number, path: string) => unknown,
  exercise: (client: CompletionClient, methods: string[]) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "completion-"));
  const path = join(root, "core.sock"), methods: string[] = [];
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
      socket.end(`${JSON.stringify({ id: request.id, result: response(request.method, methods.length, path) })}\n`);
    });
  });
  const listening = once(server, "listening");
  server.listen(path);
  await listening;
  await chmod(path, 0o600);
  try { await exercise(new CompletionClient(path, "omo", "w1:p1"), methods); }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true });
  }
}

test("old core receives no new method before feature negotiation", async () => {
  await withPeer(() => ({ type: "pong", capabilities: {} }), async (client, methods) => {
    await expect(client.request({ action: "inspect" })).rejects.toThrow("unsupported");
    expect(methods).toEqual(["ping"]);
  });
});

test("same socket response with changed incarnation is rejected", async () => {
  await withPeer((method, index, path) => method === "ping"
    ? { type: "pong", capabilities: { updater_completion_v1: true } }
    : { type: "updater_completion", snapshot: {
      ...snapshot(path),
      binding: { ...snapshot(path).binding, pane_incarnation: index > 2 ? "term-b:42" : "term-a:42" },
    } }, async client => {
    await client.request({ action: "inspect" });
    await expect(client.request({ action: "inspect" })).rejects.toThrow("stale_completion");
  });
});

test("reordered generation does not replace the last accepted observation", async () => {
  await withPeer((method, index, path) => method === "ping"
    ? { type: "pong", capabilities: { updater_completion_v1: true } }
    : { type: "updater_completion", snapshot: { ...snapshot(path), generation: index > 2 ? 0 : 1 } },
  async client => {
    await client.request({ action: "inspect" });
    await expect(client.request({ action: "inspect" })).rejects.toThrow("stale_completion");
  });
});

test("a newer invalidated runtime snapshot remains readable without granting readiness", async () => {
  await withPeer((method, index, path) => method === "ping"
    ? { type: "pong", capabilities: { updater_completion_v1: true } }
    : { type: "updater_completion", snapshot: {
      ...snapshot(path), sequence: index > 2 ? 5 : 4,
      runtime_alive: index <= 2, admission_locked: index > 2,
    } }, async client => {
    await client.request({ action: "inspect" });
    const dead = await client.request({ action: "inspect" });
    expect(dead.runtime_alive).toBe(false);
    expect(dead.all_work_drained).toBe(false);
  });
});
