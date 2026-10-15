import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Family } from "../protocol";

export const COMPLETION_METHOD = "updater.completion.v1";
const kinds = ["root", "tool", "subagent", "background", "monitor", "continuation"] as const;
type Kind = (typeof kinds)[number];
type Session = { readonly source: string; readonly agent: string; readonly kind: string; readonly value: string };
export type CompletionBinding = {
  readonly socket_id: string; readonly socket_epoch: string;
  readonly pane_id: string; readonly pane_incarnation: string; readonly root_pid: number;
  readonly root_start_identity: string | null; readonly root_executable: string | null;
  readonly session: Session | null; readonly cwd: string | null; readonly options_ref: string | null;
};
type Producer = {
  readonly id: string; readonly kind: Kind; readonly parent: string | null;
  readonly admitted_sequence: number; readonly finished_sequence: number | null;
  readonly outcome: "natural" | "error" | "cancelled" | null; readonly sealed: boolean;
};
export type CompletionSnapshot = {
  readonly binding: CompletionBinding; readonly family: Family;
  readonly generation: number; readonly sequence: number;
  readonly required_producers: readonly Kind[]; readonly connected_producers: readonly Kind[];
  readonly missing_producers: readonly Kind[]; readonly producers: readonly Producer[];
  readonly runtime_source: string; readonly producer_work_complete: boolean;
  readonly admission_locked: boolean; readonly lease_valid: boolean;
  readonly runtime_alive: boolean; readonly all_work_drained: boolean; readonly input_fenced: boolean;
};
export type CompletionAction =
  | { readonly action: "inspect" }
  | { readonly action: "begin" | "renew"; readonly owner: string; readonly lease_ms: number }
  | { readonly action: "register"; readonly producer: string; readonly kind: Kind; readonly parent: string | null }
  | { readonly action: "finish"; readonly producer: string; readonly outcome: "natural" | "error" | "cancelled" }
  | { readonly action: "seal"; readonly producer: string }
  | { readonly action: "drain"; readonly owner: string };
export class CompletionFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = "CompletionFailure"; }
}

