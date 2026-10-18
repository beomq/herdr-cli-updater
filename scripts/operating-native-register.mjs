import { readFileSync, writeFileSync, renameSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { configurePluginRuntime, RUNTIME_SET_PROFILE } from "../src/service/plugin-runtime.ts";
import { discoverWorker, stopWorker, startWorker, defaultWorkerDirectory } from "../src/service/worker.ts";
import { attachAuthenticatedWorker } from "../src/service/client.ts";
import { homedir } from "node:os";

const root = `${homedir()}/.local/share/herdr-cli-updater`;
const native = JSON.parse(readFileSync(join(root, "operating-native/evidence/applied.json"))).runtime, runtime = join(root, "runtime.json");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
if (existsSync(defaultWorkerDirectory)) {
  const client = await attachAuthenticatedWorker(defaultWorkerDirectory);
  try {
    const jobs = await client.request({ operation: "jobs" });
    if (!jobs.ok || jobs.result.jobs.some(job => !["completed", "failed", "cancelled", "recovery_required"].includes(job.status)))
      throw new Error("Active updater jobs prevent registration");
  } finally { client.close(); }
  await stopWorker(discoverWorker(defaultWorkerDirectory));
}
const registry = join(root, "worker.catalog/auto-sources.json");
const original = readFileSync(registry);
const state = JSON.parse(original);
const approved = new Set([`${homedir()}/.bun/bin/omo`, `${homedir()}/.bun/install/global/node_modules/.bin/omo`]);
for (const reference of state.pins) {
  if (approved.has(reference.path)) {
    reference.sha256 = hash(readFileSync(reference.path));
    reference.mode = lstatSync(reference.path).mode & 0o7777;
  }
}
state.generation += 1;
if (!existsSync(join(root, "operating-native/evidence/auto-sources-before.json")))
  writeFileSync(join(root, "operating-native/evidence/auto-sources-before.json"), original, { flag: "wx", mode: 0o600 });
writeFileSync(`${registry}.operating`, JSON.stringify(state), { flag: "wx", mode: 0o600 });
renameSync(`${registry}.operating`, registry);
const previous = JSON.parse(readFileSync(runtime, "utf8"));
const configurations = previous.profile === RUNTIME_SET_PROFILE
  ? previous.configurations.filter(reference => !reference.path.startsWith(join(root, "operating-native/"))) : [];
configurations.push({ path: native, sha256: hash(readFileSync(native)) });
const next = `${runtime}.operating`;
configurePluginRuntime(next, { schemaVersion: 1, profile: RUNTIME_SET_PROFILE, configurations });
renameSync(runtime, `${runtime}.${Date.now()}-before-native`);
renameSync(next, runtime);
process.env.HERDR_CLI_UPDATER_RUNTIME_CONFIG = runtime;
process.env.HERDR_SOCKET = `${homedir()}/.config/herdr/herdr.sock`;
await startWorker(defaultWorkerDirectory, { home: homedir(), path: process.env.PATH,
  prefixes: ["/opt/homebrew", "/usr/local"], socket: process.env.HERDR_SOCKET });
const client = await attachAuthenticatedWorker(defaultWorkerDirectory, 15000);
try {
  const installations = await client.request({ operation: "installations" });
  const runtimes = await client.request({ operation: "runtimes" });
  writeFileSync(join(root, "operating-native/evidence/operating-api.json"), JSON.stringify({ installations, runtimes }), { mode: 0o600 });
  console.log(JSON.stringify({ status: "OPERATING_UPDATER_REGISTERED", installationsOk: installations.ok, runtimesOk: runtimes.ok }));
} finally { client.close(); }
