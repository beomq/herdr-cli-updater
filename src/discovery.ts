import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import { isInstallSelection } from "./protocol";
import type { Family, InstallationOwner, Result, VersionEvidence } from "./protocol";
import type { AdapterCapabilities, InstallationIdentity, MutationResource } from "./adapters/types";

export type DiscoveryReason = "missing" | "broken_link" | "link_loop" | "not_executable"
  | "unverified_owner" | "ambiguous_owner" | "invalid_provenance" | "stale_provenance" | "unverified_shim";
export type ProvenancePin = { readonly path: string; readonly sha256: string };
export type DiscoveryInput = {
  readonly executable: string;
  readonly family: Family;
  /** Pins come from a separately qualified installer/adapter, never executable help. */
  readonly provenance?: readonly ProvenancePin[];
  readonly probe?: { readonly cwd: string; readonly environment?: ProbeEnvironment };
};
export type Discovery = {
  readonly installation: InstallationIdentity;
  readonly qualification: { readonly kind: "known" } | { readonly kind: "unknown"; readonly reason: DiscoveryReason };
  readonly capabilities: AdapterCapabilities;
};
export type ProbeEnvironment = { readonly PATH?: string; readonly LANG?: string; readonly LC_ALL?: string };
export type ProbeInput = {
  readonly executable: string; readonly cwd: string; readonly argument: "--version" | "--help";
  readonly environment?: ProbeEnvironment; readonly timeoutMs?: number; readonly maxBytes?: number;
};
export type ProbeResult = Result<{ readonly stdout: string; readonly stderr: string }, {
  readonly code: "invalid_probe" | "probe_failed" | "output_limit" | "timeout";
}>;

const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const resource = (path: string, bytes: Uint8Array): MutationResource => ({
  resourceId: `resource:${digest(path)}`, realpath: path, fingerprint: `sha256:${digest(bytes)}`,
});
function object(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clean(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}
function absolute(value: unknown): value is string {
  return clean(value) && isAbsolute(value);
}
class DiscoveryError extends Error {
  constructor(readonly reason: DiscoveryReason) { super(reason); }
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function stableFile<T>(path: string, read: (handle: FileHandle, size: number) => Promise<T>): Promise<T> {
  const canonical = await target(path);
  const named = await lstat(canonical, { bigint: true });
  if (!named.isFile()) throw new DiscoveryError("invalid_provenance");
  let handle: FileHandle | undefined;
  try {
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!sameFile(named, before) || before.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new DiscoveryError("stale_provenance");
    const value = await read(handle, Number(before.size));
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after)) throw new DiscoveryError("stale_provenance");
    if (!sameFile(after, await lstat(canonical, { bigint: true })) || await realpath(path) !== canonical)
      throw new DiscoveryError("stale_provenance");
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP"))
      throw new DiscoveryError("stale_provenance");
    throw error;
  } finally { await handle?.close(); }
}
async function bytes(path: string, limit = 64 * 1024): Promise<Uint8Array> {
  return stableFile(path, async (handle, size) => {
    if (size > limit) throw new DiscoveryError("invalid_provenance");
    const buffer = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) throw new DiscoveryError("stale_provenance");
      offset += bytesRead;
    }
    return buffer;
  });
}
async function fileDigest(path: string): Promise<string> {
  return stableFile(path, async (handle, size) => {
    // One reusable buffer, independent of resource size; no whole-file read or concatenation.
    const buffer = Buffer.alloc(64 * 1024);
    const hash = createHash("sha256");
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead === 0) throw new DiscoveryError("stale_provenance");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash.digest("hex");
  });
}
async function target(path: string): Promise<string> {
  const link = await lstat(path);
  try { return await realpath(path); } catch (error) {
    if (link.isSymbolicLink() && error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new DiscoveryError("broken_link");
    throw error;
  }
}
async function executable(path: string, seen = new Set<string>()): Promise<string> {
  const physical = await target(path);
  if (seen.has(physical) || seen.size >= 16) throw new DiscoveryError("link_loop");
  seen.add(physical);
  const info = await stat(physical);
  if (!info.isFile() || (info.mode & 0o111) === 0) throw new DiscoveryError("not_executable");
  const handle = await open(physical, "r");
  let header: string;
  try {
    const buffer = Buffer.alloc(4096);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, read.bytesRead).toString();
  } finally { await handle.close(); }
  if (/^#!\/(?:bin\/(?:ba)?sh|usr\/bin\/env (?:ba)?sh)\r?\n/.test(header)) {
    // Only this literal exec grammar is qualified; shell programs are never evaluated.
    const match = /^#!\/bin\/sh\nexec "([^"$`\\\n]+)" "\$@"\n?$/.exec(header);
    const next = match?.[1];
    if (!next || !absolute(next)) throw new DiscoveryError("unverified_shim");
    try { return await executable(next, seen); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new DiscoveryError("broken_link");
      throw error;
    }
  }
  return physical;
}

