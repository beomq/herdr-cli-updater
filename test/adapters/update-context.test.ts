import { afterEach, expect, test } from "bun:test";
import { access, chmod, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { Socket } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { createOmoUpdateSpec, executeOmoUpdate, getOmoUpdateIntent, isAuditedOmoTrustedLifecycle, qualifyOmoUpdate } from "../../src/adapters/update-context";
import type { OmoArtifact, OmoLocalOverlayGrant, OmoUpdateQualification } from "../../src/adapters/update-context";
import { capture, fixture, now, value } from "../fixtures/evidence/task-38/fixture";
import { rawOfficialRegistryFailure } from "../fixtures/evidence/task-38/raw-official";
import { fixture as childFixture } from "../fixtures/evidence/task22/r2/fixture";
import { consumeOmoUpdate } from "../../src/install/update";
import type { OmoConsumerReceipt } from "../../src/install/update";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
afterEach(async () => {
  for (const f of fixtures.splice(0)) expect(await f.cleanup()).toMatchObject({ effects: 0, rootsRemaining: 0, processesRemaining: 0 });
});
const rejected = { ok: false, error: { code: "verification_failed" } } as const;
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new TypeError("invalid_json_object");
  return Object.fromEntries(Object.entries(value));
}
const aliasName = "@earendil-works/pi-ai";
const actualName = "@code-yeongyu/senpi-ai";
const aliasDeclaration = "npm:@code-yeongyu/senpi-ai@2026.10.1-3";
type Fixture = Awaited<ReturnType<typeof fixture>>;
const digest = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
async function aliasFixture(options: NonNullable<Parameters<typeof fixture>[1]> = { global: true,
  fields: ["dependencies", "optionalDependencies", "peerDependencies"] }) {
  const f = await fixture("5.1.10", options);
  fixtures.push(f);
  return f;
}
async function materialize(f: Fixture) {
  for (const [path, bytes] of f.targetFiles) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}
async function replaceArchive(artifact: OmoArtifact, change: (files: Record<string, Blob | string>) => void,
  preserveSRI = false): Promise<OmoArtifact> {
  const files: Record<string, Blob | string> = Object.fromEntries(await new Bun.Archive(await readFile(artifact.archive.path)).files());
  change(files);
  const bytes = await new Bun.Archive(files, { compress: "gzip" }).bytes();
  await writeFile(artifact.archive.path, bytes);
  if (preserveSRI) return { ...artifact, archive: { ...artifact.archive, sha256: digest(bytes) } };
  const metadata = record(JSON.parse(await readFile(artifact.metadata.path, "utf8")));
  const body = JSON.stringify({ ...metadata, dist: { ...record(metadata["dist"]),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } });
  await writeFile(artifact.metadata.path, body);
  return { ...artifact, archive: { ...artifact.archive, sha256: digest(bytes) },
    metadata: { ...artifact.metadata, sha256: digest(body) } };
}
async function authorizeTarget(f: Pick<Fixture, "input" | "authorize">, artifacts: readonly OmoArtifact[], postinstall = f.input.qualification.target.postinstall) {
  return f.authorize({ ...f.input.qualification, target: { ...f.input.qualification.target, artifacts, postinstall } });
}
/** Controlled installed-version fixture, not acquired vendor/native evidence. */
async function authorizeInstalledVersion(f: Fixture, version: string) {
  const path = join(f.wrapper, "package.json");
  await writeFile(path, JSON.stringify({ ...record(JSON.parse(await readFile(path, "utf8"))), version }));
  await writeFile(join(f.prefix, "install/global/package.json"), JSON.stringify({ dependencies: { "omo-ai": version } }));
  const resources = await Promise.all(f.input.qualification.installation.resources.map(async row =>
    ({ ...row, fingerprint: `sha256:${digest(await readFile(row.realpath))}` })));
  return f.authorize({ ...f.input.qualification, installation: { ...f.input.qualification.installation,
    installedVersion: { kind: "known", version }, resources, resourcesFingerprint: `sha256:${digest(JSON.stringify(resources))}` } });
}

test("controlled qualifier fixture accepts and verifies 6.0.0 to 6.1.0 without native attestation", async () => {
  // Given: real qualification guards over controlled pinned package bytes.
  const f = await fixture("6.1.0");
  fixtures.push(f);
  const input = await authorizeInstalledVersion(f, "6.0.0");
  const context = value(await qualifyOmoUpdate(input, now));
  const spec = value(createOmoUpdateSpec(context, "update-only", now));
  let launches = 0;
  // When: the official flow reaches the controlled materialization boundary.
  const result = await executeOmoUpdate(spec, { now: () => now, run: async () => {
    launches++;
    await materialize(f);
    return { status: 0, signal: null };
  } });
  // Then: the general pair remains subject to real post-effect verification.
  expect(spec.command.args).toEqual(["add", "-g", "omo-ai@6.1.0"]);
  expect(result).toMatchObject({ ok: true, value: { kind: "files-verified", durableReceipt: false } });
  expect(launches).toBe(1);
  expect(record(JSON.parse(await readFile(join(f.wrapper, "package.json"), "utf8")))["version"]).toBe("6.1.0");
});

test.each(["declared", "wrong-target", "undeclared", "wrong-location"] as const)(
  "accepts only original nested bin links: %s", async scenario => {
    const f = await setup(), artifacts = [...f.input.qualification.target.artifacts];
    const engineIndex = artifacts.findIndex(row => row.name === "@code-yeongyu/senpi");
    const engine = artifacts[engineIndex];
    if (!engine) throw new Error("missing fixture engine");
    const root = join(f.prefix, "install/global/node_modules", engine.installName);
    const nested = `${engine.installName}/node_modules/bin-fixture`;
    const originalManifest = (await new Bun.Archive(await readFile(engine.archive.path)).files()).get("package/package.json");
    if (!originalManifest) throw new Error("missing fixture manifest");
    const original = record(JSON.parse(await originalManifest.text()));
    const template = await replaceArchive(engine, files => {
      files["package/package.json"] = JSON.stringify({ ...original,
        dependencies: { "bin-fixture": "1.0.0" } });
    });
    artifacts[engineIndex] = template;
    const engineFiles = await new Bun.Archive(await readFile(template.archive.path)).files();
    const manifest = engineFiles.get("package/package.json");
    if (!manifest) throw new Error("missing manifest");
    f.targetFiles.set(join(root, "package.json"), await manifest.text());
    const bytes = await new Bun.Archive({ "package/package.json": JSON.stringify({
      name: "bin-fixture", version: "1.0.0", bin: { fixture: "cli.js" } }),
      "package/cli.js": "fixture-cli" }, { compress: "gzip" }).bytes();
    const archivePath = join(f.home, "bin-fixture.tgz"), metadataPath = join(f.home, "bin-fixture.json");
    await writeFile(archivePath, bytes);
    const metadata = JSON.stringify({ name: "bin-fixture", version: "1.0.0", dist: {
      tarball: "https://registry.npmjs.org/bin-fixture/-/bin-fixture-1.0.0.tgz",
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } });
    await writeFile(metadataPath, metadata);
    artifacts.push({ name: "bin-fixture", installName: nested, version: "1.0.0",
      archive: { path: archivePath, sha256: digest(bytes) }, metadata: { path: metadataPath, sha256: digest(metadata) } });
    for (const [name, blob] of await new Bun.Archive(bytes).files())
      f.targetFiles.set(join(f.prefix, "install/global/node_modules", nested, name.slice(8)), await blob.text());
    const input = await authorizeTarget(f, artifacts);
    const spec = value(createOmoUpdateSpec(value(await qualifyOmoUpdate(input, now)), "update-only", now));
    const result = await executeOmoUpdate(spec, { now: () => now, run: async () => {
      await materialize(f);
      const path = join(root, scenario === "wrong-location" ? "other" : "node_modules/.bin",
        scenario === "undeclared" ? "unknown" : "fixture");
      await mkdir(dirname(path), { recursive: true });
      await symlink(scenario === "wrong-target" ? "../bin-fixture/package.json" : "../bin-fixture/cli.js", path);
      return { status: 0, signal: null };
    } });
    expect(result).toMatchObject(scenario === "declared"
      ? { ok: true, value: { kind: "files-verified" } } : { ok: false, error: { code: "recovery_required" } });
  });

test("verified installer outputs lose shared write permissions without losing executable bits", async () => {
  // Given authenticated target outputs and an unrelated writable file.
  const f = await setup();
  const entry = join(f.wrapper, "bin/omo.js"), manifestPath = join(f.wrapper, "package.json");
  const unrelated = join(f.home, "unrelated.txt");
  await writeFile(unrelated, "not an installation output");
  await chmod(unrelated, 0o666);
  // When the original-manager boundary materializes writable outputs.
  const result = await executeOmoUpdate(f.spec, { now: () => now, run: async () => {
    await materialize(f);
    await chmod(entry, 0o777);
    await chmod(manifestPath, 0o666);
    return { status: 0, signal: null };
  } });
  // Then only verified output permissions are restricted.
  expect(result).toMatchObject({ ok: true, value: { kind: "files-verified" } });
  expect((await stat(entry)).mode & 0o777).toBe(0o755);
  expect((await stat(manifestPath)).mode & 0o777).toBe(0o644);
  expect((await stat(unrelated)).mode & 0o777).toBe(0o666);
});

test.each(["scripts/postinstall", "scripts/postinstall/index.js"])(
  "rejects a path shadowing the reviewed protobuf entry: %s", path => {
    const manifest = { scripts: { postinstall: "node scripts/postinstall" } };
    const members = new Map([["scripts/postinstall.js", "5af8463b97ee8e309b4a2111f9479bacdf0c180de0ca0155527679b1fc6d9e6c"]]);
    expect(isAuditedOmoTrustedLifecycle("protobufjs", manifest, members)).toBe(true);
    members.set(path, digest("unreviewed entry"));
    expect(isAuditedOmoTrustedLifecycle("protobufjs", manifest, members)).toBe(false);
  });

test.each(["reviewed", "changed-command", "bundled-prepare", "prepare-directory", "prepare-extension", "changed-protobuf-source"] as const)(
  "verifies extra trusted lifecycle sources before issuing update authority: %s", async scenario => {
    // Given: an integrity-bound registry package is explicitly trusted by the user.
    const f = await setup(), protobuf = scenario === "changed-protobuf-source";
    const name = protobuf ? "protobufjs" : "@google/genai", version = protobuf ? "7.6.6" : "2.23.0";
    const globalPath = join(f.prefix, "install/global/package.json");
    const declaration = record(JSON.parse(await readFile(globalPath, "utf8")));
    const before = { ...declaration, dependencies: { ...record(declaration["dependencies"]), [name]: version },
      trustedDependencies: ["omo-ai", name] };
    await writeFile(globalPath, JSON.stringify(before));
    const packageBody = JSON.stringify({ name, version, scripts: protobuf ? { postinstall: "node scripts/postinstall" } : {
      preinstall: scenario === "changed-command" ? "node arbitrary.js" : "echo 'preinstall: no-op'",
      prepare: "node scripts/prepare.js",
    } });
    const files = { "package/package.json": packageBody, "package/index.js": "export {};",
      ...(protobuf ? { "package/scripts/postinstall.js": "throw new Error('changed source');" } : {}),
      ...(scenario === "prepare-directory" ? { "package/scripts/prepare.js/index.js": "throw new Error('unreviewed directory');" } : {}),
      ...(scenario === "prepare-extension" ? { "package/scripts/prepare.js.js": "throw new Error('unreviewed extension');" } : {}),
      ...(scenario === "bundled-prepare" ? { "package/scripts/prepare.js": "throw new Error('unreviewed');" } : {}) };
    const bytes = await new Bun.Archive(files, { compress: "gzip" }).bytes();
    const archivePath = join(f.home, "trusted.tgz"), metadataPath = join(f.home, "trusted.json");
    await writeFile(archivePath, bytes);
    const metadata = JSON.stringify({ name, version, dist: {
      tarball: `https://registry.npmjs.org/${name}/-/${protobuf ? "protobufjs" : "genai"}-${version}.tgz`,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    } });
    await writeFile(metadataPath, metadata);
    const artifact: OmoArtifact = { name, version, installName: name,
      archive: { path: archivePath, sha256: digest(bytes) },
      metadata: { path: metadataPath, sha256: digest(metadata) } };
    for (const [path, body] of Object.entries(files))
      f.targetFiles.set(join(f.prefix, "install/global/node_modules", name, path.slice(8)), body);
    f.targetFiles.set(globalPath, JSON.stringify({ ...before, dependencies: {
      ...before.dependencies, "omo-ai": f.input.qualification.target.version,
    } }));
    const resources = await Promise.all(f.input.qualification.installation.resources.map(async row =>
      ({ ...row, fingerprint: `sha256:${digest(await readFile(row.realpath))}` })));
    const input = await f.authorize({ ...f.input.qualification,
      installation: { ...f.input.qualification.installation, resources,
        resourcesFingerprint: `sha256:${digest(JSON.stringify(resources))}` },
      target: { ...f.input.qualification.target, artifacts: [...f.input.qualification.target.artifacts, artifact] } });
    // When: the real issuer inspects the exact scripts and original archive.
    const qualified = await qualifyOmoUpdate(input, now);
    // Then: a changed command or newly shipped prepare script grants no authority.
    if (scenario !== "reviewed") { expect(qualified).toEqual(rejected); return; }
    const spec = value(createOmoUpdateSpec(value(qualified), "update-only", now));
    expect(await executeOmoUpdate(spec, { now: () => now, run: async () => {
      await materialize(f); return { status: 0, signal: null };
    } })).toMatchObject({ ok: true, value: { kind: "files-verified" } });
    expect(record(JSON.parse(await readFile(globalPath, "utf8")))["trustedDependencies"]).toEqual(["omo-ai", name]);
  });

