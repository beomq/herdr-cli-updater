import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { startServer } from "./server";
import { defaultHerdrSocket } from "./herdr-panes";
import { AppError } from "./types";
import { z } from "zod";

export async function runService(directory: string, port: number, printURL = false): Promise<void> {
  const home = process.env["HOME"] ?? homedir();
  const prefixes = process.env["CLI_UPDATER_PREFIXES"]?.split(":").filter(Boolean)
    ?? ["/opt/homebrew", "/usr/local"];
  const currentConversation = z.object({ pid: z.number().int().positive(), startedAt: z.string(),
    id: z.string(), path: z.string().startsWith("/") }).strict().nullable()
    .parse(JSON.parse(process.env["CLI_UPDATER_CURRENT_CONVERSATION"] ?? "null"));
  const herdrSocket = process.env["HERDR_SOCKET"]?.startsWith("/") ? process.env["HERDR_SOCKET"] : defaultHerdrSocket(process.env["XDG_CONFIG_HOME"] ?? `${home}/.config`);
  const service = await startServer({ directory, port, home, path: process.env["PATH"] ?? "", prefixes, currentConversation, herdrSocket });
  process.send?.({ type: "ready", pid: service.owner.pid, instance: service.owner.instance,
    origin: service.owner.origin, url: service.url });
  if (printURL) console.log(JSON.stringify({ pid: service.owner.pid, origin: service.owner.origin, url: service.url }));
  const stop = () => {
    void service.close().catch(error => { console.error(error instanceof AppError ? error.detail : "shutdown_unverified"); });
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try { await service.closed; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (import.meta.main) {
  try {
    const parsed = parseArgs({ args: process.argv.slice(2), strict: true, options: {
      service: { type: "boolean" }, "state-dir": { type: "string" }, port: { type: "string" },
    } });
    if (!parsed.values.service || !parsed.values["state-dir"]) throw new AppError("invalid_request");
    await runService(parsed.values["state-dir"], Number(parsed.values.port ?? "0"));
  } catch (error) {
    process.send?.({ type: "failed", code: error instanceof AppError ? error.code : "unavailable" });
    process.exitCode = 1;
  }
}
