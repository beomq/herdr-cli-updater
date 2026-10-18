import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { fixture } from "../fixture";
import { checkSubjectKey } from "../../../../../../src/service/check-runtime";

// The only controlled boundary is the real stream's asynchronous cancel hook.
// A deadline signal is triggered at that exact event, not by elapsed sleeps.
export async function cancellationScenario(mode: "baseline" | "corrected", trigger: "abort" | "deadline" | "reject") {
  const f = await fixture(), events: string[] = [];
  const readEntered = Promise.withResolvers<void>(), cancelEntered = Promise.withResolvers<void>();
  const cancelRelease = Promise.withResolvers<void>(), lockReleased = Promise.withResolvers<void>();
  const admissionRelease = Promise.withResolvers<void>();
  const caller = new AbortController(), budget = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  let budgetIssued = false;
  AbortSignal.timeout = milliseconds => {
    if (milliseconds === 3500 && !budgetIssued) { budgetIssued = true; return budget.signal; }
    return originalTimeout(milliseconds);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, settled = false, cancelSettled = false;
  let requests = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      events.push("read-entered"); readEntered.resolve();
      if (trigger === "reject") controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    async cancel() {
      events.push("cancel-entered"); cancelEntered.resolve();
      await cancelRelease.promise;
      cancelSettled = true; events.push("cancel-settled");
      if (trigger === "reject") throw new TypeError("controlled cancel rejection");
    },
  }, { highWaterMark: 0 });
  const getReader = body.getReader.bind(body);
  // Instrument the actual standard reader, never replace its read/cancel behavior.
  Object.defineProperty(body, "getReader", { value: () => {
    reader = getReader();
    const releaseLock = reader.releaseLock.bind(reader);
    reader.releaseLock = () => {
      releaseLock(); events.push("lock-released"); lockReleased.resolve();
    };
    return reader;
  } });
  const runtime = f.runtime({
    admit: async source => {
      if (source.installation.family === "omp") await admissionRelease.promise;
      return f.admit(source);
    },
    request: async input => ++requests === 1 ? new Response(body) : f.request(input),
  });
  const pending = runtime.check(f.source, caller.signal);
  pending.then(() => { settled = true; events.push("reply-settled"); },
    () => { settled = true; events.push("reply-rejected"); });
  const otherSubjects = Array.from({ length: 64 }, (_, index) => ({
    ...f.source, installation: { ...f.source.installation, family: "omp" as const, channel: `cleanup:${index}` },
  }));
  const others: ReturnType<typeof runtime.check>[] = [];
  try {
    await readEntered.promise;
    if (trigger === "abort") { events.push("caller-abort"); caller.abort(); }
    if (trigger === "deadline") {
      events.push("deadline-event"); budget.abort();
    }
    await cancelEntered.promise;
    if (trigger === "reject") cancelRelease.resolve();
    if (mode === "baseline" && trigger !== "reject") {
      // Store completion is a subscribed causal checkpoint, not a timer.
      assert.deepEqual(await f.store.get(checkSubjectKey(f.source)), { ok: true, value: null });
      assert.equal(settled, false);
      events.push("baseline-reply-still-pending");
      cancelRelease.resolve();
    }
    const watchdog = originalTimeout(4000), bounded = Promise.withResolvers<never>();
    const expired = () => bounded.reject(new TypeError("caller did not settle before the bounded scenario timeout"));
    watchdog.addEventListener("abort", expired, { once: true });
    let result: Awaited<typeof pending>;
    try { result = await Promise.race([pending, bounded.promise]); }
    finally { watchdog.removeEventListener("abort", expired); }
    if (trigger === "reject") {
      assert.equal(body.locked, mode === "baseline");
      events.push(body.locked ? "baseline-lock-leaked" : "rejection-unlocked");
    } else {
      assert.deepEqual(result, { ok: false, error: { code: mode === "baseline" ? "receipt_uncertain" : "resources_busy" } });
      if (mode === "corrected") {
        assert.equal(cancelSettled, false);
        assert.equal(body.locked, true);
        assert.equal(runtime.check(f.source), pending);
        for (const source of otherSubjects.slice(0, 63)) others.push(runtime.check(source));
        const extra = otherSubjects[63];
        assert(extra);
        assert.deepEqual(await runtime.check(extra), { ok: false, error: { code: "resources_busy" } });
        events.push("exact-active-slot-retained");
      }
      assert.deepEqual(await f.store.get(checkSubjectKey(f.source)), { ok: true, value: null });
      cancelRelease.resolve();
      await lockReleased.promise;
      admissionRelease.resolve();
      await Promise.all(others);
      assert.equal(body.locked, false);
      if (mode === "corrected") {
        const retry = runtime.check(f.source);
        assert.notEqual(retry, pending);
        const refreshed = await retry;
        assert(refreshed.ok && refreshed.value.kind === "update-available");
        events.push("actual-cleanup-retired-new-operation");
      }
    }
    return { mode, trigger, events, result, cancelSettled, locked: body.locked, genuineVendor: false };
  } finally {
    cancelRelease.resolve(); admissionRelease.resolve();
    await pending; await Promise.all(others);
    // Baseline deliberately proves a leaked lock; retire that exact reader.
    if (body.locked && reader) reader.releaseLock();
    await lockReleased.promise;
    AbortSignal.timeout = originalTimeout;
    await f.cleanup();
    assert.equal(existsSync(f.root), false);
    events.push("cleanup:fixture-peer-stopped-root-absent-ownedcleanup0");
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  assert(mode === "baseline" || mode === "corrected");
  const triggers = mode === "baseline" ? ["abort", "reject"] as const : ["abort", "deadline", "reject"] as const;
  const reports = [];
  for (const trigger of triggers) reports.push(await cancellationScenario(mode, trigger));
  console.log(JSON.stringify({ reports, ownedcleanup: 0, FullDone: false, native: "0/8" }, null, 2));
}
