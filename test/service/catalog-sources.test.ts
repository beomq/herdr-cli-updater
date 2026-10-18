import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { createCatalogSourceOwner } from "../../src/service/catalog-sources";
import type { CatalogSourceEnvironment, CatalogSourceOwner } from "../../src/service/catalog-sources";
import { catalogRegistryDirectory, createAutomaticCatalogProvider, registerCatalog } from "../../src/service/catalog-provider";
import { readCatalog } from "../../src/catalog";
import { FAMILIES } from "../../src/adapters/types";
import { createHash } from "node:crypto";
import type { Family } from "../../src/protocol";
import * as filesystem from "node:fs/promises";
import type { BufferEncodingOption, ObjectEncodingOptions, PathLike } from "node:fs";
import { artifactPath, artifactTest } from "../fixtures/artifacts";

const roots: string[] = [], owners: CatalogSourceOwner[] = [], closes: (() => Promise<void>)[] = [];
function root(): string {
  const p = realpathSync(mkdtempSync("/tmp/auto-cat-"));
  roots.push(p);
  return p;
}
function artifact(p: string, body: string | Uint8Array, mode = 0o700) {
  mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(p, body, { mode });
  return p;
}
const names = {
  omo: "omo-ai", omp: "@oh-my-pi/pi-coding-agent", pi: "@earendil-works/pi-coding-agent",
  claude: "@anthropic-ai/claude-code", codex: "@openai/codex", grok: "@xai-official/grok",
} as const;
function installed(home: string, family: Exclude<Family, "agy" | "cursor">, layout = "packages") {
  const base = join(home, layout, family), executable = artifact(join(base, "cli"),
    `#!/usr/bin/env bun\nthrow new Error("automatic collector must never execute ${family}");\n`);
  artifact(join(base, "package.json"), JSON.stringify({ name: names[family], version: "1.2.3", bin: { [family]: "cli" } }), 0o600);
  mkdirSync(join(home, "bin"), { recursive: true, mode: 0o700 });
  symlinkSync(executable, join(home, "bin", family));
  return executable;
}
test("standalone Senpi stays unclassified while upstream Pi uses its own package identity", async () => {
  const home = root();
  const upstream = installed(home, "pi");
  const base = join(home, "standalone-senpi"), entry = artifact(join(base, "cli"), "#!/usr/bin/env bun\n");
  artifact(join(base, "package.json"), JSON.stringify({ name: "@code-yeongyu/senpi", version: "2026.10.1-3", bin: { pi: "cli", senpi: "cli" } }), 0o600);
  symlinkSync(entry, join(home, "bin/senpi"));
  const { source } = owner(home);
  const observed = await source.refresh();
  expect(observed.state).toBe("complete");
  expect(observed.candidates.map(row => row.installation.executableRealpath)).toEqual([upstream]);
  expect(readFileSync(entry, "utf8")).toBe("#!/usr/bin/env bun\n");
});
test("isolates a refused known package manifest without hiding independent installations", async () => {
  const home = root(), directory = join(home, "worker"); mkdirSync(directory, { mode: 0o700 });
  const grok = installed(home, "grok");
  const manifest = artifact(join(home, ".bun/install/global/node_modules/omo-ai/package.json"), "{invalid", 0o600);
  const owner = createCatalogSourceOwner(directory, { home, path: join(home, "bin"), prefixes: [] });
  owners.push(owner);
  const scan = await owner.refresh();
  expect(scan.failures.some(row => row.sourcePath === manifest && row.code === "verification_failed")).toBe(true);
  expect(scan.references.find(row => row.path === manifest)?.familyHint).toBe("omo");
  const provider = createAutomaticCatalogProvider(directory, owner);
  const observed = await readCatalog(await provider(undefined, "installations"));
  expect(observed.failures).toEqual([]);
  expect(observed.installations.map(row => row.executableRealpath)).toEqual([grok]);
});

test("keeps qualified mutation namespaces out of automatic sticky pins while observing other installations", async () => {
  const home = root(), directory = join(home, "worker"); mkdirSync(directory, { mode: 0o700 });
  const grok = installed(home, "grok"), codex = installed(home, "codex");
  const owned = join(home, "bin/grok");
  const owner = createCatalogSourceOwner(directory, { home, path: join(home, "bin"), prefixes: [] }, undefined, [owned]);
  owners.push(owner);
  const before = await owner.refresh();
  expect(before.state).toBe("complete");
  expect(before.candidates.map(row => row.installation.executableRealpath)).toEqual([codex]);
  artifact(grok, "changed by the private updater");
  const after = await owner.refresh();
  expect(after.state).toBe("complete"); expect(after.failures).toEqual([]);
  expect(after.candidates.map(row => row.installation.executableRealpath)).toEqual([codex]);
});

test.each(["same", "different"] as const)("isolates a refused generic alias only for the same known physical target: %s", async scenario => {
  const home = root(), directory = join(home, "worker"); mkdirSync(directory, { mode: 0o700 });
  const grok = installed(home, "grok"), codex = installed(home, "codex");
  const genericTarget = scenario === "same" ? grok : artifact(join(home, "unknown-cli"), "#!/usr/bin/env bun\n");
  symlinkSync(genericTarget, join(home, "bin/agent"));
  const source = createCatalogSourceOwner(directory, { home, path: join(home, "bin"), prefixes: [] });
  owners.push(source);
  await source.refresh();
  artifact(grok, "#!/usr/bin/env bun\nthrow new Error('changed');\n");
  if (scenario === "different") artifact(genericTarget, "#!/usr/bin/env bun\nthrow new Error('unclassified drift');\n");
  const catalog = await readCatalog(await createAutomaticCatalogProvider(directory, source)());
  if (scenario === "same") {
    expect(catalog.failures).toEqual([]);
    expect(catalog.installations.map(row => row.executableRealpath)).toEqual([codex]);
  } else {
    expect(catalog.failures.length).toBeGreaterThan(0);
    expect(catalog.installations).toEqual([]);
  }
});

function npmNative(home: string, aliased = false) {
  const pkg = join(home, "npm/lib/node_modules/@openai/codex");
  const wrapper = artifact(join(pkg, "bin/codex.js"), readFileSync(join(import.meta.dir,
    "../fixtures/evidence/task-5/families/codex/bounded-source/npm/codex.js"), "utf8"));
  artifact(join(pkg, "package.json"), JSON.stringify({
    name: "@openai/codex", version: "0.156.0", bin: { codex: "bin/codex.js" },
  }), 0o600);
  const selected = join(pkg, "node_modules/@openai/codex-darwin-arm64");
  const platform = aliased ? join(home, "platform") : selected;
  artifact(join(platform, "package.json"), JSON.stringify({
    name: "@openai/codex", version: "0.156.0-darwin-arm64",
  }), 0o600);
  const target = artifact(join(platform, "vendor/aarch64-apple-darwin/bin/codex"), "owned native target marker");
  if (aliased) {
    mkdirSync(join(selected, ".."), { recursive: true, mode: 0o700 });
    symlinkSync(platform, selected);
  }
  mkdirSync(join(home, "bin"), { mode: 0o700 });
  symlinkSync(wrapper, join(home, "bin/codex"));
  return { target, selected, platform };
}

