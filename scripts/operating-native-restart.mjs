import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CoreOperationsClient } from "../src/core/client.ts";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/operating-native/evidence";
const pane = "w22:p1", socket = "/Users/beomseok/.config/herdr/herdr.sock";
const operations = "/Users/beomseok/.config/herdr/updater-operations-794e95d1341eb0576a26c9410fdd1e200b5609b14458d0c6df59f0e2bedc4470/operations.jsonl";
const client = await CoreOperationsClient.discover(socket, AbortSignal.timeout(10000));
const before = await client.request({ action: "inspect", pane_id: pane }, AbortSignal.timeout(10000));
if (!before.binding || !before.native_qualified || before.recovery_required) throw new Error("Native managed session required");
async function dispatch(request) {
  const signal = AbortSignal.timeout(120000);
  const observer = client.observeOperation(request.operation_id, operations, signal, "/Users/beomseok/.nvm/versions/node/v24.20.0/bin/node");
  try {
    await observer.ready;
    const initial = await client.request(request, signal);
    const result = initial.receipt?.status === "in_progress" ? await observer.completed : initial;
    if (!result.binding || result.recovery_required || !result.native_qualified || result.receipt?.status !== "completed")
      throw new Error(`Native ${request.action} incomplete`);
    return result;
  } finally { await observer.close(); }
}
const claim = await dispatch({ action: "claim", operation_id: `operating-claim-${randomUUID()}`, expected_binding: before.binding });
if (!claim.owner_token) throw new Error("Missing exact owner token");
const stopId = `operating-stop-${randomUUID()}`;
const stopped = await dispatch({ action: "stop", operation_id: stopId, expected_binding: claim.binding, owner_token: claim.owner_token });
const started = await dispatch({ action: "start", operation_id: `operating-start-${randomUUID()}`, stop_operation_id: stopId,
  expected_binding: stopped.binding, owner_token: claim.owner_token, profile: "operating-omo-20261006-r7" });
if (!isDeepStrictEqual(started.binding.session, before.binding.session) || started.binding.root.pid === before.binding.root.pid
  || started.binding.generation !== before.binding.generation + 1) throw new Error("Conversation restart identity mismatch");
await dispatch({ action: "release", operation_id: `operating-release-${randomUUID()}`, expected_binding: started.binding, owner_token: claim.owner_token });
writeFileSync(`${root}/operating-restart.json`, JSON.stringify({ status: "PASS", before: before.binding, after: started.binding,
  sameSession: true, existingSessionsRestarted: 0 }), { mode: 0o600 });
console.log(JSON.stringify({ status: "OPERATING_SAME_CONVERSATION_RESTART_PASS", oldPid: before.binding.root.pid, newPid: started.binding.root.pid }));
