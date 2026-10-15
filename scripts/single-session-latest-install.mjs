import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "/Users/beomseok/.local/share/herdr-cli-updater/single-session-5.1.21";
const prefix = join(root, "prefix"), home = join(root, "installer-home");
mkdirSync(home, { recursive: true, mode: 0o700 });
const manager = "/private/tmp/herdr-native-519-tools/bun-darwin-aarch64/bun";
const env = { HOME: home, BUN_INSTALL: prefix, BUN_CONFIG_REGISTRY: "https://registry.npmjs.org",
  PATH: "/opt/homebrew/Cellar/bun/1.3.6/bin:/Users/beomseok/.nvm/versions/node/v24.20.0/bin:/usr/bin:/bin" };
const child = Bun.spawn([manager, "add", "-g", "omo-ai@5.1.21", "--trust"], {
  cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
]);
writeFileSync(join(root, "install.json"), JSON.stringify({ exitCode, stdout, stderr }), { mode: 0o600 });
if (exitCode !== 0) throw new Error("Single-session latest install failed");
const entry = join(prefix, "install/global/node_modules/omo-ai/bin/omo.js");
const version = Bun.spawn(["/opt/homebrew/Cellar/bun/1.3.6/bin/bun", entry, "--version"], {
  cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
const [versionOut, versionErr, versionExit] = await Promise.all([
  new Response(version.stdout).text(), new Response(version.stderr).text(), version.exited,
]);
const manifest = JSON.parse(readFileSync(join(prefix, "install/global/node_modules/omo-ai/package.json")));
writeFileSync(join(root, "version.json"), JSON.stringify({ exitCode: versionExit, stdout: versionOut, stderr: versionErr, entry,
  engine: manifest.dependencies["@code-yeongyu/senpi"] }), { mode: 0o600 });
if (versionExit !== 0 || !versionOut.startsWith("omo 5.1.21 (engine: senpi ")) throw new Error("Single-session latest version failed");
console.log(`SINGLE_SESSION_LATEST_INSTALLED ${versionOut.trim()}`);