test.each(["unchanged", "qualified-transform", "changed", "missing", "extra", "late-change"] as const)(
  "reuses only complete authenticated existing package payloads: %s", async scenario => {
    // Given: an unchanged engine is already installed from its qualified archive.
    const f = await setup(), root = join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi");
    for (const [path, body] of f.targetFiles) if (path.startsWith(`${root}/`)
      && !f.input.qualification.target.postinstall.some(pin => pin.path === path)) {
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, body);
    }
    const payload = join(root, "dist/payload.js");
    if (scenario === "changed") await writeFile(payload, "unverified");
    if (scenario === "missing") await rm(payload);
    if (scenario === "extra") await writeFile(join(root, "extra.js"), "unverified");
    if (scenario === "qualified-transform") {
      await writeFile(payload, "qualified-generated-engine");
      f.targetFiles.set(payload, "qualified-generated-engine");
    }
    const input = await f.authorize({ ...f.input.qualification, reuseVerifiedPackages: true,
      target: { ...f.input.qualification.target, postinstall: [...f.input.qualification.target.postinstall,
        ...(scenario === "qualified-transform" ? [{ path: payload, sha256: digest("qualified-generated-engine") }] : [])] } });
    // When: the reuse policy is qualified and rechecked immediately before dispatch.
    const qualified = await qualifyOmoUpdate(input, now);
    if (!["unchanged", "qualified-transform", "late-change"].includes(scenario)) {
      expect(qualified).toEqual(rejected);
      return;
    }
    let launches = 0;
    const result = await executeOmoUpdate(value(createOmoUpdateSpec(value(qualified), "update-only", now)), {
      now: () => now,
      event: async event => { if (scenario === "late-change" && event.kind === "dispatch") await writeFile(payload, "unverified"); },
      run: async command => {
        launches++;
        expect(command.args).not.toContain("--force");
        await materialize(f);
        return { status: 0, signal: null };
      },
    });
    // Then: unchanged files are reusable; any late drift prevents the manager running.
    expect(launches).toBe(scenario === "late-change" ? 0 : 1);
    expect(result.ok).toBe(scenario !== "late-change");
  });

test.each(["unchanged", "before-dispatch", "after-dispatch"] as const)(
  "preserves opaque unrelated package links and rejects %s replacement", async stage => {
    // Given: an unrelated link with no readable external target is bound as data.
    const f = await setup(), path = join(f.prefix, "install/global/node_modules/external-tools");
    const target = join(f.root, "unread-external-tools");
    await symlink(target, path);
    const input = await f.authorize({ ...f.input.qualification, preservedLinks: [{ path, target }] });
    const context = value(await qualifyOmoUpdate(input, now));
    const spec = value(createOmoUpdateSpec(context, "update-only", now));
    const replace = async () => { await rm(path); await symlink(`${target}-changed`, path); };
    if (stage === "before-dispatch") await replace();
    let launches = 0;
    // When: the actual issuer/consumer runs with either stable or changed link data.
    const result = await executeOmoUpdate(spec, { now: () => now, run: async () => {
      launches++;
      await materialize(f);
      if (stage === "after-dispatch") await replace();
      return { status: 0, signal: null };
    } });
    // Then: no external contents are needed, and either replacement refuses success.
    if (stage === "unchanged") {
      expect(result).toMatchObject({ ok: true, value: { kind: "files-verified" } });
      expect(await readlink(path)).toBe(target);
    } else expect(result).toEqual({ ok: false, error: {
      code: stage === "after-dispatch" ? "recovery_required" : "verification_failed",
    } });
    expect(launches).toBe(stage === "before-dispatch" ? 0 : 1);
  });

test.each(["unchanged", "changed-before", "changed-after", "extra-after", "target-edge", "outside"] as const)(
  "preserves unreferenced package data without making it an active dependency: %s", async scenario => {
    // Given: a historical directory is no longer part of the declared dependency graph.
    const f = await setup(), root = join(f.prefix, "install/global/node_modules/old-dom");
    await mkdir(root);
    const manifest = JSON.stringify({ name: "old-dom", version: "1.0.0", dependencies: { absent: "99.0.0" } });
    const entry = join(root, "retained.js");
    await writeFile(join(root, "package.json"), manifest);
    await writeFile(entry, "retained bytes");
    await chmod(entry, 0o777);
    const artifacts = [...f.input.qualification.target.artifacts];
    if (scenario === "target-edge") {
      const index = artifacts.findIndex(row => row.name === "@code-yeongyu/senpi"), engine = artifacts[index];
      if (!engine) throw new TypeError("retained_engine_missing");
      artifacts[index] = await replaceArchive(engine, files => {
        files["package/package.json"] = JSON.stringify({ name: engine.name, version: engine.version,
          dependencies: { "old-dom": "1.0.0" } });
      });
    }
    const input = await f.authorize({ ...f.input.qualification, target: { ...f.input.qualification.target, artifacts },
      preservedPackages: [{ root: scenario === "outside" ? f.home : root, files: [
        { path: join(root, "package.json"), sha256: digest(manifest) }, { path: entry, sha256: digest("retained bytes") },
      ] }] });
    if (scenario === "changed-before") await writeFile(entry, "changed");
    // When: the same issuer and output verification handle preserved files separately.
    const qualified = await qualifyOmoUpdate(input, now);
    if (["changed-before", "target-edge", "outside"].includes(scenario)) {
      expect(qualified).toEqual(rejected);
      return;
    }
    const result = await executeOmoUpdate(value(createOmoUpdateSpec(value(qualified), "update-only", now)), {
      now: () => now, run: async () => {
        await materialize(f);
        if (scenario === "changed-after") await writeFile(entry, "changed");
        if (scenario === "extra-after") await writeFile(join(root, "extra.js"), "changed");
        return { status: 0, signal: null };
      },
    });
    // Then: unrelated data and modes stay exact; no graph or post-effect drift is hidden.
    expect(result.ok).toBe(scenario === "unchanged");
    if (scenario === "unchanged") {
      expect(await readFile(entry, "utf8")).toBe("retained bytes");
      expect((await stat(entry)).mode & 0o777).toBe(0o777);
    } else expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
  });

test.each(["removed", "unrecorded", "late-change", "not-removed", "unchanged-parent"] as const)(
  "admits only recorded old dependencies below a replaced parent: %s", async scenario => {
    // Given: an old nested engine shadows the qualified global engine.
    const f = await setup();
    const parent = scenario === "unchanged-parent" ? join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi") : f.wrapper;
    const root = join(parent, "node_modules/@code-yeongyu/senpi"), path = join(root, "package.json");
    await mkdir(root, { recursive: true });
    const body = JSON.stringify({ name: "@code-yeongyu/senpi", version: "2025.1.1" });
    await writeFile(path, body);
    const input = await f.authorize({ ...f.input.qualification,
      ...(scenario === "unrecorded" ? {} : { retiredPackages: [{ root, files: [{ path, sha256: digest(body) }] }] }) });
    // When: transition qualification still refuses ordinary unbound shadows.
    const qualified = await qualifyOmoUpdate(input, now);
    if (scenario === "unrecorded" || scenario === "unchanged-parent") {
      expect(qualified).toEqual(rejected);
      return;
    }
    let launches = 0;
    const result = await executeOmoUpdate(value(createOmoUpdateSpec(value(qualified), "update-only", now)), {
      now: () => now,
      event: async event => { if (scenario === "late-change" && event.kind === "dispatch") await writeFile(path, "{}"); },
      run: async () => {
        launches++;
        if (scenario !== "not-removed") await rm(root, { recursive: true });
        await materialize(f);
        return { status: 0, signal: null };
      },
    });
    // Then: a recorded snapshot is checked before dispatch and removal after it.
    expect(launches).toBe(scenario === "late-change" ? 0 : 1);
    expect(result.ok).toBe(scenario === "removed");
    if (scenario === "not-removed") expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
  });

test.each(["latest", "^6.0.0", "06.0.0", "6.0.0-beta", "6.0.0;echo", ""] as const)(
  "controlled qualifier fixture rejects unsupported installed version %#", async version => {
    // Given: installed bytes and their pins agree on an unsupported version.
    const f = await setup();
    const input = await authorizeInstalledVersion(f, version);
    // When / Then: generalized identity does not admit floating, beta or unsafe versions.
    expect(await qualifyOmoUpdate(input, now)).toEqual(rejected);
  },
);

test.each(["installed-version", "target-version", "metadata-version", "source-digest"] as const)(
  "controlled general qualifier fixture rejects mismatched %s", async defect => {
    // Given: a valid general pair with one contradictory, explicitly repinned input.
    const f = await fixture("6.1.0");
    fixtures.push(f);
    const input = await authorizeInstalledVersion(f, "6.0.0");
    let q = input.qualification;
    switch (defect) {
      case "installed-version": q = { ...q, installation: { ...q.installation, installedVersion: { kind: "known", version: "6.0.1" } } }; break;
      case "target-version": q = { ...q, target: { ...q.target, version: "6.1.1" } }; break;
      case "metadata-version": {
        const artifact = q.target.artifacts.find(row => row.name === "omo-ai");
        if (!artifact) throw new TypeError("general_wrapper_missing");
        const body = JSON.stringify({ ...record(JSON.parse(await readFile(artifact.metadata.path, "utf8"))), version: "6.1.1" });
        await writeFile(artifact.metadata.path, body);
        q = { ...q, target: { ...q.target, artifacts: q.target.artifacts.map(row => row === artifact
          ? { ...row, metadata: { ...row.metadata, sha256: digest(body) } } : row) } };
        break;
      }
      case "source-digest": {
        const source = join(f.wrapper, "bin/lib/self-update.js");
        await writeFile(source, "export const unqualified = true;");
        const resources = q.installation.resources.map(row => row.realpath === source
          ? { ...row, fingerprint: `sha256:${digest("export const unqualified = true;")}` } : row);
        q = { ...q, installation: { ...q.installation, resources, resourcesFingerprint: `sha256:${digest(JSON.stringify(resources))}` } };
        break;
      }
    }
    // When / Then: version generalization preserves metadata, identity and official-source guards.
    expect(await qualifyOmoUpdate(await f.authorize(q), now)).toEqual(rejected);
    expect(existsSync(f.marker)).toBe(false);
  },
);

