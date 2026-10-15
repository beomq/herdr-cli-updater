import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { prepareOmoInstallationRuntime } from "../src/service/prepare-omo-runtime";
import { loadOmoUpdateRuntime } from "../src/service/omo-update-runtime";

const [root, prefix, bun, stableRoot] = process.argv.slice(2);
if (!root || !prefix || !bun || !stableRoot || !/^\d+$/.test(stableRoot))
  throw new TypeError("usage: bun scripts/prepare-omo-runtime.ts NEW_ROOT PREFIX ORIGINAL_BUN STABLE_ROOT_PID");
mkdirSync(root, { mode: 0o700 });
const directory = join(root, "prepare"), ownerDirectory = join(root, "owner"), socketDirectory = join(root, "sockets");
for (const path of [directory, ownerDirectory, socketDirectory]) mkdirSync(path, { mode: 0o700 });
try {
  const prepared = await prepareOmoInstallationRuntime({ directory, prefix, bun: realpathSync(bun), ownerDirectory,
    socketDirectory, registeredSockets: [], rootPids: [Number(stableRoot)] });
  const loaded = await loadOmoUpdateRuntime({ directory: ownerDirectory, coreSocket: join(socketDirectory, "unused.sock") },
    prepared.configurationPin, prepared.inputs);
  console.log(JSON.stringify({ configurationPin: prepared.configurationPin, profile: prepared.inputs.profile, runtime: loaded.kind,
    operatingMutation: false, artifacts: prepared.inputs.update.qualification.target.artifacts.length }));
  if (loaded.kind !== "configured") process.exitCode = 1;
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(error.name, error.message); process.exitCode = 1;
}
