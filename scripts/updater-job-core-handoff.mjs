import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { coreRequest } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/run.mjs";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const socket = "/Users/beomseok/.config/herdr/herdr.sock";
const binary = "/Users/beomseok/Desktop/herdr-updater-core-source-cache/.worktrees/session-restart/.local/native-target/debug/herdr";
const profile = JSON.parse(readFileSync(join(root, "profile.json")));
if (profile.pane !== "w2C:p1") throw new Error("Unexpected owned trial pane");
const panes = await coreRequest(socket, "pane.list", {}, AbortSignal.timeout(10000));
const before = [];
for (const pane of panes.panes) {
  if (pane.pane_id === profile.pane) continue;
  before.push(await coreRequest(socket, "pane.process_info", { pane_id: pane.pane_id }, AbortSignal.timeout(10000)));
}
const evidence = join(root, `core-handoff-${Date.now()}.json`);
const record = { binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"), before };
writeFileSync(evidence, JSON.stringify(record), { flag: "wx", mode: 0o600 });
await coreRequest(socket, "pane.close", { pane_id: profile.pane }, AbortSignal.timeout(15000));
record.closedOwnedTrialPane = profile.pane;
writeFileSync(evidence, JSON.stringify(record), { mode: 0o600 });
record.handoff = await coreRequest(socket, "server.live_handoff", { import_exe: binary,
  expected_protocol: 22, expected_version: "0.9.3" }, AbortSignal.timeout(60000));
writeFileSync(evidence, JSON.stringify(record), { mode: 0o600 });
console.log(`UPDATER_CORE_HANDOFF ${evidence}`);
