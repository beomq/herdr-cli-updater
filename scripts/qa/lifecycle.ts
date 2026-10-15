import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import type { CatalogObservation, CatalogReaders } from "../../src/catalog";
import { JobError } from "../../src/jobs/jobs";
import type { NewJob } from "../../src/jobs/jobs";
import { JobStore } from "../../src/jobs/store";
import { attachAuthenticatedWorker, isServiceResponse } from "../../src/service/client";
import { domainStoreDirectory } from "../../src/service/domain";
import { connectPrivateSocket } from "../../src/service/socket";
import type { SocketEvent } from "../../src/service/socket";
import { discoverWorker, serveDomainWorker, stopWorker } from "../../src/service/worker";
import { JobComponent } from "../../src/tui/job";
import { RecoveryComponent } from "../../src/tui/recovery";
import { fileDigest, hashBytes, QaError, RunFailure, withIsolation } from "./runner";
import type { CleanupReceipt, ExecutionReceipt } from "./runner";
import { catalogMain } from "./catalog";

const project = resolve(import.meta.dir, "../..");
const ownedEvidence = join(project, ".omo/evidence/herdr-cli-updater/task33/redaction-r1");
const dependencies = [
  "src/service/client.ts", "src/service/domain.ts", "src/service/socket.ts", "src/service/worker.ts",
  "src/catalog.ts", "src/protocol.ts", "src/adapters/types.ts", "src/jobs/jobs.ts", "src/jobs/store.ts",
  "src/tui/job.ts", "src/tui/recovery.ts", "scripts/qa/runner.ts", "scripts/qa/registry.ts",
] as const;
const sourceCases = ["prompt", "transcript", "capability", "path", "throw"] as const;
const missingNativeProof = [
  "genuine-core-source-acquisition-and-build",
  "eight-actual-family-loader-captures",
  "native-update-and-exact-resume",
  "actual-restore-arguments",
  "registry-native-proof-observation",
] as const;

function requireThat(value: boolean, code: string): asserts value {
  if (!value) throw new QaError(code, code);
}
export function assertRedacted(value: unknown, secrets: readonly string[]): void {
  const bytes = typeof value === "string" ? value : JSON.stringify(value);
  requireThat(!secrets.some(secret => bytes.includes(secret)), "secret-leak");
}
function bounded<T>(promise: Promise<T>, timeoutMs = 5000): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new QaError("deadline", "signal deadline")), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolvePromise(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}
async function hashes() {
  return Object.fromEntries(await Promise.all(dependencies.map(async path => [path, await fileDigest(join(project, path))])));
}

export function parseLifecycleArgs(args: readonly string[]) {
  requireThat(args.length === 6 && args[0] === "--scenario" && args[1] === "redaction"
    && args[2] === "--secret-sentinel" && args[4] === "--evidence-dir", "invalid-command");
  const sentinel = args[3], destination = args[5];
  requireThat(typeof sentinel === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(sentinel)
    && typeof destination === "string" && destination.length > 0, "invalid-command");
  const evidenceDir = destination === "E/redaction" ? join(ownedEvidence, "redaction") : resolve(destination);
  const suffix = relative(ownedEvidence, evidenceDir);
  requireThat(suffix !== "" && !suffix.startsWith("..") && !isAbsolute(suffix), "evidence-path");
  return { sentinel, evidenceDir };
}

/** Private fixture seam only. The request handler, authentication, projection,
 * CAS, publication and storage are the production implementations, not substitutes.
 * The seeded job is not a native update/resume observation.
 */
