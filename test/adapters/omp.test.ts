import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOmpAdapter } from "../../src/adapters/omp";
import type { OmpConfiguration, OmpCoreEvidence, OmpPrivateRuntime } from "../../src/adapters/omp";
import type { RuntimeIdentity } from "../../src/adapters/types";
import type { FailureCode } from "../../src/protocol";
import { ompSourceR2, verifyOmpSourceReceipt } from "../../.omo/evidence/herdr-cli-updater/task-10/source-r2";

const sourceRoot = ompSourceR2.root;
const evidenceRoot = resolve(import.meta.dir, "../../.omo/evidence/herdr-cli-updater/task-10");
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const roots: string[] = [];
function absolute(path: string): path is `/${string}` { return path.startsWith("/"); }
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
async function fixture(options: { readonly channel?: string; readonly owner?: string; readonly output?: string; readonly exit?: number } = {}) {
  verifyOmpSourceReceipt();
  const root = await realpath(await mkdtemp(join(tmpdir(), "task10-omp-")));
  if (!absolute(root)) throw new TypeError("fixture root must be absolute");
  roots.push(root);
  const executable = join(root, "program");
  const observed = join(root, "observed.jsonl");
  await writeFile(executable, `#!${process.execPath}
import {appendFileSync} from "node:fs";
appendFileSync(${JSON.stringify(observed)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})+"\\n");
if(process.argv.length!==3||process.argv[2]!=="--version") process.exit(91);
console.log(${JSON.stringify(options.output ?? "omp/17.1.8")});process.exit(${options.exit ?? 0});
`);
  await chmod(executable, 0o700);
  const manifest = join(root, "package.json");
  await writeFile(manifest, JSON.stringify({ name: options.owner ?? "@oh-my-pi/pi-coding-agent", version: "17.1.8", bin: { omp: "program" } }));
  const receipt = join(root, "owner.json");
  const owner = { kind: "package", manager: "bun", packageName: options.owner ?? "@oh-my-pi/pi-coding-agent", prefix: root };
  const body = JSON.stringify({
    family: "omp", executable, channel: options.channel ?? "stable", owner, packageManifest: manifest,
    resources: [
      { path: executable, sha256: hash(await readFile(executable)) },
      { path: manifest, sha256: hash(await readFile(manifest)) },
    ],
  });
  await writeFile(receipt, body);
  const runtimePath = join(root, "private.json");
  const corePath = join(root, "core.json");
  const config: OmpConfiguration = {
    sourceRoot, probeCwd: root,
    provenance: () => [{ path: receipt, sha256: hash(body) }],
    // Real isolated private-store reads, not mocked protocol/discovery success.
    readRuntime: () => JSON.parse(readFileSync(runtimePath, "utf8")),
    readCoreEvidence: () => JSON.parse(readFileSync(corePath, "utf8")),
  };
  const adapter = createOmpAdapter(config);
  const detection = await adapter.detect(executable);
  if (!detection.ok) return { root, executable, manifest, receipt, observed, detection, adapter, config, runtimePath, corePath };
  const installation = detection.value;
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const sessionPath = join(root, "saved session ; literal.jsonl");
  const sessionId = "019a1234-1234-7123-8123-123456789abc";
  const runtime: RuntimeIdentity = {
    runtimeId: "runtime:omp", installationId: installation.installationId, runningVersion: { kind: "known", version: "17.1.8" },
    binding: {
      socketId: "socket:1", socketEpoch: "epoch:1", paneId: "pane:1", paneGeneration: 2,
      rootIncarnation: { pid: 100, startIdentity: "start:1", executableRealpath: executable },
      session: { kind: "conversation", fullId: sessionId, storagePathHash: `sha256:${hash(sessionPath)}` },
      cwd, optionsRef: "options:1", turnGeneration: 3, resourcesFingerprint: installation.resourcesFingerprint,
    },
  };
  const record: OmpPrivateRuntime = {
    runtime, installation, sessionPath, sessionId, options: ["--model", "fixture-model", "--provider=fixture", "--no-lsp", "--mode", "rpc"],
  };
  await writeFile(sessionPath, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd, timestamp: "2026-10-02T00:00:00.000Z" }) + "\n");
  await writeFile(runtimePath, JSON.stringify(record));
  await writeFile(corePath, "null");
  return { root, executable, manifest, receipt, observed, detection, adapter, config, runtimePath, corePath, record, runtime, installation };
}
async function ready(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  if (!f.detection.ok || !f.record || !f.runtime || !f.installation) throw new TypeError("fixture detection failed");
  return { ...f, record: f.record, runtime: f.runtime, installation: f.installation };
}
const denied = (code: FailureCode) => ({ ok: false, error: { code } } as const);

