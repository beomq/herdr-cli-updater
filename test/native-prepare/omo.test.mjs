import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { adaptPairedLauncher, digest, inspectVendor, mergeHook, packOverlay, pairedEngineVersion, prepareOmo, safeRelative } from "../../scripts/native-prepare/omo.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sri = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-prepare-test-")));
  roots.push(root);
  const manifest = { name: "omo-ai", version: "5.1.17", files: ["bin", "plugin"],
    bin: { omo: "bin/omo.js" }, dependencies: { "@code-yeongyu/senpi": "2026.10.8" } };
  const manifestBytes = JSON.stringify(manifest);
  const bytes = await new Bun.Archive({ "package/package.json": manifestBytes,
    "package/bin/omo.js": "export const original = true;\n",
    "package/plugin/package.json": JSON.stringify({ name: "plugin", version: "5.1.17" }),
  }, { compress: "gzip" }).bytes();
  const metadata = { name: manifest.name, version: manifest.version, dist: { integrity: sri(bytes), tarball: "https://registry.npmjs.org/omo-ai/-/omo-ai-5.1.17.tgz" } };
  const filePin = async (name, body) => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { path, sha256: digest(body) };
  };
  const vendor = { name: manifest.name, version: manifest.version, installName: manifest.name,
    ...await inspectVendor(metadata, bytes, manifest.name, manifest.version),
    archive: await filePin("original.tgz", bytes), metadata: await filePin("metadata.json", JSON.stringify(metadata)) };
  const files = [{ relativePath: "bin/omo.js", source: await filePin("build/omo.js", "export const native = 4;\n") },
    { relativePath: "plugin/extensions/omo.js", source: await filePin("build/plugin.js", "export const admission = true;\n") }];
  const sourceBinding = await filePin("source-build.json", JSON.stringify({ commit: "a".repeat(40), protocolVersion: 4, nativeFlowQualified: false }));
  const npmPath = Bun.which("npm");
  if (!npmPath) throw new Error("npm is required for real pack regression tests");
  const env = { HOME: root, PATH: process.env.PATH, npm_config_userconfig: "/dev/null", npm_config_cache: join(root, "cache") };
  return { root, vendor, bytes, metadata, files, sourceBinding, filePin, npmPath, env, manifestBytes };
}

test("keeps exact engine pairing when selected wrapper metadata changes", () => {
  // Given
  const wrapper = { dependencies: { "@code-yeongyu/senpi": "2026.10.8" } };
  // When
  const version = pairedEngineVersion(wrapper);
  // Then
  expect(version).toBe("2026.10.8");
});

test("accepts only the selected original wrapper engine after adapting native launcher pairing", () => {
  // Given
  const original = 'return manifest.version !== "2026.10.1-3";';
  const packageManifest = () => ({ dependencies: { "@code-yeongyu/senpi": "2026.10.8" } });
  // When
  const rejects = new Function("manifest", "packageManifest", adaptPairedLauncher(original));
  // Then
  expect(rejects({ version: "2026.10.8" }, packageManifest)).toBe(false);
  expect(rejects({ version: "2026.10.1-3" }, packageManifest)).toBe(true);
});

test("rejects unknown pairing code when original hook context changed", () => {
  // Given / When / Then
  expect(() => adaptPairedLauncher('return manifest.version !== "unknown";')).toThrow();
});

test.each(["^2026.10.8", "latest", "npm:@code-yeongyu/senpi@2026.10.8", undefined])(
  "rejects nonexact engine pairing when declaration is %s", declaration => {
    // Given / When / Then
    expect(() => pairedEngineVersion({ dependencies: { "@code-yeongyu/senpi": declaration } })).toThrow();
  });

test.each(["/bin/omo.js", "../outside", "bin/../outside", "bin\\omo.js", "bin//omo.js", "bin/\u0000"])(
  "rejects unsafe output members when path is %s", path => {
    // Given / When / Then
    expect(() => safeRelative(path)).toThrow();
  });

test("rejects vendor bytes when independent registry integrity disagrees", async () => {
  // Given
  const f = await fixture();
  const corrupt = new Uint8Array(f.bytes);
  corrupt[0] ^= 1;
  // When / Then
  await expect(inspectVendor(f.metadata, corrupt, "omo-ai", "5.1.17")).rejects.toThrow("integrity");
});

