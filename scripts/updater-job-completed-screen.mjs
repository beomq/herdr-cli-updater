import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTerminal, openTerminalCapture } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/terminal.mjs";
import { homedir } from "node:os";
const root = `${homedir()}/.local/share/herdr-cli-updater/updater-single-job`;
const output = join(root, "tui");
const job = JSON.parse(readFileSync(join(root, "actual-job.json")));
const terminal = startTerminal(["bun", join(import.meta.dirname, "plugin.ts"), "tui"], join(import.meta.dirname, ".."),
  { ...process.env, HERDR_SOCKET: `${homedir()}/.config/herdr/herdr.sock` }, AbortSignal.timeout(120000));
const capture = await openTerminalCapture({ paths: { tmp: output } }, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", process.env);
let rendering = Promise.resolve();
const render = raw => {
  const next = rendering.then(() => capture.screen(raw, terminal.cols, terminal.rows));
  rendering = next.then(() => undefined);
  return next;
};
async function observe(predicate, key) {
  const event = terminal.expect(async raw => predicate(await render(raw)), terminal.sequence, 60000);
  void event.catch(() => undefined);
  if (key) terminal.write(key);
  else if (predicate(await render(terminal.raw))) return;
  await event;
}
try {
  await observe(frame => frame.includes("Discovery failed") || frame.includes("Installed CLIs:"));
  if (process.argv.includes("--catalog")) {
    await observe(frame => frame.includes("Installed CLIs:") && /omo\s+5\.1\.21/.test(frame));
    await capture.capture({ raw: terminal.raw, cols: terminal.cols, rows: terminal.rows }, "updater-restored-catalog", async (name, body) =>
      writeFileSync(join(output, name), body, { mode: 0o600 }));
    console.log("UPDATER_CATALOG_SCREEN_VERIFIED");
  }
  console.log("UPDATER_COMPLETED_VIEW_READY");
  await observe(frame => frame.includes("JOBS 1"), "2");
  console.log("UPDATER_COMPLETED_JOBS_READY");
  await observe(frame => frame.includes("persisted: completed") && frame.includes("Same conversation restart: 1/1 verified"), "\r");
  await capture.capture({ raw: terminal.raw, cols: terminal.cols, rows: terminal.rows }, "updater-completed", async (name, body) =>
    writeFileSync(join(output, name), body, { mode: 0o600 }));
  console.log(`UPDATER_COMPLETED_SCREEN_VERIFIED ${job.jobId}`);
} catch (error) {
  await capture.capture({ raw: terminal.raw, cols: terminal.cols, rows: terminal.rows }, "updater-completed-error", async (name, body) =>
    writeFileSync(join(output, name), body, { mode: 0o600 }));
  throw error;
} finally { await terminal.close(); await capture.close(); }