export async function ownedRedactionWorker(): Promise<void> {
  const home = process.env["HOME"], sockets = process.env["XDG_RUNTIME_DIR"];
  requireThat(typeof home === "string" && typeof sockets === "string"
    && process.env["QA_PREFIX"] === join(resolve(home, ".."), "i")
    && sockets === join(resolve(home, ".."), "s"), "private-child-environment");
  const lines = createInterface({ input: process.stdin });
  const input = lines[Symbol.asyncIterator]();
  const first = await input.next();
  requireThat(!first.done, "seed-missing");
  const secret: unknown = JSON.parse(first.value);
  requireThat(typeof secret === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(secret), "seed-invalid");
  const privatePath = join(home, secret, "conversation.jsonl");
  const privateSource = { prompt: secret, transcript: [secret], capability: secret, path: privatePath };
  const binding = {
    socketId: "fixture-source", socketEpoch: "fixture-epoch", paneId: "fixture-pane", paneGeneration: 1,
    rootIncarnation: { pid: process.pid, startIdentity: "fixture-process", executableRealpath: process.execPath },
    session: { kind: "conversation", fullId: "redaction-saved-session", storagePathHash: hashBytes(privatePath) } as const,
    cwd: home, optionsRef: `options:${hashBytes(secret)}`, turnGeneration: 1, resourcesFingerprint: "fixture-fingerprint",
  };
  const installation = {
    installationId: "omo-redaction-fixture", resourcesFingerprint: "fixture-fingerprint",
    owner: { kind: "unknown", reason: "unverified_owner" } as const,
    installedVersion: { kind: "unknown", reason: "not_captured" } as const,
  };
  const specification: NewJob = {
    jobId: "redaction-job", requestId: "redaction-seed", mode: "update-and-restart" as const, installation,
    selectedTargets: [{ targetId: "redaction-target", runtimeId: "fixture-runtime",
      installationId: installation.installationId, expectedBinding: binding }],
  };
  const directory = join(sockets, "worker"), storage = domainStoreDirectory(directory);
  const seed = new JobStore(storage);
  const rejectedFields: string[] = [];
  try {
    for (const field of ["prompt", "transcript", "token", "env", "argv"] as const) {
      let rejected = false;
      try { seed.create({ ...specification, [field]: secret }); }
      catch (error) {
        if (!(error instanceof JobError) || error.code !== "invalid_input") throw error;
        rejected = true;
      }
      requireThat(rejected, "private-storage-admitted-secret");
      rejectedFields.push(field);
    }
    seed.create(specification);
  } finally { seed.close(); }
  const unknown = { kind: "unknown", reason: "not_verified" } as const;
  const row: CatalogObservation = { lastCheck: null, contract: {
    version: 1, family: "omo",
    installation: { ...installation, family: "omo", channel: "unknown", executableRealpath: process.execPath,
      resources: [{ resourceId: "fixture-resource", realpath: process.execPath, fingerprint: "fixture-fingerprint" }] },
    runtime: { runtimeId: "fixture-runtime", installationId: installation.installationId,
      binding, runningVersion: { kind: "unknown", reason: "not_captured" } },
    capabilities: { check: unknown, update: unknown, busySafe: unknown, completion: unknown,
      resume: unknown, gracefulExit: unknown },
  } };
  const runtime = row.contract.runtime;
  requireThat(runtime !== null, "fixture-runtime");
  let state = "clean";
  const readers: CatalogReaders = { candidates: [], sockets: [{
    socketId: binding.socketId, socketEpoch: binding.socketEpoch, read: async () => {
      switch (state) {
        case "clean": return { ok: true, value: [row] };
        case "throw": throw new Error(privateSource.prompt);
        case "prompt": case "transcript":
          return { ok: true, value: [{ ...row, contract: { ...row.contract, [state]: privateSource[state] } }] };
        case "capability":
          return { ok: true, value: [{ ...row, contract: { ...row.contract,
            capabilities: { ...row.contract.capabilities, resume: { ...unknown, token: privateSource.capability } } } }] };
        case "path":
          return { ok: true, value: [{ ...row, contract: { ...row.contract,
            runtime: { ...runtime, binding: { ...binding,
              session: { ...binding.session, storagePath: privateSource.path } } } } }] };
        default: throw new QaError("fixture-command", "fixture-command");
      }
    },
  }] };
  const worker = await serveDomainWorker(directory, readers);
  const emit = (event: string, value: unknown) => console.log(JSON.stringify({ event, value }));
  emit("ready", { owner: worker.owner, rejectedFields, storagePathHash: binding.session.storagePathHash,
    privateSourceSha256: hashBytes(JSON.stringify(privateSource)), seededJobOnly: true });
  try {
    for (;;) {
      const command = await Promise.race([input.next(), worker.closed.then(() => ({ done: true as const, value: "" }))]);
      if (command.done) break;
      requireThat(command.value === "clean" || sourceCases.some(value => value === command.value), "fixture-command");
      state = command.value;
      emit("configured", { state });
    }
  } finally { lines.close(); await worker.stop(); }
}

