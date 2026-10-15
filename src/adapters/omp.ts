import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { discoverExecutable, probeExecutable } from "../discovery";
import type { ProvenancePin } from "../discovery";
import type { FailureCode, RuntimeBinding } from "../protocol";
import { parseAdapterContract } from "./types";
import type { AdapterResult, FamilyAdapter, InstallationIdentity, RuntimeIdentity } from "./types";

/** These readers belong to the private core store, not public request/capability data.
 * readRuntime must query current incarnation/generations, not a saved display snapshot.
 */
export type OmpPrivateRuntime = {
  readonly runtime: RuntimeIdentity;
  readonly installation: InstallationIdentity;
  readonly sessionPath: string;
  readonly sessionId: string;
  readonly options: readonly string[];
};
export type OmpCoreEvidence = {
  readonly expectedBinding: RuntimeBinding;
  readonly evidenceRef: string;
  readonly workGeneration: number;
  readonly admission: "claimed";
  readonly pending: {
    readonly root: number; readonly tools: number; readonly subagents: number;
    readonly background: number; readonly monitors: number; readonly continuations: number;
    readonly deliveries: number;
  };
  readonly operationId: string;
  readonly ownerTokenRef: string;
};
export type OmpConfiguration = {
  readonly sourceRoot: string;
  readonly probeCwd: `/${string}`;
  readonly provenance: (executable: string) => readonly ProvenancePin[];
  readonly readRuntime: (runtimeId: string) => OmpPrivateRuntime | null;
  /** Only task18/19 authoritative core attestations may supply this reader. */
  readonly readCoreEvidence?: (runtimeId: string) => OmpCoreEvidence | null;
};

