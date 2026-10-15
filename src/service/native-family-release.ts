import { AGY_INSTALLER_SHA256, AGY_MANIFEST_CHANNEL } from "../adapters/agy";
import type { InstallationIdentity } from "../adapters/types";
import type { CheckResult, FailureCode } from "../protocol";

const grokPackage = "@xai-official/grok";
const grokRegistry = `https://registry.npmjs.org/${encodeURIComponent(grokPackage)}`;
const grokTags = `https://registry.npmjs.org/-/package/${encodeURIComponent(grokPackage)}/dist-tags`;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*))?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/;
const cursorEndpoint = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function semver(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const match = releaseVersion.exec(value);
  return match !== null && !(match[4]?.split(".").some(part => /^\d+$/.test(part)
    && part.length > 1 && part.startsWith("0")) ?? false);
}
function cursorVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 18
    || !/^\d{4}\.\d{2}\.\d{2}-[a-f0-9]{7}$/.test(value)) return false;
  const date = value.slice(0, 10).replaceAll(".", "-");
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
function unavailable(code: FailureCode, checkedAt: number): CheckResult {
  return { kind: "unavailable", failure: { code }, checkedAt };
}
// Bun's comparator truncates oversized numeric components. Compare validated
// SemVer integers exactly, including numeric prerelease identifiers.
function order(left: string, right: string): number {
  const a = releaseVersion.exec(left), b = releaseVersion.exec(right);
  if (!a || !b) throw new TypeError("invalid_semver");
  for (let index = 1; index <= 3; index++) {
    const x = a[index], y = b[index];
    if (x === undefined || y === undefined) throw new TypeError("invalid_semver");
    if (BigInt(x) !== BigInt(y)) return BigInt(x) > BigInt(y) ? 1 : -1;
  }
  const preA = a[4], preB = b[4];
  if (preA === undefined || preB === undefined)
    return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const partsA = preA.split("."), partsB = preB.split(".");
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index++) {
    const x = partsA[index], y = partsB[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numericA = /^\d+$/.test(x), numericB = /^\d+$/.test(y);
    if (numericA && numericB) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
function compare(installed: string, available: string, checkedAt: number): CheckResult {
  const comparison = order(available, installed);
  if (comparison < 0) return unavailable("verification_failed", checkedAt);
  return comparison === 0 ? { kind: "up-to-date", installedVersion: installed, checkedAt }
    : { kind: "update-available", installedVersion: installed, availableVersion: available, checkedAt };
}

/** Public comparison only. The parent binds installedVersion to observed bytes
 * or package metadata and owns bounded HTTP, timeouts and source revalidation.
 * No result here authenticates an owner or authorizes an update.
 */
export async function checkNativeFamilyRelease(
  installation: InstallationIdentity,
  read: (url: string, request?: { readonly method: "POST"; readonly body: string }) => Promise<unknown>,
  checkedAt: number,
): Promise<CheckResult> {
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0)
    return unavailable("malformed_request", checkedAt);
  if (installation.installedVersion.kind !== "known")
    return unavailable("receipt_uncertain", checkedAt);
  const installed = installation.installedVersion.version;
  // Public-reader boundary: do not inspect unknown thrown values.
  try {
    switch (installation.family) {
      case "agy": {
        if (installation.owner.kind !== "native")
          return unavailable("receipt_uncertain", checkedAt);
        if (installation.owner.installerDigest !== `sha256:${AGY_INSTALLER_SHA256}`
          || installation.channel !== AGY_MANIFEST_CHANNEL)
          return unavailable("identity_mismatch", checkedAt);
        if (!stableVersion.test(installed) || !semver(installed))
          return unavailable("verification_failed", checkedAt);
        // Verified darwin_arm64 manifest: version, version-bound artifact URL,
        // and lowercase hex SHA512; not the installer script's version.
        const manifest = await read(AGY_MANIFEST_CHANNEL);
        if (!object(manifest) || Object.keys(manifest).sort().join(",") !== "sha512,url,version"
          || typeof manifest["version"] !== "string"
          || !stableVersion.test(manifest["version"]) || !semver(manifest["version"])
          || typeof manifest["sha512"] !== "string" || !/^[a-f0-9]{128}$/.test(manifest["sha512"])
          || typeof manifest["url"] !== "string"
          || !new RegExp(`^https://storage\\.googleapis\\.com/antigravity-public/antigravity-cli/${manifest["version"].replaceAll(".", "\\.")}-[0-9]+/darwin-arm/cli_mac_arm64\\.tar\\.gz$`).test(manifest["url"]))
          return unavailable("verification_failed", checkedAt);
        return compare(installed, manifest["version"], checkedAt);
      }
      case "grok": {
        if (!semver(installed)) return unavailable("verification_failed", checkedAt);
        const channel = installation.channel, owner = installation.owner;
        if (!["unknown", "stable", "alpha"].includes(channel) && !(channel === "latest" && owner.kind !== "native"))
          return unavailable("unsupported", checkedAt);
        if (owner.kind === "native") {
          if (channel === "unknown") return unavailable("receipt_uncertain", checkedAt);
          const stable = await read("https://x.ai/cli/stable");
          if (typeof stable !== "string" || !semver(stable.trim()))
            return unavailable("verification_failed", checkedAt);
          let available = stable.trim();
          if (channel === "alpha") {
            const alpha = await read("https://x.ai/cli/alpha");
            if (typeof alpha !== "string" || !semver(alpha.trim()))
              return unavailable("verification_failed", checkedAt);
            if (order(alpha.trim(), available) > 0) available = alpha.trim();
          }
          return compare(installed, available, checkedAt);
        }
        if (owner.kind !== "unknown" && !(owner.kind === "package"
          && owner.manager === "npm" && owner.packageName === grokPackage))
          return unavailable("identity_mismatch", checkedAt);
        // Unknown owner remains unknown: compare a genuinely bound Grok version
        // against the public npm default, not an inferred native channel.
        const tags = await read(grokTags), latest = await read(`${grokRegistry}/latest`);
        if (!object(tags) || !semver(tags["latest"]) || !object(latest)
          || latest["name"] !== grokPackage || latest["version"] !== tags["latest"])
          return unavailable("verification_failed", checkedAt);
        let available = tags["latest"];
        if (channel === "alpha") {
          if (!semver(tags["alpha"])) return unavailable("verification_failed", checkedAt);
          if (order(tags["alpha"], available) > 0) {
            available = tags["alpha"];
            const alpha = await read(`${grokRegistry}/${encodeURIComponent(available)}`);
            if (!object(alpha) || alpha["name"] !== grokPackage || alpha["version"] !== available)
              return unavailable("verification_failed", checkedAt);
          }
        }
        return compare(installed, available, checkedAt);
      }
      case "cursor": {
        // Official 2026.01.23-916f423 update-core calls
        // POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl
        // with {channel}; prod-stable-internal maps to prod, static skips checks.
        // Public POST returns {url,version}; ordinary and Connect GET return 405.
        // cursor.com/install's downloads.cursor.com/lab path is a distribution
        // location, NOT evidence of the installation's effective channel.
        const channel = installation.channel;
        if (channel === "unknown") return unavailable("receipt_uncertain", checkedAt);
        if (!["prod", "lab", "staging", "prod-stable-internal"].includes(channel))
          return unavailable("unsupported", checkedAt);
        if (!cursorVersion(installed)) return unavailable("verification_failed", checkedAt);
        const release = await read(cursorEndpoint, { method: "POST",
          body: JSON.stringify({ channel: channel === "prod-stable-internal" ? "prod" : channel }) });
        if (!object(release) || !cursorVersion(release["version"])
          || release["url"] !== `https://downloads.cursor.com/lab/${release["version"]}/`)
          return unavailable("verification_failed", checkedAt);
        const available = release["version"];
        if (available.slice(0, 10) < installed.slice(0, 10))
          return unavailable("verification_failed", checkedAt);
        // Hashes are identifiers, not ordered numbers. On the same date the
        // official channel's different hash is the manual updater's new target.
        return available === installed ? { kind: "up-to-date", installedVersion: installed, checkedAt }
          : { kind: "update-available", installedVersion: installed, availableVersion: available, checkedAt };
      }
      case "omo": case "omp": case "pi": case "claude": case "codex":
        return unavailable("unsupported", checkedAt);
      default: {
        const exhaustive: never = installation.family;
        return exhaustive;
      }
    }
  } catch {
    return unavailable("receipt_uncertain", checkedAt);
  }
}
