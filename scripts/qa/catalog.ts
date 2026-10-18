import { watch } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readCatalog } from "../../src/catalog";
import { parseCompletion } from "../../src/core/completion";
import { attachAuthenticatedWorker } from "../../src/service/client";
import { createAutomaticCatalogProvider } from "../../src/service/catalog-provider";
import { createCatalogSourceOwner } from "../../src/service/catalog-sources";
import { serveDomainWorker } from "../../src/service/worker";
import { fileDigest, QaError, RunFailure, withIsolation } from "./runner";
import type { CleanupReceipt, ExecutionReceipt } from "./runner";
import { homedir } from "node:os";

const project = resolve(import.meta.dir, "../..");
const evidenceRoot = join(project, ".omo/evidence/herdr-cli-updater/task-1");
const fixtures = join(project, "test/fixtures/catalog");
const dependencies = [
  "src/catalog.ts", "src/protocol.ts", "src/core/completion.ts", "src/core/client.ts",
  "src/service/catalog-sources.ts", "src/service/catalog-provider.ts", "src/service/domain.ts",
  "src/service/worker.ts", "src/service/client.ts", "src/service/socket.ts",
  "src/discovery.ts", "src/adapters/types.ts", "scripts/qa/runner.ts", "scripts/qa/registry.ts",
] as const;

