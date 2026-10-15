import { spawn } from "node:child_process";
import { dlopen, JSCallback, ptr } from "bun:ffi";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, watch, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { types } from "node:util";
import { executePrivateUpdate, getPrivateUpdateIntent } from "../adapters/update-context";
import type { AdapterResult, PrivateUpdateCommand, PrivateUpdateContext, PrivateUpdateIntent, UpdateSpec } from "../adapters/types";

export type OmoConsumerReceipt = {
  readonly intent: PrivateUpdateIntent;
  readonly kind: "intent" | "dispatch" | "launched" | "cleanup-observed" | "cleanup-exit" | "exit" | "files-verified" | "rejected" | "recovery_required";
  readonly pid?: number;
  readonly processVersion?: number;
  readonly status?: number | null;
  readonly signal?: string | null;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly outputTruncated?: boolean;
};
export type OmoConsumerOptions = {
  /** Existing canonical 0700 same-user directory. This is private worker state,
   * not a public launch grant, queue claim, or core drain attestation. */
  readonly receiptRoot: string;
  readonly now: () => number;
  readonly timeoutMs?: number;
  /** Abandons observation, never kills/retries a possibly running updater. */
  readonly signal?: AbortSignal;
  /** Notifications cannot grant authority or manufacture an exit observation. */
  readonly event?: (receipt: OmoConsumerReceipt) => Promise<void>;
};
export type OmoConsumerSuccess = {
  readonly kind: "files-verified";
  readonly intent: PrivateUpdateIntent;
  readonly durableReceipt: true;
};
const consumed = new WeakSet<PrivateUpdateContext>();
const failure = (code: "verification_failed" | "recovery_required" | "update_failed"): AdapterResult<OmoConsumerSuccess> =>
  ({ ok: false, error: { code } });

// allow: SIZE_OK — authorized consumer scope keeps the OS-owned join and its
// durable journal in the same module. No separate executor or launch API exists.
/** Darwin's original launcher execs its bundled Node in the same process.
 * The cleanup is a detached direct child of that Node. A process's original
 * parent pidversion survives reparenting; current PPID and command text do not
 * prove this relationship. libdispatch retains exact EVFILT_PROC knotes.
 *
 * Spawn suspended, arm before SIGCONT, and retain the root until waitpid.
 * Quiesce only the authenticated cleanup after installer exit and original
 * bootstrap marker creation, with an audit-token signal, never kill(pid).
 * Reclaim only its unchanged empty runtime marker after the knote reports exit.
 * Independent postflight checks all artifacts after the last writer has exited.
 */
