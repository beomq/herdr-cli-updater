import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Installation } from "../protocol";
import { AppError, type ManagedSession } from "./types";

type Options = {
  readonly directory: string;
  readonly onChange: () => void;
  readonly env?: Readonly<Record<string, string>>;
};
type Pending = {
  readonly command: string;
  readonly sessionId: string | null;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: AppError) => void;
};
/** Mutable ownership ledger. A persisted PID never grants ownership. */
type Entry = {
  view: ManagedSession;
  path: string;
  instance: string | null;
  hostGeneration: number | null;
  route: string | null;
  host: Host | null;
  fenced: boolean;
  lifecycle: boolean;
  event: number;
  refusedAt: number | null;
};
type Host = {
  readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly pending: Map<string, Pending>;
  readonly read: Promise<void>;
  expectedExit: boolean;
  broken: boolean;
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("protocol");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new AppError("protocol");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) throw new AppError("protocol");
  return value;
}
function bounded<T>(promise: Promise<T>, milliseconds: number, error: AppError): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function durableHeader(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const header = object(JSON.parse(buffer.subarray(0, size).toString("utf8").split("\n")[0] ?? ""));
    if (header["type"] !== "session") throw new AppError("protocol", "invalid_session_header");
    return text(header["id"]);
  } finally { closeSync(fd); }
}

