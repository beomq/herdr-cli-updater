import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, realpathSync, readdirSync, lstatSync, renameSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { discoverExecutable } from "../src/discovery.ts";
import { CoreOperationsClient } from "../src/core/client.ts";
import { preparePluginRuntime, configurePluginRuntime, RUNTIME_SET_PROFILE } from "../src/service/plugin-runtime.ts";
import { attachAuthenticatedWorker } from "../src/service/client.ts";
import { discoverWorker, stopWorker, startWorker } from "../src/service/worker.ts";
import { preparedNativeRecipe } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/normalize.mjs";
import { targetArtifacts } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/issued-inputs.mjs";
import { qualifyOmoUpdate } from "../src/adapters/update-context.ts";

const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const prefix = join(root, "prefix"), worker = "/Users/beomseok/.local/share/herdr-cli-updater/worker";
const socket = "/Users/beomseok/.config/herdr/herdr.sock", sockets = "/Users/beomseok/.config/herdr";
const profile = JSON.parse(readFileSync(join(root, "profile.json"))), image = JSON.parse(readFileSync(join(root, "latest-image.json")));
const beforeInstall = JSON.parse(readFileSync(join(root, "evidence/installation.json")));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pin = path => ({ path: realpathSync(path), sha256: hash(readFileSync(path)) });
const save = (name, value) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 }); return pin(path); };
const old = join(import.meta.dirname, "../.omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/inputs");
process.env.ONE_FAMILY_BEFORE_ACQUISITION = join(old, "acquisition.json");
process.env.ONE_FAMILY_BEFORE_ALIASES = join(old, "alias-closure.json");
process.env.UPDATER_JOB_LATEST_ACQUISITION = join(root, "acquisition/acquisition.json");
const recipe = preparedNativeRecipe(image.recipePath);
const core = await CoreOperationsClient.discover(socket, AbortSignal.timeout(10000));
const native = await core.request({ action: "inspect", pane_id: profile.pane }, AbortSignal.timeout(10000));
if (!native.native_qualified || native.recovery_required || !native.binding) throw new Error("Actual session lacks native binding");
const wrapper = join(prefix, "install/global/node_modules/omo-ai"), engine = join(prefix, "install/global/node_modules/@code-yeongyu/senpi");
const paths = [join(wrapper, "bin/omo.js"), join(wrapper, "package.json"), join(engine, "package.json"),
  realpathSync(join(engine, JSON.parse(readFileSync(join(engine, "package.json"))).bin.senpi)), join(engine, "dist/cli-main.js"),
  join(prefix, "install/global/package.json"), join(prefix, "install/global/bun.lock"), join(prefix, "bin/omo"), join(wrapper, "bin/senpi-patch.mjs"),
  ...["self-update.js", "package-paths.js", "update-args.js"].map(name => join(wrapper, "bin/lib", name))];
// Bind every existing target slot whose version will change, not just the pair.
const imagePins = image.independentTargetPins;
for (const output of imagePins.filter(row => row.path.endsWith("/package.json") && row.path.includes("/node_modules/"))) {
  if (!existsSync(output.path)) continue;
  const beforePackage = JSON.parse(readFileSync(output.path));
  const afterPath = join(image.prefix, relative(prefix, output.path));
  const afterPackage = JSON.parse(readFileSync(afterPath));
  if (beforePackage.version !== afterPackage.version && !paths.includes(output.path)) paths.push(output.path);
}
const resources = paths.map(path => ({ resourceId: `resource:${hash(path)}`, realpath: realpathSync(path), fingerprint: `sha256:${pin(path).sha256}` }));
const owner = { kind: "wrapper", packageName: "omo-ai", prefix, engineResourceId: `resource:${hash(join(engine, "package.json"))}` };
const discovery = { family: "omo", executable: resources[0].realpath, channel: "latest", owner,
  packageManifest: join(wrapper, "package.json"), resources: resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })) };
