import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  accessSync, constants, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync,
  closeSync, openSync, renameSync, statSync, writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createCursorAdapter, CURSOR_INSTALLER_DIGEST, CURSOR_SOURCE_VERSION } from "../../src/adapters/cursor";
import type { CursorConfiguration } from "../../src/adapters/cursor";
import type { AdapterResult, InstallationIdentity, RuntimeIdentity } from "../../src/adapters/types";

const evidence = resolve(import.meta.dir, "../fixtures/evidence/task-15/r4");
const temporary = realpathSync(mkdtempSync(join(evidence, "test-run-")));
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
});

test("T15-r4 late owner execute access must reject mode0401 despite other execute bit", async () => {
  const f = fixture(), before = statSync(f.executable), bytes = readFileSync(f.executable);
  let decoded = false, lateReads = 0;
  const a = createCursorAdapter({ ...f.config,
    decodeMetadata: value => { decoded = true; return f.config.decodeMetadata(value); },
    privateRuntime: () => {
      if (decoded) { lateReads++; chmodSync(f.executable, 0o401); }
      return f.privateRow;
    },
  });
  success(await a.detect(f.executable));
  const result = a.exactResume(f.runtime), after = statSync(f.executable);
  expect(lateReads).toBe(1);
  expect(() => accessSync(f.executable, constants.X_OK)).toThrow();
  expect(() => accessSync(f.executable, constants.R_OK)).not.toThrow();
  expect(after.mode & 0o111).not.toBe(0);
  expect(after.uid === process.getuid?.()).toBe(true);
  expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  expect(readFileSync(f.executable)).toEqual(bytes);
  expect(result).toEqual({ ok: false, error: { code: "identity_mismatch" } });
});

