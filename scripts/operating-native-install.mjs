import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { preparedNativeRecipe } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/normalize.mjs";
import { acquiredClosure, installOriginal } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/install.mjs";

const root = process.env.OPERATING_NATIVE_ROOT ?? "/Users/beomseok/.local/share/herdr-cli-updater/operating-native";
const prefix = join(root, process.env.OPERATING_NATIVE_PREFIX_NAME ?? "prefix");
const evidence = join(root, "evidence");
mkdirSync(evidence, { recursive: true, mode: 0o700 });
process.env.ONE_FAMILY_TARGET_RUNTIME = "/Users/beomseok/.local/share/herdr-cli-updater/worker-preparations/omo-mJsivd/omo-runtime.json";
const acquired = join(import.meta.dirname, "../.omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/inputs");
process.env.ONE_FAMILY_BEFORE_ACQUISITION = join(acquired, "acquisition.json");
process.env.ONE_FAMILY_BEFORE_ALIASES = join(acquired, "alias-closure.json");
const recipe = preparedNativeRecipe(process.env.OPERATING_NATIVE_PREPARATION ?? "/private/tmp/herdr-session-restart-native-519-r3/preparation.json");
const acquisition = JSON.parse(readFileSync(process.env.ONE_FAMILY_BEFORE_ACQUISITION, "utf8"));
const aliases = JSON.parse(readFileSync(process.env.ONE_FAMILY_BEFORE_ALIASES, "utf8"));
for (const artifact of recipe.acquisitionArtifacts) {
  if (!acquisition.records.some(row => row.name === artifact.name && row.version === artifact.version))
    acquisition.records.push(artifact);
}
const rows = acquiredClosure(acquisition, aliases, recipe.artifacts, recipe.target.version, recipe.acquisitionArtifacts);
for (const row of [...acquisition.records, ...aliases.records]) {
  if (!rows.some(item => item.name === row.name && item.version === row.version)) rows.push(row);
}
const managerPath = "/private/tmp/herdr-native-519-tools/bun-darwin-aarch64/bun";
const manager = { path: managerPath, sha256: createHash("sha256").update(readFileSync(managerPath)).digest("hex") };
const environment = { HOME: "/Users/beomseok", BUN_INSTALL: prefix,
  PATH: "/opt/homebrew/Cellar/bun/1.3.6/bin:/Users/beomseok/.nvm/versions/node/v24.20.0/bin:/Users/beomseok/.local/bin:/opt/homebrew/bin:/usr/bin:/bin" };
const installReceipt = join(evidence, process.env.OPERATING_NATIVE_INSTALL_RECEIPT ?? "original-install.json");
if (!existsSync(installReceipt)) {
  const installed = await installOriginal(rows, recipe.target.version, manager, root, environment, AbortSignal.timeout(300000));
  writeFileSync(installReceipt, JSON.stringify(installed), { flag: "wx", mode: 0o600 });
}
const result = readFileSync(installReceipt, "utf8");
if (JSON.parse(result).exitCode !== 0) throw new Error("Original install did not succeed");
const postinstall = JSON.parse(readFileSync(join(import.meta.dirname,
  "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/runs/54e263b4-ae58-4ef4-95c9-3ad4f4ca55a2/final-postinstall-hashes.json"), "utf8"));
const independent = process.env.OPERATING_NATIVE_INDEPENDENT
  ? JSON.parse(readFileSync(process.env.OPERATING_NATIVE_INDEPENDENT, "utf8")) : null;
for (const file of recipe.targetFiles) {
  const installed = join(prefix, "install/global/node_modules", file.packageName, file.relativePath);
  const observed = createHash("sha256").update(readFileSync(installed)).digest("hex");
  const originalOutput = independent
    ? independent.independentTargetPins.filter(row => row.path.endsWith(`/node_modules/${file.packageName}/${file.relativePath}`))
      .map(row => ({ expected: row.sha256, observed: row.sha256 }))[0]
    : postinstall.find(row => row.path.endsWith(`/node_modules/${file.packageName}/${file.relativePath}`));
  if (observed !== file.source.sha256 && !(originalOutput?.expected === observed && originalOutput.observed === observed))
    throw new Error(`Native installed output differs: ${file.packageName}/${file.relativePath}`);
}
writeFileSync(join(evidence, "installation.json"), JSON.stringify({ prefix, manager, environment,
  sourceBinding: recipe.sourceBinding, artifacts: recipe.artifacts }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ status: "OPERATING_NATIVE_INSTALLED", version: recipe.target.version, prefix }));
