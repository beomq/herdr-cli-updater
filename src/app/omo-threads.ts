import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { z } from "zod";

const threadSchema = z.object({
  sessionId: z.string().uuid(),
  sessionPath: z.string().startsWith("/").endsWith(".jsonl"),
  socket: z.string().startsWith("/"),
  endpoint_kind: z.literal("tui"),
  alive: z.literal(true),
  name: z.string().max(4096).optional(),
});
const registrationSchema = z.object({
  pid: z.number().int().positive(), processStartTime: z.string(),
  instance_id: z.string().uuid(), socket: z.string(), engineVersion: z.string().max(128),
});
export type OmoThread = z.infer<typeof threadSchema> & {
  readonly registration?: z.infer<typeof registrationSchema>;
  readonly state?: OmoState;
};

const stateSchema = z.object({
  sessionId: z.string().uuid(), sessionFile: z.string(),
  isStreaming: z.boolean(), isCompacting: z.boolean(), isBashRunning: z.boolean(),
  pendingMessageCount: z.number().int().nonnegative(),
  retryAttempt: z.number().nonnegative().optional(),
  blocking_question: z.boolean().optional(), editor_has_draft: z.boolean().optional(),
  // These fields are not exposed by older engines. Their absence must never mean idle.
  hasSessionWork: z.boolean().optional(), hasActiveWakeSource: z.boolean().optional(),
});
export type OmoState = z.infer<typeof stateSchema>;
export type OmoActivity = "working" | "blocked" | "idle" | "unknown";
export function omoActivity(state: OmoState): OmoActivity {
  if (state.blocking_question || state.editor_has_draft) return "blocked";
  if (state.isStreaming || state.isCompacting || state.isBashRunning || state.pendingMessageCount > 0
    || (state.retryAttempt ?? 0) > 0 || state.hasSessionWork || state.hasActiveWakeSource) return "working";
  return state.hasSessionWork === false && state.hasActiveWakeSource === false ? "idle" : "unknown";
}

/** Read-only TUI state query. Credentials remain in memory and are never returned or logged. */
export async function readOmoState(socketPath: string): Promise<OmoState | undefined> {
  let secret: Buffer;
  try { secret = await readFile(`${socketPath}.secret`); }
  catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "EACCES"].includes(String(error.code))) return undefined;
    throw error;
  }
  if (secret.length !== 32) return undefined;
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    const id = crypto.randomUUID();
    let buffer = "";
    const finish = (state?: OmoState) => { clearTimeout(timer); socket.destroy(); resolve(state); };
    const timer = setTimeout(() => finish(), 2000);
    socket.once("connect", () => { socket.write(secret); socket.write(JSON.stringify({ id, type: "get_state", observe: true }) + "\n"); });
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 4 * 1024 * 1024) { finish(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let parsed: unknown;
        try { parsed = JSON.parse(line); }
        catch (error) { if (error instanceof SyntaxError) { finish(); return; } throw error; }
        const reply = z.object({ id: z.string(), success: z.boolean(), data: z.unknown().optional() }).safeParse(parsed);
        if (!reply.success || reply.data.id !== id) continue;
        const state = stateSchema.safeParse(reply.data.data);
        finish(reply.data.success && state.success ? state.data : undefined); return;
      }
    });
    socket.once("error", () => finish());
    socket.once("close", () => finish());
  });
}

export async function readOmoRegistration(agentDir: string, socket: string): Promise<OmoThread["registration"]> {
  const directory = join(agentDir, "rpc-host-daemon", createHash("sha256").update(socket).digest("hex").slice(0, 16));
  try {
    const pointer = z.object({ instance_id: z.string().uuid() }).parse(JSON.parse(await readFile(join(directory, "host.pid"), "utf8")));
    const record = registrationSchema.parse(JSON.parse(await readFile(join(directory, "generations", pointer.instance_id, "host.pid"), "utf8")));
    return record.socket === socket && record.instance_id === pointer.instance_id ? record : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError
      || (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code)))) return undefined;
    throw error;
  }
}

/** Enumeration is metadata only. `status: live` means reachable, NOT idle. */
export function parseOmoThreads(text: string): readonly OmoThread[] {
  const records = z.array(z.unknown()).parse(JSON.parse(text));
  return records.flatMap(record => {
    const parsed = threadSchema.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Use the installed CLI's public reader rather than interpreting private socket credentials. */
export async function readOmoThreads(executable: string, agentDir?: string): Promise<readonly OmoThread[]> {
  const text = await new Promise<string>((resolve, reject) => {
    execFile(executable, ["thread", "list", "--all-scope", "--json"],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  const threads = parseOmoThreads(text);
  if (!agentDir) return threads;
  return Promise.all(threads.map(async thread => {
    const registration = await readOmoRegistration(agentDir, thread.socket);
    const state = await readOmoState(thread.socket);
    const exactState = state?.sessionId === thread.sessionId && state.sessionFile === thread.sessionPath ? state : undefined;
    return { ...thread, ...(registration ? { registration } : {}), ...(exactState ? { state: exactState } : {}) };
  }));
}