type Receipt = {
  readonly family: Family; readonly executable: string; readonly channel: string;
  readonly owner: Exclude<InstallationOwner, { readonly kind: "unknown" }>; readonly packageManifest: string | null;
  readonly resources: readonly { readonly path: string; readonly sha256: string }[];
};
function receipt(value: unknown): value is Receipt {
  if (!object(value) || Object.keys(value).sort().join(",") !== "channel,executable,family,owner,packageManifest,resources") return false;
  const owner = value["owner"];
  return ["omo", "omp", "pi", "claude", "codex", "agy", "cursor", "grok"].includes(String(value["family"]))
    && absolute(value["executable"]) && clean(value["channel"]) && value["channel"] !== "unknown"
    && (value["packageManifest"] === null || absolute(value["packageManifest"]))
    && isInstallSelection({ installationId: "pin", resourcesFingerprint: "pin", owner,
      installedVersion: { kind: "unknown", reason: "not_captured" } })
    && object(owner) && owner["kind"] !== "unknown"
    && Array.isArray(value["resources"]) && value["resources"].length > 0 && value["resources"].length <= 32
    && value["resources"].every((row: unknown) => object(row) && Object.keys(row).length === 2
      && absolute(row["path"]) && typeof row["sha256"] === "string" && /^[a-f0-9]{64}$/.test(row["sha256"]));
}

/** Read-only physical discovery. No runtime binding or user options enter this API.
 * Local package metadata alone cannot attest installation manager or release channel.
 * A pin validates observed files, not genuine vendor provenance or updater capability.
 */
