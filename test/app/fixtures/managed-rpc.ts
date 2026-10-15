import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const instanceId = randomUUID();
const route = `route-${instanceId}`;
let path = "";
let durable = "";
let busy = false;
let lastPrompt: Record<string, unknown> | null = null;
const mode = process.env["FIXTURE_MODE"];
const emit = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const response = (request: Record<string, unknown>, data?: Record<string, unknown>, error?: string) => {
  const frame = { type: "response", id: request["id"], command: request["type"], success: !error,
    ...(request["sessionId"] && request["type"] !== "release_session" ? { sessionId: request["sessionId"] } : {}),
    ...(request["type"] === "release_session" && mode === "release-route" ? { sessionId: "foreign-route" } : {}),
    ...(data ? { data } : {}), ...(error ? { error } : {}) };
  emit(frame);
  if (mode === "duplicate") emit(frame);
};
process.on("SIGTERM", () => {
  if (path || busy) process.exit(91);
  process.exit(0);
});
for await (const line of createInterface({ input: process.stdin })) {
  const request: Record<string, unknown> = JSON.parse(line);
  switch (request["type"]) {
    case "get_protocol_info":
      response(request, { protocolVersion: mode === "unsupported" || (process.env["FIXTURE_PROTOCOL_BLOCK"] && existsSync(process.env["FIXTURE_PROTOCOL_BLOCK"])) ? 2 : 1, mode: "multi", instanceId,
        generation: 0, engineVersion: "engine-7", capabilities: ["multi_session", "durable_session_id"],
        launch_profile: { core: { multi_session: true, session_runtime: "in-process" } } });
      break;
    case "open_session": {
      if (typeof request["sessionPath"] !== "string") process.exit(92);
      path = request["sessionPath"];
      durable = existsSync(path) ? String(JSON.parse(readFileSync(path, "utf8"))["id"]) : randomUUID();
      writeFileSync(path, JSON.stringify({ type: "session", id: durable }), { mode: 0o600 });
      response(request, { sessionId: route, state: { sessionId: mode === "wrong-resume" && existsSync(`${path}.opened`) ? randomUUID() : durable } });
      writeFileSync(`${path}.opened`, "opened");
      break;
    }
    case "list_sessions": response(request, { sessions: path ? [{ sessionId: route }] : [] }); break;
    case "prompt":
      busy = true;
      lastPrompt = request;
      emit({ type: "agent_start", sessionId: route });
      if (mode === "lost") process.exit(73);
      if (mode === "mismatch") { response({ ...request, sessionId: "foreign-route" }); process.exit(74); }
      response(request);
      emit({ type: "extension_ui_request", sessionId: route, id: "approval-1", method: "confirm", title: "Proceed?" });
      break;
    case "extension_ui_response":
      if (request["uiRequestId"] !== "approval-1" || typeof request["confirmed"] !== "boolean") process.exit(93);
      response(request);
      busy = false;
      emit({ type: "agent_end", sessionId: route });
      if (lastPrompt && mode === "duplicate") response(lastPrompt);
      break;
    case "release_session":
      if (request["interrupt"] !== undefined || request["force"] !== true || request["reason"] !== "takeover") process.exit(94);
      if (busy) { response(request, undefined, "turn_active"); break; }
      emit({ type: "session_closed", sessionId: route, reason: "released", sessionPath: path });
      response(request, { released: true, session_path: path, attachments: 1, dropped: { deliveries: [], user_messages: [] } });
      path = "";
      if (mode === "release-route") process.exit(75);
      break;
    default: response(request, undefined, "unknown_command");
  }
}
