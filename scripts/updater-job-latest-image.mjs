import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { preparedNativeRecipe } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/normalize.mjs";
import { installOriginal } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/install.mjs";

const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const beforePrefix = join(root, "prefix"), imagePrefix = join(root, "latest-image"), secondPrefix = join(root, "latest-independent");
const revision = Date.now();
const priorLockPath = join(imagePrefix, "install/global/bun.lock");
const topologyLock = process.argv.includes("--preserve-topology") ? Bun.JSON5.parse(readFileSync(priorLockPath, "utf8")) : null;
const topologyWorkspace = topologyLock ? readFileSync(join(imagePrefix, "install/global/package.json")) : null;
if (topologyLock) {
  const baselineModules = join(beforePrefix, "install/global/node_modules");
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bun") continue;
      const path = join(directory, entry.name), manifestPath = join(path, "package.json");
      if (existsSync(manifestPath)) {
        const pkg = JSON.parse(readFileSync(manifestPath));
        const slot = relative(baselineModules, path).replaceAll("/node_modules/", "/");
        if (relative(baselineModules, path).includes("/node_modules/") && !topologyLock.packages[slot]) {
          const target = Object.values(topologyLock.packages).find(row => row[0] === `${pkg.name}@${pkg.version}`)
            ?? topologyLock.packages[pkg.name];
          if (!target || !target[0].startsWith(`${pkg.name}@`)) throw new Error(`Target slot unavailable: ${slot}`);
          topologyLock.packages[slot] = structuredClone(target);
        }
        if (existsSync(join(path, "node_modules"))) visit(join(path, "node_modules"));
      } else if (entry.name.startsWith("@")) visit(path);
    }
  };
  visit(baselineModules);
}
for (const path of [imagePrefix, secondPrefix, join(root, "latest-image.json")]) {
  if (existsSync(path)) renameSync(path, `${path}.history-${revision}`);
}
const home = join(root, "latest-installer-home");
mkdirSync(home, { recursive: true, mode: 0o700 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pin = path => ({ path: realpathSync(path), sha256: hash(readFileSync(path)) });
process.env.ONE_FAMILY_TARGET_RUNTIME = "/Users/beomseok/.local/share/herdr-cli-updater/worker-preparations/omo-mJsivd/omo-runtime.json";
const old = join(import.meta.dirname, "../.omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/inputs");
process.env.ONE_FAMILY_BEFORE_ACQUISITION = join(old, "acquisition.json");
process.env.ONE_FAMILY_BEFORE_ALIASES = join(old, "alias-closure.json");
process.env.UPDATER_JOB_LATEST_ACQUISITION = join(root, "acquisition/acquisition.json");
const recipe = preparedNativeRecipe("/private/tmp/herdr-updater-native-521/preparation.json");
const rows = [...recipe.acquisitionArtifacts.filter(row => !recipe.artifacts.some(overlay => overlay.name === row.name && overlay.version === row.version)), ...recipe.artifacts];
const beforeInstall = JSON.parse(readFileSync(join(root, "evidence/installation.json")));
const manager = beforeInstall.manager;
const environment = { HOME: home, BUN_INSTALL: imagePrefix,
  PATH: "/opt/homebrew/Cellar/bun/1.3.6/bin:/Users/beomseok/.nvm/versions/node/v24.20.0/bin:/usr/bin:/bin" };
if (topologyLock) {
  mkdirSync(join(imagePrefix, "install/global"), { recursive: true, mode: 0o700 });
  writeFileSync(join(imagePrefix, "install/global/package.json"), topologyWorkspace);
  writeFileSync(join(imagePrefix, "install/global/bun.lock"), JSON.stringify(topologyLock));
}
const first = await installOriginal(rows, recipe.target.version, manager, root, environment, AbortSignal.timeout(600000), !!topologyLock);
if (first.exitCode !== 0) throw new Error(`Latest native image install: ${first.stderr}`);
const global = join(imagePrefix, "install/global"), independentGlobal = join(secondPrefix, "install/global");
mkdirSync(independentGlobal, { recursive: true, mode: 0o700 });
writeFileSync(join(independentGlobal, "package.json"), readFileSync(join(global, "package.json")));
writeFileSync(join(independentGlobal, "bun.lock"), readFileSync(join(global, "bun.lock")));
const second = await installOriginal(rows, recipe.target.version, manager, root, { ...environment, BUN_INSTALL: secondPrefix }, AbortSignal.timeout(600000), true);
if (second.exitCode !== 0) throw new Error(`Independent latest native image install: ${second.stderr}`);
const pins = [], walk = directory => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), info = lstatSync(path);
    if (info.isDirectory()) walk(path);
    else if (info.isFile()) {
      const actual = join(imagePrefix, relative(secondPrefix, path));
      const independent = pin(path), observed = pin(actual);
      if (independent.sha256 !== observed.sha256) throw new Error(`Independent package mismatch: ${relative(secondPrefix, path)}`);
      pins.push({ path: join(beforePrefix, relative(secondPrefix, path)), sha256: independent.sha256, source: independent });
    }
  }
};
walk(join(secondPrefix, "install/global/node_modules"));
for (const name of ["install/global/package.json", "install/global/bun.lock", "bin/omo"]) {
  const actualBytes = readFileSync(join(imagePrefix, name), "utf8");
  const independentBytes = readFileSync(join(secondPrefix, name), "utf8").replaceAll(secondPrefix, imagePrefix).replaceAll(second.registryOrigin, first.registryOrigin);
  if (name.endsWith("bun.lock") ? JSON.stringify(Bun.JSON5.parse(actualBytes)) !== JSON.stringify(Bun.JSON5.parse(independentBytes)) : actualBytes !== independentBytes)
    throw new Error(`Independent original output mismatch: ${name}`);
  pins.push({ path: join(beforePrefix, name), sha256: hash(actualBytes.replaceAll(imagePrefix, beforePrefix)),
    source: pin(join(imagePrefix, name)), projection: "owned-prefix-rebase" });
}
writeFileSync(join(root, "latest-image.json"), JSON.stringify({ prefix: imagePrefix, independentPrefix: secondPrefix, manager,
  environment, registryOrigin: first.registryOrigin, independentTargetPins: pins, recipePath: "/private/tmp/herdr-updater-native-521/preparation.json" }), { mode: 0o600 });
console.log(`UPDATER_LATEST_IMAGE_VERIFIED ${pins.length} exact independent outputs`);
