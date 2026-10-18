import { existsSync, lstatSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { attachAuthenticatedWorker } from "../src/service/client.ts";
import { discoverWorker, stopWorker, startWorker } from "../src/service/worker.ts";
import { homedir } from "node:os";
const directory = `${homedir()}/.local/share/herdr-cli-updater/worker`;
const client = await attachAuthenticatedWorker(directory, 15000);
let saved;
try {
  const response = await client.request({ operation: "jobs" });
  if (!response.ok || response.result.jobs.some(job => job.status !== "completed")) throw new Error("Non-completed job prevents code replacement");
  saved = response.result.jobs;
} finally { client.close(); }
await stopWorker(discoverWorker(directory));
if (existsSync(directory)) {
  if (!readdirSync(directory).every(name => name === "mutations" && lstatSync(join(directory, name)).isDirectory()
    || /^[a-f0-9]{64}\.jsonl$/.test(name) && lstatSync(join(directory, name)).isFile())) throw new Error("Unknown retired worker data");
  renameSync(directory, `${directory}.catalog-reload-${Date.now()}`);
}
process.env.HERDR_CLI_UPDATER_RUNTIME_CONFIG = `${homedir()}/.local/share/herdr-cli-updater/runtime.json`;
await startWorker(directory, { home: homedir(), path: process.env.PATH,
  prefixes: ["/opt/homebrew", "/usr/local"], socket: `${homedir()}/.config/herdr/herdr.sock` });
const fresh = await attachAuthenticatedWorker(directory, 15000);
try {
  const jobs = await fresh.request({ operation: "jobs" });
  if (!jobs.ok || !isDeepStrictEqual(jobs.result.jobs, saved)) throw new Error("Job history changed");
  const response = await fresh.request({ operation: "installations" });
  if (!response.ok) throw new Error(`Catalog remains unavailable: ${response.error.code}`);
  console.log(JSON.stringify({ status: "CATALOG_RESTORED", jobsPreserved: saved.length,
    installations: response.result.installations.map(row => ({ family: row.family, version: row.installedVersion })) }));
} finally { fresh.close(); }
