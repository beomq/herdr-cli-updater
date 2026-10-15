import { isAbsolute, join } from "node:path";

const versionPattern = /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]{7}$/;

export function parseCursorOriginalVersion(output) {
  const version = output.trim();
  if (!versionPattern.test(version)) throw new TypeError("Invalid Cursor original version");
  return version;
}

// Returns data only. The parent owns artifact admission, environment replacement,
// write confinement, execution, and observation/reaping of detached cleanup.
export function prepareCursorOriginalUpdate({ executable, home, version, urlPrefix }) {
  if (!isAbsolute(executable) || !isAbsolute(home) || home === "/") {
    throw new TypeError("Original executable and isolated home must be absolute paths");
  }
  if (!versionPattern.test(version)) throw new TypeError("Invalid fixed Cursor version");
  const supply = new URL(urlPrefix);
  if (!["https:", "http:", "file:"].includes(supply.protocol) ||
      supply.username || supply.password || supply.search || supply.hash) {
    throw new TypeError("Cursor supply prefix must be a credential-free base URL");
  }
  const root = join(home, ".local/share/cursor-agent");
  const bin = join(home, ".local/bin");
  return {
    command: executable,
    args: ["install", version, supply.href.replace(/\/$/, "")],
    cwd: home,
    env: {
      HOME: home,
      TMPDIR: join(home, "tmp"),
      PATH: "/usr/bin:/bin",
      AGENT_CLI_CREDENTIAL_STORE: "file",
      CURSOR_CONFIG_DIR: join(home, "config"),
      CURSOR_DATA_DIR: join(home, "data"),
      NODE_COMPILE_CACHE: join(home, "compile-cache"),
    },
    installDirectory: join(root, "versions", version),
    aliases: [join(bin, "agent"), join(bin, "cursor-agent")],
    cursorShim: join(bin, "cursor"),
    writeRoots: [root, bin, join(home, "config"), join(home, "data"),
      join(home, "compile-cache"), join(home, "tmp")],
    detachedCleanup: {
      command: join(root, "versions", version, "cursor-agent"),
      args: ["cleanup-install-versions", version],
    },
  };
}
