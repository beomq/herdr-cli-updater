import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { canonical, exact, identifier, record } from "../jobs/jobs";
import type { InstallationIdentity } from "../adapters/types";
import { parseAdapterContract } from "../adapters/types";
import { isTargetSelection } from "../protocol";
import type { Failure, TargetSelection } from "../protocol";
import { captureResourceData, evaluateResourceGate, parseResourcePlan, verifyResourceFingerprint } from "./resources";
import type { NativeExitAdmission, ResourcePlan } from "./resources";

export class QueueError extends Error {
  constructor(readonly code: Failure["code"]) { super(code); this.name = "QueueError"; }
}
export type QueueEntry = {
  readonly jobId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly state: "queued" | "completed" | "cancelled" | "recovery_required";
  readonly operationId: string | null;
};
/** Process-local capability. A copied/serialized object is never ownership. */
export type MutationOwnership = { readonly kind: "mutation-ownership" };
type Owner = { readonly jobId: string; readonly operationId: string; readonly revision: number };
type RestartReservation = { readonly kind: "restart-only"; readonly installation: InstallationIdentity; readonly target: TargetSelection };
function restartPlan(value: unknown): RestartReservation | null {
  if (!record(value) || !exact(value, ["kind", "installation", "target"]) || value["kind"] !== "restart-only"
    || !record(value["installation"]) || !isTargetSelection(value["target"])
    || value["target"].installationId !== value["installation"]["installationId"]
    || !verifyResourceFingerprint(value["installation"], value["installation"]).ok) return null;
  // The adapter parser supplies the typed installation after the data-only gate.
  const installation = parseAdapterContract({ version: 1, family: value["installation"]["family"],
    installation: value["installation"], runtime: null,
    capabilities: { check: unknownCapability, update: unknownCapability, busySafe: unknownCapability,
      completion: unknownCapability, resume: unknownCapability, gracefulExit: unknownCapability } });
  return installation.ok ? { kind: "restart-only", installation: installation.value.installation, target: value["target"] } : null;
}
const unknownCapability = { kind: "unknown", reason: "not_verified" } as const;
type Row = {
  readonly seq: number; readonly job_id: string; readonly request_id: string;
  readonly semantic: string; readonly plan: string; readonly revision: number;
  readonly state: "queued" | "intent" | "completed" | "cancelled" | "recovery_required";
  readonly operation_id: string | null; readonly slot: number | null;
};
const appId = 0x48555131;
const files = ["queue.sqlite", "queue.sqlite-wal", "queue.sqlite-shm"] as const;
const schema = `
  CREATE TABLE entries (
    seq INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL,
    semantic TEXT NOT NULL, plan TEXT NOT NULL CHECK(json_valid(plan)),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    state TEXT NOT NULL CHECK(state IN ('queued','intent','completed','cancelled','recovery_required')),
    operation_id TEXT UNIQUE, slot INTEGER CHECK(slot IS NULL OR slot=1),
    CHECK((state IN ('intent','recovery_required') AND slot IS NOT NULL AND slot=1 AND operation_id IS NOT NULL)
      OR (state='completed' AND slot IS NULL AND operation_id IS NOT NULL)
      OR (state IN ('queued','cancelled') AND slot IS NULL AND operation_id IS NULL))
  ) STRICT;
  CREATE UNIQUE INDEX single_mutation ON entries(slot) WHERE slot IS NOT NULL;
  CREATE TABLE requests (
    request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES entries(job_id)
  ) STRICT;
`;
function layout(db: Database): string {
  return JSON.stringify(db.query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','view') ORDER BY type,name",
  ).all().map(row => [row.type, row.name, row.tbl_name, row.sql?.replace(/\s+/g, " ").trim() ?? null]));
}
const expectedLayout = (() => {
  using db = new Database(":memory:");
  db.exec(schema);
  return layout(db);
})();
function requireSchema(db: Database): void {
  if (layout(db) !== expectedLayout) throw new QueueError("verification_failed");
}
function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new QueueError("unauthorized");
}
function fingerprint(plan: ResourcePlan): string {
  return createHash("sha256").update(canonical({
    ...plan, mutationResources: [...plan.mutationResources].sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    contract: { ...plan.contract, installation: { ...plan.contract.installation,
      resources: [...plan.contract.installation.resources].sort((a, b) => a.resourceId.localeCompare(b.resourceId)) } },
    selectedTargets: [...plan.selectedTargets].sort((a, b) => a.targetId.localeCompare(b.targetId)),
    ...(plan.transition ? { transition: {
      expectedAfter: { ...plan.transition.expectedAfter,
        resources: [...plan.transition.expectedAfter.resources].sort((a, b) => a.resourceId.localeCompare(b.resourceId)) },
      mutationRoots: [...plan.transition.mutationRoots].sort(),
    } } : {}),
  })).digest("hex");
}
const codes: readonly Failure["code"][] = ["malformed_request", "unauthorized", "verification_failed", "not_found",
  "request_conflict", "revision_conflict", "recovery_required", "cancel_unsafe", "resources_busy",
  "external_writer", "identity_mismatch", "unsupported"];
