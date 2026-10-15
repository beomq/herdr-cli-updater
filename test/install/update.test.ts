import { expect, test } from "bun:test";
import { watch, readFileSync, readdirSync, writeFileSync, renameSync, statSync } from "node:fs";
import { access, chmod, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { Socket } from "node:net";
import { consumeOmoUpdate } from "../../src/install/update";
import type { OmoConsumerReceipt } from "../../src/install/update";
import { getOmoUpdateIntent } from "../../src/adapters/update-context";
import { fixture, hash, now, value } from "../../.omo/evidence/herdr-cli-updater/task22/r2/fixture";

// allow: SIZE_OK — the only authorized consumer test entry owns the complete
// real-process authority/receipt/recovery boundary. Fixture construction is
// already separate in task22 evidence; do not scatter these effect regressions
// into sibling test modules outside this task's ownership.
type Fixture = Awaited<ReturnType<typeof fixture>>;
function rows(f: Fixture): OmoConsumerReceipt[] {
  return readdirSync(f.journal).flatMap(name => readFileSync(join(f.journal, name), "utf8").trim().split("\n")
    .filter(Boolean).map(line => {
      const receipt: OmoConsumerReceipt = JSON.parse(line);
      return receipt;
    }));
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  const completion = Promise.withResolvers<T>();
  const timer = setTimeout(() => completion.reject(new TypeError("fixture_event_timeout")), 5000);
  promise.then(result => { clearTimeout(timer); completion.resolve(result); },
    error => { clearTimeout(timer); completion.reject(error); });
  return completion.promise;
}
function subscribe(f: Fixture, predicate: (receipts: readonly OmoConsumerReceipt[]) => boolean) {
  const event = Promise.withResolvers<void>();
  const watcher = watch(f.journal, () => { if (predicate(rows(f))) event.resolve(); });
  return { promise: bounded(event.promise), close: () => watcher.close() };
}
async function effects(f: Fixture): Promise<number> {
  try { return (await readFile(f.effects, "utf8")).trim().split("\n").filter(Boolean).length; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}
async function cleanup(f: Fixture) {
  const recordedPids = rows(f).filter(row => row.kind === "launched").map(row => row.pid);
  let exited: ReturnType<typeof subscribe> | undefined;
  const live = recordedPids.some(pid => {
    if (pid === undefined) throw new TypeError("fixture_pid");
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  });
  if (live && !rows(f).some(row => row.kind === "exit")) {
    exited = subscribe(f, receipts => receipts.some(row => row.kind === "exit") && receipts.at(-1)?.kind === "recovery_required");
    f.release();
    try { await exited.promise; } finally { exited.close(); }
  }
  // A corrupt journal is not an authoritative process inventory. Keep the
  // actual shim's effect PID available even when its exit callback erased rows.
  const observation: { pid: number; registryPort: number } | undefined = await effects(f) > 0
    ? JSON.parse((await readFile(f.effects, "utf8")).trim()) : undefined;
  const pids = new Set([...recordedPids, ...(observation ? [observation.pid] : [])]);
  for (const pid of pids) {
    if (pid === undefined) throw new TypeError("fixture_pid");
    expect(() => process.kill(pid, 0)).toThrow();
  }
  if (observation) {
    const socket = new Socket();
    try {
      // Register the exact refusal before probing this operation's own registry.
      const refused = bounded(once(socket, "error"));
      socket.connect(observation.registryPort, "127.0.0.1");
      expect((await refused)[0]).toMatchObject({ code: "ECONNREFUSED" });
    } finally { socket.destroy(); }
    expect((await readdir(f.home)).filter(name => name.startsWith(".herdr-update-cache-"))).toEqual([]);
  }
  expect(await f.cleanup()).toEqual({ rootsRemaining: 0, socketsRemaining: 0 });
  await expect(access(f.root)).rejects.toMatchObject({ code: "ENOENT" });
}

test("rejects zero exit without actual verified installed artifacts", async () => {
  // Given: real isolated manager exits zero but deliberately changes no files.
  const f = await fixture("no-change");
  try {
    const spec = await f.spec();
    // When
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now });
    // Then: authoritative exit is not an installation success.
    expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
    expect(rows(f).find(row => row.kind === "exit")?.status).toBe(0);
    expect(rows(f).some(row => row.kind === "files-verified")).toBe(false);
    expect(await effects(f)).toBe(1);
  } finally { await cleanup(f); }
});

