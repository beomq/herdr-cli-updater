import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachAuthenticatedWorker } from "../src/service/client.ts";
import { defaultWorkerDirectory } from "../src/service/worker.ts";
import { homedir } from "node:os";
const root = `${homedir()}/.local/share/herdr-cli-updater/operating-native/evidence`;
mkdirSync(root, { recursive: true, mode: 0o700 });
const clients = await Promise.all(Array.from({ length: 3 }, () => attachAuthenticatedWorker(defaultWorkerDirectory, 20000)));
try {
  if (clients.some(client => client.incarnation !== clients[0].incarnation)) throw new Error("Worker incarnation drift");
  const started = performance.now();
  const installations = await clients[0].request({ operation: "installations" });
  const installMs = performance.now() - started;
  if (!installations.ok) throw new Error(`Installations refused: ${installations.error.code}`);
  const sessionStart = performance.now();
  const sessions = await clients[1].request({ operation: "sessions" });
  const sessionsMs = performance.now() - sessionStart;
  if (!sessions.ok) throw new Error(`Sessions refused: ${sessions.error.code}`);
  const rows = installations.result.installations, queue = [...rows], checks = [];
  const checksStart = performance.now();
  await Promise.all(clients.map(async client => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const start = performance.now();
      const result = await client.request({ operation: "check", installationId: row.installationId });
      checks.push({ family: row.family, installedVersion: row.installedVersion, ms: performance.now() - start, result });
    }
  }));
  const checksMs = performance.now() - checksStart;
  const result = { installMs, sessionsMs, checksMs, overallMs: performance.now() - started, sessions, checks };
  writeFileSync(join(root, "catalog-latency.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: "OPERATING_CATALOG_LATENCY_MEASURED", installMs: Math.round(installMs), sessionsMs: Math.round(sessionsMs),
    checksMs: Math.round(checksMs), sessions: sessions.result.sessions.map(row => ({ pane: row.paneId, family: row.family, status: row.status })),
    unavailableSources: sessions.result.unavailableSources, checks: checks.map(row => ({ family: row.family, ms: Math.round(row.ms), ok: row.result.ok })) }));
} finally { for (const client of clients) client.close(); }