const discoveryPath = join(prefix, "discovery.json");
// This script owns this private discovery receipt; changed resource coverage is a new preparation.
writeFileSync(discoveryPath, JSON.stringify(discovery), { mode: 0o600 });
const provenance = pin(discoveryPath);
if (readFileSync(provenance.path, "utf8") !== JSON.stringify(discovery)) throw new Error("Existing discovery drift");
const discovered = await discoverExecutable({ executable: resources[0].realpath, family: "omo", provenance: [provenance] });
if (!discovered.ok || discovered.value.qualification.kind !== "known") throw new Error("Actual job installation discovery failed");
const before = discovered.value.installation;
const independent = image.independentTargetPins.map(({ path, sha256 }) => ({ path, sha256 }));
independent.push(provenance);
const afterResources = before.resources.map(row => {
  const target = independent.find(pin => pin.path === row.realpath);
  if (!target) throw new Error(`Independent resource absent: ${row.realpath}`);
  return { ...row, fingerprint: `sha256:${target.sha256}` };
});
const revision = Date.now();
const after = save(`expected-after-${revision}.json`, { ...before, installedVersion: { kind: "known", version: recipe.target.version },
  resources: afterResources, resourcesFingerprint: `sha256:${hash(JSON.stringify(afterResources))}` });
const manifests = [];
function walk(directory) {
  for (const row of readdirSync(directory, { withFileTypes: true })) {
    if (!row.isDirectory() || row.name === ".bun") continue;
    const child = join(directory, row.name), manifest = join(child, "package.json");
    if (lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) {
      const pkg = JSON.parse(readFileSync(manifest));
      manifests.push({ name: pkg.name, version: pkg.version, installName: relative(join(image.prefix, "install/global/node_modules"), child) });
      if (lstatSync(join(child, "node_modules"), { throwIfNoEntry: false })?.isDirectory()) walk(join(child, "node_modules"));
    } else if (row.name.startsWith("@")) walk(child);
  }
}
walk(join(image.prefix, "install/global/node_modules"));
const acquired = JSON.parse(readFileSync(process.env.UPDATER_JOB_LATEST_ACQUISITION));
const acquiredArtifacts = manifests.map(row => {
  const artifact = acquired.records.find(a => a.name === row.name && a.version === row.version);
  if (!artifact) throw new Error(`Original closure missing ${row.name}@${row.version}`);
  return { ...row, archive: artifact.archive, metadata: artifact.metadata };
});
const { artifacts, grants } = targetArtifacts(recipe, acquiredArtifacts);
const home = join(root, "installer-home");
mkdirSync(home, { recursive: true, mode: 0o700 });
const now = Date.now();
const node = pin("/Users/beomseok/.nvm/versions/node/v24.20.0/bin/node");
const qualification = { installation: before, manager: { ...beforeInstall.manager, name: "bun", node },
  env: { BUN_INSTALL: prefix, HOME: home, PATH: [beforeInstall.manager.path.slice(0, beforeInstall.manager.path.lastIndexOf("/")),
    node.path.slice(0, node.path.lastIndexOf("/"))].join(":") },
  target: { packageName: "omo-ai", version: recipe.target.version, channel: "latest", checkedAt: now, expiresAt: now + 300000,
    artifacts, postinstall: independent.filter(pin => pin.path.startsWith(join(prefix, "install/global/node_modules/"))) } };
const registeredSockets = [];
function socketWalk(directory) { for (const row of readdirSync(directory, { withFileTypes: true })) {
  const path = join(directory, row.name); if (row.isDirectory()) socketWalk(path); else if (row.isSocket()) registeredSockets.push(path);
  else if (row.isSymbolicLink()) {
    let target = path, info = lstatSync(target);
    const visited = new Set();
    while (info.isSymbolicLink()) {
      if (visited.has(target)) throw new Error("Socket alias cycle"); visited.add(target);
      target = resolve(dirname(target), readlinkSync(target));
      target = join(realpathSync(dirname(target)), basename(target)); info = lstatSync(target);
    }
    if (info.isDirectory()) throw new Error("Socket directory alias unqualified");
    if (info.isSocket() && !registeredSockets.includes(target)) registeredSockets.push(target);
  }
} }
socketWalk(sockets);
const candidate = { schemaVersion: 1, profile: "omo-qualified-native-abi4", ownerDirectory: worker, update: { qualification }, overlays: grants,
  provenance: [provenance], expectedAfterPin: after, independentTargetPins: independent, sourcePins: [recipe.sourceBinding],
  acquiredReplies: [{ url: "https://registry.npmjs.org/-/package/omo-ai/dist-tags", status: 200, body: acquired.acquiredDistTags },
    { url: `https://registry.npmjs.org/omo-ai/${recipe.target.version}`, status: 200, body: recipe.artifacts.find(a => a.name === "omo-ai").provenance.vendor.metadata }],
  native: { coreSocket: socket, coreIdentity: core.identity, operationsPath: join(profile.operationRoot, "operations.jsonl"),
    runtimeId: `actual-job:${profile.session.fullId}`, profile: profile.afterProfile, sessionPath: profile.session.file,
    sourceBinding: recipe.sourceBinding, node: pin("/Users/beomseok/.nvm/versions/node/v24.20.0/bin/node"), paneId: profile.pane },
  coverage: { root, prefix, socketDirectory: sockets, registeredSockets, rootPids: [native.binding.supervisor.pid] } };
