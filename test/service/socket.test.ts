import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  connectPrivateSocket, MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, requestPrivateSocket, startPrivateSocket,
  stopPrivateSocket, subscribePrivateSocket, TransportError,
} from "../../src/service/socket";
import type { PrivateSocketServer, RequestHandler } from "../../src/service/socket";
import type { Job, ServiceRequest, ServiceResponse } from "../../src/protocol";

const roots: string[] = [];
const servers: PrivateSocketServer[] = [];
const clients: { close(): void }[] = [];
function directory(): string {
  // Short, per-run namespace stays within macOS sockaddr_un limits.
  const root = mkdtempSync(join(tmpdir(), "ipc-"));
  roots.push(root);
  return join(root, "private");
}
function start(handler: RequestHandler = request => ({
  version: 1, requestId: request.requestId, operation: request.operation,
  ok: false, error: { code: "unsupported" },
})): PrivateSocketServer {
  const server = startPrivateSocket(directory(), handler);
  servers.push(server);
  return server;
}
function request(server: PrivateSocketServer, requestId = "qa-1"): ServiceRequest {
  // Read only the newly created disposable capability; never output its value.
  return { version: 1, requestId, token: readFileSync(server.endpoint.tokenPath, "utf8"), operation: "jobs" };
}
function jobs(requestId = "qa-1"): ServiceResponse {
  return { version: 1, requestId, operation: "jobs", ok: true, result: { jobs: [] } };
}
function sizedJobs(bytes: number, requestId = "qa-1"): ServiceResponse {
  const makeJob = (index: number) => ({ jobId: `job-${index}`, requestId: `request-${index}`, revision: 0,
    mode: "update-only", status: "queued", selectedTargets: [], targetTxns: [], failure: null,
    installTxn: { state: "queued", receipt: null, failure: null, selection: { installationId: "install",
      resourcesFingerprint: "f", owner: { kind: "unknown", reason: "unverified_owner" },
      installedVersion: { kind: "unknown", reason: "not_captured" } } } }) satisfies Job;
  const envelope = { version: 1, requestId, operation: "jobs", ok: true } as const;
  const rows: ReturnType<typeof makeJob>[] = [];
  let size = Buffer.byteLength(JSON.stringify({ ...envelope, result: { jobs: rows } }));
  for (let index = 0; ; index++) {
    const job = makeJob(index);
    const additional = Buffer.byteLength(JSON.stringify(job)) + (rows.length ? 1 : 0);
    if (size + additional > bytes) break;
    rows.push(job); size += additional;
  }
  const last = rows.pop();
  if (!last) throw new TransportError("protocol");
  rows.push({ ...last, installTxn: { ...last.installTxn,
    selection: { ...last.installTxn.selection, resourcesFingerprint: `f${"x".repeat(bytes - size)}` } } });
  return { ...envelope, result: { jobs: rows } };
}
async function client(server: PrivateSocketServer) {
  const connection = await connectPrivateSocket(server.endpoint.socketPath);
  clients.push(connection);
  return connection;
}
afterEach(() => {
  for (const connection of clients.splice(0)) connection.close();
  for (const server of servers.splice(0)) {
    server.stop();
    expect(server.connectionCount).toBe(0);
  }
  for (const root of roots.splice(0)) {
    // Assert transport cleanup before removing the test-owned container.
    expect(readdirSync(root)).toEqual([]);
    rmdirSync(root);
    expect(existsSync(root)).toBe(false);
  }
});

test("happy actual Unix requests and sequence events are enqueued before triggers", async () => {
  // Given: authenticated live subscription has received the server's ready ACK.
  const server = start(req => jobs(req.requestId));
  const subscription = await subscribePrivateSocket(server.endpoint, request(server), 0);
  clients.push(subscription);
  const first = subscription.next();
  // When: a real request completes and two events are published without polling.
  const response = await requestPrivateSocket(server.endpoint, request(server));
  const event1 = server.publish(jobs());
  const event2 = server.publish(jobs("qa-2"));
  // Then: both sequential events, including one received before next(), survive.
  expect(response).toEqual(jobs());
  expect(await first).toEqual(event1);
  expect(await subscription.next()).toEqual(event2);
  expect([event1.sequence, event2.sequence]).toEqual([1, 2]);
});

