import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, realpathSync, copyFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import { preparedNativeRecipe } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/normalize.mjs";
import { acquiredClosure, installOriginal } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/install.mjs";
import { homedir } from "node:os";

const operating = `${homedir()}/.local/share/herdr-cli-updater/operating-native/prefix-r6`;
const prefix = "/private/tmp/herdr-operating-r6-frozen-after-image";
const acquired = join(import.meta.dirname, "../.omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/inputs");
process.env.ONE_FAMILY_TARGET_RUNTIME = `${homedir()}/.local/share/herdr-cli-updater/worker-preparations/omo-mJsivd/omo-runtime.json`;
process.env.ONE_FAMILY_BEFORE_ACQUISITION = join(acquired, "acquisition.json");
process.env.ONE_FAMILY_BEFORE_ALIASES = join(acquired, "alias-closure.json");
const recipe = preparedNativeRecipe("/private/tmp/herdr-prompt-preset-native-519-r6/preparation.json");
const acquisition = JSON.parse(readFileSync(process.env.ONE_FAMILY_BEFORE_ACQUISITION));
const aliases = JSON.parse(readFileSync(process.env.ONE_FAMILY_BEFORE_ALIASES));
for (const row of recipe.acquisitionArtifacts) if (!acquisition.records.some(a => a.name === row.name && a.version === row.version)) acquisition.records.push(row);
const rows = acquiredClosure(acquisition, aliases, recipe.artifacts, recipe.target.version, recipe.acquisitionArtifacts);
for (const row of [...acquisition.records, ...aliases.records]) if (!rows.some(a => a.name === row.name && a.version === row.version)) rows.push(row);
mkdirSync(join(prefix, "install/global"), { recursive: true, mode: 0o700 });
for (const name of ["package.json", "bun.lock"]) copyFileSync(join(operating, "install/global", name), join(prefix, "install/global", name));
const installation = JSON.parse(readFileSync(`${homedir()}/.local/share/herdr-cli-updater/operating-native/evidence/installation.json`));
const env = { ...installation.environment, BUN_INSTALL: prefix };
const result = await installOriginal(rows, recipe.target.version, installation.manager, prefix, env, AbortSignal.timeout(300000), true);
writeFileSync(join(prefix, "original-install.json"), JSON.stringify(result), { mode: 0o600 });
const launchCheck = Bun.spawn(["/opt/homebrew/bin/bun", join(prefix, "install/global/node_modules/omo-ai/bin/omo.js"), "--version"],
  { env: { ...env, OMO_RUNTIME: "bun", PATH: `/opt/homebrew/bin:${env.PATH}` }, stdout: "pipe", stderr: "pipe" });
const [versionOut, versionErr, versionExit] = await Promise.all([new Response(launchCheck.stdout).text(), new Response(launchCheck.stderr).text(), launchCheck.exited]);
if (versionExit !== 0) throw new Error(`Independent original launcher failed: ${versionErr}`);
writeFileSync(join(prefix, "original-launch.json"), JSON.stringify({ versionOut, versionErr, versionExit }), { mode: 0o600 });
const pins = [], hash = bytes => createHash("sha256").update(bytes).digest("hex");
function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), info = lstatSync(path);
    if (info.isDirectory()) walk(path);
    else if (info.isFile()) pins.push({ path: realpathSync(path), sha256: hash(readFileSync(path)) });
  }
}
walk(join(prefix, "install/global/node_modules"));
const operatingOrigin = JSON.parse(readFileSync(`${homedir()}/.local/share/herdr-cli-updater/operating-native/evidence/original-install-r6-pinned.json`)).registryOrigin;
for (const name of ["install/global/package.json", "install/global/bun.lock", "bin/omo"]) {
  const path = join(prefix, name);
  const observed = readFileSync(path, "utf8");
  const projected = observed.replaceAll(prefix, operating).replaceAll(result.registryOrigin, operatingOrigin);
  const actual = readFileSync(join(operating, name), "utf8");
  if (name.endsWith("bun.lock")) {
    if (JSON.stringify(Bun.JSON5.parse(projected)) !== JSON.stringify(Bun.JSON5.parse(actual))) throw new Error("Independent frozen lock graph mismatch");
    // Original lock formatting is preserved separately; the graph is independently regenerated.
    pins.push({ path, sha256: hash(actual), projection: "equal-original-lock-graph" });
  } else {
    if (projected !== actual) throw new Error(`Independent original output mismatch: ${name}`);
    pins.push({ path, sha256: hash(projected), projection: "owned-prefix-rebase" });
  }
}
for (const reference of pins.filter(row => row.path.includes("/node_modules/"))) {
  const actual = join(operating, relative(prefix, reference.path));
  if (hash(readFileSync(actual)) !== reference.sha256) throw new Error(`Independent package output mismatch: ${actual}`);
}
writeFileSync(join(prefix, "after-image.json"), JSON.stringify({ prefix, independentTargetPins: pins, sourceBinding: recipe.sourceBinding,
  originalInstaller: result, projection: "Only owned-prefix, transport origin, and original lock formatting rebased after exact graph comparison" }), { mode: 0o600 });
console.log(JSON.stringify({ status: "OPERATING_INDEPENDENT_FROZEN_IMAGE_VERIFIED", receipt: join(prefix, "after-image.json"), files: pins.length }));
