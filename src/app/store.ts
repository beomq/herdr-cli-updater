import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "./types";
import type { AppOperation, CommandEnvelope, UpdatePolicy } from "./types";
import { operationSchema, policySchema, installJobSchema } from "./validation";
import type { InstallJob } from "./catalog-types";
import { z } from "zod";
import { removalJobSchema } from './catalog-removal';
import type { RemovalJob } from './catalog-removal';
import { catalogUpdateSchema } from './catalog-updates';
import type { CatalogUpdateJob } from './catalog-updates';
import { catalogDefaultJobSchema } from './catalog-default-jobs';
import type { CatalogDefaultJob } from './catalog-default-jobs';
import { catalogBulkSchema } from './catalog-bulk';
import type { CatalogBulk } from './catalog-bulk';

const termsSchema = z.object({
  sessions: z.array(z.object({ id: z.string(), generation: z.number().int().nonnegative() }).strict()),
  automatic: z.boolean(),
  stopped: z.array(z.string()),
  restarts: z.array(z.object({
    id:z.string(),generation:z.number().int().nonnegative(),durableSessionId:z.string(),
    status:z.enum(['pending','completed']),
  }).strict()).default([]),
}).strict();
export type OperationTerms = z.infer<typeof termsSchema>;

export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o777) !== 0o700 || realpathSync(path) !== path)
    throw new AppError("invalid_request", "private_directory_required");
  return path;
}