export async function runRedaction(sentinel: string) {
  requireThat(/^[A-Za-z0-9_-]{8,128}$/.test(sentinel), "seed-invalid");
  const before = await hashes();
  const actions: { readonly action: string; readonly observed: unknown }[] = [];
  let cleanup: CleanupReceipt | undefined;
  let executions: readonly ExecutionReceipt[] = [];
  let failureCode: string | null = null;
  // Mutable build observation shared with the isolated action.
  const buildObservation: { value: { readonly sha256: string; readonly sourceSha256: string } | null } = { value: null };
  const sourceSha256 = await fileDigest(import.meta.path);
  try {
    const run = await withIsolation(async context => {
      // A genuine local JS bundle observation, explicitly NOT a native core build.
      const build = await Bun.build({ entrypoints: [import.meta.path], target: "bun" });
      requireThat(build.success && build.outputs.length === 1, "subset-bundle-failed");
      const output = build.outputs[0];
      requireThat(output !== undefined, "subset-bundle-missing");
      const artifact = join(context.paths.prefix, "redaction.js");
      await writeFile(artifact, new Uint8Array(await output.arrayBuffer()), { flag: "wx", mode: 0o600 });
      buildObservation.value = { sha256: await fileDigest(artifact), sourceSha256 };
      const child = await context.spawn({ argv: [process.execPath, "-e",
        `import { ownedRedactionWorker } from ${JSON.stringify(artifact)}; await ownedRedactionWorker();`],
        readyEvent: "ready", eventTimeoutMs: 5000 });
      child.write(JSON.stringify(sentinel) + "\n");
      const ready = await child.ready;
      requireThat(ready !== undefined, "readiness-missing");
      assertRedacted(ready.value, [sentinel]);
      actions.push({ action: "production-worker-ready", observed: ready.value });
      const directory = join(context.paths.sockets, "worker"), owner = discoverWorker(directory);
      const token = await Bun.file(owner.tokenPath).text();
      const secrets = [sentinel, token];
      const capture = (action: string, observed: unknown) => {
        assertRedacted(observed, secrets);
        actions.push({ action, observed });
      };
      const identity = await lstat(owner.socketPath);
      capture("socket-identity", { ...owner, dev: identity.dev, ino: identity.ino,
        mode: identity.mode & 0o777, uid: identity.uid, home: context.paths.home, config: context.paths.profile,
        sqlite: domainStoreDirectory(directory), fixtureSourceNotNativeCore: true });
      requireThat(identity.isSocket() && (identity.mode & 0o777) === 0o600, "socket-mode");
      const client = await attachAuthenticatedWorker(directory, 5000);
      try {
        const installs = await client.request({ operation: "installations" });
        requireThat(installs.ok && installs.result.installations.length === 1
          && installs.result.installations[0]?.family === "omo", "family-identity-lost");
        capture("installations", installs);
        const runtimes = await client.request({ operation: "runtimes" });
        requireThat(runtimes.ok && runtimes.result.runtimes.length === 1
          && runtimes.result.runtimes[0]?.binding.session.fullId === "redaction-saved-session"
          && runtimes.result.runtimes[0]?.binding.session.storagePathHash === hashBytes(join(context.paths.home, sentinel, "conversation.jsonl")),
        "session-identity-lost");
        capture("runtimes", runtimes);
        const targets = await client.request({ operation: "targets", installationId: "omo-redaction-fixture" });
        requireThat(targets.ok && targets.result.targets.length === 0, "forged-restart-capability");
        capture("unqualified-targets", targets);
        for (const state of sourceCases) {
          const configured = child.waitFor("configured", 5000);
          child.write(state + "\n");
          capture("source-configured", (await configured).value);
          const response = await client.request({ operation: "runtimes" });
          requireThat(!response.ok && response.error.code === (state === "throw" ? "verification_failed" : "malformed_request"),
            "private-source-not-rejected");
          capture(`source-${state}-rejection`, response);
        }
        for (const input of [
          { version: 1, requestId: "bad-source", operation: "jobs", token, prompt: sentinel, transcript: [sentinel] },
          { version: 1, requestId: "bad-token", operation: "jobs", token: hashBytes(sentinel) },
        ]) {
          const wire = await connectPrivateSocket(owner.socketPath, AbortSignal.timeout(5000));
          try {
            const reply = bounded(wire.next());
            wire.send(input);
            const response = await reply;
            requireThat(typeof response === "object" && response !== null && "error" in response
              && isDeepStrictEqual(response.error, { code: input.token !== token ? "unauthorized" : "malformed_request" }),
            "wire-secret-not-rejected");
            capture("wire-rejection", response);
          } finally { wire.close(); }
        }
        const jobs = await client.request({ operation: "jobs" });
        requireThat(jobs.ok && jobs.result.jobs.length === 1, "seed-job-missing");
        const job = jobs.result.jobs[0];
        requireThat(job !== undefined && job.status === "queued" && job.mode === "update-and-restart", "seed-forged-completion");
        capture("public-jobs", jobs);
        const inspect = await client.request({ operation: "inspect-job", jobId: job.jobId });
        requireThat(inspect.ok && inspect.result.targets.every(target => target.effect === "unknown"
          && target.lastIdentity === null && target.safeAction === "inspect"), "seed-forged-effect");
        capture("public-inspection", inspect);
        const create = await client.request({ operation: "create-job", mode: "update-and-restart",
          installation: job.installTxn.selection, selectedTargets: job.selectedTargets });
        const reconcile = await client.request({ operation: "reconcile-job", jobId: job.jobId, expectedRevision: job.revision });
        requireThat(!create.ok && create.error.code === "unsupported" && !reconcile.ok
          && reconcile.error.code === "unsupported", "fake-native-success");
        capture("unsupported-create", create); capture("unsupported-reconcile", reconcile);
        // Structurally completed states without the effect receipts are NOT proof.
        const forged = { ...job, status: "completed" as const, failure: null,
          installTxn: { ...job.installTxn, state: "succeeded" as const, failure: null },
          targetTxns: job.targetTxns.map(target => ({ ...target, state: "completed" as const, failure: null })) };
        requireThat(!isServiceResponse({ ...jobs, result: { jobs: [forged] } }), "forged-client-completion");
        const recovery = new RecoveryComponent(forged);
        requireThat(recovery.view.verified === false && recovery.view.outcome === "unverified", "forged-render-completion");
        capture("forged-completion-refused", { clientAdmitted: false, view: recovery.view });
        for (const [columns, rows] of [[80, 24], [120, 40]] as const) {
          const render = new JobComponent(job).render(columns, rows);
          const recover = new RecoveryComponent(job).render(columns, rows);
          const forgedRender = new JobComponent(forged).render(columns, rows);
          requireThat(!forgedRender.includes("result: completed"), "forged-job-render-completion");
          requireThat([render, recover, forgedRender].every(frame => frame.split("\n").length <= rows
            && frame.split("\n").every(line => Bun.stringWidth(line) <= columns)), "render-overflow");
          capture("component-render", { columns, rows, render, recover, forgedRender, pixelsVerified: false });
        }
        const event = Promise.withResolvers<SocketEvent>();
        const subscription = await client.subscribe({ incarnation: client.incarnation, sequence: 0 },
          { event: event.resolve, error: event.reject });
        try {
          // Subscription ACK and bounded listener precede the committing action.
          const notification = bounded(event.promise);
          const cancelled = await client.request({ operation: "cancel-job", jobId: job.jobId, expectedRevision: job.revision });
          const observed = await notification;
          requireThat(cancelled.ok && cancelled.result.job.status === "cancelled"
            && cancelled.result.job.revision === 1 && isDeepStrictEqual(observed.response, cancelled)
            && observed.incarnation === owner.incarnation && observed.sequence === 1, "cancel-event-mismatch");
          capture("public-cancel", cancelled); capture("public-event", observed);
          const stale = await client.request({ operation: "cancel-job", jobId: job.jobId, expectedRevision: 0 });
          requireThat(!stale.ok && stale.error.code === "revision_conflict", "stale-cancel-not-rejected");
          capture("stale-cancel", stale);
        } finally { subscription.close(); await subscription.closed; }
      } finally { client.close(); }
      // Production authenticated incarnation shutdown; retained spawn exit bounded.
      const completed = bounded(child.completed);
      await stopWorker(owner);
      const receipt = await completed;
      requireThat(receipt.exitCode === 0 && receipt.signal === null, "worker-exit");
      capture("process-exit", receipt);
      for (const file of [owner.socketPath, owner.tokenPath, owner.controlPath, join(directory, "owner.json")])
        requireThat(!(await Bun.file(file).exists()), "owned-worker-resource-remains");
      const storage = domainStoreDirectory(directory);
      using persisted = new JobStore(storage);
      const final = persisted.get("redaction-job");
      requireThat(final.status === "cancelled" && final.revision === 1, "cancel-not-durable");
      capture("persisted-after-shutdown", final);
      for (const name of await readdir(storage)) {
        const bytes = new Uint8Array(await Bun.file(join(storage, name)).arrayBuffer());
        requireThat(!secrets.some(secret => Buffer.from(bytes).includes(Buffer.from(secret))), "db-secret-leak");
        capture("db-file-scan", { name, size: bytes.length, sha256: hashBytes(bytes), secretFound: false });
      }
    }, { timeoutMs: 30000, joinTimeoutMs: 5000 });
    cleanup = run.cleanup; executions = run.executions;
  } catch (error) {
    if (!(error instanceof RunFailure)) throw error;
    cleanup = error.cleanup; executions = error.executions;
    failureCode = error.original instanceof QaError ? error.original.code : "scenario-failed";
  }
  const after = await hashes();
  const dependenciesStable = isDeepStrictEqual(before, after);
  const subsetPassed = failureCode === null && dependenciesStable && cleanup?.resourcesRemaining === 0
    && cleanup.actionState === "joined";
  // Subset success cannot satisfy or bypass the registry's native proof gate.
  const result = {
    task: "33.redaction-r1", scenario: "redaction", status: failureCode ? "FAIL" : "BLOCKED",
    FullDone: false, qualification: "production-integration-subset-not-native", subsetPassed,
    failureCode, dependenciesStable, missingNativeProof, sourceSha256, buildSourceSha256: buildObservation.value?.sourceSha256 ?? null,
    subsetBuild: buildObservation.value, coreBuild: null, nativeProof: null, nativeUpdateResumeCaptures: 0,
    captures: actions.length, cleanupResourcesRemaining: cleanup?.resourcesRemaining ?? 1,
    sentinelSha256: hashBytes(sentinel),
  } as const;
  assertRedacted({ result, actions, executions }, [sentinel]);
  return { result, actions, cleanup, manifest: { before, after, bun: Bun.version, executable: process.execPath,
    executableSha256: await fileDigest(process.execPath), sourceSha256, build: buildObservation.value,
    nativeAcquisition: null, nativeBuild: null }, executions };
}