test("qualified Bun package manifests never enter automatic sticky pins", async () => {
  // Given: a qualified writer owns one package namespace, not the whole HOME.
  const home = root(), directory = join(home, "worker");
  mkdirSync(directory, { mode: 0o700 });
  const codex = installed(home, "codex");
  const owned = join(home, ".bun/install/global/node_modules/omo-ai");
  const manifest = artifact(join(owned, "package.json"), JSON.stringify({ name: "omo-ai", version: "5.1.24" }), 0o600);
  const source = createCatalogSourceOwner(directory, { home, path: join(home, "bin"), prefixes: [] }, undefined, [owned]);
  owners.push(source);
  await source.refresh();
  // When: an approved update changes the package manifest.
  writeFileSync(manifest, JSON.stringify({ name: "omo-ai", version: "5.1.27" }));
  const result = await source.refresh();
  // Then: its private before/after reader owns validation; independent discovery survives.
  expect(result.failures).toEqual([]);
  expect(result.candidates.map(row => row.installation.executableRealpath)).toEqual([codex]);
  const state = JSON.parse(readFileSync(join(catalogRegistryDirectory(directory), "auto-sources.json"), "utf8"));
  expect(state.pins.some((row: { path: string }) => row.path === manifest)).toBe(false);
});
function owner(home: string, extra: Partial<CatalogSourceEnvironment> = {}, clock?: () => number) {
  const directory = join(home, "worker");
  mkdirSync(directory, { mode: 0o700 });
  const source = createCatalogSourceOwner(directory, { home, path: join(home, "bin"), prefixes: [], ...extra }, clock);
  owners.push(source);
  return { source, directory };
}
function claudeBuild(version: string) {
  return `PACKAGE_URL:"@anthropic-ai/claude-code",README_URL:"https://code.claude.com/docs/en/overview",VERSION:"${version}",FEEDBACK_CHANNEL:"https://github.com/anthropics/claude-code/issues",BUILD_TIME:"2026-08-26T05:55:19Z",GIT_SHA:"89c726188daf6407b6b57bf67d312f2958e5b9f2"`;
}
function nativeClaude(home: string, body = claudeBuild("2.1.300")) {
  const executable = artifact(join(home, ".local/share/claude/versions/not-a-version"),
    Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.alloc(65500), Buffer.from(body)]));
  mkdirSync(join(home, ".local/bin"), { recursive: true, mode: 0o700 });
  symlinkSync(executable, join(home, ".local/bin/claude"));
  return executable;
}
function cursorRuntime(home: string, body: string) {
  const version = join(home, ".local/share/cursor-agent/versions/not-a-version");
  const wrapper = artifact(join(version, "cursor-agent"), readFileSync(artifactPath("task-5/families/cursor/boundedsource/installed-wrapper.sh"), "utf8"));
  artifact(join(version, "package.json"), JSON.stringify({ name: "@anysphere/agent-cli-runtime" }), 0o600);
  artifact(join(version, "node"), "owned interpreter marker");
  const payload = artifact(join(version, "index.js"), body);
  mkdirSync(join(home, "bin"), { recursive: true, mode: 0o700 });
  symlinkSync(wrapper, join(home, "bin/cursor-agent"));
  return { wrapper, payload };
}
async function omoFixture(home: string, provenance: "archive" | "bounded-source" = "archive") {
  const evidence = join(import.meta.dir, "../fixtures/evidence/task-5/families/omo");
  const wrapper = join(home, "packages/omo"), engine = join(home, "engine");
  for (const [archive, digest, destination, members] of [
    ["omo-ai-5.1.9.tgz", "6140150aacec28ed0a33115fe294ac29e528737b8b0f8dc8f263e1e80d7686f6", wrapper,
      ["package/package.json", "package/bin/**"]],
    ["senpi-2026.10.1-3.tgz", "a807496c7d4a387f28548bfb9fb8d9fc3db389681ac735754df7a391f55dc268", engine,
      ["package/package.json", "package/dist/index.js", "package/dist/bundle/cli.js", "package/dist/cli.js", "package/dist/core/brand.js"]],
  ] as const) {
    const bytes = readFileSync(artifactPath(join("task-5/families/omo/acquired", archive)));
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new TypeError("immutable archive drift");
    for (const [name, file] of await new Bun.Archive(bytes).files(members))
      artifact(join(destination, name.slice("package/".length)), new Uint8Array(await file.arrayBuffer()),
        name === "package/package.json" ? 0o600 : 0o700);
  }
  const resolver = join(wrapper, "bin/lib/package-paths.js");
  if (provenance === "bounded-source") writeFileSync(resolver, readFileSync(join(evidence, "boundedsource/omo/bin/lib/package-paths.js")));
  const expected = "da57bd6016ab85a0f65f53cde53ca3b2e8606e2efc515bcb592d637c24401e67";
  if (createHash("sha256").update(readFileSync(resolver)).digest("hex") !== expected) throw new TypeError("immutable resolver drift");
  const selected = join(wrapper, "node_modules/@code-yeongyu/senpi");
  mkdirSync(join(selected, ".."), { recursive: true, mode: 0o700 });
  symlinkSync(engine, selected);
  mkdirSync(join(home, "bin"), { recursive: true, mode: 0o700 });
  const executable = join(engine, "dist/bundle/cli.js");
  symlinkSync(join(wrapper, "bin/omo.js"), join(home, "bin/omo"));
  for (const name of ["pi", "senpi", "engine-alias"]) symlinkSync(executable, join(home, "bin", name));
  return { wrapper, engine, executable, resolver, selected };
}
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const source of owners.splice(0)) await source.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true });
});

test("enumerates all eight lookup references without inventing native family evidence", async () => {
  // Given: six bin-bound packages and two native lookup refs with no vendor map.
  const home = root();
  for (const family of ["omo", "omp", "pi", "claude", "codex", "grok"] as const) installed(home, family);
  artifact(join(home, "bin", "agy"), "unmapped native artifact");
  artifact(join(home, "bin", "cursor-agent"), "#!/bin/bash\nunknown cursor wrapper\n");
  const { source } = owner(home);
  // When
  const result = await source.refresh();
  // Then: eight lookup policies ran, but unknown native bytes do not qualify.
  expect(result.state).toBe("complete");
  expect(new Set(result.references.map(row => row.familyHint))).toEqual(new Set(FAMILIES));
  expect(result.candidates.map(row => row.family).sort()).toEqual(["claude", "codex", "grok", "omo", "omp", "pi"]);
  expect(result.families.filter(row => row.state === "unclassified").map(row => row.family)).toEqual(["agy", "cursor"]);
  expect(result.candidates.every(row => row.installation.owner.kind === "unknown")).toBe(true);
});

test("deduplicates canonical file aliases without merging independent installations", async () => {
  // Given
  const home = root(), first = installed(home, "codex");
  symlinkSync(first, join(home, "bin", "another-alias"));
  const second = artifact(join(home, "separate", "cli"), readFileSync(first, "utf8"));
  artifact(join(home, "separate", "package.json"), JSON.stringify({
    name: "@openai/codex", version: "1.2.3", bin: { codex: "cli" },
  }), 0o600);
  mkdirSync(join(home, "second-bin"), { mode: 0o700 });
  symlinkSync(second, join(home, "second-bin", "codex"));
  const { source } = owner(home, { path: `${join(home, "bin")}:${join(home, "second-bin")}` });
  // When
  const result = await source.refresh();
  // Then
  expect(result.candidates).toHaveLength(2);
  expect(result.references.some(row => row.path.endsWith("/another-alias") && row.classified)).toBe(true);
  expect(new Set(result.candidates.map(row => row.installation.installationId)).size).toBe(2);
});