function requireThat(value: boolean, code: string): asserts value {
  if (!value) throw new QaError(code, code);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pinned(value: unknown): value is { readonly path: string; readonly sha256: string } {
  return object(value) && typeof value["path"] === "string" && typeof value["sha256"] === "string"
    && /^[a-f0-9]{64}$/.test(value["sha256"]);
}
export function parseCatalogArgs(args: readonly string[]) {
  requireThat(args.length === 6 && args[0] === "--scenario" && args[1] === "catalog"
    && args[2] === "--fixtures" && typeof args[3] === "string" && resolve(args[3]) === fixtures
    && args[4] === "--evidence-dir" && typeof args[5] === "string" && args[5].length > 0, "invalid-command");
  const destination = args[5] === "E/catalog" ? join(evidenceRoot, "catalog-r1") : resolve(args[5]);
  const suffix = relative(evidenceRoot, destination);
  requireThat(suffix !== "" && !suffix.startsWith("..") && !isAbsolute(suffix), "evidence-path");
  return { fixtures, evidenceDir: destination };
}
function bounded<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new QaError("deadline", "catalog signal deadline")), milliseconds);
    promise.then(value => { clearTimeout(timer); resolvePromise(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

/** Only task-owned paths are admitted by the caller. Read-only core methods plus
 * disposable workspace creation and server shutdown; never native enrollment. */
export async function catalogExchange(path: string, method: string, params: unknown): Promise<unknown> {
  requireThat(["ping", "agent.list", "workspace.create", "updater.completion.v1", "server.stop"].includes(method),
    "unregistered-method");
  const info = await lstat(path);
  requireThat(info.isSocket() && !info.isSymbolicLink() && info.uid === process.getuid?.()
    && (info.mode & 0o777) === 0o600, "unsafe-core-socket");
  return new Promise((resolvePromise, reject) => {
    const id = crypto.randomUUID(), socket = createConnection({ path });
    let buffer = "", settled = false;
    const finish = (error: unknown, result?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolvePromise(result);
    };
    const timer = setTimeout(() => finish(new QaError("deadline", "catalog RPC deadline")), 5000);
    socket.setEncoding("utf8");
    socket.on("error", error => finish(error));
    socket.on("close", () => finish(new QaError("response-missing", "core closed before response")));
    socket.on("data", bytes => {
      buffer += bytes;
      if (Buffer.byteLength(buffer) > 262144) { finish(new QaError("response-overflow", "core response too large")); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const response: unknown = JSON.parse(buffer.slice(0, end));
        requireThat(object(response) && response["id"] === id, "response-identity");
        finish(null, response);
      } catch (error) { finish(error); }
    });
    // Listeners and deadline exist before the request is written.
    socket.once("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
  });
}
function result(response: unknown): Record<string, unknown> {
  requireThat(object(response) && object(response["result"]), "core-result");
  return response["result"];
}
function socketArrival(path: string) {
  const signal = Promise.withResolvers<void>();
  const watcher = watch(resolve(path, ".."), (_event, name) => {
    if (name?.toString() !== basename(path)) return;
    void lstat(path).then(info => { if (info.isSocket()) signal.resolve(); }, signal.reject);
  });
  watcher.on("error", signal.reject);
  const ready = bounded(signal.promise);
  // A spawn failure can retire the watcher before the caller awaits readiness.
  void ready.catch(() => undefined);
  return { ready, close: () => watcher.close() };
}
async function hashes() {
  return Object.fromEntries(await Promise.all(dependencies.map(async path => [path, await fileDigest(join(project, path))])));
}
export function catalogExitCode(status: "PASS" | "BLOCKED" | "FAIL"): number {
  switch (status) { case "PASS": return 0; case "BLOCKED": return 3; case "FAIL": return 1; }
}

export async function runCatalog(evidenceDir: string) {
  const before = await hashes();
  const actions: { readonly action: string; readonly observed: unknown }[] = [];
  const blockers: { readonly owner: string; readonly field: string; readonly required: string; readonly observed: unknown }[] = [];
  let cleanup: CleanupReceipt | undefined;
  let executions: readonly ExecutionReceipt[] = [];
  let failureCode: string | null = null;
  const rootPids: number[] = [];
  const epochs: string[] = [];
  const sockets: string[] = [];
  const artifactHashes: Record<string, string> = {};
  // Accumulate only independently observed facts; unsupported fields stay false.
  const assertions = { separateRootsAndEpochs: false, sharedInstallationDiscovery: false,
    aliasDeduplicated: false, wrapperManagedEngineGrouped: false, busyCapabilityTruth: false,
    runtimeInstallationCorrelation: false, versionsAndCheckTime: false };
  try {
    const run = await withIsolation(async context => {
      const input: unknown = JSON.parse(await readFile(join(fixtures, "inputs.json"), "utf8"));
      requireThat(object(input) && object(input["core"]) && pinned(input["core"])
        && Array.isArray(input["archives"]) && input["archives"].length === 2, "invalid-fixtures");
      const core = input["core"], archives = input["archives"];
      requireThat("receipt" in core && typeof core.receipt === "string", "invalid-fixtures");
      const receiptPath = core.receipt;
      requireThat(core.path === `${homedir()}/Desktop/herdr-updater-toolchain/task20-core-r2-target/release/herdr`,
        "unregistered-core");
      const actualCoreHash = await fileDigest(core.path);
      artifactHashes[core.path] = actualCoreHash;
      const receipt: unknown = JSON.parse(await readFile(join(project, receiptPath), "utf8"));
      if (actualCoreHash !== core.sha256 || !object(receipt) || !object(receipt["release"])
        || receipt["release"]["path"] !== core.path || receipt["release"]["sha256"] !== actualCoreHash) {
        blockers.push({ owner: "task20 core build owner", field: "release.path/sha256",
          required: "Current successful private release and matching artifact observation", observed: { actualCoreHash, receipt } });
        return;
      }
      actions.push({ action: "private-core-provenance", observed: { path: core.path, sha256: actualCoreHash,
        receipt: receiptPath, receiptSha256: await fileDigest(join(project, receiptPath)) } });
      const version = await context.invoke([core.path, "--version"]);
      requireThat(version.exitCode === 0, "core-version");
      actions.push({ action: "actual-binary-version", observed: version });
      for (const archive of archives) {
        requireThat(pinned(archive) && "destination" in archive
          && (archive.destination === "omo" || archive.destination === "engine")
          && !isAbsolute(archive.path) && !relative(project, resolve(project, archive.path)).startsWith(".."),
        "invalid-fixtures");
        const path = join(project, archive.path), digest = await fileDigest(path);
        artifactHashes[path] = digest;
        if (digest !== archive.sha256) {
          blockers.push({ owner: "task5 artifact owner", field: archive.path,
            required: "Actual acquired OmO/Senpi archive digest", observed: digest });
          return;
        }
        const destination = join(context.paths.prefix, archive.destination);
        await mkdir(destination, { mode: 0o700 });
        const extracted = await context.invoke(["/usr/bin/tar", "-xzf", path, "--strip-components=1", "-C", destination]);
        requireThat(extracted.exitCode === 0, "archive-extraction");
        actions.push({ action: "genuine-archive-extracted", observed: { path, digest, destination, exitCode: extracted.exitCode } });
      }
      const wrapper = join(context.paths.prefix, "omo"), engine = join(context.paths.prefix, "engine");
      await mkdir(join(wrapper, "node_modules/@code-yeongyu"), { recursive: true, mode: 0o700 });
      await symlink(engine, join(wrapper, "node_modules/@code-yeongyu/senpi"));
      const bin = join(context.paths.prefix, "bin");
      await mkdir(bin, { mode: 0o700 });
      await symlink(join(wrapper, "bin/omo.js"), join(bin, "omo"));
      await symlink(join(wrapper, "bin/omo.js"), join(bin, "omo-alias"));
      const engineEntry = await Bun.file(join(engine, "dist/bundle/cli.js")).exists()
        ? join(engine, "dist/bundle/cli.js") : join(engine, "dist/cli.js");
      await symlink(engineEntry, join(bin, "senpi"));
      const cores: { readonly path: string; readonly child: Awaited<ReturnType<typeof context.spawn>> }[] = [];
      try {
        for (const name of ["a", "b"]) {
          const home = join(context.paths.home, name), config = join(context.paths.profile, name);
          await mkdir(home, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
          const configuration = join(config, "config.toml"), path = join(context.paths.sockets, `${name}.sock`);
          sockets.push(path);
          await writeFile(configuration, 'onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n[terminal]\ndefault_shell = "/bin/sh"\n',
            { mode: 0o600 });
          const arrival = socketArrival(path); // Exact filesystem subscription BEFORE process launch.
          try {
            const child = await context.spawn({ argv: ["/usr/bin/env", "-i", `HOME=${home}`,
              `XDG_CONFIG_HOME=${config}`, `XDG_DATA_HOME=${home}/data`, `XDG_STATE_HOME=${home}/state`,
              `XDG_CACHE_HOME=${home}/cache`, `XDG_RUNTIME_DIR=${context.paths.sockets}`, `TMPDIR=${context.paths.tmp}`,
              `HERDR_CONFIG_PATH=${configuration}`, `HERDR_SOCKET_PATH=${path}`, "PATH=/usr/bin:/bin",
              "SHELL=/bin/sh", "TERM=dumb", core.path, "server"] });
            cores.push({ path, child });
            await arrival.ready;
            actions.push({ action: "actual-core-ready", observed: { path } });
          } finally { arrival.close(); }
          const pong = await catalogExchange(path, "ping", {});
          actions.push({ action: "actual-core-ping", observed: { path, response: pong } });
          const created = await catalogExchange(path, "workspace.create", { cwd: context.paths.root, focus: false });
          actions.push({ action: "actual-workspace-create", observed: { path, method: "workspace.create",
            params: { cwd: context.paths.root, focus: false }, response: created } });
          const workspace = result(created);
          requireThat(object(workspace["root_pane"]) && typeof workspace["root_pane"]["pane_id"] === "string", "workspace-pane");
          const params = {
            family: "omo", pane_id: workspace["root_pane"]["pane_id"], expected_binding: null,
            generation: 0, sequence: 0, owner: null, operation: { action: "inspect" },
          };
          const rawCompletion = await catalogExchange(path, "updater.completion.v1", params);
          actions.push({ action: "actual-completion-inspect", observed: { path,
            method: "updater.completion.v1", params, response: rawCompletion } });
          const completion = result(rawCompletion);
          const physical = parseCompletion(completion["snapshot"], "omo");
          rootPids.push(physical.binding.root_pid);
          epochs.push(physical.binding.socket_epoch);
          actions.push({ action: "actual-core-root-observation", observed: { path, snapshot: physical,
            classification: "actual-shell-root-not-native-cli-binding" } });
        }
        const physical = actions.filter(entry => entry.action === "actual-core-root-observation").map(entry => entry.observed);
        requireThat(rootPids.length === 2 && rootPids[0] !== rootPids[1]
          && epochs.length === 2 && epochs[0] !== epochs[1], "distinct-roots-and-epochs");
        assertions.separateRootsAndEpochs = true;
        actions.push({ action: "dual-core-roots", observed: physical });
        const directory = join(context.paths.sockets, "worker");
        // Automatic source discovery uses the actual archive bytes and genuine core sockets.
        // Explicit source registration is deliberately absent.
        const configHome = join(context.paths.profile, "catalog");
        for (const path of sockets) {
          actions.push({ action: "private-core-socket", observed: { path, mode: (await lstat(path)).mode & 0o777 } });
        }
        const [firstSocket, secondSocket] = sockets;
        requireThat(firstSocket !== undefined && secondSocket !== undefined, "two-core-sockets");
        const source = createCatalogSourceOwner(directory, {
          home: context.paths.home, path: bin, prefixes: [context.paths.prefix], configHome, socket: firstSocket,
        });
        const second = createCatalogSourceOwner(join(context.paths.sockets, "second"), {
          home: context.paths.home, path: bin, prefixes: [context.paths.prefix], configHome, socket: secondSocket,
        });
        try {
          const sourceSnapshot = await source.refresh(context.signal);
          const secondSnapshot = await second.refresh(context.signal);
          assertions.sharedInstallationDiscovery = sourceSnapshot.candidates.length > 0
            && isDeepStrictEqual(sourceSnapshot.candidates, secondSnapshot.candidates);
          const omo = sourceSnapshot.candidates.find(row => row.family === "omo");
          const pi = sourceSnapshot.candidates.find(row => row.family === "pi");
          assertions.aliasDeduplicated = sourceSnapshot.candidates.filter(row => row.family === "omo").length === 1
            && omo?.aliases.some(row => row.path === join(bin, "omo-alias")) === true;
          assertions.wrapperManagedEngineGrouped = omo !== undefined && pi !== undefined
            && omo.installation.resources.some(resource => resource.realpath === pi.installation.executableRealpath);
          actions.push({ action: "actual-source-discovery", observed: { first: sourceSnapshot, second: secondSnapshot } });
          const provider = createAutomaticCatalogProvider(directory, source);
          const other = createAutomaticCatalogProvider(join(context.paths.sockets, "second"), second);
          const firstReaders = await provider(context.signal), secondReaders = await other(context.signal);
          const readers = { ...firstReaders, runtimeSources: [
            ...(firstReaders.runtimeSources ?? []), ...(secondReaders.runtimeSources ?? []),
          ] };
          const catalog = await readCatalog(readers);
          actions.push({ action: "actual-catalog", observed: catalog });
          const worker = await serveDomainWorker(directory, () => readers);
          try {
            const client = await attachAuthenticatedWorker(directory);
            try {
              const installations = await client.request({ operation: "installations" });
              const runtimes = await client.request({ operation: "runtimes" });
              assertions.runtimeInstallationCorrelation = runtimes.ok && runtimes.result.runtimes.length === 2
                && runtimes.result.runtimes.every(row => rootPids.includes(row.binding.rootIncarnation.pid))
                && new Set(runtimes.result.runtimes.map(row => row.installationId)).size === 1;
              assertions.busyCapabilityTruth = catalog.observations.length > 0
                && catalog.observations.every(row => row.contract.capabilities.busySafe.kind !== "supported"
                  && row.contract.capabilities.completion.kind !== "supported"
                  && row.contract.capabilities.resume.kind !== "supported");
              actions.push({ action: "service-installations", observed: installations },
                { action: "service-runtimes", observed: runtimes });
              if (!runtimes.ok) blockers.push({ owner: "task17 catalog-provider / task4 service-domain owners",
                field: "RuntimeAvailability.observed -> RuntimeBinding.installationId",
                required: "Genuine root incarnation/socket epoch, captured startup identity and installation resource correlation; no native restart qualification required",
                observed: { runtimeAvailability: catalog.runtimeAvailability, service: runtimes } });
              if (installations.ok) {
                const installation = installations.result.installations[0];
                if (installation) {
                  const checked = await client.request({ operation: "check", installationId: installation.installationId });
                  actions.push({ action: "service-check", observed: checked });
                  assertions.versionsAndCheckTime = checked.ok && runtimes.ok
                    && runtimes.result.runtimes.every(row => row.runningVersion.kind === "known")
                    && installation.installedVersion.kind === "known";
                  if (!checked.ok) blockers.push({ owner: "task4 service-domain / family check adapter owners",
                    field: "check -> CheckResult/lastCheck",
                    required: "Read-only actual installed/available version and checkedAt; zero installation mutation",
                    observed: checked });
                }
              }
              actions.push({ action: "busy-capability-truth", observed: catalog.observations.map(row => ({
                family: row.contract.family, installation: row.contract.installation,
                capabilities: row.contract.capabilities,
              })) });
              if (!assertions.wrapperManagedEngineGrouped) blockers.push({
                owner: "task17 catalog source/provider owners", field: "Installation.resources owned wrapper/managed-engine grouping",
                required: "Actual OmO/Senpi shared owned resource represented in catalog, not two independent updaters",
                observed: { source: sourceSnapshot.candidates, public: catalog.installations },
              });
            } finally { client.close(); }
          } finally { await worker.stop(); }
          requireThat(sourceSnapshot.state === "complete" && secondSnapshot.state === "complete", "source-incomplete");
          requireThat(catalog.failures.length === 0, "catalog-source-failure");
          // Empty/source-only catalog is never a full actual catalog pass.
          if (catalog.runtimes.length !== 2 || catalog.runtimeReadiness !== "observed")
            requireThat(blockers.length > 0, "unproven-runtime");
        } finally { await source.close(); await second.close(); }
      } finally {
        for (const { path, child } of cores.reverse()) {
          await catalogExchange(path, "server.stop", {});
          const ended = await bounded(child.completed);
          actions.push({ action: "actual-core-exit", observed: ended });
          requireThat(ended.exitCode === 0, "core-clean-exit");
        }
      }
    }, { timeoutMs: 60000, joinTimeoutMs: 10000 });
    cleanup = run.cleanup; executions = run.executions;
  } catch (error) {
    if (!(error instanceof RunFailure)) throw error;
    cleanup = await error.finalCleanup; executions = error.executions;
    failureCode = error.original instanceof QaError ? error.original.code : "catalog-execution-failed";
    actions.push({ action: "scenario-failure", observed: {
      code: failureCode, error: error.original instanceof Error ? error.original.message : String(error.original),
    } });
  }
  const after = await hashes();
  const stable = isDeepStrictEqual(before, after);
  const remainingRoots = rootPids.filter(pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw error; }
  });
  requireThat(cleanup !== undefined, "cleanup-missing");
  const artifactAfter = Object.fromEntries(await Promise.all(Object.keys(artifactHashes).map(async path => [path, await fileDigest(path)])));
  const sourceStable = stable && isDeepStrictEqual(artifactHashes, artifactAfter);
  const status: "FAIL" | "BLOCKED" | "PASS" = failureCode || !sourceStable || cleanup.resourcesRemaining !== 0 || remainingRoots.length > 0
    ? "FAIL" : blockers.length > 0 ? "BLOCKED" : "PASS";
  requireThat(status !== "PASS" || Object.values(assertions).every(Boolean), "catalog-proof-incomplete");
  return { result: { scenario: "catalog", evidenceDir, status, qualification: "actual-core-readonly-not-native-restart",
    FullDone: false, nativeQualifiedFamilies: 0, failureCode, blockers, dependenciesStable: sourceStable,
    cleanupResourcesRemaining: cleanup.resourcesRemaining + remainingRoots.length,
    before, after, artifactHashes, artifactAfter, remainingRoots, assertions },
  cleanup: { ...cleanup, remainingRoots, socketsRemoved: await Promise.all(sockets.map(async path => !await Bun.file(path).exists())) },
  actions, executions };
}

export async function catalogMain(args: readonly string[]): Promise<number> {
  const parsed = parseCatalogArgs(args); // Before filesystem writes or child acquisition.
  const fixtureInfo = await lstat(parsed.fixtures);
  requireThat(fixtureInfo.isDirectory() && !fixtureInfo.isSymbolicLink()
    && await realpath(parsed.fixtures) === parsed.fixtures, "invalid-fixtures");
  let current = await realpath(project);
  for (const part of relative(project, parsed.evidenceDir).split("/")) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      requireThat(info.isDirectory() && !info.isSymbolicLink(), "evidence-path");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  try {
    requireThat((await readdir(parsed.evidenceDir)).length === 0, "evidence-not-empty");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(parsed.evidenceDir, { recursive: true, mode: 0o700 });
  const run = await runCatalog(parsed.evidenceDir);
  for (const [name, value] of [["result.json", run.result], ["cleanup.json", run.cleanup],
    ["executions.json", run.executions]] as const)
    await writeFile(join(parsed.evidenceDir, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(join(parsed.evidenceDir, "actions.jsonl"), [
    { action: "invocation", observed: { argv: ["bun", "scripts/qa/lifecycle.ts", ...args] } }, ...run.actions,
  ].map(value => JSON.stringify(value)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(run.result));
  return catalogExitCode(run.result.status);
}
