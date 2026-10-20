import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createController } from "./controller";
import type { CurrentConversationContext } from "./observations";
import { parseCommand } from "./validation";
import { privateDirectory } from "./store";
import { AppError } from "./types";
import { browserSessions, browserSessionSeconds } from './browser-auth';
import type { AppResponse, AppSnapshot, CommandEnvelope } from "./types";

const ownerSchema = z.object({ version: z.literal(1), pid: z.number().int().positive(), instance: z.string().uuid(),
  origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/), secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ServerOwner = z.infer<typeof ownerSchema>;
/** The recorded owner process no longer exists (crash, reboot, kill -9), so its record and
 * lock only block the next start. An owner that is alive is never touched, even when it does
 * not answer. */
function ownerAlive(owner: ServerOwner): boolean {
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}
export function readLiveServerOwner(directory: string): ServerOwner | null {
  const owner = readServerOwner(directory);
  if (!owner || ownerAlive(owner)) return owner;
  for (const name of ["server.json", "server.lock"]) {
    try { unlinkSync(join(directory, name)); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  return null;
}
export function readServerOwner(directory: string): ServerOwner | null {
  const path = join(directory, "server.json");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
    throw new AppError("unauthorized");
  return ownerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
const conversationSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string(),
  id: z.string(), path: z.string().startsWith("/") }).strict().nullable();
export async function controlServer(owner: ServerOwner, action: "status" | "open" | "stop",
  currentConversation?: CurrentConversationContext | null) {
  const response = await fetch(`${owner.origin}/internal/control`, {
    method: "POST", headers: { authorization: `Bearer ${owner.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ action, instance: owner.instance, ...(currentConversation === undefined ? {} : { currentConversation }) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new AppError(response.status === 409 ? "busy" : "unavailable");
  const result = z.object({ pid: z.number(), instance: z.string(), origin: z.string(),
    url: z.string().optional(), service: z.string() }).strict().parse(await response.json());
  if (result.pid !== owner.pid || result.instance !== owner.instance || result.origin !== owner.origin)
    throw new AppError("unauthorized");
  return result;
}
export async function commandServer(owner: ServerOwner, command: CommandEnvelope): Promise<unknown> {
  const response = await fetch(`${owner.origin}/internal/command`, {
    method: "POST", headers: { authorization: `Bearer ${owner.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ instance: owner.instance, request: command }), signal: AbortSignal.timeout(30_000),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new AppError(response.status === 409 ? "busy" : "uncertain");
  return value;
}

type Options = {
  readonly directory: string;
  readonly home: string;
  readonly path: string;
  readonly prefixes: readonly string[];
  readonly port?: number;
  readonly assets?: string;
  readonly managedEnv?: Readonly<Record<string, string>>;
  readonly currentConversation?: CurrentConversationContext | null;
  readonly herdrSocket?: string | null;
};
const empty: AppSnapshot = { revision: 0, service: "connecting", installations: [], managed: [], external: [],
  operations: [], policies: [], failure: null };

export async function startServer(options: Options) {
  privateDirectory(options.directory);
  const assets = options.assets ?? fileURLToPath(new URL("../../dist/web/", import.meta.url));
  if (["index.html", "main.js", "main.css"].some(name => !lstatSync(join(assets, name), { throwIfNoEntry: false })?.isFile()))
    throw new AppError("unavailable", "web_assets_missing");
  if (readLiveServerOwner(options.directory)) throw new AppError("conflict", "service_already_owned");
  const lockPath = join(options.directory, "server.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new AppError("conflict", "service_already_owned");
    throw error;
  }
  const lockIdentity = lstatSync(lockPath);
  function releaseLock(): void {
    const current = lstatSync(lockPath, { throwIfNoEntry: false });
    if (current?.ino === lockIdentity.ino && current.dev === lockIdentity.dev) unlinkSync(lockPath);
    closeSync(lock);
  }
  const instance = randomUUID(), secret = randomBytes(32).toString("hex");
  let sessions:ReturnType<typeof browserSessions>;
  try{sessions=browserSessions(options.directory);}
  catch(error){releaseLock();throw error;}
  const bootstrap = new Map<string, number>();
  let controller: Awaited<ReturnType<typeof createController>> | undefined;
  let observed:AppSnapshot = {...empty,serverInstance:instance}, closing = false, initialized = false;
  const observers = new Set<() => void>();
  const closed = Promise.withResolvers<void>();
  function token(): string {
    for (const [value, expiry] of bootstrap) if (expiry <= Date.now()) bootstrap.delete(value);
    const value = randomBytes(32).toString("hex");
    bootstrap.set(value, Date.now() + 300_000);
    return value;
  }
  function same(a: string, b: string): boolean {
    return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
  function headers(extra: Record<string, string> = {}): Headers {
    const result = new Headers(extra);
    result.set("cache-control", "no-store");
    result.set("x-content-type-options", "nosniff");
    result.set("referrer-policy", "no-referrer");
    result.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return result;
  }
  function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
    return Response.json(value, { status, headers: headers(extra) });
  }
  async function body(request: Request): Promise<unknown> {
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new AppError("invalid_request");
    try { return await request.json(); }
    catch (error) {
      if (error instanceof SyntaxError) throw new AppError("invalid_request");
      throw error;
    }
  }
  async function close(): Promise<void> {
    if (closing) throw new AppError("busy");
    if (!initialized) throw new AppError("busy", "service_initializing");
    closing = true;
    try {
      await controller?.close();
      for (const listener of observers) listener();
      observers.clear();
      await server.stop(false);
      const owner = readServerOwner(options.directory);
      if (owner?.instance === instance) unlinkSync(join(options.directory, "server.json"));
      releaseLock();
      closed.resolve();
    } catch (error) { closing = false; throw error; }
  }
  let server: Bun.Server<undefined>;
  try { server = Bun.serve({
    hostname: "127.0.0.1", port: options.port ?? 0, maxRequestBodySize: 64 * 1024,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url), origin = `http://127.0.0.1:${server.port}`;
      if (request.headers.get("host") !== `127.0.0.1:${server.port}`) return json({ error: "unauthorized" }, 403);
      const cookieName = `cli_updater_${server.port}`;
      try {
        if (url.pathname === "/internal/command" && request.method === "POST") {
          if (!same(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) return json({ error: "unauthorized" }, 403);
          const input = z.object({ instance: z.literal(instance), request: z.unknown() }).strict().parse(await body(request));
          if (!controller || closing) throw new AppError("unavailable");
          const command = parseCommand(input.request);
          if (command.command.kind !== "refresh" && command.command.kind !== "native-restart") throw new AppError("invalid_request");
          const snapshot = { ...await controller.command(command), serverInstance: instance };
          return json({ ok: true, snapshot } satisfies AppResponse);
        }
        if (url.pathname === "/internal/control" && request.method === "POST") {
          if (!same(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) return json({ error: "unauthorized" }, 403);
          const input = z.object({ action: z.enum(["status", "open", "stop"]), instance: z.literal(instance),
            currentConversation: conversationSchema.optional() }).strict().parse(await body(request));
          const status = { pid: process.pid, instance, origin, service: observed.service };
          if (input.action === "open") {
            if (input.currentConversation !== undefined && controller && !closing) controller.bindCurrentConversation(input.currentConversation);
            return json({ ...status, url: `${origin}/#token=${token()}` });
          }
          if (input.action === "stop") {
            // Reply before tearing down the response's listener.
            if (!initialized || !controller) throw new AppError("busy");
            await controller.close();
            controller = undefined;
            queueMicrotask(() => { void close().catch(() => { process.exitCode = 1; }); });
          }
          return json(status);
        }
        if (url.pathname === "/" && request.method === "GET")
          return new Response(Bun.file(join(assets, "index.html")), { headers: headers({ "content-type": "text/html; charset=utf-8" }) });
        if (url.pathname === "/assets/brand.svg" && request.method === "GET")
          return new Response(Bun.file(join(assets, "brand.svg")), { headers: headers({ "content-type": "image/svg+xml" }) });
        if (request.method === "GET" && /^\/assets\/(?:symbol-(?:sheep|terminal-transparent)|logo-horizontal-(?:light|dark)|favicon-(?:16|32|48|64|180|192|512)|app-icon-(?:128|256|512|1024)|apple-touch-icon)\.png$/.test(url.pathname))
          return new Response(Bun.file(join(assets, url.pathname.slice("/assets/".length))), { headers: headers({ "content-type": "image/png" }) });
        if (url.pathname === "/assets/favicon.ico" && request.method === "GET")
          return new Response(Bun.file(join(assets, "favicon.ico")), { headers: headers({ "content-type": "image/x-icon" }) });
        if (request.method === "GET" && (url.pathname === "/assets/main.js" || url.pathname === "/assets/main.css"))
          return new Response(Bun.file(join(assets, url.pathname.endsWith(".js") ? "main.js" : "main.css")),
            { headers: headers({ "content-type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" }) });
        if (url.pathname === "/api/session" && request.method === "POST") {
          if (request.headers.get("origin") !== origin) return json({ error: "unauthorized" }, 403);
          const input = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await body(request));
          const expiry = bootstrap.get(input.token);
          bootstrap.delete(input.token);
          if (expiry === undefined || expiry <= Date.now()) return json({ error: "unauthorized" }, 401);
          return json({ ok: true }, 200, { "set-cookie": `${cookieName}=${sessions.issue()}; Max-Age=${browserSessionSeconds}; HttpOnly; SameSite=Strict; Path=/` });
        }
        const cookie = request.headers.get("cookie")?.split(";").map(value => value.trim())
          .find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
        if (!cookie || !sessions.accepts(cookie)) return json({ error: "unauthorized" }, 401);
        if (request.headers.has("origin") && request.headers.get("origin") !== origin)
          return json({ error: "unauthorized" }, 403);
        if (url.pathname === "/api/state" && request.method === "GET") return json(observed);
        if (url.pathname === "/api/events" && request.method === "GET") {
          server.timeout(request, 0);
          let dispose = () => {};
          let deliver = () => {};
          const stream = new ReadableStream<Uint8Array>({
            start(output) {
              let last = -1, ended = false;
              const emit = () => {
                if (ended) return;
                if (closing) { ended = true; output.close(); observers.delete(emit); return; }
                if ((output.desiredSize ?? 0) > 0 && last !== observed.revision) {
                  last = observed.revision;
                  output.enqueue(new TextEncoder().encode(`event: snapshot\nid: ${last}\ndata: ${JSON.stringify(observed)}\n\n`));
                }
              };
              observers.add(emit);
              deliver = emit;
              dispose = () => {
                ended = true; observers.delete(emit);
                request.signal.removeEventListener("abort", dispose);
              };
              request.signal.addEventListener("abort", dispose, { once: true });
              emit();
            },
            pull() { deliver(); },
            cancel() { dispose(); },
          });
          return new Response(stream, { headers: headers({ "content-type": "text/event-stream", connection: "keep-alive" }) });
        }
        if (url.pathname === "/api/command" && request.method === "POST") {
          if (request.headers.get("origin") !== origin) return json({ error: "unauthorized" }, 403);
          if (!controller || closing) throw new AppError("unavailable");
          const requestBody = parseCommand(await body(request));
          const snapshot = {...await controller.command(requestBody),serverInstance:instance};
          return json({ ok: true, snapshot } satisfies AppResponse);
        }
        return json({ error: "not_found" }, 404);
      } catch (error) {
        const code = error instanceof AppError ? error.detail : error instanceof z.ZodError ? "invalid_request" : "unavailable";
        return json({ ok: false, error: code, snapshot: observed } satisfies AppResponse,
          error instanceof AppError && (error.code === "busy" || error.code === "conflict") ? 409 : 400);
      }
    },
  }); } catch (error) { releaseLock(); throw error; }
  const owner: ServerOwner = { version: 1, pid: process.pid, instance, origin: `http://127.0.0.1:${server.port}`, secret };
  try { writeFileSync(join(options.directory, "server.json"), JSON.stringify(owner), { mode: 0o600, flag: "wx" }); }
  catch (error) { await server.stop(true); releaseLock(); throw error; }
  void createController(options).then(value => {
    controller = value;
    observed = {...value.snapshot(),serverInstance:instance};
    value.subscribe(() => { observed = {...value.snapshot(),serverInstance:instance}; for (const observer of observers) observer(); });
    initialized = true;
    for (const observer of observers) observer();
  }, error => {
    initialized = true;
    observed = { ...empty, serverInstance:instance,revision: 1, service: "unavailable", failure: error instanceof AppError ? error.detail : "unavailable" };
    for (const observer of observers) observer();
  });
  return { owner, url: `${owner.origin}/#token=${token()}`, closed: closed.promise, close };
}
