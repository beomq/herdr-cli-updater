import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Remove only producer-owned scratch, never installation or receipt files. */
export function releasePreparationScratch(root: string): void {
  const owner = lstatSync(root);
  if (realpathSync(root) !== root || !owner.isDirectory() || owner.uid !== process.getuid?.()
    || (owner.mode & 0o022) !== 0) throw new TypeError("noncanonical preparation root");
  for (const name of ["resolve", "calibration-a", "calibration-b"]) {
    const scope = join(root, name), info = lstatSync(scope, { throwIfNoEntry: false });
    if (!info) continue;
    if (!info.isDirectory() || realpathSync(scope) !== scope) throw new TypeError("unsafe preparation scratch");
    // npm keeps its command logs in the scope; OmO keeps them at root.
    for (const child of ["prefix", "cache", "tmp", "home"]) {
      const path = join(scope, child);
      if (lstatSync(path, { throwIfNoEntry: false })) rmSync(path, { recursive: true });
    }
  }
}

export function releaseFailedPreparation(root: string): void {
  releasePreparationScratch(root);
  if (["omo-runtime.json", "package-runtime.json"].some(name => lstatSync(join(root, name), { throwIfNoEntry: false }))) return;
  const acquired = join(root, "acquired");
  if (lstatSync(acquired, { throwIfNoEntry: false })) rmSync(acquired, { recursive: true });
}

/** Keep registered preparations plus the newest previous success per install.
 * Failed attempts retain diagnostics, not downloads or installation clones.
 * The caller must hold the preparation lock and have an empty worker. */
export function retainPreparations(parent: string, protectedRoots: readonly string[]): void {
  const keep = new Set(protectedRoots);
  const parentInfo = lstatSync(parent);
  if (realpathSync(parent) !== parent || parentInfo.uid !== process.getuid?.()
    || (parentInfo.mode & 0o022) !== 0) throw new TypeError("noncanonical preparations parent");
  const entries = readdirSync(parent, { withFileTypes: true }).filter(entry => /^(omo|npm)-[A-Za-z0-9]+$/.test(entry.name));
  // Validate every deletion boundary before removing anything.
  for (const entry of entries) {
    const root = join(parent, entry.name);
    if (!entry.isDirectory() || realpathSync(root) !== root) throw new TypeError("unsafe preparation entry");
    for (const name of ["resolve", "calibration-a", "calibration-b", "acquired"]) {
      const path = join(root, name), info = lstatSync(path, { throwIfNoEntry: false });
      if (info && (!info.isDirectory() || realpathSync(path) !== path)) throw new TypeError("unsafe preparation entry");
    }
  }
  const previous = new Map<string, { readonly root: string; readonly time: number }>();
  for (const entry of entries) {
    const root = join(parent, entry.name), file = join(root, "qualification.json");
    if (!entry.isDirectory() || realpathSync(root) !== root) throw new TypeError("unsafe preparation entry");
    if (keep.has(root) || !lstatSync(file, { throwIfNoEntry: false })) continue;
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || !("installation" in value) || !("target" in value))
      throw new TypeError("invalid preparation qualification");
    const installation = value.installation, target = value.target;
    if (typeof installation !== "object" || installation === null || !("installationId" in installation)
      || typeof installation.installationId !== "string" || typeof target !== "object" || target === null
      || !("checkedAt" in target) || typeof target.checkedAt !== "number") throw new TypeError("invalid preparation qualification");
    // A qualification alone is not a completed runtime preparation.
    if (!["omo-runtime.json", "package-runtime.json"].some(name => lstatSync(join(root, name), { throwIfNoEntry: false }))) continue;
    const old = previous.get(installation.installationId);
    if (!old || old.time < target.checkedAt) previous.set(installation.installationId, { root, time: target.checkedAt });
  }
  for (const row of previous.values()) keep.add(row.root);
  for (const entry of entries) {
    const root = join(parent, entry.name);
    releasePreparationScratch(root);
    if (!keep.has(root)) {
      const acquired = join(root, "acquired");
      if (lstatSync(acquired, { throwIfNoEntry: false })) rmSync(acquired, { recursive: true });
    }
  }
}
