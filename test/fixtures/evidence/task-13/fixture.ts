import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "../../../../src/adapters/codex";
import type { RuntimeIdentity } from "../../../../src/adapters/types";
import type { InstallationOwner } from "../../../../src/protocol";

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const threadId = "0199ad22-1388-7a11-8baa-111111111111";
function isAbsolute(value: string): value is `/${string}` {
  return value.startsWith("/");
}
function absolute(value: string): `/${string}` {
  if (!isAbsolute(value)) throw new TypeError("fixture_absolute_path");
  return value;
}
// Fixtures are created only at runtime in unique roots and removed by their owner.
// No manager/update/resume command is ever invoked.
export async function fixture(managerName: "npm" | "bun" = "npm", executablePadding = 0) {
  const root = absolute(realpathSync(mkdtempSync(join(tmpdir(), "task13-codex-"))));
  const executable = absolute(join(root, "bin", "not-a-codex-basename"));
  const manifest = join(root, "package.json");
  const receiptPath = join(root, "owner.json");
  const privatePath = join(root, "private.json");
  const preflightPath = join(root, "preflight.json");
  const managerPath = join(root, "manager.json");
  const releasePath = join(root, "releases.json");
  const sessionPath = join(root, "unrelated-rollout-filename.jsonl");
  const callsPath = join(root, "readonly-calls.jsonl");
  const effectPath = join(root, "MUTATION");
  mkdirSync(join(root, "bin"));
  const program = `#!${process.execPath}
import {appendFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({args,cwd:process.cwd()})+"\\n");
if(args.length===1 && args[0]==="--version") console.log("codex-cli 0.156.0");
else {writeFileSync(${JSON.stringify(effectPath)},"effect");process.exit(31);}
`;
  writeFileSync(executable, Buffer.concat([Buffer.from(program), Buffer.alloc(executablePadding, 32)]));
  chmodSync(executable, 0o700);
  writeFileSync(manifest, JSON.stringify({ name: "@openai/codex", version: "0.156.0", bin: { codex: "bin/not-a-codex-basename" } }));
  const owner: InstallationOwner = { kind: "package", manager: managerName, packageName: "@openai/codex", prefix: root };
  const receipt = {
    family: "codex", executable, channel: "stable/npm-latest", owner, packageManifest: manifest,
    resources: [
      { path: executable, sha256: digest(readFileSync(executable)) },
      { path: manifest, sha256: digest(readFileSync(manifest)) },
    ],
  };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const pin = { path: receiptPath, sha256: digest(readFileSync(receiptPath)) };
  // Manager path is explicitly configured and digest bound, not found through PATH.
  writeFileSync(managerPath, JSON.stringify({
    owner, channel: receipt.channel, executable, sha256: digest(readFileSync(executable)), cwd: root,
  }));
  writeFileSync(releasePath, JSON.stringify({
    github: { tag_name: "rust-v0.160.0", draft: false, prerelease: false },
    npm: { "dist-tags": { latest: "0.160.0" }, versions: {
      "0.160.0": { dist: { tarball: "https://registry.npmjs.org/@openai/codex/-/codex-0.160.0.tgz", integrity: "sha512-fixture" } },
    } },
  }));
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  const adapter = createCodexAdapter({
    probeCwd: root,
    provenance: () => [pin],
    privateRuntime: () => read(privatePath),
    preflight: () => read(preflightPath),
    manager: () => read(managerPath),
    releases: async () => read(releasePath),
    now: () => 123,
  });
  const found = await adapter.detect(executable);
  if (!found.ok) { rmSync(root, { recursive: true }); throw new TypeError(found.error.code); }
  const installation = found.value;
  const args = ["--model", "fixture-model", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--cd", root, "--no-alt-screen"];
  const runtime: RuntimeIdentity = {
    runtimeId: "fixture-runtime", installationId: installation.installationId,
    runningVersion: { kind: "unknown", reason: "not_captured" },
    binding: {
      socketId: "fixture-socket", socketEpoch: "epoch-1", paneId: "pane-1", paneGeneration: 2,
      rootIncarnation: { pid: 123, startIdentity: "start-1", executableRealpath: executable },
      session: { kind: "conversation", fullId: threadId, storagePathHash: `sha256:${digest(sessionPath)}` },
      cwd: root, optionsRef: "private-options", turnGeneration: 4, resourcesFingerprint: installation.resourcesFingerprint,
    },
  };
  const privateData = { sessionPath, optionsRef: runtime.binding.optionsRef, args };
  const preflight = {
    binding: runtime.binding, threadId, cwd: root, storagePathHash: runtime.binding.session.storagePathHash,
    optionsDigest: `sha256:${digest(JSON.stringify(args))}`,
  };
  const meta = { timestamp: "2026-10-02T00:00:00Z", type: "session_meta", payload: {
    id: threadId, cwd: root, timestamp: "2026-10-02T00:00:00Z", cli_version: "0.156.0",
    originator: "fixture", source: "cli", model_provider: "openai",
  } };
  writeFileSync(privatePath, JSON.stringify(privateData));
  writeFileSync(preflightPath, JSON.stringify(preflight));
  writeFileSync(sessionPath, JSON.stringify(meta) + "\n");
  return {
    root, executable, manifest, receiptPath, privatePath, preflightPath, managerPath, releasePath,
    sessionPath, callsPath, effectPath, adapter, installation, runtime, privateData, preflight, meta, pin,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      try { lstatSync(root); throw new TypeError("cleanup_failed"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    },
  };
}
