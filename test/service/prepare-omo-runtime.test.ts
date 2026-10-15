import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareOmoInstallationRuntime } from "../../src/service/prepare-omo-runtime";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const target = { version: "5.1.27", gitHead: "a44f2f7af8485dcc6ed9d8ae69851d6b7202f00c",
  dependencies: { "@code-yeongyu/senpi": "2026.10.10-9" } };
function fixture(version = "5.1.24") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omo-supported-source-"))); roots.push(root);
  const directory = join(root, "prepare"), prefix = join(root, "prefix"), ownerDirectory = join(root, "owner"),
    socketDirectory = join(root, "sockets"), bun = join(root, "tools/bun"), global = join(prefix, "install/global");
  for (const path of [directory, ownerDirectory, socketDirectory, join(root, "tools"),
    join(prefix, "bin"), join(global, "node_modules/omo-ai")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(bun, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  writeFileSync(join(prefix, "bin/omo"), "#!/bin/sh\nexit 98\n", { mode: 0o700 });
  const manifest = join(global, "package.json");
  writeFileSync(manifest, JSON.stringify({ dependencies: { "omo-ai": version }, trustedDependencies: ["omo-ai"] }));
  writeFileSync(join(global, "node_modules/omo-ai/package.json"), JSON.stringify({ name: "omo-ai", version }));
  return { options: { directory, prefix, bun, ownerDirectory, socketDirectory, registeredSockets: [], rootPids: [process.pid] },
    manifest, original: readFileSync(manifest) };
}
async function archive(name: string, version: string, extra: Record<string, unknown> = {}) {
  const bytes = new Uint8Array(await new Bun.Archive({ "package/package.json": JSON.stringify({ name, version, ...extra }) }).bytes());
  return { bytes, meta: { name, version, gitHead: target.gitHead, dist: {
    tarball: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  } } };
}
describe("supported genuine OmO source contract", () => {
  test.each(["5.1.27", "5.1.28"])("resolves latest %s without a release-number allowlist and still checks lifecycle source", async version => {
    // Given: genuine-shaped wire artifacts, deliberately missing audited lifecycle members.
    const { options, manifest, original } = fixture(), urls: string[] = [];
    const wrapper = await archive("omo-ai", version, { dependencies: { "@code-yeongyu/senpi": "2026.10.10-9" } });
    const engine = await archive("@code-yeongyu/senpi", "2026.10.10-9");
    // When
    const preparation = prepareOmoInstallationRuntime(options, { request: async request => {
      urls.push(request.url);
      if (request.url.endsWith("/latest")) return Response.json({ ...target, version });
      for (const row of [wrapper, engine]) {
        if (request.url === row.meta.dist.tarball) return new Response(row.bytes);
        if (request.url.endsWith(`/${row.meta.version}`)) return Response.json(row.meta);
      }
      throw new Error(`unexpected acquisition: ${request.url}`);
    } });
    // Then: source validation, not the fake manager, stops the transaction.
    await expect(preparation).rejects.toMatchObject({ reason: "source", detail: "unaudited lifecycle source: bin/senpi-patch.mjs" });
    expect(urls).toContain("https://registry.npmjs.org/%40code-yeongyu%2Fsenpi/2026.10.10-9");
    expect(readFileSync(manifest)).toEqual(original);
  });
  test.each([
    { version: "5.1.28-beta.1", gitHead: target.gitHead },
    { version: target.version, gitHead: "../main" },
  ])("rejects invalid stable version or commit before artifact acquisition: %j", async latest => {
    // Given
    const { options, manifest, original } = fixture(), urls: string[] = [];
    // When
    const preparation = prepareOmoInstallationRuntime(options, { request: async request => {
      urls.push(request.url); return Response.json(latest);
    } });
    // Then
    await expect(preparation).rejects.toMatchObject({ reason: "source" });
    expect(urls).toEqual(["https://registry.npmjs.org/omo-ai/latest"]);
    expect(readFileSync(manifest)).toEqual(original);
  });
  test("rejects an already current installation without dispatch", async () => {
    // Given
    const { options } = fixture(target.version), urls: string[] = [];
    // When
    const preparation = prepareOmoInstallationRuntime(options, { request: async request => {
      urls.push(request.url); return Response.json(target);
    } });
    // Then
    await expect(preparation).rejects.toMatchObject({ reason: "configuration" });
    expect(urls).toHaveLength(1);
  });
  test("rejects target metadata commit disagreement despite matching archive integrity", async () => {
    // Given
    const { options } = fixture();
    const wrapper = await archive("omo-ai", target.version), engine = await archive("@code-yeongyu/senpi", "2026.10.10-9");
    // When
    const preparation = prepareOmoInstallationRuntime(options, { request: async request => {
      if (request.url.endsWith("/latest")) return Response.json(target);
      for (const row of [wrapper, engine]) {
        if (request.url === row.meta.dist.tarball) return new Response(row.bytes);
        if (request.url.endsWith(`/${row.meta.version}`)) return Response.json({ ...row.meta, gitHead: "0".repeat(40) });
      }
      throw new Error(`unexpected acquisition: ${request.url}`);
    } });
    // Then
    await expect(preparation).rejects.toMatchObject({ reason: "source", detail: "target metadata differs from audited official contract" });
  });
  test("rejects a different paired engine even when both archives pass integrity", async () => {
    // Given
    const { options } = fixture();
    const wrapper = await archive("omo-ai", target.version, { dependencies: { "@code-yeongyu/senpi": "2026.10.10-6" } });
    const engine = await archive("@code-yeongyu/senpi", "2026.10.10-9");
    // When
    const preparation = prepareOmoInstallationRuntime(options, { request: async request => {
      if (request.url.endsWith("/latest")) return Response.json(target);
      for (const row of [wrapper, engine]) {
        if (request.url === row.meta.dist.tarball) return new Response(row.bytes);
        if (request.url.endsWith(`/${row.meta.version}`)) return Response.json(row.meta);
      }
      throw new Error(`unexpected acquisition: ${request.url}`);
    } });
    // Then
    await expect(preparation).rejects.toMatchObject({ reason: "source", detail: "exact paired Senpi required" });
  });
  test("rejects current target archive integrity disagreement before dispatch", async () => {
    // Given
    const { options, manifest, original } = fixture();
    const wrapper = await archive("omo-ai", target.version);
    // When
    const preparation = prepareOmoInstallationRuntime(options, { request: async request => {
      if (request.url.endsWith("/latest")) return Response.json(target);
      if (request.url.endsWith(".tgz")) return new Response(new Uint8Array([1, 2, 3]));
      return Response.json(wrapper.meta);
    } });
    // Then
    await expect(preparation).rejects.toMatchObject({ reason: "source", detail: "integrity: omo-ai@5.1.27" });
    expect(readFileSync(manifest)).toEqual(original);
  });
});
