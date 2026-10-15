import { randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AdapterResult } from "../adapters/types";
import type { CheckResult, FailureCode, VersionEvidence } from "../protocol";

const MAX_ENTRIES = 64;
const MAX_BYTES = 1024 * 1024;
export type CheckReleaseReceipt = {
  readonly origin: string;
  readonly method: "GET" | "POST";
  readonly status: number;
  readonly bodyDigest: string;
  readonly acquiredAt: number;
};
export type CheckStoreEntry = {
  /** SHA256 of the complete ordered source AND policy snapshot, supplied by checker. */
  readonly subjectKey: string;
  readonly installedVersion: VersionEvidence;
  readonly checkedAt: number;
  readonly result: CheckResult;
  readonly metadata: readonly CheckReleaseReceipt[];
};
export type CheckStore = {
  readonly get: (subjectKey: string) => Promise<AdapterResult<CheckStoreEntry | null>>;
  readonly put: (entry: CheckStoreEntry) => Promise<AdapterResult<void>>;
};
type Document = { readonly schemaVersion: 1; readonly entries: readonly CheckStoreEntry[] };
type Snapshot = { readonly document: Document; readonly identity: Stats | null };
class StoreError extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function version(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\s\x00-\x1f\x7f]/.test(value);
}
function versionEvidence(value: unknown): value is VersionEvidence {
  if (!record(value)) return false;
  switch (value["kind"]) {
    case "known": return keys(value, ["kind", "version"]) && version(value["version"]);
    case "unknown": return keys(value, ["kind", "reason"])
      && (value["reason"] === "not_captured" || value["reason"] === "probe_failed");
    default: return false;
  }
}
const failureCodes = [
  "malformed_request", "unsupported_version", "unauthorized", "not_found", "stale_selection",
  "stale_binding", "revision_conflict", "request_conflict", "unsupported", "resources_busy",
  "external_writer", "cancel_unsafe", "missing_session", "identity_mismatch", "update_failed",
  "verification_failed", "receipt_uncertain", "recovery_required",
] as const satisfies readonly FailureCode[];
function checkResult(value: unknown): value is CheckResult {
  if (!record(value) || !timestamp(value["checkedAt"])) return false;
  switch (value["kind"]) {
    case "up-to-date": return keys(value, ["kind", "installedVersion", "checkedAt"]) && version(value["installedVersion"]);
    case "update-available": return keys(value, ["kind", "installedVersion", "availableVersion", "checkedAt"])
      && version(value["installedVersion"]) && version(value["availableVersion"])
      && value["availableVersion"] !== value["installedVersion"];
    case "unavailable": {
      const failure = value["failure"];
      return keys(value, ["kind", "failure", "checkedAt"]) && record(failure) && keys(failure, ["code"])
        && failureCodes.some(code => code === failure["code"]);
    }
    default: return false;
  }
}
function receipt(value: unknown): value is CheckReleaseReceipt {
  if (!record(value) || !keys(value, ["origin", "method", "status", "bodyDigest", "acquiredAt"])
    || typeof value["origin"] !== "string" || value["origin"].length > 8192
    || (value["method"] !== "GET" && value["method"] !== "POST") || typeof value["status"] !== "number"
    || !Number.isInteger(value["status"]) || value["status"] < 100 || value["status"] > 599
    || !digest(value["bodyDigest"]) || !timestamp(value["acquiredAt"])) return false;
  try {
    const origin = new URL(value["origin"]);
    return origin.protocol === "https:" && !origin.username && !origin.password && !origin.search && !origin.hash;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}
function entry(value: unknown): value is CheckStoreEntry {
  if (!record(value) || !keys(value, ["subjectKey", "installedVersion", "checkedAt", "result", "metadata"])
    || !digest(value["subjectKey"]) || !versionEvidence(value["installedVersion"])
    || !timestamp(value["checkedAt"]) || !checkResult(value["result"])
    || value["result"].checkedAt !== value["checkedAt"] || !Array.isArray(value["metadata"])
    || !value["metadata"].every(receipt)) return false;
  const checkedAt = value["checkedAt"];
  if (!value["metadata"].every(item => item.acquiredAt <= checkedAt)) return false;
  const result = value["result"], installed = value["installedVersion"];
  switch (result.kind) {
    case "unavailable": return true;
    case "up-to-date":
    case "update-available": return installed.kind === "known" && installed.version === result.installedVersion;
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function identity(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function same(left: Stats | null, right: Stats | null): boolean {
  return left === null ? right === null : right !== null && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function privateNode(node: Stats, directory: boolean): boolean {
  return node.uid === process.getuid?.() && (node.mode & 0o7777) === (directory ? 0o700 : 0o600)
    && (directory ? node.isDirectory() : node.isFile() && node.nlink === 1);
}
function refused(): never { throw new StoreError("recovery_required"); }
function failure(error: unknown): AdapterResult<never> {
  // Private filesystem boundary: raw OS errors and paths never cross the API.
  return { ok: false, error: { code: error instanceof StoreError ? error.code : "recovery_required" } };
}

/** One worker-owned writer. No cache, persistent handle or cross-process locking.
 * Each operation reopens the bounded file; absence is distinct from corruption.
 * Path fences are observations, not openat/renameat authority against another
 * process. Failed precommit leaves the old file; after rename, uncertainty is
 * recovery_required, never a promise to roll back a possibly committed check.
 */
export function createCheckStore(workerDirectory: string): CheckStore {
  const worker = resolve(workerDirectory), parent = dirname(worker);
  const directory = join(parent, `${basename(worker)}.checks`), file = join(directory, "checks.json");
  let queue: Promise<void> = Promise.resolve();
  function directoryIdentity(create: boolean): Stats | null {
    if (workerDirectory !== worker || realpathSync(parent) !== parent) refused();
    const ownedWorker = identity(worker);
    if (ownedWorker && !privateNode(ownedWorker, true)) refused();
    let current = identity(directory);
    if (!current && create) {
      mkdirSync(directory, { mode: 0o700 });
      current = identity(directory);
    }
    if (current && (!privateNode(current, true) || realpathSync(directory) !== directory)) refused();
    return current;
  }
  function fence(owned: Stats): void {
    const current = directoryIdentity(false);
    if (!current || current.dev !== owned.dev || current.ino !== owned.ino) refused();
  }
  async function read(owned: Stats): Promise<Snapshot> {
    fence(owned);
    const before = identity(file);
    if (!before) return { document: { schemaVersion: 1, entries: [] }, identity: null };
    if (!privateNode(before, false) || before.size > MAX_BYTES) refused();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let snapshot: Snapshot;
    try {
      const opened = await handle.stat();
      if (!same(before, opened) || !privateNode(opened, false)) refused();
      // A fixed-size buffer bounds allocation even if another writer grows the file.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const next = await handle.read(buffer, length, buffer.length - length, length);
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      if (length > MAX_BYTES || !same(opened, await handle.stat())) refused();
      fence(owned);
      if (!same(before, identity(file))) refused();
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))); }
      catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) throw new StoreError("verification_failed");
        throw error;
      }
      if (record(parsed) && parsed["schemaVersion"] !== 1) throw new StoreError("unsupported_version");
      if (!record(parsed) || !keys(parsed, ["schemaVersion", "entries"]) || !Array.isArray(parsed["entries"])
        || parsed["entries"].length > MAX_ENTRIES || !parsed["entries"].every(entry)
        || new Set(parsed["entries"].map(item => item.subjectKey)).size !== parsed["entries"].length)
        throw new StoreError("verification_failed");
      snapshot = { document: { schemaVersion: 1, entries: parsed["entries"] }, identity: before };
    } finally { await handle.close(); }
    fence(owned);
    if (!same(before, identity(file))) refused();
    return snapshot;
  }
  function serialize<T>(operation: () => Promise<AdapterResult<T>>): Promise<AdapterResult<T>> {
    const pending = queue.then(operation);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  return {
    get(subjectKey) {
      if (!digest(subjectKey)) return Promise.resolve({ ok: false, error: { code: "verification_failed" } });
      return serialize<CheckStoreEntry | null>(async () => {
        try {
          const owned = directoryIdentity(false);
          if (!owned) return { ok: true, value: null };
          const snapshot = await read(owned);
          const found = snapshot.document.entries.find(item => item.subjectKey === subjectKey);
          return { ok: true, value: found ? freeze(structuredClone(found)) : null };
        } catch (error) { return failure(error); }
      });
    },
    put(input) {
      // Capture and admit synchronously, before queueing or any filesystem await.
      let admitted: CheckStoreEntry;
      try {
        const cloned: unknown = structuredClone(input);
        if (!entry(cloned) || Buffer.byteLength(JSON.stringify({ schemaVersion: 1, entries: [cloned] })) > MAX_BYTES)
          throw new StoreError("verification_failed");
        admitted = freeze(cloned);
      } catch (error) {
        return Promise.resolve({ ok: false, error: {
          code: error instanceof StoreError ? error.code : "verification_failed",
        } });
      }
      return serialize(async () => {
        let temporary: string | undefined, temporaryIdentity: Stats | undefined;
        let committed = false;
        let result: AdapterResult<void>;
        try {
          const owned = directoryIdentity(true);
          if (!owned) refused();
          const previous = await read(owned);
          const entries = [...previous.document.entries.filter(item => item.subjectKey !== admitted.subjectKey), admitted]
            .slice(-MAX_ENTRIES);
          const body = JSON.stringify({ schemaVersion: 1, entries });
          if (Buffer.byteLength(body) > MAX_BYTES) throw new StoreError("verification_failed");
          temporary = join(directory, `.checks-${randomUUID()}.tmp`);
          const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try {
            temporaryIdentity = identity(temporary) ?? undefined;
            if (!temporaryIdentity || !privateNode(temporaryIdentity, false)
              || !same(temporaryIdentity, await handle.stat())) refused();
            await handle.writeFile(body, "utf8");
            await handle.sync();
          } finally { await handle.close(); }
          fence(owned);
          const completed = identity(temporary);
          if (!completed || completed.ino !== temporaryIdentity.ino || completed.dev !== temporaryIdentity.dev
            || !privateNode(completed, false) || !same(previous.identity, identity(file))) refused();
          await rename(temporary, file);
          committed = true;
          // A fulfilled rename is not proof that this path still names our
          // admitted bytes: reopen after the await and recheck owner and content.
          const published = await read(owned);
          fence(owned);
          if (!published.identity || published.identity.ino !== completed.ino || published.identity.dev !== completed.dev
            || !same(published.identity, identity(file)) || JSON.stringify(published.document) !== body) refused();
          result = { ok: true, value: undefined };
        } catch (error) {
          // After commit even decoder/admission failures describe an uncertain
          // publication, not a refused precommit input. Never promise rollback.
          result = committed ? { ok: false, error: { code: "recovery_required" } } : failure(error);
        }
        finally {
          try {
            if (temporary && temporaryIdentity) {
              const remaining = identity(temporary);
              if (remaining && remaining.ino === temporaryIdentity.ino && remaining.dev === temporaryIdentity.dev)
                await unlink(temporary);
            }
          } catch (error) {
            result = committed ? { ok: false, error: { code: "recovery_required" } } : failure(error);
          }
        }
        return result;
      });
    },
  };
}