test.each(["update-only", "update-and-restart"] as const)("verifies actual installed hashes and durable ordering for %s", async mode => {
  // Given: actual production adapter/check/issuer and a pinned isolated manager.
  const f = await fixture();
  try {
    const spec = await f.spec(mode);
    const intent = value(getOmoUpdateIntent(spec));
    // When
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now });
    // Then: only real postflight verification can complete this private operation.
    expect(result).toEqual({ ok: true, value: { kind: "files-verified", intent, durableReceipt: true } });
    const receipts = rows(f);
    expect(receipts.map(row => row.kind)).toEqual(["intent", "dispatch", "launched", "exit", "files-verified"]);
    expect(receipts.every(row => JSON.stringify(row.intent) === JSON.stringify(intent))).toBe(true);
    expect(receipts.find(row => row.kind === "exit")).toMatchObject({ status: 0, signal: null });
    for (const [path, expected] of f.files) expect(hash(await readFile(path))).toBe(hash(expected));
    expect(JSON.parse(await readFile(join(f.wrapper, "package.json"), "utf8")).version).toBe("5.1.10");
    expect(await effects(f)).toBe(1);
    expect(JSON.parse(await readFile(f.effects, "utf8"))).toMatchObject({ intentBeforeEffect: true, environmentExact: true, argsExact: true });
  } finally { await cleanup(f); }
});

test.each(["copy", "json", "generic", "forged"] as const)("rejects %s specs without a process or private registry effect", async kind => {
  // Given
  const f = await fixture();
  try {
    const issued = await f.spec();
    const { execution: _context, ...generic } = issued;
    const candidate = kind === "copy" ? { ...issued } : kind === "generic" ? generic
      : kind === "json" ? JSON.parse(JSON.stringify(issued)) : { ...issued, execution: { kind: "omo-official-update" } as const };
    // When
    const result = await consumeOmoUpdate(candidate, { receiptRoot: f.journal, now: () => now });
    // Then: serialized/raw CommandSpec is never a launch grant.
    expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
    expect(await effects(f)).toBe(0);
    expect(await readdir(f.home)).toEqual([]);
    expect(await readdir(f.journal)).toEqual([]);
  } finally { await cleanup(f); }
});

test("rejects caller getters without invoking them or granting execution", async () => {
  // Given
  const f = await fixture();
  try {
    const spec = await f.spec();
    let getterCalls = 0;
    Object.defineProperty(spec, "execution", { enumerable: true, get() { getterCalls++; return f.context; } });
    // When
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now });
    // Then
    expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
    expect(getterCalls).toBe(0);
    expect(await effects(f)).toBe(0);
  } finally { await cleanup(f); }
});

test("rejects a forged execution context even on an authentic issued spec identity", async () => {
  // Given: structural equality of a handle is not its private WeakMap identity.
  const f = await fixture();
  try {
    const spec = await f.spec();
    Reflect.set(spec, "execution", { kind: "omo-official-update" });
    // When: only the existing executeOmoUpdate context table can authorize this.
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now });
    // Then
    expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
    expect(await effects(f)).toBe(0);
    expect(await readdir(f.home)).toEqual([]);
    expect(rows(f).some(row => row.kind === "dispatch")).toBe(false);
  } finally { await cleanup(f); }
});

test("refuses a used context even with another authentic issued object and root", async () => {
  // Given: both actual issued objects exist before the first mutation.
  const f = await fixture();
  try {
    const first = await f.spec(), second = await f.spec();
    value(await consumeOmoUpdate(first, { receiptRoot: f.journal, now: () => now }));
    const otherRoot = join(f.root, "other-journal");
    await mkdir(otherRoot, { mode: 0o700 });
    // When
    const replay = await consumeOmoUpdate(second, { receiptRoot: otherRoot, now: () => now });
    // Then
    expect(replay).toEqual({ ok: false, error: { code: "verification_failed" } });
    expect(await readdir(otherRoot)).toEqual([]);
    expect(await effects(f)).toBe(1);
  } finally { await cleanup(f); }
});

test.each(["launched", "exit"] as const)("retains authoritative exit and no replay after %s notification throws", async stage => {
  // Given: hostile callback payload must never be coerced/logged.
  const f = await fixture();
  try {
    const spec = await f.spec();
    let inspections = 0;
    const payload = { toJSON() { inspections++; throw null; }, toString() { inspections++; throw null; } };
    // When
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now,
      event: async receipt => { if (receipt.kind === stage) throw payload; } });
    // Then: the launched process really ran, exited, and is never retried.
    expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
    expect(rows(f).find(row => row.kind === "exit")).toMatchObject({ status: 0, signal: null });
    expect(rows(f).at(-1)?.kind).toBe("recovery_required");
    expect(rows(f).some(row => row.kind === "files-verified")).toBe(false);
    expect(await effects(f)).toBe(1);
    expect(inspections).toBe(0);
    expect((await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now })).ok).toBe(false);
    expect(await effects(f)).toBe(1);
  } finally { await cleanup(f); }
});

