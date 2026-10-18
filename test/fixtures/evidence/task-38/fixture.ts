import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterResult, InstallationIdentity, PrivateUpdateCommand } from "../../../../src/adapters/types";
import { createOmoUpdateSpec, qualifyOmoUpdate } from "../../../../src/adapters/update-context";
import type { OmoArtifact, OmoUpdateInput, OmoUpdateQualification } from "../../../../src/adapters/update-context";

export const now = 100_000;
export const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function value<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}
export async function fixture(targetVersion = "5.1.10", alias?: {
  readonly global?: boolean; readonly fields?: readonly ("dependencies" | "optionalDependencies" | "peerDependencies")[];
}) {
  const root = await realpath(await mkdtemp(join(import.meta.dir, "runtime-")));
  try {
  const prefix = join(root, "bun");
  const wrapper = join(prefix, "install/global/node_modules/omo-ai");
  const engine = join(prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json");
  const home = join(root, "home");
  await Promise.all([mkdir(join(wrapper, "bin/lib"), { recursive: true }),
    mkdir(join(prefix, "bin"), { recursive: true }), mkdir(join(engine, ".."), { recursive: true }), mkdir(home)]);
  const source = join(import.meta.dir, "../task-5/families/omo/boundedsource/omo");
  const officialPaths = ["bin/omo.js", "bin/senpi-patch.mjs", "bin/lib/self-update.js", "bin/lib/package-paths.js", "bin/lib/update-args.js"];
  for (const path of officialPaths) await writeFile(join(wrapper, path), await readFile(join(source, path)));
  const wrapperManifest = { name: "omo-ai", version: "5.1.9", bin: { omo: "bin/omo.js" },
    scripts: { postinstall: "node bin/senpi-patch.mjs" }, dependencies: { "@code-yeongyu/senpi": "2026.10.1-3" } };
  await writeFile(join(wrapper, "package.json"), JSON.stringify(wrapperManifest));
  await writeFile(engine, JSON.stringify({ name: "@code-yeongyu/senpi", version: "2026.10.1-3" }));
  await writeFile(join(prefix, "install/global/package.json"), JSON.stringify({ dependencies: {
    "omo-ai": "5.1.9", ...(alias?.global ? { "@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@2026.10.1-3" } : {}),
  } }));
  await writeFile(join(prefix, "install/global/bun.lock"), '{"lockfileVersion":1}');
  await writeFile(join(prefix, "bin/omo"), "#!/bin/sh\nexit 93\n");
  const manager = join(prefix, "bin/bun");
  // If anyone bypasses injection and executes this owned file, the marker exposes it.
  const marker = join(root, "FORBIDDEN_EFFECT");
  await writeFile(manager, `#!/bin/sh\nprintf effect > '${marker}'\nexit 94\n`);
  await chmod(manager, 0o700);
  const paths = [...officialPaths.map(path => join(wrapper, path)), join(wrapper, "package.json"), engine,
    join(prefix, "install/global/package.json"), join(prefix, "install/global/bun.lock"), join(prefix, "bin/omo")];
  const resources = await Promise.all(paths.map(async path => ({
    resourceId: `resource:${hash(path)}`, realpath: path, fingerprint: `sha256:${hash(await readFile(path))}`,
  })));
  const executable = join(wrapper, "bin/omo.js");
  const installation: InstallationIdentity = {
    installationId: `install:${hash(executable)}`, family: "omo", channel: "latest",
    executableRealpath: executable, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}`,
    owner: { kind: "wrapper", packageName: "omo-ai", engineResourceId: `resource:${hash(engine)}`, prefix },
    installedVersion: { kind: "known", version: "5.1.9" }, resources,
  };
  const artifacts: OmoArtifact[] = [];
  const targetFiles = new Map<string, string | Uint8Array>();
  const packages: Array<readonly [string, string, string]> = [
    ["omo-ai", targetVersion, "omo-ai"], ["@code-yeongyu/senpi", "2026.10.1-3", "@code-yeongyu/senpi"],
    ...(alias ? [["@code-yeongyu/senpi-ai", "2026.10.1-3", "@earendil-works/pi-ai"] as const] : []),
  ];
  for (const [name, version, installName] of packages) {
    const edges = name === "@code-yeongyu/senpi" ? Object.fromEntries((alias?.fields ?? []).map(field =>
      [field, { "@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@2026.10.1-3" }])) : {};
    const data: Record<string, string | Uint8Array> = {
      "package/package.json": JSON.stringify(name === "omo-ai" ? { ...wrapperManifest, version } : { name, version, ...edges }),
      "package/dist/payload.js": `export const qualifiedPayload = ${JSON.stringify(name + "@" + version)};\n`,
    };
    if (name === "omo-ai") for (const path of officialPaths) data[`package/${path}`] = await readFile(join(wrapper, path));
    const bytes = await new Bun.Archive(data, { compress: "gzip" }).bytes();
    const archivePath = join(root, `${artifacts.length}.tgz`);
    await writeFile(archivePath, bytes);
    const metadataPath = join(root, `${artifacts.length}.metadata.json`);
    const metadata = JSON.stringify({ name, version, dist: {
      tarball: `https://registry.npmjs.org/${name}/-/fixture-${version}.tgz`,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    } });
    await writeFile(metadataPath, metadata);
    artifacts.push({ name, installName, version, archive: { path: archivePath, sha256: hash(bytes) },
      metadata: { path: metadataPath, sha256: hash(metadata) } });
    for (const [path, body] of Object.entries(data)) targetFiles.set(join(prefix, "install/global/node_modules", installName, path.slice(8)), body);
  }
  const stamp = join(prefix, "install/global/node_modules/@code-yeongyu/senpi/prepared-stamp");
  targetFiles.set(stamp, "qualified-postinstall-output");
  if (targetVersion === "5.1.9") for (const [path, bytes] of targetFiles) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  }
  const qualification: OmoUpdateQualification = {
    installation, manager: { name: "bun", path: manager, sha256: hash(await readFile(manager)) },
    env: { HOME: home, PATH: join(prefix, "bin"), BUN_INSTALL: prefix },
    target: { packageName: "omo-ai", version: targetVersion, channel: "latest", checkedAt: now - 1, expiresAt: now + 1000,
      artifacts, postinstall: [{ path: stamp, sha256: hash("qualified-postinstall-output") }] },
  };
  const receipt = { path: join(root, "private-receipt.json"), sha256: hash(JSON.stringify(qualification)) };
  await writeFile(receipt.path, JSON.stringify(qualification));
  const input: OmoUpdateInput = { qualification, receipt };
  const context = value(await qualifyOmoUpdate(input, now));
  const spec = value(createOmoUpdateSpec(context, "update-only", now));
  return { root, prefix, wrapper, home, manager, marker, input, context, spec, targetFiles,
    async authorize(next: OmoUpdateQualification): Promise<OmoUpdateInput> {
      const body = JSON.stringify(next);
      await writeFile(receipt.path, body);
      return { qualification: next, receipt: { path: receipt.path, sha256: hash(body) } };
    },
    async cleanup() {
      // Capture hashes before removal; no updater/installer is ever called.
      let effects = 0;
      try { await readFile(marker); effects++; } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await rm(root, { recursive: true, force: true });
      return { root, effects, rootsRemaining: 0, processesRemaining: 0 };
    },
  };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export function capture() {
  const commands: PrivateUpdateCommand[] = [];
  return { commands, now: () => now,
    run: async (command: PrivateUpdateCommand) => { commands.push(command); return { status: 29, signal: null }; } };
}
