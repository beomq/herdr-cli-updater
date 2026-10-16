import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCheckRuntime } from "../../../../../src/service/check-runtime";
import type { CheckClock, CheckSource } from "../../../../../src/service/check-runtime";
import { createCheckStore } from "../../../../../src/service/check-store";
import type { CheckStore } from "../../../../../src/service/check-store";
import type { AdapterResult, InstallationIdentity } from "../../../../../src/adapters/types";
import type { Family } from "../../../../../src/protocol";

export const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Mechanism fixture: real package files, HTTP wire and actual metadata store.
 * Synthetic package/version fields are not vendor or native qualification.
 */
export async function fixture(family: Family = "pi") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "check-r1-")));
  await mkdir(join(root, "bin"), { mode: 0o700 });
  await mkdir(join(root, "worker"), { mode: 0o700 });
  const executable = join(root, "bin", family === "omo" ? "omo.js" : "engine.js");
  const manifest = join(root, "package.json"), engine = join(root, "engine", "package.json");
  const engineExecutable = family === "omo" ? join(root, "engine", "bin", "engine.js") : executable;
  await writeFile(executable, "throw new Error('package must not execute');\n", { mode: 0o700 });
  if (family === "omo") {
    await mkdir(join(root, "engine", "bin"), { recursive: true, mode: 0o700 });
    await writeFile(engineExecutable, "throw new Error('engine must not execute');\n", { mode: 0o700 });
  }
  const names: Record<Family, string> = { omo: "omo-ai", pi: "@earendil-works/pi-coding-agent", omp: "@oh-my-pi/pi-coding-agent",
    claude: "@anthropic-ai/claude-code", codex: "@openai/codex", agy: "antigravity-cli", cursor: "cursor-agent", grok: "@xai-official/grok" };
  const installed = family === "omo" ? "5.1.9" : family === "pi" ? "1.1.0" : "2026.10.1-3";
  await writeFile(manifest, JSON.stringify(family === "omo"
    ? { name: names.omo, version: installed, bin: { omo: "bin/omo.js" }, dependencies: { "@code-yeongyu/senpi": installed === "5.1.9" ? "2026.10.1-3" : "" } }
    : { name: names[family], version: installed, bin: family === "pi" ? { pi: "bin/engine.js" } : { pi: "bin/engine.js", senpi: "bin/engine.js" } }), { mode: 0o600 });
  if (family === "omo") await writeFile(engine, JSON.stringify({ name: "@code-yeongyu/senpi", version: "2026.10.1-3",
    bin: { pi: "bin/engine.js", senpi: "bin/engine.js" } }), { mode: 0o600 });
  const alias = join(root, family);
  await symlink(executable, alias);
  const dependency = join(root, "node_modules", "@code-yeongyu", "senpi");
  if (family === "omo") {
    await mkdir(join(root, "node_modules", "@code-yeongyu"), { recursive: true, mode: 0o700 });
    await symlink(join(root, "engine"), dependency);
  }
  const registration = join(root, "registration.json");
  await writeFile(registration, '{"allowed":true}', { mode: 0o600 });
  const files = [...new Set([executable, manifest, ...(family === "omo" ? [engine, engineExecutable] : [])])].sort();
  const resources = files.map(path => ({ resourceId: `resource:${digest(path)}`, realpath: path,
    fingerprint: `sha256:${digest(readFileSync(path))}` }));
  const installation: InstallationIdentity = { installationId: `install:${digest(executable)}`, family, channel: "unknown",
    executableRealpath: executable, owner: { kind: "unknown", reason: "unverified_owner" },
    installedVersion: { kind: "known", version: installed }, resources,
    resourcesFingerprint: `sha256:${digest(JSON.stringify(resources))}` };
  const source: CheckSource = { installation, pins: [...files, registration].map(path => ({
    path, sha256: digest(readFileSync(path)), mode: lstatSync(path).mode & 0o7777 })),
    aliases: [{ path: alias, target: executable },
      ...(family === "omo" ? [{ path: dependency, target: join(root, "engine") }] : [])], packageManifest: manifest,
    engineManifest: family === "omo" ? engine : null };
  const store = createCheckStore(join(root, "worker"));
  const state: { latest: string | null; name: string; status: number; body: string | null } = {
    latest: family === "omo" ? "5.1.10" : family === "pi" ? "1.2.0" : "2026.10.1-4", name: names[family], status: 200, body: null };
  const requests: { readonly url: string; readonly method: string; readonly credentials: string;
    readonly redirect: string; readonly headers: readonly [string, string][] }[] = [];
  const wireRequests: { readonly method: string; readonly headers: readonly [string, string][] }[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    wireRequests.push({ method: request.method, headers: [...request.headers.entries()] });
    const data = new URL(request.url).pathname.endsWith("/dist-tags")
      ? (state.latest === null ? {} : { latest: state.latest })
      : { name: state.name, version: state.latest };
    return new Response(state.body ?? JSON.stringify(data), { status: state.status, headers: { "Content-Type": "application/json" } });
  } });
  const request = async (input: Request) => {
    requests.push({ url: input.url, method: input.method, credentials: input.credentials,
      redirect: input.redirect, headers: [...input.headers.entries()] });
    return fetch(`${server.url.origin}${new URL(input.url).pathname}`, { method: input.method,
      headers: input.headers, signal: input.signal, redirect: "error", credentials: "omit" });
  };
  const admit = async (_source: CheckSource): Promise<AdapterResult<null>> => {
    const value: unknown = JSON.parse(await readFile(registration, "utf8"));
    return typeof value === "object" && value !== null && "allowed" in value && value.allowed === true
      ? { ok: true, value: null } : { ok: false, error: { code: "identity_mismatch" } };
  };
  function runtime(overrides: {
    readonly request?: (request: Request) => Promise<Response>;
    readonly admit?: (source: CheckSource) => Promise<AdapterResult<null>>;
    readonly clock?: CheckClock;
    readonly store?: CheckStore;
  } = {}) {
    return createCheckRuntime({ store: overrides.store ?? store, admit: overrides.admit ?? admit,
      request: overrides.request ?? request, ...(overrides.clock ? { clock: overrides.clock } : {}) });
  }
  return { root, source, store, runtime, admit, request, requests, wireRequests, state, executable, manifest, engine, engineExecutable,
    registration, alias, async cleanup() { await server.stop(true); await rm(root, { recursive: true }); } };
}
