// allow: SIZE_OK - Task11 owns exactly one family module; private frozen-contract
// validation and spec construction stay together without editing shared helpers.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { discoverExecutable } from "../discovery";
import type { ProvenancePin } from "../discovery";
import type { CheckResult, FailureCode, RuntimeBinding } from "../protocol";
import type { AdapterResult, FamilyAdapter, InstallationIdentity, RuntimeIdentity } from "./types";

/** These accessors belong to core's private store, never a public capability/UI.
 * Qualification is an independently acquired vendor/installer record, not help output.
 * Absent real records block specs. Fixture records prove mechanisms only.
 * Core must revalidate the spec's complete binding before any process effect.
 */
export type PiQualification = {
  readonly publicationCommit: string;
  readonly tagCommit: string;
  readonly signatureVerified: boolean;
  readonly sourcePins: readonly ProvenancePin[];
};
export type PiRuntimeRecord = {
  readonly runtime: RuntimeIdentity;
  readonly installation: InstallationIdentity;
  readonly sessionPath: string;
  readonly optionsRef: string;
  readonly startupOptionsFingerprint: string;
  readonly options: readonly string[];
};
export type PiCoreRecord = {
  readonly expectedBinding: RuntimeBinding;
  readonly evidenceRef: string;
  readonly workGeneration: number;
  readonly activeWork: {
    readonly root: number; readonly tools: number; readonly subagents: number;
    readonly monitors: number; readonly continuations: number;
  };
  readonly admission: "open" | "fenced";
  readonly claim: null | { readonly operationId: string; readonly ownerTokenRef: string };
};
export type PiUpdateRecord = {
  readonly manager: ProvenancePin;
  readonly release: unknown;
  readonly resourcesFingerprint: string;
  readonly allConsumersKnown: true;
  readonly consumerInstallationIds: readonly string[];
};
export type PiConfiguration = {
  readonly provenance: readonly ProvenancePin[];
  readonly engineManifest: string;
  readonly qualification: () => PiQualification | null;
  readonly release: (channel: string) => Promise<unknown>;
  readonly runtime: (runtimeId: string) => PiRuntimeRecord | null;
  readonly core: (runtimeId: string) => PiCoreRecord | null;
  readonly update: (installationId: string) => PiUpdateRecord | null;
  /** Exact observed package snapshot; never supplies mutation provenance. */
  readonly checkOnly?: InstallationIdentity;
};
const PACKAGE = "@earendil-works/pi-coding-agent";
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$(?![\s\S])/;
const hash = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const fail = <T>(code: FailureCode): AdapterResult<T> => ({ ok: false, error: { code } });
const object = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const absolute = (value: string): value is `/${string}` =>
  value.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(value);
function bytes(path: string, limit = 64 * 1024 * 1024): Buffer {
  if (!absolute(path) || realpathSync(path) !== path || !statSync(path).isFile()
    || statSync(path).size > limit) throw new TypeError("invalid artifact");
  return readFileSync(path);
}
const json = (path: string): unknown => JSON.parse(bytes(path, 65536).toString());
function calver(value: unknown): readonly number[] | null {
  const match = typeof value === "string" ? /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-([2-9]\d*))?$/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)] : null;
}
function boundary<T>(action: () => AdapterResult<T>): AdapterResult<T> {
  // Private producers may throw any value. Never inspect, coerce or log it.
  try { return action(); } catch {
    return fail("verification_failed");
  }
}

