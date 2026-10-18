import { createConnection } from "node:net";
import { lstatSync } from "node:fs";
import { AppError } from "./types";

/** Read-only and input-only access to the user's running herdr server over its
 * socket. No agent lifecycle authority is claimed: the same commands a human
 * types into the pane are sent, and the server's own agent status is read back.
 * This is the distributed-CLI path (no native bridge): weaker than the core
 * native contract but honest about it. */
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type HerdrPaneAgent = {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly terminalId: string;
  readonly agent: string | null;
  readonly status: HerdrAgentStatus;
  readonly stateChangeSeq: number;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly foregroundPids: readonly number[];
};
export type HerdrPaneClient = {
  readonly executable?: (kind:string) => Promise<string|null>;
  readonly selectExecutable?: (kind:string,executable:string|null) => Promise<void>;
  readonly socketPath: string;
  readonly agents: () => Promise<readonly HerdrPaneAgent[]>;
  readonly agent: (paneId: string) => Promise<HerdrPaneAgent | null>;
  readonly foregroundPids: (paneId: string) => Promise<readonly number[]>;
  readonly read: (paneId: string) => Promise<string>;
  readonly sendLine: (paneId: string, text: string) => Promise<void>;
  readonly wait: (paneId: string, until: readonly HerdrAgentStatus[], timeoutMs: number) => Promise<HerdrPaneAgent | null>;
};
type Reply = { readonly id: string; readonly result?: unknown; readonly error?: { readonly code: string; readonly message: string } };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";

export function defaultHerdrSocket(configHome = `${process.env["HOME"] ?? ""}/.config`): string | null {
  const path = `${configHome}/herdr/herdr.sock`;
  try { return lstatSync(path).isSocket() ? path : null; } catch { return null; }
}

async function request(socketPath: string, method: string, params: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buffer = "", settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new AppError("timeout", `herdr_${method}_timeout`)), timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      let reply: Reply;
      try { reply = JSON.parse(buffer.slice(0, boundary)) as Reply; }
      catch { finish(new AppError("protocol", "herdr_reply_invalid")); return; }
      if (reply.id !== id) { finish(new AppError("protocol", "herdr_reply_mismatch")); return; }
      if (reply.error) { finish(new AppError("unavailable", `herdr_${reply.error.code}`)); return; }
      finish(null, reply.result);
    });
    socket.on("error", error => finish(new AppError("unavailable", `herdr_socket_${"code" in error ? String(error.code) : "error"}`)));
    socket.on("close", () => finish(new AppError("unavailable", "herdr_socket_closed")));
  });
}

function parseAgent(value: unknown, foregroundPids: readonly number[] = []): HerdrPaneAgent | null {
  if (!record(value) || !text(value["pane_id"]) || !text(value["workspace_id"]) || !text(value["terminal_id"])) return null;
  const status = value["agent_status"];
  return {
    paneId: value["pane_id"], workspaceId: value["workspace_id"], terminalId: value["terminal_id"],
    agent: text(value["agent"]) ? value["agent"] : null,
    status: status === "idle" || status === "working" || status === "blocked" || status === "done" ? status : "unknown",
    stateChangeSeq: typeof value["state_change_seq"] === "number" ? value["state_change_seq"] : 0,
    cwd: text(value["cwd"]) ? value["cwd"] : null,
    title: text(value["title"]) ? value["title"] : null,
    foregroundPids,
  };
}

export function createHerdrPaneClient(socketPath: string): HerdrPaneClient {
  const call = (method: string, params: Readonly<Record<string, unknown>>, timeoutMs = 5_000) => request(socketPath, method, params, timeoutMs);
  async function foregroundPids(paneId: string): Promise<readonly number[]> {
    const result = await call("pane.process_info", { pane_id: paneId });
    const info = record(result) ? result["process_info"] : null;
    if (!record(info) || !Array.isArray(info["foreground_processes"])) return [];
    return info["foreground_processes"].flatMap(row => record(row) && typeof row["pid"] === "number" ? [row["pid"]] : []);
  }
  return {
    socketPath,
    async executable(kind) {
      const result=await call('server.agent_executable.get',{kind});
      if(!record(result)||result['type']!=='agent_executable'||result['kind']!==kind
        ||!(result['executable']===null||text(result['executable'])))throw new AppError('protocol','herdr_executable_reply_invalid');
      return result['executable'];
    },
    async selectExecutable(kind,executable) {
      const result=await call('server.agent_executable.set',{kind,executable});
      if(!record(result)||result['type']!=='agent_executable'||result['kind']!==kind||result['executable']!==executable)
        throw new AppError('protocol','herdr_executable_reply_invalid');
    },
    async agents() {
      const result = await call("agent.list", {});
      if (!record(result) || !Array.isArray(result["agents"])) throw new AppError("protocol", "herdr_agent_list_invalid");
      const rows: HerdrPaneAgent[] = [];
      for (const row of result["agents"]) {
        const parsed = parseAgent(row);
        if (!parsed) continue;
        rows.push({ ...parsed, foregroundPids: await foregroundPids(parsed.paneId) });
      }
      return rows;
    },
    async agent(paneId) {
      try {
        const result = await call("agent.get", { target: paneId });
        const parsed = record(result) ? parseAgent(result["agent"]) : null;
        return parsed ? { ...parsed, foregroundPids: await foregroundPids(paneId) } : null;
      } catch (error) {
        if (error instanceof AppError && error.detail === "herdr_agent_not_found") return null;
        throw error;
      }
    },
    foregroundPids,
    async read(paneId) {
      const result = await call("pane.read", { pane_id: paneId, source: "recent" });
      const read = record(result) ? result["read"] : null;
      return record(read) && text(read["text"]) ? read["text"] : "";
    },
    async sendLine(paneId, line) {
      if (line.includes("\n") || line.includes("\r")) throw new AppError("invalid_request", "herdr_multiline_input");
      await call("pane.send_text", { pane_id: paneId, text: line });
      await call("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
    },
    async wait(paneId, until, timeoutMs) {
      try {
        const result = await call("agent.wait", { target: paneId, until: [...until], timeout_ms: timeoutMs }, timeoutMs + 2_000);
        const parsed = record(result) ? parseAgent(result["agent"]) : null;
        return parsed ? { ...parsed, foregroundPids: await foregroundPids(paneId) } : null;
      } catch (error) {
        if (error instanceof AppError && (error.detail === "herdr_agent_not_found" || error.detail === "herdr_timeout")) return null;
        throw error;
      }
    },
  };
}