test.each([0, 1])("complete response ceiling is enforced by the real sender and receiver at offset%s", async offset => {
  // Given
  const expected = sizedJobs(MAX_RESPONSE_BYTES + offset);
  expect(Buffer.byteLength(JSON.stringify(expected))).toBe(MAX_RESPONSE_BYTES + offset);
  const server = start(req => sizedJobs(MAX_RESPONSE_BYTES + offset, req.requestId));
  // When / Then
  if (offset === 0) expect(await requestPrivateSocket(server.endpoint, request(server))).toEqual(expected);
  else await expect(requestPrivateSocket(server.endpoint, request(server))).rejects.toEqual(new TransportError("closed"));
});

test.each([0, 1])("event ceiling includes its complete wrapper at offset%s without advancing rejection", async offset => {
  // Given: real subscription is acknowledged before publication.
  const server = start();
  const stream = await subscribePrivateSocket(server.endpoint, request(server), 0, AbortSignal.timeout(2000));
  clients.push(stream);
  const wrapperBytes = Buffer.byteLength(JSON.stringify({ kind: "event", incarnation: server.endpoint.incarnation,
    sequence: 1, response: jobs() })) - Buffer.byteLength(JSON.stringify(jobs()));
  const response = sizedJobs(MAX_RESPONSE_BYTES - wrapperBytes + offset);
  // When / Then
  if (offset === 0) {
    const next = stream.next(), event = server.publish(response);
    expect(Buffer.byteLength(JSON.stringify(event))).toBe(MAX_RESPONSE_BYTES);
    expect(await next).toEqual(event);
    expect(server.sequence).toBe(1);
  } else {
    expect(() => server.publish(response)).toThrow(new TransportError("overflow"));
    expect(server.sequence).toBe(0);
  }
});

test("client rejects an oversized response from a raw peer independently of server protection", async () => {
  // Given: test-only raw peer, with a deterministic partial-write pump.
  const path = directory(), frame = Buffer.from(`${JSON.stringify(sizedJobs(MAX_RESPONSE_BYTES + 1))}\n`);
  type Pending = { outgoing: Buffer };
  function pump(socket: Bun.Socket<Pending>): void {
    socket.data.outgoing = socket.data.outgoing.subarray(socket.write(socket.data.outgoing));
    socket.flush();
  }
  const listener = Bun.listen<Pending>({ unix: path, socket: {
    open(socket) { socket.data = { outgoing: frame }; },
    data: pump, drain: pump,
  } });
  const connection = await connectPrivateSocket(path, AbortSignal.timeout(2000));
  try {
    const response = connection.next();
    // When
    connection.send({ trigger: true });
    // Then
    await expect(response).rejects.toEqual(new TransportError("overflow"));
  } finally { connection.close(); listener.stop(true); }
});

test.each([64, 65])("admits exactly 64 queued messages and fails closed on 65 with batch size %s", async count => {
  // Capture the real connection's production data callback. Invoke that callback
  // atomically with NDJSON, so OS fragmentation or consumer timing cannot decide
  // whether all frames were queued before next(). The socket itself stays real.
  const server = start(req => jobs(req.requestId)), original = Bun.connect;
  let receive: Bun.SocketHandler<unknown>["data"];
  let raw: Bun.Socket<unknown> | undefined;
  const capture = spyOn(Bun, "connect").mockImplementation(async options => {
    if (!("unix" in options)) throw new TypeError("fixture_unix_only");
    receive = options.socket.data;
    const connected = await original(options);
    raw = connected;
    return connected;
  });
  let connection: Awaited<ReturnType<typeof connectPrivateSocket>>;
  try { connection = await client(server); }
  finally { capture.mockRestore(); }
  if (!receive || !raw) throw new TypeError("fixture_data_handler");
  const batch = Buffer.from(Array.from({ length: count }, (_, index) => `${JSON.stringify(jobs(`queued-${index}`))}\n`).join(""));
  // No waiter is installed while the actual parser fills its queue.
  await receive(raw, batch);
  if (count === 65) {
    await expect(connection.next()).rejects.toEqual(new TransportError("overflow"));
  } else {
    for (let index = 0; index < 64; index++) expect(await connection.next()).toEqual(jobs(`queued-${index}`));
    // The unmodified underlying connection still authenticates and responds.
    const response = connection.next();
    connection.send(request(server));
    expect(await response).toEqual(jobs());
  }
});

