import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { JobStore } from "../../src/jobs/store";
import type { NewJob } from "../../src/jobs/jobs";
import { JobError } from "../../src/jobs/jobs";

// allow: SIZE_OK — task23 owns this single SQLite test file; F3/F4 boundary matrices stay beside the original persistence regressions.
const roots: string[] = [];
const stores: JobStore[] = [];
function root(): string {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), "job-store-"));
  roots.push(parent);
  return join(parent, "owned");
}
function open(path = root()): JobStore {
  const store = new JobStore(path);
  stores.push(store);
  return store;
}
function spec(jobId = "job", requestId = "request"): NewJob {
  return { jobId, requestId, mode: "update-only", selectedTargets: [],
    installation: { installationId: "install", resourcesFingerprint: "fingerprint",
      owner: { kind: "native", installerDigest: "digest", prefix: "/qa/install" },
      installedVersion: { kind: "known", version: "1" } } };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("persists actual WAL rows across close and reopen with private permissions", () => {
  // Given
  const path = root();
  const store = open(path);
  const created = store.create(spec());
  store.close();
  // When
  const reopened = open(path);
  // Then
  expect(reopened.get("job")).toEqual(created.job);
  using db = new Database(join(path, "jobs.sqlite"), { readonly: true });
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(db.query("SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 1 });
  expect(lstatSync(path).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(path)) expect(lstatSync(join(path, name)).mode & 0o777).toBe(0o600);
});

test("lists stable public views from persisted jobs without exposing private records", () => {
  // Given
  const path = root();
  const store = open(path);
  store.create(spec("z-job", "z-request"));
  store.create(spec("A-job", "a-request"));
  store.change({ jobId: "z-job", expectedRevision: 0 }, { kind: "cancel" });
  store.close();
  const reopened = open(path);
  // When
  const jobs = reopened.list();
  // Then
  expect(jobs.map(job => [job.jobId, job.status, job.revision])).toEqual([
    ["A-job", "queued", 0], ["z-job", "cancelled", 1],
  ]);
  for (const job of jobs) expect(Object.keys(job).sort()).toEqual([
    "failure", "installTxn", "jobId", "mode", "requestId", "revision", "selectedTargets", "status", "targetTxns",
  ]);
  using db = new Database(join(path, "jobs.sqlite"), { readonly: true });
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  expect(db.query("SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 2 });
});

test("deduplicates request and job identities durably without including candidate ID in semantics", () => {
  // Given
  const path = root();
  const store = open(path);
  store.create(spec());
  store.close();
  const reopened = open(path);
  // When
  const repeated = reopened.create(spec("candidate", "request"));
  const alias = reopened.create(spec("job", "alias-request"));
  // Then
  expect(repeated.kind).toBe("existing");
  expect(repeated.job.jobId).toBe("job");
  expect(alias.kind).toBe("existing");
  expect(reopened.create(spec("unused", "alias-request")).job.jobId).toBe("job");
});

test.each(["job", "request"])("rejects semantic conflict on durable %s identity", identity => {
  // Given
  const store = open();
  store.create(spec());
  const input = spec(identity === "job" ? "job" : "other", identity === "request" ? "request" : "other");
  // When / Then
  expect(() => store.create({ ...input, installation: { ...input.installation, resourcesFingerprint: "changed" } }))
    .toThrow(new JobError("request_conflict"));
  expect(store.get("job").revision).toBe(0);
});

test("serializes revision CAS across independent database connections", () => {
  // Given
  const path = root();
  const first = open(path);
  const second = open(path);
  first.create(spec());
  // When
  first.change({ jobId: "job", expectedRevision: 0 }, { kind: "wait-resources" });
  // Then
  expect(() => second.change({ jobId: "job", expectedRevision: 0 }, { kind: "cancel" })).toThrow(new JobError("revision_conflict"));
  expect(second.get("job").status).toBe("waiting");
});

test("preserves the row when prospective cancellation result admission rejects", () => {
  // Given
  const store = open();
  const original = store.create(spec()).job;
  // When
  expect(() => store.change({ jobId: "job", expectedRevision: 0 }, { kind: "cancel" }, job => {
    expect(job.revision).toBe(1);
    expect(job.status).toBe("cancelled");
    throw new JobError("resources_busy");
  })).toThrow(new JobError("resources_busy"));
  // Then
  expect(store.get("job")).toEqual(original);
});

test("writes no intent or writer reservation when result admission rejects", () => {
  // Given
  const path = root();
  const store = open(path);
  const original = store.create(spec()).job;
  using db = new Database(join(path, "jobs.sqlite"), { readonly: true });
  // When
  expect(() => store.change({ jobId: "job", expectedRevision: 0 },
    { kind: "intent", operationId: "rejected", targetId: null, effect: "updated" },
    () => { throw new JobError("resources_busy"); })).toThrow(new JobError("resources_busy"));
  // Then
  expect(store.get("job")).toEqual(original);
  expect(db.query("SELECT count(*) AS n FROM intents").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM writer").get()).toEqual({ n: 0 });
});

test("commits the admitted exact prospective result without admitting stale CAS", () => {
  // Given
  const store = open();
  store.create(spec());
  let admitted = 0;
  // When
  const result = store.change({ jobId: "job", expectedRevision: 0 }, { kind: "cancel" }, job => {
    expect(job.status).toBe("cancelled");
    expect(job.revision).toBe(1);
    admitted++;
    return null;
  });
  // Then
  expect(result.job).toEqual(store.get("job"));
  expect(() => store.change({ jobId: "job", expectedRevision: 0 }, { kind: "cancel" },
    () => { admitted++; return null; })).toThrow(new JobError("revision_conflict"));
  expect(admitted).toBe(1);
});

test("keeps the global writer reserved across uncertain effects and process reopening", () => {
  // Given
  const path = root();
  const first = open(path);
  first.create(spec());
  first.create(spec("second", "second-request"));
  first.change({ jobId: "job", expectedRevision: 0 }, { kind: "intent", operationId: "op", targetId: null, effect: "updated" });
  first.close();
  const next = open(path);
  // When / Then
  expect(next.get("job").status).toBe("recovery_required");
  expect(() => next.change({ jobId: "second", expectedRevision: 0 }, { kind: "intent", operationId: "other-op", targetId: null, effect: "updated" }))
    .toThrow(new JobError("resources_busy"));
  expect(next.get("second").revision).toBe(0);
});

test("atomic intent authorizes once and cannot be replayed with a fresh revision", () => {
  // Given
  const store = open();
  store.create(spec());
  const intent = { kind: "intent", operationId: "op", targetId: null, effect: "updated" } as const;
  // When
  const first = store.change({ jobId: "job", expectedRevision: 0 }, intent);
  // Then
  expect(first.kind).toBe("authorized");
  expect(() => store.change({ jobId: "job", expectedRevision: 0 }, intent)).toThrow(new JobError("revision_conflict"));
  expect(() => store.change({ jobId: "job", expectedRevision: 1 }, intent)).toThrow(new JobError("invalid_transition"));
});

test.each(["token", "argv", "env", "transcript", "prompt"])("rejects secret-bearing %s before any durable write", field => {
  // Given
  const path = root();
  const store = open(path);
  const secret = "ULW_SECRET_REDACTION_jobstore";
  const input = { ...spec(), [field]: secret };
  // When
  expect(() => store.create(input)).toThrow(new JobError("invalid_input"));
  // Then
  for (const name of readdirSync(path)) expect(readFileSync(join(path, name)).includes(Buffer.from(secret))).toBe(false);
  expect(() => store.get("job")).toThrow(new JobError("not_found"));
});

test.each(["directory", "file", "wal", "shm", "hardlink", "foreign-db", "dirty"])("refuses foreign %s without clobber or permission repair", scenario => {
  // Given: every fixture path is disposable; no existing user directory is modified.
  const path = root();
  const foreign = join(dirnameOf(path), "foreign");
  writeFileSync(foreign, "preserve", { mode: 0o600 });
  if (scenario === "directory") symlinkSync(dirnameOf(path), path);
  else {
    mkdirSync(path, { mode: 0o700 });
    if (scenario === "file") symlinkSync(foreign, join(path, "jobs.sqlite"));
    if (scenario === "hardlink") linkSync(foreign, join(path, "jobs.sqlite"));
    if (scenario === "dirty") writeFileSync(join(path, "keep"), "keep");
    if (scenario === "foreign-db") {
      using db = new Database(join(path, "jobs.sqlite"), { create: true });
      db.exec("CREATE TABLE precious(value TEXT); INSERT INTO precious VALUES('preserve')");
      chmodSync(join(path, "jobs.sqlite"), 0o600);
    }
    if (scenario === "wal" || scenario === "shm") {
      rmSync(path, { recursive: true });
      open(path).close();
      const sidecar = join(path, `jobs.sqlite-${scenario}`);
      if (existsSync(sidecar)) rmSync(sidecar);
      symlinkSync(foreign, sidecar);
    }
  }
  const before = readFileSync(foreign);
  const names = readdirSync(path);
  // When / Then
  expect(() => open(path)).toThrow(new JobError("unsafe_path"));
  expect(readFileSync(foreign)).toEqual(before);
  expect(readdirSync(path)).toEqual(names);
});
function dirnameOf(path: string): string { return join(path, ".."); }

test("refuses an existing permissive owned directory without chmod", () => {
  // Given
  const path = root();
  open(path).close();
  chmodSync(path, 0o755);
  // When / Then
  expect(() => open(path)).toThrow(new JobError("unsafe_path"));
  expect(lstatSync(path).mode & 0o777).toBe(0o755);
});

test("rolls back intent and writer reservation when the final CAS write aborts", () => {
  // Given: a real SQLite failure inside the production transaction, not a mocked database.
  const path = root();
  const store = open(path);
  store.create(spec());
  using db = new Database(join(path, "jobs.sqlite"));
  db.exec("CREATE TRIGGER fail_cas BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'ULW_SECRET_REDACTION_sql'); END");
  // When / Then
  expect(() => store.change({ jobId: "job", expectedRevision: 0 }, { kind: "intent", targetId: null, effect: "updated", operationId: "op" }))
    .toThrow(new JobError("storage_failure"));
  expect(store.get("job").revision).toBe(0);
  expect(db.query("SELECT count(*) AS n FROM intents").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM writer").get()).toEqual({ n: 0 });
});

test("releases the writer only after completion and preserves global operation ID uniqueness", () => {
  // Given
  const store = open();
  store.create(spec());
  store.change({ jobId: "job", expectedRevision: 0 }, { kind: "intent", targetId: null, effect: "updated", operationId: "op" });
  store.change({ jobId: "job", expectedRevision: 1 }, { kind: "observe", targetId: null, receipt: { kind: "completed", operationId: "op", effect: "updated", identity: null } });
  store.change({ jobId: "job", expectedRevision: 2 }, { kind: "verify-install" });
  store.create(spec("second", "second-request"));
  // When / Then
  expect(() => store.change({ jobId: "second", expectedRevision: 0 }, { kind: "intent", targetId: null, effect: "updated", operationId: "op" }))
    .toThrow(new JobError("request_conflict"));
  expect(store.get("second").revision).toBe(0);
  expect(store.change({ jobId: "second", expectedRevision: 0 }, { kind: "intent", targetId: null, effect: "updated", operationId: "second-op" }).kind).toBe("authorized");
});

test.each(["create", "change", "revision"].flatMap(entry =>
  ["toJSON-error", "toJSON-proxy", "accessor", "proxy", "revoked", "native-error", "prototype-proxy"]
    .map(kind => ({ entry, kind }))))("rejects $entry $kind with a fixed code and zero caller hooks", ({ entry, kind }) => {
  // Given: do not inspect or coerce any caller-thrown value, even in the test.
  const store = open();
  store.create(spec());
  let hooks = 0;
  const sentinel = new Error("ULW_PRIVATE_SENTINEL_F3");
  const poison = new Proxy({}, { getPrototypeOf() { hooks++; throw sentinel; } });
  const base = entry === "create" ? spec("new", "new-request")
    : entry === "change" ? { kind: "wait-resources" } : { jobId: "job", expectedRevision: 0 };
  let input: unknown = base;
  switch (kind) {
    case "toJSON-error": case "toJSON-proxy":
      Object.defineProperty(base, "toJSON", { enumerable: true, value() { hooks++; throw kind === "toJSON-error" ? sentinel : poison; } });
      break;
    case "accessor":
      Object.defineProperty(base, entry === "create" ? "installation" : entry === "change" ? "kind" : "expectedRevision",
        { enumerable: true, get() { hooks++; throw poison; } });
      break;
    case "proxy":
      input = new Proxy(base, {
        get() { hooks++; throw sentinel; }, getPrototypeOf() { hooks++; throw sentinel; },
        ownKeys() { hooks++; throw sentinel; }, getOwnPropertyDescriptor() { hooks++; throw sentinel; },
      });
      break;
    case "revoked": {
      const revoked = Proxy.revocable(base, { getPrototypeOf() { hooks++; throw sentinel; } });
      revoked.revoke();
      input = revoked.proxy;
      break;
    }
    case "native-error": input = sentinel; break;
    case "prototype-proxy": Object.setPrototypeOf(base, poison); break;
    default: throw new JobError("invalid_input");
  }
  // When: Reflect.apply deliberately exercises the JavaScript boundary with non-DTO objects.
  let caught: unknown;
  try {
    if (entry === "create") Reflect.apply(store.create, store, [input]);
    else if (entry === "change") Reflect.apply(store.change, store, [{ jobId: "job", expectedRevision: 0 }, input]);
    else Reflect.apply(store.change, store, [input, { kind: "wait-resources" }]);
  } catch (error) { caught = error; }
  // Then: only a new code-only native JobError escapes; no hook ran and no row changed.
  expect(hooks).toBe(0);
  expect(caught === sentinel || caught === poison).toBe(false);
  expect(types.isProxy(caught)).toBe(false);
  expect(types.isNativeError(caught)).toBe(true);
  expect(Object.getPrototypeOf(caught)).toBe(JobError.prototype);
  expect(Object.getOwnPropertyDescriptor(caught, "code")?.value).toBe("invalid_input");
  expect(store.get("job").revision).toBe(0);
  expect(() => store.get("new")).toThrow(new JobError("not_found"));
});

test("rejects nested accessors and serialization hooks without invoking them", () => {
  // Given
  const store = open();
  let hooks = 0;
  const input = spec();
  Object.defineProperty(input.installation.owner, "prefix", { enumerable: true, get() { hooks++; return "/forbidden"; } });
  const event = { kind: "observe", targetId: null, receipt: { kind: "uncertain", operationId: "op",
    toJSON() { hooks++; return { kind: "completed", operationId: "op", effect: "updated", identity: null }; } } };
  // When / Then
  expect(() => store.create(input)).toThrow(new JobError("invalid_input"));
  expect(() => Reflect.apply(store.change, store, [{ jobId: "job", expectedRevision: 0 }, event])).toThrow(new JobError("invalid_input"));
  expect(hooks).toBe(0);
});

test("captures frozen data without changing the caller and retains internal error codes", () => {
  // Given
  const store = open();
  const input = Object.freeze(spec());
  const revision = Object.freeze({ jobId: "job", expectedRevision: 0 });
  const event = Object.freeze({ kind: "wait-resources" } as const);
  // When
  store.create(input);
  store.change(revision, event);
  // Then
  expect(revision.expectedRevision).toBe(0);
  expect(event.kind).toBe("wait-resources");
  expect(() => store.change(revision, event)).toThrow(new JobError("revision_conflict"));
});

test("maps a real SQLite writer lock to resources_busy without leaking its native error", () => {
  // Given: the competing write lock remains held until after the attempted transaction.
  const path = root();
  const store = open(path);
  store.create(spec());
  using locker = new Database(join(path, "jobs.sqlite"));
  locker.exec("BEGIN IMMEDIATE");
  try {
    // When / Then
    expect(() => store.change({ jobId: "job", expectedRevision: 0 }, { kind: "wait-resources" })).toThrow(new JobError("resources_busy"));
  } finally { locker.exec("ROLLBACK"); }
  expect(store.get("job").revision).toBe(0);
});

function durableHashes(path: string): string[] {
  return ["jobs.sqlite", "jobs.sqlite-wal"].filter(name => existsSync(join(path, name)))
    .map(name => createHash("sha256").update(readFileSync(join(path, name))).digest("hex"));
}
test.each(["renamed-table", "missing-index", "nonunique-index", "weak-check", "weak-foreign-key", "weak-unique", "non-strict", "extra-column"])(
  "refuses %s schema without writing durable bytes or losing receipts",
  variation => {
    // Given: a persisted uncertain operation and writer; corrupt only this fixture's schema.
    const path = root();
    const store = open(path);
    store.create(spec());
    store.change({ jobId: "job", expectedRevision: 0 }, { kind: "intent", operationId: "op", effect: "updated", targetId: null });
    store.close();
    using db = new Database(join(path, "jobs.sqlite"));
    const receipt = db.query<{ receipt: string }, []>("SELECT receipt FROM intents").get()?.receipt;
    if (!receipt) throw new JobError("corrupt_store");
    if (variation === "renamed-table") db.exec("ALTER TABLE intents RENAME TO alien_intents");
    else if (variation === "missing-index") db.exec("DROP INDEX one_install_intent");
    else if (variation === "nonunique-index") db.exec("DROP INDEX one_install_intent; CREATE INDEX one_install_intent ON intents(job_id) WHERE target_id IS NULL");
    else if (variation === "extra-column") db.exec("ALTER TABLE intents ADD COLUMN extra TEXT");
    else {
      const original = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE name='intents'").get()?.sql;
      if (!original) throw new JobError("corrupt_store");
      const changed = variation === "weak-check" ? original.replace("CHECK(effect IN ('updated','stopped','started'))", "")
        : variation === "weak-foreign-key" ? original.replace("REFERENCES jobs(job_id)", "")
        : variation === "weak-unique" ? original.replace(",\n    UNIQUE(job_id, target_id, effect)", "")
        : original.replace(" STRICT", "");
      expect(changed === original).toBe(false);
      db.transaction(() => {
        db.exec("DROP TABLE intents");
        db.exec(changed);
        db.exec("CREATE UNIQUE INDEX one_install_intent ON intents(job_id) WHERE target_id IS NULL");
        db.query("INSERT INTO intents(operation_id,job_id,target_id,effect,receipt) VALUES('op','job',NULL,'updated',?)").run(receipt);
      }).immediate();
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = durableHashes(path);
    // When / Then
    expect(() => open(path)).toThrow(new JobError("corrupt_store"));
    expect(durableHashes(path)).toEqual(before);
    expect(db.query("PRAGMA application_id").get()).toEqual({ application_id: 0x48554a31 });
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    const table = variation === "renamed-table" ? "alien_intents" : "intents";
    expect(db.query<{ receipt: string }, []>(`SELECT receipt FROM ${table}`).get()?.receipt === receipt).toBe(true);
    expect(db.query("SELECT count(*) AS n FROM writer").get()).toEqual({ n: 1 });
  },
);

test("refuses schema changes on an already open store before get or further mutation", () => {
  // Given
  const path = root();
  const store = open(path);
  store.create(spec());
  store.change({ jobId: "job", expectedRevision: 0 }, { kind: "intent", operationId: "op", effect: "updated", targetId: null });
  using db = new Database(join(path, "jobs.sqlite"));
  db.exec("ALTER TABLE intents RENAME TO alien_intents; PRAGMA wal_checkpoint(TRUNCATE)");
  const before = durableHashes(path);
  // When / Then
  expect(() => store.get("job")).toThrow(new JobError("corrupt_store"));
  expect(() => store.operation("op")).toThrow(new JobError("corrupt_store"));
  expect(() => store.create(spec("other", "other"))).toThrow(new JobError("corrupt_store"));
  expect(() => store.change({ jobId: "job", expectedRevision: 1 }, { kind: "recover" })).toThrow(new JobError("corrupt_store"));
  expect(durableHashes(path)).toEqual(before);
  expect(db.query("SELECT count(*) AS n FROM alien_intents").get()).toEqual({ n: 1 });
  expect(db.query("SELECT count(*) AS n FROM writer").get()).toEqual({ n: 1 });
});
