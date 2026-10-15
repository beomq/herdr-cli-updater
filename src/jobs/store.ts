import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonical, decodeJob, exact, identifier, initialJob, isReceipt, JobError, parseChange, parseNewJob, record, transition, viewJob } from "./jobs";
import type { Intent, JobChange, JobRecord, NewJob } from "./jobs";
import type { Job, Receipt } from "../protocol";

const applicationId = 0x48554a31;
const files = ["jobs.sqlite", "jobs.sqlite-wal", "jobs.sqlite-shm"] as const;
// allow: SIZE_OK — task23 fixes this file's ownership to SQLite persistence, including its input and schema admission boundaries.
const schemaSql = `
  CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY, semantic TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0), payload TEXT NOT NULL CHECK(json_valid(payload))
  ) STRICT;
  CREATE TABLE requests (request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id)) STRICT;
  CREATE TABLE intents (
    operation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id),
    target_id TEXT, effect TEXT NOT NULL CHECK(effect IN ('updated','stopped','started')),
    receipt TEXT NOT NULL CHECK(json_valid(receipt)),
    UNIQUE(job_id, target_id, effect)
  ) STRICT;
  CREATE UNIQUE INDEX one_install_intent ON intents(job_id) WHERE target_id IS NULL;
  CREATE TABLE writer (slot INTEGER PRIMARY KEY CHECK(slot=1), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id)) STRICT;
`;
function schemaLayout(db: Database): string {
  // Compare SQLite's own schema records, including autoindexes, FK/CHECK/STRICT declarations
  // and exact column order. No SQL parser or compatibility/migration rules.
  const rows = db.query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','view') ORDER BY type,name",
  ).all();
  return JSON.stringify(rows.map(row => [row.type, row.name, row.tbl_name, row.sql?.replace(/\s+/g, " ").trim() ?? null]));
}
const supportedSchema = (() => {
  using reference = new Database(":memory:");
  reference.exec(schemaSql);
  return schemaLayout(reference);
})();
function requireSchema(db: Database): void {
  // Auxiliary triggers are permitted; required table/index constraints are never relaxed.
  if (schemaLayout(db) !== supportedSchema) throw new JobError("corrupt_store");
}
type Row = { readonly payload: string; readonly revision: number; readonly semantic: string };
export type StoredOperation = {
  readonly jobId: string;
  readonly targetId: string | null;
  readonly effect: "updated" | "stopped" | "started";
  readonly receipt: Receipt;
};
export type Revision = { readonly jobId: string; readonly expectedRevision: number };
export type ChangeResult =
  | { readonly kind: "authorized"; readonly job: Job; readonly authorization: Intent }
  | { readonly kind: "recorded"; readonly job: Job };

function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new JobError("unsafe_path");
}
/** Accept only data-only JSON trees. Never enumerate a Proxy or read an accessor.
 * The opaque catch owns the UNTRUSTED boundary; no caught value is inspected.
 */
function captureInput(input: unknown): unknown {
  const ancestors = new WeakSet<object>();
  function copy(value: unknown, depth: number): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null || types.isProxy(value) || depth > 16 || ancestors.has(value)) {
      throw new JobError("invalid_input");
    }
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new JobError("invalid_input");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value) && keys.length !== value.length + 1) throw new JobError("invalid_input");
    const detached: object = array ? [] : {};
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || key === "toJSON" || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new JobError("invalid_input");
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new JobError("invalid_input");
      const child: unknown = descriptor.value;
      Object.defineProperty(detached, key, { value: copy(child, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(value);
    return detached;
  }
  try { return copy(input, 0); }
  catch { throw new JobError("invalid_input"); }
}
const jobErrorCodes: readonly JobError["code"][] = [
  "invalid_input", "not_found", "request_conflict", "revision_conflict", "invalid_transition",
  "cancel_unsafe", "receipt_mismatch", "resources_busy", "unsafe_path", "storage_failure", "corrupt_store",
];
function storageError(error: unknown): never {
  // Only native/internal work runs inside these catches, after captureInput has detached
  // caller data. Even unexpected thrown values cannot run prototype/accessor/coercion hooks.
  if (types.isProxy(error) || !types.isNativeError(error)) throw new JobError("storage_failure");
  const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
  const nativeName: unknown = Object.getOwnPropertyDescriptor(error, "name")?.value;
  const errno: unknown = Object.getOwnPropertyDescriptor(error, "errno")?.value;
  if (Object.getPrototypeOf(error) === JobError.prototype) {
    const known = jobErrorCodes.find(candidate => candidate === code);
    if (known) throw new JobError(known);
  }
  // Bun emits native Error instances with own SQLiteError/name/code/errno data.
  if (nativeName === "SQLiteError") {
    throw new JobError(typeof errno === "number" && ((errno & 0xff) === 5 || (errno & 0xff) === 6)
      ? "resources_busy" : "storage_failure");
  }
  if (Object.getPrototypeOf(error) === SyntaxError.prototype) throw new JobError("corrupt_store");
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) throw new JobError("unsafe_path");
  throw new JobError("storage_failure");
}

