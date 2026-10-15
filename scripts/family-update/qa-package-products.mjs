import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

// This track never relocates, repairs, or restores acquired installation bytes.
// The only writer to a selected installation is the real product consumer.
const project = await realpath(join(import.meta.dirname, "../.."));
const base = join(project, ".omo/evidence/herdr-cli-updater/six-families/packages");
const families = ["claude", "codex", "omp", "grok"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const need = (condition, message) => { if (!condition) throw new Error(message); };
const json = async path => JSON.parse(await readFile(path, "utf8"));
async function digest(path) {
  const before = await lstat(path, { bigint: true });
  need(before.isFile() && await realpath(path) === path, `Not a canonical regular file: ${path}`);
  const value = createHash("sha256");
  for await (const bytes of createReadStream(path)) value.update(bytes);
  const after = await lstat(path, { bigint: true });
  need(["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => before[key] === after[key]), `Changed while reading: ${path}`);
  return value.digest("hex");
}
const pin = async path => ({ path, sha256: await digest(path) });
async function verify(reference) {
  need(await digest(reference.path) === reference.sha256, `Acquired pin changed: ${reference.path}`);
}
async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
async function persist(root, name, bytes) {
  const path = join(root, name);
  need(path.startsWith(root + "/"), "Evidence destination escaped");
  await directory(dirname(path));
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return pin(path);
}
const record = (root, name, value) => persist(root, name, JSON.stringify(value, null, 2) + "\n");
async function snapshot(root) {
  const rows = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name), relativePath = relative(root, file);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isSymbolicLink()) rows.push({ relativePath, symlink: await readlink(file) });
      else {
        need(entry.isFile(), `Unexpected installation entry: ${file}`);
        const info = await lstat(file);
        rows.push({ relativePath, sha256: await digest(file), bytes: info.size, mode: info.mode & 0o777 });
      }
    }
  }
  for (const name of ["prefix", "home", "bun"]) await visit(join(root, name));
  return rows.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
