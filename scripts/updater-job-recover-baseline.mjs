import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CoreOperationsClient, OperationFailure } from "../src/core/client.ts";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const profile = JSON.parse(readFileSync(join(root, "profile.json")));
const job = JSON.parse(readFileSync(join(root, "actual-job-terminal.json")));
if (job.status !== "recovery_required" || job.installTxn.state !== "queued") throw new Error("Baseline recovery not applicable");
const selected = job.selectedTargets[0];
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const claimId = `op-${createHash("sha256").update(JSON.stringify(canonical([job.jobId, selected.targetId, "claim"]))).digest("hex")}`;
const stopId = job.targetTxns[0].receipt.operationId;
const client = await CoreOperationsClient.discover("/Users/beomseok/.config/herdr/herdr.sock", AbortSignal.timeout(10000));
const signal = AbortSignal.timeout(90000);
const claim = await client.request({ action: "result", operation_id: claimId }, signal);
const stop = await client.request({ action: "result", operation_id: stopId }, signal);
if (!claim.owner_token || stop.receipt?.status !== "completed" || stop.receipt.action !== "stop"
  || stop.binding?.session.full_id !== profile.session.fullId || stop.recovery_required)
  throw new Error("Exact completed stop recovery unavailable");
async function dispatch(request) {
  const observation = client.observeOperation(request.operation_id, join(profile.operationRoot, "operations.jsonl"), signal,
    "/Users/beomseok/.nvm/versions/node/v24.20.0/bin/node");
  try {
    await observation.ready;
    let result;
    try { result = await client.request(request, signal); }
    catch (error) { if (!(error instanceof OperationFailure) || !error.mayHaveExecuted) throw error; }
    if (!result?.receipt || result.receipt.status === "in_progress") result = await observation.completed;
    if (result.receipt?.status !== "completed" || result.recovery_required) throw new Error("Baseline recovery failed");
    return result;
  } finally { await observation.close(); }
}
const restored = await dispatch({ action: "start", operation_id: `recover-${job.jobId.slice(4)}-baseline`,
  stop_operation_id: stopId, expected_binding: stop.binding, owner_token: claim.owner_token, profile: profile.beforeProfile });
await dispatch({ action: "release", operation_id: `recover-${job.jobId.slice(4)}-release`,
  expected_binding: restored.binding, owner_token: claim.owner_token });
writeFileSync(join(root, "baseline-recovery.json"), JSON.stringify({ jobId: job.jobId, restored }), { mode: 0o600 });
console.log(`UPDATER_BASELINE_RECOVERED ${restored.binding.root.pid} same-conversation ${restored.binding.session.full_id}`);
