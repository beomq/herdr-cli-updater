/** Disposable mechanism parser. Not Anthropic source or genuine resume proof. */
import { isDeepStrictEqual } from "node:util";
import type { CommandSpec, InstallationIdentity } from "../../../../src/adapters/types";

export const fixtureTarget = { version: "2.1.288", sha256: "a".repeat(64) } as const;
export function parseFixture(args: readonly string[]): "version" | "update" | "resume" | null {
  if (isDeepStrictEqual(args, ["--version"])) return "version";
  if (isDeepStrictEqual(args, ["update"])) return "update";
  if (args[0] === "--resume" && /^[a-f0-9-]{36}$/.test(args[1] ?? "")) {
    const options = args.slice(2);
    if (options.length % 2 !== 0) return null;
    for (let i = 0; i < options.length; i += 2) {
      if (!["--model", "--permission-mode"].includes(options[i] ?? "")
        || !/^[A-Za-z0-9._-]+$/.test(options[i + 1] ?? "")) return null;
    }
    return "resume";
  }
  return null;
}
export function fixtureUpdate(installation: InstallationIdentity, manager: string): readonly string[] {
  const owner = installation.owner;
  if (owner.kind === "native" && manager === "native") return ["update"];
  if (owner.kind !== "package" || owner.manager !== manager) return [];
  // Fixture-only grammars. They do not authorize real manager installations.
  switch (manager) {
    case "npm": return ["update", "--global", "--prefix", owner.prefix, owner.packageName, "--channel", installation.channel];
    case "bun": return ["update", "--global", "--cwd", owner.prefix, owner.packageName, "--channel", installation.channel];
    case "homebrew": return ["upgrade", "--cask", owner.packageName, "--prefix", owner.prefix, "--channel", installation.channel];
    default: return [];
  }
}
export function acceptsFixture(
  command: CommandSpec, installation: InstallationIdentity, manager: string,
  target: { readonly version: string; readonly sha256: string } | null,
): boolean {
  if (command.args[0] === "--resume")
    return command.executable === installation.executableRealpath && parseFixture(command.args) === "resume";
  const expected = fixtureUpdate(installation, manager);
  return installation.owner.kind !== "unknown" && isDeepStrictEqual(target, fixtureTarget)
    && expected.length > 0 && command.cwd === installation.owner.prefix
    && isDeepStrictEqual(command.args, expected);
}
