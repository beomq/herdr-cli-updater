import { fork, spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { version } from "../../package.json";
import { commandServer, controlServer, readServerOwner } from "./server";
import { parseCommand } from "./validation";
import { AppError } from "./types";
import { captureCurrentConversation } from "./observations";

const readySchema = z.object({ type: z.literal("ready"), pid: z.number().int().positive(),
  instance: z.string().uuid(), origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/), url: z.string() }).strict();
function options(args: readonly string[]) {
  try {
    const parsed = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
      "state-dir": { type: "string" }, port: { type: "string", default: "0" },
      "no-open": { type: "boolean", default: false }, json: { type: "boolean", default: false },
      selection: { type: "string" },
    } });
    const directory = parsed.values["state-dir"] ?? process.env["CLI_UPDATER_STATE_DIR"]
      ?? join(homedir(), ".local/share/cli-updater");
    const port = Number(parsed.values.port);
    if (!isAbsolute(directory) || !Number.isInteger(port) || port < 0 || port > 65535)
      throw new AppError("invalid_request");
    return { directory, port, open: !parsed.values["no-open"], json: parsed.values.json, selection: parsed.values.selection };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_request", "invalid_arguments");
  }
}
async function open(directory: string, port: number) {
  const existing = readServerOwner(directory);
  if (existing) {
    const result = await controlServer(existing, "open", captureCurrentConversation());
    if (!result.url) throw new AppError("protocol");
    return { pid: result.pid, origin: result.origin, url: result.url };
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(directory);
  const child = fork(fileURLToPath(new URL("./main.ts", import.meta.url)),
    ["--service", "--state-dir", canonical, "--port", String(port)], {
      execPath: process.execPath, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, CLI_UPDATER_CURRENT_CONVERSATION: JSON.stringify(captureCurrentConversation()) },
    });
  const ready = Promise.withResolvers<z.infer<typeof readySchema>>();
  const timer = setTimeout(() => ready.reject(new AppError("timeout", "service_start_timeout")), 30_000);
  child.once("message", message => {
    const result = readySchema.safeParse(message);
    if (!result.success || result.data.pid !== child.pid || new URL(result.data.url).origin !== result.data.origin)
      ready.reject(new AppError("unavailable", "service_start_failed"));
    else ready.resolve(result.data);
  });
  child.once("error", () => ready.reject(new AppError("unavailable", "service_start_failed")));
  child.once("exit", () => ready.reject(new AppError("unavailable", "service_start_failed")));
  try {
    const result = await ready.promise;
    child.disconnect(); child.unref();
    return { pid: result.pid, origin: result.origin, url: result.url };
  } finally { clearTimeout(timer); }
}

export async function runCLI(args: readonly string[]): Promise<void> {
  try {
    if (args.length === 1 && args[0] === "--version") { console.log(version); return; }
    if (args.length === 1 && args[0] === "--help") {
      console.log("CLI Updater — local OmO updates and managed sessions");
      console.log("Usage: cli-updater [open|serve|status|stop] [--state-dir /path] [--port 0] [--no-open] [--json]");
      console.log("Native: cli-updater native-targets --state-dir /path");
      console.log("Restart: cli-updater native-restart --state-dir /path --selection /path/selection.json");
      console.log("selection.json contains the selected { installation: InstallSelection, target: TargetSelection } from snapshot.native.selections.");
      console.log("Requires Bun 1.4.2+. Original OmO installation updates currently require macOS, Bun and Node.");
      return;
    }
    const first = args[0];
    const command = !first || first.startsWith("-") ? "open" : first;
    if (!["open", "serve", "status", "stop", "native-targets", "native-restart"].includes(command)) throw new AppError("invalid_request", "unsupported_command");
    const parsed = options(command === first ? args.slice(1) : args);
    if (command === "native-targets" || command === "native-restart") {
      const owner = readServerOwner(parsed.directory);
      if (!owner) throw new AppError("unavailable", "service_not_running");
      const selected: unknown = command === "native-restart"
        ? JSON.parse(readFileSync(parsed.selection ?? "", "utf8")) : null;
      const request = parseCommand({ requestId: randomUUID(), command: command === "native-targets" ? { kind: "refresh" }
        : typeof selected === "object" && selected !== null ? { ...selected, kind: "native-restart" } : selected });
      console.log(JSON.stringify(await commandServer(owner, request)));
      return;
    }
    if (command === "status" || command === "stop") {
      const owner = readServerOwner(parsed.directory);
      if (!owner) { console.log(JSON.stringify({ running: false })); return; }
      const result = await controlServer(owner, command === "status" ? "status" : "stop");
      console.log(JSON.stringify({ running: command === "status", pid: result.pid, origin: result.origin, service: result.service }));
      return;
    }
    if (command === "serve") {
      const { runService } = await import("./main");
      await runService(parsed.directory, parsed.port, true); return;
    }
    const result = await open(parsed.directory, parsed.port);
    console.log(parsed.json ? JSON.stringify(result) : `CLI Updater: ${result.url}`);
    if (parsed.open && process.platform === "darwin") {
      const browser = spawn("/usr/bin/open", [result.url], { stdio: "ignore", detached: true });
      browser.on("error", () => { console.error("Open the printed local URL in your browser."); });
      browser.unref();
    }
  } catch (error) {
    console.error(error instanceof AppError ? error.detail : "service_unavailable");
    process.exitCode = error instanceof AppError && error.code === "invalid_request" ? 2 : 1;
  }
}