test.each([
  { name: "malformed JSON", input: "{", code: "malformed_request" },
  { name: "unsupported version", input: { version: 2 }, code: "unsupported_version" },
  { name: "bad token", input: { version: 1, requestId: "qa-1", operation: "jobs", token: "b".repeat(64) }, code: "unauthorized" },
  { name: "missing token", input: { version: 1, requestId: "qa-1", operation: "jobs" }, code: "malformed_request" },
])("malformed/auth $name rejects before handler mutation", async ({ input, code }) => {
  // Given: the handler has an observable mutation counter, not a mock call assertion.
  let mutations = 0;
  const server = start(req => { mutations++; return jobs(req.requestId); });
  const connection = await client(server);
  const response = connection.next();
  // When: malformed values go across an actual Unix connection.
  connection.send(input);
  // Then: exact public boundary errors, no raw payload, no mutation.
  expect(await response).toEqual({ version: 1, requestId: null, ok: false, error: { code } });
  expect(mutations).toBe(0);
});

test("framing accepts fragmented coalesced NDJSON and rejects oversized bytes", async () => {
  // Given: a real raw Bun client observes each response before it writes.
  let mutations = 0;
  const server = start(req => { mutations++; return jobs(req.requestId); });
  const frames: unknown[] = [];
  const paired = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  let input = "";
  let outgoing = Buffer.alloc(0);
  function pump(socket: Bun.Socket): void {
    if (outgoing.length === 0) return;
    const accepted = socket.write(outgoing);
    expect(accepted).toBeGreaterThanOrEqual(0);
    outgoing = outgoing.subarray(accepted);
    socket.flush();
  }
  const socket = await Bun.connect({
    unix: server.endpoint.socketPath,
    socket: {
      drain: pump,
      data(_socket, data) {
        input += data.toString();
        let newline: number;
        while ((newline = input.indexOf("\n")) >= 0) {
          frames.push(JSON.parse(input.slice(0, newline)));
          input = input.slice(newline + 1);
          if (frames.length === 2) paired.resolve();
          if (frames.length === 3) ready.resolve();
        }
      },
    },
  });
  clients.push({ close: () => socket.terminate() });
  const deadline = AbortSignal.timeout(3000);
  deadline.addEventListener("abort", () => ready.reject(new TransportError("aborted")), { once: true });
  const frame = JSON.stringify(request(server));
  // When: split and coalesced requests are followed by a multi-byte oversized frame.
  socket.write(frame.slice(0, 20));
  socket.write(`${frame.slice(20)}\n${frame}\n`);
  socket.flush();
  await paired.promise;
  outgoing = Buffer.from(`${"é".repeat(MAX_FRAME_BYTES / 2 + 1)}\n`);
  pump(socket);
  await ready.promise;
  // Then: two requests execute; oversized bytes do not invoke the handler.
  expect(frames).toEqual([jobs(), jobs(), { version: 1, requestId: null, ok: false, error: { code: "malformed_request" } }]);
  expect(mutations).toBe(2);
});

test("concurrency rejects a second owner without unlinking the first listener", async () => {
  // Given: an active owner with two concurrent clients.
  const server = start(req => jobs(req.requestId));
  // When: a competing owner and concurrent requests target its directory.
  expect(() => startPrivateSocket(server.endpoint.directory, req => jobs(req.requestId))).toThrow("owner_conflict");
  const responses = await Promise.all(["qa-a", "qa-b"].map(id => requestPrivateSocket(server.endpoint, request(server, id))));
  // Then: ownership files and the original listener remain functional.
  expect(responses).toEqual([jobs("qa-a"), jobs("qa-b")]);
  expect(lstatSync(server.endpoint.socketPath).isSocket()).toBe(true);
});

