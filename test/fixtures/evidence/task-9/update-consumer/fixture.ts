import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fixture as privateFixture, now as initialNow, value } from "../../task-38/fixture";
import { createOmoAdapter } from "../../../../../src/adapters/omo";
import type { OmoConfiguration, OmoUpdateAuthority } from "../../../../../src/adapters/omo";
import { createOmoUpdateSpec, getOmoUpdateIntent, qualifyOmoUpdate } from "../../../../../src/adapters/update-context";
import type { Mode } from "../../../../../src/protocol";

const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export async function fixture() {
  const owned = await privateFixture();
  try {
    const base = owned.input.qualification.installation;
    await chmod(base.executableRealpath, 0o700);
    const wrapperManifest = join(owned.wrapper, "package.json");
    const engineManifest = join(owned.prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json");
    const discoveryPath = join(owned.prefix, "task9-discovery.json");
    const discovery = JSON.stringify({ family: "omo", executable: base.executableRealpath, channel: base.channel,
      owner: base.owner, packageManifest: wrapperManifest,
      resources: base.resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })) });
    await writeFile(discoveryPath, discovery);
    const resources = [...base.resources, { resourceId: `resource:${hash(discoveryPath)}`,
      realpath: discoveryPath, fingerprint: `sha256:${hash(discovery)}` }].sort((a, b) => a.realpath.localeCompare(b.realpath));
    const installation = { ...base, resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
    const input = await owned.authorize({ ...owned.input.qualification, installation });
    const context = value(await qualifyOmoUpdate(input, initialNow));
    const modes: readonly Mode[] = ["update-only", "update-and-restart"];
    const operations = new Map(modes.map(mode => {
      const spec = value(createOmoUpdateSpec(context, mode, initialNow));
      return [mode, { context, intent: value(getOmoUpdateIntent(spec)), spec }] as const;
    }));
    const releasePath = join(owned.root, "task9-release.json");
    await writeFile(releasePath, JSON.stringify({ name: "omo-ai", version: input.qualification.target.version,
      "dist-tags": { latest: input.qualification.target.version } }));
    let clock = initialNow;
    const authority: OmoUpdateAuthority = {
      now: () => clock,
      read(selection) {
        const operation = operations.get(selection.mode);
        return operation && isDeepStrictEqual(selection.installation, installation)
          && selection.check.kind === "update-available"
          && selection.check.installedVersion === "5.1.9"
          && selection.check.availableVersion === input.qualification.target.version
          && selection.check.checkedAt === initialNow ? operation : null;
      },
    };
    const config: OmoConfiguration = { provenance: [{ path: discoveryPath, sha256: hash(discovery) }],
      wrapperManifest, engineManifest, release: async () => JSON.parse(await readFile(releasePath, "utf8")),
      runtime: () => null, core: () => null, updateAuthority: authority };
    const adapter = createOmoAdapter(config);
    const detected = value(await adapter.detect(installation.executableRealpath));
    if (!isDeepStrictEqual(detected, installation)) throw new TypeError("fixture_identity_mismatch");
    return { ...owned, input, context, installation, config, adapter, authority, operations, releasePath,
      setClock(next: number) { clock = next; },
      async check() { return value(await adapter.check(installation)); } };
  } catch {
    await owned.cleanup();
    throw new TypeError("fixture_qualification_failed");
  }
}
