#!/usr/bin/env bun
// Produces local source overlays, not native admission or install qualification.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { latestManagerResolution, latestTypesResolution, latestRpcResolution, latestEngineResolutions,
  currentHookResolutions, selectedHookResolutions, resolveCurrentHook,
  resolveLatestManager, resolveLatestTypes, resolveLatestRpc, resolveLatestEngineHook } from "./latest-hook-resolution.mjs";

const wrapperPaths = ["packages/omo-native/bin", "packages/omo-senpi/src", "packages/senpi-task/src"];
const enginePaths = ["packages/agent/src", "packages/coding-agent/src", "packages/tui/src", "packages/senpi-codemode/src"];
const bridgePath = "packages/coding-agent/src/core/updater-native-bridge.ts";
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const json = async path => JSON.parse(await readFile(path, "utf8"));
const pin = async path => ({ path: await realpath(path), sha256: digest(await readFile(path)) });
const persist = async (path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); return pin(path); };

export function safeRelative(path) {
  requireValue(typeof path === "string" && path.length > 0 && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every(part => part && part !== "." && part !== ".."), `Unsafe path: ${path}`);
  return path;
}

export function pairedEngineVersion(manifest) {
  const version = manifest.dependencies?.["@code-yeongyu/senpi"];
  requireValue(typeof version === "string" && exactVersion.test(version), "Wrapper must pin an exact paired Senpi engine");
  return version;
}

export function adaptPairedLauncher(source) {
  const fixed = 'manifest.version !== "2026.10.1-3"';
  requireValue(source.split(fixed).length === 2, "Unknown native launcher pairing context");
  return source.replace(fixed, 'manifest.version !== packageManifest().dependencies["@code-yeongyu/senpi"]');
}

