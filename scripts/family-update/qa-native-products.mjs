import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

// Actual product QA only. Retained vendor sources are read, never modified.
// All native execution goes through the official static issuer and consumer.
const project = await realpath(join(import.meta.dirname, "../.."));
const evidence = join(project, ".omo/evidence/herdr-cli-updater");
const retained = join(evidence, "six-families/native-update/cursor-agy-current");
const destination = join(evidence, "six-families/native-product-qa");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const json = async path => JSON.parse(await readFile(path, "utf8"));
async function digest(path) {
  const before = await lstat(path, { bigint: true });
  need(before.isFile() && await realpath(path) === path, `Noncanonical file: ${path}`);
  const value = createHash("sha256");
  for await (const bytes of createReadStream(path)) value.update(bytes);
  const after = await lstat(path, { bigint: true });
  need(["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => before[key] === after[key]), `Changed file: ${path}`);
  return value.digest("hex");
}
const pin = async path => ({ path, sha256: await digest(path) });
async function dir(path, mode = 0o700) {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode);
}
async function persist(root, name, body, mode = 0o600) {
  const path = join(root, name);
  need(path.startsWith(root + "/"), "Evidence destination escaped");
  await dir(dirname(path));
  await writeFile(path, body, { flag: "wx", mode });
  return pin(path);
}
const record = (root, name, value) => persist(root, name, JSON.stringify(value, null, 2) + "\n");
async function snapshot(root) {
  const entries = [];
  async function visit(path, local) {
    const info = await lstat(path), mode = info.mode & 0o777;
    if (info.isDirectory()) {
      entries.push({ path: local, type: "directory", mode });
      for (const name of await readdir(path)) await visit(join(path, name), local === "." ? name : `${local}/${name}`);
    } else if (info.isSymbolicLink()) entries.push({ path: local, type: "symlink", mode, target: await readlink(path) });
    else {
      need(info.isFile(), `Unexpected native entry: ${path}`);
      entries.push({ path: local, type: "file", mode, bytes: info.size, sha256: await digest(path) });
    }
  }
  await visit(root, ".");
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
function resource(path, sha256) {
  return { realpath: path, resourceId: `resource:${hash(path)}`, fingerprint: `sha256:${sha256}` };
}
function identity(family, executable, channel, owner, version, resources) {
  resources.sort((a, b) => a.realpath.localeCompare(b.realpath));
  return { family, channel, executableRealpath: executable, installationId: `install:${hash(executable)}`, owner,
    installedVersion: { kind: "known", version }, resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
}
async function command(argv, timeoutMs = 10000) {
  const child = Bun.spawn(argv, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    return { argv, pid: child.pid, stdout, stderr, exitCode, signal: child.signalCode };
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}
async function census(root) {
  return { observedAt: Date.now(),
    processes: await command(["/bin/ps", "-axo", "pid=,ppid=,uid=,lstart=,command="]),
    consumers: await command(["/usr/sbin/lsof", "-n", "-P", "-Fpn", "+D", root]) };
}
async function acquire(root, name, url, body) {
  const startedAt = Date.now(), method = body === undefined ? "GET" : "POST";
  const response = await fetch(url, { method, ...(body === undefined ? {} : {
    body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30000) });
  need(response.status === 200 && !response.redirected, `Official acquisition ${response.status}: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  need(bytes.length < 1024 * 1024, "Metadata exceeded bound");
  const checkedAt = Date.now(), value = JSON.parse(new TextDecoder().decode(bytes));
  await record(root, `public/${name}-http.json`, { method, url, startedAt, checkedAt, status: response.status,
    credentials: "omit", redirect: "error", request: body ?? null, response: value,
    raw: await persist(root, `public/${name}-raw.json`, bytes) });
  return { method, url, checkedAt, value };
}
async function prepareAgy(root, scope) {
  const nativeRoot = join(scope, "state"), home = join(nativeRoot, "home"), executable = join(nativeRoot, "bin/agy");
  await dir(nativeRoot); await dir(home); await dir(join(nativeRoot, "bin"), 0o755); await dir(join(home, "tmp"), 0o755);
  const original = join(retained, "agy/update-success-r1/acquired/antigravity");
  const source = await pin(original);
  need(source.sha256 === "d15693410c904242c1c3423a579f60a81e018444bb51fbccc6505f988b62a91d", "AGY original differs");
  await copyFile(original, executable, constants.COPYFILE_FICLONE); await chmod(executable, 0o755);
  const { AGY_INSTALLER_SHA256, AGY_MANIFEST_CHANNEL } = await import("../../src/adapters/agy.ts");
  const owner = { kind: "native", prefix: nativeRoot, installerDigest: `sha256:${AGY_INSTALLER_SHA256}` };
  const installed = identity("agy", executable, AGY_MANIFEST_CHANNEL, owner, "1.2.15", [resource(executable, source.sha256)]);
  const targetFile = join(retained, "agy/package/antigravity"), targetInfo = await lstat(targetFile);
  const expectedFiles = [{ path: "antigravity", sha256: await digest(targetFile), bytes: targetInfo.size, mode: targetInfo.mode & 0o777 }];
  const historical = join(retained, "agy/update-success-r1/state");
  const historicalAfter = await snapshot(historical);
  await record(root, "independent-historical-after.json", { root: historical, entries: historicalAfter });
  const expectedEntries = historicalAfter.map(row => ({ ...row,
    path: /^bin\/agy\.[1-9][0-9]*\.old$/.test(row.path) ? "bin/agy.<timestamp>.old" : row.path,
    mode: row.path === "." || row.path === "home" ? 0o700 : row.mode })).sort((a, b) => a.path.localeCompare(b.path));
  need(expectedEntries.find(row => row.path === "bin/agy").sha256 === expectedFiles[0].sha256, "Historical target differs from acquired archive member");
  const after = identity("agy", executable, AGY_MANIFEST_CHANNEL, owner, "1.2.16", [
    resource(executable, expectedFiles[0].sha256), resource(nativeRoot, hash(JSON.stringify(expectedEntries))),
    ...["home/.gemini/antigravity-cli/updater/update.lock", "home/.gemini/antigravity-cli/updater/update_status.json"]
      .map(path => resource(join(nativeRoot, path), expectedEntries.find(row => row.path === path).sha256)) ]);
  const env = { HOME: home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin",
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share") };
  const installer = await pin(join(evidence, "task-5/families/agy/boundedsource/install.sh"));
  need(installer.sha256 === AGY_INSTALLER_SHA256, "AGY installer provenance differs");
  const archive = await pin(join(retained, "agy/package.tar.gz"));
  const acquired = await acquire(root, "agy-latest", AGY_MANIFEST_CHANNEL);
  need(acquired.value.version === "1.2.16", `Official latest moved to ${acquired.value.version}; acquire independent target before dispatch`);
  const manifest = await record(root, "manifest.json", acquired.value);
  const release = await record(root, "release.json", { method: "GET", url: AGY_MANIFEST_CHANNEL, status: 200,
    checkedAt: acquired.checkedAt, response: acquired.value });
  const q = { installation: installed, root: nativeRoot, home, env, source, installer,
    dependencies: [await pin("/usr/bin/sandbox-exec")],
    target: { selection: "official-latest", version: acquired.value.version, channel: AGY_MANIFEST_CHANNEL,
      manifest, release, archive, expectedFiles, checkedAt: acquired.checkedAt, expiresAt: acquired.checkedAt + 300000 } };
  return { q, after, nativeRoot, expectedEntries, historicalPins: [source, installer, archive, await pin(targetFile)] };
}
async function prepareCursor(root, scope) {
  const nativeRoot = join(scope, "home"), home = nativeRoot, prefix = join(home, ".local/share/cursor-agent");
  const source = join(prefix, "versions/2026.01.23-916f423"), oldArchiveUrl =
    "https://downloads.cursor.com/lab/2026.01.23-916f423/darwin/arm64/agent-cli-package.tar.gz";
  await dir(home);
  for (const path of [source, join(home, ".local/bin"), ...["config", "data", "compile-cache", "tmp"].map(name => join(home, name))])
    await dir(path, 0o755);
  const originalRoot = join(retained, "cursor/package/dist-package");
  const originalExecutable = join(originalRoot, "cursor-agent");
  const targetRows = await snapshot(originalRoot);
  const expectedFiles = targetRows.filter(row => row.type === "file")
    .map(({ path, sha256, bytes, mode }) => ({ path, sha256, bytes, mode }));
  need(expectedFiles.length === 447, "Current original closure differs");
  const acquiredBefore = (await readdir(destination)).filter(name => /^cursor-\d+$/.test(name)).sort().reverse();
  let retainedOld;
  for (const name of acquiredBefore) {
    const candidate = join(destination, name, "acquired/cursor-old.tar.gz");
    if (await lstat(candidate).catch(error => { if (error.code === "ENOENT") return null; throw error; })) {
      retainedOld = candidate; break;
    }
  }
  let oldArchiveBytes;
  if (retainedOld) oldArchiveBytes = await readFile(retainedOld);
  else {
    const oldArchiveResponse = await fetch(oldArchiveUrl, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(120000) });
    need(oldArchiveResponse.status === 200, "Official old Cursor archive unavailable");
    oldArchiveBytes = new Uint8Array(await oldArchiveResponse.arrayBuffer());
  }
  need(oldArchiveBytes.length === 50546193 && hash(oldArchiveBytes) === "bd33acce8516e0b5941e52b0c1ec50447d54cb909cbcddde97acb58d17c109e3",
    "Official old Cursor archive differs from retained source receipt");
  const oldArchive = await persist(root, "acquired/cursor-old.tar.gz", oldArchiveBytes);
  await record(root, "acquired/old-source.json", { officialUrl: oldArchiveUrl, reusedImmutableArchive: retainedOld ?? null, archive: oldArchive });
  const extractRoot = join(root, "acquired/old");
  await dir(extractRoot);
  const extracted = await command(["/usr/bin/tar", "-xzf", oldArchive.path, "-C", extractRoot], 120000);
  await record(root, "acquired/old-extraction.json", extracted);
  need(extracted.exitCode === 0, "Old original extraction failed");
  const oldRoot = join(extractRoot, "dist-package"), oldRows = await snapshot(oldRoot);
  const beforeFiles = oldRows.filter(row => row.type === "file")
    .map(({ path, sha256, bytes, mode }) => ({ path, sha256, bytes, mode }));
  need(beforeFiles.length === 349, "Old original closure differs");
  const beforeDirectories = oldRows.filter(row => row.type === "directory" && row.path !== "."
    && !oldRows.some(child => child.path.startsWith(row.path + "/"))).map(row => row.path);
  await cp(oldRoot, source, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const executable = join(source, "cursor-agent");
  for (const alias of ["agent", "cursor-agent"]) await symlink(executable, join(home, ".local/bin", alias));
  const configSource = join(retained, "probe-home/config/cli-config.json"), config = await readFile(configSource);
  need(hash(config) === "6bebcca150b22dd97e384d296ce1061a1710659fe9ce9eeb4e9c559c4c412c0c", "Isolated source config differs");
  await writeFile(join(home, "config/cli-config.json"), config, { flag: "wx", mode: 0o644 });
  const beforeInstaller = await pin(join(evidence, "task-5/families/cursor/boundedsource/install.sh"));
  const owner = { kind: "native", prefix: home, installerDigest: `sha256:${beforeInstaller.sha256}` };
  const installed = identity("cursor", executable, "prod", owner, "2026.01.23-916f423",
    beforeFiles.map(file => resource(join(source, file.path), file.sha256)));
  const afterRoot = join(prefix, "versions/2026.10.01-e373342");
  const after = identity("cursor", join(afterRoot, "cursor-agent"), "prod", owner, "2026.10.01-e373342",
    expectedFiles.map(file => resource(join(afterRoot, file.path), file.sha256)));
  const archivePath = join(root, "supply/darwin/arm64/agent-cli-package.tar.gz");
  await dir(dirname(archivePath));
  await copyFile(join(retained, "cursor/package.tar.gz"), archivePath, constants.COPYFILE_FICLONE);
  const archive = await pin(archivePath), manifest = await record(root, "manifest.json", expectedFiles);
  const env = { HOME: home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin", AGENT_CLI_CREDENTIAL_STORE: "file",
    CURSOR_CONFIG_DIR: join(home, "config"), CURSOR_DATA_DIR: join(home, "data"), NODE_COMPILE_CACHE: join(home, "compile-cache") };
  // This is the independently acquired CURRENT original's effective isolated
  // source input, not a claim about the operating or old installed CLI channel.
  // Missing channel maps to prod in this exact original; the replacement env
  // supplies neither AGENT_CLI_UPDATE_CHECK_URL nor ambient configuration.
  const updateModule = join(originalRoot, "8078.index.js"), originalCode = await readFile(updateModule, "utf8");
  const defaultRule = 'return"prod-stable-internal"===e?"prod":e??"prod"';
  need(originalCode.includes(defaultRule) && !Object.hasOwn(JSON.parse(config.toString()), "channel"),
    "CURSOR_EFFECTIVE_PROD_INPUT_UNCONFIRMED");
  await record(root, "cursor-channel-source.json", { source: await pin(updateModule), config: await pin(configSource),
    exactRule: defaultRule, effectiveOriginalSourceChannel: "prod", originalExecutable, environmentReplacement: env,
    operatingInstallationChannelInspected: false, selectedBeforeChannelIsolated: true,
    downloadLaneNotUsedAsChannel: true, beforePayload: oldArchive });
  const acquired = await acquire(root, "cursor-prod", "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl",
    { channel: "prod" });
  need(acquired.value.version === "2026.10.01-e373342"
    && acquired.value.url === "https://downloads.cursor.com/lab/2026.10.01-e373342/", "Current original target moved");
  const release = await record(root, "release.json", { method: "POST", url: acquired.url, request: { channel: "prod" },
    status: 200, response: acquired.value });
  const q = { installation: installed, originalExecutable, beforeFiles, beforeDirectories, beforeInstaller, home, env,
    manifest, expectedFiles,
    dependencies: await Promise.all(["/bin/bash", "/bin/realpath", "/bin/sh", "/usr/bin/basename", "/usr/bin/bsdtar",
      "/usr/bin/curl", "/usr/bin/dirname", "/usr/bin/env", "/usr/bin/readlink", "/usr/bin/sandbox-exec"].map(pin)),
    target: { version: acquired.value.version, channel: "prod", archive, release,
      checkedAt: acquired.checkedAt, expiresAt: acquired.checkedAt + 300000 } };
  return { q, after, nativeRoot, targetRows, source,
    historicalPins: [beforeInstaller, await pin(configSource), await pin(updateModule), await pin(join(retained, "cursor/package.tar.gz"))] };
}
async function prepare(family, root, scope) {
  const prepared = family === "agy" ? await prepareAgy(root, scope) : await prepareCursor(root, scope);
  const { q } = prepared, before = await snapshot(prepared.nativeRoot);
  await record(root, "snapshot-before.json", before);
  const expectedAfterPin = await record(root, "expected-after.json", prepared.after);
  const receipt = await record(root, "qualification.json", q);
  const provenance = await record(root, "provenance.json", { family, executable: q.installation.executableRealpath,
    channel: q.installation.channel, owner: q.installation.owner, packageManifest: null,
    resources: q.installation.resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })) });
  const update = { qualification: q, receipt };
  const api = family === "agy" ? await import("../../src/adapters/agy-update.ts") : await import("../../src/adapters/cursor-update.ts");
  const qualified = await (family === "agy" ? api.qualifyAgyUpdate : api.qualifyCursorUpdate)(update, Date.now());
  const issued = qualified.ok ? (family === "agy" ? api.createAgyUpdateSpec : api.createCursorUpdateSpec)(qualified.value, "update-only", Date.now()) : qualified;
  const qualification = { qualified: qualified.ok, issued: issued.ok,
    independentAfterMatches: issued.ok && isDeepStrictEqual(issued.value.expectedAfter, prepared.after),
    error: issued.ok ? null : issued.error, nativeExecuted: false };
  await record(root, "qualifier.json", qualification);
  console.log("NATIVE_QA_QUALIFIER", family, JSON.stringify(qualification), root);
  need(qualification.qualified && qualification.issued && qualification.independentAfterMatches, "Actual-source qualifier or independent after mismatch");
  const workerDirectory = join(scope, "worker");
  const inputs = { schemaVersion: 1, profile: "qualified-native-update-only-v1", ownerDirectory: workerDirectory,
    profiles: [{ family, update, provenance, sourcePins: prepared.historicalPins, expectedAfterPin,
      coverage: { root: scope, socketDirectory: workerDirectory,
        registeredSockets: [join(workerDirectory, "service.sock"), join(workerDirectory, "control.sock")], rootPids: [] } }] };
  await record(root, "preparation.json", { family, nativeRoot: prepared.nativeRoot, workerDirectory, environment: q.env,
    independentAfter: expectedAfterPin, historicalPins: prepared.historicalPins, beforeRootCreatedByThisRun: true,
    targetSelection: family === "agy" ? "official-latest; drift requires recovery, not pinned prevention" : "fixed original install",
    sourceBinaries: [{ path: q.installation.executableRealpath, positive: true, executedForDiscovery: false }] });
  return { ...prepared, before, inputs };
}
async function workerMain() {
  const incoming = Promise.withResolvers();
  process.once("message", incoming.resolve);
  const timer = setTimeout(() => incoming.reject(new Error("configuration IPC timeout")), 30000);
  let worker;
  try {
    const { configurationPath, workerDirectory, home, path } = await incoming.promise;
    clearTimeout(timer);
    process.env.HERDR_CLI_UPDATER_RUNTIME_CONFIG = configurationPath;
    const { serveDomainWorker } = await import("../../src/service/worker.ts");
    worker = await serveDomainWorker(workerDirectory, undefined, { home, path, prefixes: [] });
    process.send({ kind: "ready", owner: worker.owner });
    process.once("message", message => { if (message.kind === "stop") void worker.stop(); });
    await worker.closed;
  } catch (error) {
    process.send({ kind: "failed", error: { message: error.message, reason: error.reason, stack: error.stack } });
    process.exitCode = 1;
  } finally { clearTimeout(timer); await worker?.stop(); process.disconnect?.(); }
}
async function actual(family, qualifierOnly) {
  const root = join(destination, `${family}-${Date.now()}`);
  await dir(root);
  // Unix socket paths must fit sockaddr_un. This private, short-lived scope is
  // owned by this run, recorded before use and removed only after worker join.
  const scope = await realpath(await mkdtemp(join(tmpdir(), "hnq-")));
  await chmod(scope, 0o700);
  await record(root, "owned-scope.json", { scope, family, ownerPid: process.pid });
  const result = { family, root, scope, status: "PREPARING", actualIncrement: false, cleanup: {} };
  let prepared, child, subscription, attachment, output, readyTimer;
  try {
    prepared = await prepare(family, root, scope);
    if (qualifierOnly) { result.status = "ACTUAL_SOURCES_QUALIFIED_ONLY"; return result; }
    await record(root, "census-before.json", await census(prepared.nativeRoot));
    const ready = Promise.withResolvers();
    // An isolated worker HOME prevents Bun's own cache from contaminating the
    // exact native write inventory; the static installer gets q.env unchanged.
    const workerHome = join(scope, "worker-home");
    await dir(workerHome);
    const env = { HOME: workerHome, TMPDIR: scope, PATH: "/usr/bin:/bin",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(scope, "transpiler-cache") };
    child = Bun.spawn([process.execPath, import.meta.path, "--worker"], { cwd: scope, env,
      stdin: "ignore", stdout: "pipe", stderr: "pipe", ipc(message) {
        if (message.kind === "ready") ready.resolve(message);
        else if (message.kind === "failed") ready.reject(Object.assign(new Error(message.error.message), message.error));
      } });
    output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    void child.exited.then(code => ready.reject(new Error(`Worker exited before readiness: ${code}`)));
    readyTimer = setTimeout(() => ready.reject(new Error("Worker readiness deadline")), 120000);
    prepared.inputs.profiles[0].coverage.rootPids = [child.pid];
    const { configurePluginRuntime } = await import("../../src/service/plugin-runtime.ts");
    const configurationPath = join(root, "native-runtime.json");
    configurePluginRuntime(configurationPath, prepared.inputs);
    await record(root, "worker-launch.json", { pid: child.pid, environment: env, configuration: await pin(configurationPath),
      nativeEnvironment: prepared.q.env, registeredSockets: prepared.inputs.profiles[0].coverage.registeredSockets });
    child.send({ configurationPath, workerDirectory: prepared.inputs.ownerDirectory,
      home: workerHome, path: "/usr/bin:/bin" });
    const loaded = await ready.promise;
    clearTimeout(readyTimer);
    await record(root, "service-loaded.json", loaded);
    const { attachAuthenticatedWorker } = await import("../../src/service/client.ts");
    attachment = await attachAuthenticatedWorker(prepared.inputs.ownerDirectory, 30000);
    const request = async body => {
      const response = await attachment.request(body);
      await record(root, `${body.operation}.json`, response);
      need(response.ok, `${body.operation}: ${response.error?.code}`);
      return response.result;
    };
    const installations = await request({ operation: "installations" });
    const selected = installations.installations.find(row => row.installationId === prepared.q.installation.installationId);
    need(selected && selected.resourcesFingerprint === prepared.q.installation.resourcesFingerprint, "Actual catalog selection differs");
    const checked = await request({ operation: "check", installationId: selected.installationId });
    need(checked.result.kind === "update-available" && checked.result.availableVersion === prepared.q.target.version, "Live check target differs");
    const targets = await request({ operation: "targets", installationId: selected.installationId });
    need(targets.targets.length === 0, "Unexpected operating runtime target");
    const settled = Promise.withResolvers(), events = [];
    subscription = await attachment.subscribe({ incarnation: attachment.incarnation, sequence: "current" }, {
      event(event) {
        events.push(event);
        const job = event.response?.result?.job;
        // A durable in-flight intent has an uncertain receipt, so viewJob
        // deliberately projects recovery_required even while install is updating.
        // Only the actual transaction's terminal state ends this subscription.
        if (job && (["completed", "failed", "cancelled"].includes(job.status)
          || job.installTxn.state === "recovery_required")) settled.resolve(job);
      }, error: settled.reject });
    const deadline = setTimeout(() => settled.reject(new Error("Exact terminal job event deadline")), 240000);
    try {
      const { installationId, resourcesFingerprint, owner, installedVersion } = selected;
      const created = await request({ operation: "create-job", mode: "update-only",
        installation: { installationId, resourcesFingerprint, owner, installedVersion }, selectedTargets: [] });
      const job = await settled.promise;
      need(job.jobId === created.job.jobId, "Terminal event job differs");
      result.job = job;
      await record(root, "job-events.json", { subscribedBeforeCreate: true, events });
      const final = await snapshot(prepared.nativeRoot);
      await record(root, "snapshot-actual-after.json", final);
      if (family === "agy") {
        const normalized = final.map(row => ({ ...row,
          path: /^bin\/agy\.[1-9][0-9]*\.old$/.test(row.path) ? "bin/agy.<timestamp>.old" : row.path }))
          .sort((a, b) => a.path.localeCompare(b.path));
        result.independentWriteSetMatches = isDeepStrictEqual(normalized, prepared.expectedEntries);
      } else {
        const targetPrefix = ".local/share/cursor-agent/versions/2026.10.01-e373342/";
        const actualFiles = final.filter(row => row.type === "file" && row.path.startsWith(targetPrefix))
          .map(row => ({ ...row, path: row.path.slice(targetPrefix.length) }));
        result.independentTargetFilesMatch = isDeepStrictEqual(actualFiles, prepared.targetRows.filter(row => row.type === "file"));
        result.aliasesMatch = ["agent", "cursor-agent"].every(alias =>
          final.find(row => row.path === `.local/bin/${alias}`)?.target === prepared.after.executableRealpath);
        result.independentWriteSetMatches = result.independentTargetFilesMatch && result.aliasesMatch;
      }
      need(job.status === "completed" && job.installTxn.state === "succeeded", `Actual terminal: ${job.status}`);
      need(result.independentWriteSetMatches, "Independent native write set differs");
      result.actualIncrement = true;
      result.status = "ACTUAL_SERVICE_UPDATE_COMPLETED";
    } finally { clearTimeout(deadline); }
  } catch (error) {
    result.status = "ACTUAL_SERVICE_QA_BLOCKED";
    result.error = { message: error.message, reason: error.reason ?? null, stack: error.stack };
  } finally {
    clearTimeout(readyTimer);
    subscription?.close(); await subscription?.closed;
    attachment?.close();
    if (child?.exitCode === null) {
      child.send({ kind: "stop" });
      const force = setTimeout(() => child.kill("SIGKILL"), 10000);
      try { result.cleanup.workerExitCode = await child.exited; } finally { clearTimeout(force); }
    } else if (child) result.cleanup.workerExitCode = child.exitCode;
    if (output) {
      const [stdout, stderr] = await output;
      await persist(root, "worker.stdout.txt", stdout); await persist(root, "worker.stderr.txt", stderr);
    }
    if (prepared) {
      for (const reference of prepared.historicalPins) need(await digest(reference.path) === reference.sha256, "Historical input changed");
      result.cleanup.historicalPinsUnchanged = true;
      const final = await snapshot(prepared.nativeRoot);
      await record(root, "snapshot-final.json", final);
      result.cleanup.beforeUnchanged = isDeepStrictEqual(final, prepared.before);
      const names = await readdir(prepared.inputs.ownerDirectory).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (names.length) await cp(prepared.inputs.ownerDirectory, join(root, "worker-records"), { recursive: true,
        filter: async path => !(await lstat(path)).isSocket() });
      result.cleanup.remainingWorkerSockets = names.filter(name => name.endsWith(".sock"));
      const jobDirectory = prepared.inputs.ownerDirectory + ".jobs";
      if (await lstat(jobDirectory).catch(error => { if (error.code === "ENOENT") return null; throw error; }))
        await cp(jobDirectory, join(root, "job-store"), { recursive: true });
      const { Database } = await import("bun:sqlite");
      for (const [label, file, tables] of [
        ["queue", join(root, "worker-records/mutations/queue.sqlite"), ["entries", "requests"]],
        ["jobs", join(root, "job-store/jobs.sqlite"), ["jobs", "intents", "writer"]],
      ]) {
        if (!(await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; }))) continue;
        const db = new Database(file, { readonly: true });
        try {
          const rows = Object.fromEntries(tables.map(table => [table, db.query(`SELECT * FROM ${table}`).all()]));
          await record(root, `${label}-durable-rows.json`, rows);
        } finally { db.close(); }
      }
      const receipts = [];
      for (const name of names.filter(name => name.endsWith(".jsonl")))
        receipts.push(...(await readFile(join(root, "worker-records", name), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse));
      result.cleanup.receiptKinds = receipts.map(row => row.kind);
      result.cleanup.nativeLaunchCount = receipts.filter(row => row.kind === "launched").length;
      result.cleanup.originalCleanupObservedCount = receipts.filter(row => row.kind === "cleanup-observed").length;
      result.cleanup.originalCleanupJoinedCount = receipts.filter(row => row.kind === "cleanup-exit").length;
    }
    const finalCensus = await census(scope);
    await record(root, "census-final.json", finalCensus);
    result.cleanup.remainingOwnedConsumerPids = [...new Set(finalCensus.consumers.stdout.split("\n")
      .filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
    result.cleanup.workerJoined = child === undefined || child.exitCode !== null;
    if (result.cleanup.remainingOwnedConsumerPids.length === 0) {
      await rm(scope, { recursive: true });
      result.cleanup.scopeRemoved = true;
    } else result.cleanup.scopeRemoved = false;
    await record(root, "result.json", result);
    console.log("NATIVE_QA_RESULT", JSON.stringify(result));
  }
  return result;
}
if (process.argv[2] === "--worker") await workerMain();
else {
  const family = process.argv[2], qualifierOnly = process.argv.includes("--qualify-only");
  need(["cursor", "agy"].includes(family), "Pass cursor or agy, optionally --qualify-only");
  const result = await actual(family, qualifierOnly);
  if (!result.actualIncrement && result.status !== "ACTUAL_SOURCES_QUALIFIED_ONLY") process.exitCode = 1;
}
