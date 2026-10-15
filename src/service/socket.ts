import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, validateRequest } from "../protocol";
import type { BoundaryFailure, RejectedRequest, ServiceRequest, ServiceResponse } from "../protocol";

export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_INPUT_QUEUE_BYTES = 4 * MAX_FRAME_BYTES;
const MAX_OUTPUT_QUEUE_BYTES = 4 * MAX_RESPONSE_BYTES;
export class TransportError extends Error {
  constructor(readonly code: "owner_conflict" | "closed" | "aborted" | "protocol" | "overflow") {
    super(code);
    this.name = "TransportError";
  }
}
export type RequestHandler = (request: ServiceRequest, signal: AbortSignal) => ServiceResponse | Promise<ServiceResponse>;
export type SocketEvent = {
  readonly kind: "event";
  readonly incarnation: string;
  readonly sequence: number;
  readonly response: ServiceResponse;
};
export type PrivateEndpoint = {
  readonly directory: string;
  readonly socketPath: string;
  readonly tokenPath: string;
  readonly incarnation: string;
};
/** Complete logical values, not truncated DTOs. Reserve the largest safe
 * sequence and fixed UUID width so publication fits before a transaction commits.
 */
export function responseFits(response: ServiceResponse, event = false): boolean {
  const value = event ? { kind: "event", incarnation: "00000000-0000-0000-0000-000000000000",
    sequence: Number.MAX_SAFE_INTEGER, response } : response;
  return Buffer.byteLength(JSON.stringify(value)) <= MAX_RESPONSE_BYTES;
}
// Mutable per-connection framing and backpressure state, never persisted.
type Peer = {
  input: Buffer;
  output: Buffer;
  busy: boolean;
  subscribed: boolean;
  ending: boolean;
  readonly controller: AbortController;
};
function rejected(code: BoundaryFailure["code"]): RejectedRequest {
  return { version: PROTOCOL_VERSION, requestId: null, ok: false, error: { code } };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parse(frame: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
}
function flush(socket: Bun.Socket<Peer>): void {
  const peer = socket.data;
  if (peer.output.length) peer.output = peer.output.subarray(socket.write(peer.output));
  socket.flush();
  if (peer.ending && peer.output.length === 0) socket.end();
}
function send(socket: Bun.Socket<Peer>, value: unknown): void {
  const frame = Buffer.from(`${JSON.stringify(value)}\n`);
  let queuedMessages = 0;
  for (let cursor = socket.data.output.indexOf(10); cursor !== -1; cursor = socket.data.output.indexOf(10, cursor + 1))
    queuedMessages++;
  if (queuedMessages >= 64 || frame.length > MAX_RESPONSE_BYTES + 1 ||
      socket.data.output.length + frame.length > MAX_OUTPUT_QUEUE_BYTES) {
    socket.terminate();
    return;
  }
  socket.data.output = Buffer.concat([socket.data.output, frame]);
  flush(socket);
}
function sameFile(path: string, identity: { readonly ino: number; readonly dev: number }): boolean {
  try {
    const current = lstatSync(path);
    return current.ino === identity.ino && current.dev === identity.dev;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Exclusive directory creation is the ownership fence. Unknown stale owners are
 * refused, not inferred dead from a PID. stop only removes this incarnation's files.
 * Subscription is live-only: cursor must equal the current sequence and incarnation.
 */
export function startPrivateSocket(directory: string, handler: RequestHandler) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new TransportError("owner_conflict");
    throw error;
  }
  const directoryIdentity = lstatSync(directory);
  const socketPath = join(directory, "service.sock");
  const tokenPath = join(directory, "capability");
  const incarnation = randomUUID();
  const bindPath = join(directory, incarnation.slice(0, 8));
  const token = randomBytes(32).toString("hex");
  const peers = new Set<Bun.Socket<Peer>>();
  let sequence = 0;
  let stopped = false;
  const endpoint: PrivateEndpoint = { directory, socketPath, tokenPath, incarnation };
  let listener: ReturnType<typeof Bun.listen<Peer>> | undefined;
  let socketIdentity: Stats | undefined;
  let tokenIdentity: Stats | undefined;
  function cleanup(): void {
    if (!sameFile(directory, directoryIdentity)) return;
    if (socketIdentity && sameFile(socketPath, socketIdentity)) unlinkSync(socketPath);
    if (tokenIdentity && sameFile(tokenPath, tokenIdentity)) unlinkSync(tokenPath);
    // A foreign file is a dirty owner boundary; never recursively delete it.
    try { rmdirSync(directory); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error;
    }
  }
  function fail(socket: Bun.Socket<Peer>, code: BoundaryFailure["code"]): void {
    socket.data.ending = true;
    send(socket, rejected(code));
  }
  async function dispatch(socket: Bun.Socket<Peer>, frame: Buffer): Promise<void> {
    const peer = socket.data;
    let input: unknown;
    try { input = parse(frame); } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) { fail(socket, "malformed_request"); return; }
      throw error;
    }
    const subscription = record(input) && input["kind"] === "subscribe";
    const validated = validateRequest(subscription && record(input) ? input["request"] : input, token);
    if (!validated.ok) { fail(socket, validated.error.code); return; }
    if (subscription && record(input)) {
      if (Object.keys(input).length !== 4 || input["incarnation"] !== incarnation
        || (input["afterSequence"] !== "current" && input["afterSequence"] !== sequence)) {
        fail(socket, "malformed_request"); return;
      }
      peer.subscribed = true;
      send(socket, { kind: "subscribed", incarnation, sequence });
      return;
    }
    const request = validated.value;
    let response: ServiceResponse;
    try {
      response = await handler(request, peer.controller.signal);
      if (response.requestId !== request.requestId || response.operation !== request.operation || response.version !== PROTOCOL_VERSION) {
        throw new TransportError("protocol");
      }
    } catch {
      // Runtime boundary: never publish an exception, credential, or stack.
      response = { version: PROTOCOL_VERSION, requestId: request.requestId, operation: request.operation,
        ok: false, error: { code: "recovery_required" } };
    }
    if (!peer.controller.signal.aborted && !stopped) send(socket, response);
  }
  function consume(socket: Bun.Socket<Peer>): void {
    const peer = socket.data;
    if (peer.busy || peer.ending || peer.controller.signal.aborted) return;
    const newline = peer.input.indexOf(10);
    if (newline < 0) {
      if (peer.input.length > MAX_FRAME_BYTES) fail(socket, "malformed_request");
      return;
    }
    if (newline > MAX_FRAME_BYTES || peer.subscribed) { fail(socket, "malformed_request"); return; }
    const frame = peer.input.subarray(0, newline);
    peer.input = peer.input.subarray(newline + 1);
    peer.busy = true;
    void dispatch(socket, frame).finally(() => { peer.busy = false; consume(socket); });
  }
  try {
    chmodSync(directory, 0o700);
    writeFileSync(tokenPath, token, { mode: 0o600, flag: "wx" });
    tokenIdentity = lstatSync(tokenPath);
    listener = Bun.listen<Peer>({
      unix: bindPath,
      socket: {
        open(socket) {
          socket.data = { input: Buffer.alloc(0), output: Buffer.alloc(0), busy: false,
            subscribed: false, ending: false, controller: new AbortController() };
          peers.add(socket);
        },
        data(socket, data) {
          if (socket.data.input.length + data.length > MAX_INPUT_QUEUE_BYTES) { fail(socket, "malformed_request"); return; }
          socket.data.input = Buffer.concat([socket.data.input, data]);
          consume(socket);
        },
        drain: flush,
        end(socket) {
          if (socket.data.input.length) fail(socket, "malformed_request");
          else socket.end();
        },
        close(socket) { socket.data.controller.abort(); peers.delete(socket); },
        error(socket) { socket.data.controller.abort(); socket.terminate(); },
      },
    });
    socketIdentity = lstatSync(bindPath);
    chmodSync(bindPath, 0o600);
    // Bun stop unlinks its original bind pathname unconditionally. Rename before
    // exposing the endpoint so native cleanup cannot unlink a public replacement.
    renameSync(bindPath, socketPath);
  } catch (error) {
    listener?.stop(true);
    cleanup();
    throw error;
  }
  return {
    endpoint,
    get sequence() { return sequence; },
    get connectionCount() { return peers.size; },
    canPublish(response: ServiceResponse): boolean {
      return !stopped && Number.isSafeInteger(sequence + 1) && responseFits(response, true);
    },
    publish(response: ServiceResponse): SocketEvent {
      if (stopped) throw new TransportError("closed");
      const event: SocketEvent = { kind: "event", incarnation, sequence: sequence + 1, response };
      if (!Number.isSafeInteger(event.sequence) || Buffer.byteLength(JSON.stringify(event)) > MAX_RESPONSE_BYTES)
        throw new TransportError("overflow");
      sequence++;
      for (const socket of peers) if (socket.data.subscribed) send(socket, event);
      return event;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const socket of peers) { socket.data.controller.abort(); socket.terminate(); }
      peers.clear();
      listener?.stop(true);
      cleanup();
    },
  };
}
export type PrivateSocketServer = ReturnType<typeof startPrivateSocket>;
export function stopPrivateSocket(server: PrivateSocketServer): void { server.stop(); }

