import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreRequest } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/run.mjs";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const profile = JSON.parse(readFileSync(join(root, "profile.json")));
const socket = "/Users/beomseok/.config/herdr/herdr.sock";
const preparing = process.argv.includes("--prepare-only");
const workspace = preparing ? await coreRequest(socket, "workspace.create", { cwd: profile.session.cwd,
  label: "updater 단일 대화 검증", focus: false }, AbortSignal.timeout(10000)) : null;
if (workspace) {
  profile.pane = workspace.root_pane.pane_id;
  writeFileSync(join(root, "profile.json"), JSON.stringify(profile), { mode: 0o600 });
  console.log(`UPDATER_TRIAL_PANE_PREPARED ${profile.pane}`);
  process.exit(0);
}
const processes = await coreRequest(socket, "pane.process_info", { pane_id: profile.pane }, AbortSignal.timeout(10000));
if (processes.process_info.foreground_processes.length !== 1 || processes.process_info.foreground_processes[0].name !== "zsh")
  throw new Error("Prepared pristine shell not ready");
const connection = { native_abi: 4, native_launch_v1: true, operations_directory: profile.operationRoot,
  profiles_directory: join(profile.operationRoot, "profiles") };
const child = Bun.spawn(["bun", join(import.meta.dirname, "plugin.ts"), "launch", profile.pane, profile.beforeProfile], {
  cwd: profile.session.cwd, env: { ...profile.environment, HERDR_SOCKET: socket, HERDR_UPDATER_CONNECTION_JSON: JSON.stringify(connection) },
  stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
writeFileSync(join(root, `pristine-restore-${Date.now()}.json`), JSON.stringify({ workspace, stdout, stderr, status }), { mode: 0o600 });
if (status !== 0) throw new Error(`Pristine launch failed: ${stderr}`);
console.log(`UPDATER_CONVERSATION_READY ${profile.pane} ${profile.session.fullId}`);
