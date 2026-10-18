import { createHash } from "node:crypto";
import { readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgyAdapter } from "../../../../../src/adapters/agy";
import type { AgyConfiguration } from "../../../../../src/adapters/agy";
import type { AdapterResult, FamilyAdapter } from "../../../../../src/adapters/types";
import { fixture } from "../fixture";

export const nativeSize = 186868816;
export async function largeResource(factory: (config: AgyConfiguration) => FamilyAdapter = createAgyAdapter) {
  const f = await fixture(factory);
  try {
    const nativePath = join(f.root, "native-resource.dat");
    await writeFile(nativePath, "");
    await truncate(nativePath, nativeSize);
    // Independent 1 MiB zero-content oracle; production must read the real file.
    const oracle = createHash("sha256");
    const zeros = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < nativeSize; offset += zeros.length)
      oracle.update(zeros.subarray(0, Math.min(zeros.length, nativeSize - offset)));
    const expected = oracle.digest("hex");
    f.receipt.resources.push({ path: nativePath, sha256: expected });
    await f.repin();
    const installation = await f.installation();
    return { ...f, nativePath, expected, observedInstallation: installation };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}

export type LoadedAdapter = {
  readonly createAgyAdapter: (config: AgyConfiguration) => FamilyAdapter;
  readonly resourceDigest: (path: string) => AdapterResult<string>;
};
export async function loadAdapter(edit?: { readonly before: string; readonly after: string }): Promise<LoadedAdapter> {
  let source = await readFile(join(import.meta.dir, "../../../../../src/adapters/agy.ts"), "utf8");
  if (edit) {
    if (source.split(edit.before).length !== 2) throw new TypeError("isolated_guard_match");
    source = source.replace(edit.before, edit.after);
  }
  for (const [specifier, target] of [
    ["../discovery", "../../../../../src/discovery.ts"],
    ["../protocol", "../../../../../src/protocol.ts"],
    ["./types", "../../../../../src/adapters/types.ts"],
  ] as const) source = source.replaceAll(`"${specifier}"`, JSON.stringify(pathToFileURL(join(import.meta.dir, target)).href));
  // Test-only in-memory exposure. Shipping module exports/API stay unchanged.
  source += "\nexport { resourceDigest };\n";
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
  return await import(`data:text/javascript;base64,${Buffer.from(transpiler.transformSync(source)).toString("base64")}`);
}