test("discovers alias resources as one owner without running updates", async () => {
  // Given: two filesystem names share a qualified owner.
  const f = await ready();
  const alias = join(f.root, "alias-pi");
  await symlink(f.executable, alias);
  // When: canonical discovery reads the alias.
  const result = await f.adapter.detect(alias);
  // Then: shared mutation resources/identity remain identical, with no execution.
  expect(result).toEqual(f.detection);
  await expect(lstat(f.observed)).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["canary", "unknown"])("blocks unqualified %s channels", async channel => {
  // Given / When: official parser supports only qualified stable latest.
  const f = await fixture({ channel });
  // Then: no mutation or probe based on an invented canary selector.
  expect(f.detection.ok).toBe(false);
  await expect(lstat(f.observed)).rejects.toMatchObject({ code: "ENOENT" });
});
test("rejects another family package without invoking it", async () => {
  // Given / When: a pi/omo alias cannot qualify its package as OMP.
  const f = await fixture({ owner: "@code-yeongyu/senpi" });
  // Then: family owner validation blocks the borrowed updater.
  expect(f.detection).toEqual(denied("unsupported"));
});
test("checks official available version through bounded version observation", async () => {
  // Given: isolated fixture owner and pinned official stable metadata.
  const f = await ready();
  // When: real adapter probes only --version.
  const result = await f.adapter.check(f.installation);
  // Then: machine versions, not updater success prose, drive the check.
  expect(result).toMatchObject({ ok: true, value: { kind: "update-available", installedVersion: "17.1.8", availableVersion: "18.4.12" } });
  expect(JSON.parse((await readFile(f.observed, "utf8")).trim())).toEqual({ argv: ["--version"], cwd: f.root });
});
test.each([
  { output: "Update successful" }, { output: "omp/17.1.8\nsuccess" },
  { output: "omp/99.0.0" }, { output: "omp/17.1.8", exit: 7 },
])("rejects misleading or unsuccessful version output %#", async options => {
  // Given: stdout or exit cannot independently attest installed identity.
  const f = await ready(options);
  // When / Then: actual bounded process observation fails closed.
  expect(await f.adapter.version(f.installation)).toEqual(denied("verification_failed"));
});
test.each(["owner", "channel", "version", "fingerprint"] as const)("rejects stale %s selection before probing", async field => {
  // Given: caller changes a selected installation snapshot.
  const f = await ready();
  const installation = {
    ...f.installation,
    ...(field === "owner" ? { owner: { kind: "package", manager: "npm", packageName: "@oh-my-pi/pi-coding-agent", prefix: f.root } as const } : {}),
    ...(field === "channel" ? { channel: "canary" } : {}),
    ...(field === "version" ? { installedVersion: { kind: "known", version: "18.4.12" } as const } : {}),
    ...(field === "fingerprint" ? { resourcesFingerprint: "sha256:changed" } : {}),
  };
  // When / Then: no spec/probe for changed owner/channel/resources.
  expect((await f.adapter.version(installation)).ok).toBe(false);
  await expect(lstat(f.observed)).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["executable", "manifest", "receipt"] as const)("blocks fresh %s byte drift before resume", async file => {
  // Given: an outside writer changes a recorded resource.
  const f = await ready();
  await writeFile(f[file], "changed");
  // When / Then: existing identity is insufficient for fresh construction.
  expect(f.adapter.exactResume(f.runtime)).toEqual(denied("stale_selection"));
});
test("returns shell-free exact argv and preserves private options and cwd", async () => {
  // Given: a full existing session and private options with an opaque public ref.
  const f = await ready();
  const parserPath = join(evidenceRoot, "source/cli/flag-tables.ts");
  const flags = await import(parserPath);
  // When: actual adapter builds a resume spec, without launching it.
  const result = f.adapter.exactResume(f.runtime);
  if (!result.ok) throw new TypeError(result.error.code);
  // Then: original shipped resume setter observes one absolute path, no picker.
  const parsed: { resume?: string } = {};
  const selector = result.value.command.args.at(-1);
  expect(selector).toBe(`--resume=${f.record.sessionPath}`);
  flags.OPTIONAL_FLAGS["--resume"].set(parsed, selector?.slice("--resume=".length));
  expect(parsed.resume).toBe(f.record.sessionPath);
  const expectedExecutable = f.executable;
  const expectedCwd = f.record.runtime.binding.cwd;
  if (!absolute(expectedExecutable) || !absolute(expectedCwd)) throw new TypeError("fixture paths must be absolute");
  expect(result.value.command).toEqual({ executable: expectedExecutable, cwd: expectedCwd,
    args: [...f.record.options, `--resume=${f.record.sessionPath}`] });
  expect(result.value.expectedBinding).toEqual(f.runtime.binding);
  expect(JSON.stringify(result.value.expectedBinding)).not.toContain(f.record.sessionPath);
  expect(result.value.optionsRef).toBe("options:1");
  await expect(lstat(f.observed)).rejects.toMatchObject({ code: "ENOENT" });
});
test("supports real shipped title-slot serialization before the header", async () => {
  // Given: the original title-slot serializer writes a 256-byte prefix.
  const f = await ready();
  const title = await import(join(evidenceRoot, "source/session/session-title-slot.ts"));
  const header = await readFile(f.record.sessionPath, "utf8");
  await writeFile(f.record.sessionPath, title.serializeTitleSlot({ title: "fixture", updatedAt: "2026-10-02T00:00:00Z" }) + header);
  // When / Then: preflight finds the real header after the title, not a new session.
  expect(f.adapter.exactResume(f.runtime).ok).toBe(true);
});
test("blocks missing session instead of creating a fresh conversation", async () => {
  // Given: the exact path was deleted after recording identity.
  const f = await ready();
  await rm(f.record.sessionPath);
  // When / Then: no launch spec and the path remains absent.
  expect(f.adapter.exactResume(f.runtime)).toEqual(denied("missing_session"));
  await expect(lstat(f.record.sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["{}", "", "not-json", '{"type":"title"}', '{"type":"session","version":3,"id":"partial","cwd":"/wrong"}'])(
  "blocks malformed or wrong session headers %#", async content => {
    // Given: loader would accept no entries or another identity.
    const f = await ready();
    await writeFile(f.record.sessionPath, content);
    // When / Then: never adopt a replacement identity.
    expect(f.adapter.exactResume(f.runtime).ok).toBe(false);
  },
);
test.each(["socketEpoch", "paneGeneration", "turnGeneration", "cwd", "optionsRef", "rootIncarnation", "session"] as const)(
  "rejects stale binding field %s", async field => {
    // Given: private authority retains the old complete binding.
    const f = await ready();
    const binding = { ...f.runtime.binding,
      ...(field === "socketEpoch" ? { socketEpoch: "epoch:other" } : {}),
      ...(field === "paneGeneration" ? { paneGeneration: 22 } : {}),
      ...(field === "turnGeneration" ? { turnGeneration: 23 } : {}),
      ...(field === "cwd" ? { cwd: f.root } : {}),
      ...(field === "optionsRef" ? { optionsRef: "options:other" } : {}),
      ...(field === "rootIncarnation" ? { rootIncarnation: { ...f.runtime.binding.rootIncarnation, startIdentity: "reused:pid" } } : {}),
      ...(field === "session" ? { session: { ...f.runtime.binding.session, storagePathHash: "sha256:wrong" } } : {}),
    };
    // When / Then: all generation/incarnation fields participate in comparison.
    expect(f.adapter.exactResume({ ...f.runtime, binding })).toEqual(denied("stale_binding"));
  },
);
test.each([
  ["--resume"], ["--resume=/tmp/other"], ["--continue"], ["--fork", "partial"], ["--no-session"],
  ["prompt"], ["--"], ["--api-key", "PRIVATE_SENTINEL"], ["--model"], ["--model", "--continue"],
  ["--config", "/private/config"], ["--max-time", "20"], ["--thinking", "invalid"], ["--mode", "invalid"],
].map(options => ({ options })))("blocks unsafe selector/options without private error leakage %#", async ({ options }) => {
  // Given: private values are not arbitrary safe startup argv.
  const f = await ready();
  await writeFile(f.runtimePath, JSON.stringify({ ...f.record, options }));
  // When / Then: typed code contains no private argv/path.
  expect(f.adapter.exactResume(f.runtime)).toEqual(denied("unsupported"));
});
test.each(["sessionId", "pathHash", "cwd"] as const)("validates authoritative stored %s against the real header", async field => {
  // Given: a private record or matching binding is internally inconsistent.
  const f = await ready();
  const runtime = field === "pathHash"
    ? { ...f.runtime, binding: { ...f.runtime.binding, session: { ...f.runtime.binding.session, storagePathHash: "sha256:wrong" } } }
    : field === "cwd" ? { ...f.runtime, binding: { ...f.runtime.binding, cwd: f.root } } : f.runtime;
  await writeFile(f.runtimePath, JSON.stringify({ ...f.record, runtime,
    ...(field === "sessionId" ? { sessionId: "019a1234-1234-7123-8123-123456789def" } : {}) }));
  // When / Then: full expected equality alone cannot confer valid storage identity.
  expect(f.adapter.exactResume(runtime)).toEqual(denied("identity_mismatch"));
});
test("does not construct PATH-dependent mutation even after qualified discovery", async () => {
  // Given: source confirms update --check differs from mutation but target uses PATH.
  const f = await ready();
  // When / Then: frozen spec cannot express pinned environment/write set.
  expect(f.adapter.updateSpec(f.installation, "update-only")).toEqual(denied("unsupported"));
  await expect(lstat(f.observed)).rejects.toMatchObject({ code: "ENOENT" });
});
test("does not accept absent core evidence or display idle", async () => {
  // Given: no authoritative completion event.
  const f = await ready();
  await writeFile(f.corePath, JSON.stringify({ display: "idle" }));
  // When / Then: display observation cannot enable a core bridge.
  expect(f.adapter.bridge(f.runtime).ok).toBe(false);
  expect(f.adapter.gracefulExit(f.runtime, "op:1", "owner:1").ok).toBe(false);
});
function attestation(runtime: RuntimeIdentity): OmpCoreEvidence {
  return { expectedBinding: runtime.binding, evidenceRef: "core:evidence", workGeneration: 3, admission: "claimed",
    pending: { root: 0, tools: 0, subagents: 0, background: 0, monitors: 0, continuations: 0, deliveries: 0 },
    operationId: "op:1", ownerTokenRef: "owner:1" };
}
test.each(["root", "tools", "subagents", "background", "monitors", "continuations", "deliveries"] as const)(
  "rejects pending %s despite other drained counters", async kind => {
    // Given: isolated core store has genuine pending work in one class.
    const f = await ready();
    const evidence = attestation(f.runtime);
    await writeFile(f.corePath, JSON.stringify({ ...evidence, pending: { ...evidence.pending, [kind]: 1 } }));
    // When / Then: no completion/stop spec.
    expect(f.adapter.bridge(f.runtime)).toEqual(denied("resources_busy"));
    expect(f.adapter.gracefulExit(f.runtime, "op:1", "owner:1")).toEqual(denied("resources_busy"));
  },
);
test("constructs core specs only from exact authoritative claim data", async () => {
  // Given: deterministic private core record, not a runtime proof.
  const f = await ready();
  await writeFile(f.corePath, JSON.stringify(attestation(f.runtime)));
  // When / Then: operation/token ownership and work generation are preserved.
  expect(f.adapter.bridge(f.runtime)).toEqual({ ok: true, value: {
    kind: "core-attestation", expectedBinding: f.runtime.binding, evidenceRef: "core:evidence", workGeneration: 3,
  } });
  expect(f.adapter.gracefulExit(f.runtime, "op:other", "owner:1")).toEqual(denied("unauthorized"));
  expect(f.adapter.gracefulExit(f.runtime, "op:1", "owner:1")).toEqual({ ok: true, value: {
    kind: "core-stop", expectedBinding: f.runtime.binding, operationId: "op:1", ownerTokenRef: "owner:1",
  } });
});
test("rejects dirty official source instead of trusting qualification flags", async () => {
  // Given: independently acquired source fixture is corrupted.
  const f = await ready();
  const { copy, target } = await isolatedSourceCopy(f.root, sourceRoot);
  await writeFile(target, "dirty");
  // When / Then: source byte pins fail even though metadata still claims acquired.
  const adapter = createOmpAdapter({ ...f.config, sourceRoot: copy });
  expect(await adapter.detect(f.executable)).toEqual(denied("verification_failed"));
});

async function isolatedSourceCopy(root: string, source: string) {
  const copy = join(root, "source");
  const canonical = await realpath(source);
  await cp(canonical, copy, { recursive: true, dereference: true });
  const original = await realpath(join(canonical, "boundedsource/src/cli/args.ts"));
  const target = await realpath(join(copy, "boundedsource/src/cli/args.ts"));
  const [sourceInfo, copyInfo] = await Promise.all([lstat(original), lstat(target)]);
  if (!target.startsWith(`${await realpath(root)}/source/`) || target === original
    || (sourceInfo.dev === copyInfo.dev && sourceInfo.ino === copyInfo.ino))
    throw new TypeError("source fixture must be physically independent");
  return { copy, target };
}

test("keeps authenticated source unchanged when the fixture input root is an alias", async () => {
  // Given: the same root symlink shape that made default cp preserve authority.
  const f = await ready();
  const alias = join(f.root, "source-alias");
  await symlink(sourceRoot, alias);
  const original = join(sourceRoot, "boundedsource/src/cli/args.ts");
  const before = await readFile(original);
  const originalInfo = await lstat(original);
  // When: canonical copy is mutated, not the preserved symlink target.
  const { target } = await isolatedSourceCopy(f.root, alias);
  await writeFile(target, "dirty");
  // Then: real inode/content remain pinned, original discovery still succeeds.
  const copyInfo = await lstat(target);
  expect(copyInfo.dev === originalInfo.dev && copyInfo.ino === originalInfo.ino).toBe(false);
  expect(await readFile(original)).toEqual(before);
  expect(hash(await readFile(original))).toBe("14b7041ad9054e34f97b539ca7e4a7eda8bd7660e637d726d1d1a8b599fa4014");
  expect(await f.adapter.detect(f.executable)).toEqual(f.detection);
});

const thrownKinds = ["error", "string", "number", "null", "undefined", "symbol", "plain-object",
  "revoked-proxy", "error-proxy", "coercion-object", "function-proxy"] as const;
const readerKinds = ["provenance", "readRuntime", "readCoreEvidence"] as const;
test.each(thrownKinds.flatMap(kind => readerKinds.map(reader => ({ kind, reader }))))(
  "returns enum-only failure without inspecting $kind from $reader", async ({ kind, reader }) => {
    // Given: real pinned discovery/private files, then a foreign callback throw.
    const f = await ready();
    let inspections = 0;
    const inspect = (): never => { inspections++; throw "PRIVATE_SENTINEL"; };
    let thrown: unknown;
    switch (kind) {
      case "error": thrown = new Error("PRIVATE_SENTINEL"); break;
      case "string": thrown = "PRIVATE_SENTINEL"; break;
      case "number": thrown = 42; break;
      case "null": thrown = null; break;
      case "undefined": thrown = undefined; break;
      case "symbol": thrown = Symbol("PRIVATE_SENTINEL"); break;
      case "plain-object": thrown = { private: "PRIVATE_SENTINEL" }; break;
      case "revoked-proxy": {
        const proxy = Proxy.revocable({}, {});
        proxy.revoke();
        thrown = proxy.proxy;
        break;
      }
      case "error-proxy": thrown = new Proxy(new Error("PRIVATE_SENTINEL"), {
        get: inspect, getPrototypeOf: inspect, has: inspect, ownKeys: inspect,
      }); break;
      case "coercion-object": thrown = {
        [Symbol.toPrimitive]: inspect, toString: inspect, valueOf: inspect,
        get code() { return inspect(); }, get message() { return inspect(); },
      }; break;
      case "function-proxy": thrown = new Proxy(() => undefined, {
        get: inspect, getPrototypeOf: inspect, has: inspect, ownKeys: inspect,
      }); break;
      default: throw new TypeError("unknown regression case");
    }
    let armed = false;
    const adapter = createOmpAdapter({
      ...f.config,
      provenance: executable => {
        if (armed && reader === "provenance") throw thrown;
        return f.config.provenance(executable);
      },
      readRuntime: runtimeId => {
        if (armed && reader === "readRuntime") throw thrown;
        return f.config.readRuntime(runtimeId);
      },
      readCoreEvidence: runtimeId => {
        if (armed && reader === "readCoreEvidence") throw thrown;
        return f.config.readCoreEvidence?.(runtimeId) ?? null;
      },
    });
    expect(await adapter.detect(f.executable)).toEqual(f.detection);
    armed = true;
    // When / Then: affected actual adapter entrypoints return only the enum code.
    if (reader === "provenance") {
      expect(await adapter.detect(f.executable)).toEqual(denied("verification_failed"));
      expect(await adapter.version(f.installation)).toEqual(denied("verification_failed"));
      expect(await adapter.check(f.installation)).toEqual(denied("verification_failed"));
      expect(adapter.updateSpec(f.installation, "update-only")).toEqual(denied("verification_failed"));
    }
    if (reader !== "readCoreEvidence")
      expect(adapter.exactResume(f.runtime)).toEqual(denied("verification_failed"));
    expect(adapter.bridge(f.runtime)).toEqual(denied("verification_failed"));
    expect(adapter.gracefulExit(f.runtime, "op:1", "owner:1")).toEqual(denied("verification_failed"));
    expect(inspections).toBe(0);
  },
);