test.each(["rewrite", "chmod", "alias", "reappear"] as const)("does not relearn %s after owner restart", async change => {
  // Given: first pins were automatically and durably captured.
  const home = root(), executable = installed(home, "codex"), first = owner(home);
  expect((await first.source.refresh()).candidates).toHaveLength(1);
  const p = join(catalogRegistryDirectory(first.directory), "auto-sources.json"), before = readFileSync(p, "utf8");
  await first.source.close();
  if (change === "rewrite") writeFileSync(executable, "different bytes");
  if (change === "chmod") chmodSync(executable, 0o500);
  if (change === "alias") {
    const other = artifact(join(home, "other"), "replacement");
    rmSync(join(home, "bin", "codex"));
    symlinkSync(other, join(home, "bin", "codex"));
  }
  if (change === "reappear") {
    rmSync(executable);
    const absent = createCatalogSourceOwner(first.directory, { home, path: join(home, "bin"), prefixes: [] });
    owners.push(absent);
    await absent.refresh();
    await absent.close();
    writeFileSync(executable, "replacement after disappearance", { mode: 0o700 });
  }
  const restarted = createCatalogSourceOwner(first.directory, { home, path: join(home, "bin"), prefixes: [] });
  owners.push(restarted);
  // When
  const after = await restarted.refresh();
  // Then
  expect(after.failures.some(row => row.code === "verification_failed")).toBe(true);
  expect(after.candidates).toEqual([]);
  if (change !== "reappear") expect(readFileSync(p, "utf8")).toBe(before);
});

test("classifies the terminal package rather than an agent or renamed launcher hint", async () => {
  // Given
  const home = root(), grok = installed(home, "grok");
  symlinkSync(grok, join(home, "bin", "agent"));
  artifact(join(home, "bin", "cursor-agent"), `#!/bin/sh\nexec "${grok}" "$@"\n`);
  const { source, directory } = owner(home);
  // When
  const snapshot = await readCatalog(await createAutomaticCatalogProvider(directory, source)());
  // Then
  expect(snapshot.installations).toHaveLength(1);
  expect(snapshot.installations[0]?.family).toBe("grok");
  expect(snapshot.observations.every(row => Object.values(row.contract.capabilities).every(cap => cap.kind !== "supported"))).toBe(true);
});

test("enumerates npm and Homebrew roots outside PATH", async () => {
  // Given
  const home = root(), npm = join(home, "npm"), brew = join(home, "brew");
  artifact(join(npm, "lib/node_modules/@openai/codex/bin/cli"), "owned npm bin");
  artifact(join(npm, "lib/node_modules/@openai/codex/package.json"), JSON.stringify({
    name: "@openai/codex", version: "2.3.4", bin: { codex: "bin/cli" },
  }), 0o600);
  artifact(join(brew, "Cellar/grok/1.0/bin/grok"), "owned brew bin");
  artifact(join(brew, "Cellar/grok/1.0/package.json"), JSON.stringify({
    name: "@xai-official/grok", version: "3.4.5", bin: { grok: "bin/grok" },
  }), 0o600);
  const { source } = owner(home, { path: "", prefixes: [npm, brew] });
  // When
  const result = await source.refresh();
  // Then
  expect(result.candidates.map(row => row.family).sort()).toEqual(["codex", "grok"]);
  expect(result.candidates.every(row => row.installation.owner.kind === "unknown")).toBe(true);
});

