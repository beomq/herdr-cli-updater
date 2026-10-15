import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { discoverExecutable, probeExecutable } from "../discovery";
import type { ProvenancePin } from "../discovery";
import { isRuntimeBinding } from "../protocol";
import type { FailureCode, RuntimeBinding } from "../protocol";
import { parseAdapterContract } from "./types";
import type {
  AdapterResult, CommandSpec, FamilyAdapter, InstallationIdentity, RuntimeIdentity,
} from "./types";

/** These are private authorities, not data accepted from a public request.
 * accepts must independently inspect a qualified parser, not help text/exit 0.
 * No default parser, storage layout, manager command or core readiness is guessed.
 */
export type ClaudeCommandEvidence = {
  readonly installation: InstallationIdentity;
  readonly command: CommandSpec;
  readonly executable: ProvenancePin;
  readonly parser: ProvenancePin;
  readonly target: { readonly version: string; readonly sha256: string } | null;
  readonly privateContext: "not-required" | "required";
  readonly accepts: (
    source: string, command: CommandSpec, installation: InstallationIdentity,
    target: ClaudeCommandEvidence["target"],
  ) => boolean;
};
export type ClaudeSavedSession = {
  readonly binding: RuntimeBinding;
  readonly installation: InstallationIdentity;
  readonly storage: ProvenancePin;
  readonly startupOptions: readonly string[];
  readonly inspect: (source: string) => {
    readonly fullId: string; readonly cwd: string; readonly startupOptions: readonly string[];
  } | null;
  readonly selector: ClaudeCommandEvidence;
};
export type ClaudeCoreAttestation = {
  readonly kind: "core-attestation";
  readonly binding: RuntimeBinding;
  readonly evidenceRef: string;
  readonly workGeneration: number;
  readonly allWorkDrained: boolean;
  readonly inputFenced: boolean;
  readonly operationId: string | null;
  readonly ownerTokenRef: string | null;
};
export type ClaudeDependencies = {
  readonly cwd: `/${string}`;
  readonly provenance: (executable: string) => readonly ProvenancePin[];
  /** Only explicitly authorized, task-owned read-only binaries may be probed. */
  readonly probeExecutables: readonly string[];
  readonly update?: (installation: InstallationIdentity) => ClaudeCommandEvidence | null;
  readonly session?: (runtime: RuntimeIdentity) => ClaudeSavedSession | null;
  readonly release?: (installation: InstallationIdentity) => {
    readonly installation: InstallationIdentity;
    readonly source: ProvenancePin;
    readonly version: (source: string, channel: string) => string | null;
  } | null;
  readonly core?: (runtime: RuntimeIdentity) => ClaudeCoreAttestation | null;
};

const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const fail = (code: FailureCode): { readonly ok: false; readonly error: { readonly code: FailureCode } } =>
  ({ ok: false, error: { code } });
const clean = (value: string): boolean => value.length > 0 && value.length <= 4096
  && !/[\u0000-\u001f\u007f]/.test(value);
function absolute(value: string): value is `/${string}` {
  return clean(value) && value.startsWith("/");
}
const uuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const semver = (value: string): boolean => /^\d+\.\d+\.\d+$/.test(value)
  && value.split(".").every(part => Number.isSafeInteger(Number(part)));

/** Same bounded file contract as discovery; never follows an opaque hash to a path. */
function file(path: string, limit = 64 * 1024 * 1024): Buffer | null {
  if (!absolute(path) || realpathSync(path) !== path) return null;
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) return null;
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function pinned(pin: ProvenancePin, limit?: number): Buffer | null {
  if (!/^[a-f0-9]{64}$/.test(pin.sha256)) return null;
  const body = file(pin.path, limit);
  return body && hash(body) === pin.sha256 ? body : null;
}
/** Private callback/getter exceptions are opaque, including non-Error values.
 * Never read properties, stringify, log or rethrow their payload at this boundary.
 */
function boundary<T>(action: () => AdapterResult<T>): AdapterResult<T> {
  try { return action(); } catch { return fail("verification_failed"); }
}
async function probeBoundary<T>(action: () => Promise<AdapterResult<T>>): Promise<AdapterResult<T>> {
  try { return await action(); } catch { return fail("verification_failed"); }
}
const unknown = { kind: "unknown", reason: "not_verified" } as const;

/** Constructs specs only. Core must revalidate them at compare-and-execute.
 * The sync frozen spec API requires sync private resolution; no async cache is proof.
 */
