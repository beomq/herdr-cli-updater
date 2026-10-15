import { readFileSync, writeFileSync } from "node:fs";
import { attachAuthenticatedWorker } from "../src/service/client.ts";
import { defaultWorkerDirectory } from "../src/service/worker.ts";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/operating-native/evidence";
const client = await attachAuthenticatedWorker(defaultWorkerDirectory, 15000);
try {
  const installations = await client.request({ operation: "installations" });
  const runtimes = await client.request({ operation: "runtimes" });
  const current = installations.ok && installations.result.installations.find(row => row.family === "omo" && row.installedVersion.kind === "known"
    && row.installedVersion.version === "5.1.19" && row.owner.prefix.endsWith("/prefix-r6"));
  if (!current || !runtimes.ok || !runtimes.result.runtimes.some(row => row.installationId === current.installationId && row.binding.paneId === "w22:p1"))
    throw new Error("Operating default installation/native runtime missing");
  const check = await client.request({ operation: "check", installationId: current.installationId });
  if (!check.ok || check.result.result.kind !== "up-to-date") throw new Error("Operating current version check failed");
  const jobs = await client.request({ operation: "jobs" });
  writeFileSync(`${root}/operating-api.json`, JSON.stringify({ installations, runtimes, check, jobs,
    nativeRestart: JSON.parse(readFileSync(`${root}/operating-restart.json`)) }), { mode: 0o600 });
  console.log(JSON.stringify({ status: "OPERATING_DEFAULT_API_PASS", installed: "5.1.19", running: "5.1.19", pane: "w22:p1" }));
} finally { client.close(); }