test("cancel closes a pending transport and notifies the handler with an abort", async () => {
  // Given: the handler's entered and aborted events are installed before triggering.
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const server = start(async (req, signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    await aborted.promise;
    return jobs(req.requestId);
  });
  const controller = new AbortController();
  const connection = await connectPrivateSocket(server.endpoint.socketPath, controller.signal);
  clients.push(connection);
  const response = connection.next();
  const outcome = response.then(value => value, (error: unknown) => error);
  connection.send(request(server));
  await entered.promise;
  // When: the consumer cancels; no domain cancellation policy is invented.
  controller.abort();
  expect(await outcome).toEqual(new TransportError("aborted"));
  await aborted.promise;
  // Then: transport is closed and handler cancellation is observable.
  expect(() => connection.send(request(server))).toThrow("aborted");
});

test("stale incarnation and sequence cannot subscribe to a new owner", async () => {
  // Given: the old owner was stopped and replaced at the same private path.
  const first = start();
  const oldEndpoint = first.endpoint;
  first.stop();
  const replacement = startPrivateSocket(oldEndpoint.directory, req => jobs(req.requestId));
  servers.push(replacement);
  // When: stale incarnation or stale sequence is presented using the new token.
  await expect(subscribePrivateSocket(oldEndpoint, request(replacement), 0)).rejects.toThrow("protocol");
  replacement.publish(jobs());
  await expect(subscribePrivateSocket(replacement.endpoint, request(replacement), 0)).rejects.toThrow("protocol");
  // Then: stopping the old owner again must not remove the replacement.
  first.stop();
  expect(await requestPrivateSocket(replacement.endpoint, request(replacement))).toEqual(jobs());
});

test("dirty and stale directories are preserved without PID-based reclamation", () => {
  // Given: an unknown stale directory contains a file owned by another incarnation.
  const path = directory();
  mkdirSync(path, { mode: 0o700 });
  const foreign = join(path, "foreign");
  writeFileSync(foreign, "foreign-owner");
  // When: startup sees an existing owner boundary.
  expect(() => startPrivateSocket(path, req => jobs(req.requestId))).toThrow("owner_conflict");
  // Then: evidence is preserved; only test-owned teardown removes it.
  expect(readFileSync(foreign, "utf8")).toBe("foreign-owner");
  rmSync(path, { recursive: true });
});

test.each(["socketPath", "tokenPath"] as const)("dirty replacement of %s survives the old owner's stop", key => {
  // Given: a same-UID writer has changed a pathname's filesystem incarnation.
  const server = start();
  const original = server.endpoint.directory;
  const path = server.endpoint[key];
  renameSync(path, `${path}.saved`);
  writeFileSync(path, "foreign-owner");
  // When: the old owner stops, it has no authority over the replacement inode.
  server.stop();
  // Then: no blind unlink occurred; fixture teardown removes its own dirty files.
  expect(readFileSync(path, "utf8")).toBe("foreign-owner");
  rmSync(original, { recursive: true });
});

test("hung handler does not hold stop open and resources are removed", async () => {
  // Given: a pending handler explicitly waits for a signal rather than a sleep.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = start(async req => { entered.resolve(); await release.promise; return jobs(req.requestId); });
  const connection = await client(server);
  const response = connection.next();
  const outcome = response.then(value => value, (error: unknown) => error);
  connection.send(request(server));
  await entered.promise;
  // When: the listener is stopped while its handler is blocked.
  stopPrivateSocket(server);
  expect(await outcome).toEqual(new TransportError("closed"));
  release.resolve();
  // Then: no listening endpoint, credential, or directory remains.
  expect(existsSync(server.endpoint.directory)).toBe(false);
  expect(server.connectionCount).toBe(0);
});

test("flaky disconnect does not retry a request or invent success", async () => {
  // Given: the handler stops its real listener after receiving exactly one request.
  let mutations = 0;
  const server = start(req => { mutations++; server.stop(); return jobs(req.requestId); });
  // When: response delivery is interrupted after dispatch.
  await expect(requestPrivateSocket(server.endpoint, request(server))).rejects.toThrow("closed");
  // Then: no automatic retry or fake completed response exists.
  expect(mutations).toBe(1);
});