/** Client returns parsed unknown wire values deliberately: domain consumers must
 * decode their operation result, rather than casting unauthenticated JSON to a job.
 * One outstanding next per connection; queued events are bounded and not polled.
 */
export async function connectPrivateSocket(socketPath: string, signal = AbortSignal.timeout(5000)) {
  let input = Buffer.alloc(0);
  const queue: { readonly value: unknown; readonly bytes: number }[] = [];
  let queuedBytes = 0;
  let failure: TransportError | undefined;
  let waiter: { resolve: (value: unknown) => void; reject: (error: TransportError) => void } | undefined;
  let socket: Bun.Socket | undefined;
  function close(code: TransportError["code"] = "closed"): void {
    failure ??= new TransportError(code);
    waiter?.reject(failure);
    waiter = undefined;
    queue.length = 0;
    socket?.terminate();
    signal.removeEventListener("abort", abort);
  }
  const abort = () => close("aborted");
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new TransportError("aborted");
    socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_socket, data) {
          input = Buffer.concat([input, data]);
          let newline: number;
          while ((newline = input.indexOf(10)) >= 0) {
            if (newline > MAX_RESPONSE_BYTES) { close("overflow"); return; }
            const frame = input.subarray(0, newline);
            input = input.subarray(newline + 1);
            let value: unknown;
            try { value = parse(frame); } catch { close("protocol"); return; }
            if (waiter) { const pending = waiter; waiter = undefined; pending.resolve(value); }
            else {
              queuedBytes += frame.length;
              if (queuedBytes > MAX_OUTPUT_QUEUE_BYTES || queue.length >= 64) { close("overflow"); return; }
              queue.push({ value, bytes: frame.length });
            }
          }
          if (input.length > MAX_RESPONSE_BYTES) close("overflow");
        },
        close() { close(); },
        end() { close(); },
        error() { close(); },
      },
    });
    if (failure) { socket.terminate(); throw failure; }
  } catch {
    close(signal.aborted ? "aborted" : "closed");
    throw failure;
  }
  const connected = socket;
  return {
    send(value: unknown): void {
      if (failure) throw failure;
      const frame = Buffer.from(`${JSON.stringify(value)}\n`);
      if (frame.length > MAX_FRAME_BYTES + 1) throw new TransportError("overflow");
      // A request is bounded; partial acceptance fails closed, never blind retries.
      if (connected.write(frame) !== frame.length) { close("overflow"); throw failure; }
      connected.flush();
    },
    next(): Promise<unknown> {
      const queued = queue.shift();
      if (queued) { queuedBytes -= queued.bytes; return Promise.resolve(queued.value); }
      if (failure) return Promise.reject(failure);
      if (waiter) return Promise.reject(new TransportError("protocol"));
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    close,
  };
}
export async function requestPrivateSocket(endpoint: PrivateEndpoint, request: ServiceRequest, signal?: AbortSignal): Promise<unknown> {
  const client = await connectPrivateSocket(endpoint.socketPath, signal);
  try { const response = client.next(); client.send(request); return await response; }
  finally { client.close(); }
}
export async function subscribePrivateSocket(endpoint: PrivateEndpoint, request: ServiceRequest, afterSequence: number, signal?: AbortSignal) {
  const client = await connectPrivateSocket(endpoint.socketPath, signal);
  try {
    const ready = client.next();
    client.send({ kind: "subscribe", request, incarnation: endpoint.incarnation, afterSequence });
    const ack = await ready;
    if (!record(ack) || ack["kind"] !== "subscribed" || ack["incarnation"] !== endpoint.incarnation || ack["sequence"] !== afterSequence) {
      throw new TransportError("protocol");
    }
    return client;
  } catch (error) { client.close(); throw error; }
}