describe("Cursor revision three corrective regressions", () => {
  for (const change of ["bytes", "mode"] as const) {
    test(`T15-r2-N1 final private reader ${change} must reject before candidate`, async () => {
      const f = fixture(), events: string[] = [];
      let decoded = false, clockReads = 0;
      const a = createCursorAdapter({ ...f.config,
        now: () => { clockReads++; return 100; },
        decodeMetadata: value => {
          decoded = true; events.push("decoder");
          return f.config.decodeMetadata(value);
        },
        installation: path => {
          if (decoded) events.push("installation");
          return f.config.installation(path);
        },
        preflight: () => {
          if (decoded) events.push("preflight");
          return f.preflight;
        },
        privateRuntime: () => {
          if (decoded) {
            events.push("privateRuntime");
            const before = statSync(f.executable, { bigint: true });
            if (change === "bytes") {
              copyFileSync(f.storagePath, f.executable);
              chmodSync(f.executable, 0o700);
            }
            else chmodSync(f.executable, 0o600);
            const after = statSync(f.executable, { bigint: true });
            expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
          }
          return f.privateRow;
        },
      });
      success(await a.detect(f.executable));
      expect(a.exactResume(f.runtime)).toEqual({ ok: false, error: {
        code: change === "bytes" ? "external_writer" : "identity_mismatch",
      } });
      expect(events).toEqual(["decoder", "installation", "preflight", "privateRuntime"]);
      expect(clockReads).toBe(0);
    });
  }
  for (const target of ["runtime", "stored", "session"] as const) {
    test(`T15-r2-N2 ${target} custom prototype rejects before normalization`, async () => {
      const f = fixture();
      await f.detected();
      const value = target === "runtime" ? f.runtime : target === "stored"
        ? f.privateRow : f.runtime.binding.session;
      Object.setPrototypeOf(value, { synthetic: true });
      expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
    });
  }
  for (const poison of ["proxy", "getter", "hook"] as const) {
    test(`T15-r3 raw ${poison} rejects without observing hooks`, async () => {
      const f = fixture();
      await f.detected();
      let reads = 0;
      if (poison === "getter") Object.defineProperty(f.runtime.binding.session, "fullId", {
        enumerable: true, get() { reads++; return "12345678-1234-1234-1234-123456789abc"; },
      });
      if (poison === "hook") Object.defineProperty(f.runtime.binding.session, "toJSON", {
        value: () => { reads++; return {}; },
      });
      const input = poison === "proxy" ? new Proxy(f.runtime, {
        getPrototypeOf(target) { reads++; return Object.getPrototypeOf(target); },
        ownKeys(target) { reads++; return Reflect.ownKeys(target); },
      }) : f.runtime;
      expect(f.adapter.exactResume(input)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
      expect(reads).toBe(0);
    });
  }
  test("T15-r3 last reader cannot change an already classified preflight prototype", async () => {
    const f = fixture();
    let decoded = false, changes = 0;
    const a = createCursorAdapter({ ...f.config,
      decodeMetadata: value => { decoded = true; return f.config.decodeMetadata(value); },
      privateRuntime: () => {
        if (decoded) { changes++; Object.setPrototypeOf(f.preflight.runtime.binding.session, { synthetic: true }); }
        return f.privateRow;
      },
    });
    success(await a.detect(f.executable));
    expect(a.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
    expect(changes).toBe(1);
  });
});

describe("Cursor independent audit regressions", () => {
  for (const part of ["binding", "options", "private-options", "issued-runtime", "late-binding", "late-options"] as const) {
    test(`T15-A1 snapshots and revalidates ${part} instead of shared references`, async () => {
      const f = fixture();
      let decoded = false;
      const a = createCursorAdapter({ ...f.config,
        decodeMetadata: value => {
          decoded = true;
          if (part === "private-options") f.privateRow.environment.LANG = "changed";
          if (part === "issued-runtime") {
            Object.assign(f.runtime.binding, { turnGeneration: 2 });
            f.preflight.runtime = structuredClone(f.runtime);
          }
          return f.config.decodeMetadata(value);
        },
        preflight: () => {
          if (decoded && part === "binding") f.preflight.runtime = { ...f.preflight.runtime,
            binding: { ...f.preflight.runtime.binding, turnGeneration: 2 } };
          if (decoded && part === "options") f.preflight.optionsSha256 = hash("changed");
          return f.preflight;
        },
        privateRuntime: () => {
          if (decoded && part === "late-binding") f.preflight.runtime = { ...f.preflight.runtime,
            binding: { ...f.preflight.runtime.binding, turnGeneration: 2 } };
          if (decoded && part === "late-options") f.preflight.optionsSha256 = hash("changed-late");
          return f.privateRow;
        },
      });
      success(await a.detect(f.executable));
      expect(a.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "stale_binding" } });
    });
  }
  for (const phase of ["decoder", "final-preflight", "final-installation"] as const) {
    for (const replacement of ["deleted", "symlink"] as const) {
      test(`T15-A2 canonical cwd ${replacement} during ${phase} cannot become a command`, async () => {
        const f = fixture(), original = f.runtime.binding.cwd;
        let decoded = false, changed = false;
        const replace = () => {
          if (changed) return;
          changed = true;
          if (replacement === "deleted") rmSync(original, { recursive: true });
          else {
            const target = join(f.root, "redirect");
            mkdirSync(target);
            renameSync(original, join(f.root, "original-workspace"));
            symlinkSync(target, original);
          }
        };
        const a = createCursorAdapter({ ...f.config,
          decodeMetadata: value => {
            decoded = true;
            if (phase === "decoder") replace();
            return f.config.decodeMetadata(value);
          },
          preflight: () => {
            if (decoded && phase === "final-preflight") replace();
            return f.preflight;
          },
          installation: path => {
            if (decoded && phase === "final-installation") replace();
            return f.config.installation(path);
          },
        });
        success(await a.detect(f.executable));
        expect(a.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "stale_binding" } });
        expect(f.runtime.binding.cwd).toBe(original);
      });
    }
  }
  for (const payload of ["Error-getter", "object-getter", "revokedProxy", "null", "string"] as const) {
    for (const callback of ["release", "now", "privateRuntime", "preflight", "decodeMetadata"] as const) {
      test(`T15-A3 ${callback} ${payload} becomes a safe nonobserving enum failure`, async () => {
        const f = fixture();
        let reads = 0;
        const boom = (): never => {
          if (payload === "revokedProxy") {
            const revoked = Proxy.revocable({}, {});
            revoked.revoke();
            throw revoked.proxy;
          }
          if (payload === "null") throw null;
          if (payload === "string") throw "PRIVATE_THROWN_TEXT";
          const value = payload === "Error-getter" ? new Error("PRIVATE_THROWN_TEXT") : {};
          Object.defineProperty(value, "code", { get() { reads++; throw new Error("PRIVATE_GETTER"); } });
          throw value;
        };
        const a = createCursorAdapter({ ...f.config, [callback]: boom });
        const installation = success(await a.detect(f.executable));
        const result = callback === "release" || callback === "now"
          ? await a.check(installation) : a.exactResume(f.runtime);
        expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
        expect(reads).toBe(0);
      });
    }
  }
  for (const method of ["updateSpec", "bridge", "gracefulExit"] as const) {
    test(`T15-A3 revoked installation reader cannot escape ${method}`, async () => {
      const f = fixture();
      let active = false;
      const a = createCursorAdapter({ ...f.config, installation: path => {
        if (!active) return f.config.installation(path);
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        throw revoked.proxy;
      } });
      const installation = success(await a.detect(f.executable));
      active = true;
      const result = method === "updateSpec" ? a.updateSpec(installation, "update-only")
        : method === "bridge" ? a.bridge(f.runtime) : a.gracefulExit(f.runtime, "operation", "owner");
      expect(result).toEqual({ ok: false, error: { code: "verification_failed" } });
    });
  }
  for (const part of ["executable", "prefix", "cwd", "DB"] as const) {
    test(`T15-A4 ${part} same-path inode replacement is stale despite identical bytes`, async () => {
      const f = fixture();
      await f.detected();
      const path = part === "cwd" ? f.runtime.binding.cwd : part === "prefix"
        ? dirname(f.executable) : part === "DB" ? f.storagePath : f.executable;
      const before = statSync(path, { bigint: true });
      if (part === "prefix") {
        renameSync(path, join(f.root, "old-prefix"));
        mkdirSync(path);
        copyFileSync(join(f.root, "old-prefix/cursor-agent"), f.executable);
        chmodSync(f.executable, 0o700);
      } else if (part === "cwd") {
        renameSync(path, join(f.root, "old-workspace"));
        mkdirSync(path);
      } else {
        const replacement = join(f.root, "replacement");
        const original = readFileSync(path);
        copyFileSync(path, replacement);
        if (part === "executable") chmodSync(replacement, 0o700);
        renameSync(replacement, path);
        expect(readFileSync(path)).toEqual(original);
      }
      expect(statSync(path, { bigint: true }).ino === before.ino).toBe(false);
      expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: {
        code: part === "cwd" || part === "DB" ? "stale_binding" : "stale_selection",
      } });
    });
  }
  for (const table of ["meta", "blobs"] as const) {
    for (const duplicate of [true, false]) {
      test(`T15-A5 ${duplicate ? "duplicate contradictory" : "nonunique"} ${table} rows require an unambiguous native schema`, async () => {
        const f = fixture();
        await f.detected();
        const db = new Database(f.storagePath);
        try {
          db.exec(`ALTER TABLE ${table} RENAME TO old;
            CREATE TABLE ${table} (${table === "meta" ? "key TEXT,value TEXT" : "id TEXT,data BLOB"});
            INSERT INTO ${table} SELECT * FROM old; DROP TABLE old`);
          if (duplicate) {
            if (table === "meta") db.query("INSERT INTO meta VALUES ('0', ?)").run(JSON.stringify({ fullId: "wrong", rootBlobId: "aabb" }));
            else db.exec("INSERT INTO blobs VALUES ('aabb', x'')");
          }
        } finally { db.close(); }
        f.refreshDb();
        expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
      });
    }
  }
  test("T15-A5 readonly whole-database integrity rejects damage outside selected session rows", async () => {
    const f = fixture();
    await f.detected();
    const db = new Database(f.storagePath);
    let rootpage: unknown;
    try {
      db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('damage')");
      const row: unknown = db.query("SELECT rootpage FROM sqlite_schema WHERE name='unrelated'").get();
      if (typeof row === "object" && row !== null && "rootpage" in row) rootpage = row.rootpage;
    } finally { db.close(); }
    if (typeof rootpage !== "number" || rootpage <= 1) throw new Error("invalid fixture rootpage");
    const pageSize = readFileSync(f.storagePath).readUInt16BE(16);
    const fd = openSync(f.storagePath, "r+");
    try { writeSync(fd, new Uint8Array([0]), 0, 1, (rootpage - 1) * pageSize); }
    finally { closeSync(fd); }
    const readonly = new Database(f.storagePath, { readonly: true, create: false });
    try {
      expect(readonly.query("SELECT value FROM meta WHERE key='0'").get()).not.toBeNull();
      expect(readonly.query("SELECT data FROM blobs WHERE id='aabb'").get()).not.toBeNull();
      expect(() => readonly.query("PRAGMA integrity_check").all()).toThrow();
    } finally { readonly.close(); }
    f.refreshDb();
    const before = readFileSync(f.storagePath), names = readdirSync(dirname(f.storagePath));
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "verification_failed" } });
    expect(readFileSync(f.storagePath)).toEqual(before);
    expect(readdirSync(dirname(f.storagePath))).toEqual(names);
  });
});
afterAll(() => {
  expect(roots).toHaveLength(0);
  rmdirSync(temporary);
});
function success<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new Error(`fixture setup failed: ${result.error.code}`);
  return result.value;
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(temporary, "cursor-")));
  roots.push(root);
  const prefix = join(root, "versions", CURSOR_SOURCE_VERSION);
  mkdirSync(prefix, { recursive: true });
  const executable = join(prefix, "cursor-agent");
  copyFileSync(join(evidence, "fixtures", "cursor-agent"), executable);
  chmodSync(executable, 0o700);
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const resources = [{ resourceId: `resource:${hash(executable)}`, realpath: executable,
    fingerprint: `sha256:${hash(readFileSync(executable))}` }];
  const installation: InstallationIdentity = {
    installationId: `install:${hash(executable)}`, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}`,
    family: "cursor", owner: { kind: "native", installerDigest: CURSOR_INSTALLER_DIGEST, prefix },
    installedVersion: { kind: "known", version: CURSOR_SOURCE_VERSION }, channel: "lab",
    executableRealpath: executable, resources,
  };
  const fullId = "12345678-1234-1234-1234-123456789abc", chatsRoot = join(root, "chats");
  const storagePath = join(chatsRoot, createHash("md5").update(cwd).digest("hex"), fullId, "store.db");
  mkdirSync(dirname(storagePath), { recursive: true });
  const db = new Database(storagePath);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
  // Test-only decoder format. This is NOT a Cursor native-format fixture.
  db.query("INSERT INTO meta VALUES ('0', ?)").run(JSON.stringify({ fullId, rootBlobId: "aabb" }));
  db.query("INSERT INTO blobs VALUES ('aabb', ?)").run(new Uint8Array([1, 2, 3]));
  db.close();
  const runtime: RuntimeIdentity = {
    runtimeId: "runtime:cursor", installationId: installation.installationId,
    runningVersion: { kind: "known", version: CURSOR_SOURCE_VERSION },
    binding: { socketId: "socket", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
      rootIncarnation: { pid: 987654, startIdentity: "fixture-start", executableRealpath: executable },
      session: { kind: "conversation", fullId, storagePathHash: hash(storagePath) },
      cwd, optionsRef: "options:cursor", turnGeneration: 1, resourcesFingerprint: installation.resourcesFingerprint },
  };
  const privateRow = { storagePath, chatsRoot, storageSha256: hash(readFileSync(storagePath)),
    fullId, cwd, optionsRef: runtime.binding.optionsRef, args: [] as string[], environment: { LANG: "C" },
    physical: {
      cwd: { dev: String(statSync(cwd, { bigint: true }).dev), ino: String(statSync(cwd, { bigint: true }).ino) },
      storage: { dev: String(statSync(storagePath, { bigint: true }).dev), ino: String(statSync(storagePath, { bigint: true }).ino) },
    } };
  const preflight = { runtime: structuredClone(runtime), storageSha256: privateRow.storageSha256,
    optionsSha256: hash(JSON.stringify({ args: privateRow.args, environment: privateRow.environment })),
    physical: structuredClone(privateRow.physical) };
  const release = { channel: "lab", installedSourceVersion: CURSOR_SOURCE_VERSION,
    version: "2026.10.01-e373342", evidenceRef: "private:test-release" };
  const config: CursorConfiguration = {
    probeCwd: `/${cwd.slice(1)}`,
    installation: canonical => canonical === executable ? installation : null,
    release: () => release, privateRuntime: () => privateRow, preflight: () => preflight,
    decodeMetadata: value => { const decoded: unknown = JSON.parse(value); return decoded; },
    now: () => 100,
  };
  const adapter = createCursorAdapter(config);
  async function detected() { return success(await adapter.detect(executable)); }
  function refreshDb() {
    const digest = hash(readFileSync(storagePath));
    privateRow.storageSha256 = digest;
    preflight.storageSha256 = digest;
  }
  return { root, executable, installation, runtime, privateRow, preflight, release, config,
    adapter, storagePath, detected, refreshDb };
}

describe("Cursor source-bounded adapter", () => {
  test("release-and-version: canonical detect, bounded child version and channel check", async () => {
    const f = fixture(), installation = await f.detected();
    expect(success(await f.adapter.version(installation))).toEqual({ kind: "known", version: CURSOR_SOURCE_VERSION });
    expect(success(await f.adapter.check(installation))).toEqual({ kind: "update-available",
      installedVersion: CURSOR_SOURCE_VERSION, availableVersion: "2026.10.01-e373342", checkedAt: 100 });
    f.release.version = CURSOR_SOURCE_VERSION;
    expect(success(await f.adapter.check(installation)).kind).toBe("up-to-date");
    f.release.version = "2025.01.01-123abcd";
    expect(await f.adapter.check(installation)).toEqual({ ok: false, error: { code: "verification_failed" } });
  });
  test("owner-channel-wrapper: canonical alias works, Grok and desktop aliases reject", async () => {
    const f = fixture(), alias = join(f.root, "cursor-agent"), agent = join(f.root, "agent");
    symlinkSync(f.executable, alias);
    expect(success(await f.adapter.detect(alias)).executableRealpath).toBe(f.executable);
    const grok = join(f.root, "grok");
    copyFileSync(f.executable, grok);
    symlinkSync(grok, agent);
    expect(await f.adapter.detect(agent)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
    expect(await f.adapter.detect(grok)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
    expect(await f.adapter.detect(join(f.root, "missing"))).toEqual({ ok: false, error: { code: "not_found" } });
  });
  test("native ownership and channel require an authoritative receipt", async () => {
    const f = fixture();
    const unknown = { ...f.installation, owner: { kind: "unknown", reason: "unverified_owner" } as const };
    const a = createCursorAdapter({ ...f.config, installation: () => unknown });
    expect(await a.detect(f.executable)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
    const bad = createCursorAdapter({ ...f.config, installation: () => ({ ...f.installation, channel: "latest" }) });
    expect(await bad.detect(f.executable)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
  });
  test("parser-accepted-flags: exact ID is one equal-form argv and options stay private", async () => {
    const f = fixture();
    await f.detected();
    const names = readdirSync(dirname(f.storagePath)), before = readFileSync(f.storagePath);
    const spec = success(f.adapter.exactResume(f.runtime));
    expect(spec.command.args).toEqual([`--resume=${f.runtime.binding.session.fullId}`]);
    expect(String(spec.command.executable)).toBe(f.executable);
    expect(String(spec.command.cwd)).toBe(f.runtime.binding.cwd);
    expect(spec.expectedBinding).toEqual(f.runtime.binding);
    expect(spec.optionsRef).toBe(f.runtime.binding.optionsRef);
    expect(readFileSync(f.storagePath)).toEqual(before);
    expect(readdirSync(dirname(f.storagePath))).toEqual(names);
  });
  for (const flag of ["--continue", "--resume", "--resume=-1", "--force", "--cloud", "--workspace=/tmp", "--print", "prompt"]) {
    test(`unsafe private option ${flag} is rejected before constructing resume`, async () => {
      const f = fixture();
      await f.detected();
      f.privateRow.args.push(flag);
      f.preflight.optionsSha256 = hash(JSON.stringify({ args: f.privateRow.args, environment: f.privateRow.environment }));
      expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "malformed_request" } });
    });
  }
  test("update-writes-and-rollback: no floating update or bare PATH spec is returned", async () => {
    const f = fixture(), installation = await f.detected();
    for (const mode of ["update-only", "update-and-restart"] as const)
      expect(f.adapter.updateSpec(installation, mode)).toEqual({ ok: false, error: { code: "receipt_uncertain" } });
    const staticInstallation = { ...f.installation, channel: "static" };
    const a = createCursorAdapter({ ...f.config, installation: () => staticInstallation });
    const detected = success(await a.detect(f.executable));
    expect(a.updateSpec(detected, "update-only")).toEqual({ ok: false, error: { code: "unsupported" } });
    expect(await a.check(detected)).toEqual({ ok: false, error: { code: "receipt_uncertain" } });
    expect(readdirSync(f.root).sort()).toEqual(["chats", "versions", "workspace"]);
  });
  test("exact-resume-identity: missing DB never creates a DB or a fresh session", async () => {
    const f = fixture();
    await f.detected();
    rmSync(dirname(f.storagePath), { recursive: true });
    const parent = dirname(dirname(f.storagePath)), before = readdirSync(parent);
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "missing_session" } });
    expect(existsSync(f.storagePath)).toBe(false);
    expect(readdirSync(parent)).toEqual(before);
  });
  test("missing saved root is rejected with a real SQLite read", async () => {
    const f = fixture();
    await f.detected();
    const db = new Database(f.storagePath);
    db.exec("DELETE FROM blobs");
    db.close();
    f.refreshDb();
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "missing_session" } });
  });
  test("unqualified metadata decoding cannot authorize a session", async () => {
    const f = fixture(), a = createCursorAdapter({ ...f.config, decodeMetadata: () => null });
    success(await a.detect(f.executable));
    expect(a.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "receipt_uncertain" } });
  });
  test("independent options and full identity observations must agree", async () => {
    const f = fixture();
    await f.detected();
    f.preflight.optionsSha256 = hash("forged");
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
    f.preflight.optionsSha256 = hash(JSON.stringify({ args: f.privateRow.args, environment: f.privateRow.environment }));
    f.privateRow.optionsRef = "options:other";
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
    f.privateRow.optionsRef = f.runtime.binding.optionsRef;
    f.privateRow.fullId = "12345678";
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
  });
  test("private environment and running source version cannot drift", async () => {
    const f = fixture();
    await f.detected();
    f.privateRow.environment.LANG = "ko_KR";
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
    const runtime = { ...f.runtime, runningVersion: { kind: "known", version: "2026.10.01-e373342" } as const };
    f.preflight.runtime = runtime;
    expect(f.adapter.exactResume(runtime)).toEqual({ ok: false, error: { code: "receipt_uncertain" } });
  });
  test("hash-path lookup is not guessed and cwd must remain the captured workspace", async () => {
    const f = fixture();
    await f.detected();
    const forged = { ...f.runtime, binding: { ...f.runtime.binding,
      session: { ...f.runtime.binding.session, storagePathHash: hash("/wrong") } } };
    f.preflight.runtime = structuredClone(forged);
    expect(f.adapter.exactResume(forged)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
    f.preflight.runtime = structuredClone(f.runtime);
    rmSync(f.runtime.binding.cwd, { recursive: true });
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "missing_session" } });
  });
  test("drain-ipc-hooks: forged display idle never supplies completion or stop proof", async () => {
    const f = fixture(), a = createCursorAdapter({ ...f.config, preflight: () => ({ ...f.preflight, idle: true, drained: true }) });
    success(await a.detect(f.executable));
    expect(a.bridge(f.runtime)).toEqual({ ok: false, error: { code: "receipt_uncertain" } });
    expect(a.gracefulExit(f.runtime, "operation", "owner")).toEqual({ ok: false, error: { code: "receipt_uncertain" } });
  });
  test("stale: changed turn, root identity or resources do not match preflight", async () => {
    const f = fixture();
    await f.detected();
    for (const binding of [
      { ...f.runtime.binding, turnGeneration: 2 },
      { ...f.runtime.binding, rootIncarnation: { ...f.runtime.binding.rootIncarnation, startIdentity: "replacement" } },
      { ...f.runtime.binding, resourcesFingerprint: "sha256:forged" },
    ]) expect(f.adapter.exactResume({ ...f.runtime, binding })).toEqual({ ok: false, error: { code: "stale_binding" } });
    const stale = { ...f.installation, channel: "prod" };
    expect(f.adapter.updateSpec(stale, "update-only")).toEqual({ ok: false, error: { code: "stale_selection" } });
  });
  test("dirty: tracked bytes and untracked runtime files fail resource verification", async () => {
    const f = fixture(), installation = await f.detected();
    const extra = join(dirname(f.executable), "unexpected.js");
    copyFileSync(f.executable, extra);
    expect(f.adapter.updateSpec(installation, "update-only")).toEqual({ ok: false, error: { code: "external_writer" } });
    unlinkSync(extra);
    copyFileSync(f.storagePath, f.executable);
    chmodSync(f.executable, 0o700);
    expect(f.adapter.updateSpec(installation, "update-only")).toEqual({ ok: false, error: { code: "external_writer" } });
  });
  test("dirty DB and pending WAL fail closed, no sidecar created by preflight", async () => {
    const f = fixture();
    await f.detected();
    const sidecar = `${f.storagePath}-wal`;
    copyFileSync(f.storagePath, sidecar);
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "external_writer" } });
    unlinkSync(sidecar);
    const db = new Database(f.storagePath);
    db.query("UPDATE meta SET value = ? WHERE key = '0'").run(JSON.stringify({ fullId: "other", rootBlobId: "aabb" }));
    db.close();
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "stale_binding" } });
    f.refreshDb();
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "identity_mismatch" } });
  });
  test("misleading: source compatibility cannot be inferred from a latest release receipt", async () => {
    const f = fixture(), installation = await f.detected();
    f.release.installedSourceVersion = "2026.10.01-e373342";
    expect(await f.adapter.check(installation)).toEqual({ ok: false, error: { code: "receipt_uncertain" } });
    f.release.installedSourceVersion = CURSOR_SOURCE_VERSION;
    f.release.channel = "prod";
    expect(await f.adapter.check(installation)).toEqual({ ok: false, error: { code: "receipt_uncertain" } });
  });
});
