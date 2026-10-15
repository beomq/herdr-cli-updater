import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, realpathSync, readdirSync, lstatSync, existsSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { preparedNativeRecipe } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/normalize.mjs";
import { installedProfile } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/bootstrap.mjs";
import { targetArtifacts } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/issued-inputs.mjs";
import { coreRequest } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/run.mjs";
import { CoreOperationsClient } from "../src/core/client.ts";
import { preparePluginRuntime } from "../src/service/plugin-runtime.ts";
import { discoverWorker, stopWorker } from "../src/service/worker.ts";
import { attachAuthenticatedWorker } from "../src/service/client.ts";

const root = "/Users/beomseok/.local/share/herdr-cli-updater/operating-native";
const prefix = join(root, process.env.OPERATING_NATIVE_PREFIX_NAME ?? "prefix"), evidence = join(root, "evidence");
const exec = join(import.meta.dirname, "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution");
const acquired = join(import.meta.dirname, "../.omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/inputs");
process.env.ONE_FAMILY_TARGET_RUNTIME = "/Users/beomseok/.local/share/herdr-cli-updater/worker-preparations/omo-mJsivd/omo-runtime.json";
process.env.ONE_FAMILY_BEFORE_ACQUISITION = join(acquired, "acquisition.json");
process.env.ONE_FAMILY_BEFORE_ALIASES = join(acquired, "alias-closure.json");
const recipe = preparedNativeRecipe(process.env.OPERATING_NATIVE_PREPARATION ?? "/private/tmp/herdr-session-restart-native-519-r3/preparation.json");
const installation = JSON.parse(readFileSync(join(evidence, "installation.json"), "utf8"));
const runtime = pinRuntime();
function pinRuntime() {
  const path = realpathSync("/opt/homebrew/bin/bun");
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}
Object.assign(installation.environment, {
  HERDR_NATIVE_SENPI_ROOT: join(prefix, "install/global/node_modules/@code-yeongyu/senpi"),
  HERDR_NATIVE_OMO_PLUGIN: join(prefix, "install/global/node_modules/omo-ai/plugin"),
  OMO_RUNTIME: "bun", SENPI_RUNTIME: "bun", TERM: "xterm-256color", SHELL: "/bin/zsh",
  HERDR_SOCKET: "/Users/beomseok/.config/herdr/herdr.sock",
  OMO_CODING_AGENT_DIR: "/Users/beomseok/.omo/agent",
  SENPI_CODING_AGENT_DIR: "/Users/beomseok/.omo/agent",
  PI_CODING_AGENT_DIR: "/Users/beomseok/.omo/agent",
});
const hash = value => createHash("sha256").update(value).digest("hex");
const pin = path => ({ path: realpathSync(path), sha256: hash(readFileSync(path)) });
const save = (name, value) => { const path = join(evidence, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return pin(path); };
const socket = "/Users/beomseok/.config/herdr/herdr.sock", cwd = "/Users/beomseok/Desktop/portfolio";
const operationsRoot = join("/Users/beomseok/.config/herdr", `updater-operations-${hash(socket)}`);
const profiles = join(operationsRoot, "profiles");
mkdirSync(profiles, { recursive: true, mode: 0o700 });
const core = await CoreOperationsClient.discover(socket, AbortSignal.timeout(10000));
const sessions = join(root, "sessions");
mkdirSync(sessions, { mode: 0o700, recursive: true });
const { SessionManager } = await import(pathToFileURL(join(prefix, "install/global/node_modules/@code-yeongyu/senpi/dist/core/session-manager.js")));
const profileName = process.env.OPERATING_NATIVE_PROFILE ?? "operating-omo-20261006-r4";
const savedProfile = existsSync(join(profiles, `${profileName}.json`))
  ? JSON.parse(readFileSync(join(profiles, `${profileName}.json`), "utf8")) : null;
const sessionManager = savedProfile ? null : SessionManager.create(cwd, sessions);
sessionManager?.appendMessage({ role: "user", content: "운영 native 연결 확인용 새 대화입니다.", timestamp: Date.now() });
const session = savedProfile ? { file: savedProfile.session_path, fullId: savedProfile.full_session_id, cwd }
  : { file: realpathSync(sessionManager.getSessionFile()), fullId: sessionManager.getSessionId(), cwd };
const options = ["--thinking", "off", "--omo-senpi-onboarding-disabled", "--tools", "bash"];
const semantic = ["--extension", join(prefix, "install/global/node_modules/omo-ai/plugin"), "--offline", "--session", session.file, ...options];
const workspaceRecord = `${profileName}-workspace.json`;
const workspace = existsSync(join(evidence, workspaceRecord)) ? JSON.parse(readFileSync(join(evidence, workspaceRecord), "utf8"))
  : await coreRequest(socket, "workspace.create", { cwd, label: "OmO 운영 native", focus: false }, AbortSignal.timeout(10000));
save(workspaceRecord, workspace);
const attestation = Bun.spawn([runtime.path, join(exec, "options.mjs"), prefix, cwd, session.file, ...semantic],
  { cwd, env: installation.environment, stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, exit] = await Promise.all([new Response(attestation.stdout).text(), new Response(attestation.stderr).text(), attestation.exited]);
if (exit !== 0) throw new Error(`Original options producer failed: ${stderr}`);
const profile = installedProfile({ paths: { prefix } }, recipe, recipe.sourceBinding,
  { manager: runtime, env: installation.environment }, session, options, JSON.parse(stdout));
if (!savedProfile) writeFileSync(join(profiles, `${profileName}.json`), JSON.stringify(profile), { flag: "wx", mode: 0o600 });
const pane = workspace.root_pane.pane_id;
if (process.env.OPERATING_NATIVE_PREPARE_ONLY === "1") {
  console.log(JSON.stringify({ status: "OPERATING_NATIVE_PROFILE_READY", pane, profile: profileName }));
  process.exit(0);
}
const connection = JSON.stringify({ native_abi: 4, native_launch_v1: true, operations_directory: operationsRoot, profiles_directory: profiles });
const existingNative = await core.request({ action: "inspect", pane_id: pane }, AbortSignal.timeout(10000));
if (!existingNative.binding) {
const launch = Bun.spawn(["bun", join(import.meta.dirname, "plugin.ts"), "launch", pane, profileName],
  { cwd, env: { ...installation.environment, HERDR_SOCKET: socket, HERDR_UPDATER_CONNECTION_JSON: connection }, stdout: "pipe", stderr: "pipe" });
const [launchOut, launchErr, launchExit] = await Promise.all([new Response(launch.stdout).text(), new Response(launch.stderr).text(), launch.exited]);
save("launch.json", { exit: launchExit, stdout: launchOut, stderr: launchErr });
if (launchExit !== 0) throw new Error(`Managed launch failed: ${launchErr}`);
}
const native = await core.request({ action: "inspect", pane_id: pane }, AbortSignal.timeout(10000));
save("native.json", native);
if (!native.native_qualified || native.recovery_required || !native.binding) throw new Error("Operating native admission failed");

const wrapper = join(prefix, "install/global/node_modules/omo-ai"), engine = join(prefix, "install/global/node_modules/@code-yeongyu/senpi");
const paths = [join(wrapper, "bin/omo.js"), join(wrapper, "package.json"), join(engine, "package.json"),
  realpathSync(join(engine, JSON.parse(readFileSync(join(engine, "package.json"), "utf8")).bin.senpi)),
  join(engine, "dist/cli-main.js"), join(prefix, "install/global/package.json"), join(prefix, "install/global/bun.lock"),
  join(prefix, "bin/omo"), join(wrapper, "bin/senpi-patch.mjs"),
  ...["self-update.js", "package-paths.js", "update-args.js"].map(name => join(wrapper, "bin/lib", name))];
const resources = paths.map(path => ({ resourceId: `resource:${hash(path)}`, realpath: realpathSync(path), fingerprint: `sha256:${pin(path).sha256}` }));
const owner = { kind: "wrapper", packageName: "omo-ai", prefix, engineResourceId: `resource:${hash(join(engine, "package.json"))}` };
const provenancePath = join(prefix, "discovery.json");
writeFileSync(provenancePath, JSON.stringify({ family: "omo", executable: resources[0].realpath, channel: "latest", owner,
  packageManifest: join(wrapper, "package.json"), resources: resources.map(r => ({ path: r.realpath, sha256: r.fingerprint.slice(7) })) }), { mode: 0o600 });
const provenance = pin(provenancePath);
const { discoverExecutable } = await import("../src/discovery.ts");
const discovered = await discoverExecutable({ executable: resources[0].realpath, family: "omo", provenance: [provenance] });
if (!discovered.ok || discovered.value.qualification.kind !== "known") throw new Error("Operating discovery failed");
const before = discovered.value.installation;
const after = save("expected-after.json", before);
const independentRecord = process.env.OPERATING_NATIVE_INDEPENDENT;
if (!independentRecord) throw new Error("Independent original-manager after-image receipt required");
const independentInput = JSON.parse(readFileSync(independentRecord, "utf8"));
const independent = independentInput.independentTargetPins.map(reference => ({
  path: join(prefix, relative(independentInput.prefix, reference.path)), sha256: reference.sha256 }));
independent.push(provenance);
for (const reference of independent) {
  if (pin(reference.path).sha256 !== reference.sha256) throw new Error(`Independent output mismatch: ${reference.path}`);
}
const manifests = [];
function walk(directory) {
  for (const row of readdirSync(directory, { withFileTypes: true })) {
    if (!row.isDirectory() || row.name === ".bun") continue;
    const child = join(directory, row.name), manifest = join(child, "package.json");
    if (lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name && pkg.version) manifests.push({ name: pkg.name, version: pkg.version, installName: relative(join(prefix, "install/global/node_modules"), child) });
      const nested = join(child, "node_modules");
      if (lstatSync(nested, { throwIfNoEntry: false })?.isDirectory()) walk(nested);
    } else if (row.name.startsWith("@")) walk(child);
  }
}
walk(join(prefix, "install/global/node_modules"));
const available = [...JSON.parse(readFileSync(process.env.ONE_FAMILY_BEFORE_ACQUISITION)).records,
  ...JSON.parse(readFileSync(process.env.ONE_FAMILY_BEFORE_ALIASES)).records, ...recipe.acquisitionArtifacts];
const acquiredArtifacts = manifests.map(row => {
  const source = available.find(a => a.name === row.name && a.version === row.version);
  if (!source) throw new Error(`Missing genuine closure artifact: ${row.name}@${row.version}`);
  return { ...row, archive: source.archive, metadata: source.metadata };
});
const { artifacts, grants } = targetArtifacts(recipe, acquiredArtifacts);
const node = pin("/Users/beomseok/.nvm/versions/node/v24.20.0/bin/node");
const installerHome = join(root, "installer-home");
mkdirSync(installerHome, { mode: 0o700, recursive: true });
const now = Date.now(), qualification = { installation: before, manager: { ...installation.manager, name: "bun" },
  env: { BUN_INSTALL: prefix, HOME: installerHome,
    PATH: installation.manager.path.slice(0, installation.manager.path.lastIndexOf("/")) },
  target: { packageName: "omo-ai", version: "5.1.19", channel: "latest", checkedAt: now, expiresAt: now + 300000, artifacts,
    postinstall: independent.filter(p => p.path.startsWith(join(prefix, "install/global/node_modules/"))) } };
const metadata = recipe.artifacts.find(a => a.name === "omo-ai").provenance.vendor.metadata;
const sockets = "/Users/beomseok/.config/herdr", worker = "/Users/beomseok/.local/share/herdr-cli-updater/worker";
const registeredSockets = [];
function collectSockets(directory) {
  for (const row of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, row.name);
    if (row.isDirectory()) collectSockets(path);
    else if (row.isSocket()) registeredSockets.push(path);
  }
}
collectSockets(sockets);
const candidate = { schemaVersion: 1, profile: "omo-qualified-native-abi4", ownerDirectory: worker, update: { qualification },
  overlays: grants, provenance: [provenance], expectedAfterPin: after, independentTargetPins: independent,
  sourcePins: [recipe.sourceBinding], acquiredReplies: [
    { url: "https://registry.npmjs.org/-/package/omo-ai/dist-tags", status: 200, body: recipe.acquiredDistTags },
    { url: "https://registry.npmjs.org/omo-ai/5.1.19", status: 200, body: metadata }],
  native: { coreSocket: socket, coreIdentity: core.identity, operationsPath: join(operationsRoot, "operations.jsonl"),
    runtimeId: `operating:${session.fullId}`, profile: profileName, sessionPath: session.file, sourceBinding: recipe.sourceBinding,
    node: pin("/Users/beomseok/.nvm/versions/node/v24.20.0/bin/node"), paneId: pane },
  coverage: { root, prefix, socketDirectory: sockets, registeredSockets, rootPids: [native.binding.supervisor.pid] } };
