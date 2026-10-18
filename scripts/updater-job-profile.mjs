import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installedProfile } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/bootstrap.mjs";
import { preparedNativeRecipe } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/normalize.mjs";
import { homedir } from "node:os";

const root = `${homedir()}/.local/share/herdr-cli-updater/updater-single-job`;
const prefix = join(root, "prefix"), cwd = `${homedir()}/Desktop/herdr-cli-updater`;
const installation = JSON.parse(readFileSync(join(root, "evidence/installation.json")));
const image = JSON.parse(readFileSync(join(root, "latest-image.json")));
const exec = join(import.meta.dirname, "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution");
const old = join(import.meta.dirname, "../.omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/inputs");
process.env.ONE_FAMILY_BEFORE_ACQUISITION = join(old, "acquisition.json");
process.env.ONE_FAMILY_BEFORE_ALIASES = join(old, "alias-closure.json");
process.env.ONE_FAMILY_TARGET_RUNTIME = `${homedir()}/.local/share/herdr-cli-updater/worker-preparations/omo-mJsivd/omo-runtime.json`;
const recipe = preparedNativeRecipe("/private/tmp/herdr-prompt-preset-native-519-r6/preparation.json");
const runtimePath = realpathSync("/opt/homebrew/bin/bun"), runtime = { path: runtimePath,
  sha256: createHash("sha256").update(readFileSync(runtimePath)).digest("hex") };
const session = { file: `${homedir()}/.omo/agent/sessions/${homedir().replaceAll("/", "-")}-Desktop-herdr-cli-updater--/2026-10-04T08-32-32-636Z_01a1060b-177c-76fe-8a60-d572826dd9e6.jsonl`,
  fullId: "01a1060b-177c-76fe-8a60-d572826dd9e6", cwd };
const environment = { ...installation.environment,
  HERDR_NATIVE_SENPI_ROOT: join(prefix, "install/global/node_modules/@code-yeongyu/senpi"),
  HERDR_NATIVE_OMO_PLUGIN: join(prefix, "install/global/node_modules/omo-ai/plugin"),
  OMO_RUNTIME: "bun", SENPI_RUNTIME: "bun", TERM: "xterm-256color", SHELL: "/bin/zsh",
  HERDR_SOCKET: `${homedir()}/.config/herdr/herdr.sock`,
  OMO_CODING_AGENT_DIR: `${homedir()}/.omo/agent`, SENPI_CODING_AGENT_DIR: `${homedir()}/.omo/agent`,
  PI_CODING_AGENT_DIR: `${homedir()}/.omo/agent` };
const semantic = ["--extension", join(prefix, "install/global/node_modules/omo-ai/plugin"), "--offline", "--session", session.file];
const child = Bun.spawn([runtime.path, join(import.meta.dirname, "updater-job-options.mjs"), prefix, cwd, session.file, ...semantic], {
  cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
if (exitCode !== 0) throw new Error(`Original effective options: ${stderr}`);
const before = installedProfile({ paths: { prefix } }, recipe, recipe.sourceBinding,
  { manager: runtime, env: environment }, session, [], JSON.parse(stdout));
const latestReceipt = JSON.parse(readFileSync(image.recipePath));
const after = { ...before, qualification: { ...before.qualification, source_revision: latestReceipt.sourceBinding.sha256 },
  closure: before.closure.map(pin => {
    if (pin.path === runtime.path) return pin;
    const output = image.independentTargetPins.find(row => row.path === pin.path);
    if (!output) throw new Error(`Independent latest profile pin missing: ${pin.path}`);
    return { path: output.path, sha256: output.sha256 };
  }), bridge_sha256: image.independentTargetPins.find(row => row.path.endsWith("/dist/core/updater-native-bridge.js"))?.sha256 };
if (!after.bridge_sha256) throw new Error("Latest bridge pin missing");
const socket = `${homedir()}/.config/herdr/herdr.sock`;
const operationRoot = join(`${homedir()}/.config/herdr`, `updater-operations-${createHash("sha256").update(socket).digest("hex")}`);
const profiles = join(operationRoot, "profiles");
mkdirSync(profiles, { recursive: true, mode: 0o700 });
writeFileSync(join(profiles, "actual-job-521-r2-before.json"), JSON.stringify(before), { flag: "wx", mode: 0o600 });
writeFileSync(join(profiles, "actual-job-521-r2-after.json"), JSON.stringify(after), { flag: "wx", mode: 0o600 });
writeFileSync(join(root, "profile.json"), JSON.stringify({ beforeProfile: "actual-job-521-r2-before", afterProfile: "actual-job-521-r2-after",
  pane: "w1V:p1", session, environment, runtime, operationRoot }), { mode: 0o600 });
console.log("UPDATER_ACTUAL_SESSION_PROFILES_PREPARED same conversation; no session started");
