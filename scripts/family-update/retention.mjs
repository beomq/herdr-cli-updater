import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

/** Keep logs/receipts and the latest referenced installation snapshots. */
export async function prunePackageCopies(root, protectedRoots) {
  const info = await lstat(root);
  if (await realpath(root) !== root || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
    throw new TypeError("noncanonical package evidence root");
  const kept = new Set(protectedRoots);
  const removed = [];
  for (const name of await readdir(root)) {
    if (!/^(selected-original|captured-before|captured-after)(-\d+)?$/.test(name)) continue;
    const scope = join(root, name);
    if (kept.has(scope)) continue;
    if (!(await lstat(scope)).isDirectory() || await realpath(scope) !== scope) throw new TypeError("unsafe package evidence copy");
    for (const child of ["prefix", "home", "bun", "cache"]) {
      const path = join(scope, child);
      try { await lstat(path); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      await rm(path, { recursive: true });
      removed.push(path);
    }
  }
  return removed;
}

/** A failed acquisition has no qualified consumer. Preserve JSON and logs. */
export async function releaseFailedAcquisition(root) {
  if (await realpath(root) !== root) throw new TypeError("noncanonical acquisition root");
  for (const name of ["resolve-before", "resolve-target"]) {
    const path = join(root, name);
    try { await lstat(path); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    await prunePackageCopiesForResolution(path);
  }
  const closure = join(root, "closure");
  let names;
  try { names = await readdir(closure); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  for (const name of names) if (/^[a-f0-9]{64}\.tgz$/.test(name)) await rm(join(closure, name));
}

async function prunePackageCopiesForResolution(root) {
  if (await realpath(root) !== root) throw new TypeError("unsafe acquisition resolution");
  for (const name of ["prefix", "home", "bun", "cache"]) {
    const path = join(root, name);
    try { await lstat(path); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    await rm(path, { recursive: true });
  }
}