export async function discoverExecutable(input: DiscoveryInput): Promise<Result<Discovery, { readonly code: DiscoveryReason }>> {
  try {
    if (!absolute(input.executable)) throw new DiscoveryError("missing");
    const physical = await executable(input.executable);
    let primary = physical;
    let family = input.family;
    let owner: InstallationOwner = { kind: "unknown", reason: "unverified_owner" };
    let channel = "unknown";
    let reason: DiscoveryReason | null = "unverified_owner";
    let version: VersionEvidence = { kind: "unknown", reason: "not_captured" };
    const resources = new Map<string, MutationResource>();
    const add = async (path: string): Promise<MutationResource> => {
      const canonical = await target(path);
      const row = { resourceId: `resource:${digest(canonical)}`, realpath: canonical,
        fingerprint: `sha256:${await fileDigest(canonical)}` };
      if (await target(path) !== canonical) throw new DiscoveryError("stale_provenance");
      resources.set(canonical, row);
      return row;
    };
    await add(physical);
    // Locate metadata by bin binding, not executable basename or packageManager hints.
    for (let directory = dirname(physical), depth = 0; depth < 16; depth++) {
      const manifestPath = resolve(directory, "package.json");
      try {
        const body = await bytes(manifestPath);
        const manifest: unknown = JSON.parse(Buffer.from(body).toString());
        if (object(manifest)) {
          const bin = manifest["bin"];
          const entries = typeof bin === "string" ? [bin] : object(bin) ? Object.values(bin) : [];
          if (entries.some(entry => typeof entry === "string" && resolve(directory, entry) === physical)) {
            await add(manifestPath);
            if (clean(manifest["version"])) version = { kind: "known", version: manifest["version"] };
            break;
          }
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const pins = input.provenance ?? [];
    if (pins.length > 1) reason = "ambiguous_owner";
    const pin = pins.length === 1 ? pins[0] : undefined;
    if (pin) {
      const pinPath = await target(pin.path);
      const body = await bytes(pinPath);
      const parsed: unknown = JSON.parse(Buffer.from(body).toString());
      if (!receipt(parsed)) throw new DiscoveryError("invalid_provenance");
      if (digest(body) !== pin.sha256) throw new DiscoveryError("stale_provenance");
      for (const entry of parsed.resources) {
        const row = await add(entry.path);
        if (row.fingerprint !== `sha256:${entry.sha256}`) throw new DiscoveryError("stale_provenance");
      }
      primary = await executable(parsed.executable);
      const declared = await Promise.all(parsed.resources.map(row => target(row.path)));
      if (!declared.includes(primary) || !declared.includes(physical))
        throw new DiscoveryError("invalid_provenance");
      const prefix = await target(parsed.owner.prefix);
      if ([...resources.keys()].some(path => !path.startsWith(`${prefix}/`))) throw new DiscoveryError("invalid_provenance");
      const qualifiedOwner = { ...parsed.owner, prefix };
      owner = qualifiedOwner;
      if (qualifiedOwner.kind === "wrapper" && ![...resources.values()].some(row => row.resourceId === qualifiedOwner.engineResourceId))
        throw new DiscoveryError("invalid_provenance");
      if (parsed.family !== input.family && !(parsed.family === "omo" && input.family === "pi" && owner.kind === "wrapper"))
        throw new DiscoveryError("invalid_provenance");
      family = parsed.family;
      channel = parsed.channel;
      reason = null;
      resources.set(pinPath, resource(pinPath, body));
      if (parsed.packageManifest !== null) {
        const manifestPath = await target(parsed.packageManifest);
        if (!declared.includes(manifestPath)) throw new DiscoveryError("invalid_provenance");
        const manifest: unknown = JSON.parse(Buffer.from(await bytes(manifestPath)).toString());
        if (!object(manifest) || !clean(manifest["version"]) || qualifiedOwner.kind === "native"
          || manifest["name"] !== qualifiedOwner.packageName) throw new DiscoveryError("invalid_provenance");
        const bin = manifest["bin"];
        const entries = typeof bin === "string" ? [bin] : object(bin) ? Object.values(bin) : [];
        const binTargets = await Promise.all(entries.map(async entry => {
          if (typeof entry !== "string") return null;
          try { return await target(resolve(dirname(manifestPath), entry)); }
          catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
          }
        }));
        if (!binTargets.includes(primary))
          throw new DiscoveryError("invalid_provenance");
        version = { kind: "known", version: manifest["version"] };
      } else if (owner.kind !== "native") throw new DiscoveryError("invalid_provenance");
    }
    if (input.probe && reason === null) {
      const result = await probeExecutable({ executable: primary, cwd: input.probe.cwd,
        argument: "--version", ...(input.probe.environment ? { environment: input.probe.environment } : {}) });
      const match = result.ok ? /^(?:[A-Za-z0-9@/._-]+ )?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\s*$/.exec(result.value.stdout) : null;
      if (!match?.[1] || (version.kind === "known" && version.version !== match[1])) {
        reason = "stale_provenance";
        version = { kind: "unknown", reason: "probe_failed" };
      } else version = { kind: "known", version: match[1] };
    }
    const ordered = [...resources.values()].sort((a, b) => a.realpath.localeCompare(b.realpath));
    const unknown = { kind: "unknown", reason: reason ? "unverified_owner" : "not_verified" } as const;
    return { ok: true, value: {
      installation: { installationId: `install:${digest(primary)}`, family, channel, owner,
        executableRealpath: primary, installedVersion: version, resources: ordered,
        resourcesFingerprint: `sha256:${digest(JSON.stringify(ordered))}` },
      qualification: reason ? { kind: "unknown", reason } : { kind: "known" },
      capabilities: { check: unknown, update: unknown, busySafe: unknown, completion: unknown, resume: unknown, gracefulExit: unknown },
    } };
  } catch (error) {
    if (error instanceof DiscoveryError) return { ok: false, error: { code: error.reason } };
    if (error instanceof SyntaxError) return { ok: false, error: { code: "invalid_provenance" } };
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return { ok: false, error: { code: "missing" } };
      if (error.code === "ELOOP") return { ok: false, error: { code: "link_loop" } };
    }
    throw error;
  }
}

/** Only direct --version/--help invocation; allowlisted env, bounded aggregate output.
 * Signals address only the task-owned child, never live CLIs.
 */
export async function probeExecutable(input: ProbeInput): Promise<ProbeResult> {
  const timeout = input.timeoutMs ?? 2000;
  const limit = input.maxBytes ?? 32768;
  if (!absolute(input.executable) || !absolute(input.cwd) || !["--version", "--help"].includes(input.argument)
    || !Number.isInteger(timeout) || timeout < 1 || timeout > 5000 || !Number.isInteger(limit) || limit < 1 || limit > 65536
    || Object.entries(input.environment ?? {}).some(([key, value]) => !["PATH", "LANG", "LC_ALL"].includes(key) || !clean(value)))
    return { ok: false, error: { code: "invalid_probe" } };
  return new Promise(resolveResult => {
    const child = spawn(input.executable, [input.argument], {
      cwd: input.cwd, env: { LANG: "C", LC_ALL: "C", ...input.environment }, shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let size = 0;
    let failure: "output_limit" | "timeout" | "probe_failed" | null = null;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stop = (): void => { child.kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy(); };
    const timer = setTimeout(() => { failure = "timeout"; stop(); }, timeout);
    const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) { failure = "output_limit"; stop(); }
      else chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => { failure = "probe_failed"; });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure || code !== 0) resolveResult({ ok: false, error: { code: failure ?? "probe_failed" } });
      else resolveResult({ ok: true, value: { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() } });
    });
  });
}