test.each(["manager", "dispatch-config"] as const)("rejects %s drift before real launch", async writer => {
  // Given
  const f = await fixture();
  try {
    const spec = await f.spec();
    if (writer === "manager") writeFileSync(f.manager, "changed");
    // When
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now,
      event: async receipt => {
        if (writer === "dispatch-config" && receipt.kind === "dispatch") writeFileSync(join(f.home, ".env"), "SYNTHETIC_PRIVATE_CONFIG");
      } });
    // Then: existing qualifier rechecks even after yielding the dispatch hook.
    expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
    expect(await effects(f)).toBe(0);
    expect(rows(f).some(row => row.kind === "launched")).toBe(false);
  } finally { await cleanup(f); }
});

test.each(["corrupt", "nonzero"] as const)("refuses %s real-manager results", async behavior => {
  // Given
  const f = await fixture(behavior);
  try {
    const spec = await f.spec();
    // When
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now });
    // Then
    expect(result).toEqual({ ok: false, error: { code: behavior === "nonzero" ? "update_failed" : "recovery_required" } });
    expect(rows(f).find(row => row.kind === "exit")?.status).toBe(behavior === "nonzero" ? 29 : 0);
    expect(rows(f).some(row => row.kind === "files-verified")).toBe(false);
    expect(await effects(f)).toBe(1);
  } finally { await cleanup(f); }
});

test("keeps unknown hung effect in recovery until cooperative release without killing or relaunching", async () => {
  // Given: pipe/IPC readiness subscription exists before action.
  const f = await fixture("hang");
  const controller = new AbortController();
  let final: ReturnType<typeof subscribe> | undefined;
  try {
    const spec = await f.spec();
    const pending = consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now, signal: controller.signal });
    await bounded(f.ready);
    const pid = rows(f).find(row => row.kind === "launched")?.pid;
    if (pid === undefined) throw new TypeError("fixture_pid");
    // When: lose observation while the actual manager is waiting on release IPC.
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { code: "recovery_required" } });
    expect(process.kill(pid, 0)).toBe(true);
    expect(rows(f).some(row => row.kind === "exit")).toBe(false);
    expect(await effects(f)).toBe(1);
    // Subscribe before releasing; the retained observer records actual exit.
    final = subscribe(f, receipts => receipts.some(row => row.kind === "exit") && receipts.at(-1)?.kind === "recovery_required");
    f.release();
    await final.promise;
    expect(rows(f).find(row => row.kind === "exit")).toMatchObject({ status: 0, signal: null });
    expect(rows(f).some(row => row.kind === "files-verified")).toBe(false);
    expect((await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now })).ok).toBe(false);
    expect(await effects(f)).toBe(1);
  } finally { final?.close(); await cleanup(f); }
});

test("drains excessive private output with bounded counters and no plaintext receipts", async () => {
  // Given
  const f = await fixture("flood");
  try {
    const spec = await f.spec();
    // When
    value(await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now }));
    // Then
    expect(rows(f).find(row => row.kind === "exit")).toMatchObject({ stdoutBytes: 65_536, stderrBytes: 65_536, outputTruncated: true });
    expect(JSON.stringify(rows(f))).not.toContain("SYNTHETIC_PRIVATE_OUTPUT");
    expect(JSON.stringify(rows(f))).not.toContain(f.home);
  } finally { await cleanup(f); }
});

test("rejects nonprivate receipt roots before effects", async () => {
  // Given
  const f = await fixture();
  try {
    const spec = await f.spec();
    await chmod(f.journal, 0o755);
    // When
    expect(await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now })).toEqual({ ok: false, error: { code: "verification_failed" } });
    // Then
    expect(await effects(f)).toBe(0);
    expect(await readdir(f.journal)).toEqual([]);
  } finally { await cleanup(f); }
});

