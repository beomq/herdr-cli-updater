import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveDomainWorker } from "../src/service/worker.ts";
import { attachAuthenticatedWorker } from "../src/service/client.ts";
import { startTerminal, openTerminalCapture } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/terminal.mjs";

const project = join(import.meta.dirname, ".."), root = await realpath(await mkdtemp(join(tmpdir(), "updater-catalog-")));
const evidence = join(project, ".omo", "evidence", "catalog-sessions", `${Date.now()}`);
await mkdir(evidence, { recursive: true });
const sink = async (name, bytes) => Bun.write(join(evidence, name), bytes);
let worker, client, terminal, capture;
const signal = AbortSignal.timeout(240000);
try {
  const directory = join(root, "worker");
  worker = await serveDomainWorker(directory);
  client = await attachAuthenticatedWorker(directory, 30000);
  const installations = await client.request({ operation: "installations" });
  await sink("installations.json", JSON.stringify(installations, null, 2));
  if (!installations.ok) throw new Error(`installations:${installations.error.code}`);
  const sessions = await client.request({ operation: "sessions" });
  if (!sessions.ok) throw new Error(`sessions:${sessions.error.code}`);
  await sink("sessions.json", JSON.stringify(sessions.result, null, 2));
  const checks = [];
  for (const row of installations.result.installations) {
    const checked = await client.request({ operation: "check", installationId: row.installationId });
    const targets = await client.request({ operation: "targets", installationId: row.installationId });
    checks.push({ family: row.family, installed: row.installedVersion, checked, targets });
  }
  await sink("checks-and-targets.json", JSON.stringify(checks, null, 2));
  const env = { ...process.env, HERDR_CLI_UPDATER_DIRECTORY: directory };
  // An owned worker observes the real core; no operating worker or CLI is restarted.
  delete env.HERDR_CLI_UPDATER_RUNTIME_CONFIG;
  capture = await openTerminalCapture({ paths: { tmp: root } },
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", env);
  terminal = startTerminal([process.execPath, join(project, "scripts/plugin.ts"), "tui"], project, env, signal, 120, 40);
  await terminal.expect(async raw => {
    const screen = await capture.screen(raw, terminal.cols, terminal.rows);
    return screen.includes("Working") && screen.includes("Ready") && screen.includes("Installed CLIs:");
  }, 0);
  await capture.capture(terminal, "catalog", sink);
  const auto = terminal.expect(async raw => {
    const screen = await capture.screen(raw, terminal.cols, terminal.rows);
    return !screen.includes("Checking") && !screen.includes("Not checked") && screen.split("\n").filter(line => /^\| [ >] (claude|codex|cursor|omo|omp)\s/.test(line)).length === 6
      && screen.split("\n").at(-1)?.startsWith("+") && (screen.includes("recheck") || screen.includes("c retry"));
  }, 0, 60000);
  const autoFrame = await auto;
  await capture.capture({ raw: autoFrame.raw, cols: terminal.cols, rows: terminal.rows }, "automatic-latest", sink);
  let sawChecking = false;
  const rechecked = terminal.expect(async raw => {
    const screen = await capture.screen(raw, terminal.cols, terminal.rows);
    if (screen.includes("Checking")) sawChecking = true;
    return sawChecking && !screen.includes("Checking")
      && screen.split("\n").filter(line => /^\| [ >] (claude|codex|cursor|omo|omp)\s/.test(line)).length === 6
      && screen.split("\n").at(-1)?.startsWith("+") && (screen.includes("recheck") || screen.includes("c retry"));
  }, terminal.sequence, 60000);
  terminal.write("c");
  const recheckedFrame = await rechecked;
  await capture.capture({ raw: recheckedFrame.raw, cols: terminal.cols, rows: terminal.rows }, "rechecked-latest", sink);
  const orderedRows = (await capture.screen(recheckedFrame.raw, terminal.cols, terminal.rows)).split("\n")
    .filter(line => /^\| [ >] (claude|codex|cursor|omo|omp)\s/.test(line))
    .map(line => line.trim().split(/\s+/).filter(part => part !== ">" && part !== "|") );
  const neighbor = orderedRows[1];
  if (!neighbor) throw new Error("catalog neighbor missing");
  const moved = terminal.expect(async raw => (await capture.screen(raw, terminal.cols, terminal.rows))
    .split("\n").some(line => line.startsWith(`| > ${neighbor[0]}`) && line.includes(neighbor[1])));
  terminal.write("\x1b[B");
  await moved;
  await capture.capture(terminal, "catalog-moved", sink);
  const small = terminal.expect(async raw => {
    const screen = await capture.screen(raw, terminal.cols, terminal.rows);
    return screen.includes("Working") && screen.includes("Ready") && screen.includes("omo");
  });
  terminal.resize(80, 24);
  await small;
  await capture.capture(terminal, "catalog-small", sink);
  const omoIndex = orderedRows.findIndex(row => row[0] === "omo");
  if (omoIndex < 0) throw new Error("omo installation missing");
  let selectedIndex = 1;
  while (selectedIndex !== omoIndex) {
    const nextIndex = selectedIndex + (selectedIndex < omoIndex ? 1 : -1);
    const moved = terminal.expect(async raw => {
      const screen = await capture.screen(raw, terminal.cols, terminal.rows);
      const row = orderedRows[nextIndex];
      return screen.split("\n").some(line => line.startsWith(`| > ${row[0]}`) && line.includes(row[1]))
        && screen.split("\n").at(-1)?.startsWith("+");
    });
    terminal.write(selectedIndex < omoIndex ? "\x1b[B" : "\x1b[A");
    await moved;
    selectedIndex = nextIndex;
  }
  const refused = terminal.expect(async raw => {
    const screen = await capture.screen(raw, terminal.cols, terminal.rows);
    return screen.includes("omo: update unavailable") && screen.includes("runner/native not connected")
      && screen.split("\n").at(-1)?.startsWith("+");
  });
  terminal.write("\r");
  const refusalFrame = await refused;
  await capture.capture({ raw: refusalFrame.raw, cols: terminal.cols, rows: terminal.rows }, "omo-update-unavailable", sink);
  const jobs = await client.request({ operation: "jobs" });
  if (!jobs.ok || jobs.result.jobs.length !== 0) throw new Error("unexpected mutation during unavailable selection");
  await sink("jobs-after-refusal.json", JSON.stringify(jobs, null, 2));
  console.log(JSON.stringify({ status: "PASS", evidence, sessions: sessions.result.sessions.length }));
} catch (error) {
  if (terminal && capture) await capture.capture(terminal, "failure", sink);
  console.error(JSON.stringify({ status: "FAIL", evidence, error: String(error) }));
  throw error;
} finally {
  client?.close();
  const terminalCleanup = await terminal?.close();
  const browserCleanup = await capture?.close();
  await worker?.stop();
  await rm(root, { recursive: true, force: true });
  await sink("cleanup.json", JSON.stringify({ terminalCleanup, browserCleanup, rootRemoved: true }, null, 2));
}
