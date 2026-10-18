import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { discoverExecutable } from "../../../../src/discovery";
import { createPiAdapter } from "../../../../src/adapters/pi";
import type { PiConfiguration, PiCoreRecord, PiQualification, PiRuntimeRecord, PiUpdateRecord } from "../../../../src/adapters/pi";
import type { InstallationOwner, Runtime } from "../../../../src/protocol";

export const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
export const ownedRoot = dirname(import.meta.path);
const sourceRoot = resolve(ownedRoot, "../task-5/families/pi");
/** Mechanism fixtures only. Not a vendor attestation or genuine identity-eight proof. */
export async function fixture() {
  const sandbox = join(ownedRoot, "sandbox");
  await mkdir(sandbox, { recursive: true });
  const root = await realpath(await mkdtemp(join(sandbox, "pi-")));
  const executable = join(root, "bin", "engine");
  const manifest = join(root, "package.json");
  const sourcePath = join(root, "args.js");
  const sessionPath = join(root, "not-the-session-id.jsonl");
  const pinPath = join(root, "ownership.json");
  const managerPath = join(root, "bin", "manager");
  await mkdir(join(root, "bin"));
  const original = await readFile(join(sourceRoot, "boundedsource/dist/cli/args.js"), "utf8");
  if (hash(original) !== "406851f55deda5b54dcf09e3feea8e95df21d97f0e3e97b92a9d93e1433bfb75")
    throw new TypeError("source receipt drift");
  // Execute the unmodified shipped parser body and its pure local helpers.
  // External imports/help/startup are excluded. grokNeoEnabled:false bypasses
  // brand environment; provider rejection is deliberately unavailable here.
  const body = original.slice(original.indexOf("const SESSION_RUNTIMES"), original.indexOf("export function printHelp"));
  await writeFile(sourcePath, body);
  await writeFile(executable, `#!${process.execPath}
${body}
const argv=process.argv.slice(2);
if(argv[0]==="--version") console.log("senpi 2026.10.1-3");
else if(argv[0]==="--help") console.log(JSON.stringify({argv,cwd:process.cwd()}));
else {const parsed=parseArgs(argv,{grokNeoEnabled:false}); console.log(JSON.stringify({...parsed,unknownFlags:Object.fromEntries(parsed.unknownFlags)}));}
`);
  await chmod(executable, 0o700);
  await writeFile(managerPath, `#!${process.execPath}\nthrow new Error("manager must never execute");\n`);
  await chmod(managerPath, 0o700);
  await writeFile(manifest, JSON.stringify({ name: "@code-yeongyu/senpi", version: "2026.10.1-3",
    bin: { pi: "bin/engine", senpi: "bin/engine" } }));
  await symlink(executable, join(root, "pi"));
  await symlink(executable, join(root, "senpi"));
  const owner: InstallationOwner = { kind: "package", manager: "npm", prefix: root, packageName: "@code-yeongyu/senpi" };
  const receipt: { family: string; executable: string; channel: string; owner: InstallationOwner;
    packageManifest: string; resources: { path: string; sha256: string }[] } =
    { family: "pi", executable, channel: "latest", owner, packageManifest: manifest,
    resources: [{ path: executable, sha256: hash(await readFile(executable)) },
      { path: manifest, sha256: hash(await readFile(manifest)) },
      { path: sourcePath, sha256: hash(await readFile(sourcePath)) }] };
  const pin = async () => {
    const body = JSON.stringify(receipt);
    await writeFile(pinPath, body);
    return { path: pinPath, sha256: hash(body) };
  };
  let provenance = [await pin()];
  const found = await discoverExecutable({ executable, family: "pi", provenance });
  if (!found.ok) throw new TypeError(found.error.code);
  const installation = found.value.installation;
  const header = { type: "session", version: 3, id: "0199-full-session-identity", cwd: root };
  await writeFile(sessionPath, JSON.stringify(header) + "\n");
  const options = ["--model", "vendor/model", "--mode", "rpc", "--thinking", "max", "--tools", "read,bash"];
  const runtime: Runtime = { runtimeId: "runtime:fixture", installationId: installation.installationId,
    runningVersion: { kind: "unknown", reason: "not_captured" }, binding: {
      socketId: "socket:fixture", socketEpoch: "epoch:1", paneId: "pane:1", paneGeneration: 1,
      rootIncarnation: { pid: 999999, startIdentity: "fixture:incarnation", executableRealpath: executable },
      session: { kind: "conversation", fullId: header.id, storagePathHash: `sha256:${hash(sessionPath)}` },
      cwd: root, optionsRef: "private:options", turnGeneration: 4, resourcesFingerprint: installation.resourcesFingerprint } };
  const release = { name: "@code-yeongyu/senpi", version: "2026.10.1-4", "dist-tags": { latest: "2026.10.1-4" } };
  const state: {
    runtime: PiRuntimeRecord | null; core: PiCoreRecord | null; qualification: PiQualification | null;
    release: unknown; update: PiUpdateRecord | null;
  } = {
    runtime: { runtime: structuredClone(runtime), installation, sessionPath, optionsRef: runtime.binding.optionsRef,
      startupOptionsFingerprint: `sha256:${hash(JSON.stringify(options))}`, options },
    qualification: { publicationCommit: "a".repeat(40), tagCommit: "a".repeat(40), signatureVerified: true,
      sourcePins: [{ path: sourcePath, sha256: hash(await readFile(sourcePath)) }] },
    core: { expectedBinding: structuredClone(runtime.binding), evidenceRef: "fixture:core-only",
      workGeneration: 4, activeWork: { root: 0, tools: 0, subagents: 0, monitors: 0, continuations: 0 },
      admission: "fenced", claim: { operationId: "operation:1", ownerTokenRef: "owner:1" } },
    release, update: { manager: { path: managerPath, sha256: hash(await readFile(managerPath)) }, release,
      allConsumersKnown: true, consumerInstallationIds: [installation.installationId],
      resourcesFingerprint: installation.resourcesFingerprint },
  };
  const config: PiConfiguration = { get provenance() { return provenance; }, engineManifest: manifest,
    qualification: () => state.qualification, release: async () => state.release,
    runtime: id => id === runtime.runtimeId ? state.runtime : null,
    core: id => id === runtime.runtimeId ? state.core : null,
    update: id => id === installation.installationId ? state.update : null };
  return { root, executable, manifest, sourcePath, sessionPath, managerPath, pinPath, receipt, header,
    installation, runtime, state, config, adapter: createPiAdapter(config),
    repin: async () => { provenance = [await pin()]; } };
}
