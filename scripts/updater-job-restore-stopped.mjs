import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CoreOperationsClient } from "../src/core/client.ts";
import { attachAuthenticatedWorker } from "../src/service/client.ts";
import { discoverWorker, stopWorker } from "../src/service/worker.ts";
import { installOriginal } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/install.mjs";

const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const worker = "/Users/beomseok/.local/share/herdr-cli-updater/worker";
const profile = JSON.parse(readFileSync(join(root, "profile.json")));
const saved = JSON.parse(readFileSync(join(root, "actual-job.json")));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const claimId = `op-${createHash("sha256").update(JSON.stringify(canonical([saved.jobId, saved.selectedTargets[0].targetId, "claim"]))).digest("hex")}`;
const client = await attachAuthenticatedWorker(worker, 15000);
let job;
try {
  const response = await client.request({ operation: "inspect-job", jobId: saved.jobId });
  if (!response.ok) throw new Error("Current failed job unavailable");
  job = response.result.job;
  if (job.status !== "recovery_required" || job.targetTxns[0].receipt?.kind !== "completed"
    || job.targetTxns[0].receipt.effect !== "stopped") throw new Error("Exact completed stop required");
} finally { client.close(); }
const core = await CoreOperationsClient.discover("/Users/beomseok/.config/herdr/herdr.sock", AbortSignal.timeout(10000));
const claim = await core.request({ action: "result", operation_id: claimId }, AbortSignal.timeout(10000));
const stopId = job.targetTxns[0].receipt.operationId;
const stopped = await core.request({ action: "result", operation_id: stopId }, AbortSignal.timeout(10000));
if (!claim.owner_token || stopped.recovery_required || stopped.receipt?.status !== "completed"
  || stopped.binding?.session.full_id !== profile.session.fullId) throw new Error("Supported native recovery unavailable");
await stopWorker(discoverWorker(worker));
const revision = Date.now();
renameSync(worker, `${worker}.retired-${revision}`);
if (existsSync(`${worker}.jobs`)) renameSync(`${worker}.jobs`, `${worker}.jobs.actual-job-history-${revision}`);
const installation = JSON.parse(readFileSync(join(root, "evidence/installation.json")));
const baseline = JSON.parse(readFileSync("/Users/beomseok/.local/share/herdr-cli-updater/worker-preparations/omo-mJsivd/omo-runtime.json"));
const archived = join(root, `prefix-files-verified-521-${revision}`);
renameSync(join(root, "prefix"), archived);
const rows = baseline.update.qualification.target.artifacts.map(artifact =>
  installation.artifacts.find(row => row.name === artifact.name && row.version === artifact.version) ?? artifact);
await installOriginal(rows, "5.1.19", installation.manager, profile.session.cwd, installation.environment, AbortSignal.timeout(180000));
const retained = JSON.parse(readFileSync(join(profile.operationRoot, "profiles", `${profile.beforeProfile}.json`)));
for (const pin of retained.closure) {
  if (createHash("sha256").update(readFileSync(pin.path)).digest("hex") !== pin.sha256) throw new Error("Baseline closure mismatch");
  const info = lstatSync(pin.path);
  if (pin.path.startsWith(join(root, "prefix") + "/") && (info.mode & 0o022)) chmodSync(pin.path, info.mode & 0o755);
}
async function dispatch(request) {
  const signal = AbortSignal.timeout(60000);
  const observation = core.observeOperation(request.operation_id, join(profile.operationRoot, "operations.jsonl"), signal,
    "/Users/beomseok/.nvm/versions/node/v24.20.0/bin/node");
  try {
    await observation.ready;
    const accepted = await core.request(request, signal);
    const result = accepted.receipt?.status === "in_progress" ? await observation.completed : accepted;
    if (result.receipt?.status !== "completed" || result.recovery_required) throw new Error("Supported recovery rejected");
    return result;
  } finally { await observation.close(); }
}
const restored = await dispatch({ action: "start", operation_id: `restore-${revision}-baseline`, stop_operation_id: stopId,
  expected_binding: stopped.binding, owner_token: claim.owner_token, profile: profile.beforeProfile });
await dispatch({ action: "release", operation_id: `restore-${revision}-release`, expected_binding: restored.binding, owner_token: claim.owner_token });
writeFileSync(join(root, `stopped-restore-${revision}.json`), JSON.stringify({ archived, restored }), { mode: 0o600 });
console.log(`UPDATER_STOPPED_CONVERSATION_RESTORED ${profile.pane} ${restored.binding.root.pid} ${profile.session.fullId}`);