test("collects all root socket metadata without connecting or confusing client sockets", async () => {
  // Given
  const home = root(), configHome = join(home, "config"), paths = [
    join(configHome, "herdr/herdr.sock"), join(configHome, "herdr/sessions/second/herdr.sock"),
    join(configHome, "herdr-dev/herdr.sock"), join(configHome, "herdr/sessions/.dot-name/herdr.sock"),
    join(configHome, "herdr/sessions/_underscore/herdr.sock"), join(configHome, "herdr/herdr-client.sock"),
  ];
  let connects = 0;
  for (const path of paths) {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const server = createServer(socket => { connects++; socket.destroy(); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
    closes.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  }
  artifact(join(configHome, "herdr/sessions/not-a-directory"), "unrelated session-root file", 0o600);
  const { source } = owner(home, { configHome });
  // When
  const result = await source.refresh();
  // Then
  expect([...result.sockets].sort()).toEqual(paths.slice(0, 5).sort());
  expect(connects).toBe(0);
  expect(result.families.every(row => row.state === "missing")).toBe(true);
});

test("deadline expiry cannot publish an apparently complete partial acquisition", async () => {
  // Given: time itself is under test; no sleep or wall-time assertion.
  const home = root();
  installed(home, "codex");
  let calls = 0;
  const { source, directory } = owner(home, {}, () => calls++ === 0 ? 0 : 4000);
  // When
  const result = await source.refresh();
  // Then
  expect(result.state).toBe("incomplete");
  expect(result.families.every(row => row.state === "incomplete")).toBe(true);
  expect(existsSync(join(home, "worker.catalog", "auto-sources.json"))).toBe(false);
  expect(directory).toBe(join(home, "worker"));
});

test("explicit sources have whole-document precedence over automatic state", async () => {
  // Given: explicit Grok differs from automatically observed Codex.
  const home = root(), codex = installed(home, "codex"), { source, directory } = owner(home);
  const provider = createAutomaticCatalogProvider(directory, source);
  expect((await readCatalog(await provider())).installations[0]?.family).toBe("codex");
  const grok = installed(home, "grok"), sha256 = createHash("sha256").update(readFileSync(grok)).digest("hex");
  registerCatalog(directory, JSON.stringify({ version: 1, candidates: [
    { family: "grok", executable: { path: grok, sha256 }, provenance: null, sources: [] },
  ], sockets: [] }));
  writeFileSync(codex, "tampered automatic candidate");
  const explicit = readFileSync(join(catalogRegistryDirectory(directory), "sources.json"), "utf8");
  // When
  const result = await readCatalog(await provider());
  // Then
  expect(result.installations.map(row => row.family)).toEqual(["grok"]);
  expect(result.failures).toEqual([]);
  expect(readFileSync(join(catalogRegistryDirectory(directory), "sources.json"), "utf8")).toBe(explicit);
});

test("publication during asynchronous acquisition wins over the older automatic observation", async () => {
  // Given: pause before real acquisition; the publisher is an actual safe file.
  const home = root();
  installed(home, "codex");
  const grok = installed(home, "grok"), { source, directory } = owner(home);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const provider = createAutomaticCatalogProvider(directory, { ...source, refresh: async signal => {
    entered.resolve();
    await release.promise;
    return source.refresh(signal);
  } });
  const pending = provider();
  await entered.promise;
  registerCatalog(directory, JSON.stringify({ version: 1, candidates: [{
    family: "grok", executable: { path: grok, sha256: createHash("sha256").update(readFileSync(grok)).digest("hex") },
    provenance: null, sources: [],
  }], sockets: [] }));
  // When
  release.resolve();
  const result = await readCatalog(await pending);
  // Then
  expect(result.installations.map(row => row.family)).toEqual(["grok"]);
});

test("pins a reviewed npm native target and rejects its replacement after restart", async () => {
  // Given: task-owned static resolver fixture, not vendor or native qualification.
  const home = root(), { target } = npmNative(home);
  const { source, directory } = owner(home);
  const first = await source.refresh();
  expect(first.candidates[0]?.pins.some(pin => pin.path === target)).toBe(true);
  await source.close();
  writeFileSync(target, "changed native target only");
  const restarted = createCatalogSourceOwner(directory, { home, path: join(home, "bin"), prefixes: [] });
  owners.push(restarted);
  // When
  const after = await readCatalog(await createAutomaticCatalogProvider(directory, restarted)());
  // Then
  expect(after.installations).toEqual([]);
  expect(after.failures[0]?.error.code).toBe("verification_failed");
});

test("quarantines a drifted family without hiding independently pinned installations", async () => {
  // Given: both families are captured by the real source owner.
  const home = root(), codex = installed(home, "codex");
  installed(home, "grok");
  const { source, directory } = owner(home), provider = createAutomaticCatalogProvider(directory, source);
  expect((await readCatalog(await provider())).installations).toHaveLength(2);
  // When: only the first family changes outside the updater.
  writeFileSync(codex, "changed pinned source");
  const observed = await source.refresh(), catalog = await readCatalog(await provider());
  // Then: the source refusal is retained and no alias of Codex is readmitted.
  expect(observed.failures.some(row => row.code === "verification_failed")).toBe(true);
  expect(catalog.installations.map(row => row.family)).toEqual(["grok"]);
  expect(catalog.observations[0]?.contract.capabilities.update.kind).not.toBe("supported");
});

test("keeps an independent installation of the same family when an old executable drifts", async () => {
  // Given: two physical Codex installations, not two aliases of the same one.
  const home = root(), old = installed(home, "codex"), independent = join(home, "independent");
  const current = installed(independent, "codex");
  const { source, directory } = owner(home, { path: `${join(home, "bin")}:${join(independent, "bin")}` });
  const provider = createAutomaticCatalogProvider(directory, source);
  expect((await readCatalog(await provider())).installations).toHaveLength(2);
  // When
  writeFileSync(old, "changed old installation");
  const catalog = await readCatalog(await provider());
  // Then: the independent installation stays read-only and the old one is absent.
  expect(catalog.installations.map(row => row.executableRealpath)).toEqual([current]);
  expect(catalog.observations[0]?.contract.capabilities.update.kind).not.toBe("supported");
});

artifactTest("keeps the genuine OmO wrapper when an unrelated old OmO executable drifts", async () => {
  // Given: the reviewed wrapper/engine closure plus an unrelated old installation.
  const home = root(), current = await omoFixture(home), legacy = join(home, "legacy");
  const old = installed(legacy, "omo");
  const { source, directory } = owner(home, { path: `${join(legacy, "bin")}:${join(home, "bin")}` });
  const provider = createAutomaticCatalogProvider(directory, source);
  expect((await readCatalog(await provider())).installations).toHaveLength(2);
  // When: the old executable changes without changing the current closure.
  writeFileSync(old, "replaced old OmO executable");
  const catalog = await readCatalog(await provider());
  // Then: Pi stays grouped with the current OmO, and no update authority is granted.
  expect(catalog.installations.map(row => row.executableRealpath)).toEqual([join(current.wrapper, "bin/omo.js")]);
  expect(catalog.observations.every(row => row.contract.family === "omo"
    && row.contract.capabilities.update.kind !== "supported")).toBe(true);
});

artifactTest("an older pre-bundle OmO engine layout stays unclassified without quarantining the current installation", async () => {
  // Given: the current closure plus an npm-style old OmO whose engine declares
  // bin.pi at dist/bundle/cli.js but ships only dist/cli.js (senpi <= 2026.9.x).
  const home = root(), current = await omoFixture(home), legacy = join(home, "legacy");
  const oldWrapper = join(legacy, "lib/node_modules/omo-ai"), oldEngine = join(oldWrapper, "node_modules/@code-yeongyu/senpi");
  artifact(join(oldWrapper, "package.json"), JSON.stringify({ name: "omo-ai", version: "5.0.0-0.beta.48", bin: { omo: "bin/omo.js" },
    dependencies: { "@code-yeongyu/senpi": "2026.9.7-2" } }), 0o600);
  artifact(join(oldWrapper, "bin/omo.js"), "#!/usr/bin/env node\nconsole.log('old omo');\n");
  artifact(join(oldEngine, "package.json"), JSON.stringify({ name: "@code-yeongyu/senpi", version: "2026.9.7-2", main: "./dist/index.js",
    exports: { ".": { import: "./dist/index.js" } }, bin: { pi: "dist/bundle/cli.js", senpi: "dist/cli.js" } }), 0o600);
  artifact(join(oldEngine, "dist/index.js"), "export {};\n", 0o600);
  artifact(join(oldEngine, "dist/cli.js"), "#!/usr/bin/env node\nconsole.log('old engine');\n");
  mkdirSync(join(legacy, "bin"), { recursive: true, mode: 0o700 });
  symlinkSync(join(oldWrapper, "bin/omo.js"), join(legacy, "bin/omo"));
  const { source, directory } = owner(home, { path: `${join(legacy, "bin")}:${join(home, "bin")}` });
  // When
  const observed = await source.refresh();
  const catalog = await readCatalog(await createAutomaticCatalogProvider(directory, source)());
  // Then: the scan completes, the old layout is neither a candidate nor a refusal, and the current OmO is listed.
  expect(observed.state).toBe("complete");
  expect(observed.failures).toEqual([]);
  expect(catalog.installations.map(row => row.executableRealpath)).toEqual([join(current.wrapper, "bin/omo.js")]);
});

test("quarantines a broken alias before resolution without hiding an independent installation", async () => {
  // Given
  const home = root(), old = installed(home, "codex"), independent = join(home, "independent");
  const current = installed(independent, "codex");
  const { source, directory } = owner(home, { path: `${join(home, "bin")}:${join(independent, "bin")}` });
  const provider = createAutomaticCatalogProvider(directory, source);
  expect((await readCatalog(await provider())).installations).toHaveLength(2);
  // When: canonical resolution fails before any source can be classified.
  rmSync(old);
  const catalog = await readCatalog(await provider());
  // Then
  expect(catalog.installations.map(row => row.executableRealpath)).toEqual([current]);
});

artifactTest("discovers a default launcher with its exact independent Bun root", async () => {
  const home = root(), prefix = join(home, "independent"), layout = join(prefix, "install/global/node_modules");
  const current = await omoFixture(layout);
  // The reviewed fixture wrapper is moved into the actual Bun global slot.
  renameSync(current.wrapper, join(layout, "omo-ai"));
  const entry = join(layout, "omo-ai/bin/omo.js"), launcher = join(home, "bin/omo");
  artifact(launcher, `#!/bin/sh\nexport BUN_INSTALL="${prefix}"\nexec "${entry}" "$@"\n`);
  const { source, directory } = owner(home);
  const catalog = await readCatalog(await createAutomaticCatalogProvider(directory, source)());
  expect(catalog.installations.map(row => row.executableRealpath)).toEqual([entry]);
  const observed = await source.refresh();
  expect(observed.candidates.some(candidate => candidate.installation.executableRealpath === entry
    && candidate.pins.some(pin => pin.path === launcher))).toBe(true);
});

test("merged aliases retain the second literal launcher hash and mode before adoption", async () => {
  // Given: two independently mutable launchers share one terminal package.
  const home = root(), target = installed(home, "codex"), second = join(home, "bin/codex");
  rmSync(second);
  artifact(join(home, "bin/claude"), `#!/bin/sh\nexec "${target}" "$@"\n`);
  artifact(second, `#!/bin/sh\nexec "${target}" "$@"\n`);
  const { source } = owner(home), observed = await source.refresh(), candidate = observed.candidates[0];
  if (!candidate) throw new TypeError("missing owned candidate");
  expect(observed.candidates).toHaveLength(1);
  expect(await source.verify(candidate)).toBe(true);
  // When: canonical paths remain unchanged while only the second launcher changes.
  writeFileSync(second, "changed second launcher bytes");
  // Then
  expect(await source.verify(candidate)).toBe(false);
});

artifactTest.each([false, true])("reads the complete official Bun shim only when both branches agree: mismatch=%s", async mismatch => {
  // Given: the two official launcher branches refer to the same entry unless changed.
  const home = root(), prefix = join(home, "independent"), layout = join(prefix, "install/global/node_modules");
  const current = await omoFixture(layout);
  renameSync(current.wrapper, join(layout, "omo-ai"));
  const entry = join(layout, "omo-ai/bin/omo.js"), launcher = join(home, "bin/omo"), bun = "/usr/local/bin/bun";
  artifact(launcher, `#!/bin/sh\n# omo-ai bun launcher shim v1 - generated by omo-ai; safe to delete, the next launch recreates it\n# entry: ${entry}\nif [ "$OMO_RUNTIME" != "node" ] && [ -x '${bun}' ]; then exec '${bun}' '${entry}' "$@"; fi\nexec '${mismatch ? `${entry}.other` : entry}' "$@"\n`);
  const { source } = owner(home);
  // When: the shell source is parsed as data, never launched.
  const observed = await source.refresh();
  // Then: a comment or one valid branch cannot authorize a conflicting launcher.
  expect(observed.candidates.some(row => row.family === "omo" && row.pins.some(pin => pin.path === launcher))).toBe(!mismatch);
});

artifactTest.each(["bin/omo", "install/global/node_modules/.bin/omo"])("tracks original OmO symlink repair without repinning its entry: %s", async slot => {
  // Given: the original entry and alias have already been captured.
  const home = root(), prefix = join(home, ".bun"), layout = join(prefix, "install/global/node_modules");
  const current = await omoFixture(layout);
  renameSync(current.wrapper, join(layout, "omo-ai"));
  const entry = join(layout, "omo-ai/bin/omo.js"), launcher = join(prefix, slot), bun = "/usr/local/bin/bun";
  mkdirSync(join(launcher, ".."), { recursive: true, mode: 0o700 });
  symlinkSync(entry, launcher);
  const { source, directory } = owner(home, { path: join(launcher, ".."), prefixes: [prefix] });
  const before = await source.refresh();
  const previous = before.candidates.find(row => row.installation.executableRealpath === entry);
  if (!previous) throw new Error("missing_candidate");
  // When: the original launcher replaces the symlink with its exact generated shim.
  rmSync(launcher);
  artifact(launcher, `#!/bin/sh\n# omo-ai bun launcher shim v1 - generated by omo-ai; safe to delete, the next launch recreates it\n# entry: ${entry}\nif [ "$OMO_RUNTIME" != "node" ] && [ -x '${bun}' ]; then exec '${bun}' '${entry}' "$@"; fi\nexec '${entry}' "$@"\n`, 0o755);
  expect(await source.verify(previous)).toBe(false);
  const after = await source.refresh();
  // Then: a new read-only observation is bound to both immutable entry and new shim.
  expect(after.failures).toEqual([]);
  const next = after.candidates.find(row => row.installation.executableRealpath === entry);
  if (!next) throw new Error("missing_repaired_candidate");
  expect(next.installation).toEqual(previous.installation);
  expect(next.pins.some(row => row.path === launcher)).toBe(true);
  expect(await source.verify(next)).toBe(true);
  const catalog = await readCatalog(await createAutomaticCatalogProvider(directory, source)());
  expect(catalog.installations.map(row => row.executableRealpath)).toContain(entry);
  expect(catalog.observations.every(row => row.contract.capabilities.update.kind !== "supported")).toBe(true);
  // A later rewrite of that pinned regular file still fails closed.
  writeFileSync(launcher, readFileSync(launcher, "utf8") + "\n");
  expect(await source.verify(next)).toBe(false);
  expect((await source.refresh()).failures.some(row => row.sourcePath === launcher)).toBe(true);
});

artifactTest.each(["entry-drift", "foreign-branch", "extra-command", "foreign-slot"])("refuses a claimed OmO shim transition with %s", async corruption => {
  const home = root(), prefix = join(home, ".bun"), layout = join(prefix, "install/global/node_modules");
  const current = await omoFixture(layout);
  renameSync(current.wrapper, join(layout, "omo-ai"));
  const entry = join(layout, "omo-ai/bin/omo.js"), bun = "/usr/local/bin/bun";
  const launcher = corruption === "foreign-slot" ? join(home, "bin/omo") : join(prefix, "bin/omo");
  mkdirSync(join(launcher, ".."), { recursive: true, mode: 0o700 }); symlinkSync(entry, launcher);
  const { source } = owner(home, { path: join(launcher, ".."), prefixes: [prefix] });
  await source.refresh();
  rmSync(launcher);
  artifact(launcher, `#!/bin/sh\n# omo-ai bun launcher shim v1 - generated by omo-ai; safe to delete, the next launch recreates it\n# entry: ${entry}\nif [ "$OMO_RUNTIME" != "node" ] && [ -x '${bun}' ]; then exec '${bun}' '${entry}' "$@"; fi\nexec '${corruption === "foreign-branch" ? `${entry}.other` : entry}' "$@"\n${corruption === "extra-command" ? "exit 0\n" : ""}`, 0o755);
  if (corruption === "entry-drift") writeFileSync(entry, readFileSync(entry, "utf8") + "\n");
  const after = await source.refresh();
  expect(after.failures.some(row => row.sourcePath === launcher && row.code === "verification_failed")).toBe(true);
});

test("dependency-manifest directory aliases remain bound after acquisition", async () => {
  // Given: reviewed resolver follows a task-owned optional-package symlink.
  const home = root(), { selected, platform } = npmNative(home, true), { source } = owner(home);
  const observed = await source.refresh(), candidate = observed.candidates[0];
  if (!candidate) throw new TypeError("missing owned native-wrapper fixture");
  expect(await source.verify(candidate)).toBe(true);
  const alternative = join(home, "alternative-platform");
  artifact(join(alternative, "package.json"), readFileSync(join(platform, "package.json"), "utf8"), 0o600);
  artifact(join(alternative, "vendor/aarch64-apple-darwin/bin/codex"), "different selected native target");
  // When: old physical files remain intact; only Node's manifest lookup is retargeted.
  rmSync(selected);
  symlinkSync(alternative, selected);
  // Then
  expect(await source.verify(candidate)).toBe(false);
});

test("shared unrelated PATH directories do not invalidate verified installations", async () => {
  const home = root(), target = installed(home, "codex");
  const shared = join(home, "shared/bin");
  mkdirSync(shared, { recursive: true });
  chmodSync(shared, 0o775);
  artifact(join(shared, "unrelated"), "unrelated command", 0o755);
  mkdirSync(join(home, "Caskroom/codex/.metadata"), { recursive: true });
  const source = createCatalogSourceOwner(join(home, "worker"), {
    home, path: `${join(home, "bin")}:${shared}`, prefixes: [home],
  });
  owners.push(source);
  const observed = await source.refresh();
  expect(observed.state).toBe("complete");
  expect(observed.failures).toEqual([]);
  expect(observed.candidates.some(row => row.installation.executableRealpath === target)).toBe(true);
  expect(await source.verify(observed.candidates.find(row => row.installation.executableRealpath === target)!)).toBe(true);
});

test("known CLI in a shared PATH directory remains rejected with its source path", async () => {
  const home = root();
  installed(home, "codex");
  chmodSync(join(home, "bin"), 0o775);
  const { source } = owner(home);
  const observed = await source.refresh();
  expect(observed.state).toBe("incomplete");
  expect(observed.candidates).toEqual([]);
  expect(observed.failures.some(row => row.sourcePath === join(home, "bin/codex") && row.code === "verification_failed")).toBe(true);
});

test("incomplete scans durably retain first observations before worker-owner restart", async () => {
  // Given: Codex is observed before a later unrelated unsafe Grok input.
  const home = root(), target = installed(home, "codex"), bad = artifact(join(home, "bin/grok"), "unsafe later input", 0o777);
  chmodSync(bad, 0o777);
  const { source, directory } = owner(home);
  const first = await source.refresh();
  expect(first.state).toBe("incomplete");
  expect(first.failures).not.toEqual([]);
  expect(existsSync(join(catalogRegistryDirectory(directory), "auto-sources.json"))).toBe(true);
  await source.close();
  // When: restart after removing the unrelated error and replacing the earlier target.
  rmSync(bad);
  writeFileSync(target, "changed after incomplete acquisition");
  const restarted = createCatalogSourceOwner(directory, { home, path: join(home, "bin"), prefixes: [] });
  owners.push(restarted);
  const after = await restarted.refresh();
  // Then: a failed scan never becomes permission to relearn earlier bytes.
  expect(after.failures.some(row => row.code === "verification_failed")).toBe(true);
  expect(after.candidates).toEqual([]);
});

test("final alias I/O expiry cannot return verified success", async () => {
  // Given: instrument only time after a real terminal alias resolution.
  const home = root();
  installed(home, "codex");
  let expired = false;
  const { source } = owner(home, {}, () => expired ? 4000 : 0);
  const candidate = (await source.refresh()).candidates[0], path = join(home, "bin/codex");
  if (!candidate) throw new TypeError("missing owned candidate");
  const native = filesystem.realpath;
  let resolutions = 0;
  function observed(p: PathLike, options?: BufferEncoding | ObjectEncodingOptions | null): Promise<string>;
  function observed(p: PathLike, options: BufferEncodingOption): Promise<Buffer<ArrayBuffer>>;
  function observed(p: PathLike, options?: BufferEncoding | ObjectEncodingOptions | BufferEncodingOption | null): Promise<string | Buffer<ArrayBuffer>>;
  async function observed(p: PathLike, options?: BufferEncoding | ObjectEncodingOptions | BufferEncodingOption | null) {
    const encoding = typeof options === "object" && options !== null ? options.encoding : options;
    const result = encoding === "buffer" ? await native(p, { encoding }) : await native(p, encoding);
    if (p === path && ++resolutions === 2) expired = true;
    return result;
  }
  const instrument = spyOn(filesystem, "realpath").mockImplementation(observed);
  try {
    // When/Then: real filesystem behavior is preserved, no sleep or host timing luck.
    expect(await source.verify(candidate)).toBe(false);
    expect(expired).toBe(true);
  } finally { instrument.mockRestore(); }
});

test("terminal publication I/O expiry remains incomplete after durable pin flush", async () => {
  // Given: the actual completed-generation rename advances the injected clock.
  const home = root();
  installed(home, "codex");
  let expired = false;
  const { source, directory } = owner(home, {}, () => expired ? 4000 : 0);
  const path = join(catalogRegistryDirectory(directory), "auto-sources.json"), native = filesystem.rename;
  const instrument = spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
    await native(from, to);
    if (to === path) {
      const state: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof state === "object" && state !== null && "generation" in state && state.generation === 1) expired = true;
    }
  });
  try {
    // When
    const result = await source.refresh();
    // Then
    expect(result.state).toBe("incomplete");
    expect(expired).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(result.families.every(row => row.state === "incomplete")).toBe(true);
  } finally { instrument.mockRestore(); }
});