function bounded<T>(promise: Promise<T>): Promise<T> {
  const completion = Promise.withResolvers<T>();
  const timer = setTimeout(() => completion.reject(new TypeError("alias_event_timeout")), 5000);
  promise.then(value => { clearTimeout(timer); completion.resolve(value); },
    error => { clearTimeout(timer); completion.reject(error); });
  return completion.promise;
}
/** Controlled regression packages, never represented as acquired vendor evidence. */
async function nestedFixture() {
  const f = await aliasFixture({ fields: ["dependencies"] });
  const target = await nestedTarget(f);
  // Existing canonical non-core slots model the original Bun installed layout;
  // the wrapper/engine's old bytes remain bound by the installation snapshot.
  for (const artifact of target.artifacts.filter(a => a.installName !== "omo-ai" && a.installName !== "@code-yeongyu/senpi")) {
    const entries = await new Bun.Archive(await readFile(artifact.archive.path)).files();
    for (const [path, blob] of entries) {
      const installed = join(f.prefix, "install/global/node_modules", artifact.installName, path.slice(8));
      await mkdir(dirname(installed), { recursive: true });
      await writeFile(installed, new Uint8Array(await blob.arrayBuffer()));
    }
  }
  return { f, ...target };
}
test("dependency manifest v prefix remains bound to canonical registry version and exact archive output", async () => {
  const f = await aliasFixture({ fields: ["dependencies"] });
  const alias = f.input.qualification.target.artifacts.find(a => a.name === actualName);
  if (!alias) throw new TypeError("alias_fixture_missing");
  const originalEntries = await new Bun.Archive(await readFile(alias.archive.path)).files();
  const originalManifest = originalEntries.get("package/package.json");
  if (!originalManifest) throw new TypeError("alias_manifest_missing");
  const pkg = JSON.parse(await originalManifest.text());
  const changed = await replaceArchive(alias, files => {
    files["package/package.json"] = JSON.stringify({ ...pkg, version: `v${alias.version}` });
  });
  const input = await authorizeTarget(f, f.input.qualification.target.artifacts.map(a => a === alias ? changed : a));
  const qualified = value(await qualifyOmoUpdate(input, now));
  const spec = value(createOmoUpdateSpec(qualified, "update-only", now));
  const manifestPath = join(f.prefix, "install/global/node_modules", alias.installName, "package.json");
  const entries = await new Bun.Archive(await readFile(changed.archive.path)).files();
  const targetManifest = entries.get("package/package.json");
  if (!targetManifest) throw new TypeError("alias_manifest_missing");
  f.targetFiles.set(manifestPath, await targetManifest.text());
  expect(await executeOmoUpdate(spec, { now: () => now, run: async () => {
    await materialize(f); return { status: 0, signal: null };
  } })).toMatchObject({ ok: true });
});
async function nestedTarget(f: Pick<Fixture, "root" | "prefix" | "input" | "targetFiles" | "authorize">) {
  const q = f.input.qualification;
  const engine = q.target.artifacts.find(a => a.name === "@code-yeongyu/senpi");
  const alias = q.target.artifacts.find(a => a.name === actualName);
  if (!engine || !alias) throw new TypeError("nested_fixture_missing");
  const changed = await replaceArchive(engine, files => {
    files["package/package.json"] = JSON.stringify({ name: engine.name, version: engine.version,
      dependencies: { [aliasName]: aliasDeclaration, entities: "^7.0.0", htmlparser2: "1.0.0",
        "dom-serializer": "1.0.0", "p-retry": "1.0.0", retry: "~0.12.0" } });
  });
  const artifacts: OmoArtifact[] = [q.target.artifacts[0] ?? engine, changed,
    { ...alias, installName: `@code-yeongyu/senpi/node_modules/${aliasName}` }];
  const packages = [
    ["entities", "7.0.1", "entities", {}],
    ["htmlparser2", "1.0.0", "htmlparser2", { entities: "^4.0.0" }],
    ["entities", "4.5.0", "htmlparser2/node_modules/entities", {}],
    ["dom-serializer", "1.0.0", "dom-serializer", { entities: "^8.0.0" }],
    ["entities", "8.1.0", "dom-serializer/node_modules/entities", {}],
    ["p-retry", "1.0.0", "p-retry", { retry: "^0.13.0", entities: "^4.0.0" }],
    ["retry", "0.12.0", "retry", {}],
    ["retry", "0.13.1", "p-retry/node_modules/retry", {}],
  ] as const;
  for (const [name, version, installName, dependencies] of packages) {
    const data = { "package/package.json": JSON.stringify({ name, version, dependencies }),
      "package/index.js": `export const version=${JSON.stringify(version)};\n` };
    const bytes = await new Bun.Archive(data, { compress: "gzip" }).bytes();
    const archivePath = join(f.root, `nested-${artifacts.length}.tgz`);
    const metadataPath = join(f.root, `nested-${artifacts.length}.metadata.json`);
    const metadata = JSON.stringify({ name, version, dependencies, dist: {
      tarball: `https://registry.npmjs.org/${name}/-/fixture-${version}.tgz`,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } });
    await writeFile(archivePath, bytes);
    await writeFile(metadataPath, metadata);
    artifacts.push({ name, version, installName, archive: { path: archivePath, sha256: digest(bytes) },
      metadata: { path: metadataPath, sha256: digest(metadata) } });
  }
  const entities4 = artifacts.find(a => a.installName === "htmlparser2/node_modules/entities");
  if (!entities4) throw new TypeError("nested_entities_missing");
  artifacts.push({ ...entities4, installName: "p-retry/node_modules/entities" });
  f.targetFiles.clear();
  for (const artifact of artifacts) {
    const entries = await new Bun.Archive(await readFile(artifact.archive.path)).files();
    for (const [path, blob] of entries)
      f.targetFiles.set(join(f.prefix, "install/global/node_modules", artifact.installName, path.slice(8)),
        new Uint8Array(await blob.arrayBuffer()));
  }
  const stamp = q.target.postinstall[0];
  if (!stamp) throw new TypeError("nested_stamp_missing");
  f.targetFiles.set(stamp.path, "qualified-postinstall-output");
  const input = await authorizeTarget(f, artifacts);
  return { artifacts, input };
}
test.each(["optional-absent", "peer-optional-absent", "required-absent", "peer-required-absent",
  "peer-false-absent", "optional-present-wrong-version", "peer-optional-present-wrong-version",
  "optional-unsafe-declaration", "optional-existing-shadow", "optional-late-shadow", "optional-output-shadow",
  "peer-optional-output-meta"] as const)("optional-contract qualifies %s without bypassing required edges", async scenario => {
  const f = await setup();
  const engine = f.input.qualification.target.artifacts.find(a => a.name === "@code-yeongyu/senpi");
  if (!engine) throw new TypeError("engine_fixture_missing");
  const optionalPeer = scenario.startsWith("peer-");
  const field = optionalPeer ? "peerDependencies" : scenario === "required-absent" ? "dependencies" : "optionalDependencies";
  const present = scenario.includes("present");
  const key = present ? "omo-ai" : "missing-package";
  const declaration = scenario === "optional-unsafe-declaration" ? "https://example.invalid/package.tgz"
    : present ? "99.0.0" : "^1.0.0";
  let body = "";
  const changed = await replaceArchive(engine, files => {
    body = JSON.stringify({ name: engine.name, version: engine.version,
      [field]: { [key]: declaration },
      ...(optionalPeer ? { peerDependenciesMeta: { [key]: { optional: scenario !== "peer-required-absent"
        && scenario !== "peer-false-absent" } } } : {}) });
    files["package/package.json"] = body;
  });
  const outputBody = scenario === "peer-optional-output-meta"
    ? JSON.stringify({ ...record(JSON.parse(body)), peerDependenciesMeta: { [key]: { optional: false } } }) : body;
  const manifestPath = join(f.prefix, "install/global/node_modules", engine.installName, "package.json");
  const postinstall = scenario === "peer-optional-output-meta"
    ? [...f.input.qualification.target.postinstall, { path: manifestPath, sha256: digest(outputBody) }]
    : f.input.qualification.target.postinstall;
  const input = await authorizeTarget(f, f.input.qualification.target.artifacts.map(a => a === engine ? changed : a), postinstall);
  const shadow = join(f.prefix, "install/global/node_modules", engine.installName, "node_modules", key);
  if (scenario === "optional-existing-shadow") await mkdir(shadow, { recursive: true });
  const qualified = await qualifyOmoUpdate(input, now);
  if (scenario === "optional-absent" || scenario === "peer-optional-absent"
    || scenario === "optional-late-shadow" || scenario === "optional-output-shadow" || scenario === "peer-optional-output-meta") {
    expect(qualified.ok).toBe(true);
    f.targetFiles.set(manifestPath, outputBody);
    const spec = value(createOmoUpdateSpec(value(qualified), "update-only", now));
    let launches = 0;
    const result = await executeOmoUpdate(spec, { now: () => now,
      event: async event => {
        if (scenario === "optional-late-shadow" && event.kind === "dispatch") await mkdir(shadow, { recursive: true });
      },
      run: async () => {
        launches++;
        await materialize(f);
        if (scenario === "optional-output-shadow") await mkdir(shadow, { recursive: true });
        return { status: 0, signal: null };
      } });
    expect(result.ok).toBe(scenario === "optional-absent" || scenario === "peer-optional-absent");
    expect(launches).toBe(scenario === "optional-late-shadow" ? 0 : 1);
  } else expect(qualified).toEqual(rejected);
});

test.each(["unchanged", "reachable", "unleased", "changed-before", "changed-output", "required-peer", "new-target"] as const)(
  "preserves only existing peer conflicts outside OmO: %s", async scenario => {
    // Given: an unrelated existing root already has an incompatible peer.
    const f = await setup(), artifacts: OmoArtifact[] = [...f.input.qualification.target.artifacts];
    const peerPins = [];
    for (const name of ["unrelated-cli", "peer-target"]) {
      const pkg = { name, version: "1.0.0", ...(name === "unrelated-cli" ? {
        peerDependencies: { "peer-target": "^2.0.0" },
        peerDependenciesMeta: { "peer-target": { optional: scenario !== "required-peer" } },
      } : {}) };
      const body = JSON.stringify(pkg), path = join(f.prefix, "install/global/node_modules", name, "package.json");
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, body);
      peerPins.push({ path, sha256: digest(body) });
      f.targetFiles.set(path, body);
      const bytes = await new Bun.Archive({ "package/package.json": scenario === "new-target" && name === "peer-target"
        ? JSON.stringify({ ...pkg, version: "1.1.0" }) : body }, { compress: "gzip" }).bytes();
      const archive = join(f.root, `${name}.tgz`), metadata = join(f.root, `${name}.json`);
      const version = scenario === "new-target" && name === "peer-target" ? "1.1.0" : "1.0.0";
      const info = JSON.stringify({ name, version, dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } });
      await writeFile(archive, bytes); await writeFile(metadata, info);
      artifacts.push({ name, installName: name, version, archive: { path: archive, sha256: digest(bytes) },
        metadata: { path: metadata, sha256: digest(info) } });
    }
    const parent = peerPins[0], dependency = peerPins[1];
    if (!parent || !dependency) throw new TypeError("peer_fixture_missing");
    if (scenario === "reachable") {
      const index = artifacts.findIndex(a => a.name === "@code-yeongyu/senpi"), engine = artifacts[index];
      if (!engine) throw new TypeError("peer_engine_missing");
      artifacts[index] = await replaceArchive(engine, files => {
        files["package/package.json"] = JSON.stringify({ name: engine.name, version: engine.version,
          dependencies: { "unrelated-cli": "^1.0.0" } });
      });
    }
    const resources = [...f.input.qualification.installation.resources, ...peerPins
      .filter(pin => scenario !== "unleased" || pin !== parent)
      .map(pin => ({ realpath: pin.path, resourceId: `resource:${digest(pin.path)}`, fingerprint: `sha256:${pin.sha256}` }))];
    const input = await f.authorize({ ...f.input.qualification,
      installation: { ...f.input.qualification.installation, resources, resourcesFingerprint: `sha256:${digest(JSON.stringify(resources))}` },
      target: { ...f.input.qualification.target, artifacts },
      preservedPeers: [{ parent, dependency, key: "peer-target" }] });
    if (scenario === "changed-before") await writeFile(parent.path, "{}");
    // When: the real qualifier checks unchanged vendor bytes, resource lease and graph.
    const qualified = await qualifyOmoUpdate(input, now);
    // Then: only the existing, unchanged, unrelated conflict is carried.
    if (scenario !== "unchanged" && scenario !== "required-peer" && scenario !== "changed-output") {
      expect(qualified).toEqual(rejected);
      return;
    }
    const result = await executeOmoUpdate(value(createOmoUpdateSpec(value(qualified), "update-only", now)), {
      now: () => now, run: async () => {
        await materialize(f);
        if (scenario === "changed-output") await writeFile(parent.path, "{}");
        return { status: 0, signal: null };
      },
    });
    expect(result).toMatchObject(scenario !== "changed-output" ? { ok: true, value: { kind: "files-verified" } }
      : { ok: false, error: { code: "recovery_required" } });
  });
