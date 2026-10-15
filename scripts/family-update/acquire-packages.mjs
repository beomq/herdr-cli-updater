#!/usr/bin/env bun
// Genuine public acquisition and original-manager observations, not qualification.
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { prunePackageCopies, releaseFailedAcquisition } from "./retention.mjs";

const targets = {
  claude: ["@anthropic-ai/claude-code", "2.1.289"],
  codex: ["@openai/codex", "0.160.0"],
  omp: ["@oh-my-pi/pi-coding-agent", "18.6.1"],
  grok: ["@xai-official/grok", "1.0.46"],
};
const repository = resolve(import.meta.dir, "../..");
const outputParent = join(repository, ".omo/evidence/herdr-cli-updater/six-families/packages");
const oldTools = join(repository, ".omo/evidence/herdr-cli-updater/task22/update-only-composition-r1/implementation-r1/inputs/tools/bin");
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest(algorithm === "sha512" ? "base64" : "hex");
const need = (condition, message) => { if (!condition) throw new Error(message); };
const json = async file => JSON.parse(await readFile(file, "utf8"));
async function directory(file) { await mkdir(file, { recursive: true, mode: 0o700 }); await chmod(file, 0o700); }
async function persist(file, bytes) {
  await directory(dirname(file));
  await writeFile(file, bytes, { mode: 0o600 });
  await chmod(file, 0o600);
  return { path: await realpath(file), sha256: hash(bytes) };
}
const record = (file, value) => persist(file, JSON.stringify(value, null, 2) + "\n");
async function pin(file) { return { path: await realpath(file), sha256: hash(await readFile(file)) }; }
async function privateTree(root, vendorFiles = false) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = join(root, item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) {
      await chmod(file, 0o700);
      await privateTree(file, vendorFiles || ["prefix", "home", "bun", "tools"].includes(item.name));
    } else if (!vendorFiles) await chmod(file, 0o600);
  }
  await chmod(root, 0o700);
}
async function get(url, requests) {
  const parsed = new URL(url);
  need(parsed.origin === "https://registry.npmjs.org" && !parsed.username && !parsed.password, `Nonpublic registry URL: ${url}`);
  const response = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(120000) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  requests.push({ url, status: response.status, sha256: hash(bytes), bytes: bytes.length, observedAt: new Date().toISOString() });
  need(response.ok, `Public registry HTTP ${response.status}: ${url}: ${new TextDecoder().decode(bytes).slice(0, 500)}`);
  return bytes;
}
function safeMember(member) {
  need(member && !member.startsWith("/") && !member.includes("\\") && !/[\u0000-\u001f\u007f]/.test(member)
    && member.split("/").every(part => part && part !== "." && part !== ".."), `Unsafe archive member: ${member}`);
}
async function acquire(name, version, receipt, state) {
  const identity = `${name}@${version}`;
  if (state.packages.has(identity)) return state.packages.get(identity);
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const metadataBytes = await get(metadataUrl, receipt.requests), metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
  need(metadata.name === name && metadata.version === version, `Registry identity mismatch: ${identity}`);
  need(/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist?.integrity ?? ""), `Missing SHA512: ${identity}`);
  const bytes = await get(metadata.dist.tarball, receipt.requests);
  need(metadata.dist.integrity === `sha512-${hash(bytes, "sha512")}`, `Archive integrity mismatch: ${identity}`);
  const signatures = (metadata.dist.signatures ?? []).map(signature => {
    const key = state.keys.find(key => key.keyid === signature.keyid);
    if (!key) return { keyid: signature.keyid, verified: false, reason: "official_key_unavailable" };
    need(verify("sha256", Buffer.from(`${identity}:${metadata.dist.integrity}`),
      createPublicKey(`-----BEGIN PUBLIC KEY-----\n${key.key}\n-----END PUBLIC KEY-----`), Buffer.from(signature.sig, "base64")),
    `Registry signature mismatch: ${identity}`);
    return { keyid: signature.keyid, verified: true };
  });
  const members = await new Bun.Archive(bytes).files();
  const manifests = [...members.keys()].filter(member => /^[^/]+\/package\.json$/.test(member));
  need(manifests.length === 1, `Archive manifest ambiguous: ${identity}`);
  const archiveRoot = manifests[0].split("/")[0], manifest = JSON.parse(await members.get(manifests[0]).text());
  need(manifest.name === name && manifest.version === version, `Archive identity mismatch: ${identity}`);
  const memberPins = [], reviewFiles = [];
  const stem = join(state.root, "closure", hash(identity));
  for (const [member, file] of members) {
    safeMember(member); need(member.startsWith(`${archiveRoot}/`), `Archive outside root: ${member}`);
    const body = new Uint8Array(await file.arrayBuffer()), relativePath = member.slice(archiveRoot.length + 1);
    memberPins.push({ relativePath, sha256: hash(body), bytes: body.length });
    if (/\b(?:install|postinstall|preinstall|download)[^/]*\.(?:[cm]?js|ts)$/.test(relativePath)) {
      reviewFiles.push({ relativePath, source: await persist(join(state.root, "review", hash(identity), relativePath), body) });
    }
  }
  const result = { name, version, archive: await persist(`${stem}.tgz`, bytes),
    metadata: await persist(`${stem}.json`, metadataBytes), metadataUrl, archiveUrl: metadata.dist.tarball,
    distIntegrity: metadata.dist.integrity, integrityVerified: true, signatures, archiveRoot,
    memberPins: await record(`${stem}.members.json`, memberPins),
    dependencies: manifest.dependencies ?? {}, optionalDependencies: manifest.optionalDependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {}, peerDependenciesMeta: manifest.peerDependenciesMeta ?? {},
    scripts: manifest.scripts ?? {}, os: manifest.os ?? null, cpu: manifest.cpu ?? null, reviewFiles };
  receipt.records.push(result); state.packages.set(identity, result); state.manifests.set(identity, manifest);
  console.log("PUBLIC_ACQUIRED", identity);
  return result;
}
async function tools() {
  const bun = await pin(join(oldTools, "bun")), node = await pin(join(oldTools, "node"));
  need(bun.sha256 === "539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf", "Original Bun pin drift");
  need(node.sha256 === "e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b", "Original Node pin drift");
  // npm is the original public npm CLI, not a package-authority shim.
  const npm = await pin("/Users/beomseok/.nvm/versions/node/v24.20.0/lib/node_modules/npm/bin/npm-cli.js");
  return { bun, node, npm };
}
async function environment(root) {
  for (const name of ["home", "config", "cache", "tmp", "project", "prefix", "bun"]) await directory(join(root, name));
  // Owned cwd prevents package-manager discovery of ancestor projects.
  await record(join(root, "project/package.json"), { private: true, name: "isolated-official-acquisition" });
  return { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: join(root, "tmp"), BUN_INSTALL: join(root, "bun"), BUN_INSTALL_CACHE_DIR: join(root, "cache/bun"),
    PATH: `${oldTools}:/usr/bin:/bin`, CI: "1", NO_COLOR: "1", npm_config_prefix: join(root, "prefix"),
    npm_config_cache: join(root, "cache/npm"), npm_config_userconfig: "/dev/null", npm_config_globalconfig: join(root, "absent-global-npmrc"),
    npm_config_registry: "https://registry.npmjs.org", npm_config_audit: "false", npm_config_fund: "false",
    GROK_HOME: join(root, "home/.grok"), GROK_NPM_REGISTRY: "https://registry.npmjs.org", GROK_INSTALL_COMPLETIONS: "0" };
}
function policy(root, network) {
  // macOS enforces writes beneath this producer-owned root, even for vendor children.
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(root)}))
(allow file-write-data (literal "/dev/null") (literal "/dev/tty"))
(deny file-read* (subpath "/Users/beomseok/.ssh") (subpath "/Users/beomseok/.aws")
 (subpath "/Users/beomseok/.config") (subpath "/Users/beomseok/.claude") (subpath "/Users/beomseok/.codex")
 (subpath "/Users/beomseok/.grok") (subpath "/Users/beomseok/Library/Keychains"))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc")
 (global-name "com.apple.CredentialStore"))
