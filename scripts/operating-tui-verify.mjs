import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTerminal, openTerminalCapture } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/terminal.mjs";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/operating-native/evidence/ui";
mkdirSync(root, { recursive: true, mode: 0o700 });
const signal = AbortSignal.timeout(180000);
const started = performance.now();
const terminal = startTerminal(["bun", join(import.meta.dirname, "plugin.ts"), "tui"], join(import.meta.dirname, ".."),
  { ...process.env, HERDR_SOCKET: "/Users/beomseok/.config/herdr/herdr.sock" }, signal);
const capture = await openTerminalCapture({ paths: { tmp: root } }, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", process.env);
const sink = async (name, bytes) => { writeFileSync(join(root, name), bytes, { mode: 0o600 }); return join(root, name); };
const complete = async raw => {
  const frame = await capture.screen(raw, terminal.cols, terminal.rows);
  return frame.includes("Up/Down choose") && /omo\s+5\.1\.19\s+5\.1\.19/.test(frame)
    && !frame.includes("Checking") && !frame.includes("Not checked");
};
try {
  const ready = await complete(terminal.raw) ? { raw: terminal.raw } : await terminal.expect(complete, 0, 60000);
  const readyMs = Math.round(performance.now() - started);
  const desktop = await capture.capture({ raw: ready.raw, cols: terminal.cols, rows: terminal.rows }, "operating-desktop", sink);
  const narrowReady = terminal.expect(complete, terminal.sequence, 30000);
  terminal.resize(70, 38);
  const resized = await narrowReady;
  const narrow = await capture.capture({ raw: resized.raw, cols: terminal.cols, rows: terminal.rows }, "operating-narrow", sink);
  writeFileSync(join(root, "timing.json"), JSON.stringify({ readyMs }), { mode: 0o600 });
  console.log(JSON.stringify({ status: "OPERATING_TUI_CAPTURED", readyMs, desktop: desktop.screenText, narrow: narrow.screenText }));
} finally { await terminal.close(); await capture.close(); }
