import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGrokAdapter, GROK_PUBLIC_SOURCE_REF } from "../../../../src/adapters/grok";
import type { GrokConfiguration } from "../../../../src/adapters/grok";
import type { InstallationIdentity, RuntimeIdentity } from "../../../../src/adapters/types";
import { tmpdir } from "node:os";

export const hash = (body: Uint8Array | string): string => createHash("sha256").update(body).digest("hex");
export const PRIVATE_SENTINEL = "ULW_GROK_PRIVATE_R2_73bd91";
export async function fixture(factory = createGrokAdapter, owner: "native" | "npm" = "native", privateSentinel?: string) {
  // All files belong to this task; no installed CLI, session or credential read.
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-fixture-grok-")));
  const binary = join(root, "grok-native"), launcher = join(root, "grok-bootstrap.js");
  const manifest = join(root, "package.json"), cwd = join(root, privateSentinel ? `workspace-${privateSentinel}` : "workspace");
  const storageRoot = join(root, "saved"), storagePath = join(storageRoot, "opaque.session");
  const fullId = "12345678-1234-4234-8234-123456789abc";
  await mkdir(cwd); await mkdir(storageRoot);
  await writeFile(binary, "task-owned inert native bytes: never execute\n"); await chmod(binary, 0o700);
  await writeFile(launcher, "task-owned inert npm launcher: never execute\n");
  await writeFile(manifest, JSON.stringify({ name: "@xai-official/grok", version: "1.0.46", bin: { grok: "grok-bootstrap.js", agent: "grok-bootstrap.js" } }));
  const saved = { fullId, resolvedId: fullId, cwd, hasSavedState: true };
  await writeFile(storagePath, JSON.stringify(saved));
  const resources = await Promise.all([binary, ...(owner === "npm" ? [launcher, manifest] : [])].map(async path => ({
    resourceId: `resource:${hash(path)}`, realpath: path, fingerprint: `sha256:${hash(await readFile(path))}`,
  })));
  resources.sort((a, b) => a.realpath.localeCompare(b.realpath));
  const installation: InstallationIdentity = {
    installationId: `install:${hash(binary)}`, family: "grok", channel: "stable", executableRealpath: binary,
    owner: owner === "native" ? { kind: "native", installerDigest: `sha256:${hash("fixture-installer")}`, prefix: root }
      : { kind: "package", manager: "npm", packageName: "@xai-official/grok", prefix: root },
    installedVersion: { kind: "known", version: "1.0.46" }, resources,
    resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}`,
  };
  const runtime: RuntimeIdentity = {
    runtimeId: "owned-runtime", installationId: installation.installationId,
    runningVersion: { kind: "known", version: "1.0.46" },
    binding: { socketId: "leader-socket", socketEpoch: "epoch-1", paneId: "pane-1", paneGeneration: 4,
      rootIncarnation: { pid: 12345, startIdentity: "owned-incarnation", executableRealpath: binary },
      session: { kind: "conversation", fullId, storagePathHash: hash(storagePath) }, cwd, optionsRef: privateSentinel ?? "private-options",
      turnGeneration: 8, resourcesFingerprint: installation.resourcesFingerprint },
  };
  const state: {
    installation: InstallationIdentity | null; version: unknown; parser: unknown; release: unknown; stored: unknown; live: unknown;
  } = {
    installation,
    version: { version: "1.0.46", executableFingerprint: resources.find(r => r.realpath === binary)?.fingerprint, evidenceRef: "owned-version" },
    // Synthetic trusted receipts test the mechanism, NOT an official release mapping.
    parser: { sourceRef: GROK_PUBLIC_SOURCE_REF, version: "1.0.46",
      executableFingerprint: resources.find(r => r.realpath === binary)?.fingerprint, evidenceRef: "owned-parser" },
    release: { channel: "stable", version: "1.0.48", resourcesFingerprint: installation.resourcesFingerprint, evidenceRef: "owned-release" },
    stored: { storagePath, storageRoot, fullId, cwd, optionsRef: runtime.binding.optionsRef, args: [], storageSha256: hash(await readFile(storagePath)) },
    live: { runtime: structuredClone(runtime), optionsSha256: hash("[]"), storageSha256: hash(await readFile(storagePath)),
      displayIdle: true, allWork: false },
  };
  const config = {
    installation: path => [binary, launcher].includes(path) ? state.installation : null,
    versionReceipt: () => state.version, parserReceipt: () => state.parser, release: () => state.release,
    privateRuntime: () => structuredClone(state.stored), preflight: () => structuredClone(state.live),
    decodeSavedSession: (body: Uint8Array): unknown => JSON.parse(Buffer.from(body).toString()), now: () => 42,
  } satisfies GrokConfiguration;
  const adapter = factory(config);
  const alias = join(root, "agent"); await symlink(owner === "npm" ? launcher : binary, alias);
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true });
    try { await lstat(root); throw new Error("cleanup_root_remains"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  };
  return { root, binary, launcher, manifest, cwd, storageRoot, storagePath, saved, installation, runtime, state, config, adapter, alias, cleanup };
}