const revision = Date.now();
const candidatePath = save(`candidate-${revision}.json`, candidate).path;
if (existsSync(join(worker, "owner.json"))) {
const workerClient = await attachAuthenticatedWorker(worker);
try {
  const jobs = await workerClient.request({ operation: "jobs" });
  if (!jobs.ok || jobs.result.jobs.some(job => !["completed", "failed", "cancelled", "recovery_required"].includes(job.status)))
    throw new Error("Operating worker has active jobs");
} finally { workerClient.close(); }
await stopWorker(discoverWorker(worker));
}
if (existsSync(worker)) {
  const remaining = readdirSync(worker);
  if (!remaining.every(name => (name === "mutations" && lstatSync(join(worker, name)).isDirectory())
    || (/^[a-f0-9]{64}\.jsonl$/.test(name) && lstatSync(join(worker, name)).isFile())))
    throw new Error("Unknown retired worker state must be preserved");
  renameSync(worker, `${worker}.retired-${Date.now()}`);
}
const runtimePath = join(root, `runtime-${revision}.json`);
await preparePluginRuntime(candidatePath, runtimePath, { directory: worker, coreSocket: socket });
save("applied.json", { pane, session, profile: profileName, runtime: runtimePath, worker });
console.log(JSON.stringify({ status: "OPERATING_NATIVE_QUALIFIED", pane, fullId: session.fullId }));
