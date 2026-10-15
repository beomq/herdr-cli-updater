import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachAuthenticatedWorker } from "../src/service/client.ts";
import { CoreOperationsClient } from "../src/core/client.ts";
import { coreRequest } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/run.mjs";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const job = JSON.parse(readFileSync(join(root, "actual-job.json")));
const profile = JSON.parse(readFileSync(join(root, "profile.json")));
const client = await attachAuthenticatedWorker("/Users/beomseok/.local/share/herdr-cli-updater/worker", 15000);
try {
  const inspection = await client.request({ operation: "inspect-job", jobId: job.jobId });
  if (!inspection.ok) throw new Error("Actual updater job inspection failed");
  const current = inspection.result.job;
  if (!["completed", "failed", "recovery_required", "cancelled"].includes(current.status)) {
    console.log(`UPDATER_JOB_PENDING ${current.status} ${current.installTxn.state}`);
    process.exitCode = 1;
  } else {
    const core = await CoreOperationsClient.discover("/Users/beomseok/.config/herdr/herdr.sock", AbortSignal.timeout(10000));
    const snapshot = await core.request({ action: "inspect", pane_id: profile.pane }, AbortSignal.timeout(10000));
    const screen = await coreRequest(core.socketId, "pane.read", { pane_id: profile.pane, source: "visible", lines: 14 }, AbortSignal.timeout(10000));
    const installedVersion = JSON.parse(readFileSync(join(root, "prefix/install/global/node_modules/omo-ai/package.json"))).version;
    writeFileSync(join(root, "actual-job-result.json"), JSON.stringify({ inspection: inspection.result, native: snapshot, installedVersion, screen: screen.read.text }), { mode: 0o600 });
    if (current.status !== "completed" || current.installTxn.state !== "succeeded"
      || current.targetTxns.length !== 1 || current.targetTxns[0].state !== "completed"
      || installedVersion !== "5.1.21" || snapshot.binding?.root.pid === job.selectedTargets[0].expectedBinding.rootIncarnation.pid
      || snapshot.binding?.session.full_id !== profile.session.fullId
      || snapshot.binding?.session.cwd !== profile.session.cwd
      || `options:${snapshot.binding?.session.options_sha256}` !== job.selectedTargets[0].expectedBinding.optionsRef
      || !snapshot.native_qualified || snapshot.recovery_required)
      throw new Error(`Actual updater job failed: ${current.status} ${current.installTxn.state}`);
    console.log(`UPDATER_JOB_COMPLETED ${job.jobId} same-conversation ${profile.session.fullId} pid=${snapshot.binding.root.pid}`);
  }
} finally { client.close(); }
