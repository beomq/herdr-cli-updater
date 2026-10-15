import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import type { CatalogRemovalTarget } from "./catalog-removal";
import { AppError } from "./types";

/** Configuration/executable references only; never search conversations, credentials, or logs. */
export function installationReferences(home: string, target: CatalogRemovalTarget): readonly string[] {
  const root = target.kind === 'standalone' ? target.payload : target.kind === "owned" ? target.target : target.kind === "brew" ? target.payloadRoot
    : join(target.target, "node_modules", target.packageName);
  const needles = [root, target.executable];
  const result: string[] = [];
  let count = 0;
  let bytes = 0;
  const buffer = Buffer.alloc(1024 * 1024);
  const patterns = needles.map(needle => Buffer.from(needle));
  const overlap = Math.max(...patterns.map(needle => needle.length)) - 1;
  function visit(path: string, depth: number): void {
    if (++count > 20_000) throw new AppError("unavailable", "reference_scan_incomplete");
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (depth > 32) throw new AppError("unavailable", "reference_scan_incomplete");
      for (const name of readdirSync(path)) {
        if (name.startsWith(".") && name !== ".mcp.json") continue;
        if (["node_modules", "sessions", "transcripts", "logs", "debug", "memory", "runtime", "dist"].includes(name)) continue;
        visit(join(path, name), depth + 1);
      }
      return;
    }
    if (!stat.isFile() || !/\.(?:json|toml|yaml|yml|js|mjs|cjs|sh)$/.test(path)
      || /(?:auth|credential|secret|token)/i.test(path.split("/").at(-1) ?? "")) return;
    if (stat.size > 64 * 1024 * 1024 || bytes + stat.size > 128 * 1024 * 1024)
      throw new AppError("unavailable", "reference_scan_incomplete");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let tail = Buffer.alloc(0), position = 0, matched = false;
    const same = (current:typeof stat) => current.isFile() && current.dev === stat.dev && current.ino === stat.ino
      && current.size === stat.size && current.mtimeMs === stat.mtimeMs && current.ctimeMs === stat.ctimeMs;
    try {
      if (!same(fstatSync(fd))) throw new AppError("unavailable", "reference_scan_incomplete");
      for (;;) {
        const size = readSync(fd, buffer, 0, buffer.length, position);
        if (!size) break;
        position += size; bytes += size;
        if (position > stat.size || bytes > 128 * 1024 * 1024) throw new AppError("unavailable", "reference_scan_incomplete");
        const chunk = Buffer.concat([tail, buffer.subarray(0, size)]);
        if (patterns.some(needle => chunk.includes(needle))) matched = true;
        tail = Buffer.from(chunk.subarray(Math.max(0, chunk.length - overlap)));
      }
      if (position !== stat.size || !same(fstatSync(fd)) || !same(lstatSync(path)))
        throw new AppError("unavailable", "reference_scan_incomplete");
    } finally { closeSync(fd); }
    if (matched) result.push(path);
  }
  for (const relative of [".omo/agent/extensions", ".omo/agent/settings.json", ".pi/agent/extensions", ".pi/agent/settings.json",
    ".omp/agent/extensions", ".omp/agent/settings.json", ".claude/settings.json", ".claude/settings.local.json",
    ".claude/plugins/installed_plugins.json", ".codex/config.toml", ".codex/plugins/cache", ".config/herdr/agents",
    ".config/herdr/plugins.toml", ".config/opencode/opencode.json"]) visit(join(home, relative), 0);
  return result.sort();
}