test("does not reacquire a durable operation after its intent acknowledgement was lost", async () => {
  // Given: actual authenticated intent already committed, no remembered callback grant.
  const f = await fixture();
  try {
    const spec = await f.spec();
    const intent = value(getOmoUpdateIntent(spec));
    const path = join(f.journal, `${hash(intent.operationId)}.jsonl`);
    const existing = JSON.stringify({ kind: "intent", intent }) + "\n";
    writeFileSync(path, existing, { mode: 0o600 });
    // When
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now });
    // Then: absence of an ACK cannot issue another command or overwrite receipts.
    expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
    expect(await readFile(path, "utf8")).toBe(existing);
    expect(await effects(f)).toBe(0);
    expect(await readdir(f.home)).toEqual([]);
  } finally { await cleanup(f); }
});

test("rechecks pinned manager after actual exit rather than trusting its zero status", async () => {
  // Given
  const f = await fixture();
  try {
    const spec = await f.spec();
    // When: mutation is after authoritative process exit, before strategy postflight.
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now,
      event: async receipt => { if (receipt.kind === "exit") writeFileSync(f.manager, "changed-manager"); } });
    // Then
    expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
    expect(rows(f).find(row => row.kind === "exit")).toMatchObject({ status: 0, signal: null });
    expect(rows(f).some(row => row.kind === "files-verified")).toBe(false);
    expect(await effects(f)).toBe(1);
  } finally { await cleanup(f); }
});

test("allows one local context dispatch when authentic operations enter concurrently", async () => {
  // Given: readiness IPC is armed before either entry; this is NOT global queue proof.
  const f = await fixture("hang");
  try {
    const first = await f.spec(), duplicate = await f.spec();
    const pending = consumeOmoUpdate(first, { receiptRoot: f.journal, now: () => now });
    // When
    const second = await consumeOmoUpdate(duplicate, { receiptRoot: f.journal, now: () => now });
    // Then
    expect(second).toEqual({ ok: false, error: { code: "verification_failed" } });
    await bounded(f.ready);
    expect(await effects(f)).toBe(1);
    f.release();
    expect((await pending).ok).toBe(true);
    expect(rows(f).filter(row => row.kind === "launched")).toHaveLength(1);
  } finally { await cleanup(f); }
});

test.each(["truncate", "same-length-rewrite", "erase-exit", "duplicate-intent"] as const)(
  "r2 refuses durable success after same-inode %s transcript tampering", async tamper => {
    // Given: the actual manager installs qualified bytes and exits zero.
    const f = await fixture();
    let beforeInode = 0, afterInode = 0, beforeLength = 0, afterLength = 0;
    try {
      const spec = await f.spec();
      // When: mutate authored history without replacing the journal inode.
      const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now,
        event: async receipt => {
          if (receipt.kind !== "exit") return;
          expect(receipt.status).toBe(0);
          const path = join(f.journal, `${hash(receipt.intent.operationId)}.jsonl`);
          const bytes = readFileSync(path, "utf8");
          beforeInode = statSync(path).ino;
          beforeLength = Buffer.byteLength(bytes);
          const lines = bytes.trim().split("\n");
          expect(JSON.parse(lines.at(-1) ?? "{}").kind).toBe("exit");
          const changed = tamper === "truncate" ? "" : tamper === "same-length-rewrite"
            ? bytes.replace('"kind":"intent"', '"kind":"erased"')
            : tamper === "erase-exit" ? lines.slice(0, -1).join("\n") + "\n"
              : bytes + lines[0] + "\n";
          writeFileSync(path, changed);
          afterInode = statSync(path).ino;
          afterLength = statSync(path).size;
        } });
      // Then: neither equal inode nor equal length authenticates committed bytes.
      expect(afterInode).toBe(beforeInode);
      if (tamper === "same-length-rewrite") expect(afterLength).toBe(beforeLength);
      expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
      expect(rows(f).some(row => row.kind === "files-verified")).toBe(false);
      expect(await effects(f)).toBe(1);
      for (const [path, expected] of f.files) expect(hash(await readFile(path))).toBe(hash(expected));
    } finally { await cleanup(f); }
  },
);

test.each(["dispatch", "late-clock"] as const)("r2 rejects journal substitution after %s before any actual spawn", async hook => {
  // Given: an authentic qualified spec, no custom issuer/executor.
  const f = await fixture();
  try {
    const spec = await f.spec(), intent = value(getOmoUpdateIntent(spec));
    const path = join(f.journal, `${hash(intent.operationId)}.jsonl`);
    let dispatched = false, swaps = 0;
    const replace = () => {
      const bytes = readFileSync(path);
      renameSync(path, join(f.root, "original-journal.jsonl"));
      writeFileSync(path, bytes, { mode: 0o600 });
      swaps++;
    };
    // When: the clock variant runs after the dispatch notification has settled.
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal,
      now() { if (hook === "late-clock" && dispatched && swaps === 0) replace(); return now; },
      event: async receipt => {
        if (receipt.kind !== "dispatch") return;
        dispatched = true;
        if (hook === "dispatch") replace();
      } });
    // Then: recovery is before mutation, not a late response to an executed install.
    expect(swaps).toBe(1);
    expect(result.ok).toBe(false);
    expect(await effects(f)).toBe(0);
    expect(rows(f).map(row => row.kind)).toEqual(["intent", "dispatch"]);
    expect(JSON.parse(await readFile(join(f.wrapper, "package.json"), "utf8")).version).toBe("5.1.9");
  } finally { await cleanup(f); }
});