export function createClaudeAdapter(deps: ClaudeDependencies): FamilyAdapter {
  // Private detected snapshots; callers cannot manufacture an owner/channel.
  const installations = new Map<string, InstallationIdentity>();
  function fresh(installation: InstallationIdentity): boolean {
    const known = installations.get(installation.executableRealpath);
    if (!known || !isDeepStrictEqual(known, installation) || installation.family !== "claude"
      || installation.owner.kind === "unknown" || installation.owner.kind === "wrapper"
      || installation.channel === "unknown") return false;
    return installation.resources.every(row => {
      const body = file(row.realpath);
      return body !== null && row.fingerprint === `sha256:${hash(body)}`;
    });
  }
  function command(evidence: ClaudeCommandEvidence, installation: InstallationIdentity): boolean {
    const spec = evidence.command;
    if (!isDeepStrictEqual(evidence.installation, installation) || !absolute(spec.executable)
      || !absolute(spec.cwd) || !statSync(spec.cwd).isDirectory()
      || spec.args.length > 64 || !spec.args.every(clean)
      || evidence.executable.path !== spec.executable || (statSync(spec.executable).mode & 0o111) === 0)
      return false;
    const binary = pinned(evidence.executable);
    const source = pinned(evidence.parser, 1024 * 1024);
    return binary !== null && source !== null
      && evidence.accepts(source.toString(), spec, installation, evidence.target);
  }
  function saved(runtime: RuntimeIdentity): AdapterResult<ClaudeSavedSession> {
    const b = runtime.binding;
    if (!isRuntimeBinding(b) || b.session.kind !== "conversation" || !uuid(b.session.fullId))
      return fail("identity_mismatch");
    const record = deps.session?.(runtime);
    if (!record) return fail("missing_session");
    if (!isDeepStrictEqual(record.binding, b) || runtime.installationId !== record.installation.installationId
      || b.resourcesFingerprint !== record.installation.resourcesFingerprint
      || b.rootIncarnation.executableRealpath !== record.installation.executableRealpath
      || !fresh(record.installation)) return fail("stale_binding");
    const body = pinned(record.storage, 1024 * 1024);
    if (!body) return fail("missing_session");
    const identity = record.inspect(body.toString());
    if (hash(record.storage.path) !== b.session.storagePathHash || !identity
      || identity.fullId !== b.session.fullId || identity.cwd !== b.cwd
      || realpathSync(b.cwd) !== b.cwd || !statSync(b.cwd).isDirectory()
      || !isDeepStrictEqual(identity.startupOptions, record.startupOptions))
      return fail("identity_mismatch");
    // Only semantic model/permission settings. Selectors, prompts, secret and
    // environmental/config references need a richer secure core API, not guesses.
    if (record.startupOptions.length % 2 !== 0 || record.startupOptions.length > 4
      || !record.startupOptions.every((value, index) => index % 2 === 0
        ? ["--model", "--permission-mode"].includes(value)
          && record.startupOptions.indexOf(value) === index
        : clean(value) && /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith("-")))
      return fail("unsupported");
    return { ok: true, value: record };
  }
  function attestation(runtime: RuntimeIdentity): AdapterResult<ClaudeCoreAttestation> {
    const session = saved(runtime);
    if (!session.ok) return session;
    const proof = deps.core?.(runtime);
    if (!proof || proof.kind !== "core-attestation" || !proof.allWorkDrained || !proof.inputFenced)
      return fail("unsupported");
    if (!isDeepStrictEqual(proof.binding, runtime.binding) || !clean(proof.evidenceRef)
      || !Number.isSafeInteger(proof.workGeneration) || proof.workGeneration < runtime.binding.turnGeneration)
      return fail("stale_binding");
    return { ok: true, value: proof };
  }
  function version(installation: InstallationIdentity): Promise<AdapterResult<InstallationIdentity["installedVersion"]>> {
    return probeBoundary(async () => {
      const gate = boundary(() => fresh(installation) ? { ok: true, value: true } : fail("stale_selection"));
      if (!gate.ok) return gate;
      if (!deps.probeExecutables.includes(installation.executableRealpath)) return fail("unsupported");
      const result = await probeExecutable({
        executable: installation.executableRealpath, cwd: deps.cwd, argument: "--version",
      });
      const match = result.ok && result.value.stderr === ""
        ? /^(\d+\.\d+\.\d+) \(Claude Code\)\r?\n?$/.exec(result.value.stdout) : null;
      const current = boundary(() => fresh(installation) ? { ok: true, value: true } : fail("stale_selection"));
      if (!current.ok) return current;
      if (!match?.[1] || (installation.installedVersion.kind === "known"
        && installation.installedVersion.version !== match[1])) return fail("verification_failed");
      return { ok: true, value: { kind: "known", version: match[1] } };
    });
  }
  return {
    family: "claude",
    detect: executable => probeBoundary(async () => {
      const result = await discoverExecutable({
        executable, family: "claude", provenance: deps.provenance(executable),
      });
      if (!result.ok) return fail(result.error.code === "missing" ? "not_found" : "verification_failed");
      const installation = result.value.installation;
      if (installation.owner.kind === "package"
        && installation.owner.packageName !== (installation.owner.manager === "homebrew"
          ? "claude-code" : "@anthropic-ai/claude-code")) return fail("identity_mismatch");
      const contract = parseAdapterContract({
        version: 1, family: "claude", installation, runtime: null,
        capabilities: { check: unknown, update: unknown, busySafe: unknown,
          completion: unknown, resume: unknown, gracefulExit: unknown },
      });
      if (!contract.ok) return fail("verification_failed");
      installations.set(installation.executableRealpath, structuredClone(installation));
      return { ok: true, value: structuredClone(installation) };
    }),
    version,
    check: installation => probeBoundary(async () => {
      const installed = await version(installation);
      if (!installed.ok) return installed;
      const release = deps.release?.(installation);
      if (!release || !isDeepStrictEqual(release.installation, installation)) return fail("unsupported");
      return boundary(() => {
        if (!fresh(installation)) return fail("stale_selection");
        const bytes = pinned(release.source, 1024 * 1024);
        const available = bytes ? release.version(bytes.toString(), installation.channel) : null;
        if (!available || !semver(available) || installed.value.kind !== "known"
          || !semver(installed.value.version)) return fail("verification_failed");
        const order = available.split(".").map(Number).reduce((difference, value, index) =>
          difference || value - Number(installed.value.kind === "known"
            ? installed.value.version.split(".")[index] : NaN), 0);
        if (order < 0) return fail("verification_failed");
        const checkedAt = Date.now();
        return { ok: true, value: order === 0
          ? { kind: "up-to-date", installedVersion: installed.value.version, checkedAt }
          : { kind: "update-available", installedVersion: installed.value.version, availableVersion: available, checkedAt } };
      });
    }),
    updateSpec: (installation, mode) => boundary(() => {
      if (mode !== "update-only" && mode !== "update-and-restart") return fail("malformed_request");
      if (!fresh(installation)) return fail("stale_selection");
      const evidence = deps.update?.(installation);
      if (!evidence) return fail("unsupported");
      // Frozen UpdateSpec cannot carry a private environment/options reference.
      // A floating target cannot be repaired by guessing a manager or bare PATH.
      if (evidence.privateContext !== "not-required" || !evidence.target
        || !semver(evidence.target.version) || !/^[a-f0-9]{64}$/.test(evidence.target.sha256))
        return fail("unsupported");
      if (!command(evidence, installation)) return fail("verification_failed");
      if (installation.owner.kind === "native"
        && (evidence.command.executable !== installation.executableRealpath
          || !isDeepStrictEqual(evidence.command.args, ["update"]))) return fail("verification_failed");
      if (!fresh(installation)) return fail("stale_selection");
      return { ok: true, value: {
        command: structuredClone(evidence.command), mode,
        expectedInstallation: structuredClone(installation), mutationResources: structuredClone(installation.resources),
      } };
    }),
    exactResume: runtime => boundary(() => {
      const record = saved(runtime);
      if (!record.ok) return record;
      const executable = record.value.installation.executableRealpath;
      const cwd = runtime.binding.cwd;
      if (!absolute(executable) || !absolute(cwd)) return fail("identity_mismatch");
      const expected: CommandSpec = {
        executable,
        args: ["--resume", runtime.binding.session.fullId, ...record.value.startupOptions],
        cwd,
      };
      if (expected.executable !== record.value.installation.executableRealpath
        || expected.cwd !== runtime.binding.cwd || !isDeepStrictEqual(expected, record.value.selector.command)
        || record.value.selector.privateContext !== "not-required"
        || !command(record.value.selector, record.value.installation)) return fail("verification_failed");
      return { ok: true, value: {
        command: structuredClone(expected), expectedBinding: structuredClone(runtime.binding), optionsRef: runtime.binding.optionsRef,
      } };
    }),
    bridge: runtime => boundary(() => {
      const proof = attestation(runtime);
      if (!proof.ok) return proof;
      return { ok: true, value: {
        kind: "core-attestation", evidenceRef: proof.value.evidenceRef,
        expectedBinding: structuredClone(runtime.binding), workGeneration: proof.value.workGeneration,
      } };
    }),
    gracefulExit: (runtime, operationId, ownerTokenRef) => boundary(() => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerTokenRef)) return fail("malformed_request");
      const proof = attestation(runtime);
      if (!proof.ok) return proof;
      if (proof.value.operationId !== operationId || proof.value.ownerTokenRef !== ownerTokenRef)
        return fail("stale_binding");
      return { ok: true, value: {
        kind: "core-stop", operationId, ownerTokenRef, expectedBinding: structuredClone(runtime.binding),
      } };
    }),
  };
}