function equalRows(actual, expected, message) {
  need(isDeepStrictEqual(actual, [...expected].sort((a, b) => a.relativePath.localeCompare(b.relativePath))), message);
}
async function command(argv, env, timeoutMs = 30000) {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { argv, pid: child.pid, stdout, stderr, exitCode, signal: child.signalCode };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
}
async function census(prefix) {
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
  return {
    observedAt: Date.now(),
    processes: await command(["/bin/ps", "-axo", "pid=,ppid=,uid=,lstart="], env),
    consumers: await command(["/usr/sbin/lsof", "-n", "-P", "-Fpn", "+D", prefix], env),
  };
}
async function acquire(root, name, url) {
  const startedAt = Date.now();
  const response = await fetch(url, { credentials: "omit", redirect: "error",
    headers: { Accept: "application/json", "User-Agent": "herdr-cli-updater-product-qa" },
    signal: AbortSignal.timeout(30000) });
  need(response.status === 200 && !response.redirected, `Public response ${response.status}: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  need(bytes.length <= 1024 * 1024, `Public response too large: ${url}`);
  const receivedAt = Date.now(), body = await persist(root, `public/${name}.json`, bytes);
  return { url, status: 200, body, startedAt, receivedAt, value: JSON.parse(new TextDecoder().decode(bytes)) };
}
async function prepare(family, root, workerDirectory) {
  const inputPath = join(base, family, "input-manifest.json"), input = await json(inputPath);
  const original = await pin(inputPath);
  for (const reference of [input.receipt, input.originalInstallCompletion, input.discoveryProvenance,
    input.managerProvenance, input.restoredBefore.observation]) await verify(reference);
  const completion = await json(input.originalInstallCompletion.path);
  need(completion.status === "GENUINE_BEFORE_TARGET_ORIGINAL_INSTALLS_COMPLETED", "Original install was not complete");
  const before = await snapshot(input.selectedRoot), acquiredBefore = await json(input.restoredBefore.observation.path);
  equalRows(before, acquiredBefore, "Selected root no longer equals independently observed before");
  const after = await snapshot(input.capturedAfter), acquiredAfter = await json(completion.comparison.target.path);
  equalRows(after, acquiredAfter, "Captured original after bytes differ from acquired observation");
  await record(root, "snapshot-before.json", before);
  await record(root, "snapshot-independent-after.json", after);
  const q = structuredClone(input.qualification), installed = q.installation;
  q.confinement = { root: input.selectedRoot, system: await pin("/usr/bin/sandbox-exec") };
  if (family === "grok") {
    const homeSnapshot = rows => ({
      files: rows.filter(row => row.relativePath.startsWith("home/") && !row.symlink)
        .map(row => ({ path: row.relativePath.slice(5), sha256: row.sha256, mode: row.mode })),
      links: rows.filter(row => row.relativePath.startsWith("home/") && row.symlink)
        .map(row => ({ path: row.relativePath.slice(5), target: row.symlink })),
    });
    q.home = { before: homeSnapshot(before), after: homeSnapshot(after) };
  }
  const expected = structuredClone(installed);
  expected.installedVersion = { kind: "known", version: q.target.version };
  expected.resources = expected.resources.map(row => {
    const found = after.find(file => file.relativePath === relative(input.selectedRoot, row.realpath));
    need(found?.sha256, `Missing measured after resource: ${row.realpath}`);
    return { ...row, fingerprint: `sha256:${found.sha256}` };
  });
  expected.resourcesFingerprint = `sha256:${hash(JSON.stringify(expected.resources))}`;
  const expectedAfterPin = await record(root, "expected-after.json", expected);
  // Projection of measured source facts, with the unchanged raw provenance pinned
  // separately. No channel, owner, physical path or payload hash is invented.
  const discovery = await record(root, "discovery-receipt.json", {
    family, channel: installed.channel, executable: installed.executableRealpath,
    owner: installed.owner,
    packageManifest: join(installed.owner.prefix, "lib/node_modules", installed.owner.packageName, "package.json"),
    resources: installed.resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })),
  });
  const encoded = encodeURIComponent(q.target.packageName);
  const replies = [
    await acquire(root, "latest", `https://registry.npmjs.org/${encoded}/latest`),
    await acquire(root, "dist-tags", `https://registry.npmjs.org/-/package/${encoded}/dist-tags`),
  ];
  if (family === "codex") replies.push(await acquire(root, "github-latest", "https://api.github.com/repos/openai/codex/releases/latest"));
  need(replies[0].value.name === q.target.packageName && replies[0].value.version === q.target.version
    && replies[1].value.latest === q.target.version, "Actual public latest moved away from acquired target");
  if (family === "codex") need(replies[2].value.tag_name === `rust-v${q.target.version}`
    && replies[2].value.draft === false && replies[2].value.prerelease === false, "Actual GitHub target does not match npm latest");
  // Fresh observation, not an edited historical receipt or artificial clock.
  q.target.checkedAt = replies[1].receivedAt;
  q.target.expiresAt = q.target.checkedAt + 300000;
  const receipt = await record(root, "qualification-observed.json", q);
  await record(root, "preparation.json", {
    family, original, originalReceipt: input.receipt, originalDiscoveryProvenance: input.discoveryProvenance,
    snapshotRecheckedAt: Date.now(), selectedRoot: input.selectedRoot, capturedAfter: input.capturedAfter,
    publicRequests: replies.map(({ value, ...reply }) => reply),
    historicalQualificationPreserved: true, changedQualificationFields: [
      "target.checkedAt", "target.expiresAt", "confinement", ...(family === "grok" ? ["home"] : []),
    ],
    confinementSystemPinObservedFromCanonicalSystemBinary: q.confinement.system,
    homeSnapshotsDerivedFromRecheckedOriginalCalibration: family === "grok",
    originalManager: q.manager, environment: q.env, externalPostinstall: input.externalPostinstall,
    originalLifecycleCommands: input.originalCommands.filter(row => row.argv.includes("--script-shell=/bin/sh")),
  });
  const inputs = {
    schemaVersion: 1, profile: "qualified-package-update-only-v1", ownerDirectory: workerDirectory,
    profiles: [{
      update: { qualification: q, receipt },
      sourcePins: [discovery, input.discoveryProvenance, original, input.originalInstallCompletion, input.managerProvenance],
      expectedAfterPin, acquiredReplies: replies.map(({ url, status, body }) => ({ url, status, body })),
      coverage: { root: input.selectedRoot, prefix: installed.owner.prefix, socketDirectory: workerDirectory,
        registeredSockets: [join(workerDirectory, "service.sock"), join(workerDirectory, "control.sock")], rootPids: [] },
    }],
  };
  await record(root, "native-and-home-output-pins.json", {
    before: before.filter(row => row.relativePath.startsWith("home/") || row.bytes > 1024 * 1024),
    independentlyAcquiredAfter: after.filter(row => row.relativePath.startsWith("home/") || row.bytes > 1024 * 1024),
  });
  return { input, original, q, before, after, inputs, replies };
}
async function workerMain() {
  process.umask(0o077);
  const incoming = Promise.withResolvers();
  process.once("message", incoming.resolve);
  const timer = setTimeout(() => incoming.reject(new Error("worker configuration IPC deadline")), 30000);
  let worker, evidenceRoot;
  try {
    const { configurationPath, workerDirectory, home, path } = await incoming.promise;
    evidenceRoot = dirname(configurationPath);
    clearTimeout(timer);
    process.env.HERDR_CLI_UPDATER_RUNTIME_CONFIG = configurationPath;
    const { serveDomainWorker } = await import("../../src/service/worker.ts");
    worker = await serveDomainWorker(workerDirectory, undefined, { home, path, prefixes: [] });
    process.send({ kind: "ready", owner: worker.owner });
    process.once("message", message => { if (message.kind === "stop") void worker.stop(); });
    await worker.closed;
  } catch (error) {
    const failure = { name: error.name, message: error.message, code: error.code ?? null, stack: error.stack };
    if (evidenceRoot) await record(evidenceRoot, "worker-failure.json", failure);
    let diagnostic;
    try {
      const stdout = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,uid=,lstart="], {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
        encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      });
      diagnostic = { stage: "same-worker-real-ps", stdout };
    } catch (probe) {
      diagnostic = { stage: "same-worker-real-ps", error: {
        message: probe.message, code: probe.code, status: probe.status, stdout: probe.stdout?.toString(), stderr: probe.stderr?.toString(),
      } };
    }
    if (evidenceRoot) await record(evidenceRoot, "worker-ps-diagnostic.json", diagnostic);
    process.send({ kind: "failed", error: failure });
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await worker?.stop();
    process.disconnect?.();
  }
}
async function actual(family, loadOnly = false) {
  const root = join(base, `${family}-product-qa`, `run-${Date.now()}`);
  await directory(root);
  const socketRoot = await realpath(await mkdtemp(join(tmpdir(), "hpq-")));
  await chmod(socketRoot, 0o700);
  let child, attachment, subscription, timeout;
  const result = { family, root, status: "PREPARING", actualIncrement: false, serviceLoaded: false, phases: [], cleanup: {} };
  let prepared;
  try {
    prepared = await prepare(family, root, join(socketRoot, "w"));
    result.phases.push("public-replies-and-full-snapshots-rechecked");
    console.log("PACKAGE_QA_PREPARED", family, root);
    await record(root, "census-before.json", await census(prepared.q.installation.owner.prefix));
    // The service must perform its own real ps/lsof census. Confinement belongs
    // to the original npm child, not the worker or a caller-supplied observer.
    if (!loadOnly) need(prepared.q.confinement !== undefined, "Original npm child confinement contract not yet configured");
    const ready = Promise.withResolvers(), diagnostics = [];
    // Register the exact child IPC event before triggering service startup.
    child = Bun.spawn([process.execPath, import.meta.path, "--worker"], {
      cwd: root, env: { ...prepared.q.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "worker-transpiler-cache") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
      ipc(message) {
        if (message.kind === "ready") ready.resolve(message);
        else if (message.kind === "diagnostic") diagnostics.push(message);
        else if (message.kind === "failed") ready.reject(Object.assign(new Error(message.error.message), message.error));
      },
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    void child.exited.then(async code => {
      if (code === 0) return;
      try {
        const failure = await json(join(root, "worker-failure.json"));
        ready.reject(Object.assign(new Error(failure.message), failure));
      } catch (error) {
        ready.reject(error.code === "ENOENT" ? new Error(`Owned worker exited ${code}`) : error);
      }
    });
    timeout = setTimeout(() => ready.reject(new Error("Owned worker IPC readiness timeout")), 240000);
    prepared.inputs.profiles[0].coverage.rootPids = [child.pid];
    const { configurePluginRuntime } = await import("../../src/service/plugin-runtime.ts");
    const configurationPath = join(root, "package-runtime.json");
    configurePluginRuntime(configurationPath, prepared.inputs);
    await record(root, "worker-launch.json", { argv: [process.execPath, import.meta.path, "--worker"],
      pid: child.pid, environment: { ...prepared.q.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "worker-transpiler-cache") },
      installerEnvironment: prepared.q.env, configuration: await pin(configurationPath),
      umask: 0o077, umaskBasis: "originalLifecycleCommands[].umask in the acquired calibration",
      loadOnly, installerCanBeRequested: !loadOnly,
      serviceSocketPathBytes: Buffer.byteLength(join(prepared.inputs.ownerDirectory, "service.sock")),
      coverageIsCandidateUntilServiceReady: true });
    child.send({ configurationPath, workerDirectory: prepared.inputs.ownerDirectory, home: prepared.q.env.HOME, path: prepared.q.env.PATH });
    try {
      const loaded = await ready.promise;
      clearTimeout(timeout);
      result.serviceLoaded = true;
      await record(root, "service-loaded.json", loaded);
      const live = await census(prepared.q.installation.owner.prefix);
      live.socketNamespace = await Promise.all((await readdir(prepared.inputs.ownerDirectory)).map(async name => {
        const path = join(prepared.inputs.ownerDirectory, name), info = await lstat(path);
        return { path, socket: info.isSocket(), uid: info.uid, mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
      }));
      live.workerUnixDescriptors = await command(["/usr/sbin/lsof", "-n", "-P", "-a", "-p", String(child.pid), "-U", "-Fpn"],
        { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" });
      need(isDeepStrictEqual(live.socketNamespace.filter(row => row.socket).map(row => row.path).sort(),
        [...prepared.inputs.profiles[0].coverage.registeredSockets].sort()), "Owned live socket census mismatch");
      await record(root, "census-live.json", live);
      const { attachAuthenticatedWorker } = await import("../../src/service/client.ts");
      attachment = await attachAuthenticatedWorker(prepared.inputs.ownerDirectory, 60000);
      const request = async body => {
        const response = await attachment.request(body);
        await record(root, `${body.operation}.json`, response);
        need(response.ok, `${body.operation}: ${response.error?.code}`);
        return response.result;
      };
      const installations = await request({ operation: "installations" });
      const selected = installations.installations.find(row => row.installationId === prepared.q.installation.installationId);
      need(selected && selected.resourcesFingerprint === prepared.q.installation.resourcesFingerprint, "Actual catalog selection mismatch");
      const check = await request({ operation: "check", installationId: selected.installationId });
      need(check.result.kind === "update-available" && check.result.availableVersion === prepared.q.target.version, "Actual check target mismatch");
      const targets = await request({ operation: "targets", installationId: selected.installationId });
      need(targets.targets.length === 0, "Unexpected native runtime in native-free QA");
      if (loadOnly) {
        result.status = "ACTUAL_SERVICE_LOAD_CHECK_VERIFIED_NOT_INSTALLED";
        result.phases.push("service-loaded", "installations", "check", "targets", "live-owned-socket-census");
        return result;
      }
      const settled = Promise.withResolvers(), events = [];
      subscription = await attachment.subscribe({ incarnation: attachment.incarnation, sequence: "current" }, {
        event(event) {
          events.push(event);
          const job = event.response?.result?.job;
          // A durable intent deliberately exposes status=recovery_required while
          // installTxn.state=updating. It is progress, not terminal settlement.
          if (job && (["completed", "cancelled"].includes(job.status)
            || ["failed", "recovery_required"].includes(job.installTxn.state))) settled.resolve(job);
        },
        error: settled.reject,
      });
      await record(root, "job-subscription.json", {
        acknowledgedAt: Date.now(), cursor: subscription.cursor, workerIncarnation: loaded.owner.incarnation,
        installationId: selected.installationId, resourcesFingerprint: selected.resourcesFingerprint,
        createRequestSent: false,
      });
      const deadline = setTimeout(() => settled.reject(new Error("Exact job event deadline exceeded")), 240000);
      try {
        const { installationId, resourcesFingerprint, owner, installedVersion } = selected;
        const created = await request({ operation: "create-job", mode: "update-only",
          installation: { installationId, resourcesFingerprint, owner, installedVersion }, selectedTargets: [] });
        const job = await settled.promise;
        need(job.jobId === created.job.jobId && isDeepStrictEqual(job.installTxn.selection, created.job.installTxn.selection), "Completed event selection mismatch");
        result.job = job;
        need(job.status === "completed" && job.installTxn.state === "succeeded", `Actual job terminal status: ${job.status}`);
        need(job.installTxn.receipt?.kind === "completed" && job.installTxn.receipt.effect === "updated",
          "Completed job omitted the durable updated receipt");
        need(events.some(event => event.response?.result?.job?.jobId === job.jobId
          && ["queued", "waiting", "running"].includes(event.response.result.job.status)), "No actual job progress publication observed");
        const observedAfter = await snapshot(prepared.input.selectedRoot);
        equalRows(observedAfter, prepared.after, "Actual complete after snapshot differs from independent original install");
        await record(root, "snapshot-actual-after.json", observedAfter);
        const catalogAfter = await attachment.request({ operation: "installations" });
        await record(root, "installations-after.json", catalogAfter);
        need(catalogAfter.ok, "Completed installation catalog request failed");
        const listedAfter = catalogAfter.result.installations.find(row => row.installationId === selected.installationId);
        const expectedAfter = await json(prepared.inputs.profiles[0].expectedAfterPin.path);
        need(listedAfter && listedAfter.installedVersion.kind === "known"
          && listedAfter.installedVersion.version === prepared.q.target.version
          && listedAfter.resourcesFingerprint === expectedAfter.resourcesFingerprint
          && isDeepStrictEqual(listedAfter.resources, expectedAfter.resources), "Completed catalog does not reflect measured updated installation");
        result.actualIncrement = true;
        result.status = "ACTUAL_SERVICE_UPDATE_COMPLETED";
      } finally {
        clearTimeout(deadline);
        await record(root, "job-events.json", { subscribedBeforeCreate: true, events });
      }
    } finally {
      subscription?.close();
      await subscription?.closed;
      attachment?.close();
      if (child.exitCode === null) child.send({ kind: "stop" });
      // Exact child exit, not a PID disappearance poll.
      const force = setTimeout(() => child.kill("SIGKILL"), 10000);
      try { result.cleanup.workerExitCode = await child.exited; }
      finally { clearTimeout(force); }
      const [stdout, stderr] = await output;
      await persist(root, "worker.stdout.txt", stdout);
      await persist(root, "worker.stderr.txt", stderr);
      await record(root, "worker-diagnostics.json", diagnostics);
    }
  } catch (error) {
    result.status = "ACTUAL_SERVICE_QA_BLOCKED";
    result.error = { name: error.name, message: error.message, code: error.code ?? null, stack: error.stack };
  } finally {
    clearTimeout(timeout);
    subscription?.close(); attachment?.close();
    if (child?.exitCode === null) { child.kill("SIGKILL"); result.cleanup.workerExitCode = await child.exited; }
    if (prepared) {
      await verify(prepared.original);
      const final = await snapshot(prepared.input.selectedRoot);
      await record(root, "snapshot-final.json", final);
      result.cleanup.originalManifestUnchanged = true;
      result.cleanup.selectedInstallationUnchanged = isDeepStrictEqual(final, prepared.before);
      result.cleanup.selectedInstallationMatchesIndependentAfter = isDeepStrictEqual(final, prepared.after);
      const workerFiles = await readdir(prepared.inputs.ownerDirectory).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const file of workerFiles.filter(name => name.endsWith(".jsonl"))) {
        await persist(root, `consumer-receipts/${file}`, await readFile(join(prepared.inputs.ownerDirectory, file)));
      }
      result.cleanup.remainingWorkerSockets = workerFiles.filter(name => name.endsWith(".sock"));
      await record(root, "census-final.json", await census(prepared.q.installation.owner.prefix));
    }
    result.cleanup.ownedChildJoined = child === undefined || child.exitCode !== null;
    await rm(socketRoot, { recursive: true });
    result.cleanup.ownedSocketRootRemoved = socketRoot;
    await record(root, "result.json", result);
    console.log("PACKAGE_QA_RESULT", JSON.stringify({ family, status: result.status, actualIncrement: result.actualIncrement,
      error: result.error?.message, evidence: join(root, "result.json"), cleanup: result.cleanup }));
  }
  return result;
}

async function cleanOwnCache(root) {
  need(families.some(family => root.startsWith(join(base, `${family}-product-qa`) + "/run-")), "Not this track's evidence");
  const result = await json(join(root, "result.json")), preparation = await json(join(root, "preparation.json"));
  need(result.cleanup.ownedChildJoined, "Owned worker must be joined first");
  const before = await json(join(root, "snapshot-before.json")), final = await json(join(root, "snapshot-final.json"));
  const selected = preparation.selectedRoot;
  const created = final.filter(row => !before.some(original => original.relativePath === row.relativePath));
  need(created.length > 0 && created.every(row => row.relativePath.startsWith("home/Library/Caches/bun/") && row.sha256),
    "Changes include non-transpiler outputs; refuse cleanup");
  for (const row of created) await verify({ path: join(selected, row.relativePath), sha256: row.sha256 });
  for (const row of created) await unlink(join(selected, row.relativePath));
  const directories = new Set();
  for (const row of created) {
    for (let path = dirname(join(selected, row.relativePath)); path !== join(selected, "home"); path = dirname(path)) directories.add(path);
  }
  for (const path of [...directories].sort((a, b) => b.length - a.length)) {
    await rmdir(path).catch(error => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
  }
  const actual = await snapshot(selected);
  equalRows(actual, before, "Original snapshot not restored after removing only owned Bun cache");
  await record(root, "cleanup-transpiler-cache.json", {
    removed: created, originalPayloadTouched: false, selectedFullSnapshotEqualsBefore: true,
    actualSnapshot: await record(root, "snapshot-after-cache-cleanup.json", actual),
  });
  console.log("PACKAGE_QA_CACHE_CLEANED", result.family, root);
}
async function qualifyRun(root) {
  need(families.some(family => root.startsWith(join(base, `${family}-product-qa`) + "/run-")), "Not this track's evidence");
  const input = await json(join(root, "package-runtime.json"));
  const { qualifyPackageUpdate } = await import("../../src/adapters/package-update.ts");
  const checkedAt = Date.now();
  const result = await qualifyPackageUpdate(input.profiles[0].update, checkedAt);
  const outcome = { checkedAt, expiresAt: input.profiles[0].update.qualification.target.expiresAt,
    accepted: result.ok, ...(result.ok ? {} : { error: result.error }), installExecuted: false };
  await record(root, `direct-qualifier-${checkedAt}.json`, outcome);
  console.log("PACKAGE_QA_QUALIFIER", JSON.stringify(outcome));
}
async function discoveryRun(root) {
  need(families.some(family => root.startsWith(join(base, `${family}-product-qa`) + "/run-")), "Not this track's evidence");
  const input = await json(join(root, "package-runtime.json"));
  const profile = input.profiles[0], expected = profile.update.qualification.installation;
  const receipt = profile.sourcePins.find(row => row.path === join(root, "discovery-receipt.json"));
  need(receipt, "Measured discovery receipt absent");
  await verify(receipt);
  const { discoverExecutable } = await import("../../src/discovery.ts");
  const actual = await discoverExecutable({ executable: expected.executableRealpath, family: expected.family, provenance: [receipt] });
  const result = { expected, actual, exactIdentityMatch: actual.ok && isDeepStrictEqual(actual.value.installation, expected),
    extraActualResources: actual.ok ? actual.value.installation.resources.filter(row => !expected.resources.some(value => value.realpath === row.realpath)) : [],
    originalInstallationUnmodified: true, executableProbeRequested: false };
  const evidence = await record(root, `actual-discovery-${Date.now()}.json`, result);
  console.log("PACKAGE_QA_DISCOVERY", JSON.stringify({ evidence, matched: result.exactIdentityMatch, extraActualResources: result.extraActualResources }));
}
async function linkRun(root) {
  need(root.startsWith(join(base, "grok-product-qa") + "/run-"), "Not this track's Grok evidence");
  const profile = (await json(join(root, "package-runtime.json"))).profiles[0], q = profile.update.qualification;
  const links = [];
  for (const row of q.before.links) {
    const entry = join(q.installation.owner.prefix, row.path), literal = await readlink(entry);
    const actual = await realpath(entry), immediate = resolve(dirname(entry), row.target);
    links.push({ entry, recordedLiteral: row.target, actualLiteral: literal, actualCanonical: actual,
      immediateTarget: immediate, immediateCanonical: await realpath(immediate),
      currentGuardAccepted: literal === row.target && actual === immediate });
  }
  await record(root, "actual-multihop-link-guard.json", { links, productionSource: await pin(join(project, "src/service/package-runtime.ts")) });
  console.log("PACKAGE_QA_LINK_GUARD", JSON.stringify(links.filter(row => !row.currentGuardAccepted)));
}
async function restoreOwnCompletedCatalogFailure(root) {
  need(root.startsWith(join(base, "grok-product-qa") + "/run-"), "Not an owned Grok QA run");
  const result = await json(join(root, "result.json")), preparation = await json(join(root, "preparation.json"));
  need(result.job?.status === "completed" && result.error?.message === "Completed installation catalog request failed"
    && result.cleanup.ownedChildJoined && result.cleanup.remainingWorkerSockets.length === 0, "Not a joined catalog-only failure");
  await verify(preparation.original);
  const input = await json(preparation.original.path), completion = await json(input.originalInstallCompletion.path);
  equalRows(await snapshot(input.selectedRoot), await json(join(root, "snapshot-independent-after.json")), "Owned output changed since completion");
  const before = await json(join(root, "snapshot-before.json")), captured = completion.equivalentBefore.capturedBefore;
  equalRows(await snapshot(captured), before, "Captured original before changed");
  need(await realpath(input.selectedRoot) === input.selectedRoot, "Noncanonical owned QA scope");
  await record(root, "owned-catalog-recovery-plan.json", { reason: "Repeat the completed owned update to verify corrected post-completion catalog", source: captured, destination: input.selectedRoot });
  for (const name of ["prefix", "home"]) {
    await rm(join(input.selectedRoot, name), { recursive: true });
    await cp(join(captured, name), join(input.selectedRoot, name), { recursive: true, verbatimSymlinks: true });
  }
  equalRows(await snapshot(input.selectedRoot), before, "Owned exact before restoration failed");
  await record(root, "owned-catalog-recovery-completed.json", { originalBeforeRestored: true, historicalInputsUnchanged: true });
  console.log("PACKAGE_QA_OWNED_CATALOG_BEFORE_RESTORED", root);
}

async function restoreOwnFailedModeRun(root) {
  need(families.some(family => root.startsWith(join(base, `${family}-product-qa`) + "/run-")), "Not this track's evidence");
  const preparation = await json(join(root, "preparation.json"));
  await verify(preparation.original);
  const manifest = await json(preparation.original.path), completion = await json(manifest.originalInstallCompletion.path);
  const job = await json(join(root, "actual-job.json")), cleanup = await json(join(root, "debug-cleanup.json"));
  need(job.installTxn.state === "recovery_required" && cleanup.ownedChildJoined, "Only a joined, failed owned effect may be restored");
  const current = await snapshot(manifest.selectedRoot), recorded = await json(join(root, "snapshot-final.json"));
  equalRows(current, recorded, "Installation changed since this owned failure");
  const expectedAfter = await json(join(root, "snapshot-independent-after.json"));
  const withoutMode = rows => rows.map(({ mode, ...row }) => row);
  need(isDeepStrictEqual(withoutMode(current), withoutMode(expectedAfter)), "Failure is not limited to captured file modes");
  const originalBefore = await json(join(root, "snapshot-before.json"));
  equalRows(await snapshot(completion.equivalentBefore.capturedBefore), originalBefore, "Acquired captured-before changed");
  const prefix = manifest.qualification.installation.owner.prefix;
  need(dirname(prefix) === manifest.selectedRoot && await realpath(prefix) === prefix, "Restore destination is not the original canonical selected prefix");
  const plan = { reason: "Restore only this QA's failed update with measured umask mismatch before retrying correct calibration",
    jobId: job.jobId, source: completion.equivalentBefore.capturedBefore, destination: prefix,
    currentMatchesRecordedOwnedFailure: true, currentContentAndLiteralLinksMatchIndependentAfter: true,
    capturedBeforeMatchesOriginalReference: true, originalHistoricalInputsModified: false };
  await record(root, "owned-mode-recovery-plan.json", plan);
  await rm(prefix, { recursive: true });
  await cp(join(completion.equivalentBefore.capturedBefore, "prefix"), prefix, { recursive: true, verbatimSymlinks: true });
  const restored = await snapshot(manifest.selectedRoot);
  equalRows(restored, originalBefore, "Exact original before was not restored");
  await record(root, "snapshot-restored-original-before.json", restored);
  await record(root, "owned-mode-recovery-completed.json", { ...plan, exactOriginalBeforeRestored: true });
  console.log("PACKAGE_QA_ORIGINAL_BEFORE_RESTORED", manifest.qualification.installation.family, root);
}
async function debugQualifier(family, serviceLoad = false) {
  need(families.includes(family), "Unknown package family");
  const root = join(base, `${family}-product-qa`, `run-${Date.now()}`);
  await directory(root);
  await record(root, "debug-journal.json", {
    purpose: serviceLoad === "job" ? "Observe the unchanged real service consumer's original confined npm stderr"
      : "Observe unchanged real admission guards without running an installer",
    artifacts: ["owned Bun child", "loopback WebKit inspector", "IPC channel"],
    cleanup: "Close inspector; join or terminate exact child handle; retain requested evidence",
  });
  const socketRoot = serviceLoad ? await realpath(await mkdtemp(join(tmpdir(), "hpqd-"))) : null;
  const prepared = await prepare(family, root, socketRoot ? join(socketRoot, "w") : join(root, "unused-worker"));
  const endpoint = Promise.withResolvers(), completed = Promise.withResolvers(), loaded = Promise.withResolvers();
  const child = Bun.spawn([process.execPath, "--inspect=127.0.0.1:0", import.meta.path,
    serviceLoad === "job" ? "--job-child" : serviceLoad ? "--load-child" : "--qualifier-child"], {
    cwd: root, env: { ...prepared.q.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "debug-transpiler-cache") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    ipc(message) {
      if (message.kind === "qualification-result") completed.resolve(message);
      else if (message.kind === "load-ready") loaded.resolve(message);
    },
  });
  prepared.inputs.profiles[0].coverage.rootPids = [child.pid];
  const config = await record(root, "diagnostic-inputs.json", prepared.inputs);
  const stdout = new Response(child.stdout).text();
  let stderr = "";
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      stderr += decoder.decode(chunk, { stream: true });
      const found = /ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.exec(stderr);
      if (found) endpoint.resolve(found[0]);
    }
  })();
  void child.exited.then(code => {
    endpoint.reject(new Error(`Inspector child exited ${code}`));
    if (code !== 0) completed.reject(new Error(`Qualifier child exited ${code}`));
  });
  const timer = setTimeout(() => {
    const error = new Error("Bounded real qualifier inspector deadline");
    endpoint.reject(error); completed.reject(error); child.kill("SIGKILL");
  }, 240000);
  let socket;
  const events = [], scripts = new Map(), pending = new Map();
  let id = 0;
  const send = (method, params = {}) => {
    const request = ++id, response = Promise.withResolvers();
    pending.set(request, response);
    socket.send(JSON.stringify({ id: request, method, params }));
    return response.promise;
  };
  let observation = Promise.resolve();
  try {
    socket = new WebSocket(await endpoint.promise);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", message => {
      const data = JSON.parse(message.data);
      if (data.id) {
        const item = pending.get(data.id); pending.delete(data.id);
        if (data.error) item?.reject(new Error(JSON.stringify(data.error))); else item?.resolve(data.result);
      } else if (data.method === "Debugger.scriptParsed") scripts.set(data.params.scriptId, data.params.url);
      else if (data.method === "Debugger.paused") {
        observation = observation.then(async () => {
          const frames = data.params.callFrames.slice(0, 12).map(frame => ({
            functionName: frame.functionName, url: scripts.get(frame.location.scriptId) ?? frame.url,
            location: frame.location, callFrameId: frame.callFrameId,
          }));
          const event = { reason: data.params.reason, data: data.params.data, frames };
          if (data.params.reason === "Breakpoint" && frames[0]?.url?.endsWith("/src/install/update.ts")) {
            event.actualChildStderr = await send("Debugger.evaluateOnCallFrame", {
              callFrameId: frames[0].callFrameId, expression: 'typeof bytes === "undefined" ? null : bytes.toString("utf8")', returnByValue: true,
            });
            event.actualDispatchedCommand = await send("Debugger.evaluateOnCallFrame", {
              callFrameId: frames[0].callFrameId,
              expression: 'typeof command === "object" ? JSON.stringify(command) : null', returnByValue: true,
            });
          }
          const caller = frames.find(frame => ["payload", "fresh", "edges", "loadPackageRuntime"].includes(frame.functionName));
          if (caller) {
            event.locals = await send("Debugger.evaluateOnCallFrame", {
              callFrameId: caller.callFrameId,
              expression: `JSON.stringify({artifact:typeof artifact==="undefined"?null:{name:artifact.name,installName:artifact.installName,version:artifact.version},field:typeof field==="undefined"?null:field,key:typeof key==="undefined"?null:key,range:typeof range==="undefined"?null:range,path:typeof path==="string"?path:null,sha256:typeof sha256==="string"?sha256:null})`,
              returnByValue: true,
            });
            const source = await send("Debugger.getScriptSource", { scriptId: caller.location.scriptId });
            const lines = source.scriptSource.split("\n"), line = caller.location.lineNumber;
            event.executedSourceExcerpt = lines.slice(Math.max(0, line - 3), line + 5).join("\n");
            if (caller.functionName === "loadPackageRuntime") {
              event.actualAdmissionResults = await send("Debugger.evaluateOnCallFrame", {
                callFrameId: caller.callFrameId, returnByValue: true,
                expression: `JSON.stringify({qualified:qualified.ok,checked:(()=>{try{return checked}catch{return "not-reached"}})()})`,
              });
            }
          }
          events.push(event);
          await send("Debugger.resume");
        }).catch(error => { completed.reject(error); child.kill("SIGKILL"); });
      }
    });
    await send("Inspector.enable");
    await send("Debugger.enable");
    await send("Debugger.setBreakpointsActive", { active: true });
    await send("Debugger.setPauseOnExceptions", { state: serviceLoad === "job" ? "none" : "all" });
    child.send({ path: config.path });
    if (serviceLoad === "job") {
      const ready = await Promise.race([loaded.promise, completed.promise]);
      need(ready.kind === "load-ready", "Actual service did not load for stderr observation");
      const consumer = [...scripts].find(([, url]) => url.endsWith("/src/install/update.ts"));
      need(consumer, "Actual consumer script absent");
      const source = await send("Debugger.getScriptSource", { scriptId: consumer[0] });
      const lines = source.scriptSource.split("\n");
      const lineNumber = lines.findIndex(line => line.includes('child.stderr.on("data"')) + 1;
      need(lineNumber > 0, "Actual consumer stderr handler absent");
      await send("Debugger.setPauseOnExceptions", { state: "none" });
      await send("Debugger.setBreakpoint", { location: { scriptId: consumer[0], lineNumber, columnNumber: 0 } });
      const dispatchLine = lines.findIndex(line => line.includes("const executable = command.executable"));
      need(dispatchLine >= 0, "Actual dispatch binding absent");
      await send("Debugger.setBreakpoint", { location: { scriptId: consumer[0], lineNumber: dispatchLine, columnNumber: 0 } });
      child.send({ kind: "run-job" });
    }
    const result = await completed.promise;
    await observation;
    await record(root, "actual-qualifier-guard.json", { result, events, serviceLoad,
      productionSource: await pin(join(project, serviceLoad ? "src/service/package-runtime.ts" : "src/adapters/package-update.ts")),
      qualifierSourceModified: false, installerExecutionRequested: serviceLoad === "job" });
    console.log("PACKAGE_QA_GUARD", family, JSON.stringify(result), join(root, "actual-qualifier-guard.json"));
  } finally {
    clearTimeout(timer);
    socket?.close();
    if (child.exitCode === null) child.send({ kind: "stop" });
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await child.exited; } finally { clearTimeout(force); }
    await stderrDone;
    await persist(root, "debug.stdout.txt", await stdout);
    await persist(root, "debug.stderr.txt", stderr);
    await record(root, "debug-cleanup.json", { childExitCode: child.exitCode, ownedChildJoined: true, inspectorClosed: true });
    await record(root, "snapshot-final.json", await snapshot(prepared.input.selectedRoot));
    if (socketRoot) {
      const workerFiles = await readdir(prepared.inputs.ownerDirectory).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const name of workerFiles.filter(name => name.endsWith(".jsonl"))) {
        await persist(root, `consumer-receipts/${name}`, await readFile(join(prepared.inputs.ownerDirectory, name)));
      }
    }
    if (socketRoot) await rm(socketRoot, { recursive: true });
  }
}
async function qualifierChild(serviceLoad = false) {
  process.umask(0o077);
  const instruction = Promise.withResolvers();
  process.once("message", instruction.resolve);
  const { path } = await instruction.promise, inputs = await json(path);
  let worker, observed;
  if (serviceLoad) {
    try {
      process.env.HERDR_CLI_UPDATER_RUNTIME_CONFIG = path;
      const { serveDomainWorker } = await import("../../src/service/worker.ts");
      const environment = inputs.profiles[0].update.qualification.env;
      worker = await serveDomainWorker(inputs.ownerDirectory, undefined, { home: environment.HOME, path: environment.PATH, prefixes: [] });
      observed = { ok: true };
      if (serviceLoad === "job") {
        const scope = dirname(path), live = await census(inputs.profiles[0].coverage.prefix);
        live.owner = worker.owner;
        live.socketNamespace = await Promise.all((await readdir(inputs.ownerDirectory)).map(async name => {
          const file = join(inputs.ownerDirectory, name), info = await lstat(file);
          return { path: file, socket: info.isSocket(), uid: info.uid, mode: info.mode & 0o777 };
        }));
        need(isDeepStrictEqual(live.socketNamespace.filter(row => row.socket).map(row => row.path).sort(),
          [...inputs.profiles[0].coverage.registeredSockets].sort()), "Actual debugger socket census mismatch");
        await record(scope, "census-live.json", live);
        const trigger = Promise.withResolvers();
        process.once("message", trigger.resolve);
        process.send({ kind: "load-ready", owner: worker.owner });
        await trigger.promise;
        const { attachAuthenticatedWorker } = await import("../../src/service/client.ts");
        const client = await attachAuthenticatedWorker(inputs.ownerDirectory, 60000);
        const settled = Promise.withResolvers(), events = [];
        const subscription = await client.subscribe({ incarnation: client.incarnation, sequence: "current" }, {
          event(event) {
            events.push(event);
            const job = event.response?.result?.job;
            if (job && (["completed", "cancelled"].includes(job.status)
              || ["failed", "recovery_required"].includes(job.installTxn.state))) settled.resolve(job);
          },
          error: settled.reject,
        });
        const deadline = setTimeout(() => settled.reject(new Error("Actual debugger job deadline")), 180000);
        try {
          const root = dirname(path), expected = inputs.profiles[0].update.qualification.installation;
          for (const operation of ["installations", "check", "targets"]) {
            const response = await client.request(operation === "installations" ? { operation }
              : { operation, installationId: expected.installationId });
            await record(root, `${operation}.json`, response);
            need(response.ok, `Actual ${operation} failed`);
          }
          await record(root, "job-subscription.json", { cursor: subscription.cursor, createRequestSent: false });
          const { installationId, resourcesFingerprint, owner, installedVersion } = expected;
          const created = await client.request({ operation: "create-job", mode: "update-only",
            installation: { installationId, resourcesFingerprint, owner, installedVersion }, selectedTargets: [] });
          await record(root, "create-job.json", created);
          need(created.ok, "Actual create-job failed");
          const job = await settled.promise;
          need(job.jobId === created.result.job.jobId, "Actual debugger job identity mismatch");
          await record(root, "actual-job.json", job);
          observed = { ok: job.status === "completed", error: job.failure };
          if (observed.ok) {
            const after = await snapshot(inputs.profiles[0].coverage.root);
            equalRows(after, await json(join(root, "snapshot-independent-after.json")), "Actual debugger after differs from calibrated after");
            await record(root, "snapshot-actual-after.json", after);
            const catalog = await client.request({ operation: "installations" });
            await record(root, "installations-after.json", catalog);
            const listed = catalog.ok && catalog.result.installations.find(row => row.installationId === installationId);
            const expectedAfter = await json(inputs.profiles[0].expectedAfterPin.path);
            need(listed && isDeepStrictEqual(listed.installedVersion, expectedAfter.installedVersion)
              && listed.resourcesFingerprint === expectedAfter.resourcesFingerprint, "Actual completed catalog mismatch");
            await record(root, "actual-increment.json", { family: expected.family, job, actualIncrement: true,
              calibratedAfterSnapshotMatched: true, actualCatalogMatched: true, umask: 0o077 });
          }
        } finally {
          clearTimeout(deadline);
          await record(dirname(path), "job-events.json", { subscribedBeforeCreate: true, events });
          subscription.close(); await subscription.closed; client.close();
        }
      }
    } catch (error) { observed = { ok: false, error: { name: error.name, message: error.message } }; }
  } else {
    const { qualifyPackageUpdate } = await import("../../src/adapters/package-update.ts");
    observed = await qualifyPackageUpdate(inputs.profiles[0].update, Date.now());
  }
  const stop = Promise.withResolvers();
  process.once("message", stop.resolve);
  process.send({ kind: "qualification-result", accepted: observed.ok, error: observed.ok ? null : observed.error });
  await stop.promise;
  await worker?.stop();
  process.disconnect?.();
}
async function lockedActual(family, loadOnly = false) {
  const lock = join(base, `.${family}-preparing`);
  await mkdir(lock, { mode: 0o700 });
  try { return await actual(family, loadOnly); }
  finally { await rm(lock, { recursive: true }); }
}
if (process.argv[2] === "--worker") await workerMain();
else if (process.argv[2] === "--cleanup-run") await cleanOwnCache(process.argv[3]);
else if (process.argv[2] === "--qualify-run") await qualifyRun(process.argv[3]);
else if (process.argv[2] === "--discovery-run") await discoveryRun(process.argv[3]);
else if (process.argv[2] === "--link-run") await linkRun(process.argv[3]);
else if (process.argv[2] === "--restore-own-mode-failure") await restoreOwnFailedModeRun(process.argv[3]);
else if (process.argv[2] === "--restore-own-catalog-failure") await restoreOwnCompletedCatalogFailure(process.argv[3]);
else if (process.argv[2] === "--debug-qualify") await debugQualifier(process.argv[3]);
else if (process.argv[2] === "--qualifier-child") await qualifierChild();
else if (process.argv[2] === "--debug-load") await debugQualifier(process.argv[3], true);
else if (process.argv[2] === "--load-child") await qualifierChild(true);
else if (process.argv[2] === "--debug-job") await debugQualifier(process.argv[3], "job");
else if (process.argv[2] === "--job-child") await qualifierChild("job");
else if (process.argv[2] === "--load-only") {
  const selected = process.argv.slice(3);
  need(selected.length > 0 && selected.every(family => families.includes(family)), "Unknown package families");
  for (const family of selected) {
    const result = await lockedActual(family, true);
    if (result.status !== "ACTUAL_SERVICE_LOAD_CHECK_VERIFIED_NOT_INSTALLED") process.exitCode = 1;
  }
}
else {
  const selected = process.argv.slice(2);
  need(selected.length > 0 && selected.every(family => families.includes(family)), "Pass one or more of claude codex omp grok");
  for (const family of selected) {
    const result = await lockedActual(family);
    if (!result.actualIncrement) process.exitCode = 1;
  }
}