test.each(["addEventListener", "removeEventListener"] as const)(
  "r2 rejects transcript damage from %s metadata getter", async method => {
    // Given: native observation signal with a caller-controlled method getter.
    const f = await fixture();
    try {
      const spec = await f.spec(), intent = value(getOmoUpdateIntent(spec));
      const path = join(f.journal, `${hash(intent.operationId)}.jsonl`);
      const controller = new AbortController();
      const nativeMethod = controller.signal[method].bind(controller.signal);
      let getterCalls = 0;
      Object.defineProperty(controller.signal, method, { configurable: true,
        get() { getterCalls++; writeFileSync(path, ""); return nativeMethod; } });
      // When: add metadata is pre-effect; remove metadata is the final cleanup hook.
      const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now, signal: controller.signal });
      // Then: cleanup must not turn erased intent/dispatch/exit into durable success.
      expect(getterCalls).toBe(1);
      expect(result.ok).toBe(false);
      expect(rows(f).some(row => row.kind === "files-verified")).toBe(false);
      expect(await effects(f)).toBe(method === "addEventListener" ? 0 : 1);
      if (method === "addEventListener") expect(rows(f).some(row => row.kind === "launched")).toBe(false);
    } finally { await cleanup(f); }
  },
);

test.each(["alias-install", "alias-wrong-root", "alias-metadata-only", "alias-signal"] as const)(
  "alias-r1 durable consumer verifies %s through actual launch and journal", async behavior => {
    // Given: controller readiness and journal exit subscription precede dispatch.
    const f = await fixture(behavior);
    const exited = subscribe(f, receipts => receipts.some(row => row.kind === "exit"));
    try {
      const spec = await f.spec(), intent = value(getOmoUpdateIntent(spec));
      // When: production consumer launches the pinned synthetic manager exactly once.
      const pending = consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now });
      await bounded(f.ready);
      const result = await bounded(pending);
      await exited.promise;
      // Then: only the correct physical alias output earns durable success.
      const receipts = rows(f);
      expect(await effects(f)).toBe(1);
      expect(receipts.filter(row => row.kind === "launched")).toHaveLength(1);
      expect(receipts.slice(0, 4).map(row => row.kind)).toEqual(["intent", "dispatch", "launched", "exit"]);
      if (behavior === "alias-install") {
        expect(result).toEqual({ ok: true, value: { kind: "files-verified", intent, durableReceipt: true } });
        expect(receipts.at(-1)?.kind).toBe("files-verified");
        const root = join(f.prefix, "install/global/node_modules/@earendil-works/pi-ai");
        expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")))
          .toEqual({ name: "@code-yeongyu/senpi-ai", version: "2026.10.1-3" });
        expect(await readFile(join(root, "dist/payload.js"), "utf8"))
          .toBe('export const qualifiedPayload = "@code-yeongyu/senpi-ai@2026.10.1-3";\n');
        for (const [path, expected] of f.files) expect(hash(await readFile(path))).toBe(hash(expected));
        await expect(access(join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi-ai"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(result).toEqual({ ok: false, error: { code: behavior === "alias-signal" ? "update_failed" : "recovery_required" } });
        expect(receipts.some(row => row.kind === "files-verified")).toBe(false);
        expect(receipts.at(-1)?.kind).toBe("recovery_required");
        if (behavior === "alias-wrong-root")
          expect(JSON.parse(await readFile(join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi-ai/package.json"), "utf8")).name)
            .toBe("@code-yeongyu/senpi-ai");
      }
      // A real signal exit is status:null, never a fabricated {status:0,signal}.
      // The strategy's zero-with-signal metadata control is in its existing test home.
      expect(receipts.find(row => row.kind === "exit")).toMatchObject(behavior === "alias-signal"
        ? { status: null, signal: "SIGTERM" } : { status: 0, signal: null });
    } finally { exited.close(); await cleanup(f); }
  },
);
