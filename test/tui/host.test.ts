import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { ServiceResponse } from "../../src/protocol";
import { openTerminalHost, HostError } from "../../src/tui/host";
import type { HostFrame, HostOptions, TerminalInput, TerminalOutput } from "../../src/tui/host";
import { readCatalog } from "../../src/catalog";
import type { CatalogObservation, CatalogReaders } from "../../src/catalog";
import { createDomain, domainStoreDirectory } from "../../src/service/domain";
import { serveDomainWorker, serveWorker } from "../../src/service/worker";
import { attachAuthenticatedWorker } from "../../src/service/client";
import { JobStore } from "../../src/jobs/store";
import type { NewJob } from "../../src/jobs/jobs";
import { catalogColumns, ink } from "../../src/tui/presentation";

class Input implements TerminalInput {
  isTTY = true;
  isRaw = false;
  isPaused = true;
  readonly raw: boolean[] = [];
  readonly data = new Set<(data: string) => void>();
  readonly ends = new Set<() => void>();
  setRawMode = (raw: boolean) => { this.isRaw = raw; this.raw.push(raw); };
  resume = () => { this.isPaused = false; };
  pause = () => { this.isPaused = true; };
  onData = (listener: (data: string) => void) => {
    this.data.add(listener); return () => { this.data.delete(listener); };
  };
  onClose = (listener: () => void) => {
    this.ends.add(listener); return () => { this.ends.delete(listener); };
  };
  send(key: string): void { for (const listener of this.data) listener(key); }
  end(): void { for (const listener of this.ends) listener(); }
}
class Output implements TerminalOutput {
  isTTY = true;
  columns = 80;
  rows = 24;
  bytes = "";
  fail = false;
  readonly resizes = new Set<() => void>();
  readonly ends = new Set<() => void>();
  write = (text: string) => {
    if (this.fail) throw new Error("PRIVATE_OUTPUT_ERROR");
    this.bytes += text;
  };
  onResize = (listener: () => void) => {
    this.resizes.add(listener); return () => { this.resizes.delete(listener); };
  };
  onClose = (listener: () => void) => {
    this.ends.add(listener); return () => { this.ends.delete(listener); };
  };
  resize(columns: number, rows: number): void {
    this.columns = columns; this.rows = rows;
    for (const listener of this.resizes) listener();
  }
}
function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HostError("terminal_failed")), 2000);
  })]).finally(() => clearTimeout(timer));
}
class Frames {
  readonly frames: HostFrame[] = [];
  readonly subscribers = new Set<(frame: HostFrame) => void>();
  receive = (frame: HostFrame) => {
    this.frames.push(frame);
    for (const listener of this.subscribers) listener(frame);
  };
  next(predicate: (frame: HostFrame) => boolean = frame => !frame.busy): Promise<HostFrame> {
    const signal = Promise.withResolvers<HostFrame>();
    const listener = (frame: HostFrame) => { if (predicate(frame)) signal.resolve(frame); };
    this.subscribers.add(listener);
    return deadline(signal.promise).finally(() => this.subscribers.delete(listener));
  }
}
const roots: string[] = [];
const workers: ReturnType<typeof serveWorker>[] = [];
const hosts: Awaited<ReturnType<typeof openTerminalHost>>[] = [];
const ports: { readonly input: Input; readonly output: Output }[] = [];
function directory(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "host-"));
  roots.push(root);
  return join(root, "w");
}
function spec(jobId = "job"): NewJob {
  return { jobId, requestId: `seed:${jobId}`, mode: "update-only", selectedTargets: [],
    installation: { installationId: "install", resourcesFingerprint: "fp",
      owner: { kind: "unknown", reason: "unverified_owner" },
      installedVersion: { kind: "unknown", reason: "not_captured" } } };
}
async function boot(readers?: CatalogReaders, count = 1) {
  const path = directory();
  const store = new JobStore(domainStoreDirectory(path));
  for (let i = 0; i < count; i++) store.create(spec(i === 0 ? "job" : `job:${i}`));
  store.close();
  const worker = await serveDomainWorker(path, readers, { home: dirname(path), path: join(dirname(path), "bin"), prefixes: [] });
  workers.push(worker);
  return { path, worker };
}
async function open(path: string, options: Omit<HostOptions, "directory" | "onFrame"> = {}) {
  const input = options.input instanceof Input ? options.input : new Input();
  const output = options.output instanceof Output ? options.output : new Output();
  const frames = new Frames();
  ports.push({ input, output });
  const host = await openTerminalHost({ ...options, directory: path, input, output, onFrame: frames.receive });
  hosts.push(host);
  return { input, output, frames, host, act: async (key: string) => {
    const next = frames.next();
    input.send(key);
    return next;
  } };
}
afterEach(async () => {
  for (const host of hosts.splice(0)) { host.close(); await host.closed; }
  for (const worker of workers.splice(0)) {
    await worker.stop();
    expect(worker.transport.connectionCount).toBe(0);
  }
  for (const { input, output } of ports.splice(0)) {
    expect([input.data.size, input.ends.size, output.resizes.size, output.ends.size]).toEqual([0, 0, 0, 0]);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
    expect(existsSync(root)).toBe(false);
  }
});