test("canonical manifest bin aliases classify the terminal file without filename hints", async () => {
  // Given
  const home = root(), target = installed(home, "codex");
  symlinkSync(target, join(home, "packages/codex/alias-cli"));
  artifact(join(home, "packages/codex/package.json"), JSON.stringify({
    name: "@openai/codex", version: "1.2.3", bin: { codex: "alias-cli" },
  }), 0o600);
  const { source } = owner(home);
  // When/Then
  expect((await source.refresh()).candidates[0]?.installation.executableRealpath).toBe(target);
});

artifactTest("Cursor literal bridges expose the terminal resource, not private launcher dependencies", async () => {
  // Given: exact reviewed launcher source in an owned resolver fixture, no native claim.
  const home = root(), version = join(home, "cursor-version"), shim = join(home, "bin/cursor-agent");
  const wrapper = artifact(join(version, "cursor-agent"), readFileSync(artifactPath("task-5/families/cursor/boundedsource/installed-wrapper.sh"), "utf8"));
  artifact(join(version, "package.json"), JSON.stringify({ name: "@anysphere/agent-cli-runtime" }), 0o600);
  artifact(join(version, "node"), "owned interpreter marker");
  artifact(join(version, "index.js"), "owned payload marker");
  artifact(shim, `#!/bin/sh\nexec "${wrapper}" "$@"\n`);
  const { source } = owner(home);
  // When
  const candidate = (await source.refresh()).candidates[0];
  // Then
  expect(candidate?.family).toBe("cursor");
  expect(candidate?.installation.executableRealpath).toBe(wrapper);
  expect(candidate?.installation.resources.some(row => row.realpath === wrapper)).toBe(true);
  expect(candidate?.installation.resources.some(row => row.realpath === shim)).toBe(false);
  expect(candidate?.pins.some(row => row.path === shim)).toBe(true);
});