function failure(error: unknown): never {
  // Storage boundary matches JobStore: no caller exception inspection/coercion.
  if (types.isProxy(error) || !types.isNativeError(error)) throw new QueueError("verification_failed");
  const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
  if (Object.getPrototypeOf(error) === QueueError.prototype) {
    const found = codes.find(candidate => candidate === code);
    if (found) throw new QueueError(found);
  }
  const name: unknown = Object.getOwnPropertyDescriptor(error, "name")?.value;
  const errno: unknown = Object.getOwnPropertyDescriptor(error, "errno")?.value;
  if (name === "SQLiteError" && typeof errno === "number" && ((errno & 0xff) === 5 || (errno & 0xff) === 6))
    throw new QueueError("resources_busy");
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) throw new QueueError("unauthorized");
  throw new QueueError("verification_failed");
}
function revisionInput(jobId: string, revision: number): void {
  if (!identifier(jobId) || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
    throw new QueueError("malformed_request");
}
function publicEntry(row: Row): QueueEntry {
  return { jobId: row.job_id, requestId: row.request_id, revision: row.revision,
    state: row.state === "intent" ? "recovery_required" : row.state, operationId: row.operation_id };
}

/** User-global, independent of socket/server/cwd. Explicit roots are for isolated
 * embeddings/tests; callers using different roots DO NOT coordinate.
 */
export function userMutationQueueRoot(): string {
  try { return join(realpathSync(homedir()), ".herdr-cli-updater-mutations"); }
  catch { throw new QueueError("unauthorized"); }
}

/** Durable FIFO single writer, not a generic lock graph or executor.
 * An intent reserves the only slot until this exact owner verifies completion.
 * Reopen, PID death and elapsed time NEVER grant or reclaim ownership. Lost
 * ownership/ACK needs future explicit reconciliation; this API cannot replay it.
 * Separate DB from JobStore binds the full immutable plan, absent in its DTO.
 * Lifecycle/job-store coordination remains task22/23 integration, NOT atomic here.
 */
export class MutationQueue {
  readonly #db: Database;
  readonly #root: string;
  readonly #rootIdentity: { readonly dev: number; readonly ino: number };
  readonly #fileIdentity: { readonly dev: number; readonly ino: number };
  readonly #owners = new WeakMap<MutationOwnership, Owner>();

  constructor(root = userMutationQueueRoot()) {
    let db: Database | undefined;
    try {
      if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || realpathSync(dirname(root)) !== dirname(root))
        throw new QueueError("unauthorized");
      const existing = lstatSync(root, { throwIfNoEntry: false });
      if (!existing) mkdirSync(root, { mode: 0o700 });
      privatePath(root, true);
      const path = join(root, files[0]);
      if (existing) {
        if (!readdirSync(root).every(name => files.some(file => file === name))) throw new QueueError("unauthorized");
        privatePath(path, false);
        for (const name of files.slice(1)) if (lstatSync(join(root, name), { throwIfNoEntry: false })) privatePath(join(root, name), false);
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const header = Buffer.alloc(100);
          if (readSync(fd, header, 0, 100, 0) !== 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\u0000"
            || header.readUInt32BE(68) !== appId || header.readUInt32BE(60) !== 1) throw new QueueError("unauthorized");
        } finally { closeSync(fd); }
        using probe = new Database(path, { readonly: true, strict: true });
        requireSchema(probe);
      } else closeSync(openSync(path, "wx", 0o600));
      db = new Database(path, { strict: true });
      db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
      if (db.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get()?.journal_mode !== "wal")
        throw new QueueError("verification_failed");
      if (!existing) {
        const initialized = db;
        initialized.transaction(() => initialized.exec(`PRAGMA application_id=${appId}; PRAGMA user_version=1; ${schema}`)).immediate();
        initialized.exec("PRAGMA wal_checkpoint(FULL)");
      }
      this.#db = db; this.#root = root;
      this.#rootIdentity = lstatSync(root); this.#fileIdentity = lstatSync(path);
      this.#check();
    } catch (error) {
      try { db?.close(true); }
      catch { throw new QueueError("verification_failed"); }
      failure(error);
    }
  }
  #check(): void {
    privatePath(this.#root, true);
    const root = lstatSync(this.#root);
    if (root.dev !== this.#rootIdentity.dev || root.ino !== this.#rootIdentity.ino) throw new QueueError("unauthorized");
    if (!readdirSync(this.#root).every(name => files.some(file => file === name))) throw new QueueError("unauthorized");
    for (const name of files) {
      const path = join(this.#root, name), stat = lstatSync(path, { throwIfNoEntry: false });
      if (name === files[0] && (!stat || stat.dev !== this.#fileIdentity.dev || stat.ino !== this.#fileIdentity.ino))
        throw new QueueError("unauthorized");
      if (stat) privatePath(path, false);
    }
    requireSchema(this.#db);
  }
  #load(jobId: string): { readonly row: Row; readonly plan: ResourcePlan | RestartReservation } {
    const row = this.#db.query<Row, [string]>("SELECT * FROM entries WHERE job_id=?").get(jobId);
    if (!row) throw new QueueError("not_found");
    const parsed: unknown = JSON.parse(row.plan);
    const restart = restartPlan(parsed);
    if (restart) {
      if (createHash("sha256").update(canonical(restart)).digest("hex") !== row.semantic
        || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new QueueError("verification_failed");
      return { row, plan: restart };
    }
    const plan = parseResourcePlan(parsed);
    if (!plan.ok || fingerprint(plan.value) !== row.semantic || !Number.isSafeInteger(row.revision) || row.revision < 0)
      throw new QueueError("verification_failed");
    return { row, plan: plan.value };
  }
  enqueue(input: unknown): { readonly kind: "created" | "existing"; readonly entry: QueueEntry } {
    const data = captureResourceData(input);
    if (!data.ok) throw new QueueError(data.error.code);
    const value = data.value;
    if (!record(value) || !exact(value, ["jobId", "requestId", "plan"])
      || !identifier(value["jobId"]) || !identifier(value["requestId"])) throw new QueueError("malformed_request");
    const plan = parseResourcePlan(value["plan"]);
    if (!plan.ok) throw new QueueError(plan.error.code);
    const jobId = value["jobId"], requestId = value["requestId"], semantic = fingerprint(plan.value);
    try {
      this.#check();
      return this.#db.transaction(() => {
        const request = this.#db.query<{ job_id: string }, [string]>("SELECT job_id FROM requests WHERE request_id=?").get(requestId);
        const candidates = this.#db.query<Row, [string, string]>("SELECT * FROM entries WHERE job_id=? OR job_id=?")
          .all(jobId, request?.job_id ?? jobId);
        if (candidates.length > 1 || candidates.some(row => row.semantic !== semantic)) throw new QueueError("request_conflict");
        const existing = candidates[0];
        if (existing) {
          const entry = publicEntry(this.#load(existing.job_id).row);
          this.#db.query("INSERT OR IGNORE INTO requests VALUES(?,?)").run(requestId, existing.job_id);
          return { kind: "existing", entry } as const;
        }
        this.#db.query("INSERT INTO entries(job_id,request_id,semantic,plan,revision,state) VALUES(?,?,?,?,0,'queued')")
          .run(jobId, requestId, semantic, JSON.stringify(plan.value));
        this.#db.query("INSERT INTO requests VALUES(?,?)").run(requestId, jobId);
        return { kind: "created", entry: publicEntry(this.#load(jobId).row) } as const;
      }).immediate();
    } catch (error) { return failure(error); }
  }
  get(jobId: string): QueueEntry {
    try {
      if (!identifier(jobId)) throw new QueueError("malformed_request");
      this.#check();
      return publicEntry(this.#load(jobId).row);
    } catch (error) { return failure(error); }
  }
  /** The synchronous private reader runs under the write transaction. It must
   * freshly observe every socket/outside consumer and independently verify proof.
   * Omitted readers fail closed. Returned ownership is NOT an updater invocation.
   */
  acquire(jobId: string, expectedRevision: number, observe?: (plan: ResourcePlan) => unknown,
    nativeExit?: Omit<NativeExitAdmission, "jobId">): MutationOwnership {
    try {
      revisionInput(jobId, expectedRevision);
      this.#check();
      const owner = this.#db.transaction((): Owner => {
        const { row, plan } = this.#load(jobId);
        if ("kind" in plan) throw new QueueError("unsupported");
        if (row.revision !== expectedRevision) throw new QueueError("revision_conflict");
        if (row.state === "intent" || row.state === "recovery_required") throw new QueueError("recovery_required");
        if (row.state !== "queued") throw new QueueError("cancel_unsafe");
        if (this.#db.query("SELECT 1 FROM entries WHERE slot=1").get()
          || this.#db.query<{ job_id: string }, []>("SELECT job_id FROM entries WHERE state='queued' ORDER BY seq LIMIT 1").get()?.job_id !== jobId)
          throw new QueueError("resources_busy");
        if (!observe) throw new QueueError("unsupported");
        let observation: unknown;
        try { observation = observe(plan); }
        catch { throw new QueueError("verification_failed"); }
        const gate = evaluateResourceGate(plan, observation, nativeExit ? { ...nativeExit, jobId } : undefined);
        if (!gate.ok) throw new QueueError(gate.error.code);
        this.#check();
        const operationId = randomUUID();
        const result = this.#db.query("UPDATE entries SET state='intent',slot=1,operation_id=?,revision=revision+1 WHERE job_id=? AND revision=? AND state='queued'")
          .run(operationId, jobId, expectedRevision);
        if (result.changes !== 1) throw new QueueError("revision_conflict");
        return { jobId, operationId, revision: expectedRevision + 1 };
      }).immediate();
      const permit: MutationOwnership = Object.freeze({ kind: "mutation-ownership" });
      this.#owners.set(permit, owner);
      return permit;
    } catch (error) { return failure(error); }
  }
  cancel(jobId: string, expectedRevision: number): QueueEntry {
    try {
      revisionInput(jobId, expectedRevision);
      this.#check();
      return this.#db.transaction(() => {
        const { row } = this.#load(jobId);
        if (row.revision !== expectedRevision) throw new QueueError("revision_conflict");
        if (row.state !== "queued") throw new QueueError("cancel_unsafe");
        if (this.#db.query("UPDATE entries SET state='cancelled',revision=revision+1 WHERE job_id=? AND revision=? AND state='queued'")
          .run(jobId, expectedRevision).changes !== 1) throw new QueueError("revision_conflict");
        return publicEntry(this.#load(jobId).row);
      }).immediate();
    } catch (error) { return failure(error); }
  }
  /** A restart reserves the SAME durable slot, but never obtains update
   * authority or invents mutation resources/installer intent. The installation
   * is observed unchanged; native claim/stop/start owns session safety. */
  reserveRestart(input: { readonly jobId: string; readonly installation: InstallationIdentity; readonly target: TargetSelection },
    observe: () => unknown): MutationOwnership {
    const captured = captureResourceData(input);
    if (!captured.ok || !record(captured.value) || !exact(captured.value, ["jobId", "installation", "target"])
      || !identifier(captured.value["jobId"])) throw new QueueError("malformed_request");
    const jobId = captured.value["jobId"];
    const plan = restartPlan({ kind: "restart-only", installation: captured.value["installation"], target: captured.value["target"] });
    if (!plan) throw new QueueError("malformed_request");
    try {
      this.#check();
      const owner = this.#db.transaction(() => {
        if (this.#db.query("SELECT 1 FROM entries WHERE job_id=?").get(jobId)) throw new QueueError("recovery_required");
        if (this.#db.query("SELECT 1 FROM entries WHERE slot=1 OR state='queued'").get()) throw new QueueError("resources_busy");
        const verified = verifyResourceFingerprint(plan.installation, observe());
        if (!verified.ok) throw new QueueError(verified.error.code);
        this.#check();
        const operationId = randomUUID();
        this.#db.query("INSERT INTO entries(job_id,request_id,semantic,plan,revision,state,operation_id,slot) VALUES(?,?,?,?,1,'intent',?,1)")
          .run(jobId, jobId, createHash("sha256").update(canonical(plan)).digest("hex"), JSON.stringify(plan), operationId);
        this.#db.query("INSERT INTO requests VALUES(?,?)").run(jobId, jobId);
        return { jobId, operationId, revision: 1 };
      }).immediate();
      const permit: MutationOwnership = Object.freeze({ kind: "mutation-ownership" });
      this.#owners.set(permit, owner);
      return permit;
    } catch (error) { return failure(error); }
  }
  completeRestart(permit: MutationOwnership, observe: () => unknown): QueueEntry {
    const owner = this.#owners.get(permit);
    if (!owner) throw new QueueError("unauthorized");
    try {
      this.#check();
      const entry = this.#db.transaction(() => {
        const { row, plan } = this.#load(owner.jobId);
        if (!("kind" in plan) || row.state !== "intent" || row.revision !== owner.revision
          || row.operation_id !== owner.operationId || row.slot !== 1) throw new QueueError("revision_conflict");
        const verified = verifyResourceFingerprint(plan.installation, observe());
        if (!verified.ok) throw new QueueError(verified.error.code);
        this.#check();
        if (this.#db.query("UPDATE entries SET state='completed',slot=NULL,revision=revision+1 WHERE job_id=? AND revision=? AND slot=1")
          .run(owner.jobId, owner.revision).changes !== 1) throw new QueueError("revision_conflict");
        return publicEntry(this.#load(owner.jobId).row);
      }).immediate();
      this.#owners.delete(permit);
      return entry;
    } catch (error) { return failure(error); }
  }
  /** Only the original in-process owner may settle. A transition pins the expected
   * artifact at enqueue; the caller cannot replace it at completion. An independent
   * postflight reader is still required; exit code alone is insufficient.
   * Failure leaves the global slot occupied, with no retry/reclamation API.
   */
  complete(permit: MutationOwnership, expected: InstallationIdentity, observe: () => unknown): QueueEntry {
    const owner = this.#owners.get(permit);
    if (!owner) throw new QueueError("unauthorized");
    try {
      this.#check();
      const result = this.#db.transaction(() => {
        const { row, plan } = this.#load(owner.jobId);
        if ("kind" in plan) throw new QueueError("unsupported");
        if (row.revision !== owner.revision || row.operation_id !== owner.operationId || row.state !== "intent" || row.slot !== 1)
          throw new QueueError("revision_conflict");
        // Capture desired output before invoking any private reader.
        const captured = captureResourceData(expected);
        let code: Failure["code"] | null = captured.ok ? null : captured.error.code;
        if (captured.ok && plan.transition) {
          const matches = verifyResourceFingerprint(plan.transition.expectedAfter, captured.value);
          if (!matches.ok) code = matches.error.code === "external_writer" ? "identity_mismatch" : matches.error.code;
        }
        let observed: unknown;
        if (code === null) {
          try { observed = observe(); }
          catch { code = "verification_failed"; }
        }
        if (code === null && captured.ok) {
          const verified = verifyResourceFingerprint(plan.transition?.expectedAfter ?? captured.value, observed);
          if (!verified.ok) code = verified.error.code;
          else if (!plan.transition && record(captured.value)) {
            const before = plan.contract.installation;
            // Version/fingerprints may change, never owner/channel/installation/write-set geometry.
            const post = captured.value;
            const rs = post["resources"];
            if (post["installationId"] !== before.installationId || post["family"] !== before.family
              || post["channel"] !== before.channel || post["executableRealpath"] !== before.executableRealpath
              || canonical(post["owner"]) !== canonical(before.owner) || !Array.isArray(rs)
              || canonical(rs.map((r: unknown) => record(r) ? [r["resourceId"], r["realpath"]] : null).sort())
                !== canonical(before.resources.map(r => [r.resourceId, r.realpath]).sort())) code = "identity_mismatch";
          }
        }
        this.#check();
        if (this.#db.query("UPDATE entries SET state=?,slot=?,revision=revision+1 WHERE job_id=? AND revision=? AND operation_id=? AND slot=1")
          .run(code === null ? "completed" : "recovery_required", code === null ? null : 1,
            owner.jobId, owner.revision, owner.operationId).changes !== 1) throw new QueueError("revision_conflict");
        return { entry: publicEntry(this.#load(owner.jobId).row), code };
      }).immediate();
      this.#owners.delete(permit);
      if (result.code !== null) throw new QueueError(result.code);
      return result.entry;
    } catch (error) { return failure(error); }
  }
  close(): void {
    try { this.#db.close(true); }
    catch (error) { failure(error); }
  }
  [Symbol.dispose](): void { this.close(); }
}
