import { spyOn } from "bun:test";
import { ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "../fixture";
import { manualProbe } from "../manual";

/** Filesystem creation barrier plus genuine owned-child close observations.
 * Only this helper cleans its foreign sentinel fixture, after manual finishes.
 */
export async function concurrentManualCheck(): Promise<{
  readonly report: Awaited<ReturnType<typeof manualProbe>>;
  readonly ownedRootObserved: boolean;
  readonly ownedRootAbsent: boolean;
  readonly foreignDuring: boolean;
  readonly foreignAfter: boolean;
  readonly observedOwnedProcesses: number;
  readonly remainingOwnedPIDs: number;
}> {
  const foreign = await fixture();
  const sentinel = join(foreign.root, "foreign-owner-sentinel");
  await writeFile(sentinel, "foreign-owner-token");
  let ownedRoot: string | null = null, foreignDuring = false, ownedRootObserved = false;
  // This is an event observer, not a spawn/exit stub; dispatch remains genuine.
  const emit = ChildProcess.prototype.emit;
  const started = new Set<ChildProcess>(), closed = new Set<ChildProcess>();
  const observer = spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
    this: ChildProcess, event: string | symbol, ...args: unknown[]
  ) {
    if (ownedRoot !== null && typeof this.spawnfile === "string" && this.spawnfile.startsWith(`${ownedRoot}/`)) {
      if (event === "spawn" && this.pid !== undefined) started.add(this);
      if (event === "close") closed.add(this);
    }
    return emit.call(this, event, ...args);
  });
  try {
    // Child observer is registered before action; filesystem barrier is private.
    const report = await manualProbe(async root => {
      ownedRoot = root;
      const marker = join(root, "ownership-ready");
      await writeFile(marker, "before");
      const ready = Promise.withResolvers<void>();
      const watcher = watch(marker, { persistent: false }, () => ready.resolve());
      watcher.on("error", () => ready.reject(new TypeError("owned_namespace_watch_failed")));
      const deadline = AbortSignal.timeout(2000);
      const expire = () => ready.reject(new TypeError("owned_namespace_event_timeout"));
      deadline.addEventListener("abort", expire, { once: true });
      try {
        // Both event and write consumers are attached before async completion.
        await Promise.all([ready.promise, writeFile(marker, "after")]);
        ownedRootObserved = (await lstat(root)).isDirectory() && (await readFile(marker, "utf8")) === "after";
        foreignDuring = (await readFile(sentinel, "utf8")) === "foreign-owner-token";
      } finally {
        watcher.close();
        deadline.removeEventListener("abort", expire);
      }
    });
    if (ownedRoot === null) throw new TypeError("owned_namespace_not_observed");
    let ownedRootAbsent = false;
    try { await lstat(ownedRoot); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") ownedRootAbsent = true;
      else throw error;
    }
    const foreignAfter = (await lstat(foreign.root)).isDirectory()
      && (await readFile(sentinel, "utf8")) === "foreign-owner-token";
    const remainingOwnedPIDs = [...started].filter(child => !closed.has(child)).length;
    if (!ownedRootObserved || !foreignDuring || !foreignAfter || !ownedRootAbsent
      || started.size === 0 || remainingOwnedPIDs !== 0) throw new TypeError("owned_cleanup_proof_failed");
    return { report, ownedRootObserved, ownedRootAbsent, foreignDuring, foreignAfter,
      observedOwnedProcesses: started.size, remainingOwnedPIDs };
  } finally {
    observer.mockRestore();
    await foreign.cleanup();
    // Independently require absence of the helper's own foreign fixture.
    let foreignAbsent = false;
    try { await lstat(foreign.root); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") foreignAbsent = true;
      else throw error;
    }
    if (!foreignAbsent) throw new TypeError("foreign_fixture_cleanup_failed");
  }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await concurrentManualCheck(), null, 2)); }
  catch { console.log(JSON.stringify({ code: "verification_failed", FullDone: false })); process.exitCode = 1; }
}
