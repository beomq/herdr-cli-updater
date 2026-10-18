import { lstatSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fixture, digest } from "./evidence/task-4/check-runtime-r1/fixture";

/** Reuse the real HTTP/store fixture without rewriting the preserved Senpi input. */
export async function upstreamPiFixture(installedVersion = "1.1.0") {
  const f = await fixture();
  await writeFile(f.manifest, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: installedVersion,
    bin: { pi: "bin/engine.js" } }));
  const resources = f.source.installation.resources.map(resource => ({ ...resource,
    fingerprint: `sha256:${digest(readFileSync(resource.realpath))}` }));
  const installation = { ...f.source.installation, installedVersion: { kind: "known" as const, version: installedVersion },
    resources, resourcesFingerprint: `sha256:${digest(JSON.stringify(resources))}` };
  const source = { ...f.source, installation, pins: f.source.pins.map(pin => ({ ...pin,
    sha256: digest(readFileSync(pin.path)), mode: lstatSync(pin.path).mode & 0o7777 })) };
  f.state.name = "@earendil-works/pi-coding-agent";
  f.state.latest = "1.2.0";
  return { ...f, source };
}
