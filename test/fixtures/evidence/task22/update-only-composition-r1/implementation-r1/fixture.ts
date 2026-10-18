import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createOmoAdapter } from "../../../../../../src/adapters/omo";
import { createOmoUpdateSpec, getOmoUpdateIntent, qualifyOmoUpdate } from "../../../../../../src/adapters/update-context";
import type { OmoArtifact, OmoUpdateInput } from "../../../../../../src/adapters/update-context";
import type { AdapterResult, InstallationIdentity } from "../../../../../../src/adapters/types";
import type { Mode } from "../../../../../../src/protocol";
import { tmpdir } from "node:os";

export const now = 100_000;
export const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
export function value<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}
export type Behavior = "install" | "no-change" | "nonzero" | "corrupt" | "hang" | "flood";
/** Synthetic pinned manager, with the actual immutable official update entry
 * semantics and archive/postinstall qualification. No vendor installer runs.
 * All writes, listener, child effects and cleanup are task22-owned.
 */
export async function fixture(behavior: Behavior = "install", managerTail = "", checkBarrier?: { readonly entered: () => void; readonly wait: Promise<void> }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-fixture-runtime-")));
  const controller = createServer();
  let peer: Socket | undefined;
  const ready = Promise.withResolvers<void>();
  controller.on("connection", socket => {
    peer = socket;
    let body = "";
    socket.on("data", bytes => {
      body += bytes.toString();
      if (body === "ready\n") ready.resolve();
      else if (body.includes("\n")) ready.reject(new TypeError("unexpected_fixture_event"));
    });
  });
  try {
    const listening = once(controller, "listening");
    controller.listen(0, "127.0.0.1");
    await listening;
    const address = controller.address();
    if (!address || typeof address === "string") throw new TypeError("fixture_address");
    const prefix = join(root, "bun");
    const wrapper = join(prefix, "install/global/node_modules/omo-ai");
    const engine = join(prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json");
    const home = join(root, "home"), journal = join(root, "journal");
    await Promise.all([mkdir(join(wrapper, "bin/lib"), { recursive: true }),
      mkdir(join(prefix, "bin"), { recursive: true }), mkdir(join(engine, ".."), { recursive: true }),
      mkdir(home), mkdir(journal, { mode: 0o700 })]);
    const source = join(import.meta.dir, "../../../task-5/families/omo/boundedsource/omo");
    const officialPaths = ["bin/omo.js", "bin/senpi-patch.mjs", "bin/lib/self-update.js", "bin/lib/package-paths.js", "bin/lib/update-args.js"];
    for (const path of officialPaths) await writeFile(join(wrapper, path), await readFile(join(source, path)));
    await chmod(join(wrapper, "bin/omo.js"), 0o700);
    const wrapperManifest = { name: "omo-ai", version: "5.1.9", bin: { omo: "bin/omo.js" },
      scripts: { postinstall: "node bin/senpi-patch.mjs" }, dependencies: { "@code-yeongyu/senpi": "2026.10.1-3" } };
    await writeFile(join(wrapper, "package.json"), JSON.stringify(wrapperManifest));
    await writeFile(engine, JSON.stringify({ name: "@code-yeongyu/senpi", version: "2026.10.1-3" }));
    await writeFile(join(prefix, "install/global/package.json"), '{"dependencies":{"omo-ai":"5.1.9"}}');
    await writeFile(join(prefix, "install/global/bun.lock"), '{"lockfileVersion":1}');
    await writeFile(join(prefix, "bin/omo"), "#!/bin/sh\nexit 93\n");
    const manager = join(prefix, "bin/bun"), effects = join(root, "effects.jsonl");
    const planPath = join(root, "fixture-plan.json");
    // Absolute interpreter and exact process environment: never shell/PATH dispatch.
    await writeFile(manager, `#!${process.execPath}
import {appendFileSync,readFileSync,readdirSync,writeFileSync,mkdirSync} from "node:fs";
import {connect} from "node:net";
const p=JSON.parse(readFileSync(${JSON.stringify(planPath)},"utf8"));
const receipts=readdirSync(p.journal).flatMap(n=>readFileSync(p.journal+"/"+n,"utf8").trim().split("\\n").map(JSON.parse));
if(!receipts.some(r=>r.kind==="intent")||!receipts.some(r=>r.kind==="dispatch"))process.exit(81);
if(process.cwd()!==p.wrapper||Object.keys(process.env).sort().join(",")!=="BUN_INSTALL,HOME,PATH"
 ||process.argv[2]!=="add"||process.argv[3]!=="-g"||process.argv[4]!=="omo-ai@5.1.10"
 ||!process.argv.includes("--registry")||!process.argv.includes("--force"))process.exit(82);
const registry=new URL(process.argv[process.argv.indexOf("--registry")+1]);
if(registry.hostname!=="127.0.0.1")process.exit(83);
appendFileSync(p.effects,JSON.stringify({pid:process.pid,registryPort:Number(registry.port),intentBeforeEffect:true,environmentExact:true,argsExact:true})+"\\n");
const channel=connect({host:"127.0.0.1",port:p.port});
const connected=new Promise(resolve=>channel.once("connect",resolve));
const release=new Promise(resolve=>channel.once("data",resolve));
await connected;
channel.write("ready\\n");
if(p.behavior==="hang")await release;
if(p.behavior==="flood"){process.stdout.write("SYNTHETIC_PRIVATE_OUTPUT".repeat(10000));process.stderr.write("SYNTHETIC_PRIVATE_OUTPUT".repeat(10000));}
if(!["no-change","nonzero"].includes(p.behavior))for(const [path,body] of p.files){
 mkdirSync(path.slice(0,path.lastIndexOf("/")),{recursive:true});writeFileSync(path,body);
}
if(p.behavior==="corrupt")writeFileSync(p.files[0][0],"changed-after-install");
${managerTail}
channel.end();
process.exitCode=p.behavior==="nonzero"?29:0;
`);
    await chmod(manager, 0o700);
    const paths = [...officialPaths.map(path => join(wrapper, path)), join(wrapper, "package.json"), engine,
      join(prefix, "install/global/package.json"), join(prefix, "install/global/bun.lock"), join(prefix, "bin/omo")];
    const resources = await Promise.all(paths.map(async path => ({
      resourceId: `resource:${hash(path)}`, realpath: path, fingerprint: `sha256:${hash(await readFile(path))}`,
    })));
    const executable = join(wrapper, "bin/omo.js");
    const base: InstallationIdentity = { installationId: `install:${hash(executable)}`, family: "omo", channel: "latest",
      executableRealpath: executable, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}`,
      owner: { kind: "wrapper", packageName: "omo-ai", engineResourceId: `resource:${hash(engine)}`, prefix },
      installedVersion: { kind: "known", version: "5.1.9" }, resources };
    const discovery = JSON.stringify({ family: "omo", executable, channel: "latest", owner: base.owner,
      packageManifest: join(wrapper, "package.json"),
      resources: resources.map(row => ({ path: row.realpath, sha256: row.fingerprint.slice(7) })) });
    const pinnedDiscovery = join(prefix, "discovery.json");
    await writeFile(pinnedDiscovery, discovery);
    resources.push({ resourceId: `resource:${hash(pinnedDiscovery)}`, realpath: pinnedDiscovery, fingerprint: `sha256:${hash(discovery)}` });
    resources.sort((a, b) => a.realpath.localeCompare(b.realpath));
    const installation = { ...base, resources, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}` };
    const artifacts: OmoArtifact[] = [];
    const files: Array<readonly [string, string]> = [];
    for (const [name, version] of [["omo-ai", "5.1.10"], ["@code-yeongyu/senpi", "2026.10.1-3"]] as const) {
      const data: Record<string, string> = {
        "package/package.json": JSON.stringify(name === "omo-ai" ? { ...wrapperManifest, version } : { name, version }),
        "package/dist/payload.js": `export const qualifiedPayload = ${JSON.stringify(name + "@" + version)};\n`,
      };
      if (name === "omo-ai") for (const path of officialPaths) data[`package/${path}`] = await readFile(join(wrapper, path), "utf8");
      const bytes = await new Bun.Archive(data, { compress: "gzip" }).bytes();
      const archivePath = join(root, `${artifacts.length}.tgz`), metadataPath = join(root, `${artifacts.length}.metadata.json`);
      await writeFile(archivePath, bytes);
      const metadata = JSON.stringify({ name, version, dist: { tarball: `https://registry.npmjs.org/${name}/-/fixture-${version}.tgz`,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } });
      await writeFile(metadataPath, metadata);
      artifacts.push({ name, installName: name, version, archive: { path: archivePath, sha256: hash(bytes) }, metadata: { path: metadataPath, sha256: hash(metadata) } });
      for (const [path, body] of Object.entries(data)) files.push([join(prefix, "install/global/node_modules", name, path.slice(8)), body]);
    }
    const stamp = join(prefix, "install/global/node_modules/@code-yeongyu/senpi/prepared-stamp");
    files.push([stamp, "qualified-postinstall-output"]);
    // This controlled manager keeps the global declaration and resolves no lock
    // packages. Its declared output includes the issuer's fresh lock seed, not
    // the old lock bytes fingerprinted before dispatch.
    files.push([join(prefix, "install/global/bun.lock"), `${JSON.stringify({ lockfileVersion: 1,
      workspaces: { "": { dependencies: { "omo-ai": "5.1.9" } } }, packages: {} }, null, 2)}\n`]);
    await writeFile(planPath, JSON.stringify({ behavior, wrapper, journal, effects, files, port: address.port }));
    const qualification = { installation, manager: { name: "bun", path: manager, sha256: hash(await readFile(manager)) },
      env: { HOME: home, PATH: join(prefix, "bin"), BUN_INSTALL: prefix },
      target: { packageName: "omo-ai", version: "5.1.10", channel: "latest", checkedAt: now - 1, expiresAt: now + 1000,
        artifacts, postinstall: [{ path: stamp, sha256: hash("qualified-postinstall-output") }] } } as const;
    const receipt = { path: join(root, "qualification.json"), sha256: hash(JSON.stringify(qualification)) };
    await writeFile(receipt.path, JSON.stringify(qualification));
    const input: OmoUpdateInput = { qualification, receipt };
    const context = value(await qualifyOmoUpdate(input, now));
    const modes: readonly Mode[] = ["update-only", "update-and-restart"];
    const operations = new Map(modes.map(mode => {
      const spec = value(createOmoUpdateSpec(context, mode, now));
      return [mode, { context, intent: value(getOmoUpdateIntent(spec)) }] as const;
    }));
    // Production adapter, not a fake issuer/provider that returns success.
    const adapter = createOmoAdapter({ wrapperManifest: join(wrapper, "package.json"), engineManifest: engine,
      provenance: [{ path: pinnedDiscovery, sha256: hash(discovery) }],
      release: async () => { checkBarrier?.entered(); await checkBarrier?.wait; return { name: "omo-ai", version: "5.1.10", "dist-tags": { latest: "5.1.10" } }; },
      runtime: () => null, core: () => null,
      updateAuthority: { now: () => now, read: selected => {
        const operation = operations.get(selected.mode);
        return operation && isDeepStrictEqual(selected.installation, installation)
          && selected.check.kind === "update-available" && selected.check.availableVersion === "5.1.10"
          ? operation : null;
      } } });
    const detected = value(await adapter.detect(executable));
    return { root, prefix, wrapper, home, journal, manager, effects, input, context, adapter, installation: detected, files,
      ready: ready.promise,
      async spec(mode: Mode = "update-only") {
        value(await adapter.check(detected));
        return value(adapter.updateSpec(detected, mode));
      },
      release() { peer?.end("release\n"); },
      async cleanup() {
        peer?.destroy();
        const closed = once(controller, "close");
        controller.close();
        await closed;
        await rm(root, { recursive: true, force: true });
        return { rootsRemaining: 0, socketsRemaining: 0 };
      } };
  } catch (error) {
    peer?.destroy();
    controller.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