test("current native Claude reads streamed build metadata and binds the original alias", async () => {
  // Given: the build constant crosses a hash read boundary and differs from the filename.
  const home = root(), executable = nativeClaude(home);
  mkdirSync(join(home, "bin"), { mode: 0o700 });
  symlinkSync(executable, join(home, "bin/renamed-cli"));
  const { source, directory } = owner(home);
  // When
  const observed = await source.refresh();
  const catalog = await readCatalog(await createAutomaticCatalogProvider(directory, source)());
  // Then
  expect(observed.candidates).toHaveLength(1);
  expect(observed.candidates[0]?.installation).toMatchObject({
    family: "claude", installedVersion: { kind: "known", version: "2.1.300" }, channel: "unknown",
    executableRealpath: executable, owner: { kind: "unknown" },
  });
  expect(observed.candidates[0]?.aliases).toContainEqual({ path: join(home, ".local/bin/claude"), target: executable });
  expect(catalog.installations[0]?.installedVersion).toEqual({ kind: "known", version: "2.1.300" });
});

test.each(["missing-metadata", "conflicting-metadata", "script", "wrong-package", "wrong-original-alias"] as const)(
  "native Claude does not classify %s from its installation directory", async change => {
    // Given
    const home = root(), executable = nativeClaude(home, change === "missing-metadata" ? "VERSION:\"2.1.300\""
      : claudeBuild("2.1.300") + (change === "conflicting-metadata" ? claudeBuild("2.1.301") : ""));
    if (change === "script") writeFileSync(executable, `#!/usr/bin/env bun\n${claudeBuild("2.1.300")}`);
    if (change === "wrong-package") artifact(join(home, ".local/share/claude/versions/package.json"), JSON.stringify({
      name: "@xai-official/grok", version: "9.9.9", bin: { grok: "not-a-version" },
    }), 0o600);
    if (change === "wrong-original-alias") {
      rmSync(join(home, ".local/bin/claude"));
      symlinkSync(installed(home, "grok"), join(home, ".local/bin/claude"));
    }
    const { source } = owner(home);
    // When
    const observed = await source.refresh();
    // Then
    expect(observed.candidates.some(row => row.family === "claude")).toBe(false);
    if (change === "conflicting-metadata" || change === "wrong-package")
      expect(observed.failures.some(row => row.code === "identity_mismatch")).toBe(true);
  });

