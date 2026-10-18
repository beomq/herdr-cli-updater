import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { attachAuthenticatedWorker } from "../src/service/client.ts";
import { discoverWorker, stopWorker } from "../src/service/worker.ts";
import { CoreOperationsClient } from "../src/core/client.ts";
import { coreRequest } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/run.mjs";
import { installOriginal } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/install.mjs";
import { homedir } from "node:os";

const root = `${homedir()}/.local/share/herdr-cli-updater/updater-single-job`;
const worker = `${homedir()}/.local/share/herdr-cli-updater/worker`;
const prefix = join(root, "prefix"), socket = `${homedir()}/.config/herdr/herdr.sock`;
const profile = JSON.parse(readFileSync(join(root, "profile.json")));
const installation = JSON.parse(readFileSync(join(root, "evidence/installation.json")));
const baseline = JSON.parse(readFileSync(`${homedir()}/.local/share/herdr-cli-updater/worker-preparations/omo-mJsivd/omo-runtime.json`));
const current = JSON.parse(readFileSync(join(prefix, "install/global/node_modules/omo-ai/package.json")));
if (current.version !== "5.1.21" || baseline.update.qualification.target.version !== "5.1.19") throw new Error("Unexpected trial versions");
const pane = "w1V:p1";
const processes = await coreRequest(socket, "pane.process_info", { pane_id: pane }, AbortSignal.timeout(10000));
if (processes.process_info.foreground_processes.length !== 1 || processes.process_info.foreground_processes[0].name !== "zsh")
  throw new Error("Original conversation pane has active work");
const core = await CoreOperationsClient.discover(socket, AbortSignal.timeout(10000));
const inspected = await core.request({ action: "inspect", pane_id: pane }, AbortSignal.timeout(10000));
if (inspected.binding) throw new Error("Original pane already native-owned");
const client = await attachAuthenticatedWorker(worker, 15000);
try {
  const jobs = await client.request({ operation: "jobs" });
  if (!jobs.ok || jobs.result.jobs.some(job => !["completed", "failed", "cancelled", "recovery_required"].includes(job.status)))
    throw new Error("Updater job active");
} finally { client.close(); }
await stopWorker(discoverWorker(worker));
const revision = Date.now();
renameSync(worker, `${worker}.retired-${revision}`);
if (existsSync(`${worker}.jobs`)) renameSync(`${worker}.jobs`, `${worker}.jobs.actual-job-history-${revision}`);
// Preserve the successful install and failed verification history in full.
const archived = join(root, `prefix-files-verified-521-${revision}`);
renameSync(prefix, archived);
const overlays = installation.artifacts;
const rows = baseline.update.qualification.target.artifacts.map(artifact => {
  const overlay = overlays.find(row => row.name === artifact.name && row.version === artifact.version);
  return overlay ?? artifact;
});
const restored = await installOriginal(rows, "5.1.19", installation.manager, profile.session.cwd,
  installation.environment, AbortSignal.timeout(300000));
const retained = JSON.parse(readFileSync(join(profile.operationRoot, "profiles", `${profile.beforeProfile}.json`)));
for (const pin of retained.closure) {
  if (createHash("sha256").update(readFileSync(pin.path)).digest("hex") !== pin.sha256)
    throw new Error(`Restored original baseline closure mismatch: ${pin.path}`);
}
profile.pane = pane;
writeFileSync(join(root, "profile.json"), JSON.stringify(profile), { mode: 0o600 });
const connection = { native_abi: 4, native_launch_v1: true, operations_directory: profile.operationRoot,
  profiles_directory: join(profile.operationRoot, "profiles") };
const launch = Bun.spawn(["bun", join(import.meta.dirname, "plugin.ts"), "launch", pane, profile.beforeProfile], {
  cwd: profile.session.cwd, env: { ...profile.environment, HERDR_SOCKET: socket, HERDR_UPDATER_CONNECTION_JSON: JSON.stringify(connection) },
  stdout: "pipe", stderr: "pipe", stdin: "ignore",
});
const [stdout, stderr, status] = await Promise.all([new Response(launch.stdout).text(), new Response(launch.stderr).text(), launch.exited]);
writeFileSync(join(root, `baseline-restage-${revision}.json`), JSON.stringify({ archived, restored, pane, stdout, stderr, status }), { mode: 0o600 });
if (status !== 0) throw new Error(`Original conversation restore failed: ${stderr}`);
console.log(`UPDATER_ORIGINAL_PANE_RESTORED ${pane} ${profile.session.fullId}; failed job retained`);
