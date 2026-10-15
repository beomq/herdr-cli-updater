import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

export const families = ["omo", "omp", "pi", "claude", "codex", "agy", "cursor", "grok"] as const;

export class ProvenanceError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ProvenanceError";
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProvenanceError(field, "expected object");
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProvenanceError(field, "required nonempty string");
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProvenanceError(field, "expected nonnegative integer");
  }
  return value;
}

function digest(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new ProvenanceError(field, "expected SHA256");
  return result;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new ProvenanceError(field, "expected string array");
  return value.map((item: unknown) => text(item, field));
}

function artifact(value: unknown, field: string) {
  const input = object(value, field);
  return { path: text(input["path"], `${field}.path`), sha256: digest(input["sha256"], `${field}.sha256`) };
}

export type IdentityQualification =
  | { readonly state: "unknown"; readonly reason: string }
  | { readonly state: "qualified"; readonly value: string; readonly evidence: { readonly path: string; readonly sha256: string } };

function identity(value: unknown, field: string): IdentityQualification {
  const input = object(value, field);
  switch (input["state"]) {
    case "unknown": return { state: "unknown", reason: text(input["reason"], `${field}.reason`) };
    case "qualified": return { state: "qualified", value: text(input["value"], `${field}.value`), evidence: artifact(input["evidence"], `${field}.evidence`) };
    default: throw new ProvenanceError(field, "expected explicit qualified/unknown identity state");
  }
}

export function parseRegistry(value: unknown) {
  const input = object(value, "registry");
  if (input["manifestVersion"] !== 1) throw new ProvenanceError("manifestVersion", "unsupported version");
  const core = object(input["core"], "core");
  const installed = object(input["installed"], "installed");
  const sourceRef = text(core["sourceRef"], "core.sourceRef");
  if (!/^[a-f0-9]{40}$/.test(sourceRef)) throw new ProvenanceError("core.sourceRef", "expected full immutable Git ref");
  const installers = input["installers"];
  if (!Array.isArray(installers) || installers.length !== families.length) {
    throw new ProvenanceError("installers", "exactly eight families required");
  }
  const seen = new Set<string>();
  const parsedInstallers = installers.map((value: unknown, index: number) => {
    const row = object(value, `installers[${index}]`);
    const family = text(row["family"], "installer.family");
    if (!families.some((item) => item === family) || seen.has(family)) {
      throw new ProvenanceError("installer.family", "unknown or duplicate family");
    }
    seen.add(family);
    return {
      family,
      owner: identity(row["owner"], `${family}.owner`),
      channel: identity(row["channel"], `${family}.channel`),
      sourceUrl: text(row["sourceUrl"], `${family}.sourceUrl`),
      source: artifact(row["source"], `${family}.source`),
      parser: artifact(row["parser"], `${family}.parser`),
    };
  });
  return {
    manifestVersion: 1,
    core: {
      sourceRef,
      sourceArchiveSha256: digest(core["sourceArchiveSha256"], "core.sourceArchiveSha256"),
      releaseTag: text(core["releaseTag"], "core.releaseTag"),
      version: text(core["version"], "core.version"),
      protocol: integer(core["protocol"], "core.protocol"),
      schemaVersion: integer(core["schemaVersion"], "core.schemaVersion"),
      toolchain: text(core["toolchain"], "core.toolchain"),
      binary: artifact(core["binary"], "core.binary"),
      schema: artifact(core["schema"], "core.schema"),
      buildReceipt: artifact(core["buildReceipt"], "core.buildReceipt"),
      releaseReceipt: artifact(core["releaseReceipt"], "core.releaseReceipt"),
    },
    installed: {
      version: text(installed["version"], "installed.version"),
      protocol: integer(installed["protocol"], "installed.protocol"),
      schemaVersion: integer(installed["schemaVersion"], "installed.schemaVersion"),
      binarySha256: digest(installed["binarySha256"], "installed.binarySha256"),
      schemaSha256: digest(installed["schemaSha256"], "installed.schemaSha256"),
    },
    installers: parsedInstallers,
  };
}