const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const pins = {
  "boundedsource/src/cli/args.ts": "14b7041ad9054e34f97b539ca7e4a7eda8bd7660e637d726d1d1a8b599fa4014",
  "boundedsource/src/cli/flag-tables.ts": "850690751d86e9414a196537eec353c77310bd586d1966600c3b8c7a03c0ba14",
  "boundedsource/src/commands/update.ts": "0a51e5917748f543add84b6e9d7ff8ab512d3fad9b896600225fb4a99d6da417",
  "boundedsource/src/cli/update-cli.ts": "ca4a417cb654ce6333cc45dbdc58f3f2109eacb68205199ae8f732bce528fd4f",
  "boundedsource/src/session/session-loader.ts": "c03e41aba61f8297cefd49865ca5bac06771d5450db0b8e1dc75b8b46c25b20a",
  "boundedsource/src/session/session-manager.ts": "1deed7156dde92a1d28aa87d311d402e5a08eec085b7fd2ab7234c7f4abb3659",
  "officialresponse/npm-version.json": "0b2f3f426a0bd3236115ecb4ffea5dda89efcab59a2b68c20a5a8ba135ccec3f",
  "officialresponse/npm-dist-tags.json": "10690c5d3e07a88cfd5e9aae3c13953aa674f26d5f3df242ed8c571dd52cfbe9",
  "officialresponse/npm-latest.json": "9c0209891c5ded407ef34728dc35f56781bdf69490882b7bea59bbaa85ca1e66",
} as const;
const unknown = { kind: "unknown", reason: "not_verified" } as const;
const capabilities = { check: unknown, update: unknown, busySafe: unknown, completion: unknown, resume: unknown, gracefulExit: unknown };
const blocked = <T>(code: FailureCode): AdapterResult<T> => ({ ok: false, error: { code } });
function object(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function absolute(value: string): value is `/${string}` {
  return value.startsWith("/") && normalize(value) === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function identifier(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function bounded(path: string, max = 256 * 1024): Buffer {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > max) throw new OmpFailure("verification_failed");
  return readFileSync(path);
}
const internalFailures = new WeakMap<object, FailureCode>();
class OmpFailure extends Error {
  constructor(code: FailureCode) { super(code); internalFailures.set(this, code); }
}
function failure<T>(error: unknown): AdapterResult<T> {
  // Identity lookup never inspects foreign prototypes/properties or coerces values.
  const code = ((typeof error === "object" && error !== null) || typeof error === "function")
    ? internalFailures.get(error) : undefined;
  return blocked(code ?? "verification_failed");
}

/** No effects API: discovery/version are bounded probes; the remaining methods
 * read authoritative files/core records and construct specs. No update/start/stop.
 */
export function createOmpAdapter(config: OmpConfiguration): FamilyAdapter {
  // Detection snapshots are compared with private records and fresh bytes, not capabilities.
  const detected = new Map<string, InstallationIdentity>();
  function source(): void {
    if (!absolute(config.sourceRoot)) throw new OmpFailure("verification_failed");
    for (const [file, digest] of Object.entries(pins))
      if (hash(bounded(join(config.sourceRoot, file))) !== digest) throw new OmpFailure("verification_failed");
    const manifest: unknown = JSON.parse(bounded(join(config.sourceRoot, "officialresponse/npm-version.json")).toString());
    if (!object(manifest) || manifest["name"] !== "@oh-my-pi/pi-coding-agent" || manifest["version"] !== "17.1.8")
      throw new OmpFailure("verification_failed");
  }
  function qualified(installation: InstallationIdentity): void {
    const parsed = parseAdapterContract({ version: 1, family: "omp", installation, runtime: null, capabilities });
    if (!parsed.ok) throw new OmpFailure("verification_failed");
    if (installation.channel !== "stable") throw new OmpFailure("unsupported");
    const owner = installation.owner;
    if (owner.kind !== "package" || owner.packageName !== "@oh-my-pi/pi-coding-agent"
      || !["npm", "bun"].includes(owner.manager)) throw new OmpFailure("unsupported");
    if (installation.installedVersion.kind !== "known" || installation.installedVersion.version !== "17.1.8")
      throw new OmpFailure("unsupported");
  }
  function fresh(installation: InstallationIdentity): void {
    source();
    qualified(installation);
    if (!isDeepStrictEqual(detected.get(installation.installationId), installation)) throw new OmpFailure("stale_selection");
    const ownerPins = config.provenance(installation.executableRealpath);
    if (ownerPins.length !== 1) throw new OmpFailure("stale_selection");
    for (const pin of ownerPins)
      if (hash(bounded(pin.path)) !== pin.sha256 || !installation.resources.some(row => row.realpath === realpathSync(pin.path)))
        throw new OmpFailure("stale_selection");
    for (const row of installation.resources)
      if (realpathSync(row.realpath) !== row.realpath || `sha256:${hash(bounded(row.realpath, 64 * 1024 * 1024))}` !== row.fingerprint)
        throw new OmpFailure("stale_selection");
  }
  function privateRuntime(runtime: RuntimeIdentity): OmpPrivateRuntime {
    const record = config.readRuntime(runtime.runtimeId);
    if (!record) throw new OmpFailure("stale_binding");
    const parsed = parseAdapterContract({ version: 1, family: "omp", installation: record.installation, runtime: record.runtime, capabilities });
    if (!parsed.ok || !isDeepStrictEqual(runtime, record.runtime)) throw new OmpFailure("stale_binding");
    fresh(record.installation);
    if (runtime.binding.rootIncarnation.executableRealpath !== record.installation.executableRealpath
      || runtime.binding.session.kind !== "conversation" || !absolute(runtime.binding.cwd)
      || !statSync(runtime.binding.cwd).isDirectory()) throw new OmpFailure("identity_mismatch");
    return record;
  }
  function core(runtime: RuntimeIdentity): OmpCoreEvidence {
    privateRuntime(runtime);
    const evidence = config.readCoreEvidence?.(runtime.runtimeId);
    if (!evidence) throw new OmpFailure("unsupported");
    if (!isDeepStrictEqual(evidence.expectedBinding, runtime.binding) || evidence.admission !== "claimed"
      || !Number.isSafeInteger(evidence.workGeneration) || evidence.workGeneration !== runtime.binding.turnGeneration
      || !identifier(evidence.evidenceRef) || !identifier(evidence.operationId) || !identifier(evidence.ownerTokenRef)
      || !object(evidence.pending) || Object.keys(evidence.pending).sort().join(",") !== "background,continuations,deliveries,monitors,root,subagents,tools"
      || !Object.values(evidence.pending).every(value => value === 0)) throw new OmpFailure("resources_busy");
    return evidence;
  }
  async function version(installation: InstallationIdentity): Promise<AdapterResult<{ readonly kind: "known"; readonly version: string }>> {
    try {
      fresh(installation);
      const result = await probeExecutable({ executable: installation.executableRealpath, cwd: config.probeCwd, argument: "--version" });
      const match = result.ok ? /^omp\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\r?\n?$/.exec(result.value.stdout) : null;
      if (!match?.[1] || match[1] !== "17.1.8") return blocked("verification_failed");
      fresh(installation);
      return { ok: true, value: { kind: "known", version: match[1] } };
    } catch (error) { return failure(error); }
  }
  return {
    family: "omp",
    async detect(executable) {
      try {
        source();
        const result = await discoverExecutable({ executable, family: "omp", provenance: config.provenance(executable) });
        if (!result.ok) return blocked(result.error.code === "missing" ? "not_found" : "verification_failed");
        if (result.value.qualification.kind !== "known") return blocked("unsupported");
        qualified(result.value.installation);
        detected.set(result.value.installation.installationId, structuredClone(result.value.installation));
        return { ok: true, value: result.value.installation };
      } catch (error) { return failure(error); }
    },
    version,
    async check(installation) {
      const observed = await version(installation);
      if (!observed.ok) return observed;
      try {
        // Read official machine metadata, not colorized `update --check` prose/exit0.
        const latest: unknown = JSON.parse(bounded(join(config.sourceRoot, "officialresponse/npm-latest.json")).toString());
        const tags: unknown = JSON.parse(bounded(join(config.sourceRoot, "officialresponse/npm-dist-tags.json")).toString());
        if (!object(latest) || !object(tags) || latest["name"] !== "@oh-my-pi/pi-coding-agent"
          || typeof latest["version"] !== "string" || tags["latest"] !== latest["version"]
          || !/^\d+\.\d+\.\d+$/.test(latest["version"])) return blocked("verification_failed");
        const installedVersion = observed.value.version;
        const availableVersion = latest["version"];
        return { ok: true, value: availableVersion === installedVersion
          ? { kind: "up-to-date", installedVersion, checkedAt: Date.now() }
          : { kind: "update-available", installedVersion, availableVersion, checkedAt: Date.now() } };
      } catch (error) { return failure(error); }
    },
    updateSpec(installation, mode) {
      try {
        fresh(installation);
        if (mode !== "update-only" && mode !== "update-and-restart") return blocked("malformed_request");
        // 17.1.8 resolves mutation target/manager via ambient PATH. CommandSpec has
        // no environment or write-set attestation, so absolute invocation is unsafe.
        return blocked("unsupported");
      } catch (error) { return failure(error); }
    },
    exactResume(runtime) {
      try {
        const record = privateRuntime(runtime);
        const binding = runtime.binding;
        const executable = binding.rootIncarnation.executableRealpath;
        const cwd = binding.cwd;
        if (!absolute(executable) || !absolute(cwd)) return blocked("identity_mismatch");
        if (!absolute(record.sessionPath) || record.sessionId !== binding.session.fullId
          || binding.session.storagePathHash !== `sha256:${hash(record.sessionPath)}`
          || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.sessionId)) return blocked("identity_mismatch");
        let content: string;
        try {
          if (realpathSync(record.sessionPath) !== record.sessionPath) return blocked("identity_mismatch");
          content = bounded(record.sessionPath, 8 * 1024 * 1024).toString();
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return blocked("missing_session");
          return failure(error);
        }
        const lines = content.split("\n");
        let header: unknown = JSON.parse(lines[0] ?? "");
        if (object(header) && header["type"] === "title") {
          if (header["v"] !== 1 || typeof header["title"] !== "string"
            || typeof header["updatedAt"] !== "string" || typeof header["pad"] !== "string"
            || (header["source"] !== undefined && header["source"] !== "auto" && header["source"] !== "user"))
            return blocked("verification_failed");
          header = JSON.parse(lines[1] ?? "");
        }
        if (!object(header) || header["type"] !== "session" || header["version"] !== 3
          || header["id"] !== record.sessionId || header["cwd"] !== binding.cwd) return blocked("identity_mismatch");
        const args: string[] = [];
        const directories: string[] = [];
        const values = ["--model", "--provider", "--thinking", "--tools", "--approval-mode", "--mode", "--add-dir"];
        const booleans = ["--no-tools", "--no-lsp", "--no-pty"];
        for (let i = 0; i < record.options.length; i++) {
          const option = record.options[i];
          if (!option || /[\u0000-\u001f\u007f]/.test(option)) return blocked("unsupported");
          if (booleans.includes(option)) { args.push(option); continue; }
          const split = option.indexOf("=");
          const flag = split < 0 ? option : option.slice(0, split);
          const value = split < 0 ? record.options[++i] : option.slice(split + 1);
          if (!values.includes(flag) || !value || value.startsWith("-") || /[\u0000-\u001f\u007f]/.test(value))
            return blocked("unsupported");
          if (flag === "--mode" && !["text", "rpc", "rpc-ui", "acp", "json"].includes(value)) return blocked("unsupported");
          if (flag === "--thinking" && !["off", "minimal", "low", "medium", "high", "xhigh", "auto"].includes(value)) return blocked("unsupported");
          if (flag === "--approval-mode" && !["always-ask", "write", "yolo"].includes(value)) return blocked("unsupported");
          if (flag === "--add-dir") {
            if (!absolute(value) || !statSync(value).isDirectory()) return blocked("identity_mismatch");
            directories.push(value);
          }
          args.push(option);
          if (split < 0) args.push(value);
        }
        if (!isDeepStrictEqual(header["additionalDirectories"] ?? [], directories)) return blocked("identity_mismatch");
        return { ok: true, value: {
          command: { executable, args: [...args, `--resume=${record.sessionPath}`], cwd },
          expectedBinding: structuredClone(binding), optionsRef: binding.optionsRef,
        } };
      } catch (error) { return failure(error); }
    },
    bridge(runtime) {
      try {
        const evidence = core(runtime);
        return { ok: true, value: { kind: "core-attestation", evidenceRef: evidence.evidenceRef,
          expectedBinding: structuredClone(runtime.binding), workGeneration: evidence.workGeneration } };
      } catch (error) { return failure(error); }
    },
    gracefulExit(runtime, operationId, ownerTokenRef) {
      try {
        const evidence = core(runtime);
        if (evidence.operationId !== operationId || evidence.ownerTokenRef !== ownerTokenRef) return blocked("unauthorized");
        return { ok: true, value: { kind: "core-stop", operationId, ownerTokenRef, expectedBinding: structuredClone(runtime.binding) } };
      } catch (error) { return failure(error); }
    },
  };
}