async function evidenceDirectory(path: string): Promise<void> {
  let current = await realpath(project);
  for (const part of relative(project, path).split("/")) {
    current = join(current, part);
    await mkdir(current, { recursive: true, mode: 0o700 });
    const info = await lstat(current);
    requireThat(info.isDirectory() && !info.isSymbolicLink(), "evidence-path");
  }
}
export async function lifecycleMain(args: readonly string[]): Promise<number> {
  if (args[0] === "--scenario" && args[1] === "catalog") return catalogMain(args);
  const { sentinel, evidenceDir } = parseLifecycleArgs(args); // before builds, processes or writes
  await evidenceDirectory(evidenceDir);
  const run = await runRedaction(sentinel);
  for (const [name, value] of [["result.json", run.result], ["cleanup.json", run.cleanup],
    ["manifest.json", run.manifest]] as const)
    await writeFile(join(evidenceDir, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(join(evidenceDir, "actions.jsonl"),
    [{ action: "invocation", observed: { argv: ["bun", "scripts/qa/lifecycle.ts", "--scenario", "redaction",
      "--secret-sentinel", { sha256: hashBytes(sentinel), withheld: true }, "--evidence-dir", evidenceDir] } },
      ...run.actions].map(action => JSON.stringify(action)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(run.result));
  return run.result.status === "FAIL" ? 1 : 3;
}

if (import.meta.main) {
  try { process.exitCode = await lifecycleMain(process.argv.slice(2)); }
  catch (error) {
    // CLI boundary never emits raw source exception/prompt/path/token text.
    console.error(JSON.stringify({ status: "FAIL", FullDone: false,
      code: error instanceof QaError ? error.code : "scenario-failed" }));
    process.exitCode = error instanceof QaError && ["invalid-command", "evidence-path"].includes(error.code) ? 2 : 1;
  }
}