export type Registry = ReturnType<typeof parseRegistry>;
export type Action = { readonly argv: readonly string[]; readonly exitCode: number; readonly stdout: string; readonly stderr: string };

// This is a host trust boundary, NOT a JSON receipt field or a CLI flag.
// Task8 owns the producer and must observe these events independently of the registry.
export type ExecutionObservation = Action & {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executableSha256: string;
};

export type ProofBinding = {
  readonly coreSource: string;
  readonly sourceRef: string;
  readonly sourceArchiveSha256: string;
  readonly binarySha256: string;
  readonly releaseTag: string;
};

export type ObservedQualification = {
  readonly state: "observed";
  readonly producerId: string;
  readonly runId: string;
  readonly sourceRef: string;
  readonly sourceArchiveSha256: string;
  readonly build: {
    readonly inputMode: "immutable-archive-only";
    readonly extractedRoot: string;
    readonly archiveSha256: string;
    readonly archivePath: string;
    readonly binarySha256: string;
    readonly execution: ExecutionObservation;
    readonly toolchain: ExecutionObservation;
  };
  readonly acquisition: {
    readonly url: string;
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly downloadedAssetSha256: string;
    readonly assetUrl: string;
    readonly assetStatus: number;
    readonly assetHeaders: Readonly<Record<string, string>>;
    readonly assetPath: string;
  };
  readonly installers: readonly {
    readonly family: string;
    readonly owner: string;
    readonly channel: string;
    readonly identity: ExecutionObservation;
    readonly sourceSha256: string;
    readonly acceptedOptions: readonly string[];
    readonly parserObservationId: string;
    readonly parserProbes: readonly ExecutionObservation[];
    readonly mutationCount: number;
  }[];
};

