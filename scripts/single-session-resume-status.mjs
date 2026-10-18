import { writeFileSync } from "node:fs";
import { coreRequest } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/run.mjs";
import { homedir } from "node:os";
const socket = `${homedir()}/.config/herdr/herdr.sock`, pane = "w1V:p1";
const session = "01a1060b-177c-76fe-8a60-d572826dd9e6";
const prefix = `${homedir()}/.local/share/herdr-cli-updater/single-session-5.1.21/prefix`;
const signal = AbortSignal.timeout(10000);
const processes = await coreRequest(socket, "pane.process_info", { pane_id: pane }, signal);
const screen = await coreRequest(socket, "pane.read", { pane_id: pane, source: "visible", lines: 16 }, signal);
const foreground = processes.process_info.foreground_processes.find(p => p.argv?.some(arg => arg.startsWith(prefix))
  && p.argv.includes(session));
const ready = foreground && screen.read.text.includes("Herdr Web UI SSH Connect")
  && screen.read.text.includes("❯") && screen.read.text.includes("~/Desktop/herdr-cli-updater");
if (!ready) { console.log("ONE_SESSION_STARTING"); process.exitCode = 1; }
else {
  writeFileSync(`${homedir()}/.local/share/herdr-cli-updater/single-session-5.1.21/resume.json`,
    JSON.stringify({ pane, session, process: foreground, screen: screen.read.text }), { mode: 0o600 });
  console.log(`ONE_SESSION_RESUMED ${session} pid=${foreground.pid}`);
}