function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function text(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v);
}
function integer(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function nullableText(v: unknown): v is string | null { return v === null || text(v); }
function kind(v: unknown): v is Kind { return typeof v === "string" && kinds.some(k => k === v); }
function categories(v: unknown): v is Kind[] {
  return Array.isArray(v) && v.every(kind) && new Set(v).size === v.length;
}
function binding(v: unknown): v is CompletionBinding {
  return record(v) && text(v["socket_id"]) && text(v["socket_epoch"]) && text(v["pane_id"])
    && text(v["pane_incarnation"]) && integer(v["root_pid"]) && v["root_pid"] > 0
    && nullableText(v["root_start_identity"]) && nullableText(v["root_executable"])
    && nullableText(v["cwd"]) && nullableText(v["options_ref"])
    && (v["session"] === null || (record(v["session"]) && text(v["session"]["source"])
      && text(v["session"]["agent"]) && text(v["session"]["kind"]) && text(v["session"]["value"])));
}
function sameBinding(a: CompletionBinding, b: CompletionBinding): boolean {
  return a.socket_id === b.socket_id && a.socket_epoch === b.socket_epoch && a.pane_id === b.pane_id
    && a.pane_incarnation === b.pane_incarnation && a.root_pid === b.root_pid
    && a.root_start_identity === b.root_start_identity && a.root_executable === b.root_executable
    && a.cwd === b.cwd && a.options_ref === b.options_ref
    && (a.session === null ? b.session === null : b.session !== null
      && a.session.source === b.session.source && a.session.agent === b.session.agent
      && a.session.kind === b.session.kind && a.session.value === b.session.value);
}
function producer(v: unknown): v is Producer {
  return record(v) && text(v["id"]) && kind(v["kind"]) && nullableText(v["parent"])
    && integer(v["admitted_sequence"]) && v["admitted_sequence"] > 0
    && (v["finished_sequence"] === null || integer(v["finished_sequence"]))
    && (v["outcome"] === null || (typeof v["outcome"] === "string"
      && ["natural", "error", "cancelled"].includes(v["outcome"])))
    && typeof v["sealed"] === "boolean";
}

/** Parse production JSON. This is an observation, never an adapter attestation. */
export function parseCompletion(value: unknown, family: Family): CompletionSnapshot {
  if (!record(value) || !binding(value["binding"]) || typeof value["family"] !== "string" || value["family"] !== family
    || !integer(value["generation"]) || !integer(value["sequence"])
    || !categories(value["required_producers"]) || !categories(value["connected_producers"])
    || !categories(value["missing_producers"]) || !Array.isArray(value["producers"])
    || !value["producers"].every(producer) || value["producers"].length > 1024
    || value["runtime_source"] !== "app.terminal_runtimes+PaneDied"
    || typeof value["producer_work_complete"] !== "boolean"
    || typeof value["admission_locked"] !== "boolean" || typeof value["lease_valid"] !== "boolean"
    || typeof value["runtime_alive"] !== "boolean" || typeof value["all_work_drained"] !== "boolean"
    || value["input_fenced"] !== false) throw new CompletionFailure("malformed_completion");
  const required = value["required_producers"], connected = value["connected_producers"];
  const missing = value["missing_producers"], producers = value["producers"];
  const sequence = value["sequence"];
  if (required.length !== kinds.length || !kinds.every(k => required.includes(k))
    || missing.length !== kinds.length - connected.length
    || !kinds.every(k => connected.includes(k) !== missing.includes(k))
    || new Set(producers.map(p => p.id)).size !== producers.length
    || (producers.length > 0 && producers.filter(p => p.kind === "root").length !== 1)
    || producers.some(p => (p.kind === "root") !== (p.parent === null))
    || new Set(producers.map(p => p.admitted_sequence)).size !== producers.length
    || producers.some(p => p.admitted_sequence > sequence
      || (p.finished_sequence !== null && (p.finished_sequence <= p.admitted_sequence
        || p.finished_sequence > sequence))
      || (p.outcome === null) !== (p.finished_sequence === null) || (p.sealed && p.outcome === null)
      || (p.parent !== null && !producers.some(parent => parent.id === p.parent
        && parent.admitted_sequence < p.admitted_sequence)))) throw new CompletionFailure("partial_completion");
  const complete = producers.length > 0 && producers.every(p => p.sealed && p.outcome === "natural");
  if (value["producer_work_complete"] !== complete) throw new CompletionFailure("partial_completion");
  // No registered family hooks yet. A claiming peer has a different, unqualified ABI.
  if (connected.length !== 0 || value["all_work_drained"]) throw new CompletionFailure("unqualified_hooks");
  return {
    binding: value["binding"], family, generation: value["generation"], sequence: value["sequence"],
    required_producers: required, connected_producers: connected, missing_producers: missing,
    producers, runtime_source: value["runtime_source"], producer_work_complete: complete,
    admission_locked: value["admission_locked"], lease_valid: value["lease_valid"],
    runtime_alive: value["runtime_alive"], all_work_drained: false, input_fenced: false,
  };
}

/** Private same-user IPC. The caller selects the core socket; no public service token is sent. */
export class CompletionClient {
  private current: CompletionSnapshot | undefined;
  private inFlight = false;
  constructor(private readonly socketPath: string, private readonly family: Family, private readonly paneId: string) {}

  async request(operation: CompletionAction, owner: string | null = null): Promise<CompletionSnapshot> {
    if (this.inFlight) throw new CompletionFailure("concurrent_request");
    this.inFlight = true;
    try {
      const pong = await this.exchange("ping", {});
      if (!record(pong) || pong["type"] !== "pong" || !record(pong["capabilities"])
        || pong["capabilities"]["updater_completion_v1"] !== true) throw new CompletionFailure("unsupported");
      if (!this.current && operation.action !== "inspect") throw new CompletionFailure("binding_required");
      const previous = this.current;
      const response = await this.exchange(COMPLETION_METHOD, {
        family: this.family, pane_id: this.paneId, expected_binding: previous?.binding ?? null,
        generation: previous?.generation ?? 0, sequence: previous?.sequence ?? 0, owner, operation,
      });
      if (!record(response) || response["type"] !== "updater_completion") throw new CompletionFailure("malformed_completion");
      const next = parseCompletion(response["snapshot"], this.family);
      if (next.binding.socket_id !== this.socketPath || next.binding.pane_id !== this.paneId)
        throw new CompletionFailure("stale_binding");
      if (previous && (!sameBinding(next.binding, previous.binding)
        || next.generation !== previous.generation + (operation.action === "begin" ? 1 : 0)
        || (operation.action === "inspect" ? next.sequence < previous.sequence
          : next.sequence !== previous.sequence + 1)))
        throw new CompletionFailure("stale_completion");
      this.current = next;
      return next;
    } finally { this.inFlight = false; }
  }

  private async exchange(method: string, params: unknown): Promise<unknown> {
    const stat = await lstat(this.socketPath);
    if (!this.socketPath.startsWith("/") || !stat.isSocket() || stat.isSymbolicLink()
      || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())
      throw new CompletionFailure("unsafe_socket");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      socket.setEncoding("utf8");
      let data = "", settled = false;
      const finish = (error: CompletionFailure | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      socket.setTimeout(5000, () => finish(new CompletionFailure("timeout")));
      socket.on("error", () => finish(new CompletionFailure("unavailable")));
      socket.on("end", () => { if (!settled) finish(new CompletionFailure("partial_response")); });
      socket.on("data", chunk => {
        data += chunk.toString("utf8");
        if (Buffer.byteLength(data) > 1_048_576) { finish(new CompletionFailure("response_too_large")); return; }
        const end = data.indexOf("\n");
        if (end < 0) return;
        let response: unknown;
        try { response = JSON.parse(data.slice(0, end)); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          finish(new CompletionFailure("malformed_json")); return;
        }
        if (!record(response) || response["id"] !== id) { finish(new CompletionFailure("response_identity")); return; }
        if (record(response["error"])) { finish(new CompletionFailure("core_rejected")); return; }
        finish(null, response["result"]);
      });
      socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    });
  }
}
