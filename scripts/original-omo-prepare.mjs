// Prepare a lockfile in a separate directory. Never changes ~/.bun or launches OmO.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { preparedNativeRecipe } from "../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/normalize.mjs";

const product = join(import.meta.dirname, "..");
const root = "/Users/beomseok/.local/share/herdr-cli-updater/original-omo-integration";
const original = "/Users/beomseok/.bun/install/global";
const prefix = join(root, "prepared-prefix");
const global = join(prefix, "install/global");
mkdirSync(global, { recursive: true, mode: 0o700 });
const home = join(root, "installer-home");
mkdirSync(home, { recursive: true, mode: 0o700 });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const beforeManifest = readFileSync(join(original, "package.json"));
const beforeLock = readFileSync(join(original, "bun.lock"));
copyFileSync(join(original, "package.json"), join(global, "package.json"));
copyFileSync(join(original, "bun.lock"), join(global, "bun.lock"));
process.env.ONE_FAMILY_TARGET_RUNTIME = "/Users/beomseok/.local/share/herdr-cli-updater/worker-preparations/omo-mJsivd/omo-runtime.json";
process.env.ONE_FAMILY_BEFORE_ACQUISITION = join(product, ".omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/inputs/acquisition.json");
process.env.ONE_FAMILY_BEFORE_ALIASES = join(product, ".omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/inputs/alias-closure.json");
const recipe = preparedNativeRecipe("/private/tmp/herdr-prompt-preset-native-519-r6/preparation.json");
const packages = new Map();
const archives = new Map();
for (const artifact of recipe.artifacts) {
  const bytes = readFileSync(artifact.archive.path);
  if (digest(bytes) !== artifact.archive.sha256) throw new Error("Source archive drift");
  const metadataBytes = readFileSync(artifact.provenance.vendor.metadata.path);
  if (digest(metadataBytes) !== artifact.provenance.vendor.metadata.sha256) throw new Error("Vendor metadata drift");
  const metadata = JSON.parse(metadataBytes);
  const path = `/native/${artifact.archive.sha256}.tgz`;
  archives.set(path, bytes);
  packages.set(artifact.name, { version: artifact.version, metadata, path,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` });
}
let server;
server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const url = new URL(request.url);
  if (archives.has(url.pathname)) return new Response(archives.get(url.pathname));
  const entry = packages.get(decodeURIComponent(url.pathname.slice(1)));
  if (entry) {
    const metadata = { ...entry.metadata, dist: { ...entry.metadata.dist, integrity: entry.integrity,
      tarball: `http://127.0.0.1:${server.port}${entry.path}` } };
    return Response.json({ name: metadata.name, "dist-tags": { latest: entry.version }, versions: { [entry.version]: metadata } });
  }
  // Public registry only, with no inherited authentication headers.
  const upstream = await fetch(`https://registry.npmjs.org${url.pathname}${url.search}`, { signal: AbortSignal.timeout(30000) });
  // fetch has already decompressed the body; do not forward content-encoding.
  return new Response(await upstream.arrayBuffer(), { status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" } });
} });
try {
  const manager = "/private/tmp/herdr-native-519-tools/bun-darwin-aarch64/bun";
  const child = Bun.spawn([manager, "add", "-g", "omo-ai@5.1.19", "--trust", "--lockfile-only"], {
    cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { HOME: home, BUN_INSTALL: prefix, BUN_CONFIG_REGISTRY: `http://127.0.0.1:${server.port}`,
      BUN_INSTALL_CACHE_DIR: join(root, "uncompressed-cache"),
      PATH: "/opt/homebrew/Cellar/bun/1.3.6/bin:/Users/beomseok/.nvm/versions/node/v24.20.0/bin:/usr/bin:/bin" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const before = Bun.JSON5.parse(beforeLock.toString());
  const afterBytes = readFileSync(join(global, "bun.lock"));
  const after = Bun.JSON5.parse(afterBytes.toString());
  const unrelated = Object.keys(JSON.parse(beforeManifest).dependencies).filter(name => name !== "omo-ai");
  const changedRoots = unrelated.filter(name => JSON.stringify(before.packages[name]) !== JSON.stringify(after.packages[name]));
  const resolve = (packages, parent, name) => {
    let path = parent;
    while (path) {
      if (packages[`${path}/${name}`]) return `${path}/${name}`;
      const cut = path.lastIndexOf("/");
      if (cut < 0) break;
      path = path.slice(0, cut);
      if (path.startsWith("@") && !path.includes("/")) path = "";
    }
    return packages[name] ? name : null;
  };
  const visited = new Set(), changedClosure = [];
  const compare = key => {
    if (visited.has(key)) return;
    visited.add(key);
    if (JSON.stringify(before.packages[key]) !== JSON.stringify(after.packages[key])) changedClosure.push(key);
    const metadata = before.packages[key]?.[2] ?? {};
    for (const name of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies })) {
      const oldKey = resolve(before.packages, key, name), newKey = resolve(after.packages, key, name);
      if (oldKey !== newKey) changedClosure.push(`${key} -> ${name}`);
      if (oldKey) compare(oldKey);
    }
  };
  unrelated.forEach(compare);
  const liveUnchanged = digest(readFileSync(join(original, "package.json"))) === digest(beforeManifest)
    && digest(readFileSync(join(original, "bun.lock"))) === digest(beforeLock);
  writeFileSync(join(root, "preparation.json"), JSON.stringify({ exitCode, stdout, stderr, changedRoots, changedClosure,
    unrelatedClosurePackages: visited.size, liveUnchanged,
    before: { manifest: digest(beforeManifest), lock: digest(beforeLock) },
    prepared: { manifest: digest(readFileSync(join(global, "package.json"))), lock: digest(afterBytes) },
    archives: recipe.artifacts.map(artifact => ({ name: artifact.name, version: artifact.version, archive: artifact.archive })),
  }, null, 2), { mode: 0o600 });
  if (exitCode !== 0 || changedRoots.length || changedClosure.length || !liveUnchanged)
    throw new Error("Original installation preparation failed; inspect preparation.json");
  console.log(`ORIGINAL_OMO_PREPARED lockfile only; original untouched; unrelated closure ${visited.size} unchanged`);
  if (process.argv.includes("--install")) {
    const install = Bun.spawn([manager, "add", "-g", "omo-ai@5.1.19", "--frozen-lockfile"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { HOME: home, BUN_INSTALL: prefix, BUN_CONFIG_REGISTRY: `http://127.0.0.1:${server.port}`,
        BUN_INSTALL_CACHE_DIR: join(root, "uncompressed-cache"),
        PATH: "/opt/homebrew/Cellar/bun/1.3.6/bin:/Users/beomseok/.nvm/versions/node/v24.20.0/bin:/usr/bin:/bin" },
    });
    const [installOut, installErr, installExit] = await Promise.all([
      new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited,
    ]);
    writeFileSync(join(root, "installation.json"), JSON.stringify({ exitCode: installExit, stdout: installOut, stderr: installErr }, null, 2), { mode: 0o600 });
    if (installExit !== 0) throw new Error("Prepared installation failed; inspect installation.json");
    if (digest(readFileSync(join(global, "bun.lock"))) !== digest(afterBytes)) throw new Error("Frozen installation changed prepared lock");
    const version = Bun.spawn(["/opt/homebrew/Cellar/bun/1.3.6/bin/bun", join(global, "node_modules/omo-ai/bin/omo.js"), "--version"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { HOME: home, BUN_INSTALL: prefix, PATH: "/opt/homebrew/Cellar/bun/1.3.6/bin:/Users/beomseok/.nvm/versions/node/v24.20.0/bin:/usr/bin:/bin" },
    });
    const [versionOut, versionErr, versionExit] = await Promise.all([
      new Response(version.stdout).text(), new Response(version.stderr).text(), version.exited,
    ]);
    writeFileSync(join(root, "version.json"), JSON.stringify({ exitCode: versionExit, stdout: versionOut, stderr: versionErr }), { mode: 0o600 });
    if (versionExit !== 0 || versionOut.trim() !== "omo 5.1.19 (engine: senpi 2026.10.10)")
      throw new Error("Prepared OmO version verification failed");
    if (digest(readFileSync(join(original, "package.json"))) !== digest(beforeManifest)
      || digest(readFileSync(join(original, "bun.lock"))) !== digest(beforeLock)) throw new Error("Original installation changed during preparation");
    console.log("ORIGINAL_OMO_STAGED_INSTALL_VERIFIED 5.1.19; original untouched");
  }
} finally { server.stop(true); }
