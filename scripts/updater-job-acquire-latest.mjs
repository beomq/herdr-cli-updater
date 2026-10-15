import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job/acquisition";
mkdirSync(root, { recursive: true, mode: 0o700 });
const installed = "/Users/beomseok/.local/share/herdr-cli-updater/single-session-5.1.21/prefix/install/global";
const lock = Bun.JSON5.parse(readFileSync(join(installed, "bun.lock"), "utf8"));
const tagsResponse = await fetch("https://registry.npmjs.org/-/package/omo-ai/dist-tags", { signal: AbortSignal.timeout(30000) });
if (!tagsResponse.ok) throw new Error("Latest dist-tags request failed");
const acquiredDistTags = await tagsResponse.text();
if (JSON.parse(acquiredDistTags).latest !== "5.1.21") throw new Error("Latest version moved; target requires requalification");
const unique = new Map();
for (const [installName, row] of Object.entries(lock.packages)) {
  const split = row[0].lastIndexOf("@"), name = row[0].slice(0, split), version = row[0].slice(split + 1);
  const key = `${name}@${version}`;
  if (!unique.has(key)) unique.set(key, { name, version, integrity: row[3] });
}
const rows = [...unique.values()], results = new Array(rows.length);
let cursor = 0;
const pin = (path, bytes) => ({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < rows.length) {
    const index = cursor++, row = rows[index];
    const basename = createHash("sha256").update(`${row.name}@${row.version}`).digest("hex");
    const archivePath = join(root, `${basename}.tgz`), metadataPath = join(root, `${basename}.json`);
    if (existsSync(archivePath) && existsSync(metadataPath)) {
      const metadataBytes = readFileSync(metadataPath), metadata = JSON.parse(metadataBytes), bytes = readFileSync(archivePath);
      const [algorithm, expected] = row.integrity.split("-");
      if (metadata.name === row.name && metadata.version === row.version && metadata.dist.integrity === row.integrity
        && createHash(algorithm).update(bytes).digest("base64") === expected) {
        results[index] = { name: row.name, version: row.version, archive: pin(archivePath, bytes),
          metadata: pin(metadataPath, metadataBytes), dist: metadata.dist };
        continue;
      }
      throw new Error(`Previously acquired bytes drifted: ${row.name}@${row.version}`);
    }
    const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}`;
    const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Metadata ${row.name}@${row.version}: ${response.status}`);
    const metadata = await response.json();
    if (metadata.name !== row.name || metadata.version !== row.version || metadata.dist.integrity !== row.integrity)
      throw new Error(`Original lock integrity mismatch: ${row.name}@${row.version}`);
    const archiveUrl = new URL(metadata.dist.tarball);
    if (archiveUrl.protocol !== "https:" || archiveUrl.hostname !== "registry.npmjs.org") throw new Error("Unexpected archive origin");
    const archiveResponse = await fetch(archiveUrl, { signal: AbortSignal.timeout(120000) });
    if (!archiveResponse.ok) throw new Error(`Archive ${row.name}@${row.version}: ${archiveResponse.status}`);
    const bytes = Buffer.from(await archiveResponse.arrayBuffer());
    const [algorithm, expected] = row.integrity.split("-");
    if (createHash(algorithm).update(bytes).digest("base64") !== expected) throw new Error(`Archive integrity: ${row.name}`);
    const metadataBytes = Buffer.from(JSON.stringify(metadata));
    writeFileSync(archivePath, bytes, { mode: 0o600 });
    writeFileSync(metadataPath, metadataBytes, { mode: 0o600 });
    results[index] = { name: row.name, version: row.version, archive: pin(archivePath, bytes),
      metadata: pin(metadataPath, metadataBytes), dist: metadata.dist };
  }
}));
writeFileSync(join(root, "acquisition.json"), JSON.stringify({ records: results, acquiredDistTags }), { mode: 0o600 });
console.log(`UPDATER_LATEST_ACQUIRED ${results.length} original lock-bound packages`);