test.each(["overrides", "resolutions", "workspaces"] as const)("dependency manifest preserves %s without applying root policy", async field => {
  const f = await setup();
  const engine = f.input.qualification.target.artifacts.find(a => a.name === "@code-yeongyu/senpi");
  if (!engine) throw new TypeError("engine_fixture_missing");
  const body = JSON.stringify({ name: engine.name, version: engine.version,
    [field]: field === "workspaces" ? ["addons/*"] : { "development-only": "^1.0.0" } });
  const changed = await replaceArchive(engine, files => { files["package/package.json"] = body; });
  const input = await authorizeTarget(f, f.input.qualification.target.artifacts.map(a => a === engine ? changed : a));
  const qualified = value(await qualifyOmoUpdate(input, now));
  f.targetFiles.set(join(f.prefix, "install/global/node_modules", engine.installName, "package.json"), body);
  const result = await executeOmoUpdate(value(createOmoUpdateSpec(qualified, "update-only", now)), {
    now: () => now, run: async () => { await materialize(f); return { status: 0, signal: null }; } });
  expect(result.ok).toBe(true);
});
test.each(["root-directory", "dot-path", "identical-dot-duplicate", "conflicting-dot-duplicate",
  "redundant-pax", "pax-traversal", "pax-size", "pax-link"] as const)("archive-contract validates %s without changing installer bytes", async scenario => {
  const f = await setup();
  const engine = f.input.qualification.target.artifacts.find(a => a.name === "@code-yeongyu/senpi");
  if (!engine) throw new TypeError("engine_fixture_missing");
  const original = gunzipSync(await readFile(engine.archive.path));
  const size = Number.parseInt(original.subarray(124, 136).toString().replace(/\0.*$/, "").trim(), 8);
  const firstLength = 512 + Math.ceil(size / 512) * 512;
  const originalName = original.subarray(0, 100).toString().replace(/\0.*$/, "");
  function header(name: string, kind: number, bytes: number): Buffer {
    const block = Buffer.from(original.subarray(0, 512));
    block.fill(0, 0, 100); block.write(name, 0);
    block.fill(0, 124, 136); block.write(bytes.toString(8).padStart(11, "0"), 124);
    block[156] = kind; block.fill(32, 148, 156);
    const sum = block.reduce((total, value) => total + value, 0);
    block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return block;
  }
  let tar: Buffer;
  if (scenario === "root-directory") tar = Buffer.concat([header("package", 53, 0), original]);
  else if (scenario.startsWith("pax-") || scenario === "redundant-pax") {
    const values = scenario === "pax-link" ? ["linkpath=/outside"]
      : [`path=${scenario === "pax-traversal" ? "package/../outside" : originalName}`,
        `size=${scenario === "pax-size" ? size + 1 : size}`, "NODETAR.type=File", "SCHILY.nlink=1"];
    const records = values.map(value => {
      let length = Buffer.byteLength(value) + 3;
      while (length !== Buffer.byteLength(`${length} ${value}\n`)) length = Buffer.byteLength(`${length} ${value}\n`);
      return `${length} ${value}\n`;
    }).join("");
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(records) / 512) * 512);
    body.write(records);
    tar = Buffer.concat([header("PaxHeader/package/package.json", 120, Buffer.byteLength(records)), body, original]);
  } else {
    const dotted = header(originalName.replace(/^package\//, "package/./"), 48, size);
    const body = Buffer.from(original.subarray(512, firstLength));
    if (scenario === "conflicting-dot-duplicate") body[0] = (body[0] ?? 0) ^ 1;
    tar = scenario === "dot-path" ? Buffer.concat([dotted, body, original.subarray(firstLength)])
      : Buffer.concat([dotted, body, original]);
  }
  const bytes = gzipSync(tar);
  await writeFile(engine.archive.path, bytes);
  const metadata = record(JSON.parse(await readFile(engine.metadata.path, "utf8")));
  const metadataBody = JSON.stringify({ ...metadata, dist: { ...record(metadata["dist"]),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } });
  await writeFile(engine.metadata.path, metadataBody);
  const changed = { ...engine, archive: { ...engine.archive, sha256: digest(bytes) },
    metadata: { ...engine.metadata, sha256: digest(metadataBody) } };
  const input = await authorizeTarget(f, f.input.qualification.target.artifacts.map(a => a === engine ? changed : a));
  const qualified = await qualifyOmoUpdate(input, now);
  if (["root-directory", "dot-path", "identical-dot-duplicate", "redundant-pax"].includes(scenario)) {
    expect(qualified.ok).toBe(true);
    const spec = value(createOmoUpdateSpec(value(qualified), "update-only", now));
    const result = await executeOmoUpdate(spec, { now: () => now, run: async command => {
      const origin = command.args[command.args.indexOf("--registry") + 1];
      const response = await fetch(`${origin}/tarballs/${changed.archive.sha256}.tgz`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      await materialize(f);
      return { status: 0, signal: null };
    } });
    expect(result.ok).toBe(true);
  } else expect(qualified).toEqual(rejected);
});
test("accepts a single named archive root and keeps original installer bytes", async () => {
  const f = await aliasFixture();
  const engine = f.input.qualification.target.artifacts.find(a => a.name === "@code-yeongyu/senpi");
  if (!engine) throw new TypeError("engine_fixture_missing");
  const changed = await replaceArchive(engine, files => {
    for (const [path, bytes] of Object.entries(files)) {
      delete files[path];
      files[path.replace(/^package\//, "senpi/")] = bytes;
    }
  });
  const input = await authorizeTarget(f, f.input.qualification.target.artifacts.map(a => a === engine ? changed : a));
  const context = value(await qualifyOmoUpdate(input, now));
  const spec = value(createOmoUpdateSpec(context, "update-only", now));
  const original = await readFile(changed.archive.path);
  const result = await executeOmoUpdate(spec, { now: () => now, run: async command => {
    const registry = command.args[command.args.indexOf("--registry") + 1];
    if (!registry) throw new TypeError("registry_missing");
    const response = await fetch(`${registry}/tarballs/${changed.archive.sha256}.tgz`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(original);
    await materialize(f);
    return { status: 0, signal: null };
  } });
  expect(result.ok).toBe(true);
});

test("rejects archives with multiple extraction roots", async () => {
  const f = await aliasFixture();
  const engine = f.input.qualification.target.artifacts.find(a => a.name === "@code-yeongyu/senpi");
  if (!engine) throw new TypeError("engine_fixture_missing");
  const changed = await replaceArchive(engine, files => { files["foreign/index.js"] = "foreign"; });
  const input = await authorizeTarget(f, f.input.qualification.target.artifacts.map(a => a === engine ? changed : a));
  expect(await qualifyOmoUpdate(input, now)).toEqual(rejected);
});

test("nested-contract qualifies and updates nearest multi-version slots and scoped alias", async () => {
  // Given: entities 7/8/4, retry 0.12/0.13 and two distinct entities@4 slots.
  const { f, input } = await nestedFixture();
  const context = value(await qualifyOmoUpdate(input, now));
  const spec = value(createOmoUpdateSpec(context, "update-only", now));
  // When: the original authenticated update strategy observes complete installed bytes.
  const result = await executeOmoUpdate(spec, { now: () => now, run: async () => {
    await materialize(f);
    return { status: 0, signal: null };
  } });
  // Then: actual Bun resolution selects each nearest physical version, not a flat fallback.
  expect(result).toMatchObject({ ok: true, value: { kind: "files-verified", durableReceipt: false } });
  const global = join(f.prefix, "install/global/node_modules");
  for (const [parent, key, slot, version] of [
    ["@code-yeongyu/senpi", "entities", "entities", "7.0.1"],
    ["htmlparser2", "entities", "htmlparser2/node_modules/entities", "4.5.0"],
    ["dom-serializer", "entities", "dom-serializer/node_modules/entities", "8.1.0"],
    ["p-retry", "entities", "p-retry/node_modules/entities", "4.5.0"],
    ["p-retry", "retry", "p-retry/node_modules/retry", "0.13.1"],
    ["@code-yeongyu/senpi", aliasName, `@code-yeongyu/senpi/node_modules/${aliasName}`, "2026.10.1-3"],
  ]) {
    if (!parent || !key || !slot || !version) throw new TypeError("resolution_case_missing");
    const resolved = Bun.resolveSync(`${key}/package.json`, join(global, parent));
    expect(resolved).toBe(join(global, slot, "package.json"));
    expect(JSON.parse(await readFile(resolved, "utf8")).version).toBe(version);
  }
  expect(await readdir(f.home)).toEqual([]);
  console.log("NESTED_RESOLUTION_PASS entities=7/8/4 retry=0.12/0.13 scopedAlias=true cache0");
});
test("nested-contract registry serves every authenticated version without slot-name identities", async () => {
  const { f, input, artifacts } = await nestedFixture();
  const spec = value(createOmoUpdateSpec(value(await qualifyOmoUpdate(input, now)), "update-only", now));
  let origin = "";
  const result = await executeOmoUpdate(spec, { now: () => now, run: async command => {
    origin = command.args[4] ?? "";
    const response = await fetch(`${origin}/entities`, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    const pkg = record(await response.json()), versions = record(pkg["versions"]);
    expect(Object.keys(versions).sort()).toEqual(["4.5.0", "7.0.1", "8.1.0"]);
    for (const version of ["4.5.0", "7.0.1", "8.1.0"]) {
      const selected = artifacts.find(a => a.name === "entities" && a.version === version);
      if (!selected) throw new TypeError("registry_version_missing");
      const entry = record(versions[version]), dist = record(entry["dist"]);
      expect(entry["version"]).toBe(version);
      const metadata = record(JSON.parse(await readFile(selected.metadata.path, "utf8")));
      expect(dist["integrity"]).toBe(record(metadata["dist"])["integrity"]);
      if (typeof dist["tarball"] !== "string") throw new TypeError("registry_tarball_missing");
      const archive = await fetch(dist["tarball"], { signal: AbortSignal.timeout(2000) });
      expect(archive.status).toBe(200);
      expect(digest(new Uint8Array(await archive.arrayBuffer()))).toBe(selected.archive.sha256);
    }
    expect((await fetch(`${origin}/${encodeURIComponent(aliasName)}`)).status).toBe(404);
    await materialize(f);
    return { status: 0, signal: null };
  } });
  expect(result.ok).toBe(true);
  await expect(fetch(`${origin}/entities`, { signal: AbortSignal.timeout(2000) })).rejects.toBeDefined();
  expect(await readdir(f.home)).toEqual([]);
  console.log("NESTED_REGISTRY_PASS status=200 versions=3 archiveHashes=true listener0 cache0");
});
test.each(["missing-closure", "wrong-path", "wrong-version", "wrong-hash", "wrong-metadata", "ambiguous-version",
  "installed-version", "escape", "duplicate-slot", "symlink", "stale"] as const)(
  "nested-contract refuses %s before installer effects", async scenario => {
    const { f, input, artifacts } = await nestedFixture();
    const slot = "htmlparser2/node_modules/entities";
    const selected = artifacts.find(a => a.installName === slot);
    const flat = artifacts.find(a => a.installName === "entities");
    if (!selected || !flat) throw new TypeError("negative_slot_missing");
    let rows = artifacts;
    switch (scenario) {
      case "missing-closure": rows = artifacts.filter(a => a !== selected); break;
      case "wrong-path": rows = artifacts.map(a => a === selected ? { ...a, installName: "htmlparser2/node_modules/other" } : a); break;
      case "wrong-version": rows = artifacts.map(a => a === selected ? { ...flat, installName: slot } : a); break;
      case "wrong-hash": rows = artifacts.map(a => a === selected ? { ...a, archive: { ...a.archive, sha256: "0".repeat(64) } } : a); break;
      case "wrong-metadata": rows = artifacts.map(a => a === selected ? { ...a, metadata: flat.metadata } : a); break;
      case "ambiguous-version": {
        const conflicting = artifacts.find(a => a.installName === "p-retry/node_modules/entities");
        if (!conflicting) throw new TypeError("duplicate_version_missing");
        const changed = await replaceArchive(selected, files => { files["package/index.js"] = "conflicting version bytes"; });
        rows = artifacts.map(a => a === selected ? changed : a);
        break;
      }
      case "installed-version": await writeFile(join(f.prefix, "install/global/node_modules", slot, "package.json"),
        '{"name":"entities","version":"7.0.1"}'); break;
      case "escape": rows = artifacts.map(a => a === selected ? { ...a, installName: "htmlparser2/node_modules/../../escape" } : a); break;
      case "duplicate-slot": rows = [...artifacts, selected]; break;
      case "symlink": {
        const parent = join(f.prefix, "install/global/node_modules/htmlparser2/node_modules");
        await mkdir(parent, { recursive: true });
        await rm(join(parent, "entities"), { recursive: true });
        await symlink(f.home, join(parent, "entities"));
        break;
      }
      case "stale": break;
    }
    const candidate = scenario === "stale" ? input : await authorizeTarget(f, rows);
    expect(await qualifyOmoUpdate(candidate, scenario === "stale" ? now + 1000 : now)).toEqual(rejected);
    expect(existsSync(f.marker)).toBe(false);
  });
test.each(["wrong-version", "wrong-hash", "missing-closure", "symlink"] as const)(
  "nested-contract refuses post-effect %s without claiming success", async scenario => {
    const { f, input } = await nestedFixture();
    const spec = value(createOmoUpdateSpec(value(await qualifyOmoUpdate(input, now)), "update-only", now));
    const slot = join(f.prefix, "install/global/node_modules/htmlparser2/node_modules/entities");
    const result = await executeOmoUpdate(spec, { now: () => now, run: async () => {
      await materialize(f);
      switch (scenario) {
        case "wrong-version": await writeFile(join(slot, "package.json"), '{"name":"entities","version":"7.0.1"}'); break;
        case "wrong-hash": await writeFile(join(slot, "index.js"), "changed bytes"); break;
        case "missing-closure": await rm(slot, { recursive: true }); break;
        case "symlink": await rm(slot, { recursive: true }); await symlink(f.home, slot); break;
      }
      return { status: 0, signal: null };
    } });
    expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
    expect(await readdir(f.home)).toEqual([]);
  });
test("nested-contract revalidates existing nested alias after final dispatch hook", async () => {
  const { f, input } = await nestedFixture();
  const spec = value(createOmoUpdateSpec(value(await qualifyOmoUpdate(input, now)), "update-only", now));
  const slot = join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi/node_modules", aliasName);
  const sentinel = join(f.home, "foreign-sentinel");
  await writeFile(sentinel, "unchanged");
  let launches = 0;
  const result = await executeOmoUpdate(spec, { now: () => now,
    event: async event => {
      if (event.kind !== "dispatch") return;
      await rm(slot, { recursive: true });
      await symlink(f.home, slot);
    },
    run: async () => { launches++; await writeFile(sentinel, "foreign write"); return { status: 0, signal: null }; },
  });
  // The unchanged official runSelfUpdate catches a pre-spawn failure as exit 1.
  expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
  expect(launches).toBe(0);
  expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  expect((await readdir(f.home)).filter(name => name.startsWith(".herdr-update-cache-"))).toEqual([]);
  console.log("NESTED_PREEXEC_PASS launches=0 foreignMutation=false cache0");
});
test("nested-contract original flow integrates real child resolution and durable ordering", async () => {
  // Given: existing pinned controlled manager, not a genuine vendor installer.
  const tail = `
for(const [parent,key] of [["htmlparser2","entities"],["dom-serializer","entities"],["p-retry","retry"],["@code-yeongyu/senpi","@earendil-works/pi-ai"]]){
 const resolved=Bun.resolveSync(key+"/package.json",p.wrapper+"/../"+parent);
 appendFileSync(p.effects,JSON.stringify({kind:"nested-resolution",parent,key,resolved,manifest:JSON.parse(readFileSync(resolved,"utf8"))})+"\\n");
}`;
  const f = await childFixture("alias-install", tail);
  try {
    const targetFiles = new Map<string, string | Uint8Array>(f.files);
    const { input } = await nestedTarget({ root: f.root, prefix: f.prefix, input: f.input, targetFiles,
      authorize: async qualification => {
        const body = JSON.stringify(qualification);
        await writeFile(f.input.receipt.path, body);
        return { qualification, receipt: { path: f.input.receipt.path, sha256: digest(body) } };
      } });
    const planPath = join(f.root, "fixture-plan.json");
    const plan = record(JSON.parse(await readFile(planPath, "utf8")));
    const files = [...targetFiles].map(([path, bytes]) => [path, typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")]);
    await writeFile(planPath, JSON.stringify({ ...plan, files }));
    const spec = value(createOmoUpdateSpec(value(await qualifyOmoUpdate(input, now)), "update-only", now));
    // When: real consumer launches/reaps the child under the original official strategy.
    const result = await consumeOmoUpdate(spec, { receiptRoot: f.journal, now: () => now });
    expect(result).toMatchObject({ ok: true, value: { kind: "files-verified", durableReceipt: true } });
    const effects: Array<ChildEffect & { parent?: string; key?: string }> =
      (await readFile(f.effects, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(effects.filter(row => row.pid !== undefined)).toHaveLength(1);
    expect(effects.filter(row => row.kind === "nested-resolution").map(row => [row.parent, row.key, row.manifest?.version]))
      .toEqual([["htmlparser2", "entities", "4.5.0"], ["dom-serializer", "entities", "8.1.0"],
        ["p-retry", "retry", "0.13.1"], ["@code-yeongyu/senpi", aliasName, "2026.10.1-3"]]);
    const receipts: OmoConsumerReceipt[] = readdirSync(f.journal).flatMap(name =>
      readFileSync(join(f.journal, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    expect(receipts.map(row => row.kind)).toEqual(["intent", "dispatch", "launched", "exit", "files-verified"]);
    for (const { pid } of effects) if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
    const port = effects.find(row => row.registryPort !== undefined)?.registryPort;
    if (port === undefined) throw new TypeError("nested_registry_port_missing");
    const socket = new Socket();
    try {
      const refused = bounded(once(socket, "error"));
      socket.connect(port, "127.0.0.1");
      expect((await refused)[0]).toMatchObject({ code: "ECONNREFUSED" });
    } finally { socket.destroy(); }
    expect(await readdir(f.home)).toEqual([]);
    console.log("NESTED_CHILD_PASS child=1 resolution=4 durableOrder=true reaped=true registry0 cache0");
  } finally {
    expect(await f.cleanup()).toEqual({ rootsRemaining: 0, socketsRemaining: 0 });
    await expect(access(f.root)).rejects.toMatchObject({ code: "ENOENT" });
    console.log("NESTED_CHILD_CLEANUP0 roots=0 sockets=0");
  }
});
test.each(["bound", "ungranted", "vendor-metadata", "local-identity", "local-dependencies", "native-output"] as const)(
  "authenticates explicit local overlay without rewriting vendor evidence: %s", async scenario => {
    // Given: controlled acquired-archive fixtures, real qualifier and native-file
    // pins. This is input-boundary evidence, not genuine native installation QA.
    const f = await aliasFixture();
    const engine = f.input.qualification.target.artifacts.find(row => row.name === "@code-yeongyu/senpi");
    if (!engine) throw new TypeError("engine_fixture_missing");
    const vendorFiles: Record<string, Blob | string> = Object.fromEntries(await new Bun.Archive(await readFile(engine.archive.path)).files());
    const originalManifest = vendorFiles["package/package.json"];
    if (!(originalManifest instanceof Blob)) throw new TypeError("manifest_fixture_missing");
    const manifest = record(JSON.parse(await originalManifest.text()));
    const vendorWithOverrides = await replaceArchive(engine, files => {
      files["package/package.json"] = JSON.stringify({ ...manifest, overrides: { [aliasName]: aliasDeclaration } });
    });
    const localFiles: Record<string, Blob | string> = Object.fromEntries(await new Bun.Archive(await readFile(vendorWithOverrides.archive.path)).files());
    const sourcePath = join(f.root, "native-output.js"), nativeBody = "export const nativeBridge = true;\n";
    await writeFile(sourcePath, nativeBody);
    localFiles["package/dist/payload.js"] = nativeBody;
    const nativePaths = ["dist/cli-main.js", "dist/core/updater-native-bridge.js", "dist/core/agent-session.js", "dist/core/session-manager.js",
      "dist/modes/interactive/interactive-mode.js", "dist/core/extensions/builtin/terminal/tools/monitor.js", "dist/payload.js"];
    for (const path of nativePaths) localFiles[`package/${path}`] = nativeBody;
    if (scenario === "local-identity" || scenario === "local-dependencies") {
      const entry = localFiles["package/package.json"];
      if (!(entry instanceof Blob)) throw new TypeError("local_manifest_missing");
      const pkg = record(JSON.parse(await entry.text()));
      localFiles["package/package.json"] = JSON.stringify(scenario === "local-identity"
        ? { ...pkg, version: "2026.10.1-4" } : { ...pkg, dependencies: {} });
    }
    const localBytes = await new Bun.Archive(localFiles, { compress: "gzip" }).bytes();
    const archivePath = join(f.root, "local-native-overlay.tgz");
    await writeFile(archivePath, localBytes);
    const sourceBindingPath = join(f.root, "controlled-native-build-receipt.json");
    const sourceBindingBody = JSON.stringify({ controlledFixture: true, outputs: nativePaths });
    await writeFile(sourceBindingPath, sourceBindingBody);
    const overlay = { kind: "local-source-overlay", archive: { path: archivePath, sha256: digest(localBytes) },
      localDist: { integrity: `sha512-${createHash("sha512").update(localBytes).digest("base64")}`,
        tarballPath: `/tarballs/${digest(localBytes)}.tgz` },
      sourceBinding: { path: sourceBindingPath, sha256: digest(sourceBindingBody) },
      originalBuildCommands: ["controlled test build, not a native build receipt"],
      files: nativePaths.map(relativePath => ({ relativePath, source: { path: sourcePath, sha256: digest(nativeBody) } })) } as const;
    const grant: OmoLocalOverlayGrant = { vendorArchive: vendorWithOverrides.archive,
      vendorMetadata: vendorWithOverrides.metadata, overlay };
    let artifact: OmoArtifact = { ...vendorWithOverrides, overlay };
    if (scenario === "vendor-metadata") {
      const body = record(JSON.parse(await readFile(artifact.metadata.path, "utf8")));
      const altered = JSON.stringify({ ...body, name: "not-the-acquired-engine" });
      await writeFile(artifact.metadata.path, altered);
      artifact = { ...artifact, metadata: { ...artifact.metadata, sha256: digest(altered) } };
    }
    if (scenario === "native-output") await writeFile(sourcePath, "unregistered native output");
    const input = await authorizeTarget(f, f.input.qualification.target.artifacts.map(row => row.name === engine.name ? artifact : row));
    // When: qualification sees genuine identity/integrity separately from local bytes.
    const qualified = await qualifyOmoUpdate(input, now, scenario === "ungranted" ? [] : [grant]);
    // Then: a JSON overlay cannot grant authority, and neither source nor package
    // identity/dependencies nor acquired metadata can drift under an explicit grant.
    if (scenario === "bound") {
      expect(qualified.ok).toBe(true);
      if (!qualified.ok) throw new TypeError("bound_overlay_refused");
      expect(createOmoUpdateSpec(qualified.value, "update-and-restart", now).ok).toBe(true);
      expect(artifact.archive).toEqual(vendorWithOverrides.archive);
    } else expect(qualified).toEqual(rejected);
  });
type ChildEffect = {
  readonly pid?: number; readonly registryPort?: number;
  readonly kind?: string; readonly resolved?: string;
  readonly manifest?: { readonly name: string; readonly version: string };
};
const resolutionTail = `
const resolved=Bun.resolveSync("@earendil-works/pi-ai/package.json",p.wrapper+"/../@code-yeongyu/senpi");
appendFileSync(p.effects,JSON.stringify({kind:"resolution",resolved,manifest:JSON.parse(readFileSync(resolved,"utf8"))})+"\\n");
`;
test.each(["positive", "alias-slot", "scope", "alias-slot-clock", "nearest-shadow", "payload-parent", "payload-file"] as const)(
  "preexec-f1-r2 real child prevents %s before effects", async scenario => {
    // Given: genuine consumer/process boundary with a pinned controlled manager.
    const f = await childFixture("alias-install", resolutionTail);
    const scope = join(f.prefix, "install/global/node_modules/@earendil-works"), slot = join(scope, "pi-ai");
    const foreign = join(f.root, "foreign-owned");
    const foreignFile = join(foreign, scenario === "scope" ? "pi-ai/package.json"
      : scenario === "payload-parent" ? "payload.js" : "package.json");
    const sentinel = '{"name":"foreign-before","version":"0.0.0"}\n';
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let execution: ReturnType<typeof consumeOmoUpdate> | undefined;
    let dispatched = false, clockInjected = false;
    try {
      await mkdir(dirname(foreignFile), { recursive: true });
      await writeFile(foreignFile, sentinel);
      const spec = await f.spec();
      // When: all injection completes inside the exact awaited dispatch boundary.
      execution = consumeOmoUpdate(spec, { receiptRoot: f.journal,
        now: () => {
          if (scenario === "alias-slot-clock" && dispatched && !clockInjected) {
            mkdirSync(scope, { recursive: true }); symlinkSync(foreign, slot); clockInjected = true;
          }
          return now;
        },
        event: async event => {
          if (event.kind !== "dispatch") return;
          dispatched = true;
          entered.resolve();
          await bounded(release.promise);
        } });
      await bounded(Promise.race([entered.promise, execution.then(() => { throw new TypeError("dispatch_not_observed"); })]));
      switch (scenario) {
        case "positive":
        case "alias-slot-clock": break;
        case "alias-slot": await mkdir(scope, { recursive: true }); await symlink(foreign, slot); break;
        case "scope": await symlink(foreign, scope); break;
        case "nearest-shadow": {
          const nested = join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai");
          await mkdir(nested, { recursive: true });
          await writeFile(join(nested, "package.json"), sentinel);
          break;
        }
        case "payload-parent":
          await mkdir(slot, { recursive: true }); await symlink(foreign, join(slot, "dist")); break;
        case "payload-file":
          await mkdir(slot, { recursive: true }); await symlink(foreignFile, join(slot, "package.json")); break;
      }
      release.resolve();
      const result = await bounded(execution);
      const receipts: OmoConsumerReceipt[] = readdirSync(f.journal).flatMap(name =>
        readFileSync(join(f.journal, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
      const effects: ChildEffect[] = existsSync(f.effects)
        ? (await readFile(f.effects, "utf8")).trim().split("\n").map(line => JSON.parse(line)) : [];
      const launches = effects.filter(row => row.pid !== undefined);
      const resolution = effects.find(row => row.kind === "resolution");
      const foreignMutation = await readFile(foreignFile, "utf8") !== sentinel;
      console.log("PREEXEC_F1", JSON.stringify({ scenario, launches: launches.length, foreignMutation,
        result: result.ok ? result.value.kind : result.error.code,
        resolvedInsidePrefix: resolution?.resolved === join(slot, "package.json"),
        journal: receipts.map(row => row.kind) }));
      // Then: recovery after a foreign write is not successful prevention.
      if (scenario === "positive") {
        expect(result).toMatchObject({ ok: true, value: { kind: "files-verified", durableReceipt: true } });
        expect(launches).toHaveLength(1);
        expect(resolution).toMatchObject({ resolved: join(slot, "package.json"),
          manifest: { name: "@code-yeongyu/senpi-ai", version: "2026.10.1-3" } });
        expect(receipts.map(row => row.kind)).toEqual(["intent", "dispatch", "launched", "exit", "files-verified"]);
      } else {
        expect({ launches: launches.length, foreignMutation }).toEqual({ launches: 0, foreignMutation: false });
        expect(result).toEqual(rejected);
        expect(receipts.map(row => row.kind)).toEqual(["intent", "dispatch", "rejected"]);
      }
      expect(await readFile(foreignFile, "utf8")).toBe(sentinel);
    } finally {
      release.resolve();
      if (execution) await bounded(execution);
      try {
        const effects: ChildEffect[] = existsSync(f.effects)
          ? (await readFile(f.effects, "utf8")).trim().split("\n").map(line => JSON.parse(line)) : [];
        for (const { pid } of effects) if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
        const port = effects.find(row => row.registryPort !== undefined)?.registryPort;
        if (port !== undefined) {
          const socket = new Socket();
          try {
            const refused = bounded(once(socket, "error"));
            socket.connect(port, "127.0.0.1");
            expect((await refused)[0]).toMatchObject({ code: "ECONNREFUSED" });
          } finally { socket.destroy(); }
        }
        expect(await readdir(f.home)).toEqual([]);
      } finally {
        expect(await f.cleanup()).toEqual({ rootsRemaining: 0, socketsRemaining: 0 });
        await expect(access(f.root)).rejects.toMatchObject({ code: "ENOENT" });
      }
      console.log("PREEXEC_CLEANUP0", JSON.stringify({ scenario, roots: 0, children: 0, sockets: 0, caches: 0 }));
    }
  },
);
test.each(["slot-link", "scope-link", "dangling-slot", "dangling-scope", "slot-file", "scope-file", "nearest-shadow"] as const)(
  "preexec-f1-r2 qualification rejects existing %s before issuing authority", async scenario => {
    // Given: the authenticated source relation is valid, but the physical destination is not.
    const f = await aliasFixture(), scope = join(f.prefix, "install/global/node_modules/@earendil-works");
    const slot = join(scope, "pi-ai"), foreign = join(f.root, "foreign-owned");
    await mkdir(foreign);
    switch (scenario) {
      case "slot-link": await mkdir(scope); await symlink(foreign, slot); break;
      case "scope-link": await symlink(foreign, scope); break;
      case "dangling-slot": await mkdir(scope); await symlink(join(foreign, "absent"), slot); break;
      case "dangling-scope": await symlink(join(foreign, "absent"), scope); break;
      case "slot-file": await mkdir(scope); await writeFile(slot, "not-a-directory"); break;
      case "scope-file": await writeFile(scope, "not-a-directory"); break;
      case "nearest-shadow":
        await mkdir(join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai"), { recursive: true });
        break;
    }
    // When / Then: no new opaque execution context and no manager effect.
    expect(await qualifyOmoUpdate(f.input, now)).toEqual(rejected);
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["global", "dependencies", "optionalDependencies", "peerDependencies", "repeated"] as const)(
  "alias-r1 exact declaration joins %s without row-order dependence", async field => {
    // Given: independent exact declaration inputs in each guarded manifest field.
    const f = await aliasFixture(field === "global" ? { global: true, fields: [] }
      : field === "repeated" ? { global: true, fields: ["dependencies", "optionalDependencies", "peerDependencies"] }
        : { fields: [field] });
    const q = f.input.qualification;
    // When: the alias row precedes the declaring engine in the target.
    const input = await authorizeTarget(f, [...q.target.artifacts].reverse());
    const context = value(await qualifyOmoUpdate(input, now));
    const spec = value(createOmoUpdateSpec(context, "update-only", now));
    const result = await executeOmoUpdate(spec, { now: () => now, run: async () => {
      await materialize(f); return { status: 0, signal: null };
    } });
    // Then: one alias root with unchanged actual identity and original edges.
    expect(result).toMatchObject({ ok: true, value: { kind: "files-verified", durableReceipt: false } });
    const aliasRoot = join(f.prefix, "install/global/node_modules/@earendil-works/pi-ai");
    expect(JSON.parse(await readFile(join(aliasRoot, "package.json"), "utf8")))
      .toEqual({ name: "@code-yeongyu/senpi-ai", version: "2026.10.1-3" });
    const engine = JSON.parse(await readFile(join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json"), "utf8"));
    if (field !== "global") expect(engine[field === "repeated" ? "dependencies" : field][aliasName]).toBe(aliasDeclaration);
    if (field === "global" || field === "repeated")
      expect(JSON.parse(await readFile(join(f.prefix, "install/global/package.json"), "utf8")).dependencies[aliasName]).toBe(aliasDeclaration);
    await expect(access(join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi-ai"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
test("alias-r1 exact declaration does not reserve the actual npm package name global", async () => {
  // Given: published devDependencies are not installation edges in the existing contract.
  const f = await setup();
  const bytes = await new Bun.Archive({ "package/package.json": JSON.stringify({
    name: "global", version: "1.0.0", devDependencies: { "development-only": "workspace:*" },
  }) }, { compress: "gzip" }).bytes();
  const archivePath = join(f.root, "global.tgz"), metadataPath = join(f.root, "global.metadata.json");
  const metadata = JSON.stringify({ name: "global", version: "1.0.0", dist: {
    tarball: "https://registry.npmjs.org/global/-/global-1.0.0.tgz",
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  } });
  await writeFile(archivePath, bytes);
  await writeFile(metadataPath, metadata);
  const artifact: OmoArtifact = { name: "global", installName: "global", version: "1.0.0",
    archive: { path: archivePath, sha256: digest(bytes) }, metadata: { path: metadataPath, sha256: digest(metadata) } };
  // When / Then: the package's name cannot turn it into the global manifest.
  const input = await authorizeTarget(f, [...f.input.qualification.target.artifacts, artifact]);
  expect(await qualifyOmoUpdate(input, now)).toMatchObject({ ok: true });
});
test("alias-r1 registry identity retains actual name SRI and archive, not alias name", async () => {
  // Given
  const f = await aliasFixture();
  const artifact = f.input.qualification.target.artifacts.find(a => a.name === actualName);
  if (!artifact) throw new TypeError("missing_alias_artifact");
  const metadata = JSON.parse(await readFile(artifact.metadata.path, "utf8"));
  let origin = "";
  // When: request both identities through the real leased HTTP server.
  const result = await executeOmoUpdate(f.spec, { now: () => now, run: async command => {
    origin = command.args[4] ?? "";
    const response = await fetch(`${origin}/${encodeURIComponent(actualName)}`, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const packument = record(await response.json());
    const version = record(record(packument["versions"])["2026.10.1-3"]), dist = record(version["dist"]);
    expect(packument["name"]).toBe("@code-yeongyu/senpi-ai");
    expect(version["name"]).toBe("@code-yeongyu/senpi-ai");
    expect(dist["integrity"]).toBe(metadata.dist.integrity);
    const tarball = dist["tarball"];
    if (typeof tarball !== "string") throw new TypeError("invalid_alias_tarball");
    const archive = await fetch(tarball, { signal: AbortSignal.timeout(2000) });
    expect(archive.status).toBe(200);
    expect(Buffer.from(await archive.arrayBuffer())).toEqual(await readFile(artifact.archive.path));
    expect((await fetch(`${origin}/${encodeURIComponent(aliasName)}`, { signal: AbortSignal.timeout(2000) })).status).toBe(404);
    return { status: 29, signal: null };
  } });
  // Then: HTTP proof is not an installation success; its lease/cache are gone.
  expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
  await expect(fetch(`${origin}/omo-ai`, { signal: AbortSignal.timeout(2000) })).rejects.toBeDefined();
  expect(await readdir(f.home)).toEqual([]);
});
const badDeclarations = ["npm:@code-yeongyu/senpi-ai@2026.10.1-4", "npm:@other/senpi-ai@2026.10.1-3",
  "npm:@code-yeongyu/senpi-ai@latest", "npm:@code-yeongyu/senpi-ai@^2026.10.1", `npm:${aliasDeclaration}`,
  "git:repo", "file:../pkg", "http://example.invalid/pkg", "workspace:*", "2026.10.1-3"] as const;
test.each(["global", "dependencies", "optionalDependencies", "peerDependencies"] as const)(
  "alias-r1 declaration rejection covers exact %s guard independently", async field => {
    for (const declaration of badDeclarations) {
      // Given: repin one changed declaration, leaving authentic source identities intact.
      const f = await aliasFixture(field === "global" ? { global: true, fields: [] } : { fields: [field] });
      let q: OmoUpdateQualification = f.input.qualification;
      if (field === "global") {
        const path = join(f.prefix, "install/global/package.json");
        const body = JSON.stringify({ dependencies: { "omo-ai": "5.1.9", [aliasName]: declaration } });
        await writeFile(path, body);
        const resources = q.installation.resources.map(row => row.realpath === path ? { ...row, fingerprint: `sha256:${digest(body)}` } : row);
        q = { ...q, installation: { ...q.installation, resources, resourcesFingerprint: `sha256:${digest(JSON.stringify(resources))}` } };
      } else {
        const engine = q.target.artifacts.find(a => a.name === "@code-yeongyu/senpi");
        if (!engine) throw new TypeError("missing_engine_artifact");
        const changed = await replaceArchive(engine, files => {
          files["package/package.json"] = JSON.stringify({ name: engine.name, version: engine.version, [field]: { [aliasName]: declaration } });
        });
        q = { ...q, target: { ...q.target, artifacts: q.target.artifacts.map(a => a === engine ? changed : a) } };
      }
      // When / Then: no executable authority is issued.
      expect(await qualifyOmoUpdate(await f.authorize(q), now)).toEqual(rejected);
    }
  },
);
test.each(["missing-installName", "wrong-key", "missing-row", "duplicate-slot", "second-version", "unexplained",
  "direct-and-alias", "wrapper-alias", "engine-alias", "", "bad\nname", "../escape", "@scope/../escape"] as const)(
  "alias-r1 declaration rejection refuses unsupported mapping %#", async kind => {
    // Given
    const f = await aliasFixture(), q = f.input.qualification;
    const alias = q.target.artifacts.find(a => a.name === actualName);
    if (!alias) throw new TypeError("missing_alias_artifact");
    let artifacts = [...q.target.artifacts];
    if (kind === "missing-row") artifacts = artifacts.filter(a => a !== alias);
    else if (kind === "duplicate-slot") artifacts.push({ ...alias, name: "@other/ai" });
    else if (kind === "second-version") artifacts.push({ ...alias, version: "2026.10.1-4", installName: "@other/ai" });
    else if (kind === "direct-and-alias") artifacts.push({ ...alias, installName: actualName });
    else if (kind === "missing-installName") {
      const input = JSON.parse(JSON.stringify(q));
      delete input.target.artifacts[2].installName;
      expect(await qualifyOmoUpdate(await f.authorize(input), now)).toEqual(rejected);
      return;
    } else if (kind === "unexplained") {
      const ordinary = await setup();
      const foreign = { ...alias, installName: "@other/ai" };
      expect(await qualifyOmoUpdate(await authorizeTarget(ordinary, [...ordinary.input.qualification.target.artifacts, foreign]), now)).toEqual(rejected);
      return;
    } else artifacts = artifacts.map(a => kind === "wrapper-alias" && a.name === "omo-ai"
      || kind === "engine-alias" && a.name === "@code-yeongyu/senpi"
      ? { ...a, installName: "@other/root" }
      : a === alias && kind !== "wrapper-alias" && kind !== "engine-alias"
        ? { ...a, installName: kind === "wrong-key" ? "@other/ai" : kind } : a);
    // When / Then
    expect(await qualifyOmoUpdate(await authorizeTarget(f, artifacts), now)).toEqual(rejected);
  },
);
test.each(["valid", "actual-root", "missing", "name", "version", "removed-file", "extra-file", "nested-shadow",
  "symlink", "postinstall-name", "postinstall-edge"] as const)(
  "alias-r1 destination proof verifies physical %s after installation", async kind => {
    // Given: expected alias file bytes and independently specified physical path.
    const f = await aliasFixture(), q = f.input.qualification;
    const root = join(f.prefix, "install/global/node_modules/@earendil-works/pi-ai");
    const manifestPath = join(root, "package.json");
    let spec = f.spec;
    let modifiedPath = manifestPath, modifiedBody = "";
    if (kind === "postinstall-name" || kind === "postinstall-edge") {
      modifiedPath = kind === "postinstall-name" ? manifestPath : join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json");
      modifiedBody = kind === "postinstall-name" ? JSON.stringify({ name: aliasName, version: "2026.10.1-3" })
        : JSON.stringify({ name: "@code-yeongyu/senpi", version: "2026.10.1-3", dependencies: { [actualName]: "2026.10.1-3" } });
      const context = value(await qualifyOmoUpdate(await authorizeTarget(f, q.target.artifacts,
        [...q.target.postinstall, { path: modifiedPath, sha256: digest(modifiedBody) }]), now));
      spec = value(createOmoUpdateSpec(context, "update-only", now));
    }
    if (kind === "nested-shadow") {
      // Permit these exact bytes as postinstall output so that only the nearer
      // resolution, not an unrelated unlisted-file check, distinguishes failure.
      const nestedManifest = join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/package.json");
      const nestedBody = JSON.stringify({ name: actualName, version: "2026.10.1-3" });
      const context = value(await qualifyOmoUpdate(await authorizeTarget(f, q.target.artifacts,
        [...q.target.postinstall, { path: nestedManifest, sha256: digest(nestedBody) }]), now));
      spec = value(createOmoUpdateSpec(context, "update-only", now));
    }
    // When: mutate one final destination property, never genuine acquired files.
    const result = await executeOmoUpdate(spec, { now: () => now, run: async () => {
      await materialize(f);
      switch (kind) {
        case "valid": break;
        case "actual-root": await rename(root, join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi-ai")); break;
        case "missing": await rm(root, { recursive: true }); break;
        case "name": await writeFile(manifestPath, JSON.stringify({ name: aliasName, version: "2026.10.1-3" })); break;
        case "version": await writeFile(manifestPath, JSON.stringify({ name: actualName, version: "2026.10.1-4" })); break;
        case "removed-file": await rm(join(root, "dist/payload.js")); break;
        case "extra-file": await writeFile(join(root, "extra.js"), "unexpected"); break;
        case "nested-shadow": {
          const nested = join(f.prefix, "install/global/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai");
          await mkdir(nested, { recursive: true });
          await writeFile(join(nested, "package.json"), await readFile(manifestPath));
          break;
        }
        case "symlink": {
          const other = join(f.root, "other-owned-alias");
          await rename(root, other); await symlink(other, root); break;
        }
        case "postinstall-name":
        case "postinstall-edge": await writeFile(modifiedPath, modifiedBody); break;
      }
      return { status: 0, signal: null };
    } });
    // Then: zero process status cannot substitute for final physical proof.
    if (kind === "valid") expect(result).toMatchObject({ ok: true, value: { kind: "files-verified", durableReceipt: false } });
    else expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
  },
);
test.each(["own-roots", "cross-link"] as const)("alias-r1 independent prefixes retain distinct authority for %s", async kind => {
  // Given: identical published alias bytes, distinct physical installations.
  const a = await aliasFixture(), b = await aliasFixture(), executor = capture();
  const artifacts: OmoArtifact[] = [];
  for (const target of b.input.qualification.target.artifacts) {
    const source = a.input.qualification.target.artifacts.find(row => row.name === target.name);
    if (!source) throw new TypeError("missing_shared_artifact");
    await writeFile(target.archive.path, await readFile(source.archive.path));
    await writeFile(target.metadata.path, await readFile(source.metadata.path));
    artifacts.push({ ...target, archive: { ...target.archive, sha256: source.archive.sha256 },
      metadata: { ...target.metadata, sha256: source.metadata.sha256 } });
  }
  const bContext = value(await qualifyOmoUpdate(await authorizeTarget(b, artifacts), now));
  const bSpec = value(createOmoUpdateSpec(bContext, "update-only", now));
  expect(artifacts.map(x => x.archive.sha256)).toEqual(a.input.qualification.target.artifacts.map(x => x.archive.sha256));
  expect(a.spec.expectedInstallation.installationId).not.toBe(b.spec.expectedInstallation.installationId);
  expect(a.spec.expectedInstallation.resourcesFingerprint).not.toBe(b.spec.expectedInstallation.resourcesFingerprint);
  // When / Then: a context cannot be paired with the other selection.
  expect(await executeOmoUpdate({ ...a.spec, expectedInstallation: b.spec.expectedInstallation }, executor)).toEqual(rejected);
  expect(executor.commands).toHaveLength(0);
  expect(await executeOmoUpdate(a.spec, { now: () => now, run: async () => {
    await materialize(a); return { status: 0, signal: null };
  } })).toMatchObject({ ok: true });
  expect(await executeOmoUpdate(bSpec, { now: () => now, run: async () => {
    await materialize(b);
    if (kind === "cross-link") {
      const slot = "install/global/node_modules/@earendil-works/pi-ai";
      await rm(join(b.prefix, slot), { recursive: true });
      await symlink(join(a.prefix, slot), join(b.prefix, slot));
    }
    return { status: 0, signal: null };
  } })).toMatchObject(kind === "cross-link" ? { ok: false, error: { code: "recovery_required" } }
    : { ok: true, value: { kind: "files-verified", durableReceipt: false } });
});
test.each(["sri", "name", "version"] as const)("alias-r1 source integrity rejects authentic installName with wrong %s", async kind => {
  // Given
  const f = await aliasFixture(), q = f.input.qualification;
  const alias = q.target.artifacts.find(a => a.name === actualName);
  if (!alias) throw new TypeError("missing_alias_artifact");
  const changed = await replaceArchive(alias, files => {
    if (kind === "sri") files["package/dist/payload.js"] = "changed";
    else files["package/package.json"] = JSON.stringify({ name: kind === "name" ? aliasName : actualName,
      version: kind === "version" ? "2026.10.1-4" : "2026.10.1-3" });
  }, kind === "sri");
  // When / Then: repinned SHA256 cannot replace SRI or actual archive identity.
  expect(await qualifyOmoUpdate(await authorizeTarget(f, q.target.artifacts.map(a => a === alias ? changed : a)), now)).toEqual(rejected);
});
test.each(["dispatch-receipt", "exit-manifest", "exit-destination", "exit-global-edge"] as const)(
  "alias-r1 late hook rechecks %s after bounded event barrier", async kind => {
    // Given: both signals exist before execution; timeout only bounds failure.
    const f = await aliasFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let effects = 0;
    const execution = executeOmoUpdate(f.spec, { now: () => now, run: async () => {
      effects++; await materialize(f); return { status: 0, signal: null };
    }, event: async event => {
      if (event.kind === (kind === "dispatch-receipt" ? "dispatch" : "exit")) { entered.resolve(); await bounded(release.promise); }
    } });
    try {
      await bounded(Promise.race([entered.promise, execution.then(() => { throw new TypeError("alias_hook_not_observed"); })]));
      // When
      const root = join(f.prefix, "install/global/node_modules/@earendil-works/pi-ai");
      if (kind === "dispatch-receipt") await writeFile(f.input.receipt.path, "{}");
      else if (kind === "exit-manifest") await writeFile(join(root, "package.json"), '{"name":"wrong","version":"2026.10.1-3"}');
      else if (kind === "exit-global-edge") await writeFile(join(f.prefix, "install/global/package.json"),
        JSON.stringify({ dependencies: { "omo-ai": "5.1.10" }, optionalDependencies: { [aliasName]: aliasDeclaration } }));
      else await rename(root, join(f.root, "moved-alias"));
    } finally { release.resolve(); }
    // Then: pre-effect denial versus post-effect recovery is explicit.
    const result = await bounded(execution);
    if (kind === "dispatch-receipt") { expect(result.ok).toBe(false); expect(effects).toBe(0); }
    else { expect(result).toEqual({ ok: false, error: { code: "recovery_required" } }); expect(effects).toBe(1); }
    expect(await readdir(f.home)).toEqual([]);
  },
);

test("runs the actual official wrapper flow with exact private manager, environment and immutable package", async () => {
  // Given: real owned files, original official sources and a separately pinned receipt.
  const f = await setup(), executor = capture();
  // When: the official flow reaches only the injected effect boundary.
  const result = await executeOmoUpdate(f.spec, executor);
  // Then: the capture refuses installation; it is not reported as an update success.
  expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
  expect<unknown>(executor.commands).toEqual([{
    executable: f.manager, args: ["add", "-g", "omo-ai@5.1.10", "--registry",
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), "--cache-dir",
      expect.stringContaining(`${f.home}/.herdr-update-cache-`), "--force", "--linker", "hoisted", "--frozen-lockfile"], cwd: f.wrapper,
    shell: false, inheritEnv: false,
    env: { HOME: f.home, PATH: join(f.prefix, "bin"), BUN_INSTALL: f.prefix },
  }]);
  expect(JSON.stringify(f.context)).toBe('{"kind":"omo-official-update"}');
  expect(Object.keys(f.context)).toEqual(["kind"]);
  expect(f.spec.expectedInstallation).toEqual(f.input.qualification.installation);
  expect(f.spec.mutationResources).toEqual(f.input.qualification.installation.resources);
});
test("keeps official post-install version verification when a manager falsely returns zero", async () => {
  // Given
  const f = await setup(), executor = capture();
  // When: manager reports success but installed metadata has not changed.
  const result = await executeOmoUpdate(f.spec, { ...executor, run: async command => {
    await executor.run(command); return { status: 0, signal: null };
  } });
  // Then
  expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
  expect(executor.commands).toHaveLength(1);
});
test.each(["bytes", "alias"] as const)("blocks stale manager %s before effects", async kind => {
  // Given
  const f = await setup(), executor = capture();
  if (kind === "bytes") await writeFile(f.manager, "#!/bin/sh\nexit 99\n");
  else {
    const alias = join(f.root, "alias");
    await symlink(f.manager, alias);
    const input = await f.authorize({ ...f.input.qualification, manager: { ...f.input.qualification.manager, path: alias } });
    expect(await qualifyOmoUpdate(input, now)).toEqual(rejected);
  }
  // When / Then
  expect(await executeOmoUpdate(f.spec, executor)).toEqual(rejected);
  expect(executor.commands).toHaveLength(0);
});
test.each(["latest", "beta", "*", "^5.1.10", "omo-ai", "5.1.10;echo", ""] as const)(
  "rejects floating or unsafe target %#", async version => {
    // Given
    const f = await setup();
    const input = await f.authorize({ ...f.input.qualification, target: { ...f.input.qualification.target, version } });
    // When / Then
    expect(await qualifyOmoUpdate(input, now)).toEqual(rejected);
  },
);
test.each(["expired", "future", "channel", "source", "receipt", "resource", "prefix"] as const)(
  "blocks stale or mismatched %s evidence", async kind => {
    // Given
    const f = await setup(), executor = capture(), q = f.input.qualification;
    if (kind === "source") await writeFile(join(f.wrapper, "bin/lib/self-update.js"), "throw new Error('PRIVATE_SENTINEL')");
    else if (kind === "receipt") await writeFile(f.input.receipt.path, '{"PRIVATE_SENTINEL":true}');
    else if (kind === "resource") await writeFile(join(f.prefix, "install/global/bun.lock"), "changed");
    else {
      const input = await f.authorize({ ...q,
        ...(kind === "prefix" ? { env: { ...q.env, BUN_INSTALL: f.root } } : {}),
        target: { ...q.target, ...(kind === "expired" ? { expiresAt: now } : kind === "future"
          ? { checkedAt: now + 1 } : kind === "channel" ? { channel: "beta" as const } : {}) },
      });
      expect(await qualifyOmoUpdate(input, now)).toEqual(rejected);
    }
    // When / Then
    expect(await executeOmoUpdate(f.spec, executor)).toEqual(rejected);
    expect(executor.commands).toHaveLength(0);
  },
);
test.each(["NODE_OPTIONS", "BUN_OPTIONS", "NPM_CONFIG_PREFIX", "npm_config_ignore_scripts", "TOKEN", "OMO_SENPI_PATCH_ROOT"])(
  "rejects unsafe inherited environment key %s without returning its value", async key => {
    // Given
    const f = await setup();
    const input = await f.authorize({ ...f.input.qualification,
      env: { ...f.input.qualification.env, [key]: "PRIVATE_SENTINEL" } });
    // When / Then
    expect(await qualifyOmoUpdate(input, now)).toEqual(rejected);
  },
);
test.each(["copy", "json", "other-install", "command", "resources"] as const)(
  "rejects forged private context or spec %s", async kind => {
    // Given
    const f = await setup(), executor = capture();
    const forged = kind === "copy" ? { ...f.spec, execution: { ...f.context } }
      : kind === "json" ? JSON.parse(JSON.stringify(f.spec))
      : kind === "other-install" ? { ...f.spec, expectedInstallation: { ...f.spec.expectedInstallation, installationId: "other" } }
      : kind === "command" ? { ...f.spec, command: { ...f.spec.command, args: ["add", "-g", "omo-ai"] } }
      : { ...f.spec, mutationResources: [] };
    // When / Then
    expect(await executeOmoUpdate(forged, executor)).toEqual(rejected);
    expect(executor.commands).toHaveLength(0);
  },
);
test("rechecks target expiry after asynchronous official linking and before callback", async () => {
  // Given
  const f = await setup(), executor = capture();
  let clockReads = 0;
  // When: the checked target expires at the final clock boundary.
  const result = await executeOmoUpdate(f.spec, { ...executor, now: () => {
    clockReads++;
    if (clockReads === 3) return f.input.qualification.target.expiresAt;
    return now;
  } });
  // Then
  expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
  expect(executor.commands).toHaveLength(0);
});
test("keeps producer inputs detached while retaining postinstall", async () => {
  // Given
  const f = await setup(), executor = capture();
  const copy = structuredClone(f.input);
  const context = value(await qualifyOmoUpdate(copy, now));
  Object.assign(copy.qualification.env, { BUN_INSTALL: f.root });
  // When
  const spec = value(createOmoUpdateSpec(context, "update-only", now));
  await executeOmoUpdate(spec, executor);
  // Then
  expect(executor.commands[0]?.env["BUN_INSTALL"]).toBe(f.prefix);
  const manifest = JSON.parse(await readFile(join(f.wrapper, "package.json"), "utf8"));
  expect(manifest.scripts.postinstall).toBe("node bin/senpi-patch.mjs");
});

test("does not serialize private executor values", async () => {
  // Given
  const f = await setup(), executor = capture();
  // When
  await executeOmoUpdate(f.spec, executor);
  // Then
  expect(executor.commands.map(command => JSON.parse(JSON.stringify(command)))).toEqual([{ kind: "private-update-command" }]);
});

test("blocks unavailable registry targets instead of the actual official floating fallback", async () => {
  // Given: execute the acquired official flow with an unavailable registry.
  const f = await setup();
  const original = await rawOfficialRegistryFailure(f.prefix);
  // When: the private producer cannot qualify an exact checked target.
  const input = await f.authorize({ ...f.input.qualification,
    target: { ...f.input.qualification.target, version: "" } });
  // Then: upstream chooses a floating package, but our boundary cannot dispatch it.
  expect(original.commands[0]?.args).toEqual(["add", "-g", "omo-ai"]);
  expect(await qualifyOmoUpdate(input, now)).toEqual(rejected);
});

test("blocks manager replacement at the final handoff boundary", async () => {
  // Given
  const f = await setup(), executor = capture();
  let clockReads = 0;
  // When: a deterministic final-boundary event replaces bytes, without a timing race.
  const result = await executeOmoUpdate(f.spec, { ...executor, now: () => {
    if (++clockReads === 3) writeFileSync(f.manager, "#!/bin/sh\nexit 98\n");
    return now;
  } });
  // Then
  expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
  expect(executor.commands).toHaveLength(0);
});
test("does not let spec mutation during linking change the captured command", async () => {
  // Given
  const f = await setup(), executor = capture();
  // When: mutate the caller-owned object after execute has taken its snapshot.
  const pending = executeOmoUpdate(f.spec, executor);
  Object.assign(f.spec.command, { cwd: f.root, args: ["add", "-g", "omo-ai"] });
  await pending;
  // Then
  expect<string | undefined>(executor.commands[0]?.cwd).toBe(f.wrapper);
  expect(executor.commands[0]?.args.slice(0, 3)).toEqual(["add", "-g", "omo-ai@5.1.10"]);
});
test("contains non-Error failures from the private caller boundary", async () => {
  // Given
  const f = await setup(), executor = capture();
  // When
  const result = await executeOmoUpdate(f.spec, { ...executor, now: () => { throw "PRIVATE_SENTINEL"; } });
  // Then
  expect(result).toEqual(rejected);
  expect(executor.commands).toHaveLength(0);
});

test("r2 F1 rejects a target with no qualified immutable payload", async () => {
  const f = await setup();
  const q = JSON.parse(JSON.stringify(f.input.qualification));
  delete q.target.artifacts;
  expect(await qualifyOmoUpdate(await f.authorize(q), now)).toEqual(rejected);
});
test.each([".npmrc", ".bunfig.toml"])("r2 F2 rejects changed HOME config %s", async name => {
  const f = await setup(), executor = capture();
  await writeFile(join(f.home, name), "registry=https://attacker.invalid\n");
  expect(await executeOmoUpdate(f.spec, executor)).toEqual(rejected);
  expect(executor.commands).toHaveLength(0);
});
test("r2 F3 rejects cross-mode replay of an issued operation", async () => {
  const f = await setup(), executor = capture();
  expect(await executeOmoUpdate({ ...f.spec, mode: "update-and-restart" }, executor)).toEqual(rejected);
  expect(executor.commands).toHaveLength(0);
});
test("r2 F4 rejects metadata-only success as uncertain effects", async () => {
  const f = await setup();
  const result = await executeOmoUpdate(f.spec, { now: () => now, run: async () => {
    const path = join(f.wrapper, "package.json");
    const body = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...body, version: "5.1.10" }));
    return { status: 0, signal: null };
  } });
  expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
});
test("r2 F4 classifies malformed post-effect metadata as uncertain effects", async () => {
  const f = await setup();
  const result = await executeOmoUpdate(f.spec, { now: () => now, run: async () => {
    await writeFile(join(f.wrapper, "package.json"), "{");
    return { status: 0, signal: null };
  } });
  expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
});
test("r2 F5 never accepts signal plus status zero", async () => {
  const f = await setup();
  const result = await executeOmoUpdate(f.spec, { now: () => now,
    run: async () => ({ status: 0, signal: "SIGTERM" }) });
  expect(result.ok).toBe(false);
});
test("r2 binds HTTP payload bytes and rejects every unqualified package", async () => {
  const f = await setup();
  let origin = "";
  const result = await executeOmoUpdate(f.spec, { now: () => now, run: async command => {
    origin = command.args[4] ?? "";
    for (const artifact of f.input.qualification.target.artifacts) {
      const response = await fetch(`${origin}/${encodeURIComponent(artifact.name)}`, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(200);
      const packument = record(await response.json());
      const dist = record(record(record(packument["versions"])[artifact.version])["dist"]);
      const tarball = dist["tarball"];
      if (typeof tarball !== "string") throw new TypeError("invalid_tarball_url");
      const bytes = new Uint8Array(await (await fetch(tarball, { signal: AbortSignal.timeout(2000) })).arrayBuffer());
      expect<unknown>(`sha512-${createHash("sha512").update(bytes).digest("base64")}`).toBe(dist["integrity"]);
      expect(Buffer.from(bytes)).toEqual(await readFile(artifact.archive.path));
    }
    expect((await fetch(`${origin}/unqualified-package`, { signal: AbortSignal.timeout(2000) })).status).toBe(404);
    return { status: 29, signal: null };
  } });
  expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
  await expect(fetch(`${origin}/omo-ai`, { signal: AbortSignal.timeout(2000) })).rejects.toBeDefined();
});
test("r2 observes complete installed bytes without claiming a durable receipt", async () => {
  const f = await setup();
  const events: string[] = [];
  const result = await executeOmoUpdate(f.spec, { now: () => now, event: async event => { events.push(event.kind); },
    run: async command => {
      // Deliberate fixture materialization, not an official manager/install claim.
      for (const [path, bytes] of f.targetFiles) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }
      const artifact = f.input.qualification.target.artifacts[0];
      if (!artifact) throw new TypeError("missing_artifact");
      await writeFile(join(f.prefix, "install/global/bun.lock"), JSON.stringify({
        lockfileVersion: 1, registry: command.args[4], artifact: `${command.args[4]}/tarballs/${artifact.archive.sha256}.tgz`,
}));
      return { status: 0, signal: null };
    } });
  expect(result).toEqual({ ok: true, value: { kind: "files-verified", durableReceipt: false, intent: value(getOmoUpdateIntent(f.spec)) } });
  expect(events).toEqual(["intent", "dispatch", "exit"]);
  const lock = JSON.parse(await readFile(join(f.prefix, "install/global/bun.lock"), "utf8"));
  expect(lock.registry).toBe("https://registry.npmjs.org");
  expect(lock.artifact).toBe("https://registry.npmjs.org/omo-ai/-/fixture-5.1.10.tgz");
});
test.each(["http://127.0.0.1:43210/tarballs/old.tgz", "https://registry.npmjs.org/old/-/old-1.0.0.tgz",
  "file:///old/overlay.tgz", "https://attacker.invalid/bypass.tgz"])("lock-contract discards pinned %s only after durable dispatch", async source => {
  const f = await setup(), path = join(f.prefix, "install/global/bun.lock");
  const body = JSON.stringify({ lockfileVersion: 1, packages: { old: ["old@1.0.0", source, {}, "sha512-old"] } });
  await writeFile(path, body);
  const resources = f.input.qualification.installation.resources.map(row => row.realpath === path
    ? { ...row, fingerprint: `sha256:${digest(body)}` } : row);
  const input = await f.authorize({ ...f.input.qualification, installation: {
    ...f.input.qualification.installation, resources, resourcesFingerprint: `sha256:${digest(JSON.stringify(resources))}` } });
  const context = value(await qualifyOmoUpdate(input, now));
  expect(await readFile(path, "utf8")).toBe(body);
  const spec = value(createOmoUpdateSpec(context, "update-only", now));
  const events: string[] = [];
  const result = await executeOmoUpdate(spec, { now: () => now,
    event: async event => {
      events.push(event.kind);
      if (event.kind === "intent" || event.kind === "dispatch") expect(await readFile(path, "utf8")).toBe(body);
    },
    run: async command => {
      expect(events).toEqual(["intent", "dispatch"]);
      const seeded = JSON.parse(await readFile(path, "utf8"));
      expect(seeded.lockfileVersion).toBe(1);
      expect(command.args).toContain("--frozen-lockfile");
      expect(seeded.workspaces[""].dependencies["omo-ai"]).toBe("5.1.10");
      expect(seeded.packages.old).toBeUndefined();
      expect(Object.keys(seeded.packages)).toEqual([...input.qualification.target.artifacts]
        .sort((a, b) => a.installName.localeCompare(b.installName)).map(artifact => artifact.installName.replaceAll("/node_modules/", "/")));
      for (const artifact of input.qualification.target.artifacts) {
        const row = seeded.packages[artifact.installName.replaceAll("/node_modules/", "/")];
        expect(row[0]).toBe(`${artifact.name}@${artifact.version}`);
        expect(row[1]).toBe(`${command.args[4]}/tarballs/${artifact.archive.sha256}.tgz`);
        expect(row[3]).toBe(`sha512-${createHash("sha512").update(await readFile(artifact.archive.path)).digest("base64")}`);
      }
      await materialize(f);
      await writeFile(path, '{"lockfileVersion":1,"packages":{}}');
      return { status: 0, signal: null };
    } });
  expect(result.ok).toBe(true);
});
test.each(["operationId", "mode", "installationId", "targetFingerprint", "provenanceDigest", "managerDigest"] as const)(
  "r2 binds requested identity %s without trusting candidate fields", async field => {
    const f = await setup(), intent = value(getOmoUpdateIntent(f.spec));
    // A caller may choose a new operation id, but it cannot rewrite an issued operation.
    if (field === "operationId") {
      const executor = capture();
      await executeOmoUpdate(f.spec, executor);
      expect(await executeOmoUpdate(f.spec, executor)).toEqual(rejected);
      expect(executor.commands).toHaveLength(1);
    } else if (field === "mode") {
      Object.assign(f.spec, { mode: "update-and-restart" });
      expect(await executeOmoUpdate(f.spec, capture())).toEqual(rejected);
    } else expect(createOmoUpdateSpec(f.context, { ...intent, [field]: "forged" }, now)).toEqual(rejected);
  },
);
test.each(["manager", "config", "throw"] as const)("r2 classifies post-handoff %s uncertainty", async kind => {
  const f = await setup();
  const result = await executeOmoUpdate(f.spec, { now: () => now, run: async () => {
    if (kind === "manager") await writeFile(f.manager, "changed");
    if (kind === "config") await writeFile(join(f.home, ".npmrc"), "registry=https://attacker.invalid");
    if (kind === "throw") throw { secret: "PRIVATE_SENTINEL" };
    return { status: 29, signal: null };
  } });
  expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
});
test("r2 revalidates after durable dispatch hook yields", async () => {
  const f = await setup(), executor = capture();
  const result = await executeOmoUpdate(f.spec, { ...executor, event: async event => {
    if (event.kind === "dispatch") await writeFile(join(f.wrapper, "bunfig.toml"), "[install]\nignoreScripts=true");
  } });
  expect(result.ok).toBe(false);
  expect(executor.commands).toHaveLength(0);
});
test("r2 disallows simultaneous execution of one issued spec", async () => {
  const f = await setup(), executor = capture();
  const pending = executeOmoUpdate(f.spec, executor);
  expect(await executeOmoUpdate(f.spec, executor)).toEqual(rejected);
  await pending;
  expect(executor.commands).toHaveLength(1);
});
test("r2 F1 rejects repinned bytes that violate the independently pinned SRI", async () => {
  const f = await setup();
  const first = f.input.qualification.target.artifacts[0];
  if (!first) throw new TypeError("missing_artifact");
  const entries = await new Bun.Archive(await readFile(first.archive.path)).files();
  const replacement: Record<string, Blob | string> = Object.fromEntries(entries);
  replacement["package/dist/payload.js"] = "changed-immutable-payload";
  const bytes = await new Bun.Archive(replacement, { compress: "gzip" }).bytes();
  await writeFile(first.archive.path, bytes);
  const modified = { ...first, archive: { ...first.archive, sha256: createHash("sha256").update(bytes).digest("hex") } };
  const input = await f.authorize({ ...f.input.qualification,
    target: { ...f.input.qualification.target, artifacts: [modified, ...f.input.qualification.target.artifacts.slice(1)] } });
  expect(await qualifyOmoUpdate(input, now)).toEqual(rejected);
});
test("r2 F5 rejects signal zero even when every postcondition matches", async () => {
  const f = await setup();
  const result = await executeOmoUpdate(f.spec, { now: () => now, run: async () => {
    for (const [path, bytes] of f.targetFiles) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    return { status: 0, signal: "SIGTERM" };
  } });
  expect(result).toEqual({ ok: false, error: { code: "update_failed" } });
});
test("r2 forbids issuing a spec from a copied private qualification", async () => {
  const f = await setup();
  expect(createOmoUpdateSpec({ ...f.context }, "update-only", now)).toEqual(rejected);
});
test("r2 refuses a checksum-valid archive with the wrong package identity before issuing authority", async () => {
  const f = await setup(), q = f.input.qualification, first = q.target.artifacts[0];
  if (!first) throw new TypeError("missing_artifact");
  const bytes = await new Bun.Archive({ "package/package.json": '{"name":"other","version":"5.1.10"}' }).bytes();
  await writeFile(first.archive.path, bytes);
  const metadata = JSON.parse(await readFile(first.metadata.path, "utf8"));
  metadata.dist.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const body = JSON.stringify(metadata);
  await writeFile(first.metadata.path, body);
  const artifact = { ...first, archive: { ...first.archive, sha256: createHash("sha256").update(bytes).digest("hex") },
    metadata: { ...first.metadata, sha256: createHash("sha256").update(body).digest("hex") } };
  const input = await f.authorize({ ...q, target: { ...q.target, artifacts: [artifact, ...q.target.artifacts.slice(1)] } });
  expect(await qualifyOmoUpdate(input, now)).toEqual(rejected);
});
test("r2 distinguishes a byte-verified no-op from dispatched execution", async () => {
  const f = await fixture("5.1.9"), executor = capture();
  fixtures.push(f);
  const result = await executeOmoUpdate(f.spec, executor);
  expect(result).toEqual({ ok: true, value: {
    kind: "already-current", intent: value(getOmoUpdateIntent(f.spec)), durableReceipt: false,
  } });
  expect(executor.commands).toHaveLength(0);
});

test.each(["home", "global", "global-manifest", "lock", "payload", "metadata", "manager", "receipt", "expiry"] as const)(
  "r3 rejects %s changes while the exit hook is suspended", async kind => {
    // Given: a valid target and an exact event barrier, registered before execution.
    const f = await setup();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let observedNow = now, runs = 0, exits = 0;
    const execution = executeOmoUpdate(f.spec, {
      now: () => observedNow,
      run: async () => {
        runs++;
        for (const [path, bytes] of f.targetFiles) {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, bytes);
        }
        return { status: 0, signal: null };
      },
      event: async event => {
        if (event.kind === "exit") { exits++; entered.resolve(); await bounded(release.promise); }
      },
    });
    await bounded(Promise.race([entered.promise, execution.then(() => { throw new TypeError("exit_hook_not_observed"); })]));
    // When: mutate one independently checked input during the observable await.
    try {
      switch (kind) {
        case "home": await writeFile(join(f.home, ".npmrc"), "registry=https://attacker.invalid"); break;
        case "global": await writeFile(join(f.prefix, "install/global/.npmrc"), "registry=https://attacker.invalid"); break;
        case "global-manifest": await writeFile(join(f.prefix, "install/global/package.json"),
          '{"dependencies":{"omo-ai":"5.1.10"},"overrides":{"omo-ai":"5.1.9"}}'); break;
        case "lock": await writeFile(join(f.prefix, "install/global/bun.lock"),
          '{"lockfileVersion":1,"registry":"https://attacker.invalid"}'); break;
        case "payload":
        case "metadata": {
          const artifact = f.input.qualification.target.artifacts[0];
          if (!artifact) throw new TypeError("missing_artifact");
          await writeFile(kind === "payload" ? artifact.archive.path : artifact.metadata.path, "changed");
          break;
        }
        case "manager": await writeFile(f.manager, "changed"); break;
        case "receipt": await writeFile(f.input.receipt.path, "{}"); break;
        case "expiry": observedNow = f.input.qualification.target.expiresAt; break;
      }
    } finally { release.resolve(); }
    // Then: effects were handed off, so neither success nor a pre-effect rejection is valid.
    expect(await bounded(execution)).toEqual({ ok: false, error: { code: "recovery_required" } });
    expect({ runs, exits }).toEqual({ runs: 1, exits: 1 });
  },
);