export interface ProofProducer {
  readonly producerId: string;
  observe(binding: ProofBinding): Promise<ObservedQualification | { readonly state: "unknown"; readonly reason: string }>;
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function invoke(argv: readonly string[], actions: Action[]): Promise<string> {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  actions.push({ argv, exitCode, stdout, stderr });
  if (exitCode !== 0) throw new ProvenanceError(argv.join(" "), `readonly command exited ${exitCode}`);
  return stdout;
}

async function checkedFile(root: string, file: { readonly path: string; readonly sha256: string }): Promise<Uint8Array> {
  const path = resolve(root, file.path);
  if (isAbsolute(file.path) || relative(root, path).startsWith("..")) {
    throw new ProvenanceError(file.path, "artifact must be inside core-source");
  }
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new ProvenanceError(file.path, "SHA256 mismatch");
  return bytes;
}

export async function verifyReceiptConsistency(registry: Registry, root: string, actions: Action[], observed?: ObservedQualification) {
  const git = ["git", "-C", resolve(root)];
  const ref = (await invoke([...git, "rev-parse", "HEAD"], actions)).trim();
  if (ref !== registry.core.sourceRef) throw new ProvenanceError("core.sourceRef", "checkout mismatch");
  const tag = (await invoke([...git, "rev-parse", "--verify", `refs/tags/${registry.core.releaseTag}^{commit}`], actions)).trim();
  if (tag !== ref) throw new ProvenanceError("core.releaseTag", "release does not map to source");
  const dirty = await invoke([...git, "diff", "HEAD", "--"], actions);
  if (dirty) throw new ProvenanceError("core.sourceRef", "tracked source modified");
  const extra = [
    await invoke([...git, "ls-files", "--others", "--exclude-standard", "-z"], actions),
    await invoke([...git, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"], actions),
  ].flatMap((output) => output.split("\0").filter(Boolean));
  const buildInputs = extra.filter((path) =>
    !path.startsWith("target/") &&
    (/^(?:build\.rs|Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?|\.cargo\/|src\/|crates\/|vendor\/)/.test(path) ||
     /\.(?:rs|c|cpp|cc|h|zig|toml|lock)$/.test(path)));
  if (buildInputs.length) throw new ProvenanceError("core.inputs", `untracked/ignored build inputs: ${buildInputs.join(", ")}`);
  // Hash bytes, not a decoded archive; Git archives are deterministic at a pinned ref.
  const archive = Bun.spawn([...git, "archive", "--format=tar", ref], { stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const [bytes, archiveError, archiveExit] = await Promise.all([
    new Response(archive.stdout).arrayBuffer(), new Response(archive.stderr).text(), archive.exited,
  ]);
  actions.push({ argv: [...git, "archive", "--format=tar", ref], exitCode: archiveExit, stdout: `sha256:${sha256(new Uint8Array(bytes))}`, stderr: archiveError });
  if (archiveExit !== 0 || sha256(new Uint8Array(bytes)) !== registry.core.sourceArchiveSha256) {
    throw new ProvenanceError("core.sourceArchiveSha256", "source archive mismatch");
  }
  const cargo = object(Bun.TOML.parse(await Bun.file(resolve(root, "Cargo.toml")).text()), "Cargo");
  const sourcePackage = object(cargo["package"], "Cargo.package");
  if (sourcePackage["version"] !== registry.core.version) throw new ProvenanceError("core.version", "Cargo version mismatch");
  const build = object(JSON.parse(new TextDecoder().decode(await checkedFile(root, registry.core.buildReceipt))), "buildReceipt");
  const release = object(JSON.parse(new TextDecoder().decode(await checkedFile(root, registry.core.releaseReceipt))), "releaseReceipt");
  if (build["command"] !== "cargo build --locked --release" || build["exitCode"] !== 0 ||
      build["sourceRef"] !== ref || build["toolchain"] !== registry.core.toolchain ||
      build["binarySha256"] !== registry.core.binary.sha256) {
    throw new ProvenanceError("buildReceipt", "build/source/toolchain/binary mapping mismatch");
  }
  if (release["tag"] !== registry.core.releaseTag || release["sourceRef"] !== ref ||
      release["version"] !== registry.core.version || release["binarySha256"] !== registry.installed.binarySha256 ||
      release["schemaSha256"] !== registry.installed.schemaSha256) {
    throw new ProvenanceError("releaseReceipt", "installed release mapping mismatch");
  }
  await checkedFile(root, registry.core.binary);
  const schemaBytes = await checkedFile(root, registry.core.schema);
  const sourceSchema = await invoke([...git, "show", `${ref}:docs/next/api/herdr-api.schema.json`], actions);
  if (sha256(sourceSchema) !== registry.core.schema.sha256) {
    throw new ProvenanceError("core.schema", "source schema digest differs from built schema");
  }
  const schema = object(JSON.parse(new TextDecoder().decode(schemaBytes)), "schema");
  if (schema["protocol"] !== registry.core.protocol || schema["schema_version"] !== registry.core.schemaVersion ||
      registry.installed.protocol !== registry.core.protocol || registry.installed.schemaVersion !== registry.core.schemaVersion ||
      registry.installed.version !== registry.core.version || registry.installed.schemaSha256 !== registry.core.schema.sha256) {
    throw new ProvenanceError("schema", "installed/build protocol/version/schema mismatch");
  }
  const binary = resolve(root, registry.core.binary.path);
  const version = (await invoke([binary, "--version"], actions)).trim();
  if (version !== `herdr ${registry.core.version}`) throw new ProvenanceError("binary.version", "build version mismatch");
  const actualSchema = await invoke([binary, "api", "schema", "--json"], actions);
  if (sha256(actualSchema) !== registry.core.schema.sha256) throw new ProvenanceError("binary.schema", "actual schema mismatch");
  for (const row of registry.installers) {
    const source = new TextDecoder().decode(await checkedFile(root, row.source));
    const parser = object(JSON.parse(new TextDecoder().decode(await checkedFile(root, row.parser))), `${row.family}.parser`);
    const claimedOptions = stringArray(parser["acceptedOptions"], `${row.family}.acceptedOptions`);
    if (row.owner.state !== "qualified") throw new ProvenanceError(`${row.family}.owner`, row.owner.reason);
    if (row.channel.state !== "qualified") throw new ProvenanceError(`${row.family}.channel`, row.channel.reason);
    await checkedFile(root, row.owner.evidence);
    await checkedFile(root, row.channel.evidence);
    if (parser["sourceSha256"] !== row.source.sha256 || parser["sourceUrl"] !== row.sourceUrl ||
        parser["owner"] !== row.owner.value || parser["channel"] !== row.channel.value) {
      throw new ProvenanceError(`${row.family}.parser`, "installer source/owner/channel/parser mapping mismatch");
    }
    let accepted: readonly string[];
    switch (parser["method"]) {
      case "restricted-shell-case":
        accepted = parseRestrictedShellCase(source);
        break;
      case "isolated-readonly-observation": {
        const evidence = observed?.installers.find((item) => item.family === row.family && item.parserObservationId === parser["observationId"]);
        if (!evidence || evidence.sourceSha256 !== row.source.sha256 || evidence.mutationCount !== 0) {
          throw new ProvenanceError(`${row.family}.parser`, "independent readonly parser observation missing");
        }
        accepted = evidence.acceptedOptions;
        break;
      }
      default: throw new ProvenanceError(`${row.family}.parser`, "parsed implementation or independently observed parser required");
    }
    if (accepted.length !== claimedOptions.length || accepted.some((option) => !claimedOptions.includes(option))) {
      throw new ProvenanceError(`${row.family}.parser`, "claimed options differ from actual parsed/observed behavior");
    }
    const independentlyObserved = observed?.installers.find((item) => item.family === row.family);
    if (independentlyObserved && (independentlyObserved.acceptedOptions.length !== accepted.length ||
        accepted.some((option) => !independentlyObserved.acceptedOptions.includes(option)))) {
      throw new ProvenanceError(`${row.family}.parser`, "independent parser behavior differs from parsed/claimed options");
    }
    if (row.family === "agy" &&
        (!accepted.includes("--dir") ||
         claimedOptions.includes("--skip-aliases") || claimedOptions.includes("--skip-path"))) {
      throw new ProvenanceError("agy.parser", "documented skip flags are not shipped shell parser options");
    }
  }
  return { status: "CONSISTENT", supportEnabled: false, sourceRef: ref, releaseTag: registry.core.releaseTag, updaterInvocations: 0, restartInvocations: 0 } as const;
}

// Deliberately narrow grammar: a complete executable case dispatch, not strings
// found inside comments, echo, heredocs, conditionals or arbitrary shell programs.
export function parseRestrictedShellCase(source: string): readonly string[] {
  const lines = source.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (lines.shift() !== 'case "$1" in' || lines.pop() !== "esac") {
    throw new ProvenanceError("parser.implementation", "unsupported shell grammar; isolated readonly observation required");
  }
  const options: string[] = [];
  let rejectsUnknown = false;
  for (const line of lines) {
    if (line === "*) exit 2 ;;") {
      if (rejectsUnknown) throw new ProvenanceError("parser.implementation", "duplicate fallback");
      rejectsUnknown = true;
      continue;
    }
    const clause = /^(-[a-zA-Z0-9-]+(?:\|-[a-zA-Z0-9-]+)*)\) ;;$/.exec(line);
    if (!clause?.[1] || rejectsUnknown) throw new ProvenanceError("parser.implementation", "unsupported or unreachable case clause");
    options.push(...clause[1].split("|"));
  }
  if (!rejectsUnknown || !options.length || new Set(options).size !== options.length) {
    throw new ProvenanceError("parser.implementation", "complete unique option dispatch and rejection required");
  }
  return options;
}

async function completeExecution(value: ExecutionObservation, field: string): Promise<void> {
  if (!value.argv.length || !isAbsolute(value.argv[0] ?? "") || !isAbsolute(value.cwd) ||
      !Object.keys(value.env).length || value.exitCode !== 0 ||
      typeof value.stdout !== "string" || typeof value.stderr !== "string") {
    throw new ProvenanceError(field, "actual argv/cwd/environment/exit/stdout/stderr observation required");
  }
  digest(value.executableSha256, `${field}.executableSha256`);
  if (sha256(new Uint8Array(await Bun.file(value.argv[0] ?? "").arrayBuffer())) !== value.executableSha256) {
    throw new ProvenanceError(field, "observed executable bytes changed");
  }
}

async function requireObserved(registry: Registry, root: string, producer: ProofProducer, proof: ObservedQualification): Promise<void> {
  const build = proof.build;
  if (!proof.runId || !proof.producerId || proof.producerId !== producer.producerId ||
      proof.sourceRef !== registry.core.sourceRef || proof.sourceArchiveSha256 !== registry.core.sourceArchiveSha256 ||
      build.inputMode !== "immutable-archive-only" || build.archiveSha256 !== registry.core.sourceArchiveSha256 ||
      !isAbsolute(build.extractedRoot) || resolve(build.extractedRoot) === resolve(root) ||
      build.execution.cwd !== build.extractedRoot || build.binarySha256 !== registry.core.binary.sha256 ||
      basename(build.execution.argv[0] ?? "") !== "cargo" || basename(build.toolchain.argv[0] ?? "") !== "rustc" ||
      build.execution.argv.slice(1).join(" ") !== "build --locked --release" ||
      build.toolchain.stdout.trim() !== registry.core.toolchain ||
      build.toolchain.argv.slice(1).join(" ") !== "--version") {
    throw new ProvenanceError("qualification.build", "independent immutable source/build/binary/toolchain binding missing");
  }
  if (!isAbsolute(build.archivePath) || sha256(new Uint8Array(await Bun.file(build.archivePath).arrayBuffer())) !== build.archiveSha256) {
    throw new ProvenanceError("qualification.build", "actual immutable archive bytes missing");
  }
  await completeExecution(build.execution, "qualification.build");
  await completeExecution(build.toolchain, "qualification.toolchain");
  const acquisition = proof.acquisition;
  if (acquisition.url !== `https://api.github.com/repos/herdrdev/herdr/releases/tags/${registry.core.releaseTag}` ||
      acquisition.status !== 200 || !Object.keys(acquisition.headers).length ||
      acquisition.downloadedAssetSha256 !== registry.installed.binarySha256 ||
      acquisition.assetUrl !== `https://github.com/herdrdev/herdr/releases/download/${registry.core.releaseTag}/herdr-macos-aarch64` ||
      acquisition.assetStatus !== 200 || !Object.keys(acquisition.assetHeaders).length ||
      !isAbsolute(acquisition.assetPath) ||
      sha256(new Uint8Array(await Bun.file(acquisition.assetPath).arrayBuffer())) !== registry.installed.binarySha256) {
    throw new ProvenanceError("qualification.acquisition", "official release GET/asset observation missing");
  }
  const release = object(JSON.parse(acquisition.body), "qualification.release");
  const assets = release["assets"];
  if (release["tag_name"] !== registry.core.releaseTag || !Array.isArray(assets) ||
      !assets.some((item: unknown) => {
        const asset = object(item, "qualification.release.asset");
        return asset["name"] === "herdr-macos-aarch64" && asset["digest"] === `sha256:${registry.installed.binarySha256}`;
      })) {
    throw new ProvenanceError("qualification.acquisition", "release response does not map installed artifact");
  }
  if (proof.installers.length !== families.length || new Set(proof.installers.map((item) => item.family)).size !== families.length) {
    throw new ProvenanceError("qualification.installers", "eight independent installer observations required");
  }
  for (const row of registry.installers) {
    const observation = proof.installers.find((item) => item.family === row.family);
    if (row.owner.state !== "qualified" || row.channel.state !== "qualified" || !observation ||
        observation.owner !== row.owner.value || observation.channel !== row.channel.value ||
        observation.sourceSha256 !== row.source.sha256 || observation.mutationCount !== 0 ||
        !observation.parserObservationId || !observation.acceptedOptions.length) {
      throw new ProvenanceError(`qualification.${row.family}`, "qualified identity/parser source evidence missing");
    }
    await completeExecution(observation.identity, `${row.family}.identity`);
    for (const option of observation.acceptedOptions) {
      const probe = observation.parserProbes.find((item) => item.argv.includes(option));
      if (!probe) throw new ProvenanceError(`${row.family}.parser`, "option has no actual readonly parser probe");
      await completeExecution(probe, `${row.family}.parser`);
    }
  }
}

export async function verifyProvenance(registry: Registry, root: string, actions: Action[], producer?: ProofProducer) {
  const evidence = producer ? await producer.observe({
    coreSource: resolve(root), sourceRef: registry.core.sourceRef, sourceArchiveSha256: registry.core.sourceArchiveSha256,
    binarySha256: registry.core.binary.sha256, releaseTag: registry.core.releaseTag,
  }) : undefined;
  let observed: ObservedQualification | undefined;
  if (evidence) {
    switch (evidence.state) {
      case "observed": observed = evidence; break;
      case "unknown": throw new ProvenanceError("qualification.producer", evidence.reason);
    }
  }
  const consistency = await verifyReceiptConsistency(registry, root, actions, observed);
  if (!producer || !observed) {
    throw new ProvenanceError("qualification.producer", "receipt consistency only; independent acquisition/build producer absent");
  }
  await requireObserved(registry, root, producer, observed);
  return { ...consistency, status: "PASS", supportEnabled: true, qualification: "observed", producerId: observed.producerId, runId: observed.runId } as const;
}

export async function main(argv: readonly string[], producer?: ProofProducer): Promise<number> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag || !value || !["--registry", "--core-source", "--evidence-dir"].includes(flag) || flags.has(flag)) {
      console.error("Expected --registry <json> --core-source <C> --evidence-dir <E>");
      return 2;
    }
    flags.set(flag, value);
  }
  const registryPath = flags.get("--registry");
  const coreSource = flags.get("--core-source");
  const evidenceDir = flags.get("--evidence-dir");
  if (!registryPath || !coreSource || !evidenceDir) {
    console.error("Missing required provenance CLI arguments");
    return 2;
  }
  const actions: Action[] = [];
  let result: { readonly status: string; readonly supportEnabled: boolean; readonly blockedField?: string; readonly reason?: string; readonly sourceRef?: string; readonly releaseTag?: string; readonly updaterInvocations: number; readonly restartInvocations: number };
  try {
    const registry = parseRegistry(await Bun.file(registryPath).json());
    result = await verifyProvenance(registry, coreSource, actions, producer);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    result = { status: "BLOCKED", supportEnabled: false, blockedField: error instanceof ProvenanceError ? error.field : "artifact.io", reason: error.message, updaterInvocations: 0, restartInvocations: 0 };
  }
  await mkdir(evidenceDir, { recursive: true });
  await Bun.write(resolve(evidenceDir, "actions.json"), JSON.stringify({ invocation: [process.execPath, ...process.argv.slice(1)], registryPath: resolve(registryPath), coreSource: resolve(coreSource), actions }, null, 2));
  await Bun.write(resolve(evidenceDir, "result.json"), JSON.stringify(result, null, 2));
  await Bun.write(resolve(evidenceDir, "cleanup.json"), JSON.stringify({ resourcesCreated: 0, resourcesRemaining: 0, processesExited: actions.length, retainedEvidenceOnly: true }, null, 2));
  console.log(JSON.stringify(result));
  return result.status === "PASS" ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