test.each(["bytes", "original-alias"] as const)("native Claude version observation rejects later %s drift", async change => {
  // Given
  const home = root(), executable = nativeClaude(home), { source } = owner(home);
  const candidate = (await source.refresh()).candidates[0];
  if (!candidate) throw new Error("native Claude missing");
  if (change === "bytes") writeFileSync(executable, Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.from(claudeBuild("2.1.301"))]));
  else {
    const other = artifact(join(home, "other-native"), readFileSync(executable));
    rmSync(join(home, ".local/bin/claude"));
    symlinkSync(other, join(home, ".local/bin/claude"));
  }
  // When/Then
  expect(await source.verify(candidate)).toBe(false);
  expect((await source.refresh()).candidates.some(row => row.family === "claude")).toBe(false);
});

artifactTest("current Cursor uses the source version function rather than a release label or directory", async () => {
  // Given: source lies beyond the small JSON body limit, with misleading unrelated metadata.
  const home = root(), version = "2026.10.05-abcdef0";
  const fixture = cursorRuntime(home, " ".repeat(300000) + 'SENTRY_RELEASE={id:"agent-cli@2000.01.01-0000000"};'
    + `"./src/utils/version.ts":(e,t,n)=>{"use strict";function r(){return null!=="${version}"?"${version}":"unknown"}n.d(t,{x:()=>r})}`);
  const { source } = owner(home);
  // When
  const candidate = (await source.refresh()).candidates[0];
  // Then
  expect(candidate?.installation).toMatchObject({ family: "cursor", channel: "unknown", installedVersion: { kind: "known", version } });
  expect(candidate?.installation.resources.some(row => row.realpath === fixture.payload)).toBe(true);
});

artifactTest("Cursor original payload alias cannot qualify a different bin-bound family", async () => {
  // Given: the reviewed launcher and runtime name still point at a Grok package.
  const home = root(), grok = installed(home, "grok"), fixture = cursorRuntime(home,
    '"./src/utils/version.ts":(e,t,n)=>{"use strict";function r(){return null!=="2026.10.05-abcdef0"?"2026.10.05-abcdef0":"unknown"}n.d(t,{x:()=>r})}');
  rmSync(fixture.payload);
  symlinkSync(grok, fixture.payload);
  const { source } = owner(home);
  // When
  const observed = await source.refresh();
  // Then
  expect(observed.candidates.some(row => row.family === "cursor")).toBe(false);
  expect(observed.failures.some(row => row.code === "identity_mismatch")).toBe(true);
});

artifactTest.each(["payload", "payload-alias", "wrong-family"] as const)("Cursor source version is unavailable after %s drift", async change => {
  // Given
  const home = root(), version = "2026.10.05-abcdef0";
  const fixture = cursorRuntime(home,
    `"./src/utils/version.ts":(e,t,n)=>{"use strict";function r(){return null!=="${version}"?"${version}":"unknown"}n.d(t,{x:()=>r})}`);
  const { source } = owner(home);
  const candidate = (await source.refresh()).candidates[0];
  if (!candidate) throw new Error("Cursor missing");
  if (change === "payload") writeFileSync(fixture.payload, readFileSync(fixture.payload, "utf8").replaceAll(version, "2026.10.06-abcdef1"));
  if (change === "payload-alias") {
    const other = artifact(join(home, "other-payload"), readFileSync(fixture.payload));
    rmSync(fixture.payload); symlinkSync(other, fixture.payload);
  }
  if (change === "wrong-family") {
    const grok = installed(home, "grok");
    rmSync(fixture.payload); symlinkSync(grok, fixture.payload);
  }
  // When/Then
  expect(await source.verify(candidate)).toBe(false);
  expect((await source.refresh()).candidates.some(row => row.family === "cursor")).toBe(false);
});

test("native Grok directory versions cannot supply npm wrapper or native version evidence", async () => {
  // Given: a native-looking download name and a separately bin-bound wrapper version.
  const home = root();
  artifact(join(home, ".grok/downloads/grok-9.8.7-macos-aarch64"), "native Grok-looking strings x-grok-client-version9.8.7");
  installed(home, "grok");
  const { source } = owner(home);
  // When
  const observed = await source.refresh();
  // Then
  expect(observed.candidates.filter(row => row.family === "grok")).toHaveLength(1);
  expect(observed.candidates.find(row => row.family === "grok")?.installation.installedVersion).toEqual({
    kind: "unknown", reason: "not_captured",
  });
});

test("unknown agent bytes do not fabricate missing-family certainty from a lookup name", async () => {
  // Given
  const home = root();
  artifact(join(home, "bin/agent"), "unmapped native bytes");
  const { source } = owner(home);
  // When/Then: the ambiguous ref could belong to any absent classified family.
  const result = await source.refresh();
  expect(result.candidates).toEqual([]);
  expect(result.families.every(row => row.count === 0 && row.state === "unclassified")).toBe(true);
});

