import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const info = JSON.parse(readFileSync(join(root, "profile.json")));
if (info.pane !== "w2A:p1") throw new Error("Unexpected original test pane");
info.pane = "w2B:p1";
writeFileSync(join(root, "profile.json"), JSON.stringify(info), { mode: 0o600 });
const connection = { native_abi: 4, native_launch_v1: true, operations_directory: info.operationRoot,
  profiles_directory: join(info.operationRoot, "profiles") };
const child = Bun.spawn(["bun", join(import.meta.dirname, "plugin.ts"), "launch", info.pane, info.beforeProfile], {
  cwd: info.session.cwd, env: { ...info.environment, HERDR_SOCKET: "/Users/beomseok/.config/herdr/herdr.sock",
    HERDR_UPDATER_CONNECTION_JSON: JSON.stringify(connection) }, stdout: "pipe", stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
]);
writeFileSync(join(root, "managed-launch.json"), JSON.stringify({ exitCode, stdout, stderr }), { mode: 0o600 });
if (exitCode !== 0) throw new Error(`Actual updater managed launch failed: ${stderr}`);
console.log(stdout.trim());
