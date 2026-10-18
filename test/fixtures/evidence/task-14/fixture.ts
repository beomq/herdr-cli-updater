import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgyAdapter, AGY_INSTALLER_SHA256, AGY_MANIFEST_CHANNEL } from "../../../../src/adapters/agy";
import type { AgyConfiguration } from "../../../../src/adapters/agy";
import type { ProvenancePin } from "../../../../src/discovery";
import type { InstallationIdentity, FamilyAdapter } from "../../../../src/adapters/types";
import type { InstallationOwner, Runtime } from "../../../../src/protocol";
import { artifactPath } from "../../artifacts";

export const sourceRoot = artifactPath("task-5/families/agy");
export const digest = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
// Mechanism-only files. NOT a claim about the proprietary native storage format.
export async function fixture(factory: (config: AgyConfiguration) => FamilyAdapter = createAgyAdapter) {
  const owned = join(import.meta.dir, "owned");
  await mkdir(owned, { recursive: true });
  const root = await realpath(await mkdtemp(join(owned, "agy-")));
  const executable = join(root, "native binary ; not-a-command");
  const sessionPath = join(root, "opaque-not-a-session-basename");
  const privatePath = join(root, "private.json");
  const bindingPath = join(root, "binding.json");
  const startupPath = join(root, "startup.json");
  const receiptPath = join(root, "owner.json");
  const manifestPath = join(root, "manifest.json");
  const program = (output: string, stderr = "") => `#!${process.execPath}
if (JSON.stringify(process.argv.slice(2)) !== '["--version"]') process.exit(71);
process.stdout.write(${JSON.stringify(output)});
process.stderr.write(${JSON.stringify(stderr)});
`;
  await writeFile(executable, program("1.2.12\n"));
  await chmod(executable, 0o700);
  const receipt: {
    family: string; executable: string; channel: string; owner: InstallationOwner;
    packageManifest: null; resources: { path: string; sha256: string }[];
  } = {
    family: "agy", executable, channel: AGY_MANIFEST_CHANNEL,
    owner: { kind: "native", installerDigest: `sha256:${AGY_INSTALLER_SHA256}`, prefix: root },
    packageManifest: null, resources: [{ path: executable, sha256: digest(await readFile(executable)) }],
  };
  let pins: readonly ProvenancePin[] = [];
  const repin = async () => {
    const body = JSON.stringify(receipt);
    await writeFile(receiptPath, body);
    pins = [{ path: receiptPath, sha256: digest(body) }];
  };
  await repin();
  const release = {
    version: "1.2.15",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.15-5434575321694208/darwin-arm/cli_mac_arm64.tar.gz",
    sha512: "a".repeat(128),
  };
  let manifestPin: ProvenancePin | null = null;
  const repinManifest = async () => {
    const body = JSON.stringify(release);
    await writeFile(manifestPath, body);
    manifestPin = { path: manifestPath, sha256: digest(body) };
  };
  await repinManifest();
  let installerPin: ProvenancePin | null = {
    path: join(sourceRoot, "boundedsource/install.sh"), sha256: AGY_INSTALLER_SHA256,
  };
  let clock = 123;
  const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  function object(value: unknown): value is { [key: string]: unknown } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function row(path: string): { [key: string]: unknown } {
    const value = json(path);
    if (!object(value)) throw new TypeError("fixture_record");
    return value;
  }
  const config: AgyConfiguration = {
    probeCwd: `/${root.slice(1)}`,
    provenance: () => pins,
    manifest: () => manifestPin,
    installer: () => installerPin,
    privateRuntime: () => existsSync(privatePath) ? json(privatePath) : null,
    preflight: () => {
      if (![sessionPath, startupPath, bindingPath].every(existsSync)) return null;
      const conversation = row(sessionPath);
      const startup = row(startupPath);
      const args = startup["args"];
      return {
        binding: json(bindingPath), storagePath: sessionPath,
        fullId: conversation["fullId"], cwd: conversation["cwd"],
        optionsRef: startup["optionsRef"], optionsSha256: digest(JSON.stringify(args)),
        storageSha256: digest(readFileSync(sessionPath)),
      };
    },
    now: () => clock,
  };
  const adapter = factory(config);
  async function installation(): Promise<InstallationIdentity> {
    const result = await adapter.detect(executable);
    if (!result.ok) throw new TypeError(result.error.code);
    return result.value;
  }
  async function runtime(installation: InstallationIdentity): Promise<Runtime> {
    const fullId = "11111111-1111-4111-8111-111111111111";
    const args: string[] = [];
    const cwd = root;
    const optionsRef = "private:startup";
    await writeFile(sessionPath, JSON.stringify({ fullId, cwd }));
    await writeFile(startupPath, JSON.stringify({ optionsRef, args }));
    const binding = {
      socketId: "socket", socketEpoch: "epoch", paneId: "pane", paneGeneration: 1,
      rootIncarnation: { pid: 700, startIdentity: "start", executableRealpath: executable },
      session: { kind: "conversation", fullId, storagePathHash: digest(sessionPath) },
      cwd, optionsRef, turnGeneration: 2, resourcesFingerprint: installation.resourcesFingerprint,
    } as const;
    await writeFile(bindingPath, JSON.stringify(binding));
    await writeFile(privatePath, JSON.stringify({
      storagePath: sessionPath, storageSha256: digest(await readFile(sessionPath)), fullId, cwd, optionsRef, args,
    }));
    return { runtimeId: "runtime", installationId: installation.installationId, binding,
      runningVersion: installation.installedVersion };
  }
  async function patch(path: string, values: { readonly [key: string]: unknown }) {
    await writeFile(path, JSON.stringify({ ...row(path), ...values }));
  }
  return {
    root, executable, receiptPath, sessionPath, privatePath, bindingPath, startupPath, manifestPath,
    adapter, config, receipt, release, repin, repinManifest, installation, runtime, patch, program,
    setPins: (value: readonly ProvenancePin[]) => { pins = value; },
    setManifest: (value: ProvenancePin | null) => { manifestPin = value; },
    setInstaller: (value: ProvenancePin | null) => { installerPin = value; },
    setClock: (value: number) => { clock = value; },
    cleanup: async () => {
      // This invocation owns exactly this private namespace, not its siblings.
      // Bounded adapter probes resolve only after their genuine child close.
      await rm(root, { recursive: true, force: true });
      try { await lstat(root); } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          return { rootRemoved: true, rootsEmpty: true, PIDs: 0 } as const;
        throw error;
      }
      throw new TypeError("owned_fixture_namespace_remains");
    },
  };
}
