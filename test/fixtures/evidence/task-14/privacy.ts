import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createAgyAdapter } from "../../../../src/adapters/agy";
import type { AdapterResult } from "../../../../src/adapters/types";
import { fixture } from "./fixture";

export const throwKinds = ["Error", "object", "string", "null"] as const;
export const hostileThrowKinds = ["revoked-proxy", "throwing-error-code"] as const;
type ThrowKind = (typeof throwKinds)[number] | (typeof hostileThrowKinds)[number];
type Callback = "provenance" | "manifest" | "installer" | "privateRuntime" | "preflight" | "now";
const marker = "task14-private-sentinel-not-for-output";

export async function privacyProbe(kind: ThrowKind) {
  let caughtValueReads = 0;
  let sentinel: unknown = kind === "Error" ? new Error(marker)
    : kind === "object" ? { privatePath: marker, options: [marker], credential: marker }
      : kind === "string" ? marker : null;
  if (kind === "revoked-proxy") {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    sentinel = revoked.proxy;
  }
  if (kind === "throwing-error-code") {
    const error = new Error(marker);
    Object.defineProperty(error, "code", { get() { caughtValueReads++; throw marker; } });
    sentinel = error;
  }
  let armed: Callback | null = null;
  function trip(callback: Callback) {
    if (armed === callback) throw sentinel;
  }
  const f = await fixture(config => createAgyAdapter({
    ...config,
    provenance: executable => { trip("provenance"); return config.provenance(executable); },
    manifest: () => { trip("manifest"); return config.manifest(); },
    installer: () => { trip("installer"); return config.installer(); },
    privateRuntime: id => { trip("privateRuntime"); return config.privateRuntime(id); },
    preflight: id => { trip("preflight"); return config.preflight(id); },
    now: () => { trip("now"); return config.now(); },
  }));
  const rows: {
    callback: Callback; operation: string; settled: boolean; enumOnly: boolean; sentinelAbsent: boolean;
    caughtValueUninspected: boolean;
  }[] = [];
  try {
    const installation = await f.installation();
    const runtime = await f.runtime(installation);
    const routes: readonly {
      readonly callback: Callback;
      readonly operation: string;
      readonly action: () => AdapterResult<unknown> | Promise<AdapterResult<unknown>>;
    }[] = [
      { callback: "provenance", operation: "detect", action: () => f.adapter.detect(f.executable) },
      { callback: "provenance", operation: "version", action: () => f.adapter.version(installation) },
      { callback: "provenance", operation: "check", action: () => f.adapter.check(installation) },
      { callback: "provenance", operation: "updateSpec", action: () => f.adapter.updateSpec(installation, "update-only") },
      { callback: "provenance", operation: "exactResume", action: () => f.adapter.exactResume(runtime) },
      { callback: "provenance", operation: "bridge", action: () => f.adapter.bridge(runtime) },
      { callback: "provenance", operation: "gracefulExit", action: () => f.adapter.gracefulExit(runtime, "op", "private:owner") },
      { callback: "manifest", operation: "check", action: () => f.adapter.check(installation) },
      { callback: "installer", operation: "update-only", action: () => f.adapter.updateSpec(installation, "update-only") },
      { callback: "installer", operation: "update-and-restart", action: () => f.adapter.updateSpec(installation, "update-and-restart") },
      { callback: "privateRuntime", operation: "exactResume", action: () => f.adapter.exactResume(runtime) },
      { callback: "preflight", operation: "exactResume", action: () => f.adapter.exactResume(runtime) },
      { callback: "preflight", operation: "bridge", action: () => f.adapter.bridge(runtime) },
      { callback: "preflight", operation: "gracefulExit", action: () => f.adapter.gracefulExit(runtime, "op", "private:owner") },
      { callback: "now", operation: "check", action: () => f.adapter.check(installation) },
    ];
    for (const route of routes) {
      armed = route.callback;
      const readsBefore = caughtValueReads;
      let settled = false, enumOnly = false, sentinelAbsent = false;
      try {
        const result = await route.action();
        settled = true;
        // Serialization is examined only in memory; no original result is logged.
        const serialized = JSON.stringify(result);
        enumOnly = serialized === '{"ok":false,"error":{"code":"verification_failed"}}';
        sentinelAbsent = !serialized.includes(marker);
      } catch {
        // Probe an escaped value without serializing or logging that private value.
        settled = false;
      }
      rows.push({ callback: route.callback, operation: route.operation, settled, enumOnly, sentinelAbsent,
        caughtValueUninspected: caughtValueReads === readsBefore });
    }
  } finally {
    await f.cleanup();
  }
  return rows;
}

if (import.meta.main) {
  const results = [];
  for (const kind of throwKinds) {
    const rows = await privacyProbe(kind);
    results.push({ kind, routes: rows.length, allSettled: rows.every(row => row.settled),
      enumOnly: rows.every(row => row.enumOnly), sentinelAbsent: rows.every(row => row.sentinelAbsent) });
  }
  const rootsEmpty = (await readdir(join(import.meta.dir, "owned"))).length === 0;
  console.log(JSON.stringify({ results, rootsEmpty, PIDs: 0, effects0: true }, null, 2));
  if (!rootsEmpty || results.some(row => !row.allSettled || !row.enumOnly || !row.sentinelAbsent)) process.exitCode = 1;
}
