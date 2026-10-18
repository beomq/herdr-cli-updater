import { compare, valid } from "semver";
import { PACKAGE_NAME } from "../config.js";
import { brandProfile, envValue } from "../core/brand.js";
import { fetchWithRetry } from "./management-http.js";
import { getPiUserAgent } from "./pi-user-agent.js";
const REGISTRY_BASE_URL = "https://registry.npmjs.org";
const LATEST_VERSION_URL = `${REGISTRY_BASE_URL}/${encodeURIComponent(PACKAGE_NAME)}/latest`;
/** Registry endpoint answering "what version does this product publish right now?". */
function latestVersionUrl(channel) {
    return channel
        ? `${REGISTRY_BASE_URL}/-/package/${encodeURIComponent(channel.packageName)}/dist-tags`
        : LATEST_VERSION_URL;
}
/** Reads the available version out of whichever registry document was fetched. */
export function readAvailableVersion(payload, channel) {
    if (typeof payload !== "object" || payload === null)
        return undefined;
    const source = payload;
    const raw = channel ? source[channel.distTag] : source.version;
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;
const RELEASE_CHANGELOG_BASE_URL = "https://github.com/code-yeongyu/senpi/blob";
const RELEASE_CHANGELOG_PATH = "packages/coding-agent/CHANGELOG.md";
const SENPI_CALVER_PATTERN = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-([2-9]\d*))?$/;
function parseSenpiCalVer(version) {
    const match = SENPI_CALVER_PATTERN.exec(version);
    if (!match) {
        return undefined;
    }
    return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)];
}
/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error) {
    const rootMessage = error instanceof Error && error.message ? error.message : String(error);
    const cause = error instanceof Error ? error.cause : undefined;
    const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
    const codes = causes
        .map((value) => typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
        ? value.code
        : undefined)
        .filter((code) => code !== undefined);
    if (codes.length > 0)
        return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
    const causeMessage = causes.find((value) => value instanceof Error && Boolean(value.message))?.message;
    return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}
export function comparePackageVersions(leftVersion, rightVersion) {
    const leftTrimmed = leftVersion.trim();
    const rightTrimmed = rightVersion.trim();
    const leftCalVer = parseSenpiCalVer(leftTrimmed);
    const rightCalVer = parseSenpiCalVer(rightTrimmed);
    if (leftCalVer && rightCalVer) {
        for (let index = 0; index < leftCalVer.length; index++) {
            if (leftCalVer[index] !== rightCalVer[index]) {
                return leftCalVer[index] < rightCalVer[index] ? -1 : 1;
            }
        }
        return 0;
    }
    const left = valid(leftTrimmed);
    const right = valid(rightTrimmed);
    if (!left || !right) {
        return undefined;
    }
    return compare(left, right);
}
export function isNewerPackageVersion(candidateVersion, currentVersion) {
    const comparison = comparePackageVersions(candidateVersion, currentVersion);
    // Unparseable pairs (e.g. branded build labels) are never "newer": an update
    // we cannot order is not one we can advertise.
    return comparison !== undefined && comparison > 0;
}
export function getReleaseChangelogUrl(version) {
    const trimmedVersion = version.trim();
    const channel = brandProfile()?.update;
    if (channel?.changelogUrl) {
        return channel.changelogUrl.replace("{version}", trimmedVersion);
    }
    const tag = trimmedVersion.startsWith("v") ? trimmedVersion : `v${trimmedVersion}`;
    return `${RELEASE_CHANGELOG_BASE_URL}/${tag}/${RELEASE_CHANGELOG_PATH}`;
}
export async function getLatestPiRelease(currentVersion, options = {}) {
    if (envValue("OFFLINE"))
        return undefined;
    const brand = brandProfile();
    const channel = brand?.update;
    if (brand && !channel) {
        // The engine's own releases are not installable from inside a branded distribution, so
        // advertising them would send the user after an update they cannot apply.
        return undefined;
    }
    const response = await fetchWithRetry(latestVersionUrl(channel), {
        headers: {
            "User-Agent": getPiUserAgent(currentVersion),
            accept: "application/json",
        },
    }, {
        maxRetries: options.retry ? 2 : 0,
        timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
    });
    if (!response.ok)
        return undefined;
    const data = (await response.json());
    const availableVersion = readAvailableVersion(data, channel);
    if (!availableVersion) {
        return undefined;
    }
    if (channel) {
        return { version: availableVersion, packageName: channel.packageName };
    }
    const packageName = typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
    const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
    return { version: availableVersion, packageName, note };
}
export async function getLatestPiVersion(currentVersion, options = {}) {
    return (await getLatestPiRelease(currentVersion, options))?.version;
}
export async function checkForNewPiVersion(currentVersion) {
    if (envValue("SKIP_VERSION_CHECK"))
        return undefined;
    try {
        const latestRelease = await getLatestPiRelease(currentVersion);
        if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
            return latestRelease;
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=version-check.js.map