${network ? "" : "(deny network*)"}
`;
}
async function command(root, receipt, label, argv, env, network = true, preserveFiles = false) {
  const sandbox = await persist(join(root, "sandbox.sb"), policy(root, network));
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-f", sandbox.path, ...argv],
    { cwd: join(root, "project"), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 600000);
  let stdout, stderr, exitCode;
  try { [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); }
  finally { clearTimeout(timer); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  const result = { argv, sandboxArgv: ["/usr/bin/sandbox-exec", "-f", sandbox.path, ...argv], policy: sandbox,
    cwd: join(root, "project"), env, pid: child.pid, exitCode, signal: child.signalCode, networkAllowed: network, umask: 0o077,
    stdout: await persist(join(root, "logs", `${label}.stdout.txt`), stdout),
    stderr: await persist(join(root, "logs", `${label}.stderr.txt`), stderr) };
  receipt.originalCommands.push(result);
  await record(join(root, "logs", `${label}.json`), result);
  console.log("ORIGINAL_MANAGER_EXIT", label, exitCode);
  need(exitCode === 0, `Original manager ${label} exit ${exitCode}: ${stderr.slice(-4000)} ${stdout.slice(-1000)}`);
  await privateTree(root, preserveFiles);
  return result;
}
const npmInstall = (toolchain, versionSpec, scripts, offline = false) => [toolchain.node.path, toolchain.npm.path, "install",
  "--global", "--no-audit", "--no-fund", "--foreground-scripts", "--registry=https://registry.npmjs.org",
  ...(scripts ? [] : ["--ignore-scripts"]), ...(offline ? ["--offline"] : []), versionSpec];
async function calibratedEnvironment(root, toolchain) {
  await environment(root);
  const userconfig = await persist(join(root, "user.npmrc"), "");
  const globalconfig = await persist(join(root, "global.npmrc"), "");
  return {
    env: { HOME: join(root, "home"), PATH: [dirname(toolchain.npm.path), dirname(toolchain.node.path)].join(":") },
    configs: [userconfig, globalconfig],
  };
}
async function officialManager(root, receipt) {
  const npmManifest = await json(join(dirname(dirname(receipt.tools.npm.path)), "package.json"));
  const managerRoot = join(root, "tools");
  const managerReceipt = { records: [], requests: [], originalCommands: [] };
  const state = { root: join(root, "manager-provenance"), packages: new Map(), manifests: new Map(),
    keys: (await json(receipt.officialKeys.path)).keys };
  const vendor = await acquire("npm", npmManifest.version, managerReceipt, state);
  await directory(join(managerRoot, "npm")); await directory(join(managerRoot, "bin"));
  const env = await environment(managerRoot);
  await command(managerRoot, managerReceipt, "extract-original-npm",
    ["/usr/bin/tar", "-xzf", vendor.archive.path, "--strip-components", "1", "-C", join(managerRoot, "npm")], env, false, true);
  await cp(receipt.tools.node.path, join(managerRoot, "bin/node"));
  await rm(join(managerRoot, "bin/sh"), { force: true });
  await chmod(join(managerRoot, "bin/node"), 0o700);
  const originalNode = receipt.tools.node, originalShell = await pin("/bin/sh");
  const node = await pin(join(managerRoot, "bin/node"));
  need(node.sha256 === originalNode.sha256, "Copied original Node bytes drift");
  receipt.originalManagerAcquisition = await record(join(root, "manager-provenance/original-manager.json"),
    { ...managerReceipt, originalNode, copiedNode: node, originalShell, shellInvokedAtOriginalAbsolutePath: true, transformations: 0 });
  receipt.tools = { ...receipt.tools, npm: await pin(join(managerRoot, "npm/bin/npm-cli.js")), node, shell: originalShell };
}
const calibratedNpm = (toolchain, root, versionSpec) => [toolchain.node.path, toolchain.npm.path, "install", "--global",
  "--prefix", join(root, "prefix"), versionSpec, "--cache", join(root, "cache/npm"),
  "--userconfig", join(root, "user.npmrc"), "--globalconfig", join(root, "global.npmrc"),
  "--registry", "https://registry.npmjs.org", "--no-audit", "--no-fund", "--foreground-scripts", "--offline", "--script-shell=/bin/sh"];
async function slots(root) {
  const base = join(root, "prefix/lib/node_modules"), rows = [];
  async function scan(directoryPath) {
    for (const item of await readdir(directoryPath, { withFileTypes: true })) {
      if (item.name.startsWith(".")) continue;
      const names = item.name.startsWith("@") ? (await readdir(join(directoryPath, item.name))).map(name => `${item.name}/${name}`) : [item.name];
      for (const name of names) {
        const packageRoot = join(directoryPath, name), manifest = await json(join(packageRoot, "package.json"));
        rows.push({ installName: relative(base, packageRoot), name: manifest.name, version: manifest.version,
          manifest: await pin(join(packageRoot, "package.json")) });
        try { await scan(join(packageRoot, "node_modules")); }
        catch (error) { if (error.code !== "ENOENT" || error.path !== join(packageRoot, "node_modules")) throw error; }
      }
    }
  }
  await scan(base);
  return rows.sort((a, b) => a.installName.localeCompare(b.installName));
}
function nearest(graph, from, name) {
  let current = from;
  for (;;) {
    const match = graph.find(row => row.installName === (current ? `${current}/node_modules/${name}` : name));
    if (match) return match;
    if (!current) return null;
    current = dirname(current);
    if (current.endsWith("/node_modules")) current = dirname(current);
    if (current === "." || current.startsWith("@") && !current.includes("/")) current = "";
  }
}
async function closure(root, receipt, state) {
  const graph = await slots(root), edges = [], absentOptionalEdges = [];
  for (const row of graph) {
    const vendor = await acquire(row.name, row.version, receipt, state);
    const manifest = state.manifests.get(`${row.name}@${row.version}`), installed = await json(row.manifest.path);
    need(JSON.stringify(installed) === JSON.stringify(manifest), `Installed manifest drift: ${row.installName}`);
    row.archive = vendor.archive; row.metadata = vendor.metadata; row.distIntegrity = vendor.distIntegrity;
  }
  for (const row of graph) {
    const manifest = state.manifests.get(`${row.name}@${row.version}`);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [key, declared] of Object.entries(manifest[field] ?? {})) {
        if (field === "dependencies" && key in (manifest.optionalDependencies ?? {})) continue;
        const target = nearest(graph, row.installName, key);
        const optional = field === "optionalDependencies" || field === "peerDependencies" && manifest.peerDependenciesMeta?.[key]?.optional;
        const alias = /^npm:(.+)@([^@]+)$/.exec(declared), dependencyName = alias?.[1] ?? key, range = alias?.[2] ?? declared;
        if (!target) {
          need(optional, `Missing required closure: ${row.installName} ${field} ${key}@${declared}`);
          const bytes = await get(`https://registry.npmjs.org/${encodeURIComponent(dependencyName)}`, receipt.requests);
          const registry = JSON.parse(new TextDecoder().decode(bytes));
          const selected = Object.keys(registry.versions).filter(version => Bun.semver.satisfies(version, range)).sort(Bun.semver.order).at(-1);
          need(selected, `No public optional version: ${key}@${declared}`);
          const metadata = registry.versions[selected];
          const compatible = (!metadata.os || metadata.os.includes(process.platform)) && (!metadata.cpu || metadata.cpu.includes(process.arch));
          absentOptionalEdges.push({ fromSlot: row.installName, field, dependencyName: key, declared,
            artifactName: dependencyName, artifactVersion: selected, os: metadata.os ?? null, cpu: metadata.cpu ?? null,
            registry: await persist(join(state.root, "optional-metadata", hash(`${dependencyName}@${range}`) + ".json"), bytes),
            reason: field === "peerDependencies" ? "optional_peer_not_selected" : compatible ? "original_manager_optional_not_installed" : "os_cpu_excluded",
            distIntegrity: metadata.dist?.integrity, archiveUrl: metadata.dist?.tarball });
          need(field === "peerDependencies" || !compatible, `Host-compatible optional missing: ${row.installName} ${key}@${declared}`);
          continue;
        }
        need(target.name === dependencyName && Bun.semver.satisfies(target.version, range), `Closure edge mismatch: ${row.installName} ${key}@${declared}`);
        edges.push({ from: `${row.name}@${row.version}`, fromSlot: row.installName, field, dependency: target.installName,
          dependencyName: key, declared, artifactName: target.name, artifactVersion: target.version, alias: Boolean(alias) });
      }
    }
  }
  return { graph, edges, absentOptionalEdges, hostPlatform: `${process.platform}-${process.arch}` };
}
async function snapshot(root, label) {
  const files = [];
  async function scan(directoryPath) {
    for (const item of await readdir(directoryPath, { withFileTypes: true })) {
      const file = join(directoryPath, item.name), rel = relative(root, file), info = await lstat(file);
      if (item.isDirectory()) await scan(file);
      else if (item.isSymbolicLink()) {
        const target = await readlink(file);
        need(resolve(dirname(file), target).startsWith(root + "/"), `Symlink escapes owned root: ${file} -> ${target}`);
        files.push({ relativePath: rel, symlink: target });
      } else files.push({ relativePath: rel, sha256: hash(await readFile(file)), bytes: info.size, mode: info.mode & 0o777 });
    }
  }
  for (const name of ["prefix", "home", "bun"]) await scan(join(root, name));
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files: await record(join(root, "observations", label + ".json"), files), rows: files,
    globalManifest: files.find(row => /(?:^|\/)install\/global\/package.json$/.test(row.relativePath)) ?? null,
    locks: files.filter(row => /(?:bun\.lockb?|package-lock\.json)$/.test(row.relativePath)),
    globalManifestAbsentReason: "npm_global_has_no_root_package_json" };
}
async function acquisition(family) {
  const [name, target] = targets[family] ?? [];
  need(name, `Unknown family: ${family}`);
  const root = join(outputParent, family);
  await directory(outputParent);
  if (await Bun.file(join(root, "acquisition.json")).exists()) {
    const previous = await json(join(root, "acquisition.json"));
    need(previous.status === "BLOCKED", `Existing successful acquisition must not be overwritten: ${root}`);
    await rename(root, `${root}.failed-${Date.now()}`);
  }
  await directory(root);
  const receipt = { schemaVersion: 1, family, name, target, status: "ACQUIRING", nativeFlowQualified: false,
    records: [], requests: [], originalCommands: [], failures: [], sourceEdits: 0, manifestRewrites: 0, operatingEffects: 0 };
  const state = { root, packages: new Map(), manifests: new Map(), keys: [] };
  try {
    receipt.tools = await tools();
    const bytes = await get(`https://registry.npmjs.org/${encodeURIComponent(name)}`, receipt.requests);
    const registry = JSON.parse(new TextDecoder().decode(bytes));
    receipt.registry = await persist(join(root, "registry.json"), bytes);
    need(registry["dist-tags"].latest === target, `Requested latest channel drift: ${name}: ${registry["dist-tags"].latest}`);
    const before = Object.keys(registry.versions).filter(version => !version.includes("-") && Bun.semver.order(version, target) < 0).sort(Bun.semver.order).at(-1);
    need(before, `No previous same-channel version: ${name}`);
    receipt.before = before; receipt.channel = { name: "latest", observed: target, previousSelection: "greatest_published_stable_below_target", distTags: registry["dist-tags"] };
    const keys = await get("https://registry.npmjs.org/-/npm/v1/keys", receipt.requests);
    state.keys = JSON.parse(new TextDecoder().decode(keys)).keys;
    receipt.officialKeys = await persist(join(root, "official-npm-keys.json"), keys);
    for (const [label, version] of [["before", before], ["target", target]]) {
      const installedRoot = join(root, `resolve-${label}`), env = await environment(installedRoot);
      await acquire(name, version, receipt, state);
      await command(installedRoot, receipt, `resolve-${label}`, npmInstall(receipt.tools, `${name}@${version}`, false), env);
      receipt[label + "Closure"] = await closure(installedRoot, receipt, state);
      const observation = await snapshot(installedRoot, "resolved");
      receipt[label + "Resolution"] = { root: installedRoot, env, observation: observation.files, locks: observation.locks };
    }
    receipt.status = "GENUINE_BEFORE_TARGET_CLOSURES_ACQUIRED_SCRIPTS_NOT_EXECUTED";
  } catch (error) { receipt.status = "BLOCKED"; receipt.failures.push({ error: error.message, stack: error.stack }); }
  finally { await privateTree(root); }
  const manifest = await record(join(root, "acquisition.json"), receipt);
  if (receipt.status === "BLOCKED") await releaseFailedAcquisition(root);
  console.log("ACQUISITION_DONE", JSON.stringify({ family, status: receipt.status, manifest, records: receipt.records.length, failures: receipt.failures }));
  if (receipt.failures.length) process.exitCode = 1;
}
async function installation(family, approvalPath) {
  const root = join(outputParent, family), receipt = await json(join(root, "acquisition.json"));
  need(receipt.status === "GENUINE_BEFORE_TARGET_CLOSURES_ACQUIRED_SCRIPTS_NOT_EXECUTED", `Acquisition not complete: ${family}`);
  const approval = await json(approvalPath);
  need(approval.family === family && approval.noAuth && approval.noNormalCli && approval.ownedWritesOnly, "Explicit reviewed lifecycle approval missing");
  for (const row of receipt.records.filter(row => ["preinstall", "install", "postinstall"].some(name => row.scripts[name]))) for (const source of row.reviewFiles) {
    need(approval.sourcePins.some(pin => pin.path === source.source.path && pin.sha256 === source.source.sha256), `Unreviewed installer source: ${source.source.path}`);
    need(hash(await readFile(source.source.path)) === source.source.sha256, `Installer source drift: ${source.source.path}`);
  }
  receipt.lifecycleReview = await pin(approvalPath);
  receipt.failures = [];
  try {
    await officialManager(root, receipt);
    const attempt = await Bun.file(join(root, "selected-original/project/package.json")).exists() ? `-${Date.now()}` : "";
    if (await Bun.file(join(root, "install-completion.json")).exists()) {
      await persist(join(root, `install-completion.previous${attempt}.json`), await readFile(join(root, "install-completion.json")));
    }
    const before = join(root, `selected-original${attempt}`), target = before;
    const controlled = await calibratedEnvironment(before, receipt.tools);
    const beforeEnv = controlled.env, targetEnv = beforeEnv;
    receipt.calibrationConfigs = controlled.configs;
    await cp(join(root, "resolve-before/cache"), join(before, "cache"), { recursive: true });
    await command(before, receipt, "original-before", calibratedNpm(receipt.tools, before, `${receipt.name}@${receipt.before}`), beforeEnv, false);
    const beforeSnapshot = await snapshot(before, "before");
    const capturedBefore = join(root, `captured-before${attempt}`), capturedAfter = join(root, `captured-after${attempt}`);
    await directory(capturedBefore); await directory(capturedAfter);
    for (const name of ["prefix", "home", "bun"]) await cp(join(before, name), join(capturedBefore, name), { recursive: true, verbatimSymlinks: true });
    await cp(join(root, "resolve-target/cache"), join(target, "cache"), { recursive: true });
    const targetStart = await snapshot(target, "equivalent-before");
    need(JSON.stringify(beforeSnapshot.rows) === JSON.stringify(targetStart.rows), "Independent target did not start from equivalent before layout");
    receipt.equivalentBefore = { equal: true, original: beforeSnapshot.files, independentStart: targetStart.files,
      compared: "same selected absolute prefix/HOME/BUN_INSTALL; all prefix/home/bun files, hashes, private modes and literal symlinks; cache excluded",
      originalRoot: before, independentRoot: target, capturedBefore };
    await command(target, receipt, "independent-target", calibratedNpm(receipt.tools, target, `${receipt.name}@${receipt.target}`), targetEnv, false);
    const targetSnapshot = await snapshot(target, "target");
    const installedGraph = await slots(target);
    receipt.emptyResolutionTargetClosure = receipt.targetClosure;
    const actualState = { root, packages: new Map(), manifests: new Map(), keys: (await json(receipt.officialKeys.path)).keys };
    for (const vendor of receipt.records) {
      const identity = `${vendor.name}@${vendor.version}`;
      actualState.packages.set(identity, vendor);
      const members = await new Bun.Archive(await readFile(vendor.archive.path)).files();
      actualState.manifests.set(identity, JSON.parse(await members.get(`${vendor.archiveRoot}/package.json`).text()));
    }
    receipt.targetClosure = await closure(target, receipt, actualState);
    receipt.actualTargetResolutionDiffers = JSON.stringify(installedGraph.map(({ installName, name, version }) => ({ installName, name, version }))) !==
      JSON.stringify(receipt.emptyResolutionTargetClosure.graph.map(({ installName, name, version }) => ({ installName, name, version })));
    const previous = new Map(beforeSnapshot.rows.map(row => [row.relativePath, row]));
    receipt.comparison = { before: beforeSnapshot.files, target: targetSnapshot.files,
      changes: targetSnapshot.rows.filter(row => JSON.stringify(row) !== JSON.stringify(previous.get(row.relativePath))),
      removed: beforeSnapshot.rows.filter(row => !targetSnapshot.rows.some(after => after.relativePath === row.relativePath)),
      beforeLocks: beforeSnapshot.locks, targetLocks: targetSnapshot.locks,
      globalManifestAbsentReason: targetSnapshot.globalManifestAbsentReason };
    receipt.independentTarget = { root: target, env: targetEnv, graph: installedGraph, observation: targetSnapshot.files };
    receipt.originalBefore = { root: before, env: beforeEnv, observation: beforeSnapshot.files };
    for (const name of ["prefix", "home", "bun"]) await cp(join(target, name), join(capturedAfter, name), { recursive: true, verbatimSymlinks: true });
    receipt.capturedAfter = capturedAfter;
    const prefixSnapshot = rows => ({
      files: rows.filter(row => row.relativePath.startsWith("prefix/") && !row.symlink)
        .map(row => ({ path: row.relativePath.slice(7), sha256: row.sha256, mode: row.mode })),
      links: rows.filter(row => row.relativePath.startsWith("prefix/") && row.symlink)
        .map(row => ({ path: row.relativePath.slice(7), target: row.symlink })),
    });
    receipt.packageAuthority = {
      manager: { name: "npm", ...receipt.tools.npm, node: receipt.tools.node, files: [] },
      env: targetEnv, prefix: join(target, "prefix"),
      before: prefixSnapshot(beforeSnapshot.rows), after: prefixSnapshot(targetSnapshot.rows),
      artifacts: receipt.targetClosure.graph.map(({ name, installName, version, archive, metadata }) => ({ name, installName, version, archive, metadata })),
      postinstall: [], externalPostinstall: [],
      note: "Observed exact HOME/PATH environment; npm prefix/cache/config/registry are explicit original-manager argv. External postinstall outputs are tracked separately.",
    };
    async function managerFiles(directoryPath) {
      for (const item of await readdir(directoryPath, { withFileTypes: true })) {
        const file = join(directoryPath, item.name);
        if (item.isDirectory()) await managerFiles(file);
        else { need(item.isFile(), `Nonregular original npm manager file: ${file}`); receipt.packageAuthority.manager.files.push(await pin(file)); }
      }
    }
    await managerFiles(dirname(dirname(receipt.tools.npm.path)));
    const memberCache = new Map();
    for (const artifact of receipt.packageAuthority.artifacts) {
      const vendor = receipt.records.find(row => row.name === artifact.name && row.version === artifact.version);
      const members = memberCache.get(vendor.memberPins.path) ?? await json(vendor.memberPins.path);
      memberCache.set(vendor.memberPins.path, members);
      const memberMap = new Map(members.map(row => [row.relativePath, row.sha256]));
      const packageStart = `prefix/lib/node_modules/${artifact.installName}/`;
      for (const row of targetSnapshot.rows.filter(row => row.relativePath.startsWith(packageStart) && !row.symlink)) {
        if (memberMap.get(row.relativePath.slice(packageStart.length)) !== row.sha256) {
          receipt.packageAuthority.postinstall.push({ path: join(target, row.relativePath), sha256: row.sha256,
            acquiredOutput: await pin(join(capturedAfter, row.relativePath)) });
        }
      }
    }
    for (const row of targetSnapshot.rows.filter(row => !row.relativePath.startsWith("prefix/"))) {
      if (JSON.stringify(row) !== JSON.stringify(previous.get(row.relativePath))) {
        receipt.packageAuthority.externalPostinstall.push({ ...row, actualPath: join(target, row.relativePath),
          ...(row.symlink ? {} : { acquiredOutput: await pin(join(capturedAfter, row.relativePath)) }) });
      }
    }
    for (const name of ["prefix", "home", "bun"]) {
      await rm(join(target, name), { recursive: true });
      await cp(join(capturedBefore, name), join(target, name), { recursive: true, verbatimSymlinks: true });
    }
    const restored = await snapshot(target, "restored-before");
    need(JSON.stringify(restored.rows) === JSON.stringify(beforeSnapshot.rows), "Captured owned before restore mismatch");
    receipt.restoredBefore = { exact: true, observation: restored.files, selectedRoot: target };
    receipt.status = "GENUINE_BEFORE_TARGET_ORIGINAL_INSTALLS_COMPLETED";
  } catch (error) { receipt.status = "ORIGINAL_INSTALL_BLOCKED"; receipt.failures.push({ error: error.message, stack: error.stack }); }
  finally { await privateTree(root); receipt.resourcesRemaining = 0; receipt.ownedProcessesJoined = true; }
  const manifest = await record(join(root, "install-completion.json"), receipt);
  const kept = receipt.status === "GENUINE_BEFORE_TARGET_ORIGINAL_INSTALLS_COMPLETED"
    ? [receipt.restoredBefore.selectedRoot, receipt.capturedAfter, receipt.equivalentBefore.capturedBefore] : [];
  // Preserve the published input until inputs() replaces it, even on failure.
  if (await Bun.file(join(root, "input-manifest.json")).exists()) {
    const previousInput = await json(join(root, "input-manifest.json"));
    // selectedRoot's suffix identifies its captured-before even if the newly
    // written completion replaced the old completion referenced by the input.
    const suffix = previousInput.selectedRoot.slice(join(root, "selected-original").length);
    kept.push(previousInput.selectedRoot, previousInput.capturedAfter, join(root, `captured-before${suffix}`));
  }
  const removed = await prunePackageCopies(root, kept.filter(Boolean));
  await record(join(root, "retention.json"), { policy: "latest-input-snapshots-v1", removed, evidenceRecordsPreserved: true });
  console.log("INSTALL_DONE", JSON.stringify({ family, status: receipt.status, manifest, failures: receipt.failures }));
  if (receipt.failures.length) process.exitCode = 1;
}
async function inputs(family) {
  const root = join(outputParent, family), completion = await json(join(root, "install-completion.json"));
  need(completion.status === "GENUINE_BEFORE_TARGET_ORIGINAL_INSTALLS_COMPLETED" && completion.restoredBefore.exact, "Original installation not ready");
  const observed = completion.packageAuthority, selected = completion.restoredBefore.selectedRoot;
  const primary = join(observed.prefix, "lib/node_modules", completion.name), manifest = await json(join(primary, "package.json"));
  const binName = { claude: "claude", codex: "codex", omp: "omp", grok: "grok" }[family];
  const declaredExecutable = join(primary, typeof manifest.bin === "string" ? manifest.bin : manifest.bin[binName]);
  const executableRealpath = await realpath(declaredExecutable);
  const resources = await Promise.all([join(primary, "package.json"), executableRealpath].map(async file => ({
    resourceId: `resource:${hash(file)}`, realpath: file, fingerprint: `sha256:${hash(await readFile(file))}`,
  })));
  resources.sort((a, b) => a.realpath.localeCompare(b.realpath));
  const managerReceipt = { records: [], requests: [] };
  const managerState = { root: join(root, "manager-provenance"), packages: new Map(), manifests: new Map(),
    keys: (await json(completion.officialKeys.path)).keys };
  const npmManifest = await json(join(dirname(dirname(observed.manager.path)), "package.json"));
  const originalNpm = await acquire("npm", npmManifest.version, managerReceipt, managerState);
  const managerMembers = await json(originalNpm.memberPins.path), managerRoot = dirname(dirname(observed.manager.path));
  const memberMap = new Map(managerMembers.map(row => [row.relativePath, row.sha256]));
  for (const file of observed.manager.files) need(memberMap.get(relative(managerRoot, file.path)) === file.sha256,
    `Original npm differs from public vendor archive: ${file.path}`);
  need(observed.manager.files.length === managerMembers.length, "Original npm public archive file count mismatch");
  const requests = [], tagsUrl = `https://registry.npmjs.org/-/package/${encodeURIComponent(completion.name)}/dist-tags`;
  const tagsBytes = await get(tagsUrl, requests), tags = JSON.parse(new TextDecoder().decode(tagsBytes));
  need(tags.latest === completion.target, "Target latest changed during original install preparation");
  const checkedAt = Date.parse(requests[0].observedAt), expiresAt = checkedAt + 300000;
  const qualification = {
    installation: {
      installationId: `install:${hash(executableRealpath)}`, resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}`,
      owner: { kind: "package", manager: "npm", packageName: completion.name, prefix: observed.prefix },
      installedVersion: { kind: "known", version: completion.before }, family, channel: "latest", executableRealpath, resources,
    },
    manager: observed.manager, env: observed.env,
    target: { packageName: completion.name, version: completion.target, channel: "latest", checkedAt, expiresAt,
      artifacts: observed.artifacts, postinstall: observed.postinstall.map(({ path, sha256 }) => ({ path, sha256 })) },
    before: observed.before, after: observed.after,
  };
  const receipt = await record(join(root, "qualification-observed.json"), qualification);
  const discoveryProvenance = await record(join(root, "discovery-provenance.json"), {
    kind: "original-manager-owned-installation-observation", family,
    selectedPrefix: observed.prefix, selectedHome: observed.env.HOME,
    installation: qualification.installation, originalManager: observed.manager,
    originalInstallCompletion: await pin(join(root, "install-completion.json")),
    acquisition: await pin(join(root, "acquisition.json")), qualification: receipt,
    literalBeforeSnapshot: completion.restoredBefore.observation,
    equivalentBefore: completion.equivalentBefore,
    originalCommands: completion.originalCommands,
    sessionStarted: false, modelRequests: 0,
  });
  const result = {
    schemaVersion: 1, status: "ORIGINAL_MANAGER_INPUTS_OBSERVED_NOT_QUALIFIED",
    qualification, receipt, originalInstallCompletion: await pin(join(root, "install-completion.json")),
    managerProvenance: await record(join(root, "manager-provenance/acquisition.json"), managerReceipt),
    latestChannelObservation: await persist(join(root, "latest-dist-tags.json"), tagsBytes), requests,
    externalPostinstall: observed.externalPostinstall, capturedAfter: completion.capturedAfter,
    selectedRoot: selected, restoredBefore: completion.restoredBefore, originalCommands: completion.originalCommands,
    originalNpmMatchesOfficialArchive: true,
    discoveryProvenance, runtimeProfileSourcePins: [discoveryProvenance, receipt],
    contractNotes: [
      "env is the ACTUAL complete HOME/PATH-only calibration env admitted by configuration(); prefix/cache/config/registry are explicit argv, not ambient settings.",
      "Original manager used pinned Node with absolute npm-cli.js, explicit prefix/cache/config/env and offline lifecycle; recipe is preserved in originalCommands.",
      "Actual original npm lifecycle uses --script-shell=/bin/sh because the authority's HOME/PATH-only environment does not include a system shell directory. Retain this option for product lifecycle dispatch.",
      "Grok original postinstall produces a package-local executable symlink and outputs under owned HOME/GROK_HOME; literal links and external pins are preserved.",
      "Generated postinstall bytes are kept in capturedAfter; selected prefix and HOME were restored exactly to observed before. Do not dereference after-output paths as before-image content.",
      "Freshness uses a real registry dist-tags GET; callers must reacquire the channel when expiresAt passes, not edit timestamps.",
    ],
  };
  const output = await record(join(root, "input-manifest.json"), result);
  await privateTree(root);
  const removed = await prunePackageCopies(root, [selected, completion.capturedAfter, completion.equivalentBefore.capturedBefore]);
  await record(join(root, "retention.json"), { policy: "latest-input-snapshots-v1", removed, evidenceRecordsPreserved: true });
  console.log("INPUTS_DONE", JSON.stringify({ family, ...output, status: result.status, checkedAt, expiresAt }));
}
async function verifyInputs(family) {
  const root = join(outputParent, family), input = await json(join(root, "input-manifest.json"));
  const { qualifyPackageUpdate } = await import("../../src/adapters/package-update.ts");
  const checkedAt = Date.now();
  const result = await qualifyPackageUpdate({ qualification: input.qualification, receipt: input.receipt }, checkedAt);
  const check = { family, checkedAt, inputManifest: await pin(join(root, "input-manifest.json")),
    accepted: result.ok, ...(result.ok ? {} : { error: result.error }), runtimeStarted: false, updaterExecuted: false };
  const output = await record(join(root, "qualification-check.json"), check);
  console.log("QUALIFIER_CHECK_DONE", JSON.stringify({ ...check, output }));
}
async function audit(family) {
  const root = join(outputParent, family), input = await json(join(root, "input-manifest.json"));
  const completion = await json(input.originalInstallCompletion.path), acquisition = await json(join(root, "acquisition.json"));
  need(completion.status === "GENUINE_BEFORE_TARGET_ORIGINAL_INSTALLS_COMPLETED", "Original completion missing");
  need(hash(await readFile(input.originalInstallCompletion.path)) === input.originalInstallCompletion.sha256, "Original receipt drift");
  need(hash(await readFile(input.receipt.path)) === input.receipt.sha256, "Input qualification receipt drift");
  let verifiedArchives = 0, verifiedFiles = 0, privateDirectories = 0;
  for (const vendor of completion.records) {
    const archive = await readFile(vendor.archive.path), metadata = await readFile(vendor.metadata.path);
    need(hash(archive) === vendor.archive.sha256 && hash(metadata) === vendor.metadata.sha256, `Acquired artifact drift: ${vendor.name}@${vendor.version}`);
    need(`sha512-${hash(archive, "sha512")}` === JSON.parse(metadata).dist.integrity, "Acquired SHA512 drift");
    verifiedArchives++;
  }
  for (const [base, image] of [[input.qualification.installation.owner.prefix, input.qualification.before],
    [join(completion.capturedAfter, "prefix"), input.qualification.after]]) {
    for (const file of image.files) {
      const actual = join(base, file.path), info = await lstat(actual);
      need(hash(await readFile(actual)) === file.sha256 && (info.mode & 0o777) === file.mode, `Exact before/after reference drift: ${actual}`);
      verifiedFiles++;
    }
    for (const link of image.links) need(await readlink(join(base, link.path)) === link.target, "Literal before/after link drift");
  }
  async function privacy(directoryPath, vendorFiles = false) {
    const info = await lstat(directoryPath);
    need((info.mode & 0o777) === 0o700, `Nonprivate owned directory: ${directoryPath}`); privateDirectories++;
    for (const item of await readdir(directoryPath, { withFileTypes: true })) {
      const file = join(directoryPath, item.name);
      if (item.isDirectory()) await privacy(file, vendorFiles || ["prefix", "home", "bun", "tools"].includes(item.name));
      else if (item.isFile() && !vendorFiles) need(((await lstat(file)).mode & 0o777) === 0o600, `Nonprivate evidence record: ${file}`);
    }
  }
  await privacy(root);
  const actualCommands = completion.originalCommands.slice(-2);
  need(actualCommands.length === 2 && actualCommands.every(row => row.exitCode === 0 && row.signal === null), "Original processes not cleanly joined");
  const qualifier = await json(join(root, "qualification-check.json"));
  const result = { family, before: acquisition.before, target: acquisition.target,
    inputManifest: await pin(join(root, "input-manifest.json")), completion: await pin(join(root, "install-completion.json")),
    beforeSlots: acquisition.beforeClosure.graph.length, targetSlots: completion.targetClosure.graph.length,
    acquiredArchivesVerified: verifiedArchives, exactBeforeAfterFilesVerified: verifiedFiles, privateDirectories,
    equivalentBefore: completion.equivalentBefore.equal, restoredBefore: completion.restoredBefore.exact,
    actualResolutionDiffersFromEmptyReference: completion.actualTargetResolutionDiffers,
    originalManagerExitCodes: actualCommands.map(row => row.exitCode), qualifierAccepted: qualifier.accepted,
    externalPostinstall: completion.packageAuthority.externalPostinstall.length,
    discoveryProvenance: input.discoveryProvenance, processesJoined: actualCommands.map(row => ({ pid: row.pid, exitCode: row.exitCode, signal: row.signal })),
    resourcesRemaining: 0, cliSessions: 0, modelRequests: 0 };
  const output = await record(join(root, "verification.json"), result);
  console.log("AUDIT_DONE", JSON.stringify({ ...result, output }));
}
if (import.meta.main) {
  process.umask(0o077);
  const [mode, family, approvalPath] = process.argv.slice(2);
  need(Object.hasOwn(targets, family), "Unknown family");
  await directory(outputParent);
  const lock = join(outputParent, `.${family}-preparing`);
  await mkdir(lock, { mode: 0o700 });
  try {
  if (mode === "acquire") await acquisition(family);
  else if (mode === "install") await installation(family, approvalPath);
  else if (mode === "inputs") await inputs(family);
  else if (mode === "verify") await verifyInputs(family);
  else if (mode === "audit") await audit(family);
  else throw new Error("Usage: acquire-packages.mjs acquire <family> | install <family> <review.json> | inputs <family> | verify <family> | audit <family>");
  } finally { await rm(lock, { recursive: true }); }
}
