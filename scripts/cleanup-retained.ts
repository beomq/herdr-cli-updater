import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { attachAuthenticatedWorker } from "../src/service/client";
import { retainPreparations } from "../src/service/preparation-retention";
import { prunePackageCopies } from "./family-update/retention.mjs";

const data = process.argv[2], apply = process.argv[3] === "--apply";
if (!data || !data.startsWith("/") || realpathSync(data) !== data || process.argv.length > 4)
  throw new TypeError("usage: bun scripts/cleanup-retained.ts ABSOLUTE_UPDATER_DATA [--apply]");
const parent = join(data, "worker-preparations"), worker = join(data, "worker");
const packageBase = resolve(import.meta.dir, "../.omo/evidence/herdr-cli-updater/six-families/packages");
const runtimeBytes = readFileSync(join(data, "runtime.json"));
const runtime = JSON.parse(runtimeBytes.toString("utf8"));
const protectedRoots: string[] = runtime.configurations.map((entry: { path: string; sha256: string }) => {
  if (createHash("sha256").update(readFileSync(entry.path)).digest("hex") !== entry.sha256)
    throw new TypeError("runtime pin changed");
  return dirname(entry.path);
});
const families = ["claude", "codex", "omp", "grok"] as const;
const plans = families.map(family => {
  const root = join(packageBase, family), inputBytes = readFileSync(join(root, "input-manifest.json"));
  const input = JSON.parse(inputBytes.toString("utf8"));
  const completion = JSON.parse(readFileSync(input.originalInstallCompletion.path, "utf8"));
  const protectedCopies: string[] = [input.selectedRoot, input.capturedAfter, completion.equivalentBefore.capturedBefore];
  if (protectedCopies.some(path => dirname(path) !== root)) throw new TypeError("foreign QA snapshot");
  return { root, inputBytes, protectedCopies, candidates: readdirSync(root).filter(name =>
    /^(selected-original|captured-before|captured-after)(-\d+)?$/.test(name)
    && !protectedCopies.includes(join(root, name))).map(name => join(root, name)) };
});
async function idle(): Promise<void> {
  const connection = await attachAuthenticatedWorker(worker, 20_000);
  try {
    const jobs = await connection.request({ operation: "jobs" });
    if (!jobs.ok || jobs.result.jobs.length) throw new TypeError("worker has jobs; cleanup refused");
  } finally { connection.close(); }
  const open = execFileSync("/usr/sbin/lsof", ["-n", "-P", "-Fn"], { encoding: "utf8", maxBuffer: 64 * 1024 ** 2 });
  const paths = open.split("\n").filter(line => line.startsWith("n")).map(line => line.slice(1));
  const boundaries = [parent, ...plans.flatMap(plan => plan.candidates)];
  if (paths.some(path => boundaries.some(root => path === root || path.startsWith(`${root}/`))))
    throw new TypeError("cleanup data has an open consumer");
}
await idle();
const plan = { policy: "bounded-retention-v1", protectedRoots, qa: plans.map(({ root, protectedCopies, candidates }) =>
  ({ root, protectedCopies, candidates })), preparations: readdirSync(parent).filter(name => /^(omo|npm)-[A-Za-z0-9]+$/.test(name)),
  operatingInstallation: join(data, "isolated-omo/prefix"), apply };
console.log(JSON.stringify(plan, null, 2));
if (apply) {
  const locks: string[] = [];
  try {
    for (const lock of [join(parent, ".preparing"), ...families.map(family => join(packageBase, `.${family}-preparing`))]) {
      await mkdir(lock, { mode: 0o700 }); locks.push(lock);
    }
    await idle();
    if (!readFileSync(join(data, "runtime.json")).equals(runtimeBytes)) throw new TypeError("runtime changed");
    for (const p of plans) if (!readFileSync(join(p.root, "input-manifest.json")).equals(p.inputBytes)) throw new TypeError("QA input changed");
    // Validate owned boundaries before any removal. Symlinks are never traversed.
    for (const path of plans.flatMap(p => p.candidates)) {
      if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new TypeError("unsafe QA candidate");
    }
    retainPreparations(parent, protectedRoots);
    const removed: string[] = [];
    for (const p of plans) removed.push(...await prunePackageCopies(p.root, p.protectedCopies));
    await writeFile(join(data, "retention-last.json"), JSON.stringify({ ...plan, removed, completedAt: new Date().toISOString(),
      recordsPreserved: true, installationUpdated: false }, null, 2), { mode: 0o600 });
    console.log(`RETENTION_CLEANUP_COMPLETED qa-subtrees=${removed.length}`);
  } finally { for (const lock of locks.reverse()) await rm(lock, { recursive: true }); }
}
