import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const profile = JSON.parse(readFileSync(join(root, "profile.json")));
const directory = join(profile.operationRoot, "profiles");
const before = JSON.parse(readFileSync(join(directory, `${profile.beforeProfile}.json`)));
const after = JSON.parse(readFileSync(join(directory, `${profile.afterProfile}.json`)));
const image = JSON.parse(readFileSync(join(root, "latest-image.json")));
const prepared = JSON.parse(readFileSync("/private/tmp/herdr-updater-native-521/preparation.json"));
async function options(prefix) {
  const child = Bun.spawn([before.executable, join(import.meta.dirname, "updater-job-options.mjs"),
    prefix, before.cwd, before.session_path, ...JSON.parse(before.options.argv)], {
    cwd: before.cwd, env: before.environment, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`Original option producer failed: ${stderr}`);
  return JSON.parse(stdout);
}
const actual = await options(join(root, "prefix")), latest = await options(image.prefix);
if (JSON.stringify(actual) !== JSON.stringify(latest)) throw new Error("Original baseline/latest options differ");
const revision = Date.now();
profile.beforeProfile = `actual-job-519-options-${revision}`;
profile.afterProfile = `actual-job-521-options-${revision}`;
const pins = new Map(image.independentTargetPins.map(pin => [pin.path, pin.sha256]));
after.closure = before.closure.map(pin => {
  if (!pin.path.startsWith(join(root, "prefix") + "/")) return pin;
  const sha256 = pins.get(pin.path);
  if (!sha256) throw new Error(`Latest independent closure missing: ${pin.path}`);
  return { path: pin.path, sha256 };
});
const bridge = image.independentTargetPins.find(pin => pin.path.endsWith("/dist/core/updater-native-bridge.js"));
if (!bridge) throw new Error("Latest original bridge absent");
after.bridge_sha256 = bridge.sha256;
after.qualification.source_revision = prepared.sourceBinding.sha256;
for (const [name, retained] of [[profile.beforeProfile, before], [profile.afterProfile, after]]) {
  retained.options = actual;
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(retained), { flag: "wx", mode: 0o600 });
}
writeFileSync(join(root, "profile.json"), JSON.stringify(profile), { mode: 0o600 });
console.log("UPDATER_ORIGINAL_OPTIONS_REFRESHED baseline/latest agree; settings unchanged");
