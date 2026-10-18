import { mkdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { coreRequest } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/run.mjs";
import { homedir } from "node:os";
const base = `${homedir()}/.config/herdr/updater-inputs-794e95d1341eb0576a26c9410fdd1e200b5609b14458d0c6df59f0e2bedc4470`;
const targets = process.argv.includes("--latest-trial") ? [["queue-term_65d3b0177b76a10", "w1T:p1"]] : [
  ["queue-term_65d36543b22112a", "w1V:p2"],
  ["queue-term_65d269a91871b1b", "w1Z:p1"],
  ["queue-term_65d39e7b306573d", "w2B:p1"],
  ["queue-term_65d26a4c786ee1d", "w10:p1"],
  ["queue-term_65d3a2e2b8df840", "w2C:p1"],
];
const panes = await coreRequest(`${homedir()}/.config/herdr/herdr.sock`, "pane.list", {}, AbortSignal.timeout(10000));
const hash = body => createHash("sha256").update(body).digest("hex");
const prepared = targets.map(([directory, pane]) => {
  if (panes.panes.some(row => row.pane_id === pane)) throw new Error(`Pane exists: ${pane}`);
  const path = join(base, directory), body = readFileSync(join(path, "input.jsonl"));
  const rows = body.toString().trim().split("\n").map(line => JSON.parse(line));
  if (rows[0].identity.binding.pane_id !== pane || rows.at(-1).record !== "runtime_closed"
    || rows.some(row => row.record === "input" && row.receipt.kind !== "resize"))
    throw new Error(`Approved archive scope changed: ${directory}`);
  return { directory, pane, path, sha256: hash(body) };
});
const archive = `${base}.closed-trial-history-${Date.now()}`;
mkdirSync(archive, { mode: 0o700 });
for (const row of prepared) {
  const destination = join(archive, row.directory);
  renameSync(row.path, destination);
  if (existsSync(row.path) || hash(readFileSync(join(destination, "input.jsonl"))) !== row.sha256)
    throw new Error(`Archive verification failed: ${row.directory}`);
}
console.log(JSON.stringify({ status: "UPDATER_CLOSED_INPUTS_ARCHIVED", archive, records: prepared.map(({ path, ...row }) => row) }));
