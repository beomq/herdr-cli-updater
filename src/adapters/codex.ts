import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { discoverExecutable, probeExecutable } from "../discovery";
import type { ProvenancePin } from "../discovery";
import { parseAdapterContract } from "./types";
import type { AdapterCapabilities, AdapterResult, FamilyAdapter, InstallationIdentity, RuntimeIdentity } from "./types";
import type { FailureCode } from "../protocol";
import { isRuntimeBinding } from "../protocol";

/** These readers must read authoritative private storage/core observations on every call.
 * No reader is a capability flag. There is deliberately no command executor.
 * preflight returns { binding, optionsDigest, threadId, cwd, storagePathHash }.
 * privateRuntime returns { sessionPath, optionsRef, args } (local JSONL only).
 * manager returns { owner, channel, executable, sha256, cwd }.
 * releases returns { github: <release JSON>, npm: <registry JSON> }.
 */
export type CodexConfiguration = {
  readonly probeCwd: `/${string}`;
  readonly provenance: (executable: string) => readonly ProvenancePin[];
  readonly privateRuntime: (runtimeId: string) => unknown;
  readonly preflight: (runtimeId: string) => unknown;
  readonly manager: (installationId: string) => unknown;
  readonly releases: () => Promise<unknown>;
  readonly now: () => number;
};

const unverified = { kind: "unknown", reason: "not_verified" } as const;
const capabilities: AdapterCapabilities = {
  check: unverified, update: unverified, busySafe: unverified,
  completion: unverified, resume: unverified, gracefulExit: unverified,
};
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const fail = <T>(code: FailureCode): AdapterResult<T> => ({ ok: false, error: { code } });
function object(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clean(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}
function absolute(value: unknown): value is `/${string}` {
  return clean(value) && value.startsWith("/");
}
function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
function stable(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}
function bytes(path: string, limit: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new RangeError("bounded_read");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
// Native executables exceed metadata limits. Hash all bytes with constant memory,
// retaining the opened file and checking its identity after the read.
function fileHash(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("invalid_resource");
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    const size = Number(before.size);
    for (let offset = 0; offset < size;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count === 0) throw new RangeError("resource_changed");
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (![after, named].every(info => info.isFile() && info.dev === before.dev && info.ino === before.ino
      && info.size === before.size && info.mode === before.mode
      && info.mtimeNs === before.mtimeNs && info.ctimeNs === before.ctimeNs)
      || realpathSync(path) !== path) throw new RangeError("resource_changed");
    return digest.digest("hex");
  } finally { closeSync(fd); }
}
// Expected boundary failures become public codes, never filesystem paths or raw errors.
function boundary<T>(action: () => AdapterResult<T>): AdapterResult<T> {
  try { return action(); } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return fail("verification_failed");
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return fail("missing_session");
      if (["EACCES", "ELOOP", "ENOTDIR", "EINVAL"].includes(String(error.code))) return fail("verification_failed");
    }
    // Public adapter boundary: even unexpected reader failures cannot expose private data.
    return fail("verification_failed");
  }
}
async function asynchronous<T>(action: () => Promise<AdapterResult<T>>): Promise<AdapterResult<T>> {
  try { return await action(); } catch (error) {
    return boundary(() => { throw error; });
  }
}

/** Conservative local option grammar, from the qualified resume parser. Never accept
 * positional data, selectors, config/remote/worktree overrides or a second --cd.
 * Config/profile need effective-config attestation, absent from this frozen contract.
 */
function options(value: unknown, cwd: string): value is readonly string[] {
  if (!Array.isArray(value) || value.length > 64 || !value.every(clean)) return false;
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const flag = value[i];
    if (!flag || seen.has(flag)) return false;
    if (flag !== "--add-dir") seen.add(flag);
    if (flag === "--no-alt-screen" || flag === "--no-daemon") continue;
    if (!["--model", "--sandbox", "--ask-for-approval", "--cd", "--add-dir"].includes(flag)) return false;
    const arg = value[++i];
    if (!clean(arg) || arg.startsWith("-")) return false;
    if (flag === "--cd" && arg !== cwd) return false;
    if (flag === "--add-dir" && !absolute(arg)) return false;
    if (flag === "--sandbox" && !["read-only", "workspace-write", "danger-full-access"].includes(arg)) return false;
    if (flag === "--ask-for-approval" && !["untrusted", "on-failure", "on-request", "never"].includes(arg)) return false;
  }
  // Explicit Current cwd avoids upstream saved-cwd picker/default ambiguity.
  return seen.has("--cd");
}

