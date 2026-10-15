import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmoPreparationError, prepareOmoInstallationRuntime } from "./prepare-omo-runtime";
import type { PrepareOmoRuntimeOptions } from "./prepare-omo-runtime";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omo-prepare-"))); roots.push(root);
  const directory = join(root, "prepare"), prefix = join(root, "prefix"), ownerDirectory = join(root, "owner"),
    socketDirectory = join(root, "sockets"), bin = join(root, "tools/bun"), global = join(prefix, "install/global");
  for (const path of [directory, ownerDirectory, socketDirectory, join(root, "tools"),
    join(prefix, "bin"), join(global, "node_modules/omo-ai")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  // This file must never run: acquisition and geometry errors precede manager dispatch.
  writeFileSync(bin, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  writeFileSync(join(prefix, "bin/omo"), "#!/bin/sh\nexit 98\n", { mode: 0o700 });
  const declaration = { dependencies: { "omo-ai": "^5.1.9", "another": "npm:actual@^2.0.0" }, trustedDependencies: ["omo-ai"],
    description: "shared declaration" };
  writeFileSync(join(global, "package.json"), JSON.stringify(declaration), { mode: 0o600 });
  writeFileSync(join(global, "node_modules/omo-ai/package.json"), JSON.stringify({ name: "omo-ai", version: "5.1.9" }), { mode: 0o600 });
  const options: PrepareOmoRuntimeOptions = { directory, prefix, bun: bin, ownerDirectory, socketDirectory,
    registeredSockets: [], rootPids: [process.pid] };
  return { options, global, declaration };
}
describe("ordinary OmO preparation boundary", () => {
  test.each([
    { trusted: ["omo-ai", "@google/genai", "protobufjs"], reviewed: true },
    { trusted: ["omo-ai", "unreviewed-hook"], reviewed: false },
  ])("preserves reviewed trust declarations before source acquisition: $reviewed", async ({ trusted, reviewed }) => {
    // Given: the declaration is existing user configuration, not rewritten approval.
    const { options, global, declaration } = fixture();
    const path = join(global, "package.json");
    writeFileSync(path, JSON.stringify({ ...declaration, trustedDependencies: trusted }));
    const before = readFileSync(path);
    let requests = 0;
    // When: acquisition is deliberately rejected before any manager can run.
    const pending = prepareOmoInstallationRuntime(options, { request: async () => {
      requests++; return Response.json({}, { status: 502 });
    } });
    // Then: reviewed names proceed to source checks; unknown hooks remain refused.
    await expect(pending).rejects.toMatchObject({ reason: reviewed ? "source" : "configuration" });
    expect(requests).toBe(reviewed ? 1 : 0);
    expect(readFileSync(path)).toEqual(before);
  });
  test.each([false, true])("unrelated external links are opaque, but declared roots are refused: declared=%s", async declared => {
    // Given: a dangling external link cannot be read or copied as package data.
    const { options, global, declaration } = fixture();
    const path = join(global, "node_modules/external-tools"), target = join(options.directory, "not-a-package");
    symlinkSync(target, path);
    if (declared) writeFileSync(join(global, "package.json"), JSON.stringify({
      ...declaration, dependencies: { ...declaration.dependencies, "external-tools": "1.0.0" },
    }));
    let requests = 0;
    // When: independent preparation scans the existing shared installation.
    const preparation = prepareOmoInstallationRuntime(options, { request: async () => {
      requests++; return Response.json({}, { status: 502 });
    } });
    // Then: opaque unrelated links survive; a linked root cannot enter resolution.
    await expect(preparation).rejects.toMatchObject({ reason: declared ? "configuration" : "source" });
    expect(requests).toBe(declared ? 0 : 1);
    expect(readlinkSync(path)).toBe(target);
  });
  test("rejects overlapping output before reading or dispatching sources", async () => {
    // Given
    const { options } = fixture(); let requests = 0;
    const directory = join(options.prefix, "prepare"); mkdirSync(directory, { mode: 0o700 });
    // When
    const preparation = prepareOmoInstallationRuntime({ ...options, directory }, {
      request: async () => { requests++; return Response.json({}); },
    });
    // Then
    await expect(preparation).rejects.toMatchObject({ reason: "geometry" });
    expect(requests).toBe(0); expect(readdirSync(directory)).toEqual([]);
  });
  test("refuses configuration by name without opening credential content", async () => {
    // Given
    const { options, global } = fixture();
    const path = join(global, ".npmrc"); mkdirSync(path, { mode: 0o700 });
    // When
    const preparation = prepareOmoInstallationRuntime(options);
    // Then
    await expect(preparation).rejects.toMatchObject({ reason: "configuration" });
    expect(readdirSync(options.directory)).toEqual([]);
  });
  test("refuses a directory masquerading as a dependency configuration", async () => {
    // Given: a directory cannot be consumed as TOML, so reading it would fail
    // differently. The configuration guard must stop on its name first.
    const { options, global } = fixture(), packageRoot = join(global, "node_modules/agent-messenger");
    mkdirSync(join(packageRoot, "bunfig.toml"), { recursive: true, mode: 0o700 });
    writeFileSync(join(packageRoot, "package.json"), '{"name":"agent-messenger","version":"2.38.1"}');
    const declarationPath = join(global, "package.json"), original = readFileSync(declarationPath);
    let requests = 0;
    // When
    const preparation = prepareOmoInstallationRuntime(options, {
      request: async () => { requests++; return Response.json({}); },
    });
    // Then
    await expect(preparation).rejects.toMatchObject({ reason: "configuration" });
    expect(requests).toBe(0); expect(readFileSync(declarationPath)).toEqual(original);
    expect(readdirSync(options.directory)).toEqual([]);
  });
  test("preserves regular dependency Bun payload without treating it as active global config", async () => {
    const { options, global } = fixture(), packageRoot = join(global, "node_modules/agent-messenger");
    mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(packageRoot, "package.json"), '{"name":"agent-messenger","version":"2.38.1"}', { mode: 0o600 });
    const file = join(packageRoot, "bunfig.toml");
    writeFileSync(file, "[install]\noptional=false\n", { mode: 0o600 });
    const original = readFileSync(file);
    let requests = 0;
    await expect(prepareOmoInstallationRuntime(options, { request: async () => {
      requests++; return Response.json({}, { status: 502 });
    } })).rejects.toMatchObject({ reason: "source" });
    expect(requests).toBe(1); expect(readFileSync(file)).toEqual(original);
  });
  test("still refuses active global Bun configuration before acquisition", async () => {
    const { options, global } = fixture();
    mkdirSync(join(global, "bunfig.toml"), { mode: 0o700 });
    let requests = 0;
    await expect(prepareOmoInstallationRuntime(options, { request: async () => {
      requests++; return Response.json({});
    } })).rejects.toMatchObject({ reason: "configuration" });
    expect(requests).toBe(0);
  });
  test("does not strip unrelated trusted lifecycle declarations", async () => {
    // Given
    const { options, global, declaration } = fixture(), path = join(global, "package.json");
    const original = JSON.stringify({ ...declaration, trustedDependencies: ["omo-ai", "another"] });
    writeFileSync(path, original);
    // When
    const preparation = prepareOmoInstallationRuntime(options);
    // Then
    await expect(preparation).rejects.toMatchObject({ reason: "configuration" });
    expect(readFileSync(path, "utf8")).toBe(original); expect(readdirSync(options.directory)).toEqual([]);
  });
  test("requires a fresh official audited target without altering the shared manifest", async () => {
    // Given
    const { options, global } = fixture(), path = join(global, "package.json"), original = readFileSync(path);
    const urls: string[] = [];
    // When
    const preparation = prepareOmoInstallationRuntime(options, {
      request: async request => { urls.push(request.url); return Response.json({ name: "omo-ai", version: "5.1.18" }); },
    });
    // Then
    await expect(preparation).rejects.toBeInstanceOf(OmoPreparationError);
    expect(urls).toEqual(["https://registry.npmjs.org/omo-ai/latest"]);
    expect(readFileSync(path)).toEqual(original); expect(readdirSync(options.directory).sort()).toEqual(["home"]);
  });
  test("rejects mismatching official tarball integrity before manager dispatch", async () => {
    // Given
    const { options, global } = fixture(), original = readFileSync(join(global, "package.json"));
    const archive = new Uint8Array([1, 2, 3]);
    // When
    const preparation = prepareOmoInstallationRuntime(options, { request: async request => {
      if (request.url.endsWith("/latest")) return Response.json({ version: "5.1.19", gitHead: "a8019016f47a9d814ebcc24bd921a561f065ee80" });
      if (request.url.endsWith(".tgz")) return new Response(archive);
      return Response.json({ name: "omo-ai", version: "5.1.19", dist: {
        tarball: "https://registry.npmjs.org/omo-ai/-/omo-ai-5.1.19.tgz", integrity: `sha512-${"A".repeat(86)}==`,
      } });
    } });
    // Then
    await expect(preparation).rejects.toMatchObject({ reason: "source", detail: "integrity: omo-ai@5.1.19" });
    expect(readFileSync(join(global, "package.json"))).toEqual(original);
    expect(readdirSync(options.directory).sort()).toEqual(["home"]);
  });
});