/** One private root for every writer of this user's queue. Different roots do NOT coordinate.
 * Same-UID callers are trusted. No external installer/core operations are implemented here.
 * DB/WAL/shm are never chmod'ed or replaced on reopen; foreign paths fail closed.
 */
export class JobStore {
  readonly #db: Database;
  readonly #root: string;
  readonly #rootIdentity: { readonly dev: number; readonly ino: number };
  readonly #fileIdentity: { readonly dev: number; readonly ino: number };

  constructor(root: string) {
    let db: Database | undefined;
    try {
      if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || realpathSync(dirname(root)) !== dirname(root)) throw new JobError("unsafe_path");
      const existing = lstatSync(root, { throwIfNoEntry: false });
      if (!existing) mkdirSync(root, { mode: 0o700 });
      privatePath(root, true);
      const path = join(root, files[0]);
      if (existing) {
        if (!readdirSync(root).every(name => files.some(file => name === file))) throw new JobError("unsafe_path");
        privatePath(path, false);
        for (const file of files.slice(1)) if (lstatSync(join(root, file), { throwIfNoEntry: false })) privatePath(join(root, file), false);
        // Check the SQLite header without opening a foreign WAL database (which could create sidecars).
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const header = Buffer.alloc(100);
          if (readSync(fd, header, 0, 100, 0) !== 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\u0000"
            || header.readUInt32BE(68) !== applicationId || header.readUInt32BE(60) !== 1) throw new JobError("unsafe_path");
        } finally { closeSync(fd); }
        // Read-only ownership gate, before any pragma or schema write to an existing DB.
        using probe = new Database(path, { readonly: true, strict: true });
        if (probe.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id !== applicationId
          || probe.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version !== 1) throw new JobError("unsafe_path");
        requireSchema(probe);
      } else {
        closeSync(openSync(path, "wx", 0o600));
      }
      db = new Database(path, { strict: true });
      db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
      const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get();
      if (mode?.journal_mode !== "wal") throw new JobError("storage_failure");
      if (!existing) {
        const initialized = db;
        initialized.transaction(() => {
          initialized.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1; ${schemaSql}`);
        }).immediate();
        initialized.exec("PRAGMA wal_checkpoint(FULL)");
      }
      this.#db = db;
      this.#root = root;
      this.#rootIdentity = lstatSync(root);
      this.#fileIdentity = lstatSync(path);
      this.#checkPaths();
    } catch (error) {
      try { db?.close(true); }
      catch { throw new JobError("storage_failure"); }
      storageError(error);
    }
  }
  #checkPaths(): void {
    privatePath(this.#root, true);
    const root = lstatSync(this.#root);
    if (root.dev !== this.#rootIdentity.dev || root.ino !== this.#rootIdentity.ino) throw new JobError("unsafe_path");
    for (const file of files) {
      const path = join(this.#root, file);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (file === files[0] && (!stat || stat.dev !== this.#fileIdentity.dev || stat.ino !== this.#fileIdentity.ino)) throw new JobError("unsafe_path");
      if (stat) privatePath(path, false);
    }
    requireSchema(this.#db);
  }
  #load(jobId: string): JobRecord {
    const row = this.#db.query<Row, [string]>("SELECT payload, revision, semantic FROM jobs WHERE job_id=?").get(jobId);
    if (!row) throw new JobError("not_found");
    const job = decodeJob(row.payload);
    if (job.spec.jobId !== jobId || job.revision !== row.revision) throw new JobError("corrupt_store");
    return job;
  }
  create(input: NewJob): { readonly kind: "created" | "existing"; readonly job: Job } {
    const spec = parseNewJob(captureInput(input));
    try {
      const semantic = createHash("sha256").update(canonical({
        installation: spec.installation, mode: spec.mode, selectedTargets: spec.selectedTargets,
      })).digest("hex");
      this.#checkPaths();
      return this.#db.transaction(() => {
        requireSchema(this.#db);
        const request = this.#db.query<{ job_id: string }, [string]>("SELECT job_id FROM requests WHERE request_id=?").get(spec.requestId);
        const candidates = this.#db.query<{ job_id: string; semantic: string }, [string, string]>(
          "SELECT job_id, semantic FROM jobs WHERE job_id=? OR job_id=?",
        ).all(spec.jobId, request?.job_id ?? spec.jobId);
        if (candidates.some(row => row.semantic !== semantic) || candidates.length > 1) throw new JobError("request_conflict");
        const existing = candidates[0];
        if (existing) {
          this.#db.query("INSERT OR IGNORE INTO requests(request_id,job_id) VALUES(?,?)").run(spec.requestId, existing.job_id);
          return { kind: "existing", job: viewJob(this.#load(existing.job_id)) } as const;
        }
        const job = initialJob(spec);
        if (spec.mode === "restart-only" && this.#db.query("SELECT 1 FROM writer WHERE slot=1").get())
          throw new JobError("resources_busy");
        this.#db.query("INSERT INTO jobs(job_id,semantic,revision,payload) VALUES(?,?,0,?)").run(spec.jobId, semantic, JSON.stringify(job));
        this.#db.query("INSERT INTO requests(request_id,job_id) VALUES(?,?)").run(spec.requestId, spec.jobId);
        if (spec.mode === "restart-only") this.#db.query("INSERT INTO writer(slot,job_id) VALUES(1,?)").run(spec.jobId);
        return { kind: "created", job: viewJob(job) } as const;
      }).immediate();
    } catch (error) { return storageError(error); }
  }
  get(jobId: string): Job {
    try {
      if (!identifier(jobId)) throw new JobError("invalid_input");
      this.#checkPaths();
      return viewJob(this.#load(jobId));
    } catch (error) { return storageError(error); }
  }
  /** Public views in stable binary job-ID order, from one SQLite read snapshot. */
  list(maxBytes?: number): readonly Job[] {
    try {
      this.#checkPaths();
      return this.#db.transaction(() => {
        const rows = this.#db.query<{ job_id: string }, []>("SELECT job_id FROM jobs ORDER BY job_id COLLATE BINARY").iterate();
        const jobs: Job[] = [];
        let bytes = 2; // JSON array brackets, with commas counted below.
        for (const row of rows) {
          const job = viewJob(this.#load(row.job_id));
          bytes += Buffer.byteLength(JSON.stringify(job)) + (jobs.length ? 1 : 0);
          if (maxBytes !== undefined && bytes > maxBytes) throw new JobError("resources_busy");
          jobs.push(job);
        }
        return jobs;
      })();
    } catch (error) { return storageError(error); }
  }
  operation(operationId: string): StoredOperation {
    try {
      if (!identifier(operationId)) throw new JobError("invalid_input");
      this.#checkPaths();
      const row = this.#db.query<{ job_id: string; target_id: string | null; effect: string; receipt: string }, [string]>(
        "SELECT job_id,target_id,effect,receipt FROM intents WHERE operation_id=?",
      ).get(operationId);
      if (!row) throw new JobError("not_found");
      const receipt: unknown = JSON.parse(row.receipt);
      if (!isReceipt(receipt) || receipt.operationId !== operationId
        || (row.effect !== "updated" && row.effect !== "stopped" && row.effect !== "started")) throw new JobError("corrupt_store");
      return { jobId: row.job_id, targetId: row.target_id, effect: row.effect, receipt };
    } catch (error) { return storageError(error); }
  }
  /** Only a newly committed intent returns authorization. get/create/reopen never do.
   * If the response/commit ACK is lost, inspect/reconcile the receipt; NEVER call the effect again.
   */
  change(revision: Revision, input: JobChange, admit?: (job: Job) => null): ChangeResult {
    const captured = captureInput(revision);
    if (!record(captured) || !exact(captured, ["jobId", "expectedRevision"]) || !identifier(captured["jobId"])
      || typeof captured["expectedRevision"] !== "number" || !Number.isSafeInteger(captured["expectedRevision"])
      || captured["expectedRevision"] < 0 || captured["expectedRevision"] >= Number.MAX_SAFE_INTEGER) throw new JobError("invalid_input");
    const expected: Revision = { jobId: captured["jobId"], expectedRevision: captured["expectedRevision"] };
    const change = parseChange(captureInput(input));
    try {
      this.#checkPaths();
      return this.#db.transaction((): ChangeResult => {
        requireSchema(this.#db);
        const old = this.#load(expected.jobId);
        if (old.revision !== expected.expectedRevision) throw new JobError("revision_conflict");
        if (change.kind === "observe") {
          const intent = this.#db.query<{ job_id: string; target_id: string | null; effect: string }, [string]>(
            "SELECT job_id,target_id,effect FROM intents WHERE operation_id=?",
          ).get(change.receipt.operationId);
          if (!intent || intent.job_id !== expected.jobId || intent.target_id !== change.targetId
            || (change.receipt.kind === "completed" && change.receipt.effect !== intent.effect)) throw new JobError("receipt_mismatch");
        }
        const next = transition(old, change);
        const job = viewJob(next);
        // Private, synchronous result admission occurs in the same transaction,
        // before any write. A network result must fit before its revision commits.
        if (admit && admit(job) !== null) throw new JobError("invalid_input");
        // Reserve before native claim, not only before stop. All update intents
        // use this same durable slot; an uncertain restart never releases it.
        if (change.kind === "intent" || change.kind === "claim") {
          const writer = this.#db.query<{ job_id: string }, []>("SELECT job_id FROM writer WHERE slot=1").get();
          if (writer && writer.job_id !== expected.jobId) throw new JobError("resources_busy");
          this.#db.query("INSERT OR IGNORE INTO writer(slot,job_id) VALUES(1,?)").run(expected.jobId);
        }
        if (change.kind === "intent") {
          if (this.#db.query("SELECT 1 FROM intents WHERE operation_id=?").get(change.operationId)) throw new JobError("request_conflict");
          this.#db.query("INSERT INTO intents(operation_id,job_id,target_id,effect,receipt) VALUES(?,?,?,?,?)")
            .run(change.operationId, expected.jobId, change.targetId, change.effect, JSON.stringify({ kind: "uncertain", operationId: change.operationId }));
        }
        if (change.kind === "observe") {
          const receipt: Receipt = change.receipt.kind === "completed" ? change.receipt : { kind: "uncertain", operationId: change.receipt.operationId };
          this.#db.query("UPDATE intents SET receipt=? WHERE operation_id=?").run(JSON.stringify(receipt), change.receipt.operationId);
        }
        const result = this.#db.query("UPDATE jobs SET payload=?,revision=? WHERE job_id=? AND revision=?")
          .run(JSON.stringify(next), next.revision, expected.jobId, expected.expectedRevision);
        if (result.changes !== 1) throw new JobError("revision_conflict");
        if (job.status === "completed" || job.status === "cancelled") this.#db.query("DELETE FROM writer WHERE job_id=?").run(job.jobId);
        return change.kind === "intent" ? { kind: "authorized", job, authorization: change } : { kind: "recorded", job };
      }).immediate();
    } catch (error) { return storageError(error); }
  }
  close(): void {
    try { this.#db.close(true); }
    catch (error) { storageError(error); }
  }
  [Symbol.dispose](): void { this.close(); }
}
