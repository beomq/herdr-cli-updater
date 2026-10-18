import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { createClaudeAdapter } from "../../../../src/adapters/claude";
import type {
  ClaudeCommandEvidence, ClaudeCoreAttestation, ClaudeDependencies, ClaudeSavedSession,
} from "../../../../src/adapters/claude";
import type { InstallationIdentity, RuntimeIdentity } from "../../../../src/adapters/types";
import type { InstallationOwner } from "../../../../src/protocol";
import { acceptsFixture, fixtureTarget, fixtureUpdate } from "./parser";

export const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const parserPath = join(import.meta.dir, "parser.ts");
export async function fixture(manager: "native" | "npm" | "bun" | "homebrew" = "native",
  versionOutput = "2.1.287 (Claude Code)\n", factory: typeof createClaudeAdapter = createClaudeAdapter) {
  const canonical = await realpath(await mkdtemp(join(tmpdir(), "task12-claude-")));
  const root = `/${canonical.slice(1)}` as const;
  await mkdir(join(root, "bin"));
  const executable = `/${join(root, "bin", "claude").slice(1)}` as const;
  const managerExecutable = `/${join(root, "bin", "manager").slice(1)}` as const;
  // Executes only --version; never calls the update/resume branch.
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--version") process.exit(91);
process.stdout.write(${JSON.stringify(versionOutput)});
`);
  await chmod(executable, 0o700);
  await writeFile(managerExecutable, `#!${process.execPath}\nprocess.exit(92);\n`);
  await chmod(managerExecutable, 0o700);
  const packageName = manager === "homebrew" ? "claude-code" : "@anthropic-ai/claude-code";
  const owner: InstallationOwner = manager === "native"
    ? { kind: "native", prefix: root, installerDigest: `sha256:${hash("fixture-installer")}` }
    : { kind: "package", manager, prefix: root, packageName };
  const manifest = join(root, "package.json");
  if (manager !== "native")
    await writeFile(manifest, JSON.stringify({ name: packageName, version: "2.1.287", bin: "bin/claude" }));
  const ownershipPath = join(root, "ownership.json");
  const ownership = {
    family: "claude", executable, channel: "latest", owner,
    packageManifest: manager === "native" ? null : manifest,
    resources: [
      { path: executable, sha256: hash(await readFile(executable)) },
      ...(manager === "native" ? [] : [{ path: manifest, sha256: hash(await readFile(manifest)) }]),
    ],
  };
  const repin = async () => {
    const body = JSON.stringify(ownership);
    await writeFile(ownershipPath, body);
    return { path: ownershipPath, sha256: hash(body) };
  };
  let provenance = [await repin()];
  const parser = { path: parserPath, sha256: hash(await readFile(parserPath)) };
  const source = join(root, "release.json");
  await writeFile(source, JSON.stringify({ channel: "latest", version: "2.1.288" }));
  const sourcePin = { path: source, sha256: hash(await readFile(source)) };
  const storage = join(root, "opaque-saved-record.json");
  const options = ["--model", "sonnet", "--permission-mode", "default"];
  const fullId = "00000000-0000-4000-8000-000000000001";
  await writeFile(storage, JSON.stringify({ fullId, cwd: root, startupOptions: options }));
  const storagePin = { path: storage, sha256: hash(await readFile(storage)) };
  let installation: InstallationIdentity | null = null;
  let session: ClaudeSavedSession | null = null;
  let core: ClaudeCoreAttestation | null = null;
  let updateOverride: ClaudeCommandEvidence | null | undefined;
  const evidence = (current: InstallationIdentity, resume = false): ClaudeCommandEvidence => {
    const spec = resume
      ? { executable, args: ["--resume", fullId, ...options], cwd: root }
      : { executable: manager === "native" ? executable : managerExecutable,
          args: fixtureUpdate(current, manager), cwd: root };
    if (!spec.executable.startsWith("/") || !spec.cwd.startsWith("/")) throw new TypeError("fixture path");
    const command = {
      executable: `/${spec.executable.slice(1)}` as const, args: spec.args, cwd: `/${spec.cwd.slice(1)}` as const,
    };
    return {
      installation: structuredClone(current), command,
      executable: { path: command.executable, sha256: hash(readFileSync(command.executable)) },
      parser,
      target: resume ? null : fixtureTarget, privateContext: "not-required",
      accepts: (source, candidate, selected, target) => hash(source) === parser.sha256
        && acceptsFixture(candidate, selected, manager, target),
    };
  };
  const deps: ClaudeDependencies = {
    cwd: `/${root.slice(1)}`, provenance: () => provenance, probeExecutables: [executable],
    update: current => updateOverride === undefined ? evidence(current) : updateOverride,
    session: runtime => runtime.runtimeId === "runtime-claude" ? session : null,
    release: current => installation && isDeepStrictEqual(current, installation) ? {
      installation: structuredClone(installation), source: sourcePin,
      version: (body, channel) => {
        const row: unknown = JSON.parse(body);
        return typeof row === "object" && row !== null && "channel" in row && row.channel === channel
          && "version" in row && typeof row.version === "string" ? row.version : null;
      },
    } : null,
    core: runtime => runtime.runtimeId === "runtime-claude" ? core : null,
  };
  const adapter = factory(deps);
  const detected = await adapter.detect(executable);
  if (!detected.ok) throw new TypeError(detected.error.code);
  installation = detected.value;
  const runtime: RuntimeIdentity = {
    runtimeId: "runtime-claude", installationId: installation.installationId,
    runningVersion: { kind: "known", version: "2.1.287" },
    binding: {
      socketId: "socket", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
      rootIncarnation: { pid: 123, startIdentity: "start", executableRealpath: executable },
      session: { kind: "conversation", fullId, storagePathHash: hash(storage) },
      cwd: root, optionsRef: "options-private", turnGeneration: 3,
      resourcesFingerprint: installation.resourcesFingerprint,
    },
  };
  session = {
    binding: structuredClone(runtime.binding), installation: structuredClone(installation),
    storage: storagePin, startupOptions: options, selector: evidence(installation, true),
    inspect: body => {
      const row: unknown = JSON.parse(body);
      if (typeof row !== "object" || row === null || !("fullId" in row) || typeof row.fullId !== "string"
        || !("cwd" in row) || typeof row.cwd !== "string" || !("startupOptions" in row)
        || !Array.isArray(row.startupOptions) || !row.startupOptions.every((value: unknown) => typeof value === "string"))
        return null;
      return { fullId: row.fullId, cwd: row.cwd, startupOptions: row.startupOptions };
    },
  };
  core = {
    kind: "core-attestation", binding: structuredClone(runtime.binding), evidenceRef: "fixture-core-only",
    workGeneration: 3, allWorkDrained: true, inputFenced: true,
    operationId: "stop-1", ownerTokenRef: "owner-private",
  };
  return {
    root, adapter, deps, executable, manifest, ownership, ownershipPath, installation, runtime,
    source, storage, managerExecutable, parser, evidence,
    get session() { return session; },
    set session(value: ClaudeSavedSession | null) { session = value; },
    get core() { return core; },
    set core(value: ClaudeCoreAttestation | null) { core = value; },
    setUpdate(value: ClaudeCommandEvidence | null) { updateOverride = value; },
    async repin() { provenance = [await repin()]; },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
      try { await lstat(root); return false; } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
        throw error;
      }
    },
  };
}