async function runCursorCommand(command: PrivateUpdateCommand, lifecycle: {
  readonly beforeResume: () => void;
  readonly event: (kind: "launched" | "cleanup-observed" | "cleanup-exit", pid: number, version: number) => Promise<void>;
  readonly exit: (exit: { readonly status: number | null; readonly signal: string | null }) => void;
}): Promise<{ readonly status: number | null; readonly signal: string | null }> {
  const completion = command.nativeCompletion;
  if (process.platform !== "darwin" || process.arch !== "arm64" || !completion
    || completion.kind !== "cursor-detached-cleanup" || completion.home !== command.env["HOME"]
    || !Object.isFrozen(completion) || !Object.isFrozen(completion.args)) throw new TypeError("private_native_completion");
  const expectedCompletion = completion;
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    posix_spawn: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    posix_spawnattr_init: { args: ["ptr"], returns: "i32" },
    posix_spawnattr_destroy: { args: ["ptr"], returns: "i32" },
    posix_spawnattr_setflags: { args: ["ptr", "i16"], returns: "i32" },
    posix_spawn_file_actions_init: { args: ["ptr"], returns: "i32" },
    posix_spawn_file_actions_destroy: { args: ["ptr"], returns: "i32" },
    posix_spawn_file_actions_addchdir_np: { args: ["ptr", "ptr"], returns: "i32" },
    posix_spawn_file_actions_addopen: { args: ["ptr", "i32", "ptr", "i32", "u16"], returns: "i32" },
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
    proc_listallpids: { args: ["ptr", "i32"], returns: "i32" },
    proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
    proc_signal_with_audittoken: { args: ["ptr", "i32"], returns: "i32" },
    sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
    waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
    dlsym: { args: ["ptr", "ptr"], returns: "ptr" },
    dispatch_get_global_queue: { args: ["i64", "u64"], returns: "ptr" },
    dispatch_source_create: { args: ["ptr", "u64", "u64", "ptr"], returns: "ptr" },
    dispatch_source_set_event_handler_f: { args: ["ptr", "ptr"], returns: "void" },
    dispatch_source_set_registration_handler_f: { args: ["ptr", "ptr"], returns: "void" },
    dispatch_source_set_cancel_handler_f: { args: ["ptr", "ptr"], returns: "void" },
    dispatch_activate: { args: ["ptr"], returns: "void" },
    dispatch_source_cancel: { args: ["ptr"], returns: "void" },
    dispatch_release: { args: ["ptr"], returns: "void" },
  });
  const os = library.symbols, cstring = (value: string) => Buffer.from(`${value}\0`);
  function requireNative(valid: boolean): asserts valid { if (!valid) throw new TypeError("private_native_observation"); }
  function observe(pid: number) {
    const bsd = Buffer.alloc(136), unique = Buffer.alloc(56);
    requireNative(os.proc_pidinfo(pid, 3, 0, ptr(bsd), bsd.length) === bsd.length
      && os.proc_pidinfo(pid, 17, 0, ptr(unique), unique.length) === unique.length);
    return { pid, uid: bsd.readUInt32LE(20), gid: bsd.readUInt32LE(24),
      unique: unique.readBigUInt64LE(16), version: unique.readUInt32LE(32),
      parentVersion: unique.readUInt32LE(36), start: bsd.readBigUInt64LE(120),
      startMicroseconds: bsd.readBigUInt64LE(128) };
  }
  type Incarnation = ReturnType<typeof observe>;
  function same(a: Incarnation, b: Incarnation): boolean {
    return a.pid === b.pid && a.unique === b.unique && a.version === b.version
      && a.uid === b.uid && a.start === b.start && a.startMicroseconds === b.startMicroseconds;
  }
  function signal(exact: Incarnation, number: number): void {
    requireNative(same(exact, observe(exact.pid)));
    // audit_token_t: only pid and pidversion select the signal target. The
    // kernel checks both atomically, closing the read-then-kill PID reuse race.
    const token = new Uint32Array([exact.uid, exact.uid, exact.gid, exact.uid, exact.gid, exact.pid, 0, exact.version]);
    requireNative(os.proc_signal_with_audittoken(ptr(token), number) === 0);
  }
  const sourceType = os.dlsym(-2n, ptr(cstring("_dispatch_source_type_proc")));
  const queue = os.dispatch_get_global_queue(0, 0);
  requireNative(sourceType !== null && queue !== null);
  const watchers: { cancel: () => Promise<void> }[] = [];
  const registrations: Promise<void>[] = [];
  const notices: Promise<void>[] = [];
  const finished = Promise.withResolvers<void>();
  let stopping = false, observationFailed = false;
  // Retain rejected notifications without letting user hooks drive process IO.
  function notice(kind: "launched" | "cleanup-observed" | "cleanup-exit", exact: Incarnation): void {
    const pending = lifecycle.event(kind, exact.pid, exact.version);
    void pending.catch(() => {}); notices.push(pending);
  }
  async function arm(exact: Incarnation, mask: number, effect: () => void): Promise<void> {
    const source = os.dispatch_source_create(sourceType, exact.pid, mask, queue);
    requireNative(source !== null);
    const ready = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>();
    const callback = new JSCallback(() => {
      if (stopping) return;
      try { effect(); } catch {
        observationFailed = true;
        if (rootExit) finished.reject(new TypeError("private_native_observation"));
      }
    }, { args: ["ptr"], returns: "void", threadsafe: true });
    const registered = new JSCallback(() => ready.resolve(), { args: ["ptr"], returns: "void", threadsafe: true });
    const closed = new JSCallback(() => cancelled.resolve(), { args: ["ptr"], returns: "void", threadsafe: true });
    os.dispatch_source_set_event_handler_f(source, callback.ptr);
    os.dispatch_source_set_registration_handler_f(source, registered.ptr);
    os.dispatch_source_set_cancel_handler_f(source, closed.ptr);
    watchers.push({ cancel: async () => {
      os.dispatch_source_cancel(source); await cancelled.promise;
      os.dispatch_release(source); callback.close(); registered.close(); closed.close();
    } });
    os.dispatch_activate(source);
    await ready.promise;
    // A knote alone does not bind the command/incarnation read before arming.
    const current = observe(exact.pid);
    requireNative(current.pid === exact.pid && current.unique === exact.unique && current.uid === exact.uid
      && current.start === exact.start && current.startMicroseconds === exact.startMicroseconds);
  }
  const attr = Buffer.alloc(8), actions = Buffer.alloc(8), pidBuffer = Buffer.alloc(4);
  let root: Incarnation | undefined, resumed = false, reaped = false;
  let rootExit: { readonly status: number | null; readonly signal: string | null } | undefined;
  const rootVersions = new Set<number>();
  const candidates = new Map<bigint, {
    exact: Incarnation; ready: boolean; exited: boolean; matched: boolean; signalled: boolean;
    marker?: { readonly path: string; readonly stat: ReturnType<typeof fstatSync> };
  }>();
  let joined = false, registrationCount = 0;
  function settle(): void {
    if (!rootExit || registrationCount !== 0) return;
    if (observationFailed) finished.reject(new TypeError("private_native_observation"));
    else if (joined) finished.resolve();
    else if (![...candidates.values()].some(row => !row.exited)) finished.reject(new TypeError("private_native_cleanup_missing"));
  }
  function match(exact: Incarnation): boolean {
    const path = Buffer.alloc(4096);
    if (os.proc_pidpath(exact.pid, ptr(path), path.length) <= 0) return false;
    if (path.subarray(0, path.indexOf(0)).toString() !== join(dirname(expectedCompletion.executable), "node")) return false;
    const mib = new Int32Array([1, 49, exact.pid]), bytes = Buffer.alloc(1024 * 1024), size = new BigUint64Array([BigInt(bytes.length)]);
    requireNative(os.sysctl(ptr(mib), mib.length, ptr(bytes), ptr(size), null, 0) === 0);
    const count = bytes.readInt32LE(0), end = Number(size[0]);
    let offset = bytes.indexOf(0, 4) + 1;
    requireNative(count > 0 && count < 128 && offset > 4 && end <= bytes.length);
    while (offset < end && bytes[offset] === 0) offset++;
    const args: string[] = [];
    for (let i = 0; i < count; i++) {
      const next = bytes.indexOf(0, offset); requireNative(next >= offset && next < end);
      args.push(bytes.subarray(offset, next).toString()); offset = next + 1;
    }
    const expected = [expectedCompletion.executable, join(dirname(expectedCompletion.executable), "index.js"), ...expectedCompletion.args];
    return args.length === expected.length && args.every((arg, i) => arg === expected[i])
      && bytes.subarray(offset, end).toString().split("\0").includes(`HOME=${expectedCompletion.home}`);
  }
  function inspect(row: NonNullable<ReturnType<typeof candidates.get>>): void {
    if (!row.ready || row.exited || row.signalled) return;
    let current: Incarnation;
    // The retained EXIT knote, not a failed liveness query, settles this child.
    try { current = observe(row.exact.pid); } catch { return; }
    requireNative(current.unique === row.exact.unique && current.uid === process.getuid?.()
      && rootVersions.has(current.parentVersion));
    row.exact = current;
    if (!row.matched && match(current)) {
      requireNative(![...candidates.values()].some(other => other !== row && other.matched));
      row.matched = true; notice("cleanup-observed", current);
    }
    if (rootExit && row.matched) {
      const marker = join(dirname(expectedCompletion.executable), ".running", String(current.pid));
      const entry = lstatSync(marker, { throwIfNoEntry: false });
      if (!entry) return;
      const directory = lstatSync(dirname(marker));
      requireNative(directory.isDirectory() && directory.uid === current.uid && (directory.mode & 0o022) === 0
        && realpathSync(dirname(marker)) === dirname(marker)
        && entry.isFile() && entry.size === 0 && entry.nlink === 1
        && entry.uid === current.uid && (entry.mode & 0o022) === 0);
      const fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        requireNative(opened.dev === entry.dev && opened.ino === entry.ino && opened.size === 0);
        row.marker = { path: marker, stat: opened };
      } finally { closeSync(fd); }
      signal(current, 15); row.signalled = true;
    }
  }
  function census(refreshRoot = true): void {
    requireNative(root !== undefined);
    if (refreshRoot && !reaped) {
      let current: Incarnation | undefined;
      // An exit can race this FORK/EXEC callback. Missing identity adds no
      // ancestor authority; only previously observed versions remain eligible.
      try { current = observe(root.pid); } catch { current = undefined; }
      if (current) {
        requireNative(current.unique === root.unique && current.uid === root.uid);
        rootVersions.add(current.version);
      }
    }
    const pids = new Int32Array(65_536), count = os.proc_listallpids(ptr(pids), pids.byteLength);
    requireNative(count > 0 && count < pids.length);
    for (const pid of pids.subarray(0, count)) {
      let exact: Incarnation;
      // Processes outside our tree can disappear during the read-only census.
      try { exact = observe(pid); } catch { continue; }
      if (exact.uid !== root.uid || !rootVersions.has(exact.parentVersion)
        || exact.start < root.start || candidates.has(exact.unique)) continue;
      const row: NonNullable<ReturnType<typeof candidates.get>> = {
        exact, ready: false, exited: false, matched: false, signalled: false,
      };
      candidates.set(exact.unique, row); registrationCount++;
      registrations.push((async () => {
        try {
          await arm(exact, 0x80000000, () => {
            row.exited = true;
            if (row.matched) {
              const marker = row.marker;
              if (marker) {
                const current = lstatSync(marker.path, { throwIfNoEntry: false });
                // The vendor may have handled the signal and removed its own
                // marker. Otherwise only the captured same inode is reclaimed.
                if (current) {
                  requireNative(current.dev === marker.stat.dev && current.ino === marker.stat.ino
                    && current.size === 0 && current.nlink === 1 && current.uid === row.exact.uid
                    && current.mtimeMs === marker.stat.mtimeMs && current.ctimeMs === marker.stat.ctimeMs
                    && realpathSync(dirname(marker.path)) === dirname(marker.path));
                  unlinkSync(marker.path);
                }
              }
              joined = true; notice("cleanup-exit", row.exact);
            }
            settle();
          });
          await arm(observe(exact.pid), 0x20000000, () => inspect(row));
          row.ready = true;
          if (!stopping) inspect(row);
        } catch {
          // An unobserved short-lived helper cannot prove cleanup completion.
          row.exited = true;
          if (row.matched) finished.reject(new TypeError("private_native_cleanup_uncertain"));
        } finally { registrationCount--; settle(); }
      })());
    }
  }
  // Handle rejection immediately, including one delivered while arming.
  void finished.promise.catch(() => {});
  // Arm the bootstrap-marker subscription before creating the root. File events
  // merely wake a re-read of the exact owned path; they confer no authority.
  const markerEvents = watch(expectedCompletion.home, { recursive: true }, () => {
    if (stopping) return;
    try { for (const row of candidates.values()) inspect(row); }
    catch { observationFailed = true; if (rootExit) finished.reject(new TypeError("private_native_marker")); }
  });
  try {
    requireNative(os.posix_spawnattr_init(ptr(attr)) === 0);
    requireNative(os.posix_spawn_file_actions_init(ptr(actions)) === 0);
    try {
      requireNative(os.posix_spawnattr_setflags(ptr(attr), 0x4080) === 0);
      requireNative(os.posix_spawn_file_actions_addchdir_np(ptr(actions), ptr(cstring(command.cwd))) === 0);
      for (const fd of [0, 1, 2])
        requireNative(os.posix_spawn_file_actions_addopen(ptr(actions), fd, ptr(cstring("/dev/null")), fd === 0 ? 0 : 1, 0) === 0);
      const argv = [command.executable, ...command.args].map(cstring);
      const env = Object.entries(command.env).map(([key, value]) => cstring(`${key}=${value}`));
      const argvPointers = new BigUint64Array([...argv.map(value => BigInt(ptr(value))), 0n]);
      const envPointers = new BigUint64Array([...env.map(value => BigInt(ptr(value))), 0n]);
      requireNative(os.posix_spawn(ptr(pidBuffer), ptr(cstring(command.executable)), ptr(actions), ptr(attr),
        ptr(argvPointers), ptr(envPointers)) === 0);
      root = observe(pidBuffer.readInt32LE(0)); rootVersions.add(root.version);
    } finally { os.posix_spawn_file_actions_destroy(ptr(actions)); os.posix_spawnattr_destroy(ptr(attr)); }
    const ownedRoot = root;
    requireNative(ownedRoot !== undefined);
    await arm(ownedRoot, 0x60000000, () => census());
    await arm(ownedRoot, 0x80000000, () => {
      // libproc can reject zombie identity queries. Preserve the versions
      // captured by EXEC/FORK events and reap only our own direct child.
      try { census(false); } catch { observationFailed = true; }
      const status = Buffer.alloc(4);
      requireNative(os.waitpid(ownedRoot.pid, ptr(status), 0) === ownedRoot.pid);
      reaped = true;
      const result = status.readInt32LE(0), termination = result & 0x7f;
      rootExit = termination === 0 ? { status: (result >> 8) & 255, signal: null }
        : { status: null, signal: `signal:${termination}` };
      lifecycle.exit(rootExit);
      for (const row of candidates.values()) inspect(row);
      settle();
    });
    lifecycle.beforeResume();
    signal(ownedRoot, 19); resumed = true;
    notice("launched", ownedRoot);
    await finished.promise;
    await Promise.all(notices);
    requireNative(rootExit !== undefined && joined);
    return rootExit;
  } finally {
    stopping = true;
    markerEvents.close();
    if (root && !resumed && !reaped) {
      // A rejected suspended spawn has not executed any vendor code.
      signal(root, 9);
      const status = Buffer.alloc(4);
      requireNative(os.waitpid(root.pid, ptr(status), 0) === root.pid); reaped = true;
    }
    await Promise.all(registrations);
    await Promise.all(watchers.map(watcher => watcher.cancel()));
    library.close();
  }
}