test.each(["throw", "wrong-request", "wrong-operation"] as const)("misleading %s result becomes a sanitized failure", async kind => {
  // Given: a failing/mis-correlated handler, including secret-shaped exception content.
  const server = start(req => {
    switch (kind) {
      case "throw": throw new Error("ULW_SECRET_REDACTION_fixture");
      case "wrong-request": return jobs("unrelated");
      case "wrong-operation": return { version: 1, requestId: req.requestId, operation: "runtimes", ok: true, result: { runtimes: [] } };
      default: { const unreachable: never = kind; throw new TypeError(String(unreachable)); }
    }
  });
  // When: a request actually crosses the listener boundary.
  const response = await requestPrivateSocket(server.endpoint, request(server));
  // Then: no exception text, stack, secret, or false success leaves the transport.
  expect(response).toEqual({ version: 1, requestId: "qa-1", operation: "jobs", ok: false, error: { code: "recovery_required" } });
});

test("repeated interruptions remove each actual socket before replacement", async () => {
  // Given: one test-owned path is reused across independent owner incarnations.
  const path = directory();
  // When: every live subscription is interrupted by stop, with next registered first.
  for (let i = 0; i < 5; i++) {
    const server = startPrivateSocket(path, req => jobs(req.requestId));
    servers.push(server);
    const subscription = await subscribePrivateSocket(server.endpoint, request(server), 0);
    clients.push(subscription);
    const outcome = subscription.next().then(value => value, (error: unknown) => error);
    server.stop();
    expect(await outcome).toEqual(new TransportError("closed"));
    // Then: all actual resources are absent before the next owner can start.
    expect(existsSync(path)).toBe(false);
    expect(existsSync(server.endpoint.socketPath)).toBe(false);
    expect(existsSync(server.endpoint.tokenPath)).toBe(false);
    expect(server.connectionCount).toBe(0);
  }
});

test("auxiliary Bun invocation captures private endpoint rejection and actual modes", async () => {
  // Given: a real listener and an auxiliary process; credentials are stdin, never argv.
  let mutations = 0;
  const server = start(req => { mutations++; return jobs(req.requestId); });
  const source = `
    const token = (await Bun.stdin.text()).trim();
    for (const [action, frame] of [
      ["malformed-json", "{\\n"],
      ["bad-token", JSON.stringify({version:1,requestId:"aux-1",operation:"jobs",token:"b".repeat(64)})+"\\n"],
      ["valid-request", JSON.stringify({version:1,requestId:"aux-1",operation:"jobs",token})+"\\n"],
    ]) {
      const response = Promise.withResolvers();
      let input = "";
      const socket = await Bun.connect({unix:process.argv[1],socket:{data(s,d){
        input += d.toString(); if(input.includes("\\n")) response.resolve(JSON.parse(input));
      }}});
      socket.write(frame);
      socket.flush();
      console.log(JSON.stringify({action,response:await response.promise}));
      socket.terminate();
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", source, server.endpoint.socketPath], {
    cwd: new URL("../../", import.meta.url).pathname,
    stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  child.stdin.write(request(server).token);
  child.stdin.end();
  // When: independent Bun clients send malformed/auth/valid frames over the Unix path.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  // Then: explicit transcript, zero negative mutations, actual OS permission stats.
  const transcript: unknown[] = stdout.trim().split("\n").map(line => JSON.parse(line));
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(transcript).toEqual([
    { action: "malformed-json", response: { version: 1, requestId: null, ok: false, error: { code: "malformed_request" } } },
    { action: "bad-token", response: { version: 1, requestId: null, ok: false, error: { code: "unauthorized" } } },
    { action: "valid-request", response: jobs("aux-1") },
  ]);
  expect(mutations).toBe(1); // Only the valid request reached the injected handler.
  const modes = {
    directory: lstatSync(server.endpoint.directory).mode & 0o777,
    socket: lstatSync(server.endpoint.socketPath).mode & 0o777,
    token: lstatSync(server.endpoint.tokenPath).mode & 0o777,
  };
  expect(modes).toEqual({ directory: 0o700, socket: 0o600, token: 0o600 });
  console.log(JSON.stringify({
    privateEndpoint: transcript, negativeMutations: 0, modes, auxiliaryExit: exitCode,
    target: server.endpoint, auxiliaryPid: child.pid,
  }));
});