export function createManagedSessions(options: Options) {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  chmodSync(options.directory, 0o700);
  const directory = realpathSync(options.directory);
  const entries = new Map<string, Entry>();
  const admissions = new Map<string, boolean>();
  const lifecycleAdmissions = new Map<string, number>();
  let closing = false;
  let closed = false;

  function persist(entry: Entry): void {
    const file = join(directory, `${entry.view.id}.metadata.json`);
    const temporary = `${file}.tmp`;
    // No output, dialog, message, environment or credential is stored in this ledger.
    const { output: _output, approval: _approval, ...view } = entry.view;
    writeFileSync(temporary, JSON.stringify({ view, path: entry.path, instance: entry.instance,
      hostGeneration: entry.hostGeneration }), { mode: 0o600 });
    renameSync(temporary, file);
  }
  function change(entry: Entry, fields: Partial<ManagedSession>): void {
    entry.view = { ...entry.view, ...fields, updatedAt: Date.now() };
    persist(entry);
    options.onChange();
  }
  for (const file of readdirSync(directory).filter(name => name.endsWith(".metadata.json"))) {
    try {
      const saved = object(JSON.parse(readFileSync(join(directory, file), "utf8")));
      const view = object(saved["view"]);
      const id = text(view["id"]);
      if (file !== `${id}.metadata.json` || !/^[a-f0-9-]{36}$/.test(id)) throw new AppError("protocol");
      const path = text(saved["path"]);
      if (path !== join(directory, `${id}.jsonl`)) throw new AppError("protocol");
      const generation = view["generation"];
      if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) throw new AppError("protocol");
      const stopped = view["state"] === "stopped";
      entries.set(id, { view: {
        id, installationId: text(view["installationId"]), cwd: text(view["cwd"]), generation,
        pid: null, state: stopped ? "stopped" : "unknown", launchedVersion: typeof view["launchedVersion"] === "string" ? view["launchedVersion"] : null,
        engineVersion: typeof view["engineVersion"] === "string" ? view["engineVersion"] : null,
        durableSessionId: typeof view["durableSessionId"] === "string" ? view["durableSessionId"] : null,
        updatedAt: Date.now(), failure: stopped ? null : "ownership_lost", output: [], approval: null,
      }, path, instance: typeof saved["instance"] === "string" ? saved["instance"] : null,
      hostGeneration: typeof saved["hostGeneration"] === "number" ? saved["hostGeneration"] : null,
      route: null, host: null, fenced: true, lifecycle: false, event: 0, refusedAt: null });
    } catch (error) {
      if (error instanceof AppError || error instanceof SyntaxError) throw new AppError("protocol", "invalid_managed_metadata");
      throw error;
    }
  }
  function selected(id: string, generation: number): Entry {
    const entry = entries.get(id);
    if (!entry) throw new AppError("not_found");
    if (entry.view.generation !== generation) throw new AppError("conflict", "stale_generation");
    return entry;
  }
  function admit(installationId: string): void {
    if (closed || closing || admissions.get(installationId) === false || (lifecycleAdmissions.get(installationId) ?? 0) > 0) throw new AppError("busy", "admission_sealed");
  }
  function fence(entry: Entry, delta: number): void {
    const id = entry.view.installationId;
    lifecycleAdmissions.set(id, (lifecycleAdmissions.get(id) ?? 0) + delta);
  }
  function uncertain(entry: Entry, host: Host, code: string): void {
    if (host.broken) return;
    host.broken = true;
    entry.fenced = true;
    for (const pending of host.pending.values()) pending.reject(new AppError("uncertain", code));
    host.pending.clear();
    change(entry, { state: "unknown", failure: code });
  }
  function event(entry: Entry, host: Host, frame: Record<string, unknown>): void {
    if (entry.host !== host || host.broken) return;
    if (frame["type"] === "response") {
      const pending = host.pending.get(text(frame["id"]));
      // A duplicate/late reply never settles a different request or replays an effect.
      if (!pending) return;
      if (frame["command"] !== pending.command
        || (pending.sessionId !== null && frame["sessionId"] !== pending.sessionId)
        || (pending.command === "release_session" && frame["sessionId"] !== undefined)) {
        uncertain(entry, host, "response_identity_mismatch");
        return;
      }
      if (typeof frame["success"] !== "boolean") throw new AppError("protocol");
      pending.resolve(frame);
      return;
    }
    if (frame["type"] === "host_superseded" || frame["type"] === "overflow") {
      uncertain(entry, host, "host_incarnation_lost");
      return;
    }
    if (frame["sessionId"] !== entry.route) return;
    entry.event++;
    switch (frame["type"]) {
      case "agent_start": change(entry, { state: "working" }); break;
      case "agent_end": change(entry, { state: "ready", approval: null }); break;
      case "extension_ui_request": {
        const method = frame["method"];
        if (method === "confirm" || method === "select" || method === "input" || method === "editor") {
          change(entry, { state: "waiting", approval: { id: text(frame["id"]), method,
            title: typeof frame["title"] === "string" ? frame["title"] : "",
            options: frame["options"] === undefined ? [] : strings(frame["options"]) } });
        }
        break;
      }
      case "message_update": {
        const update = object(frame["assistantMessageEvent"]);
        if (update["type"] === "text_delta" && typeof update["delta"] === "string") {
          const output = [...entry.view.output, update["delta"].slice(0, 8192)].slice(-128);
          change(entry, { output });
        }
        break;
      }
      case "session_replaced": uncertain(entry, host, "durable_identity_changed"); break;
      case "session_error": uncertain(entry, host, "session_error"); break;
      case "session_closed":
        if (!entry.lifecycle || frame["reason"] !== "released") uncertain(entry, host, "unexpected_session_close");
        break;
      default: options.onChange();
    }
  }
  async function request(entry: Entry, host: Host, command: string, fields: Record<string, unknown> = {}, scoped = false): Promise<Record<string, unknown>> {
    if (host.broken || entry.host !== host) throw new AppError("uncertain", "host_unavailable");
    if (host.pending.size >= 64) throw new AppError("busy", "rpc_capacity");
    const id = randomUUID();
    const sessionId = scoped ? entry.route : null;
    if (scoped && !sessionId) throw new AppError("uncertain", "missing_routing_handle");
    const reply = Promise.withResolvers<Record<string, unknown>>();
    // release_session is a host command: its request names the session, but its
    // response is unscoped after release. Bind that receipt by request id, path,
    // durable header and the subsequent empty-host observation instead.
    host.pending.set(id, { command, sessionId: command === "release_session" ? null : sessionId,
      resolve: reply.resolve, reject: reply.reject });
    try {
      host.child.stdin.write(`${JSON.stringify({ ...fields, id, type: command, ...(sessionId ? { sessionId } : {}) })}\n`);
      await host.child.stdin.flush();
      const response = await bounded(reply.promise, 60_000, new AppError("uncertain", "rpc_response_timeout"));
      if (!response["success"]) {
        switch (response["error"]) {
          case "turn_active": case "session_busy": case "attached": throw new AppError("busy");
          case "release_unsupported": case "unknown_command": throw new AppError("unsupported");
          case "unknown_extension_ui_request": case "question_already_resolved": throw new AppError("conflict");
          default: throw new AppError("uncertain", "rpc_effect_refused");
        }
      }
      return response["data"] === undefined ? {} : object(response["data"]);
    } catch (error) {
      if (error instanceof AppError && (error.code === "busy" || error.code === "unsupported" || error.code === "conflict")) throw error;
      uncertain(entry, host, error instanceof AppError ? error.detail : "rpc_write_failed");
      throw new AppError("uncertain", entry.view.failure ?? "rpc_failed");
    } finally { host.pending.delete(id); }
  }
  async function terminate(entry: Entry, host: Host): Promise<void> {
    host.expectedExit = true;
    host.child.kill("SIGTERM");
    await bounded(host.child.exited, 30_000, new AppError("uncertain", "host_exit_timeout"));
    await bounded(host.read, 5_000, new AppError("uncertain", "host_stream_exit_timeout"));
    entry.host = null;
    entry.route = null;
    change(entry, { pid: null, state: "stopped", approval: null, failure: null });
  }
  async function start(entry: Entry, installation: Installation): Promise<ManagedSession> {
    if (installation.family !== "omo" || process.platform === "win32") throw new AppError("unsupported");
    const previousInstance = entry.instance;
    const previousDurable = entry.view.durableSessionId;
    change(entry, { state: "starting", launchedVersion: installation.installedVersion.kind === "known" ? installation.installedVersion.version : null,
      engineVersion: null, failure: null });
    let host: Host | null = null;
    let openDispatched = false;
    try {
      const child = Bun.spawn([process.execPath, installation.executableRealpath, "--mode", "rpc", "--multi-session", "--session-runtime", "in-process"], {
        cwd: entry.view.cwd, env: { ...process.env, ...options.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      const pending = new Map<string, Pending>();
      const current: Host = { child, pending, expectedExit: false, broken: false, read: consume() };
      host = current;
      entry.host = current;
      change(entry, { pid: child.pid });
      async function consume(): Promise<void> {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for await (const chunk of child.stdout) {
            buffer += decoder.decode(chunk, { stream: true });
            if (buffer.length > 16 * 1024 * 1024) throw new AppError("protocol", "rpc_record_limit");
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              event(entry, current, object(JSON.parse(line)));
            }
          }
          if (!current.expectedExit) uncertain(entry, current, "rpc_stream_closed");
        } catch (error) {
          uncertain(entry, current, error instanceof AppError ? error.detail : "rpc_malformed_frame");
        }
      }
      // Drain stderr without retaining arbitrary diagnostic payloads or credentials.
      void (async () => { for await (const _chunk of child.stderr) { /* discard */ } })();
      void child.exited.then(() => {
        if (!current.expectedExit) uncertain(entry, current, "owned_host_exited");
      });
      const protocol = await request(entry, current, "get_protocol_info");
      const capabilities = strings(protocol["capabilities"]);
      const profile = object(object(protocol["launch_profile"])["core"]);
      if (protocol["protocolVersion"] !== 1 || protocol["mode"] !== "multi"
        || !capabilities.includes("multi_session") || !capabilities.includes("durable_session_id")
        || profile["session_runtime"] !== "in-process" || profile["multi_session"] !== true) throw new AppError("unsupported", "unsupported_rpc_protocol");
      const instance = text(protocol["instanceId"]);
      const generation = protocol["generation"];
      if (instance === previousInstance || typeof generation !== "number" || !Number.isSafeInteger(generation)) throw new AppError("protocol", "host_identity_mismatch");
      entry.instance = instance;
      entry.hostGeneration = generation;
      change(entry, { engineVersion: text(protocol["engineVersion"]) });
      openDispatched = true;
      const opened = await request(entry, current, "open_session", { cwd: entry.view.cwd, sessionPath: entry.path, permissionPreset: "ask", auto_title: false });
      const state = object(opened["state"]);
      const durable = text(state["sessionId"]);
      if (previousDurable !== null && durable !== previousDurable) throw new AppError("uncertain", "resume_identity_mismatch");
      entry.route = text(opened["sessionId"]);
      entry.fenced = false;
      entry.refusedAt = null;
      change(entry, { durableSessionId: durable, state: "ready" });
      return entry.view;
    } catch (error) {
      if (host && !openDispatched && !host.broken) {
        const listing = await request(entry, host, "list_sessions");
        if (!Array.isArray(listing["sessions"]) || listing["sessions"].length !== 0) throw new AppError("uncertain", "startup_host_not_empty");
        await terminate(entry, host);
      }
      entry.fenced = true;
      change(entry, { state: openDispatched || host?.broken ? "unknown" : "failed",
        failure: error instanceof AppError ? error.detail : "launch_failed" });
      throw error instanceof AppError ? error : new AppError("unavailable", "launch_failed");
    }
  }
  async function stopEntry(entry: Entry, locked = false): Promise<ManagedSession> {
    if (entry.lifecycle && !locked) throw new AppError("busy", "lifecycle_in_progress");
    if (entry.view.state === "stopped") return entry.view;
    const host = entry.host;
    // A failed restart before open_session may have a verified empty, terminated host.
    // Unknown sessions and lost ownership never enter this path.
    if(entry.view.state==='failed'&&host===null&&entry.view.pid===null&&entry.view.durableSessionId!==null
      &&durableHeader(entry.path)===entry.view.durableSessionId){
      change(entry,{state:'stopped',approval:null,failure:null});
      return entry.view;
    }
    if (!host || host.broken || entry.view.state === "starting") throw new AppError("uncertain", "ownership_unverified");
    if (entry.refusedAt === entry.event) throw new AppError("busy", "await_observed_event");
    entry.fenced = true;
    entry.lifecycle = true;
    if (!locked) fence(entry, 1);
    const prior = entry.view.state;
    const observedAtDispatch = entry.event;
    change(entry, { state: "stopping" });
    try {
      const released = await request(entry, host, "release_session", { reason: "takeover", force: true }, true);
      const dropped = object(released["dropped"]);
      if (released["released"] !== true || released["session_path"] !== entry.path
        || released["attachments"] !== 1 || strings(dropped["deliveries"]).length !== 0
        || strings(dropped["user_messages"]).length !== 0 || !existsSync(entry.path)) throw new AppError("uncertain", "release_identity_unverified");
      if (durableHeader(entry.path) !== entry.view.durableSessionId) throw new AppError("uncertain", "durable_identity_unverified");
      const listing = await request(entry, host, "list_sessions");
      if (!Array.isArray(listing["sessions"]) || listing["sessions"].length !== 0) throw new AppError("uncertain", "host_not_empty");
      await terminate(entry, host);
      return entry.view;
    } catch (error) {
      if (error instanceof AppError && error.code === "busy") {
        entry.refusedAt = observedAtDispatch;
        change(entry, { state: entry.view.state === "stopping" ? prior : entry.view.state, failure: "busy" });
      } else uncertain(entry, host, error instanceof AppError ? error.detail : "stop_unverified");
      throw error instanceof AppError ? error : new AppError("uncertain", "stop_unverified");
    } finally {
      if (!locked) { entry.lifecycle = false; fence(entry, -1); }
    }
  }
  return {
    list(): readonly ManagedSession[] { return [...entries.values()].map(entry => structuredClone(entry.view)); },
    async launch(installation: Installation, cwd: string): Promise<ManagedSession> {
      admit(installation.installationId);
      if (installation.family !== "omo") throw new AppError("unsupported");
      if (!isAbsolute(cwd)) throw new AppError("invalid_request", "absolute_cwd_required");
      const id = randomUUID();
      const entry: Entry = { view: { id, installationId: installation.installationId, cwd: realpathSync(cwd), generation: 1,
        pid: null, state: "starting", launchedVersion: null, engineVersion: null, durableSessionId: null,
        updatedAt: Date.now(), failure: null, output: [], approval: null }, path: join(directory, `${id}.jsonl`),
        instance: null, hostGeneration: null, route: null, host: null, fenced: false, lifecycle: true, event: 0, refusedAt: null };
      entries.set(id, entry);
      persist(entry);
      try { return await start(entry, installation); } finally { entry.lifecycle = false; }
    },
    stop(id: string, generation: number): Promise<ManagedSession> { return stopEntry(selected(id, generation)); },
    async restart(id: string, generation: number, installation: Installation): Promise<ManagedSession> {
      const entry = selected(id, generation);
      if (installation.installationId !== entry.view.installationId) throw new AppError("conflict", "installation_mismatch");
      if (closed || closing) throw new AppError("busy");
      if (entry.lifecycle) throw new AppError("busy", "lifecycle_in_progress");
      entry.lifecycle = true;
      fence(entry, 1);
      try {
        await stopEntry(entry, true);
        change(entry, { generation: generation + 1, state: "restarting" });
        return await start(entry, installation);
      } finally { entry.lifecycle = false; fence(entry, -1); }
    },
    async send(id: string, generation: number, message: string): Promise<void> {
      const entry = selected(id, generation);
      admit(entry.view.installationId);
      if (!message.trim() || message.length > 1024 * 1024) throw new AppError("invalid_request");
      if (entry.fenced || entry.lifecycle || entry.view.state !== "ready") throw new AppError("busy");
      const host = entry.host;
      if (!host) throw new AppError("uncertain");
      change(entry, { state: "working" });
      await request(entry, host, "prompt", { message }, true);
    },
    async respond(id: string, generation: number, approvalId: string, value: string | boolean): Promise<void> {
      const entry = selected(id, generation);
      const approval = entry.view.approval;
      if (!approval || approval.id !== approvalId) throw new AppError("conflict", "stale_approval");
      if (approval.method === "confirm" ? typeof value !== "boolean" : typeof value !== "string") throw new AppError("invalid_request");
      if (approval.method === "select" && (typeof value !== "string" || !approval.options.includes(value))) throw new AppError("invalid_request");
      const host = entry.host;
      if (!host || host.broken) throw new AppError("uncertain");
      await request(entry, host, "extension_ui_response", { uiRequestId: approvalId,
        ...(approval.method === "confirm" ? { confirmed: value } : { value }) }, true);
      if (entry.view.approval?.id === approvalId) change(entry, { approval: null, state: "working" });
    },
    setAdmission(installationId: string, enabled: boolean): void {
      admissions.set(installationId, enabled);
      if (enabled) for (const entry of entries.values()) {
        if (entry.view.installationId === installationId && !entry.lifecycle && entry.host && !entry.host.broken)
          entry.fenced = false;
      }
      options.onChange();
    },
    async close(): Promise<void> {
      if (closed) return;
      if (closing) throw new AppError("busy", "close_in_progress");
      closing = true;
      try {
        for (const entry of entries.values()) {
          if (!entry.host) continue;
          if (entry.view.state !== "stopped") await stopEntry(entry);
        }
        closed = true;
      } finally { closing = false; }
    },
  };
}