const tagsPath = join(root, `dist-tags-${revision}.json`);
writeFileSync(tagsPath, acquired.acquiredDistTags, { flag: "wx", mode: 0o600 });
candidate.acquiredReplies[0].body = pin(tagsPath);
const candidatePath = save(`candidate-${revision}.json`, candidate).path;
const qualificationReceipt = save(`qualification-${revision}.json`, qualification);
const preflight = await qualifyOmoUpdate({ qualification, receipt: qualificationReceipt }, Date.now(), grants);
if (!preflight.ok) throw new Error(`Actual update qualification rejected: ${JSON.stringify(preflight)}`);
if (existsSync(join(worker, "owner.json"))) {
 const client = await attachAuthenticatedWorker(worker, 15000);
 try {
  const jobs = await client.request({ operation: "jobs" });
  if (!jobs.ok || jobs.result.jobs.some(job => !["completed", "failed", "cancelled", "recovery_required"].includes(job.status)))
    throw new Error("Existing updater job active");
 } finally { client.close(); }
 await stopWorker(discoverWorker(worker));
}
if (existsSync(worker)) {
  const remaining = readdirSync(worker);
  if (!remaining.every(name => (name === "mutations" && lstatSync(join(worker, name)).isDirectory())
    || (/^[a-f0-9]{64}\.jsonl$/.test(name) && lstatSync(join(worker, name)).isFile()))) throw new Error("Unknown worker state");
  renameSync(worker, `${worker}.retired-${revision}`);
}
const jobsDirectory = `${worker}.jobs`;
if (existsSync(jobsDirectory)) {
  renameSync(jobsDirectory, `${jobsDirectory}.actual-job-history-${revision}`);
  console.log(`UPDATER_FAILED_JOB_HISTORY_ARCHIVED ${jobsDirectory}.actual-job-history-${revision}`);
}
const runtimePath = join(root, `runtime-${revision}.json`);
await preparePluginRuntime(candidatePath, runtimePath, { directory: worker, coreSocket: socket });
const configRoot = "/Users/beomseok/.local/share/herdr-cli-updater", runtimeConfig = join(configRoot, "runtime.json");
const existing = JSON.parse(readFileSync(runtimeConfig));
if (existing.profile !== RUNTIME_SET_PROFILE) throw new Error("Existing runtime set required");
const configurations = existing.configurations.filter(pin => {
  if (pin.path.startsWith(root + "/")) return false;
  const config = JSON.parse(readFileSync(pin.path));
  const qualifications = config.profiles?.map(profile => profile.update.qualification) ?? [config.update?.qualification];
  if (qualifications.every(q => q?.target?.expiresAt < Date.now())) {
    console.log(`UPDATER_EXPIRED_REGISTRATION_ARCHIVED ${pin.path}`);
    return false;
  }
  return true;
});
configurations.push(pin(runtimePath));
const nextRuntime = `${runtimeConfig}.actual-job-${revision}`;
configurePluginRuntime(nextRuntime, { schemaVersion: 1, profile: RUNTIME_SET_PROFILE, configurations });
renameSync(runtimeConfig, `${runtimeConfig}.${revision}-before-actual-job`);
renameSync(nextRuntime, runtimeConfig);
process.env.HERDR_CLI_UPDATER_RUNTIME_CONFIG = runtimeConfig;
process.env.HERDR_SOCKET = socket;
await startWorker(worker, { home: "/Users/beomseok", path: process.env.PATH,
  prefixes: ["/opt/homebrew", "/usr/local"], socket });
const started = await attachAuthenticatedWorker(worker, 15000);
try { const targets = await started.request({ operation: "targets", installationId: before.installationId });
  save(`registered-${revision}.json`, { before, targets, runtimePath });
  if (!targets.ok || !targets.result.selection || !targets.result.targets.length) throw new Error("Actual job target not available");
} finally { started.close(); }
console.log(`UPDATER_ACTUAL_JOB_REGISTERED ${before.installationId}`);