test("preserves upstream changes when hook transplant touches another region", async () => {
  // Given
  const f = await fixture();
  const baseline = "const upstream = 1;\n\nconst unchanged = 1;\n\nconst hook = 1;\n";
  const upstream = baseline.replace("upstream = 1", "upstream = 2");
  const hooked = baseline.replace("hook = 1", "hook = 4");
  // When
  const { merged } = await mergeHook(upstream, baseline, hooked, join(f.root, "merge"), f.env);
  // Then
  expect(merged).toBe("const upstream = 2;\n\nconst unchanged = 1;\n\nconst hook = 4;\n");
});

test("rejects conflicting source changes when hook and upstream edit the same region", async () => {
  // Given
  const f = await fixture();
  // When / Then
  await expect(mergeHook("const value = 2;\n", "const value = 1;\n", "const value = 4;\n",
    join(f.root, "merge"), f.env)).rejects.toThrow("Command failed");
});

test("rejects acquired manifest when registry identity disagrees", async () => {
  // Given
  const f = await fixture();
  // When / Then
  await expect(inspectVendor(f.metadata, f.bytes, "omo-ai", "5.1.18")).rejects.toThrow("identity");
});

test("packs explicit overlays while preserving acquired metadata and manifest bytes", async () => {
  // Given
  const f = await fixture();
  const commands = [JSON.stringify({ argv: ["bun", "script/build-omo-native.ts"], exitCode: 0 })];
  // When
  const result = await packOverlay(f.vendor, f.files, f.sourceBinding, commands, f.root, { npmPath: f.npmPath }, f.env);
  // Then
  expect(result.artifact.archive).toEqual(f.vendor.archive);
  expect(result.artifact.metadata).toEqual(f.vendor.metadata);
  expect(result.grant.overlay).toEqual(result.artifact.overlay);
  expect(result.grant.overlay.archive.sha256).not.toBe(f.vendor.archive.sha256);
  expect(result.grant.overlay.sourceBinding).toEqual(f.sourceBinding);
  expect(result.grant.overlay.originalBuildCommands).toEqual(commands);
  const output = await new Bun.Archive(await readFile(result.grant.overlay.archive.path)).files();
  expect(await output.get("package/package.json").text()).toBe(f.manifestBytes);
  expect(await output.get("package/bin/omo.js").text()).toBe(await readFile(f.files[0].source.path, "utf8"));
  const original = await readFile(f.vendor.archive.path);
  expect(digest(original)).toBe(f.vendor.archive.sha256);
  expect(JSON.parse(await readFile(f.vendor.metadata.path, "utf8")).dist.integrity).toBe(sri(original));
  expect(result.targetFiles.find(row => row.relativePath === "bin/omo.js")).toMatchObject({
    installName: "omo-ai", source: { sha256: f.files[0].source.sha256 },
  });
  expect(result.grant.overlay.files[0].source.path).not.toBe(f.files[0].source.path);
  // When original source QA rebuilds an emitter after packing,
  await writeFile(f.files[0].source.path, "a later original build");
  // Then the packed provenance still points at the same genuine copied bytes.
  expect(digest(await readFile(result.grant.overlay.files[0].source.path))).toBe(f.files[0].source.sha256);
});

test("rejects source mutation when output digest no longer matches", async () => {
  // Given
  const f = await fixture();
  await writeFile(f.files[0].source.path, "changed after build");
  // When / Then
  await expect(packOverlay(f.vendor, f.files, f.sourceBinding, ["build"], f.root, { npmPath: f.npmPath }, f.env)).rejects.toThrow("digest");
});

test.each(["package.json", "plugin/package.json"])("rejects manifest overlays when path is %s", async path => {
  // Given
  const f = await fixture();
  const files = [{ ...f.files[0], relativePath: path }];
  // When / Then
  await expect(packOverlay(f.vendor, files, f.sourceBinding, ["build"], f.root, { npmPath: f.npmPath }, f.env)).rejects.toThrow("manifest");
});

test("rejects missing hooks when npm allowlist omits compiled output", async () => {
  // Given
  const f = await fixture();
  const files = [{ ...f.files[0], relativePath: "excluded/native.js" }];
  // When / Then
  await expect(packOverlay(f.vendor, files, f.sourceBinding, ["build"], f.root, { npmPath: f.npmPath }, f.env)).rejects.toThrow("missing");
});

test("does not overwrite previous preparation when output already exists", async () => {
  // Given
  const f = await fixture();
  const marker = await f.filePin("keep", "preserve");
  // When / Then
  await expect(prepareOmo({ version: "5.1.17", outputDir: f.root, wrapperHooksSource: f.root, engineHooksSource: f.root,
    bunPath: "/usr/bin/false", npmPath: "/usr/bin/false", nodePath: "/usr/bin/false" })).rejects.toThrow();
  expect(digest(await readFile(marker.path))).toBe(marker.sha256);
});
