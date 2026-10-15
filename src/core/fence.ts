import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { parseCompletion } from "./completion";
import type { CompletionBinding, CompletionSnapshot } from "./completion";
import type { Family } from "../protocol";

export const FENCE_METHOD = "updater.fence.v1";
const phases = ["open", "draining", "held", "recovery", "closed"] as const;
const kinds = ["data", "paste", "focus", "synthetic", "protocol", "submission", "resize"] as const;
type InputPhase = (typeof phases)[number];
type InputKind = (typeof kinds)[number];
export type FenceOperation = "inspect" | "prepare" | "claim" | "queue" | "release";
export type InputReceipt = {
  readonly sequence: number; readonly kind: InputKind; readonly bytes: number; readonly sha256: string;
};
export type FenceSnapshot = {
  readonly completion: CompletionSnapshot;
  readonly input: {
    readonly phase: InputPhase; readonly queue_id: string | null;
    readonly accepted_sequence: number; readonly cutoff_sequence: number;
    readonly queued_bytes: number; readonly journal_bytes: number;
    readonly rejected: number; readonly pending_starts: number;
    readonly entries: readonly InputReceipt[];
    readonly physical_barrier: boolean; readonly consuming_ack: false; readonly replay_ready: false;
  };
  readonly restart_claimed: false;
};
export class FenceFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = "FenceFailure"; }
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function integer(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function phase(v: unknown): v is InputPhase {
  return typeof v === "string" && phases.some(p => p === v);
}
function kind(v: unknown): v is InputKind {
  return typeof v === "string" && kinds.some(k => k === v);
}
function entry(v: unknown): v is InputReceipt {
  return record(v) && integer(v["sequence"]) && v["sequence"] > 0 && kind(v["kind"])
    && integer(v["bytes"]) && v["bytes"] <= 4 * 1024 * 1024
    && typeof v["sha256"] === "string" && /^[a-f0-9]{64}$/.test(v["sha256"]);
}
function bindingKey(v: CompletionBinding): string {
  return JSON.stringify([v.socket_id, v.socket_epoch, v.pane_id, v.pane_incarnation, v.root_pid,
    v.root_start_identity, v.root_executable, v.cwd, v.options_ref,
    v.session === null ? null : [v.session.source, v.session.agent, v.session.kind, v.session.value]]);
}

/** Physical drain/escrow observation, never native consumption or restart permission. */
export function parseFence(value: unknown, family: Family): FenceSnapshot {
  if (!record(value) || !record(value["input"]) || value["restart_claimed"] !== false)
    throw new FenceFailure("malformed_fence");
  const completion = parseCompletion(value["completion"], family), input = value["input"];
  if (!phase(input["phase"])
    || !(input["queue_id"] === null || (typeof input["queue_id"] === "string" && /^queue-[a-zA-Z0-9_-]{1,128}$/.test(input["queue_id"])))
    || !integer(input["accepted_sequence"]) || !integer(input["cutoff_sequence"])
    || !integer(input["queued_bytes"]) || !integer(input["journal_bytes"])
    || input["journal_bytes"] > 4 * 1024 * 1024
    || !integer(input["rejected"]) || !integer(input["pending_starts"]) || input["pending_starts"] > 1024
    || !Array.isArray(input["entries"]) || input["entries"].length > 1024 || !input["entries"].every(entry)
    || typeof input["physical_barrier"] !== "boolean"
    || input["consuming_ack"] !== false || input["replay_ready"] !== false)
    throw new FenceFailure("malformed_fence");
  const cutoff = input["cutoff_sequence"], entries = input["entries"];
  if (input["accepted_sequence"] < cutoff
    || entries.some((e, i) => e.sequence !== cutoff + i + 1)
    || entries.reduce((sum, e) => sum + e.bytes, 0) !== input["queued_bytes"]
    || (input["queue_id"] !== null && input["accepted_sequence"] !== cutoff + entries.length)
    || (input["queue_id"] === null && entries.length !== 0)
    || ((input["phase"] === "held") !== input["physical_barrier"])
    || (input["physical_barrier"] && input["pending_starts"] !== 0)
    || (input["phase"] === "open" && (input["queue_id"] !== null || input["journal_bytes"] !== 0))
    || (["held", "draining"].includes(input["phase"])
      && (input["queue_id"] === null || input["journal_bytes"] === 0 || !completion.admission_locked)))
    throw new FenceFailure("partial_fence");
  return {
    completion, restart_claimed: false,
    input: {
      phase: input["phase"], queue_id: input["queue_id"], accepted_sequence: input["accepted_sequence"],
      cutoff_sequence: cutoff, queued_bytes: input["queued_bytes"], journal_bytes: input["journal_bytes"],
      rejected: input["rejected"], pending_starts: input["pending_starts"], entries,
      physical_barrier: input["physical_barrier"], consuming_ack: false, replay_ready: false,
    },
  };
}

const rejectionCodes = ["stale_binding", "wrong_family", "stale_generation", "invalid_sequence",
  "owner_mismatch", "lease_expired", "input_prepare_failed", "input_journal_unavailable",
  "input_actor_unavailable", "input_fence_poisoned", "native_completion_unverified",
  "native_consumption_unverified", "input_fenced"] as const;

export class FenceClient {
  private current: CompletionSnapshot;
  private lastInputSequence = 0;
  private inFlight = false;
  constructor(private readonly socket: string, initial: CompletionSnapshot, private readonly owner: string) {
    this.current = initial;
  }

  async request(action: FenceOperation): Promise<FenceSnapshot> {
    if (this.inFlight) throw new FenceFailure("concurrent_request");
    this.inFlight = true;
    try {
      const pong = await this.exchange("ping", {});
      if (!record(pong) || pong["type"] !== "pong" || !record(pong["capabilities"])
        || pong["capabilities"]["updater_fence_v1"] !== true) throw new FenceFailure("unsupported");
      const before = this.current;
      const result = await this.exchange(FENCE_METHOD, {
        completion: { family: before.family, pane_id: before.binding.pane_id, expected_binding: before.binding,
          generation: before.generation, sequence: before.sequence, owner: this.owner, operation: { action: "inspect" } },
        operation: { action },
      });
      if (!record(result) || result["type"] !== "updater_fence") throw new FenceFailure("malformed_fence");
      const snapshot = parseFence(result["snapshot"], before.family);
      if (snapshot.completion.binding.socket_id !== this.socket
        || bindingKey(snapshot.completion.binding) !== bindingKey(before.binding)
        || snapshot.completion.generation !== before.generation
        || snapshot.completion.sequence < before.sequence
        || ((action === "prepare" || action === "release") && snapshot.completion.sequence !== before.sequence + 1)
        || snapshot.input.accepted_sequence < this.lastInputSequence)
        throw new FenceFailure("stale_fence");
      this.current = snapshot.completion;
      this.lastInputSequence = snapshot.input.accepted_sequence;
      return snapshot;
    } finally { this.inFlight = false; }
  }

  private async exchange(method: string, params: unknown): Promise<unknown> {
    const stat = await lstat(this.socket);
    if (!this.socket.startsWith("/") || !stat.isSocket() || stat.isSymbolicLink()
      || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
      throw new FenceFailure("unsafe_socket");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socket });
      socket.setEncoding("utf8");
      let buffer = "", settled = false;
      const finish = (error: FenceFailure | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      socket.setTimeout(5000, () => finish(new FenceFailure("timeout")));
      socket.on("error", () => finish(new FenceFailure("unavailable")));
      socket.on("end", () => { if (!settled) finish(new FenceFailure("partial_response")); });
      socket.on("data", data => {
        buffer += data.toString("utf8");
        if (Buffer.byteLength(buffer) > 1_048_576) { finish(new FenceFailure("response_too_large")); return; }
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        let response: unknown;
        try { response = JSON.parse(buffer.slice(0, end)); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          finish(new FenceFailure("malformed_json")); return;
        }
        if (!record(response) || response["id"] !== id) { finish(new FenceFailure("response_identity")); return; }
        if (record(response["error"])) {
          const code = response["error"]["code"];
          finish(new FenceFailure(typeof code === "string" && rejectionCodes.some(c => c === code) ? code : "core_rejected"));
          return;
        }
        finish(null, response["result"]);
      });
      socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    });
  }
}
