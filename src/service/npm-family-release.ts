import type { InstallationIdentity } from "../adapters/types";
import type { CheckResult } from "../protocol";

const registry = "https://registry.npmjs.org";
const claudeReleases = "https://downloads.claude.ai/claude-code-releases";
const codexRelease = "https://api.github.com/repos/openai/codex/releases/latest";
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stable(value: unknown): readonly [number, number, number] {
  if (typeof value !== "string" || value.length > 128 || /[\r\n]/.test(value)
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new TypeError("verification_failed");
  const [major, minor, patch] = value.split(".").map(Number);
  if (major === undefined || minor === undefined || patch === undefined
    || ![major, minor, patch].every(Number.isSafeInteger))
    throw new TypeError("verification_failed");
  return [major, minor, patch];
}

/** Source admission and bounded HTTP acquisition belong to CheckRuntime.
 * This comparison never grants update authority or rewrites the captured channel.
 */
export async function checkNpmFamilyRelease(installation: InstallationIdentity,
  read: (url: string) => Promise<unknown>, checkedAt: number): Promise<CheckResult> {
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) throw new TypeError("verification_failed");
  const unsupported: CheckResult = { kind: "unavailable", failure: { code: "unsupported" }, checkedAt };
  const owner = installation.owner;
  let name: string;
  let native = false;
  switch (installation.family) {
    case "claude":
      name = "@anthropic-ai/claude-code";
      native = owner.kind === "native";
      if (native ? !["stable", "latest"].includes(installation.channel)
        : !["latest", "unknown"].includes(installation.channel))
        return unsupported;
      break;
    case "codex":
      name = "@openai/codex";
      if (!["stable/npm-latest", "latest", "unknown"].includes(installation.channel)) return unsupported;
      break;
    case "omp":
      name = "@oh-my-pi/pi-coding-agent";
      if (!["stable", "latest", "unknown"].includes(installation.channel)) return unsupported;
      break;
    case "omo": case "pi": case "agy": case "cursor": case "grok": return unsupported;
    default: return unreachable(installation.family);
  }
  // Source-fenced official package lookup does not require mutation ownership.
  if (!native && owner.kind !== "unknown" && (owner.kind !== "package"
    || !["npm", "bun"].includes(owner.manager) || owner.packageName !== name)) return unsupported;
  if (installation.installedVersion.kind !== "known") throw new TypeError("verification_failed");
  const installedVersion = installation.installedVersion.version;
  const installed = stable(installedVersion);
  let availableVersion: string;
  if (native) {
    const release = await read(`${claudeReleases}/${installation.channel}`);
    // Official channel endpoints are text, optionally terminated by one newline.
    if (typeof release !== "string") throw new TypeError("verification_failed");
    availableVersion = release.replace(/\r?\n$/, "");
    stable(availableVersion);
  } else {
    const encoded = encodeURIComponent(name);
    const latest = await read(`${registry}/${encoded}/latest`);
    if (!object(latest) || latest["name"] !== name || typeof latest["version"] !== "string")
      throw new TypeError("verification_failed");
    availableVersion = latest["version"];
    stable(availableVersion);
    const tags = await read(`${registry}/-/package/${encoded}/dist-tags`);
    if (!object(tags) || tags["latest"] !== availableVersion) throw new TypeError("verification_failed");
    if (installation.family === "codex") {
      const github = await read(codexRelease);
      if (!object(github) || github["tag_name"] !== `rust-v${availableVersion}`
        || github["draft"] !== false || github["prerelease"] !== false)
        throw new TypeError("verification_failed");
    }
  }
  const available = stable(availableVersion);
  const order = available[0] - installed[0] || available[1] - installed[1] || available[2] - installed[2];
  return order > 0
    ? { kind: "update-available", installedVersion, availableVersion, checkedAt }
    : { kind: "up-to-date", installedVersion, checkedAt };
}
function unreachable(_value: never): never { throw new TypeError("verification_failed"); }