test("reads actual jobs while unavailable catalog stays separate from empty success", async () => {
  // Given
  const { path } = await boot({ candidates: [], sockets: [] });
  const terminal = await open(path);
  // When
  const frame = await terminal.act("2");
  // Then: machine identities and actual persisted status, not fixed prose.
  expect(frame.view).toBe("jobs");
  expect((await terminal.act("d")).text).toContain("job");
  expect(frame.text).toContain("queued");
  expect(terminal.frames.frames[1]?.notice).toContain("unsupported");
  const store = new JobStore(domainStoreDirectory(path));
  try { expect(store.get("job").revision).toBe(0); } finally { store.close(); }
});
test("routes inspect to real authenticated recovery without any mutation", async () => {
  // Given
  const { path } = await boot();
  const terminal = await open(path);
  await terminal.act("2");
  await terminal.act("\r");
  // When
  const frame = await terminal.act("i");
  // Then
  expect(frame.view).toBe("recovery");
  expect(frame.text).toContain("queued");
  const store = new JobStore(domainStoreDirectory(path));
  try { expect(store.get("job").revision).toBe(0); } finally { store.close(); }
});
test("persists one explicit cancellation and reopens against the surviving worker", async () => {
  // Given
  const { path, worker } = await boot();
  const terminal = await open(path, { afterSequence: 0 });
  await terminal.act("2");
  await terminal.act("\r");
  // When
  const frame = await terminal.act("c");
  terminal.host.close();
  await terminal.host.closed;
  const reopened = await open(path); // No fabricated current-cursor lookup after event 1.
  await reopened.act("2");
  const observed = await reopened.act("\r");
  // Then
  expect(frame.text).toContain("cancelled");
  expect(observed.text).toContain("cancelled");
  expect(worker.transport.sequence).toBe(1);
  expect(existsSync(worker.owner.socketPath)).toBe(true);
  const store = new JobStore(domainStoreDirectory(path));
  try { expect(store.get("job").revision).toBe(1); } finally { store.close(); }
});
test("observes externally committed event only after explicit subscription readiness", async () => {
  // Given
  const { path } = await boot();
  const terminal = await open(path, { afterSequence: 0 });
  await terminal.act("2");
  await terminal.act("\r");
  const client = await attachAuthenticatedWorker(path);
  const next = terminal.frames.next(frame => frame.text.includes("cancelled"));
  // When
  try { await client.request({ operation: "cancel-job", jobId: "job", expectedRevision: 0 }); }
  finally { client.close(); }
  // Then
  expect((await next).text).toContain("cancelled");
});
test("does not discover or retry an unsupported fresh cursor after sequence changed", async () => {
  // Given
  const { path } = await boot();
  const client = await attachAuthenticatedWorker(path);
  try { await client.request({ operation: "cancel-job", jobId: "job", expectedRevision: 0 }); }
  finally { client.close(); }
  const input = new Input(), output = new Output();
  ports.push({ input, output });
  // When / Then
  await expect(openTerminalHost({ directory: path, input, output, afterSequence: 0 })).rejects.toMatchObject({ code: "malformed_request" });
  expect(input.raw).toEqual([true, false]);
  expect(input.isPaused).toBe(true);
});
test("restores raw mode and own listeners on input close while preserving foreign listeners", async () => {
  // Given
  const { path } = await boot();
  const terminal = await open(path);
  let foreignCalls = 0;
  const foreign = () => { foreignCalls++; };
  terminal.input.data.add(foreign);
  // When
  terminal.input.end();
  await terminal.host.closed;
  terminal.host.close();
  terminal.input.send("q");
  // Then
  expect(terminal.input.raw).toEqual([true, false]);
  expect(terminal.input.isPaused).toBe(true);
  expect(foreignCalls).toBe(1);
  terminal.input.data.delete(foreign);
  expect(terminal.output.bytes.endsWith("\x1b[?25h\x1b[?1049l")).toBe(true);
  expect(terminal.output.bytes.endsWith(ink.normal + "\x1b[?25h\x1b[?1049l")).toBe(true);
});
test("retains already raw flowing input state on close", async () => {
  // Given
  const { path } = await boot();
  const input = new Input();
  input.isRaw = true; input.isPaused = false;
  const terminal = await open(path, { input });
  // When
  terminal.host.close();
  await terminal.host.closed;
  // Then
  expect(input.raw).toEqual([]);
  expect(input.isRaw).toBe(true);
  expect(input.isPaused).toBe(false);
});
test("bounds many jobs and CJK output at both real terminal sizes", async () => {
  // Given
  const { path, worker } = await boot(undefined, 35);
  const terminal = await open(path);
  await terminal.act("2");
  // When
  const small = terminal.frames.next();
  terminal.output.resize(80, 24);
  await small;
  const big = terminal.frames.next();
  terminal.output.resize(120, 40);
  await big;
  // Then
  const secret = readFileSync(worker.owner.tokenPath, "utf8");
  for (const frame of terminal.frames.frames) {
    expect(frame.text.split("\n").length).toBeLessThanOrEqual(frame.rows);
    expect(frame.text.split("\n").every(line => Bun.stringWidth(line) < frame.columns)).toBe(true);
    expect(frame.text).not.toContain(secret);
    expect(frame.text.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(frame.text.split("\n").every(line => Bun.stringWidth(line) === frame.columns - 1)).toBe(true);
  }
  expect(terminal.output.bytes).toContain(ink.focus + "[1 Catalog]");
  expect(terminal.output.bytes).toContain(ink.focus + "[2 Jobs]");
});
test("decodes split supported CSI input and navigates actual job identity", async () => {
  // Given
  const { path } = await boot(undefined, 2);
  const terminal = await open(path);
  await terminal.act("2");
  // When
  const next = terminal.frames.next();
  terminal.input.send("\x1b[");
  terminal.input.send("B");
  await next;
  const frame = await terminal.act("\r");
  // Then
  expect(frame.view).toBe("job");
  expect(frame.notice).toContain("job:1");
  expect(frame.text).not.toContain("job:1");
  expect((await terminal.act("d")).text).toContain("job:1");
});
test("closing during initial observation resolves without a closed-client failure", async () => {
  const { path } = await boot();
  const input = new Input(), output = new Output();
  const loading = openTerminalHost({ directory: path, input, output, onFrame: () => input.send("q") });
  const host = await loading;
  expect(host.isClosed).toBe(true);
  await host.closed;
  expect(input.isRaw).toBe(false);
});
test("fails closed and restores input when output throws without leaking raw error", async () => {
  // Given
  const { path } = await boot();
  const terminal = await open(path);
  // When
  terminal.output.fail = true;
  terminal.output.resize(120, 40);
  // Then
  await expect(terminal.host.closed).rejects.toMatchObject({ code: "terminal_failed" });
  // afterEach may await it again; the expected failed host has already been checked.
  hosts.splice(hosts.indexOf(terminal.host), 1);
  expect(terminal.input.raw).toEqual([true, false]);
  expect(terminal.output.bytes).not.toContain("PRIVATE_OUTPUT_ERROR");
});

const supported = { kind: "supported", reason: "verified", evidenceRef: "fixture-only" } as const;
const unsupported = { kind: "unsupported", reason: "missing_bridge" } as const;
function readers(): CatalogReaders {
  const observation: CatalogObservation = {
    contract: { version: 1, family: "omo",
      installation: { ...spec().installation, family: "omo", channel: "한글频道-stable",
        owner: { kind: "native", installerDigest: "fixture-digest", prefix: "/fixture" },
        installedVersion: { kind: "known", version: "1" }, executableRealpath: "/fixture/omo",
        resources: [{ resourceId: "r", realpath: "/fixture/omo", fingerprint: "fp" }] },
      runtime: null, capabilities: { check: supported, update: supported, busySafe: unsupported,
        completion: unsupported, resume: unsupported, gracefulExit: unsupported } },
    lastCheck: { checkedAt: 1, result: { kind: "update-available", installedVersion: "1", availableVersion: "2", checkedAt: 1 } },
  };
  return { candidates: [{ candidateId: "fixture", family: "omo",
    read: async () => ({ ok: true, value: structuredClone(observation) }) }], sockets: [] };
}
test("composes actual catalog and check intent but preserves worker unsupported authority", async () => {
  // Given
  const source = readers(), catalog = await readCatalog(source);
  const { path } = await boot(source);
  const terminal = await open(path, { catalog });
  // When
  const failed = terminal.frames.next(frame => frame.text.includes("unsupported"));
  await terminal.act("c");
  const frame = await deadline(failed);
  // Then
  expect(frame.view).toBe("catalog");
  expect(frame.text).toContain("unsupported");
  expect((await terminal.act("d")).text).toContain("한글频道");
});
test.each(["omo", "claude"] as const)("preparation is opt-in and only detaches missing-runner OmO: %s", async family => {
  const source = readers(), base = (await readCatalog(source)).installations[0];
  if (!base) throw new HostError("metadata_failed");
  const installation = { ...base, family };
  const path = directory(), operations: string[] = [];
  workers.push(serveWorker(path, request => {
    operations.push(request.operation);
    const envelope = { version: 1, requestId: request.requestId } as const;
    switch (request.operation) {
      case "installations": return { ...envelope, operation: "installations", ok: true, result: { installations: [installation] } };
      case "sessions": return { ...envelope, operation: "sessions", ok: true, result: { sessions: [], unavailableSources: 0 } };
      case "jobs": return { ...envelope, operation: "jobs", ok: true, result: { jobs: [] } };
      default: return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
    }
  }));
  const ordinary = await open(path);
  await ordinary.act("\r");
  expect(ordinary.host.isClosed).toBe(false);
  ordinary.host.close(); await ordinary.host.closed;
  const prepared = Promise.withResolvers<void>();
  let calls = 0;
  const input = new Input(), output = new Output();
  const terminal = await open(path, { input, output, onPrepareInstallation: selected => {
    expect(selected).toEqual(installation);
    expect([input.data.size, input.ends.size, output.resizes.size, output.ends.size]).toEqual([0, 0, 0, 0]);
    expect(input.isRaw).toBe(false);
    calls++; prepared.resolve();
  } });
  if (family === "omo") {
    input.send("\r"); await deadline(prepared.promise); await terminal.host.closed;
    expect(calls).toBe(1);
  } else {
    await terminal.act("\r"); expect(calls).toBe(0); expect(terminal.host.isClosed).toBe(false);
  }
  expect(operations).not.toContain("create-job");
});
test("checks latest automatically, keeps navigation responsive and applies c results without refresh", async () => {
  const path = directory(), installation = (await readCatalog(readers())).installations[0];
  if (!installation) throw new HostError("metadata_failed");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0;
  workers.push(serveWorker(path, async request => {
    const envelope = { version: 1, requestId: request.requestId } as const;
    switch (request.operation) {
      case "installations": return { ...envelope, operation: "installations", ok: true, result: { installations: [installation] } };
      case "sessions": return { ...envelope, operation: "sessions", ok: true, result: { sessions: [], unavailableSources: 0 } };
      case "jobs": return { ...envelope, operation: "jobs", ok: true, result: { jobs: [] } };
      case "check": {
        calls++;
        if (calls === 1) { entered.resolve(); await release.promise; }
        return { ...envelope, operation: "check", ok: true, result: { installationId: installation.installationId,
          result: calls === 1 ? { kind: "update-available", installedVersion: "1", availableVersion: "9.2.3", checkedAt: 1 }
            : { kind: "up-to-date", installedVersion: "1", checkedAt: 2 } } };
      }
      default: return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
    }
  }));
  const terminal = await open(path);
  await deadline(entered.promise);
  expect(terminal.frames.frames.at(-1)?.text).toContain("Checking");
  await terminal.act("ArrowDown");
  await terminal.act("c");
  expect(calls).toBe(1);
  const updated = terminal.frames.next(frame => frame.text.includes("9.2.3"));
  release.resolve();
  expect((await deadline(updated)).text).toContain("9.2.3");
  const checked = terminal.frames.next(frame => frame.notice === "Latest version checked; c recheck" && !frame.text.includes("9.2.3")
    && !frame.text.includes("Checking"));
  await terminal.act("c");
  const frame = await deadline(checked);
  const row = frame.text.split("\n").find(line => line.startsWith("| > omo")) ?? "";
  const widths = catalogColumns(frame.columns - 5);
  const start = 2 + (widths[0] ?? 0) + (widths[1] ?? 0) + 2;
  expect(Bun.sliceAnsi(row, start, start + (widths[2] ?? 0)).trim()).toBe("1");
  expect(calls).toBe(2);
});
test("starts independent refresh reads before installation discovery completes", async () => {
  // Given
  const path = directory();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const operations = new Set<string>();
  workers.push(serveWorker(path, async request => {
    operations.add(request.operation);
    if (operations.has("sessions") && operations.has("jobs")) entered.resolve();
    if (request.operation === "installations") await release.promise;
    return { version: 1, requestId: request.requestId, operation: request.operation,
      ok: false, error: { code: "unsupported" } };
  }));
  // When
  const opening = open(path);
  try {
    await entered.promise;
    // Then
    expect(operations).toEqual(new Set(["installations", "sessions", "jobs"]));
  } finally { release.resolve(); await opening; }
});
test.each([false, true])("bounds automatic and queued manual checks to three and cancels on close=%s", async close => {
  // Given: real authenticated transport; only check completion is gated.
  const path = directory(), base = (await readCatalog(readers())).installations[0];
  if (!base) throw new HostError("metadata_failed");
  const installations = Array.from({ length: 7 }, (_, index) => ({ ...base, installationId: `install:${index}` }));
  const entered = installations.map(() => Promise.withResolvers<void>());
  const releases = installations.map(() => Promise.withResolvers<void>());
  const calls: string[] = [];
  let active = 0, peak = 0;
  const worker = serveWorker(path, async request => {
    const envelope = { version: 1, requestId: request.requestId } as const;
    switch (request.operation) {
      case "installations": return { ...envelope, operation: "installations", ok: true, result: { installations } };
      case "sessions": return { ...envelope, operation: "sessions", ok: true, result: { sessions: [], unavailableSources: 0 } };
      case "jobs": return { ...envelope, operation: "jobs", ok: true, result: { jobs: [] } };
      case "check": {
        const index = installations.findIndex(row => row.installationId === request.installationId);
        calls.push(request.installationId); active++; peak = Math.max(peak, active);
        entered[index]?.resolve();
        try { await releases[index]?.promise; } finally { active--; }
        return { ...envelope, operation: "check", ok: true, result: { installationId: request.installationId,
          result: { kind: "up-to-date", installedVersion: "1", checkedAt: 1 } } };
      }
      default: return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
    }
  });
  workers.push(worker);
  const terminal = await open(path);
  try {
    // When: a manual check for an already queued installation stays deduplicated.
    await Promise.all(entered.slice(0, 3).map(event => event.promise));
    expect(calls).toHaveLength(3);
    for (const key of ["j", "j", "j", "c"]) await terminal.act(key);
    releases[0]?.resolve();
    await entered[3]?.promise;
    expect(calls).toHaveLength(4);
    if (close) {
      terminal.host.close(); await terminal.host.closed;
      const bytes = terminal.output.bytes.length;
      releases.forEach(event => event.resolve());
      await worker.stop(); workers.splice(workers.indexOf(worker), 1);
      expect(calls).toHaveLength(4);
      expect(terminal.output.bytes.length).toBe(bytes);
    } else {
      const complete = terminal.frames.next(frame => !frame.text.includes("Checking"));
      for (let index = 1; index < installations.length; index++) {
        await entered[index]?.promise;
        releases[index]?.resolve();
      }
      await complete;
      expect(calls).toEqual(installations.map(row => row.installationId));
    }
    // Then
    expect(peak).toBe(3);
  } finally { releases.forEach(event => event.resolve()); }
});
test("composes actual selection confirmation without inventing create success", async () => {
  // Given
  const source = readers(), catalog = await readCatalog(source);
  const installation = catalog.installations[0];
  if (!installation) throw new HostError("metadata_failed");
  const { path } = await boot(source);
  const terminal = await open(path, { catalog, selections: [
    { installation, update: supported, readiness: supported, targets: [] },
  ] });
  await terminal.act("s");
  await terminal.act("r");
  await terminal.act("\r");
  // When
  const frame = await terminal.act("\r");
  // Then
  expect(frame.view).toBe("selection");
  expect(frame.notice).toBe("unsupported");
  expect((await terminal.act("\x1b")).view).toBe("catalog");
  const store = new JobStore(domainStoreDirectory(path));
  try { expect(store.list().map(job => job.jobId)).toEqual(["job"]); } finally { store.close(); }
});
test("uses authenticated selection without injected maps and opens only the persisted created job", async () => {
  // Given: a real authenticated wire and real JobStore; this tests host plumbing,
  // not updater/native qualification. Creation remains queued, never completed.
  const path = directory(), catalog = await readCatalog(readers());
  const installation = catalog.installations[0];
  if (!installation) throw new HostError("metadata_failed");
  const store = new JobStore(domainStoreDirectory(path));
  let firstSelection = true;
  const worker = serveWorker(path, request => {
    const envelope = { version: 1, requestId: request.requestId } as const;
    switch (request.operation) {
      case "installations": return { ...envelope, operation: "installations", ok: true,
        result: { installations: [installation] } };
      case "runtimes": return { ...envelope, operation: "runtimes", ok: true, result: { runtimes: [] } };
      case "jobs": return { ...envelope, operation: "jobs", ok: true, result: { jobs: store.list() } };
      case "targets": {
        if (firstSelection) {
          firstSelection = false;
          return { ...envelope, operation: "targets", ok: false, error: { code: "unsupported" } };
        }
        return { ...envelope, operation: "targets", ok: true,
          result: { targets: [], selection: { installation, update: supported, readiness: supported, targets: [] } } };
      }
      case "check": return { ...envelope, operation: "check", ok: true,
        result: { installationId: installation.installationId,
          result: { kind: "update-available", installedVersion: "1.0.0", availableVersion: "2.0.0", checkedAt: 1 } } };
      case "create-job": {
        if (request.mode !== "update-only") return { ...envelope, operation: "create-job", ok: false, error: { code: "unsupported" } };
        const created = store.create({ jobId: "wire-selected-job", requestId: request.requestId,
          mode: request.mode, installation: request.installation, selectedTargets: [] });
        const response: ServiceResponse = { ...envelope, operation: "create-job", ok: true, result: created };
        worker.transport.publish(response);
        return response;
      }
      default: return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
    }
  }, () => store.close());
  workers.push(worker);
  const terminal = await open(path, { afterSequence: 0 });
  const refused = await terminal.act("s");
  expect(refused.view).toBe("catalog");
  expect(refused.notice).not.toBe("");
  expect((await terminal.act("\r")).notice).toBe("");
  await terminal.act("\r");
  // When: explicit second confirmation crosses the actual authenticated service.
  const frame = await terminal.act("\r");
  // Then: the actual persisted identity/status, not optimistic success.
  expect(frame.view).toBe("job");
  expect(frame.text).not.toContain("wire-selected-job");
  expect((await terminal.act("d")).text).toContain("wire-selected-job");
  expect(store.get("wire-selected-job").status).toBe("queued");
  expect(store.list()).toHaveLength(1);
});
test("reopened prepared host still requires explicit final confirmation and never prepares a runnable selection", async () => {
  const path = directory(), installation = (await readCatalog(readers())).installations[0];
  if (!installation) throw new HostError("metadata_failed");
  const store = new JobStore(domainStoreDirectory(path));
  let ready = false, preparations = 0;
  workers.push(serveWorker(path, request => {
    const envelope = { version: 1, requestId: request.requestId } as const;
    switch (request.operation) {
      case "installations": return { ...envelope, operation: "installations", ok: true, result: { installations: [installation] } };
      case "sessions": return { ...envelope, operation: "sessions", ok: true, result: { sessions: [], unavailableSources: 0 } };
      case "jobs": return { ...envelope, operation: "jobs", ok: true, result: { jobs: store.list() } };
      case "targets": return ready
        ? { ...envelope, operation: "targets", ok: true, result: { targets: [],
          selection: { installation, update: supported, readiness: supported, targets: [] } } }
        : { ...envelope, operation: "targets", ok: false, error: { code: "unsupported" } };
      case "create-job": {
        if (request.mode !== "update-only") throw new HostError("metadata_failed");
        return { ...envelope, operation: "create-job", ok: true, result: store.create({ jobId: "prepared-confirmed",
          requestId: request.requestId, installation: request.installation, mode: request.mode, selectedTargets: [] }) };
      }
      default: return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
    }
  }, () => store.close()));
  const requested = Promise.withResolvers<void>();
  const terminal = await open(path, { onPrepareInstallation: () => { preparations++; ready = true; requested.resolve(); } });
  terminal.input.send("\r"); await deadline(requested.promise); await terminal.host.closed;
  expect(store.list()).toHaveLength(0);
  const reopened = await open(path, { onPrepareInstallation: () => { preparations++; } });
  expect(store.list()).toHaveLength(0);
  expect((await reopened.act("\r")).view).toBe("selection");
  expect(store.list()).toHaveLength(0);
  await reopened.act("\r");
  expect(store.list()).toHaveLength(0);
  expect((await reopened.act("\r")).view).toBe("job");
  expect(store.get("prepared-confirmed").status).toBe("queued");
  expect(preparations).toBe(1);
});
test.each(["current", "native-current", "missing", "valid", "stale", "changed"] as const)(
  "handles Enter truthfully with %s selection evidence after an event-gated check", async state => {
    // Given: discovery has no lastCheck, as in the source-only domain path.
    const path = directory(), base = (await readCatalog(readers())).installations[0];
    if (!base) throw new HostError("metadata_failed");
    const installation = { ...base, lastCheck: null };
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const store = new JobStore(domainStoreDirectory(path));
    let creates = 0, targetReads = 0, changed = false;
    const worker = serveWorker(path, async request => {
      const envelope = { version: 1, requestId: request.requestId } as const;
      switch (request.operation) {
        case "installations": return { ...envelope, operation: "installations", ok: true,
          result: { installations: [{ ...installation, resourcesFingerprint: changed ? "changed" : installation.resourcesFingerprint }] } };
        case "sessions": return { ...envelope, operation: "sessions", ok: true, result: { sessions: [], unavailableSources: 0 } };
        case "jobs": return { ...envelope, operation: "jobs", ok: true, result: { jobs: store.list() } };
        case "check": {
          entered.resolve(); await release.promise;
          return { ...envelope, operation: "check", ok: true, result: { installationId: installation.installationId,
            result: state === "current" ? { kind: "up-to-date", installedVersion: "1", checkedAt: 2 }
              : { kind: "update-available", installedVersion: "1", availableVersion: "2", checkedAt: 2 } } };
        }
        case "targets": {
          targetReads++;
          return { ...envelope, operation: "targets", ok: true, result: { targets: [],
            ...(state === "missing" || state === "current" ? {} : { selection: {
              installation: { ...installation, resourcesFingerprint: state === "stale" ? "stale" : installation.resourcesFingerprint },
              ...(state === "native-current" ? { installation: { ...installation,
                lastCheck: { checkedAt: 2, result: { kind: "up-to-date", installedVersion: "1", checkedAt: 2 } } } } : {}),
              update: supported, readiness: supported, targets: [],
            } }) } };
        }
        case "create-job": {
          creates++;
          return { ...envelope, operation: "create-job", ok: true, result: store.create({ jobId: "enter-job",
            requestId: request.requestId, installation: request.installation,
            ...(request.mode === "update-only" ? { mode: request.mode, selectedTargets: request.selectedTargets }
              : { mode: request.mode, selectedTargets: request.selectedTargets }) }) };
        }
        default: return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
      }
    }, () => store.close());
    workers.push(worker);
    const terminal = await open(path);
    await deadline(entered.promise);
    // When: Enter arrives while the automatic check is still pending.
    const selected = terminal.frames.next(frame => !frame.busy);
    terminal.input.send("\r");
    release.resolve();
    const frame = await selected;
    // Then: absent authority never creates; valid authority reaches the persisted job.
    if (state === "valid" || state === "changed") {
      expect(frame.view).toBe("selection");
      await terminal.act("\r");
      changed = state === "changed";
      const confirmed = await terminal.act("\r");
      expect(confirmed.view).toBe(state === "valid" ? "job" : "selection");
      if (state === "changed") expect(confirmed.notice).toBe("stale_selection");
      expect(creates).toBe(state === "valid" ? 1 : 0);
    } else {
      expect(frame.view).toBe("catalog");
      expect(frame.notice).toBe(state === "current" || state === "native-current" ? "up-to-date"
        : state === "missing" ? "unsupported" : "stale_selection");
      expect(creates).toBe(0);
      expect(targetReads).toBe(state === "current" ? 0 : 1);
    }
    expect(store.list().map(job => job.jobId)).toEqual(state === "valid" ? ["enter-job"] : []);
  },
);
test("rejects stale supplemental catalog rather than manufacturing complete metadata", async () => {
  // Given
  const source = readers(), catalog = await readCatalog(source);
  const { path } = await boot(source);
  const terminal = await open(path, { catalog: { ...catalog, runtimes: [{
    runtimeId: "invented", installationId: "install", runningVersion: { kind: "unknown", reason: "not_captured" },
    binding: { socketId: "s", socketEpoch: "e", paneId: "p", paneGeneration: 0,
      rootIncarnation: { pid: 1, startIdentity: "PRIVATE", executableRealpath: "/fixture" },
      session: { kind: "conversation", fullId: "PRIVATE", storagePathHash: "PRIVATE" },
      cwd: "/fixture", optionsRef: "PRIVATE", turnGeneration: 0, resourcesFingerprint: "fp" },
  }] } });
  // When
  const frame = await terminal.act("s");
  // Then
  expect(frame.view).toBe("catalog");
  expect(frame.notice).toBe("unsupported");
  expect(frame.text).not.toContain("invented");
});
test("does not expose private bindings or terminal injection supplied by admitted wire DTOs", async () => {
  // Given: real authenticated endpoint, intentionally hostile display-only channel.
  const path = directory();
  const source = readers(), catalog = await readCatalog(source);
  const worker = serveWorker(path, request => {
    const envelope = { version: 1, requestId: request.requestId, operation: request.operation } as const;
    switch (request.operation) {
      case "installations": return { ...envelope, operation: "installations", ok: true,
        result: { installations: catalog.installations.map(row => ({ ...row,
          channel: "한글\u009d0;INJECTED_TITLE\u009c\u202e频道" })) } };
      case "runtimes": return { ...envelope, operation: "runtimes", ok: true, result: { runtimes: [] } };
      case "jobs": return { ...envelope, operation: "jobs", ok: true, result: { jobs: [] } };
      default: return { ...envelope, ok: false, error: { code: "unsupported" } };
    }
  });
  workers.push(worker);
  const terminal = await open(path);
  // When
  const frame = await terminal.act("1");
  // Then
  expect(frame.text).not.toContain("INJECTED_TITLE");
  expect(frame.text).not.toMatch(/[\x1b\u009d\u009c\u202e]/);
  expect(terminal.output.bytes).not.toContain("INJECTED_TITLE");
});
test("keeps pane counts unknown when authenticated runtime discovery fails", async () => {
  const path = directory(), catalog = await readCatalog(readers());
  let creates = 0;
  const worker = serveWorker(path, request => {
    if (request.operation === "create-job") creates++;
    const envelope = { version: 1, requestId: request.requestId } as const;
    switch (request.operation) {
      case "installations": return { ...envelope, operation: "installations", ok: true,
        result: { installations: catalog.installations } };
      case "jobs": return { ...envelope, operation: "jobs", ok: true, result: { jobs: [] } };
      default: return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
    }
  });
  workers.push(worker);
  const terminal = await open(path);
  const frame = await terminal.act("1");
  const row = frame.text.split("\n").find(line => line.startsWith("| > "));
  if (!row) throw new HostError("terminal_failed");
  const widths = catalogColumns(frame.columns - 5);
  const start = 2 + widths.slice(0, 3).reduce((sum, width) => sum + width + 1, 0);
  expect(Bun.sliceAnsi(row, start, start + (widths[3] ?? 0)).trim()).toBe("-");
  expect(frame.view).toBe("catalog");
  expect((await terminal.act("s")).view).toBe("catalog");
  expect(creates).toBe(0);
});
test("shows observed family counts without promoting idle panes into update authority", async () => {
  const path = directory(), catalog = await readCatalog(readers());
  const observed = [{ socketId: "socket:a", paneId: "pane:a", family: "omo", status: "working", workComplete: null },
    { socketId: "socket:a", paneId: "pane:b", family: "omo", status: "idle", workComplete: null }] as const;
  workers.push(serveWorker(path, request => {
    const envelope = { version: 1, requestId: request.requestId } as const;
    switch (request.operation) {
      case "installations": return { ...envelope, operation: "installations", ok: true,
        result: { installations: catalog.installations } };
      case "sessions": return { ...envelope, operation: "sessions", ok: true,
        result: { sessions: observed, unavailableSources: 0 } };
      case "jobs": return { ...envelope, operation: "jobs", ok: true, result: { jobs: [] } };
      default: return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
    }
  }));
  const terminal = await open(path);
  const first = terminal.frames.frames.at(-1);
  const next = await terminal.act("ArrowDown");
  const row = next.text.split("\n").find(line => line.startsWith("| > ")) ?? "";
  const widths = catalogColumns(next.columns - 5);
  let start = 2 + widths.slice(0, 3).reduce((sum, width) => sum + width + 1, 0);
  const counts = widths.slice(3).map(width => {
    const value = Bun.sliceAnsi(row, start, start + width).trim(); start += width + 1; return value;
  });
  expect(counts).toEqual(["2", "1", "-"]);
  expect(next.text.split("\n").filter(line => /^\| [ >] omo/.test(line))).toHaveLength(1);
  expect(Bun.stripANSI(first?.text ?? "").split("\n").filter(line => /^\| [ >] omo/.test(line))).toHaveLength(1);
  expect(next.text).not.toContain("/fixture/omo");
});
test("keeps jobs unavailable when the actual authenticated worker rejects the list", async () => {
  // Given
  const path = directory();
  const worker = serveWorker(path, request => ({
    version: 1, requestId: request.requestId, operation: request.operation,
    ok: false, error: { code: "resources_busy" },
  }));
  workers.push(worker);
  const terminal = await open(path);
  // When
  const frame = await terminal.act("2");
  // Then: an unavailable response must not become a successful empty list.
  expect(frame.notice).toBe("jobs: resources_busy");
  expect(frame.text).not.toMatch(/^JOBS 0/m);
});
test("retires pending read ownership on close without rendering its late response", async () => {
  // Given: barrier observes the exact inspection before terminal close.
  const path = directory();
  const store = new JobStore(domainStoreDirectory(path));
  store.create(spec());
  store.close();
  const domain = createDomain(path);
  const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const worker = serveWorker(path, async (request, signal) => {
    if (request.operation === "inspect-job") { received.resolve(); await release.promise; }
    return domain.handle(request, signal);
  }, domain.close);
  workers.push(worker);
  const terminal = await open(path);
  await terminal.act("2");
  await terminal.act("\r");
  // When
  const observed = deadline(received.promise);
  terminal.input.send("i");
  await observed;
  terminal.host.close();
  await terminal.host.closed;
  const length = terminal.output.bytes.length;
  release.resolve();
  await worker.stop(); // Drains the exact handler, not a guessed timing interval.
  workers.splice(workers.indexOf(worker), 1);
  // Then
  expect(terminal.output.bytes.length).toBe(length);
  expect(worker.transport.connectionCount).toBe(0);
  expect(terminal.input.raw).toEqual([true, false]);
});
test.each(["job", "recovery"] as const)("rejects held SQLite inspect rev0 after live cancel rev1 in %s", async initialView => {
  // Given: only scheduling is gated; authenticated DTOs come from the real domain.
  const path = directory();
  const seed = new JobStore(domainStoreDirectory(path));
  seed.create(spec());
  seed.close();
  const captured = Promise.withResolvers<ServiceResponse>(), release = Promise.withResolvers<void>();
  const hashes: string[] = [];
  let inspectCount = 0, cancelCount = 0;
  let domain: ReturnType<typeof createDomain> | undefined;
  const worker = serveWorker(path, async (request, signal) => {
    if (!domain) throw new HostError("metadata_failed");
    const response = await domain.handle(request, signal);
    if (request.operation === "cancel-job") cancelCount++;
    if (request.operation === "inspect-job" && ++inspectCount === (initialView === "job" ? 1 : 2)) {
      const hash = () => createHash("sha256").update(JSON.stringify(response)).digest("hex");
      hashes.push(hash());
      captured.resolve(response);
      await deadline(release.promise);
      hashes.push(hash());
    }
    return response;
  }, () => domain?.close());
  workers.push(worker);
  domain = createDomain(path, undefined, {
    admit: response => {
      expect(worker.transport.canPublish(response)).toBe(true);
      return null;
    },
    publish: response => { worker.transport.publish(response); },
  });
  let client: Awaited<ReturnType<typeof attachAuthenticatedWorker>> | undefined;
  try {
    const terminal = await open(path, { afterSequence: 0 });
    await terminal.act("2");
    await terminal.act("\r");
    if (initialView === "recovery") await terminal.act("i");
    client = await attachAuthenticatedWorker(path);
    const snapshotReady = deadline(captured.promise);
    terminal.input.send("iiii");
    const snapshot = await snapshotReady;
    if (snapshot.operation !== "inspect-job" || !snapshot.ok) throw new HostError("metadata_failed");
    expect(snapshot.result.job.revision).toBe(0);
    // When: wait for the exact rendered newer event before releasing the old reply.
    const newerReady = terminal.frames.next(frame => frame.busy && frame.text.includes("cancelled"));
    const committed = await client.request({ operation: "cancel-job", jobId: "job", expectedRevision: 0 });
    expect(committed.ok).toBe(true);
    const newer = await newerReady;
    expect(newer.view).toBe(initialView);
    const rejectedReady = terminal.frames.next(frame => !frame.busy && frame.notice === "revision_conflict");
    release.resolve();
    const rejected = await rejectedReady;
    // Then: reject ALL old consumer construction/normal-notice writes.
    expect(rejected.view).toBe(initialView);
    expect(rejected.notice).toBe("revision_conflict");
    expect(rejected.text).toContain("cancelled");
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
    expect(inspectCount).toBe(initialView === "job" ? 1 : 2);
    expect(cancelCount).toBe(1);
    const persisted = new JobStore(domainStoreDirectory(path));
    try {
      expect(persisted.get("job").revision).toBe(1);
      expect(persisted.get("job").status).toBe("cancelled");
    } finally { persisted.close(); }
  } finally { release.resolve(); client?.close(); }
});
test("selection r follows its real review route without entering recovery", async () => {
  // Given
  const source = readers(), catalog = await readCatalog(source);
  const installation = catalog.installations[0];
  if (!installation) throw new HostError("metadata_failed");
  const { path } = await boot(source);
  const terminal = await open(path, { catalog,
    selections: [{ installation, update: supported, readiness: supported, targets: [] }] });
  await terminal.act("s");
  // When / Then: state/routing, not pinned hint prose.
  const reviewed = await terminal.act("r");
  expect(reviewed.view).toBe("selection");
  expect(reviewed.text).toContain("reviewing");
  const confirmed = await terminal.act("\r");
  expect(confirmed.view).toBe("selection");
  expect(confirmed.text).toContain("confirming");
  expect((await terminal.act("\r")).notice).toBe("unsupported");
});
test("opening another persisted job replaces the previous job action context", async () => {
  // Given
  const { path } = await boot(undefined, 2);
  const store = new JobStore(domainStoreDirectory(path));
  try {
    store.change({ jobId: "job:1", expectedRevision: 0 },
      { kind: "intent", operationId: "uncertain-job:1", effect: "updated", targetId: null });
    store.change({ jobId: "job:1", expectedRevision: 1 },
      { kind: "observe", targetId: null, receipt: { kind: "uncertain", operationId: "uncertain-job:1" } });
  } finally { store.close(); }
  const terminal = await open(path);
  await terminal.act("2");
  await terminal.act("\r");
  const cancelled = await terminal.act("c");
  // When
  await terminal.act("2");
  await terminal.act("j");
  const next = await terminal.act("\r");
  // Then: notice identifies the selected machine entity, not the last action.
  expect(next.notice).not.toBe(cancelled.notice);
  expect(next.notice).toContain("job:1");
  expect(next.text).toContain("recovery_required");
  const persisted = new JobStore(domainStoreDirectory(path));
  try {
    expect(persisted.get("job").status).toBe("cancelled");
    expect(persisted.get("job:1").status).toBe("recovery_required");
    expect(persisted.get("job:1").revision).toBe(2);
  } finally { persisted.close(); }
});