export function createCodexAdapter(config: CodexConfiguration): FamilyAdapter {
  // Cache contains observations, not readiness. Sync spec methods rehash every resource.
  const installations = new Map<string, InstallationIdentity>();
  function current(installation: InstallationIdentity): AdapterResult<InstallationIdentity> {
    const parsed = parseAdapterContract({ version: 1, family: "codex", installation, runtime: null, capabilities });
    if (!parsed.ok) return fail("malformed_request");
    const observed = installations.get(installation.installationId);
    if (!observed || !isDeepStrictEqual(observed, installation)) return fail("stale_selection");
    if (observed.owner.kind === "unknown" || observed.channel === "unknown") return fail("unsupported");
    // Provenance configuration may revoke/change owner pins after discovery.
    const pins = config.provenance(observed.executableRealpath);
    if (pins.length !== 1 || !pins.every(pin => observed.resources.some(resource =>
      resource.realpath === realpathSync(pin.path) && resource.fingerprint === `sha256:${pin.sha256}`))) return fail("stale_selection");
    for (const resource of observed.resources) {
      if (realpathSync(resource.realpath) !== resource.realpath
        || `sha256:${fileHash(resource.realpath)}` !== resource.fingerprint) return fail("external_writer");
    }
    return { ok: true, value: observed };
  }
  function bound(runtime: RuntimeIdentity): AdapterResult<InstallationIdentity> {
    if (!object(runtime) || !isRuntimeBinding(runtime.binding)) return fail("malformed_request");
    const installation = installations.get(runtime.installationId);
    if (!installation) return fail("stale_binding");
    const parsed = parseAdapterContract({ version: 1, family: "codex", installation, runtime, capabilities });
    if (!parsed.ok) return fail("stale_binding");
    const fresh = current(installation);
    if (!fresh.ok) return fresh;
    const binding = runtime.binding;
    if (binding.rootIncarnation.executableRealpath !== installation.executableRealpath
      || binding.session.kind !== "conversation" || !uuid(binding.session.fullId)) return fail("identity_mismatch");
    const live = config.preflight(runtime.runtimeId);
    if (!object(live) || !isRuntimeBinding(live["binding"])
      || !isDeepStrictEqual(live["binding"], binding)) return fail("stale_binding");
    return fresh;
  }
  const adapter: FamilyAdapter = {
    family: "codex",
    async detect(executable) {
      return asynchronous(async () => {
      const result = await discoverExecutable({ executable, family: "codex", provenance: config.provenance(executable) });
      if (!result.ok) return fail(result.error.code === "missing" ? "not_found" : "verification_failed");
      const installation = structuredClone(result.value.installation);
      installations.set(installation.installationId, installation);
      return { ok: true, value: structuredClone(installation) };
      });
    },
    async version(installation) {
      return asynchronous(async () => {
      const fresh = boundary(() => current(installation));
      if (!fresh.ok) return fresh;
      const result = await probeExecutable({ executable: fresh.value.executableRealpath, cwd: config.probeCwd,
        argument: "--version", timeoutMs: 5000 });
      const match = result.ok ? /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\r?\n?$/.exec(result.value.stdout) : null;
      const version = match?.[1];
      if (!version || (fresh.value.installedVersion.kind === "known" && fresh.value.installedVersion.version !== version))
        return fail("verification_failed");
      const after = boundary(() => current(installation));
      return after.ok ? { ok: true, value: { kind: "known", version } } : after;
      });
    },
    async check(installation) {
      return asynchronous(async () => {
      const version = await adapter.version(installation);
      if (!version.ok) return version;
      if (version.value.kind !== "known" || !stable(version.value.version)
        || installation.channel !== "stable/npm-latest") return fail("unsupported");
      const input = await config.releases();
      if (!object(input) || !object(input["github"]) || !object(input["npm"])) return fail("verification_failed");
      const github = input["github"];
      const npm = input["npm"];
      const tag = github["tag_name"];
      const latest = typeof tag === "string" && tag.startsWith("rust-v") ? tag.slice(6) : null;
      const tags = npm["dist-tags"];
      const versions = npm["versions"];
      const release = latest && object(versions) ? versions[latest] : null;
      const dist = object(release) ? release["dist"] : null;
      if (!stable(latest) || github["draft"] !== false || github["prerelease"] !== false
        || !object(tags) || tags["latest"] !== latest || !object(dist)
        || !clean(dist["tarball"]) || !clean(dist["integrity"])) return fail("verification_failed");
      const fresh = boundary(() => current(installation));
      if (!fresh.ok) return fresh;
      const left = latest.split(".").map(BigInt);
      const right = version.value.version.split(".").map(BigInt);
      let newer = false;
      for (let i = 0; i < 3; i++) {
        const a = left[i], b = right[i];
        if (a === undefined || b === undefined) return fail("verification_failed");
        if (a !== b) { newer = a > b; break; }
      }
      const checkedAt = config.now();
      if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) return fail("verification_failed");
      return { ok: true, value: newer
        ? { kind: "update-available", installedVersion: version.value.version, availableVersion: latest, checkedAt }
        : { kind: "up-to-date", installedVersion: version.value.version, checkedAt } };
      });
    },
    updateSpec(installation, mode) {
      return boundary(() => {
        if (mode !== "update-only" && mode !== "update-and-restart") return fail("malformed_request");
        const fresh = current(installation);
        if (!fresh.ok) return fresh;
        const owner = fresh.value.owner;
        if (owner.kind !== "package" || fresh.value.channel !== "stable/npm-latest"
          || owner.packageName !== "@openai/codex") return fail("unsupported");
        const manager = config.manager(installation.installationId);
        if (!object(manager)) return fail("unsupported");
        if (!isDeepStrictEqual(manager["owner"], owner)
          || manager["channel"] !== installation.channel || manager["cwd"] !== owner.prefix) return fail("identity_mismatch");
        if (!absolute(manager["executable"]) || !clean(manager["sha256"])) return fail("verification_failed");
        const executable = manager["executable"];
        if (realpathSync(executable) !== executable || !(statSync(executable).mode & 0o111)
          || fileHash(executable) !== manager["sha256"]) return fail("external_writer");
        if (!absolute(owner.prefix)) return fail("verification_failed");
        // Homebrew requires cask ownership, not the npm package owner used in this lane.
        if (owner.manager === "homebrew") return fail("unsupported");
        // Official upstream argv uses a floating package target. The frozen API has
        // no private immutable acquisition/update context or environment binding.
        // Task38 must supply that verified delta; do not guess @version/prefix flags.
        return fail("unsupported");
      });
    },
    exactResume(runtime) {
      return boundary(() => {
        const fresh = bound(runtime);
        if (!fresh.ok) return fresh;
        const binding = runtime.binding;
        const privateData = config.privateRuntime(runtime.runtimeId);
        const live = config.preflight(runtime.runtimeId);
        if (!object(privateData) || !object(live) || !isDeepStrictEqual(live["binding"], binding)
          || privateData["optionsRef"] !== binding.optionsRef || !absolute(privateData["sessionPath"])
          || !options(privateData["args"], binding.cwd)) return fail("verification_failed");
        const args = privateData["args"];
        const sessionPath = realpathSync(privateData["sessionPath"]);
        if (`sha256:${hash(sessionPath)}` !== binding.session.storagePathHash
          || live["storagePathHash"] !== binding.session.storagePathHash
          || live["threadId"] !== binding.session.fullId || live["cwd"] !== binding.cwd
          || live["optionsDigest"] !== `sha256:${hash(JSON.stringify(args))}`) return fail("identity_mismatch");
        // Read first metadata, never derive identity from rollout filename.
        const first = bytes(sessionPath, 16 * 1024 * 1024).toString().split("\n").find(line => line.trim().length > 0);
        const line: unknown = first ? JSON.parse(first) : null;
        const meta = object(line) ? line["payload"] : null;
        if (!object(line) || line["type"] !== "session_meta" || !object(meta)
          || meta["id"] !== binding.session.fullId || meta["cwd"] !== binding.cwd
          || (meta["history_mode"] !== undefined && meta["history_mode"] !== "legacy"
            && meta["history_mode"] !== "paginated")) return fail("identity_mismatch");
        if (!absolute(binding.cwd) || realpathSync(binding.cwd) !== binding.cwd || !statSync(binding.cwd).isDirectory())
          return fail("identity_mismatch");
        const executable = fresh.value.executableRealpath;
        if (!absolute(executable)) return fail("verification_failed");
        return { ok: true, value: {
          command: { executable, args: ["resume", binding.session.fullId, ...args], cwd: binding.cwd },
          expectedBinding: structuredClone(binding), optionsRef: binding.optionsRef,
        } };
      });
    },
    bridge(runtime) {
      return boundary(() => {
        const fresh = bound(runtime);
        if (!fresh.ok) return fresh;
        // Frozen FamilyAdapter specifies output only. No qualified all-work producer,
        // versioned core attestation reader or input fence exists in task5/task13.
        return fail("unsupported");
      });
    },
    gracefulExit(runtime, operationId, ownerTokenRef) {
      return boundary(() => {
        const fresh = bound(runtime);
        if (!fresh.ok) return fresh;
        if (!clean(operationId) || !clean(ownerTokenRef)) return fail("malformed_request");
        // Never substitute /exit, signals, display idle or TurnComplete for core-stop.
        return fail("unsupported");
      });
    },
  };
  return adapter;
}
