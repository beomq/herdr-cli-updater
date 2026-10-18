import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTerminal, openTerminalCapture } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/terminal.mjs";
import { homedir } from "node:os";

const root = `${homedir()}/.local/share/herdr-cli-updater/operating-native/evidence/enter`;
mkdirSync(root, { recursive: true, mode: 0o700 });
const signal = AbortSignal.timeout(120000);
const terminal = startTerminal(["bun", join(import.meta.dirname, "plugin.ts"), "tui"], join(import.meta.dirname, ".."),
  { ...process.env, HERDR_SOCKET: `${homedir()}/.config/herdr/herdr.sock` }, signal);
const capture = await openTerminalCapture({ paths: { tmp: root } }, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", process.env);
const sink = async (name, bytes) => { writeFileSync(join(root, name), bytes, { mode: 0o600 }); };
const screen = raw => capture.screen(raw, terminal.cols, terminal.rows);
const completeFrame = frame => frame.includes("Up/Down choose")
  && /^\|\s+[> ]?\s*omo\s+5\.1\.19\s+5\.1\.19/m.test(frame)
  && !frame.includes("Checking") && !frame.includes("Not checked");
try {
  const completed = async raw => {
    const frame = await screen(raw);
    return completeFrame(frame);
  };
  if (!await completed(terminal.raw)) await terminal.expect(completed, 0, 60000);
  // The actual initial selection is Claude, whose runner is not connected.
  const unavailable = terminal.expect(async raw => {
    const frame = await screen(raw);
    return completeFrame(frame) && frame.includes("runner/native not connected");
  }, terminal.sequence);
  terminal.write("\r");
  const denied = await unavailable;
  await capture.capture({ raw: denied.raw, cols: terminal.cols, rows: terminal.rows }, "enter-no-runner", sink);
  // Select the operating OmO row after the six ordinary installations.
  const rows = ["codex\\s+0\\.153\\.2", "codex\\s+0\\.156\\.0", "omo\\s+5\\.1\\.9", "omp", "cursor", "omo\\s+5\\.1\\.19"];
  for (const row of rows) {
    const selected = terminal.expect(async raw => {
      const frame = await screen(raw);
      return new RegExp(`^\\| > ${row}`, "m").test(frame) && completeFrame(frame);
    }, terminal.sequence);
    terminal.write("\x1b[B");
    await selected;
  }
  const current = terminal.expect(async raw => {
    const frame = await screen(raw);
    return completeFrame(frame) && frame.includes("up-to-date");
  }, terminal.sequence);
  terminal.write("\r");
  const ready = await current;
  await capture.capture({ raw: ready.raw, cols: terminal.cols, rows: terminal.rows }, "enter-current", sink);
  console.log("OPERATING_ENTER_VERIFIED no-runner and up-to-date; no update submitted");
} finally { await terminal.close(); await capture.close(); }