async function get(url, asJson = false) {
  const parsed = new URL(url);
  requireValue(parsed.protocol === "https:" && !parsed.username && !parsed.password
    && ["registry.npmjs.org", "api.github.com", "codeload.github.com"].includes(parsed.hostname),
  `Unsupported acquisition URL: ${url}`);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120000),
    headers: { "User-Agent": "herdr-native-prepare", Accept: asJson ? "application/json" : "*/*" } });
  requireValue(response.ok, `Acquisition failed: HTTP ${response.status} ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, value: asJson ? JSON.parse(new TextDecoder().decode(bytes)) : undefined };
}

/** Same identity/integrity boundary as the existing package assembler. */
export async function inspectVendor(metadata, bytes, name, version) {
  requireValue(metadata.name === name && metadata.version === version, `Registry identity mismatch: ${name}@${version}`);
  requireValue(metadata.dist?.integrity === integrity(bytes), `Vendor integrity mismatch: ${name}@${version}`);
  const files = await new Bun.Archive(bytes).files();
  for (const path of files.keys()) {
    safeRelative(path);
    requireValue(path.startsWith("package/"), `Unsafe package member: ${path}`);
  }
  const manifestFile = files.get("package/package.json");
  requireValue(manifestFile, `Missing package manifest: ${name}@${version}`);
  const manifest = JSON.parse(await manifestFile.text());
  requireValue(manifest.name === name && manifest.version === version, `Archive identity mismatch: ${name}@${version}`);
  return { files, manifest };
}

async function acquirePackage(name, version, output, installName = name) {
  requireValue(exactVersion.test(version), `Exact version required: ${name}@${version}`);
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
  const metadataResponse = await get(url, true);
  const archiveResponse = await get(metadataResponse.value.dist.tarball);
  const checked = await inspectVendor(metadataResponse.value, archiveResponse.bytes, name, version);
  const directory = join(output, "vendor", name.replaceAll("/", "-").replace("@", ""), version);
  return { name, version, installName, ...checked, rawMetadata: metadataResponse.value, metadataUrl: url,
    archive: await persist(join(directory, "original.tgz"), archiveResponse.bytes),
    metadata: await persist(join(directory, "metadata.json"), metadataResponse.bytes) };
}

/** Acquisition extraction is performed by tar, not in-script source rewriting. */
async function materialize(files, archivePath, root, prefix, env) {
  for (const path of files.keys()) {
    safeRelative(path);
    requireValue(path.startsWith(prefix), `Archive member outside root: ${path}`);
    const relative = path.slice(prefix.length);
    if (!relative) continue;
    safeRelative(relative);
  }
  await mkdir(root, { recursive: true });
  await command(["/usr/bin/tar", "-xzf", archivePath, "--strip-components", "1", "-C", root], root, env);
}

async function acquireSource(repo, commit, directory, output, env) {
  requireValue(/^[a-f0-9]{40}$/.test(commit), `Source commit required for ${repo}`);
  const url = `https://codeload.github.com/${repo}/tar.gz/${commit}`;
  const response = await get(url);
  const archive = await persist(join(output, "source-archives", `${repo.replace("/", "-")}-${commit}.tgz`), response.bytes);
  const files = await new Bun.Archive(response.bytes).files();
  const prefix = `${repo.split("/")[1]}-${commit}/`;
  await materialize(files, archive.path, directory, prefix, env);
  // GitHub source archives omit submodule contents. Resolve the selected commit's
  // gitlinks, not a branch's latest submodule versions.
  const tree = (await get(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`, true)).value;
  requireValue(!tree.truncated, `Truncated source tree: ${repo}@${commit}`);
  const links = tree.tree.filter(entry => entry.mode === "160000");
  const submodules = [];
  if (links.length) {
    const config = await readFile(join(directory, ".gitmodules"), "utf8");
    const declarations = config.split(/\[submodule [^\]]+\]/).slice(1).map(section => ({
      path: /^\s*path\s*=\s*(.+)$/m.exec(section)?.[1]?.trim(),
      url: /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim(),
    }));
    for (const link of links) {
      safeRelative(link.path);
      const declaration = declarations.find(row => row.path === link.path);
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(declaration?.url ?? "");
      requireValue(match, `Unsupported submodule URL at ${repo}:${link.path}`);
      submodules.push(await acquireSource(match[1], link.sha, join(directory, link.path), output, env));
    }
  }
  return { repo, commit, archive, submodules };
}

async function command(argv, cwd, env, logPath, stdin) {
  const child = Bun.spawn(argv, { cwd, env, stdin: stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  if (stdin) { child.stdin.write(stdin); child.stdin.end(); }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (logPath) await persist(logPath, JSON.stringify({ argv, cwd, exitCode,
    stdout: await persist(`${logPath}.stdout.txt`, stdout),
    stderr: await persist(`${logPath}.stderr.txt`, stderr) }, null, 2));
  requireValue(exitCode === 0, `Command failed (${exitCode}): ${argv.join(" ")}${logPath ? `; log: ${logPath}` : ""}\n${stderr.slice(-3000)}\n${stdout.slice(-3000)}`);
  return stdout;
}

/** Three-way transplant preserves nonoverlapping upstream changes without fuzz. */
export async function mergeHook(upstream, baseline, hooked, scratch, env, reviewed) {
  await mkdir(scratch, { recursive: true });
  const paths = [join(scratch, "upstream"), join(scratch, "baseline"), join(scratch, "hooked")];
  for (const [index, bytes] of [upstream, baseline, hooked].entries()) await persist(paths[index], bytes);
  try {
    return { merged: await command(["/usr/bin/diff3", "-m", ...paths], scratch, env, join(scratch, "merge.json")) };
  } catch (error) {
    if (!reviewed || ![latestManagerResolution.relativePath, latestTypesResolution.relativePath, latestRpcResolution.relativePath,
      ...latestEngineResolutions.map(row => row.relativePath),
      ...currentHookResolutions.map(row => row.relativePath),
      ...selectedHookResolutions.map(row => row.relativePath)].includes(reviewed.relativePath)) throw error;
    const log = await json(join(scratch, "merge.json"));
    if (log.exitCode !== 1) throw error;
    const resolveHook = ["5.1.19", "5.1.21"].includes(reviewed.version) ? resolveCurrentHook
      : reviewed.relativePath === latestManagerResolution.relativePath ? resolveLatestManager
      : reviewed.relativePath === latestTypesResolution.relativePath ? resolveLatestTypes
        : reviewed.relativePath === latestRpcResolution.relativePath ? resolveLatestRpc : resolveLatestEngineHook;
    return resolveHook({ ...reviewed, upstream, baseline, hooked,
      conflicted: await readFile(log.stdout.path, "utf8") });
  }
}

async function sourceChangePatch(targetPath, upstream, merged, scratch, env) {
  const before = await persist(join(scratch, "patch-preimage"), upstream);
  const after = await persist(join(scratch, "patch-postimage"), merged);
  const child = Bun.spawn(["/usr/bin/diff", "-u", before.path, after.path],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [diff, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  requireValue(exitCode === 0 || exitCode === 1, `Source patch diff failed (${exitCode}): ${stderr}`);
  if (exitCode === 0) return "";
  return `*** Update File: ${targetPath}\n` + diff.split("\n").slice(2)
    .map(line => line.startsWith("@@ ") ? "@@" : line).join("\n");
}

/** Export only current production source changes, never historical evidence. */
async function applyHooks(source, target, paths, env, output, label, options, commit) {
  const baselineCommit = (await command(["/usr/bin/git", "rev-parse", "HEAD"], source, env)).trim();
  const changed = (await command(["/usr/bin/git", "diff", "--name-only", "HEAD", "--", ...paths], source, env)).trim().split("\n")
    .filter(path => /\.(?:ts|js|mjs)$/.test(path) && !/\.test\./.test(path));
  requireValue(changed.length, `No native hook changes in ${source}`);
  for (const path of changed) safeRelative(path);
  const patch = await command(["/usr/bin/git", "diff", "--no-ext-diff", "--no-renames", "--binary", "HEAD", "--", ...changed], source, env);
  const patchPin = await persist(join(output, "hooks", `${label}.patch`), patch);
  // A unified patch's context may have moved in newer sources. Merge against the
  // hook checkout's actual baseline; conflicting edits remain a hard blocker.
  const changes = [];
  const plannedFiles = [];
  const reviewedResolutions = [];
  const baselinePins = [];
  const unresolved = [];
  for (const path of changed) {
    const baseline = await command(["/usr/bin/git", "show", `HEAD:${path}`], source, env);
    baselinePins.push({ relativePath: path, sha256: digest(baseline) });
    const upstream = await readFile(join(target, path), "utf8");
    let result;
    try {
      result = await mergeHook(upstream, baseline, await readFile(join(source, path)),
        join(output, "hooks", label, path), env, { version: options.version, commit, relativePath: path });
    } catch (error) {
      unresolved.push({ relativePath: path, error: error.message });
      continue;
    }
    const merged = label === "wrapper" && path === "packages/omo-native/bin/lib/launcher.js"
      ? adaptPairedLauncher(result.merged) : result.merged;
    if (result.resolution) reviewedResolutions.push(result.resolution);
    requireValue(upstream.endsWith("\n") && merged.endsWith("\n"), `Source requires explicit no-newline reconciliation: ${path}`);
    changes.push(await sourceChangePatch(join(target, path), upstream, merged, join(output, "hooks", label, path), env));
    plannedFiles.push({ path: join(target, path), sha256: digest(merged) });
  }
  requireValue(unresolved.length === 0, `Unreviewed ${label} source conflicts: ${JSON.stringify(unresolved)}`);
  const additions = [];
  if (label === "engine") {
    for (const path of [bridgePath, "packages/coding-agent/test/updater-native-bridge.test.ts",
      "packages/tui/test/stdin-buffer-managed-boundary.test.ts"]) {
      const bytes = await readFile(join(source, path), "utf8");
      requireValue(!await Bun.file(join(target, path)).exists(), `Upstream already owns ${path}; reconcile hooks before preparing`);
      requireValue(bytes.endsWith("\n"), `Native source requires newline: ${path}`);
      changes.push(`*** Add File: ${join(target, path)}\n`
        + bytes.slice(0, -1).split("\n").map(line => `+${line}\n`).join(""));
      plannedFiles.push({ path: join(target, path), sha256: digest(bytes) });
    }
  }
  const sourcePatch = `*** Begin Patch\n${changes.join("")}*** End Patch\n`;
  const applicationPatch = await persist(join(output, "hooks", `${label}-apply.patch`), sourcePatch);
  if (options.sourcePatchesOnly) return { baselineCommit, baselinePins, patch: patchPin, applicationPatch, plannedFiles, reviewedResolutions };
  requireValue(options.applyPatchPath && isAbsolute(options.applyPatchPath), `Source edits require an actual apply_patch executable; pending patch: ${applicationPatch.path}`);
  await command([options.applyPatchPath], target, env, join(output, "logs", `${label}-apply.json`), sourcePatch);
  if (label === "engine") additions.push(await pin(join(target, bridgePath)));
  return { baselineCommit, baselinePins, patch: patchPin, applicationPatch, reviewedResolutions, files: await Promise.all(changed.map(path => pin(join(target, path)))), additions };
}

async function outputFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await outputFiles(path, relativePath));
    else {
      requireValue(entry.isFile(), `Nonregular build output: ${path}`);
      if (!relativePath.endsWith(".map") && !relativePath.includes(".test.")) files.push({ relativePath, source: await pin(path) });
    }
  }
  return files;
}

export async function packOverlay(vendor, files, sourceBinding, originalBuildCommands, output, tools, env) {
  requireValue(files.length > 0 && originalBuildCommands.length > 0, "Empty source overlay or build commands");
  const seen = new Set();
  for (const file of files) {
    safeRelative(file.relativePath);
    requireValue(!["package.json", "plugin/package.json"].includes(file.relativePath), "Vendor manifest overlay forbidden");
    requireValue(!seen.has(file.relativePath), `Duplicate overlay path: ${file.relativePath}`);
    seen.add(file.relativePath);
    requireValue(isAbsolute(file.source.path) && await realpath(file.source.path) === file.source.path
      && (await stat(file.source.path)).isFile(), `Noncanonical output pin: ${file.source.path}`);
    requireValue(digest(await readFile(file.source.path)) === file.source.sha256, `Output digest mismatch: ${file.source.path}`);
  }
  requireValue(digest(await readFile(sourceBinding.path)) === sourceBinding.sha256, "Source binding digest mismatch");
  const stage = join(output, "stages", vendor.name.replaceAll("/", "-").replace("@", ""), vendor.version);
  await mkdir(stage, { recursive: true });
  await materialize(vendor.files, vendor.archive.path, stage, "package/", env);
  for (const file of files) {
    const target = join(stage, file.relativePath);
    await mkdir(dirname(target), { recursive: true });
    // Package assembly copies only original builder outputs, never edits source.
    await command(["/bin/cp", file.source.path, target], stage, env);
  }
  // npm pack applies the unchanged vendor allowlist. Confirm it did not omit hooks.
  const archives = join(output, "archives");
  await mkdir(archives, { recursive: true });
  const packed = JSON.parse(await command([tools.npmPath, "pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", archives],
    stage, env, join(output, "logs", `${vendor.name.replaceAll("/", "-")}-pack.json`)));
  const rows = Array.isArray(packed) ? packed : Object.values(packed);
  requireValue(rows.length === 1, "Expected one npm pack result");
  safeRelative(rows[0].filename);
  const archivePath = join(archives, rows[0].filename);
  const bytes = await readFile(archivePath);
  const actual = await new Bun.Archive(bytes).files();
  requireValue(await actual.get("package/package.json")?.text() === await vendor.files.get("package/package.json").text(), "Vendor manifest changed");
  for (const file of files) {
    const blob = actual.get(`package/${file.relativePath}`);
    requireValue(blob && digest(new Uint8Array(await blob.arrayBuffer())) === file.source.sha256, `Packed overlay missing or changed: ${file.relativePath}`);
  }
  const targetFiles = [];
  for (const [path, blob] of actual) {
    const relativePath = safeRelative(path.slice("package/".length));
    const source = await pin(join(stage, relativePath));
    requireValue(source.sha256 === digest(new Uint8Array(await blob.arrayBuffer())), `Packed target mismatch: ${relativePath}`);
    targetFiles.push({ installName: vendor.installName, relativePath, source });
  }
  const overlay = { kind: "local-source-overlay", archive: await pin(archivePath),
    localDist: { integrity: integrity(bytes), tarballPath: `/tarballs/${digest(bytes)}.tgz` },
    sourceBinding, originalBuildCommands,
    // Original emitter directories are mutable: source QA may legitimately
    // rebuild them. Bind the actual packed copies instead, not those emitters.
    files: await Promise.all(files.map(async file => ({ relativePath: file.relativePath,
      source: await pin(join(stage, file.relativePath)) }))) };
  return { artifact: { name: vendor.name, version: vendor.version, installName: vendor.installName,
    archive: vendor.archive, metadata: vendor.metadata, overlay },
    grant: { vendorArchive: vendor.archive, vendorMetadata: vendor.metadata, overlay }, targetFiles };
}

/**
 * Inputs are producer-owned hook checkouts and explicit build tools, not client
 * qualification claims. A fresh directory is retained on failure for diagnosis.
 */
export async function prepareOmo(options) {
  const { version, wrapperHooksSource, engineHooksSource, bunPath, npmPath, nodePath } = options;
  requireValue(exactVersion.test(version), "An exact selected OmO version is required");
  const output = resolve(options.outputDir);
  for (const path of [output, wrapperHooksSource, engineHooksSource, bunPath, npmPath, nodePath]) {
    requireValue(typeof path === "string" && isAbsolute(path) && !path.split("/").includes(".omo"), `Absolute non-evidence input required: ${path}`);
  }
  requireValue(await realpath(dirname(output)) === dirname(output), "Output parent must be canonical");
  if (!options.resume && !options.replan) await mkdir(output); // Exclusive reservation.
  const home = join(output, "home");
  if (!options.resume && !options.replan) await mkdir(home);
  const env = { HOME: home, TMPDIR: join(output, "tmp"), PATH: `${dirname(bunPath)}:${dirname(nodePath)}:${dirname(npmPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    npm_config_userconfig: "/dev/null", npm_config_cache: join(output, "npm-cache"), BUN_INSTALL_CACHE_DIR: join(output, "bun-cache"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    CI: "true", HUSKY: "0" };
  if (!options.resume && !options.replan) await mkdir(env.TMPDIR);
  const receiptPath = join(output, "preparation.json");
  const receipt = options.resume || options.replan ? await json(receiptPath) : { schemaVersion: 1, status: "PREPARING", nativeFlowQualified: false,
    target: { packageName: "omo-ai", version }, originalBuildCommands: [], acquisitions: [] };
  const priorAcquisitions = receipt.acquisitions;
  const repacking = options.resume && (receipt.status === "LOCAL_SOURCE_OVERLAY_PACKED_NOT_INSTALL_QUALIFIED" || options.rebuild === true);
  let runOutput = output;
  let restoreVendor;
  try {
    let wrapper, engine;
    if (options.resume || options.replan) {
      const retryUnbuilt = version === "5.1.21" && receipt.status === "BLOCKED"
        && receipt.originalBuildCommands.length === 0 && Object.keys(receipt.hooks).length === 2
        && receipt.blocker?.includes("UnknownLockfileVersion: failed to parse lockfile");
      requireValue(receipt.target.version === version && (options.resume ? receipt.status === "SOURCE_PATCHES_REQUIRED" || repacking || retryUnbuilt
        : receipt.status === "BLOCKED" && options.sourcePatchesOnly && receipt.originalBuildCommands.length === 0 && receipt.sources?.length === 2),
      "Only pending patches or an unbuilt failed patch plan may resume");
      for (const hook of options.resume ? Object.values(receipt.hooks) : []) {
        requireValue(digest(await readFile(hook.applicationPatch.path)) === hook.applicationPatch.sha256, "Source patch artifact changed");
        for (const file of hook.plannedFiles) requireValue((await pin(file.path)).sha256 === file.sha256, `Source patch not applied exactly: ${file.path}`);
        hook.files = hook.plannedFiles;
        hook.additions = [];
      }
      restoreVendor = async row => {
        requireValue(digest(await readFile(row.archive.path)) === row.archive.sha256
          && digest(await readFile(row.metadata.path)) === row.metadata.sha256, "Acquired vendor pin changed");
        const metadata = await json(row.metadata.path);
        return { ...row, installName: row.installName ?? row.name, rawMetadata: metadata, metadataUrl: `https://registry.npmjs.org/${encodeURIComponent(row.name)}/${row.version}`,
          ...await inspectVendor(metadata, await readFile(row.archive.path), row.name, row.version) };
      };
      wrapper = await restoreVendor(receipt.acquisitions[0]);
      engine = await restoreVendor(receipt.acquisitions[1]);
    } else {
      wrapper = await acquirePackage("omo-ai", version, output);
    }
    if (repacking) {
      await persist(join(output, `preparation.previous-${receipt.preparationAttempt ?? 0}.json`), await readFile(receiptPath));
      receipt.preparationAttempt = (receipt.preparationAttempt ?? 0) + 1;
      runOutput = join(output, "attempts", String(receipt.preparationAttempt));
      await mkdir(join(output, "attempts"), { recursive: true });
      await mkdir(runOutput);
      // Publication staging intentionally rewrites workspace manifests. Reuse
      // the already successful locked installations, not another frozen install
      // against those staged manifests. Verify every reused command's real log.
      const installed = receipt.originalBuildCommands.filter(entry => ["install", "ci"].includes(JSON.parse(entry).argv[1]));
      requireValue(installed.length === 2, "Two original locked installs required for repack");
      for (const entry of installed) {
        const record = JSON.parse(entry);
        requireValue(digest(await readFile(record.log.path)) === record.log.sha256
          && (await json(record.log.path)).exitCode === 0, "Original install observation changed");
      }
      receipt.originalBuildCommands = installed;
    }
    const engineVersion = pairedEngineVersion(wrapper.manifest);
    receipt.target.engineVersion = engineVersion;
    if (!engine) engine = await acquirePackage("@code-yeongyu/senpi", engineVersion, output);
    receipt.acquisitions = [wrapper, engine].map(({ name, version, archive, metadata }) => ({ name, version, archive, metadata }));
    receipt.acquiredReplies = [wrapper, engine].map(row => ({ url: row.metadataUrl, status: 200, body: row.metadata }));
    await persist(receiptPath, JSON.stringify(receipt, null, 2));
    const wrapperRoot = join(output, "sources", "wrapper"), engineRoot = join(output, "sources", "engine");
    if (!options.resume) {
    if (!options.replan) {
    const engineRef = (await get(`https://api.github.com/repos/code-yeongyu/senpi/git/ref/tags/v${engineVersion}`, true)).value.object;
    const engineCommit = engineRef.type === "tag"
      ? (await get(`https://api.github.com/repos/code-yeongyu/senpi/git/tags/${engineRef.sha}`, true)).value.object.sha : engineRef.sha;
    receipt.sources = [
      await acquireSource("code-yeongyu/oh-my-openagent", wrapper.rawMetadata.gitHead, wrapperRoot, output, env),
      await acquireSource("code-yeongyu/senpi", engineCommit, engineRoot, output, env),
    ];
    }
    requireValue((await json(join(wrapperRoot, "packages/omo-native/package.json"))).version === version, "Wrapper source version mismatch");
    requireValue((await json(join(engineRoot, "packages/coding-agent/package.json"))).version === engineVersion, "Engine source version mismatch");
    const plans = await Promise.allSettled([
      applyHooks(wrapperHooksSource, wrapperRoot, wrapperPaths, env, output, "wrapper", options, receipt.sources[0].commit),
      applyHooks(engineHooksSource, engineRoot, enginePaths, env, output, "engine", options, receipt.sources[1].commit),
    ]);
    receipt.hooks = {};
    for (const [index, plan] of plans.entries()) if (plan.status === "fulfilled") receipt.hooks[index === 0 ? "wrapper" : "engine"] = plan.value;
    requireValue(plans.every(plan => plan.status === "fulfilled"), plans.filter(plan => plan.status === "rejected").map(plan => plan.reason.message).join("\n"));
    if (options.sourcePatchesOnly) {
      delete receipt.blocker;
      receipt.status = "SOURCE_PATCHES_REQUIRED";
      await persist(receiptPath, JSON.stringify(receipt, null, 2));
      return receipt;
    }
    }
    const build = async (argv, cwd, label) => {
      const logPath = join(runOutput, "logs", `${label}.json`);
      await command(argv, cwd, env, logPath);
      receipt.originalBuildCommands.push(JSON.stringify({ argv, cwd, log: await pin(logPath) }));
    };
    // Original locked installs and original build paths; no synthetic compiler.
    if (!repacking) await build(["5.1.19", "5.1.21"].includes(version)
      ? [npmPath, "ci", "--ignore-scripts"]
      : [bunPath, "install", "--frozen-lockfile", "--ignore-scripts"], engineRoot, "engine-install");
    await build([npmPath, "run", "build"], engineRoot, "engine-build");
    await build([nodePath, "scripts/prepare-senpi-bundled-workspaces.mjs"], engineRoot, "engine-package-staging");
    if (!repacking) await build([bunPath, "install", "--frozen-lockfile", "--ignore-scripts"], wrapperRoot, "wrapper-install");
    const pluginRoot = join(runOutput, "plugin");
    await build([bunPath, "script/build-omo-native.ts", "--output", pluginRoot], wrapperRoot, "wrapper-build");
    await build([bunPath, "script/build-omo-native.ts", "--check-only", "--output", pluginRoot], wrapperRoot, "wrapper-completeness");
    const sourceBinding = await persist(join(runOutput, "source-build.json"), JSON.stringify({
      sources: receipt.sources, hooks: receipt.hooks, originalBuildCommands: receipt.originalBuildCommands,
      tools: await Promise.all([bunPath, npmPath, nodePath].map(pin)), nativeFlowQualified: false,
    }, null, 2));
    const wrapperFiles = [
      ...(await outputFiles(join(wrapperRoot, "packages/omo-native/bin"))).map(file => ({ ...file, relativePath: `bin/${file.relativePath}` })),
      ...(await outputFiles(pluginRoot)).filter(file => file.relativePath !== "package.json")
        .map(file => ({ ...file, relativePath: `plugin/${file.relativePath}` })),
    ];
    const targets = [{ vendor: wrapper, files: wrapperFiles }];
    const workspaces = [
      ["coding-agent", "@code-yeongyu/senpi", "@code-yeongyu/senpi", ["dist", "vendor"]],
      ["agent", "@code-yeongyu/senpi-agent-core", "@earendil-works/pi-agent-core", ["dist", "assets"]],
      ["tui", "@code-yeongyu/senpi-tui", "@earendil-works/pi-tui", ["dist"]],
      ["senpi-codemode", "@code-yeongyu/senpi-codemode", "@code-yeongyu/senpi-codemode", ["src"]],
    ];
    for (const [directory, name, installName, roots] of workspaces) {
      const previous = priorAcquisitions?.find(row => row.name === name && row.version === engineVersion);
      const vendor = name === engine.name ? engine : previous && restoreVendor
        ? await restoreVendor({ ...previous, installName }) : await acquirePackage(name, engineVersion, output, installName);
      if (vendor !== engine) {
        receipt.acquisitions.push({ name: vendor.name, version: vendor.version, archive: vendor.archive, metadata: vendor.metadata });
        receipt.acquiredReplies.push({ url: vendor.metadataUrl, status: 200, body: vendor.metadata });
      }
      const files = [];
      for (const root of roots) {
        const path = join(engineRoot, "packages", directory, root);
        if (!await stat(path).catch(() => null)) continue;
        files.push(...(await outputFiles(path)).map(file => ({ ...file, relativePath: `${root}/${file.relativePath}` })));
      }
      targets.push({ vendor, files });
    }
    const produced = [];
    for (const target of targets) produced.push(await packOverlay(target.vendor, target.files, sourceBinding, receipt.originalBuildCommands, runOutput, options, env));
    delete receipt.blocker;
    receipt.status = "LOCAL_SOURCE_OVERLAY_PACKED_NOT_INSTALL_QUALIFIED";
    receipt.sourceBinding = sourceBinding;
    receipt.artifacts = produced.map(row => row.artifact);
    receipt.overlayGrants = produced.map(row => row.grant);
    receipt.targetFiles = produced.flatMap(row => row.targetFiles);
    receipt.provenance = [sourceBinding, ...receipt.acquisitions.flatMap(row => [row.archive, row.metadata])];
    receipt.sourceDiffs = Object.values(receipt.hooks).map(row => row.patch);
    receipt.sourcePins = [sourceBinding, ...Object.values(receipt.hooks).flatMap(row => [row.patch, row.applicationPatch, ...row.files, ...row.additions])];
    await persist(receiptPath, JSON.stringify(receipt, null, 2));
    return receipt;
  } catch (error) {
    receipt.status = "BLOCKED";
    receipt.blocker = error instanceof Error ? error.message : String(error);
    await persist(receiptPath, JSON.stringify(receipt, null, 2));
    throw new Error(`Preparation blocked; receipt: ${receiptPath}\n${receipt.blocker}`, { cause: error });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flags = ["version", "output", "wrapper-hooks", "engine-hooks", "bun", "npm", "node", "apply-patch", "source-patches-only", "resume", "replan"];
  const values = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]?.replace(/^--/, "");
    requireValue(flags.includes(flag) && args[i + 1] && !values[flag], `Invalid argument: ${args[i]}`);
    values[flag] = args[i + 1];
  }
  for (const flag of flags.filter(flag => !["apply-patch", "source-patches-only", "resume", "replan"].includes(flag))) requireValue(values[flag], `Missing --${flag}`);
  console.log(JSON.stringify(await prepareOmo({ version: values.version, outputDir: values.output,
    wrapperHooksSource: values["wrapper-hooks"], engineHooksSource: values["engine-hooks"],
    bunPath: values.bun, npmPath: values.npm, nodePath: values.node, applyPatchPath: values["apply-patch"],
    sourcePatchesOnly: values["source-patches-only"] === "true", resume: values.resume === "true", replan: values.replan === "true" }), null, 2));
}