/** Authenticate without running caller accessors/Proxy traps. The original
 * issued object is retained: copying a descriptor never transfers authority.
 */
function dataOnly(value: unknown, depth = 0): boolean {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) return true;
  if (typeof value !== "object" || types.isProxy(value) || depth > 16) return false;
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && descriptor !== undefined && Object.hasOwn(descriptor, "value")
      && (descriptor.enumerable || (array && key === "length")) && dataOnly(descriptor.value, depth + 1);
  });
}

/** One private consumer and its real process backend. Generic family specs are
 * rejected, never raw-spawned. Global queue/core admission is deliberately NOT
 * supplied by this mechanism; a later trusted worker must own those gates.
 *
 * Exclusive operation journal + single-use context prevent automatic replay.
 * Intent is fsync'ed before a private strategy creates even its private cache.
 * Timeout returns recovery without terminating the updater. The outstanding
 * observer retains the journal until authoritative exit and strategy cleanup.
 */
export async function consumeOmoUpdate(spec: UpdateSpec, options: OmoConsumerOptions): Promise<AdapterResult<OmoConsumerSuccess>> {
  let fd: number | undefined;
  try {
    if (!dataOnly(spec)) return failure("verification_failed");
    const authenticated = getPrivateUpdateIntent(spec);
    if (!authenticated.ok || !spec.execution) return failure("verification_failed");
    const context = spec.execution;
    if (consumed.has(context)) return failure("verification_failed");
    const intent = authenticated.value;
    const root = options.receiptRoot, clock = options.now, notify = options.event, signal = options.signal;
    const timeoutMs = options.timeoutMs ?? 1_800_000;
    if (signal?.aborted || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) return failure("verification_failed");
    const directory = lstatSync(root);
    if (realpathSync(root) !== root || !directory.isDirectory() || directory.uid !== process.getuid?.()
      || (directory.mode & 0o777) !== 0o700) return failure("verification_failed");
    const path = join(root, `${createHash("sha256").update(intent.operationId).digest("hex")}.jsonl`);
    // Existing intent, including an ACK-lost one, is never a fresh grant.
    if (lstatSync(path, { throwIfNoEntry: false })) return failure("recovery_required");
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const journal = fd, identity = fstatSync(journal);
    let attempted = false, timedOut = false, callbackFailed = false, journalFailed = false;
    // Authored bytes are comparison evidence, never a prefix restoration source.
    let transcript = Buffer.alloc(0), committed = identity;
    const recorded = new Set<OmoConsumerReceipt["kind"]>();
    function validateJournal(): void {
      try {
        if (journalFailed) throw new TypeError("private_receipt_changed");
        const current = lstatSync(root), entry = lstatSync(path), opened = fstatSync(journal);
        if (current.dev !== directory.dev || current.ino !== directory.ino || current.uid !== directory.uid
          || (current.mode & 0o777) !== 0o700 || entry.dev !== identity.dev || entry.ino !== identity.ino
          || opened.uid !== identity.uid || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
          || opened.size !== transcript.length || opened.mtimeMs !== committed.mtimeMs
          || opened.ctimeMs !== committed.ctimeMs) throw new TypeError("private_receipt_changed");
        const actual = Buffer.alloc(transcript.length);
        let offset = 0;
        while (offset < actual.length) {
          const length = readSync(journal, actual, offset, actual.length - offset, offset);
          if (length === 0) throw new TypeError("private_receipt_changed");
          offset += length;
        }
        const after = fstatSync(journal);
        if (!actual.equals(transcript) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
          || after.ctimeMs !== opened.ctimeMs) throw new TypeError("private_receipt_changed");
      // Native I/O and arbitrary private hook effects never disclose path/error payloads.
      } catch { journalFailed = true; throw new TypeError("private_receipt_changed"); }
    }
    function append(receipt: OmoConsumerReceipt): void {
      const bytes = Buffer.from(JSON.stringify(receipt) + "\n");
      validateJournal();
      let written = 0;
      while (written < bytes.length) written += writeSync(journal, bytes, written, bytes.length - written);
      fsyncSync(journal);
      transcript = Buffer.concat([transcript, bytes]);
      committed = fstatSync(journal);
      validateJournal();
      recorded.add(receipt.kind);
    }
    append({ kind: "intent", intent });
    const directoryFd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    consumed.add(context);
    const completion = Promise.withResolvers<AdapterResult<OmoConsumerSuccess>>();
    const abandon = () => {
      timedOut = true;
      try { append({ kind: "recovery_required", intent }); } catch { journalFailed = true; }
      completion.resolve(failure("recovery_required"));
    };
    const timer = setTimeout(abandon, timeoutMs);
    async function emit(receipt: OmoConsumerReceipt): Promise<void> {
      append(receipt);
      try { await notify?.(Object.freeze(receipt)); }
      // Arbitrary caller throws are private; never inspect/stringify the payload.
      catch { callbackFailed = true; throw new TypeError("private_notification_failed"); }
      validateJournal();
    }
    // The background observer owns the fd from here, including after timeout.
    fd = undefined;
    void (async () => {
      let result: AdapterResult<OmoConsumerSuccess> = failure("recovery_required");
      try {
        signal?.addEventListener("abort", abandon, { once: true });
        validateJournal();
        const observed = await executePrivateUpdate(spec, {
          now: () => { const value = clock(); validateJournal(); return value; },
          event: async event => {
            // Intent was already durable before any strategy effect.
            if (event.kind === "intent") {
              try { await notify?.(Object.freeze({ kind: "intent", intent })); }
              catch { callbackFailed = true; throw new TypeError("private_notification_failed"); }
              validateJournal();
            } else if (event.kind === "dispatch") {
              if (timedOut) throw new TypeError("private_deadline_elapsed");
              await emit({ kind: "dispatch", intent });
            }
            // Strategy exit notification is not our authoritative exit source.
          },
          run: async command => {
            if (attempted || timedOut || command.shell !== false || command.inheritEnv !== false
              || !Object.isFrozen(command) || !Object.isFrozen(command.args) || !Object.isFrozen(command.env)
              || (command.nativeCompletion !== undefined && !dataOnly(command.nativeCompletion))
              || (intent.family === "cursor") !== (command.nativeCompletion !== undefined)
              || (command.nativeCompletion !== undefined && context.kind !== "cursor-original-update")
              || !recorded.has("intent") || !recorded.has("dispatch")) {
              throw new TypeError("private_dispatch_rejected");
            }
            const executable = command.executable, args = [...command.args], cwd = command.cwd, env = { ...command.env };
            // All notification, clock and command metadata reads have settled.
            // No caller hook or await is permitted between this check and spawn.
            validateJournal();
            attempted = true;
            if (command.nativeCompletion) {
              const exit = await runCursorCommand(command, {
                beforeResume: () => {
                  if (timedOut) throw new TypeError("private_deadline_elapsed");
                  validateJournal();
                },
                event: (kind, pid, processVersion) => emit({ kind, intent, pid, processVersion }),
                exit: exit => append({ kind: "exit", intent, ...exit }),
              });
              try { await notify?.(Object.freeze({ kind: "exit", intent, ...exit })); }
              catch { callbackFailed = true; throw new TypeError("private_notification_failed"); }
              validateJournal();
              if (callbackFailed || timedOut) throw new TypeError("private_result_uncertain");
              return exit;
            }
            // Explicit env replaces ambient environment. No shell, stdin, or log.
            const child = spawn(executable, args, {
              cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"],
            });
            let stdoutBytes = 0, stderrBytes = 0, outputTruncated = false, spawnFailed = false;
            // Drain all bytes without retaining plaintext; counters are bounded.
            child.stdout.on("data", (bytes: Buffer) => {
              outputTruncated ||= stdoutBytes + bytes.length > 65_536;
              stdoutBytes = Math.min(65_536, stdoutBytes + bytes.length);
            });
            child.stderr.on("data", (bytes: Buffer) => {
              outputTruncated ||= stderrBytes + bytes.length > 65_536;
              stderrBytes = Math.min(65_536, stderrBytes + bytes.length);
            });
            const closed = Promise.withResolvers<{ readonly status: number | null; readonly signal: string | null }>();
            let launchNotice: Promise<void> = Promise.resolve();
            child.once("spawn", () => {
              launchNotice = child.pid === undefined
                ? Promise.reject(new TypeError("private_process_identity_missing"))
                : emit({ kind: "launched", intent, pid: child.pid });
              // Attach rejection handling before an arbitrary callback can fail.
              void launchNotice.catch(() => { callbackFailed = true; });
            });
            child.once("error", () => { spawnFailed = true; });
            child.once("close", (status, signal) => {
              try { append({ kind: "exit", intent, status, signal, stdoutBytes, stderrBytes, outputTruncated }); }
              catch { journalFailed = true; }
              closed.resolve({ status, signal });
            });
            const exit = await closed.promise;
            await launchNotice;
            try { await notify?.(Object.freeze({ kind: "exit", intent, ...exit })); }
            catch { callbackFailed = true; throw new TypeError("private_notification_failed"); }
            validateJournal();
            if (spawnFailed || journalFailed || callbackFailed || timedOut) throw new TypeError("private_result_uncertain");
            return exit;
          },
        });
        if (timedOut || callbackFailed || journalFailed) result = failure("recovery_required");
        else if (!observed.ok) result = !attempted && observed.error.code === "update_failed"
          ? failure("verification_failed") : observed;
        else if (attempted && observed.value.kind === "files-verified") {
          // Existing strategy re-reads actual artifact contents/hash/version.
          if (!recorded.has("intent") || !recorded.has("dispatch") || !recorded.has("exit")) {
            throw new TypeError("private_receipt_incomplete");
          }
          append({ kind: "files-verified", intent });
          result = { ok: true, value: { kind: "files-verified", intent, durableReceipt: true } };
        } else result = failure("verification_failed");
        if (!result.ok) append({ kind: attempted || timedOut ? "recovery_required" : "rejected", intent });
      } catch {
        result = failure("recovery_required");
        try { append({ kind: "recovery_required", intent }); } catch { journalFailed = true; }
      } finally {
        clearTimeout(timer);
        try {
          signal?.removeEventListener("abort", abandon);
          // Cleanup method getters/implementations are the final supplied hooks.
          validateJournal();
        } catch { result = failure("recovery_required"); }
        try { closeSync(journal); } catch { result = failure("recovery_required"); }
        completion.resolve(result);
      }
    })();
    return completion.promise;
  // Admission/storage errors are normalized without examining private payloads.
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { return failure("recovery_required"); }
    }
    return failure("verification_failed");
  }
}

/** Same journal, timeout, process backend and one-effect guard for all issuers.
 * The legacy name remains valid for existing OmO clients and fixtures.
 */
export const consumePrivateUpdate = consumeOmoUpdate;
export type PrivateConsumerOptions = OmoConsumerOptions;
export type PrivateConsumerReceipt = OmoConsumerReceipt;
export type PrivateConsumerSuccess = OmoConsumerSuccess;