export function createPiAdapter(config: PiConfiguration): FamilyAdapter {
  const checkOnly = config.checkOnly ? structuredClone(config.checkOnly) : undefined;
  function packageCurrent(installation: InstallationIdentity): boolean {
    if (!checkOnly || !isDeepStrictEqual(checkOnly, installation) || installation.family !== "pi"
      || installation.owner.kind === "wrapper" || installation.installedVersion.kind !== "known"
      || (installation.owner.kind === "package" && installation.owner.packageName !== PACKAGE)
      || !semver.test(installation.installedVersion.version) || installation.resources.length === 0
      || installation.installationId !== `install:${hash(installation.executableRealpath)}`
      || installation.resourcesFingerprint !== `sha256:${hash(JSON.stringify(installation.resources))}`) return false;
    for (const resource of installation.resources) {
      if (resource.resourceId !== `resource:${hash(resource.realpath)}`
        || resource.fingerprint !== `sha256:${hash(bytes(resource.realpath))}`) return false;
    }
    if (![config.engineManifest, installation.executableRealpath]
      .every(path => installation.resources.some(resource => resource.realpath === path))) return false;
    const engine = json(config.engineManifest);
    return object(engine) && engine["name"] === PACKAGE && engine["version"] === installation.installedVersion.version
      && object(engine["bin"]) && typeof engine["bin"]["pi"] === "string"
      && realpathSync(resolve(dirname(config.engineManifest), engine["bin"]["pi"])) === installation.executableRealpath;
  }
  async function packageCheck(installation: InstallationIdentity): Promise<AdapterResult<CheckResult>> {
    try {
      if (!packageCurrent(installation)) return fail("stale_selection");
      const candidate = release(await config.release("latest"));
      if (!candidate || installation.installedVersion.kind !== "known") return fail("verification_failed");
      if (!packageCurrent(installation)) return fail("stale_selection");
      const installedVersion = installation.installedVersion.version, checkedAt = Date.now();
      const comparison = Bun.semver.order(candidate, installedVersion);
      if (comparison < 0) return fail("verification_failed");
      return { ok: true, value: comparison > 0
        ? { kind: "update-available", installedVersion, availableVersion: candidate, checkedAt }
        : { kind: "up-to-date", installedVersion, checkedAt } };
    } catch { return fail("verification_failed"); }
  }
  function fresh(installation: InstallationIdentity): boolean {
    const pin = config.provenance.length === 1 ? config.provenance[0] : undefined;
    if (!pin || hash(bytes(pin.path, 65536)) !== pin.sha256) return false;
    const receipt = json(pin.path);
    if (!object(receipt) || receipt["family"] !== installation.family
      || receipt["executable"] !== installation.executableRealpath || receipt["channel"] !== installation.channel
      || !isDeepStrictEqual(receipt["owner"], installation.owner) || !Array.isArray(receipt["resources"])
      || installation.installationId !== `install:${hash(installation.executableRealpath)}`
      || installation.resourcesFingerprint !== `sha256:${hash(JSON.stringify(installation.resources))}`
      || installation.resources.length !== receipt["resources"].length + 1
      || new Set(installation.resources.map(row => row.realpath)).size !== installation.resources.length
      || !installation.resources.some(row => row.realpath === pin.path)) return false;
    if (installation.owner.kind === "unknown" || installation.channel !== "latest") return false;
    const prefix = realpathSync(installation.owner.prefix);
    if (prefix !== installation.owner.prefix || installation.resources.some(row =>
      !row.realpath.startsWith(`${prefix}/`) || row.resourceId !== `resource:${hash(row.realpath)}`
      || row.fingerprint !== `sha256:${hash(bytes(row.realpath))}`)) return false;
    if (!receipt["resources"].every((row: unknown) => object(row) && typeof row["path"] === "string"
      && installation.resources.some(resource => resource.realpath === row["path"]
        && resource.fingerprint === `sha256:${row["sha256"]}`))) return false;
    const engine = json(config.engineManifest);
    if (!object(engine) || engine["name"] !== "@code-yeongyu/senpi" || !calver(engine["version"])
      || !object(engine["bin"]) || typeof engine["bin"]["pi"] !== "string"
      || engine["bin"]["pi"] !== engine["bin"]["senpi"]
      || !installation.resources.some(row => row.realpath === config.engineManifest)) return false;
    const engineExecutable = resolve(dirname(config.engineManifest), engine["bin"]["pi"]);
    if (!installation.resources.some(row => row.realpath === engineExecutable)) return false;
    if (installation.family === "omo" && installation.owner.kind === "wrapper") {
      const manifestPath = receipt["packageManifest"];
      if (typeof manifestPath !== "string" || !installation.resources.some(row => row.realpath === manifestPath)) return false;
      const wrapper = json(manifestPath);
      return installation.owner.packageName === "omo-ai" && object(wrapper)
        && wrapper["name"] === "omo-ai" && object(wrapper["dependencies"])
        && wrapper["dependencies"]["@code-yeongyu/senpi"] === engine["version"] && object(wrapper["bin"])
        && typeof wrapper["bin"]["omo"] === "string"
        && resolve(dirname(manifestPath), wrapper["bin"]["omo"]) === installation.executableRealpath
        && isDeepStrictEqual(installation.installedVersion, { kind: "known", version: wrapper["version"] });
    }
    return false;
  }
  function release(value: unknown): string | null {
    return object(value) && value["name"] === PACKAGE && typeof value["version"] === "string"
      && semver.test(value["version"]) && object(value["dist-tags"])
      && value["dist-tags"]["latest"] === value["version"] ? value["version"] : null;
  }
  async function detect(executableRealpath: string): Promise<AdapterResult<InstallationIdentity>> {
    try {
      const found = await discoverExecutable({ executable: executableRealpath, family: "pi", provenance: config.provenance });
      if (!found.ok) return fail(found.error.code === "missing" ? "not_found" : "verification_failed");
      if (found.value.installation.family === "pi") {
        const snapshot = createPiAdapter({ ...config, checkOnly: found.value.installation });
        const current = await snapshot.version(found.value.installation);
        return current.ok ? { ok: true, value: found.value.installation } : current;
      }
      if (found.value.qualification.kind !== "known" || !fresh(found.value.installation)) return fail("verification_failed");
      return { ok: true, value: found.value.installation };
    } catch {
      return fail("verification_failed");
    }
  }
  return {
    family: "pi", detect,
    async version(installation) {
      if (checkOnly) return boundary(() => packageCurrent(installation)
        ? { ok: true, value: installation.installedVersion } : fail("stale_selection"));
      const found = await detect(installation.executableRealpath);
      if (!found.ok) return found;
      return isDeepStrictEqual(found.value, installation) ? { ok: true, value: found.value.installedVersion } : fail("stale_selection");
    },
    async check(installation) {
      if (checkOnly) return packageCheck(installation);
      const found = await detect(installation.executableRealpath);
      if (!found.ok) return found;
      if (!isDeepStrictEqual(found.value, installation)) return fail("stale_selection");
      if (installation.owner.kind === "wrapper") return fail("unsupported");
      return createPiAdapter({ ...config, checkOnly: installation }).check(installation);
    },
    exactResume() { return fail("unsupported"); },
    updateSpec(installation) {
      return boundary(() => fresh(installation) ? fail("unsupported") : fail("stale_selection"));
    },
    bridge() { return fail("unsupported"); },
    gracefulExit() { return fail("unsupported"); },
  };
}
