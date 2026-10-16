import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "../../.omo/evidence/herdr-cli-updater/task-11/fixture";
import { writeFile } from "node:fs/promises";
import { createPiAdapter } from "../../src/adapters/pi";
import { upstreamPiFixture } from "../fixtures/pi-package";
import { fixture as originalSenpiFixture } from "../../.omo/evidence/herdr-cli-updater/task-11/fixture";
import { rm } from "node:fs/promises";
import type { FailureCode } from "../../src/protocol";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function senpiFixture() { const f = await originalSenpiFixture(); roots.push(f.root); return f; }

const configuration = (f: Awaited<ReturnType<typeof upstreamPiFixture>>) => ({ provenance: [], engineManifest: f.manifest,
  checkOnly: f.source.installation, qualification: () => null, runtime: () => null, core: () => null, update: () => null,
  release: async () => ({ name: f.state.name, version: f.state.latest, "dist-tags": { latest: f.state.latest } }) });
const failure = (code: FailureCode) => ({ ok: false as const, error: { code } });
test("never separately updates an OmO-owned engine", async () => {
  // Given: the actual discovery compound owner route, not a standalone-looking basename.
  const f = await senpiFixture();
  const wrapper = join(f.root, "bin", "omo");
  const wrapperManifest = join(f.root, "wrapper.json");
  await writeFile(wrapper, `#!${process.execPath}\nthrow new Error("wrapper must not execute");\n`);
  const { chmod } = await import("node:fs/promises");
  await chmod(wrapper, 0o700);
  await writeFile(wrapperManifest, JSON.stringify({ name: "omo-ai", version: "5.1.9", bin: { omo: "bin/omo" },
    dependencies: { "@code-yeongyu/senpi": "2026.10.1-3" } }));
  f.receipt.family = "omo"; f.receipt.executable = wrapper; f.receipt.packageManifest = wrapperManifest;
  f.receipt.owner = { kind: "wrapper", packageName: "omo-ai", prefix: f.root, engineResourceId: `resource:${hash(f.manifest)}` };
  f.receipt.resources.push({ path: wrapper, sha256: hash(await readFile(wrapper)) },
    { path: wrapperManifest, sha256: hash(await readFile(wrapperManifest)) });
  await f.repin();
  // When: pi resolves to compound OmO ownership.
  const detected = await createPiAdapter(f.config).detect(join(f.root, "pi"));
  // Then: engine updater never receives a spec.
  expect(detected.ok).toBe(true);
  if (!detected.ok) throw new TypeError(detected.error.code);
  expect(detected.value.family).toBe("omo");
  expect(f.adapter.updateSpec(detected.value, "update-and-restart")).toEqual(failure("unsupported"));
});
test("runs shipped source parser in isolated fixture without operating CLI startup", async () => {
  // Given: the pinned actual parser body; no environment/profile imports.
  const f = await senpiFixture();
  // When: direct shell-free argv observes parser machine fields.
  const child = Bun.spawn([f.executable, "--session", f.sessionPath, "--model", "vendor/model", "--thinking", "max"],
    { cwd: f.root, env: {}, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then: semantic fields, not a successful exit alone.
  expect({ exit, stderr, parsed: JSON.parse(stdout) }).toMatchObject({ exit: 0, stderr: "", parsed: {
    session: f.sessionPath, model: "vendor/model", thinking: "max", messages: [], fileArgs: [], unknownFlags: {}, diagnostics: [] } });
});
test("observes misleading zero exit retaining unknown session selector in actual parser", async () => {
  // Given: parser treats equals syntax as unknown, unlike exact --session.
  const f = await senpiFixture();
  // When: exact external parser function executes in a task-owned binary.
  const child = Bun.spawn([f.executable, `--session=${f.sessionPath}`, "--latest"],
    { cwd: f.root, env: {}, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  // Then: no exact session identity, despite exit zero.
  expect({ exit, parsed: JSON.parse(stdout) }).toMatchObject({ exit: 0, parsed: {
    unknownFlags: { session: f.sessionPath, latest: true } } });
  expect(JSON.parse(stdout).session).toBeUndefined();
});

test.each(["1.2.0", "1.1.0", "1.0.0"])("checks upstream semver %s without launching the package", async version => {
  const f = await upstreamPiFixture();
  try {
    f.state.latest = version;
    const adapter = createPiAdapter(configuration(f));
    const checked = await adapter.check(f.source.installation);
    expect(checked).toMatchObject(version === "1.0.0" ? { ok: false, error: { code: "verification_failed" } }
      : { ok: true, value: { kind: version === "1.2.0" ? "update-available" : "up-to-date", installedVersion: "1.1.0" } });
    expect(adapter.updateSpec(f.source.installation, "update-only").ok).toBe(false);
  } finally { await f.cleanup(); }
});
test.each(["name", "version", "tag"])("rejects misleading upstream release %s", async part => {
  const f = await upstreamPiFixture();
  try {
    const adapter = createPiAdapter({ ...configuration(f), release: async () => ({
      name: part === "name" ? "@code-yeongyu/senpi" : f.state.name,
      version: part === "version" ? "help output" : "1.2.0", "dist-tags": { latest: part === "tag" ? "1.1.0" : "1.2.0" } }) });
    expect(await adapter.check(f.source.installation)).toEqual({ ok: false, error: { code: "verification_failed" } });
  } finally { await f.cleanup(); }
});
test("rejects stale upstream bytes after the release await", async () => {
  const f = await upstreamPiFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    const adapter = createPiAdapter({ ...configuration(f), release: async () => {
      entered.resolve(); await release.promise;
      return { name: f.state.name, version: "1.2.0", "dist-tags": { latest: "1.2.0" } };
    } });
    const pending = adapter.check(f.source.installation); await entered.promise;
    await writeFile(f.executable, "changed"); release.resolve();
    expect(await pending).toEqual({ ok: false, error: { code: "stale_selection" } });
  } finally { release.resolve(); await f.cleanup(); }
});
test("retains standalone Senpi bytes but rejects its historical Pi authority", async () => {
  const f = await senpiFixture();
  try {
    expect((await f.adapter.detect(f.executable)).ok).toBe(false);
    expect((await f.adapter.check(f.installation)).ok).toBe(false);
    expect(f.adapter.exactResume(f.runtime)).toEqual({ ok: false, error: { code: "unsupported" } });
    expect(f.adapter.bridge(f.runtime).ok).toBe(false);
    expect(f.adapter.gracefulExit(f.runtime, "operation:1", "owner:1").ok).toBe(false);
    expect(f.adapter.updateSpec(f.installation, "update-only").ok).toBe(false);
  } finally { await rm(f.root, { recursive: true }); }
});
