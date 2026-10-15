import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { preparedNativeRecipe } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/normalize.mjs";
import { targetArtifacts } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/issued-inputs.mjs";

const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const image = JSON.parse(readFileSync(join(root, "latest-image.json")));
const set = JSON.parse(readFileSync("/Users/beomseok/.local/share/herdr-cli-updater/runtime.json"));
const input = JSON.parse(readFileSync(set.configurations.find(row => row.path.startsWith(root + "/")).path));
const prefix = input.coverage.prefix;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
process.env.ONE_FAMILY_TARGET_RUNTIME = "/Users/beomseok/.local/share/herdr-cli-updater/worker-preparations/omo-mJsivd/omo-runtime.json";
const old = join(import.meta.dirname, "../.omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/inputs");
process.env.ONE_FAMILY_BEFORE_ACQUISITION = join(old, "acquisition.json");
process.env.ONE_FAMILY_BEFORE_ALIASES = join(old, "alias-closure.json");
process.env.UPDATER_JOB_LATEST_ACQUISITION = join(root, "acquisition/acquisition.json");
const recipe = preparedNativeRecipe("/private/tmp/herdr-updater-native-521/preparation.json");
const acquired = JSON.parse(readFileSync(join(root, "acquisition/acquisition.json")));
const slots = [], modules = join(image.prefix, "install/global/node_modules");
function walk(directory) {
  for (const row of readdirSync(directory, { withFileTypes: true })) {
    if (!row.isDirectory() || row.name === ".bun") continue;
    const child = join(directory, row.name), manifest = join(child, "package.json");
    if (lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) {
      const pkg = JSON.parse(readFileSync(manifest));
      const vendor = acquired.records.find(record => record.name === pkg.name && record.version === pkg.version);
      if (!vendor) throw new Error(`Original closure missing: ${pkg.name}@${pkg.version}`);
      slots.push({ name: pkg.name, version: pkg.version, installName: relative(modules, child), archive: vendor.archive, metadata: vendor.metadata });
      if (lstatSync(join(child, "node_modules"), { throwIfNoEntry: false })?.isDirectory()) walk(join(child, "node_modules"));
    } else if (row.name.startsWith("@")) walk(child);
  }
}
walk(modules);
const { artifacts } = targetArtifacts(recipe, slots);

// Expected bytes come from both independent original installations and pinned
// archives, never from the installation being verified.
function outputs(sourcePrefix) {
  const workspace = JSON.parse(readFileSync(join(sourcePrefix, "install/global/package.json")));
  const trustedDependencies = workspace.trustedDependencies;
  delete workspace.trustedDependencies;
  const packages = Object.fromEntries([...artifacts].sort((a, b) => a.installName.localeCompare(b.installName)).map(artifact => {
    const pkg = JSON.parse(readFileSync(join(sourcePrefix, "install/global/node_modules", artifact.installName, "package.json")));
    if (pkg.name !== artifact.name || pkg.version !== artifact.version) throw new Error("Independent package identity mismatch");
    const metadata = Object.fromEntries(["dependencies", "optionalDependencies", "peerDependencies", "os", "cpu", "bin"]
      .filter(field => pkg[field] !== undefined).map(field => [field, pkg[field]]));
    const optionalPeers = Object.entries(pkg.peerDependenciesMeta ?? {}).filter(([, value]) => value.optional === true).map(([key]) => key);
    if (optionalPeers.length) metadata.optionalPeers = optionalPeers;
    const archive = artifact.overlay?.archive ?? artifact.archive;
    const archiveBytes = readFileSync(archive.path);
    if (hash(archiveBytes) !== archive.sha256) throw new Error("Independent archive pin mismatch");
    const originalBytes = readFileSync(artifact.metadata.path);
    if (hash(originalBytes) !== artifact.metadata.sha256) throw new Error("Independent metadata pin mismatch");
    const original = JSON.parse(originalBytes);
    return [artifact.installName.replaceAll("/node_modules/", "/"), [`${artifact.name}@${artifact.version}`,
      artifact.overlay ? `file://${archive.path}` : original.dist.tarball, metadata,
      `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`]];
  }));
  const launcher = readFileSync(join(sourcePrefix, "bin/omo"), "utf8").replaceAll(sourcePrefix, prefix)
    .replaceAll("/opt/homebrew/Cellar/bun/1.3.6/bin/bun", image.manager.path);
  return { "install/global/bun.lock": `${JSON.stringify({ lockfileVersion: 1, configVersion: 1,
    workspaces: { "": workspace }, trustedDependencies, packages }, null, 2)}\n`, "bin/omo": launcher };
}
const first = outputs(image.prefix), second = outputs(image.independentPrefix);
for (const [relative, body] of Object.entries(first)) {
  if (body !== second[relative]) throw new Error(`Independent projection mismatch: ${relative}`);
  const row = image.independentTargetPins.find(pin => pin.path === join(prefix, relative));
  if (!row) throw new Error(`Independent target pin missing: ${relative}`);
  row.sha256 = hash(body);
  row.projection = "original-installer-canonical-output";
}
const evidence = join(root, `independent-output-projection-${Date.now()}.json`);
writeFileSync(evidence, JSON.stringify({ manager: image.manager, sourcePrefixes: [image.prefix, image.independentPrefix],
  artifacts, outputs: first }), { flag: "wx", mode: 0o600 });
image.outputProjection = { path: evidence, sha256: hash(readFileSync(evidence)) };
writeFileSync(join(root, "latest-image.json"), JSON.stringify(image), { mode: 0o600 });
console.log("UPDATER_INDEPENDENT_OUTPUTS_PROJECTED two original images; target installation not read");
