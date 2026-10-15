import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { createOmoAdapter } from "../adapters/omo";
import { createPiAdapter } from "../adapters/pi";
import type { AdapterResult, FamilyAdapter, InstallationIdentity } from "../adapters/types";
import type { CheckResult, FailureCode, Installation } from "../protocol";
import type { CheckReleaseReceipt, CheckStore } from "./check-store";
import { checkNpmFamilyRelease } from "./npm-family-release";
import { checkNativeFamilyRelease } from "./native-family-release";

// allow: SIZE_OK — the registered single runtime owns one source-fenced check
// operation; transport, source admission and publication cannot be separate owners.
export type CheckSource = {
  readonly installation: InstallationIdentity;
  readonly pins: readonly { readonly path: string; readonly sha256: string; readonly mode: number }[];
  readonly aliases: readonly { readonly path: string; readonly target: string }[];
  readonly packageManifest: string | null;
  readonly engineManifest: string | null;
  readonly managedEngine?: {
    readonly family: "pi";
    readonly installationId: string;
    readonly executableRealpath: string;
    readonly installedVersion: string;
  };
};
export type CheckClock = { readonly now: () => number; readonly monotonic: () => number };
export type CheckRuntimeConfiguration = {
  readonly store: CheckStore;
  /** Source owner/whole-registration refusal, not a callback-issued receipt. */
  readonly admit: (source: CheckSource) => Promise<AdapterResult<null>>;
  /** Private HTTP seam must honor Request.signal; never supplied by a wire command. */
  readonly request?: (request: Request) => Promise<Response>;
  readonly clock?: CheckClock;
  /** Private exact OmO check target; never supplied by a wire command. */
  readonly omoTargetVersion?: string;
};
class CheckError extends Error {
  constructor(readonly code: FailureCode, readonly phase: "source" | "release") { super(code); }
}
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const failure = <T>(code: FailureCode): AdapterResult<T> => ({ ok: false, error: { code } });
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const absolute = (path: string) => path.startsWith("/") && normalize(path) === path && !/[\u0000-\u001f\u007f]/.test(path);
const policy = { origin: "https://registry.npmjs.org", tag: "latest", version: 2 } as const;
function packageName(source: CheckSource): string | null {
  switch (source.installation.family) {
    case "omo": return "omo-ai";
    case "pi": return "@code-yeongyu/senpi";
    case "claude": return "@anthropic-ai/claude-code";
    case "codex": return "@openai/codex";
    case "omp": return "@oh-my-pi/pi-coding-agent";
    case "agy": case "cursor": case "grok": return null;
    default: return unreachable(source.installation.family);
  }
}
function unreachable(_value: never): never { throw new CheckError("verification_failed", "source"); }
/** Complete ordered snapshot: no installationId-only cache or inferred owner. */
export function checkSubjectKey(source: CheckSource, omoTargetVersion?: string): string {
  return hash(JSON.stringify({ source, policy: { ...policy, packageName: packageName(source),
    ...(source.installation.family === "omo" && omoTargetVersion !== undefined ? { targetVersion: omoTargetVersion } : {}) } }));
}
function timestamp(clock: CheckClock): number {
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new CheckError("verification_failed", "source");
  return now;
}
function bound(path: string, source: CheckSource): string {
  const canonical = realpathSync(path);
  if (canonical !== path && !source.aliases.some(edge => {
    const suffix = relative(edge.path, path);
    return suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("/")
      && resolve(edge.target, suffix) === canonical;
  })) throw new CheckError("verification_failed", "source");
  return canonical;
}
function verify(source: CheckSource, fence: () => void, packageCheck = true): void {
  fence();
  const installation = source.installation;
  if (source.pins.length === 0 || source.pins.length > 1024 || source.aliases.length > 1024
    || new Set(source.pins.map(pin => pin.path)).size !== source.pins.length
    || new Set(source.aliases.map(alias => alias.path)).size !== source.aliases.length
    || installation.installationId !== `install:${hash(installation.executableRealpath)}`
    || installation.resourcesFingerprint !== `sha256:${hash(JSON.stringify(installation.resources))}`)
    throw new CheckError("verification_failed", "source");
  for (const pin of source.pins) {
    fence();
    if (!absolute(pin.path) || realpathSync(pin.path) !== pin.path || !/^[a-f0-9]{64}$/.test(pin.sha256))
      throw new CheckError("verification_failed", "source");
    const before = lstatSync(pin.path, { bigint: true }), uid = BigInt(process.getuid?.() ?? -1);
    if (!before.isFile() || before.nlink !== 1n || (before.uid !== uid && before.uid !== 0n)
      || (before.mode & 0o022n) !== 0n || Number(before.mode & 0o7777n) !== pin.mode
      || before.size > 512n * 1024n * 1024n) throw new CheckError("verification_failed", "source");
    const fd = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const digest = createHash("sha256"), buffer = Buffer.alloc(65536);
      for (let offset = 0; offset < Number(before.size);) {
        fence();
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
        if (count === 0) throw new CheckError("stale_selection", "source");
        digest.update(buffer.subarray(0, count)); offset += count;
      }
      const opened = fstatSync(fd, { bigint: true }), after = lstatSync(pin.path, { bigint: true });
      if ([opened, after].some(info => info.dev !== before.dev || info.ino !== before.ino
        || info.size !== before.size || info.mode !== before.mode || info.mtimeNs !== before.mtimeNs
        || info.ctimeNs !== before.ctimeNs) || digest.digest("hex") !== pin.sha256
        || realpathSync(pin.path) !== pin.path) throw new CheckError("stale_selection", "source");
    } finally { closeSync(fd); }
  }
  for (const resource of installation.resources) {
    if (resource.resourceId !== `resource:${hash(resource.realpath)}`
      || !source.pins.some(pin => pin.path === resource.realpath && resource.fingerprint === `sha256:${pin.sha256}`))
      throw new CheckError("verification_failed", "source");
  }
  for (const alias of source.aliases) {
    fence();
    const info = lstatSync(alias.path);
    if (!absolute(alias.path) || !absolute(alias.target)
      || (info.uid !== process.getuid?.() && info.uid !== 0)
      || realpathSync(alias.path) !== alias.target)
      throw new CheckError("stale_selection", "source");
  }
  if (![installation.executableRealpath, source.packageManifest, source.engineManifest]
    .filter(path => path !== null).every(path => source.pins.some(pin => pin.path === path)))
    throw new CheckError("verification_failed", "source");
  if (packageCheck && packageName(source) !== null && source.packageManifest !== null
    && installation.installedVersion.kind === "known") {
    if (lstatSync(source.packageManifest).size > 262144) throw new CheckError("verification_failed", "source");
    const manifest: unknown = JSON.parse(readFileSync(source.packageManifest, "utf8"));
    const binName = installation.family === "omo" ? "omo" : installation.family === "pi" ? "pi" : installation.family;
    const entry = object(manifest) && (typeof manifest["bin"] === "string" ? manifest["bin"]
      : object(manifest["bin"]) ? manifest["bin"][binName] : undefined);
    if (!object(manifest) || manifest["name"] !== packageName(source)
      || manifest["version"] !== installation.installedVersion.version || typeof entry !== "string"
      || bound(resolve(dirname(source.packageManifest), entry), source) !== installation.executableRealpath)
      throw new CheckError("verification_failed", "source");
    const engineManifest = source.engineManifest;
    if (installation.family === "omo" && engineManifest !== null) {
      let dependency = false;
      for (let parent = dirname(source.packageManifest), level = 0; level < 16; level++, parent = dirname(parent)) {
        try {
          dependency = bound(join(parent, "node_modules", "@code-yeongyu", "senpi", "package.json"), source) === engineManifest;
          break;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (parent === dirname(parent)) break;
      }
      if (lstatSync(engineManifest).size > 262144) throw new CheckError("verification_failed", "source");
      const engine: unknown = JSON.parse(readFileSync(engineManifest, "utf8"));
      const engineBin = object(engine) && object(engine["bin"]) ? engine["bin"] : null;
      const engineEntry = engineBin && typeof engineBin["pi"] === "string" && engineBin["pi"] === engineBin["senpi"]
        ? engineBin["pi"] : null;
      if (!dependency || !object(engine) || engine["name"] !== "@code-yeongyu/senpi"
        || !object(manifest["dependencies"]) || manifest["dependencies"]["@code-yeongyu/senpi"] !== engine["version"]
        || engineEntry === null
        || !source.pins.some(pin => pin.path === bound(resolve(dirname(engineManifest), engineEntry), source)))
        throw new CheckError("verification_failed", "source");
      const managed = source.managedEngine;
      if (managed && (managed.family !== "pi" || managed.installationId !== `install:${hash(managed.executableRealpath)}`
        || managed.executableRealpath !== bound(resolve(dirname(engineManifest), engineEntry), source)
        || managed.installedVersion !== engine["version"]))
        throw new CheckError("verification_failed", "source");
    }
  }
  fence();
}
async function waiting<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(new CheckError("receipt_uncertain", "release"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try { return await Promise.race([promise, aborted.promise]); }
  finally { signal.removeEventListener("abort", abort); }
}
function safeFailure(error: unknown, signal: AbortSignal): CheckError {
  if (error instanceof CheckError) return error;
  if (signal.aborted) return new CheckError("resources_busy", "source");
  if (error instanceof SyntaxError || error instanceof TypeError
    || (error instanceof Error && "code" in error
      && ["ENOENT", "EACCES", "ELOOP", "ENOTDIR"].includes(String(error.code))))
    return new CheckError("verification_failed", "source");
  throw error;
}
export function createCheckRuntime(configuration: CheckRuntimeConfiguration) {
  const omoTargetVersion = configuration.omoTargetVersion;
  const clock = configuration.clock ?? { now: Date.now, monotonic: performance.now.bind(performance) };
  const request = configuration.request ?? ((input: Request) => fetch(input, { credentials: "omit", redirect: "error" }));
  const active = new Map<string, Promise<AdapterResult<CheckResult>>>();
  async function run(source: CheckSource, signal: AbortSignal): Promise<AdapterResult<CheckResult>> {
    const deadline = clock.monotonic() + 3500;
    const fence = () => {
      if (signal.aborted || clock.monotonic() >= deadline) throw new CheckError("resources_busy", "source");
    };
    const metadata: CheckReleaseReceipt[] = [];
    try {
      const admitted = await waiting(configuration.admit(source), signal);
      if (!admitted.ok) return admitted;
      verify(source, fence);
      let result: CheckResult;
      const name = packageName(source);
      if (source.installation.installedVersion.kind === "unknown"
        || ((source.installation.family === "omo" || source.installation.family === "pi") && source.packageManifest === null)
        || (source.installation.family === "omo" && source.engineManifest === null)) {
        result = { kind: "unavailable", failure: { code: "unsupported" }, checkedAt: timestamp(clock) };
      } else {
        const httpSignal = AbortSignal.any([signal, AbortSignal.timeout(1500)]);
        let releaseFailure: FailureCode | undefined;
        let sourceFailure: CheckError | undefined;
        let unexpectedRelease: { readonly error: unknown } | undefined;
        const read = async (url: string, options?: { readonly method: "POST"; readonly body: string }): Promise<unknown> => {
          try {
            const method = options?.method ?? "GET";
            const response = await waiting(request(new Request(url, { method, credentials: "omit",
              redirect: "error", headers: { Accept: "application/json, text/plain", "User-Agent": "herdr-cli-updater" },
              signal: httpSignal, ...(options ? { body: options.body,
                headers: { Accept: "application/json", "Content-Type": "application/json",
                  "Connect-Protocol-Version": "1", "User-Agent": "herdr-cli-updater" } } : {}) })), httpSignal);
            if (response.redirected || !response.body)
              throw new CheckError("receipt_uncertain", "release");
            const reader = response.body.getReader(), chunks: Uint8Array[] = [];
            let size = 0;
            try {
              for (;;) {
                const next = await waiting(reader.read(), httpSignal);
                if (next.done) break;
                size += next.value.byteLength;
                if (size > 1024 * 1024) throw new CheckError("verification_failed", "release");
                chunks.push(next.value);
              }
            } finally {
              try { await reader.cancel(); }
              finally { reader.releaseLock(); }
            }
            const body = Buffer.concat(chunks);
            metadata.push({ origin: url, method, status: response.status,
              bodyDigest: hash(body), acquiredAt: timestamp(clock) });
            if (response.status !== 200) throw new CheckError("receipt_uncertain", "release");
            try {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
              const hostname = new URL(url).hostname;
              return hostname === "downloads.claude.ai" || hostname === "x.ai" || hostname === "cursor.com"
                ? text : JSON.parse(text);
            }
            catch (error) {
              if (error instanceof SyntaxError || error instanceof TypeError)
                throw new CheckError("verification_failed", "release");
              throw error;
            }
          } catch (error) {
            if (error instanceof CheckError) throw error;
            if (httpSignal.aborted || error instanceof TypeError
              || (error instanceof Error && "code" in error))
              throw new CheckError("receipt_uncertain", "release");
            throw error;
          }
        };
        const release = async (): Promise<unknown> => {
          try {
            if (name === null) throw new CheckError("unsupported", "release");
            const targetVersion = source.installation.family === "omo" ? omoTargetVersion : undefined;
            if (targetVersion !== undefined
              && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(targetVersion))
              throw new CheckError("verification_failed", "release");
            const encoded = encodeURIComponent(name);
            const tags = await read(`${policy.origin}/-/package/${encoded}/dist-tags`);
            const afterTags = await waiting(configuration.admit(source), signal);
            if (!afterTags.ok) throw new CheckError(afterTags.error.code, "source");
            verify(source, fence);
            if (!object(tags) || typeof tags["latest"] !== "string"
              || !/^[0-9][A-Za-z0-9.+-]{0,127}$/.test(tags["latest"])) throw new CheckError("verification_failed", "release");
            const requestedVersion = targetVersion ?? tags["latest"];
            const version = await read(`${policy.origin}/${encoded}/${encodeURIComponent(requestedVersion)}`);
            const afterVersion = await waiting(configuration.admit(source), signal);
            if (!afterVersion.ok) throw new CheckError(afterVersion.error.code, "source");
            verify(source, fence);
            if (!object(version) || version["name"] !== name || version["version"] !== requestedVersion)
              throw new CheckError("verification_failed", "release");
            return { name, version: version["version"], "dist-tags": tags };
          } catch (error) {
            if (error instanceof CheckError) {
              if (error.phase === "source") sourceFailure = error;
              else releaseFailure = error.code;
            }
            else unexpectedRelease = { error };
            throw error;
          }
        };
        if (source.installation.family === "claude" || source.installation.family === "codex"
          || source.installation.family === "omp") {
          try { result = await checkNpmFamilyRelease(source.installation, read, timestamp(clock)); }
          catch (error) {
            if (error instanceof CheckError) throw error;
            if (!(error instanceof TypeError)) throw error;
            throw new CheckError("verification_failed", "release");
          }
        } else if (source.installation.family === "cursor" || source.installation.family === "agy"
          || source.installation.family === "grok") {
          try { result = await checkNativeFamilyRelease(source.installation, read, timestamp(clock)); }
          catch (error) {
            if (error instanceof CheckError) throw error;
            if (!(error instanceof TypeError)) throw error;
            throw new CheckError("verification_failed", "release");
          }
        } else {
          if (source.packageManifest === null) throw new CheckError("verification_failed", "source");
          let adapter: FamilyAdapter;
          switch (source.installation.family) {
            case "omo":
              if (source.engineManifest === null) throw new CheckError("verification_failed", "source");
              adapter = createOmoAdapter({ provenance: [], wrapperManifest: source.packageManifest,
                engineManifest: source.engineManifest, release, runtime: () => null, core: () => null,
                checkOnly: source.installation, ...(omoTargetVersion !== undefined ? { targetVersion: omoTargetVersion } : {}) });
              break;
            case "pi":
              adapter = createPiAdapter({ provenance: [], engineManifest: source.packageManifest, release,
                qualification: () => null, runtime: () => null, core: () => null, update: () => null,
                checkOnly: source.installation });
              break;
            default: return unreachable(source.installation.family);
          }
          const checked = await adapter.check(source.installation);
          if (sourceFailure) throw sourceFailure;
          if (unexpectedRelease) throw unexpectedRelease.error;
          result = checked.ok ? { ...checked.value, checkedAt: timestamp(clock) }
            : { kind: "unavailable", failure: { code: releaseFailure ?? checked.error.code }, checkedAt: timestamp(clock) };
        }
      }
      const finalAdmission = await waiting(configuration.admit(source), signal);
      if (!finalAdmission.ok) return finalAdmission;
      verify(source, fence);
      result = { ...result, checkedAt: timestamp(clock) };
      const committed = await configuration.store.put({ subjectKey: checkSubjectKey(source, omoTargetVersion),
        installedVersion: source.installation.installedVersion, checkedAt: result.checkedAt, result, metadata });
      if (!committed.ok) return committed;
      const published = await waiting(configuration.admit(source), signal);
      if (!published.ok) return published;
      verify(source, fence);
      return { ok: true, value: result };
    } catch (error) {
      const failed = safeFailure(error, signal);
      return failure(failed.code);
    }
  }
  return {
    check(source: CheckSource, signal = new AbortController().signal): Promise<AdapterResult<CheckResult>> {
      let captured: CheckSource;
      try { captured = structuredClone(source); }
      catch (error) { return Promise.resolve(failure(safeFailure(error, signal).code)); }
      const key = checkSubjectKey(captured, omoTargetVersion), existing = active.get(key);
      if (existing) return existing;
      if (active.size >= 64) return Promise.resolve(failure("resources_busy"));
      const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
      const work = run(captured, operationSignal);
      // A bounded reply does not retire a still-owned reader cancellation.
      const reply = waiting(work, operationSignal).catch((error: unknown) => {
        if (operationSignal.aborted) return failure<CheckResult>("resources_busy");
        throw error;
      });
      active.set(key, reply);
      void work.then(() => active.delete(key), () => active.delete(key));
      return reply;
    },
    async lastCheck(source: CheckSource): Promise<AdapterResult<Installation["lastCheck"]>> {
      const captured = structuredClone(source), signal = new AbortController().signal;
      const deadline = clock.monotonic() + 3500;
      const fence = () => {
        if (clock.monotonic() >= deadline) throw new CheckError("resources_busy", "source");
      };
      try {
        const admitted = await configuration.admit(captured);
        if (!admitted.ok) return admitted;
        verify(captured, fence, false);
        const stored = await configuration.store.get(checkSubjectKey(captured, omoTargetVersion));
        if (!stored.ok) return stored;
        const final = await configuration.admit(captured);
        if (!final.ok) return final;
        verify(captured, fence, stored.value !== null);
        return { ok: true, value: stored.value ? { checkedAt: stored.value.checkedAt, result: stored.value.result } : null };
      } catch (error) { return failure(safeFailure(error, signal).code); }
    },
  };
}