artifactTest.each(["archive", "bounded-source"] as const)("groups genuine OmO %s source with physical Pi aliases but not an independent prefix", async provenance => {
  // Given: actual immutable archive bytes; no launcher or engine is executed.
  const home = root(), fixture = await omoFixture(home, provenance);
  const independent = join(home, "independent");
  installed(independent, "pi");
  const { source, directory } = owner(home, { path: `${join(independent, "bin")}:${join(home, "bin")}` });
  // When: physical Pi is intentionally collected before the wrapper.
  const observed = await source.refresh(), group = observed.candidates.find(row => row.family === "omo");
  const catalog = await readCatalog(await createAutomaticCatalogProvider(directory, source)());
  // Then
  expect(observed.state).toBe("complete");
  expect(observed.candidates.map(row => row.family).sort()).toEqual(["omo", "pi"]);
  expect(group?.managedEngine).toEqual({ family: "pi", executableRealpath: fixture.executable,
    installationId: `install:${createHash("sha256").update(fixture.executable).digest("hex")}`, installedVersion: "2026.10.1-3" });
  expect(group?.installation.resources.map(row => row.realpath).sort()).toEqual([
    join(fixture.wrapper, "bin/omo.js"), join(fixture.wrapper, "package.json"),
    fixture.executable, join(fixture.engine, "package.json"),
  ].sort());
  expect(group?.aliases.filter(row => ["pi", "senpi", "engine-alias"].some(name => row.path === join(home, "bin", name)))).toHaveLength(3);
  expect(group?.pins.some(row => row.path === join(fixture.wrapper, "bin/lib/bun-runtime.js"))).toBe(true);
  expect(group?.pins.some(row => row.path === join(fixture.wrapper, "bin/lib/launcher.js"))).toBe(true);
  expect(group?.pins.some(row => row.path === join(fixture.engine, "dist/core/brand.js"))).toBe(true);
  expect(catalog.installations.map(row => row.family).sort()).toEqual(["omo", "pi"]);
  expect(catalog.installations.find(row => row.family === "omo")?.installedVersion).toEqual({ kind: "known", version: "5.1.9" });
  expect(catalog.failures).toEqual([]);
  expect(catalog.installations.every(row => row.owner.kind === "unknown" && row.channel === "unknown")).toBe(true);
  expect(catalog.observations.every(row => Object.values(row.contract.capabilities).every(cap => cap.kind !== "supported"))).toBe(true);
});

artifactTest.each(["resolver", "launcher", "new-helper"] as const)(
  "lists a previously unobserved OmO %s without granting execution authority", async change => {
    // Given: local metadata-bound wrapper, with source unknown to the updater.
    const home = root(), fixture = await omoFixture(home);
    const marker = join(home, "must-not-execute");
    const path = change === "resolver" ? fixture.resolver
      : join(fixture.wrapper, "bin/lib", change === "launcher" ? "launcher.js" : "new-helper.js");
    artifact(path, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`);
    const { source, directory } = owner(home);
    // When: display-only discovery snapshots the installed files, without importing.
    const catalog = await readCatalog(await createAutomaticCatalogProvider(directory, source)());
    // Then: the local package is visible, but no vendor or mutation authority follows.
    expect(catalog.installations.map(row => row.family)).toEqual(["omo"]);
    expect(catalog.installations[0]?.owner.kind).toBe("unknown");
    expect(catalog.observations.every(row => Object.values(row.contract.capabilities).every(cap => cap.kind !== "supported"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect((await source.refresh()).candidates[0]?.pins.some(pin => pin.path === path)).toBe(true);
  });

artifactTest.each(["dependency-version", "main", "terminal-family"] as const)(
  "rejects unproven OmO relation after %s drift", async change => {
    // Given
    const home = root(), fixture = await omoFixture(home);
    if (change === "dependency-version" || change === "main" || change === "terminal-family") {
      const p = join(fixture.engine, "package.json"), metadata = JSON.parse(readFileSync(p, "utf8"));
      if (change === "dependency-version") metadata.version = "different";
      if (change === "main") metadata.exports["."].import = "./dist/foreign.js";
      if (change === "terminal-family") metadata.name = "@xai-official/grok";
      writeFileSync(p, JSON.stringify(metadata));
    }
    const { source } = owner(home);
    // When/Then: package/PATH labels do not authorize the missing source relation.
    const observed = await source.refresh();
    expect(observed.candidates.some(row => row.family === "omo")).toBe(false);
    if (change === "terminal-family") expect(observed.candidates.some(row => row.family === "grok")).toBe(true);
  });

artifactTest("OmO terminal disproof rejects a contradictory canonical ancestor bin binding", async () => {
  // Given: genuine Pi manifest remains intact; an ancestor contradicts its bin.
  const home = root();
  await omoFixture(home);
  artifact(join(home, "package.json"), JSON.stringify({
    name: "@xai-official/grok", bin: { grok: "engine/dist/bundle/cli.js" },
  }), 0o600);
  const { source } = owner(home);
  // When/Then
  const result = await source.refresh();
  expect(result.candidates.some(row => row.family === "omo")).toBe(false);
  expect(result.failures.some(row => row.code === "identity_mismatch")).toBe(true);
});

artifactTest.each(["resolver", "launcher", "runtime", "brand", "engine", "mode", "alias", "manifest-alias", "deleted-helper"] as const)(
  "OmO first pins and alias closure reject external %s writer without relearning", async change => {
    // Given: real immutable source closure and durable first observation.
    const home = root(), fixture = await omoFixture(home), { source, directory } = owner(home);
    const group = (await source.refresh()).candidates.find(row => row.family === "omo");
    if (!group) throw new TypeError("missing genuine OmO group");
    expect(await source.verify(group)).toBe(true);
    const state = join(catalogRegistryDirectory(directory), "auto-sources.json"), before = readFileSync(state, "utf8");
    await source.close();
    const target = change === "resolver" || change === "deleted-helper" ? fixture.resolver
      : change === "launcher" ? join(fixture.wrapper, "bin/lib/launcher.js")
      : change === "runtime" ? join(fixture.wrapper, "bin/lib/bun-runtime.js")
      : change === "brand" ? join(fixture.engine, "dist/core/brand.js") : fixture.executable;
    if (change === "alias" || change === "manifest-alias") {
      const link = change === "alias" ? join(home, "bin/senpi") : fixture.selected;
      const other = join(home, "other-engine");
      if (change === "alias") artifact(other, readFileSync(fixture.executable));
      else {
        for (const relative of ["package.json", "dist/index.js", "dist/bundle/cli.js", "dist/core/brand.js"])
          artifact(join(other, relative), readFileSync(join(fixture.engine, relative)), relative === "package.json" ? 0o600 : 0o700);
      }
      rmSync(link);
      symlinkSync(other, link);
    } else if (change === "mode") chmodSync(target, 0o500);
    else if (change === "deleted-helper") rmSync(target);
    else writeFileSync(target, "external replacement");
    const restarted = createCatalogSourceOwner(directory, { home, path: join(home, "bin"), prefixes: [] });
    owners.push(restarted);
    // When/Then: identical alias bytes still fail; no automatic replacement baseline.
    expect(await restarted.verify(group)).toBe(false);
    const catalog = await readCatalog(await createAutomaticCatalogProvider(directory, restarted)());
    expect(catalog.installations).toEqual([]);
    expect(catalog.failures.some(row => row.error.code === "verification_failed")).toBe(true);
    expect(readFileSync(state, "utf8")).toBe(before);
  });
