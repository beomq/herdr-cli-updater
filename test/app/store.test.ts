import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStore } from "../../src/app/store";
import { AppError } from "../../src/app/types";
import { parseCommand } from "../../src/app/validation";
import { Database } from "bun:sqlite";

const roots: string[] = [], stores: AppStore[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "app-store-")));
  roots.push(root);
  const store = new AppStore(root);
  stores.push(store);
  return { root, store };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

test("a persisted request cannot create another effect after reconnect", () => {
  // Given: one accepted user intent in the real store.
  const { store, root } = fixture();
  const request = parseCommand({ requestId: "first", command: { kind: "check", installationId: "install:a" } });
  expect(store.accept(request)).toBe(true);
  store.finish(request.requestId, "completed");
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new AppStore(root); stores.push(reopened);
  // When: a reconnected caller repeats the same intent.
  const accepted = reopened.accept(request);
  // Then: no new operation is admitted.
  expect(accepted).toBe(false);
});

test("a repeated request id with another target conflicts", () => {
  // Given: an existing intent bound to one installation.
  const { store } = fixture();
  store.accept(parseCommand({ requestId: "first", command: { kind: "check", installationId: "install:a" } }));
  // When: a caller reuses its id for another installation.
  const changed = parseCommand({ requestId: "first", command: { kind: "check", installationId: "install:b" } });
  // Then: the request is rejected rather than forwarded.
  expect(() => store.accept(changed)).toThrow(AppError);
});

test("an interrupted intent stays uncertain after reopening instead of becoming replayable", () => {
  // Given: an accepted command whose result was not durably acknowledged.
  const { store, root } = fixture();
  const request = parseCommand({ requestId: "interrupted", command: { kind: "launch", installationId: "install:a", cwd: root } });
  store.accept(request);
  store.close(); stores.splice(stores.indexOf(store), 1);
  // When: a new service opens its store.
  const recovered = new AppStore(root); stores.push(recovered);
  // Then: identity is retained, but completion and a second effect are refused.
  expect(recovered.outcome(request.requestId)).toBe("uncertain");
  expect(recovered.accept(request)).toBe(false);
});

test.each([
  { kind: "launch", installationId: "install:a", cwd: "relative" },
  { kind: "launch", installationId: "install:a", cwd: "/tmp", executable: "/bin/sh" },
  { kind: "respond", sessionId: "session:a", generation: 0, approvalId: "a", value: { approved: true } },
  { kind: "policy", installationId: "install:a", mode: "force", intervalMinutes: 60 },
  { kind: "policy", installationId: "install:a", mode: "update", intervalMinutes: 0 },
  { kind: "policy", installationId: "install:a", mode: "update", intervalMinutes: 60, firstCheck: "whenever" },
  { kind: "confirm", operationId: "operation:a", revision: 0,
    sessions: [{ id: "a", generation: 1 }, { id: "a", generation: 1 }], restart: true },
  { kind:"install-recover",jobId:"job:a",revision:0,action:"delete" },
  { kind:"install-recover",jobId:"job:a",revision:0,action:"archive",target:"/tmp/other" },
  { kind:"install-recover",jobId:"job:a",revision:-1,action:"inspect" },
])("untrusted web commands cannot widen the declared operation", command => {
  // Given: malformed or capability-widening browser input.
  const envelope = { requestId: "first", command };
  // When / Then: boundary parsing refuses it before store or worker access.
  expect(() => parseCommand(envelope)).toThrow(AppError);
});

test("automatic timing and verified installation time survive reopening", () => {
  // Given: a policy and an installation receipt persisted independently of session restart.
  const { store, root } = fixture();
  store.putPolicy({ installationId: "install:a", mode: "check", intervalMinutes: 60,
    firstCheck: "after-interval", lastCheckedAt: 1000, nextCheckAt: 3601000, waitingReason: null });
  store.putOperation({ id: "update:a", requestId: "request:a", installationId: "install:a", kind: "update",
    stage: "uncertain", revision: 1, targetVersion: "2", beforeVersion: "1", installedVersion: "2",
    installedAt: 1500, sessionIds: [], restart: true, createdAt: 1000, updatedAt: 2000,
    failure: "restart_unverified", detail: null, jobId: "job:a" });
  store.close(); stores.splice(stores.indexOf(store), 1);
  // When: the service reopens its persistent state.
  const reopened = new AppStore(root); stores.push(reopened);
  // Then: a later restart failure has not erased or changed the verified installation time.
  expect(reopened.operation("update:a")).toMatchObject({ installedAt: 1500, updatedAt: 2000, stage: "uncertain" });
  expect(reopened.policies()[0]).toMatchObject({ firstCheck: "after-interval", nextCheckAt: 3601000, lastCheckedAt: 1000 });
});

test.each([undefined,'keep','restart-idle','restart-all'] as const)('stored pane policy %s preserves legacy semantics without rewriting its row',paneSessions=>{
  // Given: raw persisted data, including a legacy row that never passed the current writer.
  const {store,root}=fixture();
  const body=JSON.stringify({installationId:'install:legacy',mode:'update',intervalMinutes:60,firstCheck:'now',
    lastCheckedAt:null,nextCheckAt:1000,waitingReason:null,...(paneSessions?{paneSessions}:{})});
  store.close();stores.splice(stores.indexOf(store),1);
  const db=new Database(join(root,'app.sqlite'));
  try{db.query('INSERT INTO policies (id,body) VALUES (?,?)').run('install:legacy',body);}finally{db.close();}
  // When: the service reloads the policy using the real schema.
  const reopened=new AppStore(root);stores.push(reopened);
  // Then: explicit intent survives, missing legacy intent remains restart-idle, with no backfill write.
  expect(reopened.policies()[0]?.paneSessions).toBe(paneSessions??'restart-idle');
  const raw=new Database(join(root,'app.sqlite'),{readonly:true});
  try{expect(raw.query<{body:string},[]>('SELECT body FROM policies').get()?.body).toBe(body);}finally{raw.close();}
});
