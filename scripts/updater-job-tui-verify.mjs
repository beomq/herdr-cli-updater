import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTerminal, openTerminalCapture, bounded } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/terminal.mjs";
import { attachAuthenticatedWorker } from "../src/service/client.ts";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const profile = JSON.parse(readFileSync(join(root, "profile.json")));
const output = join(root, "tui");
mkdirSync(output, { recursive: true, mode: 0o700 });
const signal = AbortSignal.timeout(360000);
const terminal = startTerminal(["bun", join(import.meta.dirname, "plugin.ts"), "tui"], join(import.meta.dirname, ".."),
  { ...process.env, HERDR_SOCKET: "/Users/beomseok/.config/herdr/herdr.sock" }, signal);
const capture = await openTerminalCapture({ paths: { tmp: output } }, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", process.env);
let rendering = Promise.resolve();
const render = raw => {
  const result = rendering.then(() => capture.screen(raw, terminal.cols, terminal.rows));
  rendering = result.then(() => undefined);
  return result;
};
const screen = () => render(terminal.raw);
const wait = async predicate => {
  let matched;
  const event = terminal.expect(async raw => {
    const frame = await render(raw);
    if (!predicate(frame)) return false;
    matched = frame;
    return true;
  }, terminal.sequence, 60000);
  void event.catch(() => undefined);
  const first = await screen();
  if (predicate(first)) return first;
  await event;
  return matched;
};
const key = async (input, predicate) => {
  const after = terminal.sequence;
  const event = terminal.expect(async raw => predicate(await render(raw)), after, 60000);
  terminal.write(input);
  await event;
};
const sink = async (name, bytes) => writeFileSync(join(output, name), bytes, { mode: 0o600 });
const client = await attachAuthenticatedWorker("/Users/beomseok/.local/share/herdr-cli-updater/worker", 15000);
let subscription;
try {
  const originalJobs = await client.request({ operation: "jobs" });
  if (!originalJobs.ok) throw new Error("Existing jobs unavailable");
  const oldJobs = new Set(originalJobs.result.jobs.map(j => j.jobId));
  let frame = await wait(frame => /omo\s+5\.1\.19\s+5\.1\.21/.test(frame)
    && !frame.includes("Checking") && !frame.includes("Not checked"));
  console.log("UPDATER_TUI_CATALOG_READY");
  await capture.capture({ raw: terminal.raw, cols: terminal.cols, rows: terminal.rows }, "updater-catalog", sink);
  const rows = frame.split("\n").filter(line => /^\|\s*[> ]\s*(claude|codex|omo|omp|cursor)\s/.test(line));
  const rowIndex = rows.findIndex(row => /omo\s+5\.1\.19\s+5\.1\.21/.test(row));
  if (rowIndex < 0) throw new Error("Actual updater baseline installation absent");
  for (let index = 0; index < rowIndex; index++) await key("\x1b[B", next => {
    const row = next.split("\n").filter(line => /^\|\s*[> ]\s*(claude|codex|omo|omp|cursor)\s/.test(line))[index + 1];
    return !!row && /^\|\s*>/.test(row);
  });
  await key("\r", next => next.includes("Choose update"));
  console.log("UPDATER_TUI_CHOOSING");
  await key("m", next => next.includes("Mode: update and restart"));
  await key(" ", next => next.includes("1 panes selected"));
  if (!(await screen()).includes(profile.pane)) throw new Error("Actual conversation target not shown");
  await capture.capture({ raw: terminal.raw, cols: terminal.cols, rows: terminal.rows }, "updater-choice", sink);
  await key("\r", next => next.includes("Enter start update"));
  await capture.capture({ raw: terminal.raw, cols: terminal.cols, rows: terminal.rows }, "updater-confirm", sink);
  const settled = Promise.withResolvers();
  const completed = bounded(settled.promise, signal);
  void completed.catch(() => undefined);
  subscription = await client.subscribe({ incarnation: client.incarnation, sequence: "current" }, {
    event: event => {
      const response = event.response;
      if (!response.ok || response.operation !== "inspect-job") return;
      const job = response.result.job;
      if (oldJobs.has(job.jobId)) return;
      console.log(`UPDATER_JOB_PROGRESS ${job.jobId} ${job.status} ${job.installTxn.state}`);
      const settledRecovery = job.status === "recovery_required"
        && (job.installTxn.state === "recovery_required" || job.targetTxns.some(target => target.state === "recovery_required"));
      if (["completed", "failed", "cancelled"].includes(job.status) || settledRecovery) settled.resolve(job);
    },
    error: error => settled.reject(error),
  });
  // User explicitly authorized this single update-and-restart test.
  const jobEvent = terminal.expect(async raw => {
    const next = await render(raw);
    return next.includes("Job") && !next.includes("Enter start update");
  }, terminal.sequence, 60000);
  terminal.write("\r");
  await jobEvent;
  const jobs = await client.request({ operation: "jobs" });
  if (!jobs.ok) throw new Error("Submitted updater job unavailable");
  const created = jobs.result.jobs.filter(job => !oldJobs.has(job.jobId));
  if (created.length !== 1 || created[0].mode !== "update-and-restart"
    || created[0].selectedTargets.length !== 1 || created[0].selectedTargets[0].expectedBinding.paneId !== profile.pane)
    throw new Error("Exact updater job not submitted");
  writeFileSync(join(root, "actual-job.json"), JSON.stringify(created[0]), { mode: 0o600 });
  await capture.capture({ raw: terminal.raw, cols: terminal.cols, rows: terminal.rows }, "updater-job", sink);
  console.log(`UPDATER_JOB_SUBMITTED ${created[0].jobId}`);
  const finalJob = await completed;
  writeFileSync(join(root, "actual-job-terminal.json"), JSON.stringify(finalJob), { mode: 0o600 });
  await capture.capture({ raw: terminal.raw, cols: terminal.cols, rows: terminal.rows }, "updater-final", sink);
  console.log(`UPDATER_JOB_SETTLED ${finalJob.jobId} ${finalJob.status}`);
} catch (error) {
  await capture.capture({ raw: terminal.raw, cols: terminal.cols, rows: terminal.rows }, "updater-error", sink);
  throw error;
} finally { subscription?.close(); client.close(); await terminal.close(); await capture.close(); }
