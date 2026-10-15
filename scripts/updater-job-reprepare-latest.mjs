import { prepareOmo } from "./native-prepare/omo.mjs";
const prepared = await prepareOmo({
  version: "5.1.21", outputDir: "/private/tmp/herdr-updater-native-521", resume: true, rebuild: true,
  wrapperHooksSource: "/Users/beomseok/Desktop/herdr-native-omo-5.1.9",
  engineHooksSource: "/Users/beomseok/Desktop/herdr-native-senpi-2026.10.1-3",
  bunPath: "/private/tmp/herdr-native-519-tools/bun-darwin-aarch64/bun",
  npmPath: "/Users/beomseok/.nvm/versions/node/v24.20.0/bin/npm",
  nodePath: "/Users/beomseok/.nvm/versions/node/v24.20.0/bin/node",
});
if (prepared.status !== "LOCAL_SOURCE_OVERLAY_PACKED_NOT_INSTALL_QUALIFIED") throw new Error(`Original source preparation failed: ${prepared.status}`);
console.log(`UPDATER_LATEST_ORIGINAL_REPREPARED ${prepared.target.wrapperVersion} ${prepared.artifacts.length} artifacts`);