/** Single service writer; SQLite owns request deduplication and durable operations. */
export class AppStore {
  readonly #db: Database;
  constructor(directory: string) {
    privateDirectory(directory);
    const file = join(directory, "app.sqlite");
    const before = lstatSync(file, { throwIfNoEntry: false });
    if (before && (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.()
      || (before.mode & 0o077) !== 0)) throw new AppError("invalid_request", "unsafe_store");
    this.#db = new Database(file, { create: true, strict: true });
    chmodSync(file, 0o600);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, body TEXT NOT NULL, outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS install_jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS removal_jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS catalog_updates (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS catalog_bulk (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS catalog_selection (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS default_jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prepared (id TEXT PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS terms (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    this.#db.exec("UPDATE commands SET outcome = 'uncertain' WHERE outcome = 'pending'");
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${file}${suffix}`;
      if (lstatSync(sidecar, { throwIfNoEntry: false })) chmodSync(sidecar, 0o600);
    }
  }
  accept(request: CommandEnvelope): boolean {
    return this.#db.transaction(() => {
      const body = createHash("sha256").update(JSON.stringify(request.command)).digest("hex");
      const previous = this.#db.query<{ body: string }, [string]>("SELECT body FROM commands WHERE id = ?").get(request.requestId);
      if (previous) {
        if (previous.body !== body) throw new AppError("conflict", "request_conflict");
        return false;
      }
      this.#db.query("INSERT INTO commands (id,body,outcome) VALUES (?,?,'pending')").run(request.requestId, body);
      return true;
    }).immediate();
  }
  catalogBulk():CatalogBulk|undefined {
    const row=this.#db.query<{body:string},[]>("SELECT body FROM catalog_bulk WHERE id=1").get();
    return row?catalogBulkSchema.parse(JSON.parse(row.body)):undefined;
  }
  putCatalogBulk(batch:CatalogBulk):void {
    this.#db.query("INSERT INTO catalog_bulk (id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(JSON.stringify(catalogBulkSchema.parse(batch)));
  }
  finish(requestId: string, outcome: "completed" | "failed" | "uncertain"): void {
    this.#db.query("UPDATE commands SET outcome = ? WHERE id = ?").run(outcome, requestId);
  }
  outcome(requestId: string): string {
    const row = this.#db.query<{ outcome: string }, [string]>("SELECT outcome FROM commands WHERE id = ?").get(requestId);
    if (!row) throw new AppError("not_found");
    return row.outcome;
  }
  operations(): readonly AppOperation[] {
    return this.#db.query<{ body: string }, []>("SELECT body FROM operations ORDER BY rowid DESC").all()
      .map(row => operationSchema.parse(JSON.parse(row.body)));
  }
  operation(id: string): AppOperation {
    const row = this.#db.query<{ body: string }, [string]>("SELECT body FROM operations WHERE id = ?").get(id);
    if (!row) throw new AppError("not_found");
    return operationSchema.parse(JSON.parse(row.body));
  }
  putOperation(operation: AppOperation): void {
    this.#db.query("INSERT INTO operations (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(operation.id, JSON.stringify(operationSchema.parse(operation)));
  }
  changeOperation(id: string, expectedRevision: number, change: Partial<Omit<AppOperation, "id" | "revision">>): AppOperation {
    return this.#db.transaction(() => {
      const before = this.operation(id);
      if (before.revision !== expectedRevision) throw new AppError("conflict", "revision_conflict");
      const after = { ...before, ...change, revision: before.revision + 1 };
      this.putOperation(after);
      return after;
    }).immediate();
  }
  policies(): readonly UpdatePolicy[] {
    return this.#db.query<{ body: string }, []>("SELECT body FROM policies ORDER BY id").all()
      .map(row => policySchema.parse(JSON.parse(row.body)));
  }
  putPolicy(policy: UpdatePolicy): void {
    this.#db.query("INSERT INTO policies (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(policy.installationId, JSON.stringify(policySchema.parse(policy)));
  }
  switchCatalogPolicy(catalogId:string,installationId:string,policies:readonly UpdatePolicy[]):void {
    this.#db.transaction(()=>{
      this.selectCatalogInstallation(catalogId,installationId);
      for(const policy of policies)this.putPolicy(policy);
    }).immediate();
  }
  putPolicies(policies:readonly UpdatePolicy[]):void {
    this.#db.transaction(()=>{for(const policy of policies)this.putPolicy(policy);}).immediate();
  }
  putPrepared(operationId: string, configuration: string): void {
    this.#db.query("INSERT INTO prepared (id,path) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path")
      .run(operationId, configuration);
  }
  prepared(operationId: string): string {
    const row = this.#db.query<{ path: string }, [string]>("SELECT path FROM prepared WHERE id = ?").get(operationId);
    if (!row) throw new AppError("not_found", "preparation_missing");
    return row.path;
  }
  putTerms(operationId: string, terms: z.input<typeof termsSchema>): void {
    this.#db.query("INSERT INTO terms (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(operationId, JSON.stringify(termsSchema.parse(terms)));
  }
  terms(operationId: string): OperationTerms {
    const row = this.#db.query<{ body: string }, [string]>("SELECT body FROM terms WHERE id = ?").get(operationId);
    if (!row) throw new AppError("not_found", "operation_terms_missing");
    return termsSchema.parse(JSON.parse(row.body));
  }
  close(): void { this.#db.close(); }
  installJobs(): readonly InstallJob[] {
    return this.#db.query<{ body: string }, []>("SELECT body FROM install_jobs ORDER BY rowid DESC").all()
      .map(row => JSON.parse(row.body))
      .filter(row => row?.catalogId !== 'gemini')
      .map(row => installJobSchema.parse(row));
  }
  putInstallJob(job: InstallJob): void {
    this.#db.query("INSERT INTO install_jobs (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(job.id, JSON.stringify(installJobSchema.parse(job)));
  }
  removalJobs(): readonly RemovalJob[] {
    return this.#db.query<{body:string},[]>("SELECT body FROM removal_jobs ORDER BY rowid DESC").all()
      .map(row=>JSON.parse(row.body))
      .filter(row=>row?.catalogId!=='gemini')
      .map(row=>removalJobSchema.parse(row));
  }
  putRemovalJob(job:RemovalJob):void {
    this.#db.query("INSERT INTO removal_jobs (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(job.id,JSON.stringify(removalJobSchema.parse(job)));
  }
  catalogUpdates():readonly CatalogUpdateJob[] {
    return this.#db.query<{body:string},[]>("SELECT body FROM catalog_updates ORDER BY rowid DESC").all()
      .map(row=>catalogUpdateSchema.parse(JSON.parse(row.body)));
  }
  putCatalogUpdate(job:CatalogUpdateJob):void {
    this.#db.query("INSERT INTO catalog_updates (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(job.id,JSON.stringify(catalogUpdateSchema.parse(job)));
  }
  catalogSelection(id:string):string|null {
    return this.#db.query<{installation_id:string},[string]>("SELECT installation_id FROM catalog_selection WHERE id=?").get(id)?.installation_id??null;
  }
  selectCatalogInstallation(id:string,installationId:string):void {
    this.#db.query("INSERT INTO catalog_selection (id,installation_id) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET installation_id=excluded.installation_id").run(id,installationId);
  }
  defaultJobs():readonly CatalogDefaultJob[] {
    return this.#db.query<{body:string},[]>("SELECT body FROM default_jobs ORDER BY rowid DESC").all()
      .map(row=>catalogDefaultJobSchema.parse(JSON.parse(row.body)));
  }
  putDefaultJob(job:CatalogDefaultJob):void {
    this.#db.query("INSERT INTO default_jobs (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(job.id,JSON.stringify(catalogDefaultJobSchema.parse(job)));
  }
}
