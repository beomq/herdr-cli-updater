import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { hash } from "./fixture";

/** Counterexample uses the full official modules unchanged, with every effect
 * default replaced by a trap. Only import linking is performed in memory.
 */
export async function rawOfficialRegistryFailure(root: string) {
  const files: Record<string, string> = {};
  const pins = {
    "self-update.js": "8fc5b3ba5ebc7a3d9e4e1ed75b36ddf6f76f77c1595148d184a30681ce234fe7",
    "package-paths.js": "da57bd6016ab85a0f65f53cde53ca3b2e8606e2efc515bcb592d637c24401e67",
    "update-args.js": "3f571751faa087d83d1e6bae61c3206877616e93243479d7604f7a34f4685c6e",
  };
  for (const [name, digest] of Object.entries(pins)) {
    const body = await readFile(join(import.meta.dir, "../task-5/families/omo/boundedsource/omo/bin/lib", name), "utf8");
    assert.equal(hash(body), digest);
    files[`/raw-omo/${name}`] = body;
  }
  const result = await Bun.build({ entrypoints: ["/raw-omo/entry.js"], target: "bun",
    define: { "import.meta.url": JSON.stringify("file:///raw-omo/package-paths.js") },
    files: { ...files,
      "/raw-omo/entry.js": 'export {runSelfUpdate} from "./self-update.js"; export {updateTarget} from "./package-paths.js";',
      "/raw-omo/child-process.js": 'export function runChild(){throw new Error("forbidden_effect")}',
      "/raw-omo/npm-dist-tags.js": 'export function fetchNpmDistTagsSync(){throw new Error("forbidden_network")}',
    } });
  assert(result.success && result.outputs[0]);
  const api = await import(`data:text/javascript;base64,${Buffer.from(await result.outputs[0].text()).toString("base64")}`);
  const commands: { command: string; args: string[]; env: Record<string, string> }[] = [];
  const exit: number = await api.runSelfUpdate(["update"], {
    fetchDistTags: () => null, readInstalled: () => ({ omo: "5.1.9", engine: "2026.10.1-3" }),
    resolveUpdate: (target?: string) => api.updateTarget(join(root, "install/global/node_modules/omo-ai"),
      "darwin", "5.1.9", root, () => false, target),
    env: {}, log: () => {}, error: () => {},
    run: async (command: string, args: string[], options: { env: Record<string, string> }) => {
      commands.push({ command, args, env: options.env }); return { status: 29, signal: null };
    },
  });
  assert.equal(exit, 29);
  assert.deepEqual(commands, [{ command: "bun", args: ["add", "-g", "omo-ai"], env: { BUN_INSTALL: root } }]);
  return { exit, commands, effects: 0 };
}
