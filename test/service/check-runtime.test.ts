import { afterEach, expect, test } from "bun:test";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkSubjectKey, createCheckRuntime } from "../../src/service/check-runtime";
import type { AdapterResult } from "../../src/adapters/types";
import { digest, fixture } from "../../.omo/evidence/herdr-cli-updater/task-4/check-runtime-r1/fixture";
import { cancellationScenario } from "../../.omo/evidence/herdr-cli-updater/task-4/check-runtime-r1/cancel-cleanup-r1/qa";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
async function owned(family: Parameters<typeof fixture>[0] = "pi") {
  const f = await fixture(family); fixtures.push(f); return f;
}
function value<T>(result: AdapterResult<T>): T {
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}

test("official latest 5.1.13 and pinned 5.1.10 use authentic endpoints and separate retained policies", async () => {
  const f = await owned("omo"), urls: string[] = [];
  const tags = { latest: "5.1.13", beta: "5.2.0-beta.1" }, tagsBody = JSON.stringify(tags);
  const peer = Bun.serve({ port: 0, fetch(input) {
    const path = new URL(input.url).pathname;
    return new Response(path.endsWith("/dist-tags") ? tagsBody
      : JSON.stringify({ name: "omo-ai", version: path.split("/").at(-1) }), {
      headers: { "Content-Type": "application/json" },
    });
  } });
  try {
    const request = async (input: Request) => {
      urls.push(input.url);
      return fetch(`${peer.url.origin}${new URL(input.url).pathname}`, { signal: input.signal });
    };
    const configuration = { store: f.store, admit: f.admit, request };
    const latest = createCheckRuntime(configuration);
    const pinned = createCheckRuntime({ ...configuration, omoTargetVersion: "5.1.10" });
    const other = createCheckRuntime({ ...configuration, omoTargetVersion: "5.1.13" });
    expect(value(await latest.check(f.source))).toMatchObject({ kind: "update-available", availableVersion: "5.1.13" });
    expect(value(await pinned.lastCheck(f.source))).toBe(null);
    expect(value(await pinned.check(f.source))).toMatchObject({ kind: "update-available", availableVersion: "5.1.10" });
    expect(value(await latest.lastCheck(f.source))?.result).toMatchObject({ availableVersion: "5.1.13" });
    expect(value(await pinned.lastCheck(f.source))?.result).toMatchObject({ availableVersion: "5.1.10" });
    expect(value(await other.lastCheck(f.source))).toBe(null);
    expect(value(await other.check(f.source))).toMatchObject({ availableVersion: "5.1.13" });
    expect(urls).toEqual([
      "https://registry.npmjs.org/-/package/omo-ai/dist-tags", "https://registry.npmjs.org/omo-ai/5.1.13",
      "https://registry.npmjs.org/-/package/omo-ai/dist-tags", "https://registry.npmjs.org/omo-ai/5.1.10",
      "https://registry.npmjs.org/-/package/omo-ai/dist-tags", "https://registry.npmjs.org/omo-ai/5.1.13",
    ]);
    const stored = value(await f.store.get(checkSubjectKey(f.source, "5.1.10")));
    expect(stored?.metadata[0]?.bodyDigest).toBe(digest(tagsBody));
    expect(stored?.metadata[1]?.origin).toBe("https://registry.npmjs.org/omo-ai/5.1.10");
  } finally { await peer.stop(true); }
});

test.each(["missing-tags", "missing-name", "wrong-name", "missing-version", "wrong-version", "malformed", "http-error"] as const)(
  "pinned OmO fails closed for %s registry metadata", async boundary => {
    const f = await owned("omo"); f.state.latest = "5.1.13";
    const request = async (input: Request) => {
      if (new URL(input.url).pathname.endsWith("/dist-tags"))
        return boundary === "missing-tags" ? Response.json({}) : f.request(input);
      if (boundary === "malformed") return new Response("{");
      if (boundary === "http-error") return new Response("not found", { status: 404 });
      return Response.json({
        ...(boundary === "missing-name" ? {} : { name: boundary === "wrong-name" ? "foreign-package" : "omo-ai" }),
        ...(boundary === "missing-version" ? {} : { version: boundary === "wrong-version" ? "5.1.13" : "5.1.10" }),
      });
    };
    const runtime = createCheckRuntime({ store: f.store, admit: f.admit, request, omoTargetVersion: "5.1.10" });
    expect(value(await runtime.check(f.source))).toMatchObject({ kind: "unavailable" });
    expect(value(await runtime.lastCheck(f.source))?.result.kind).toBe("unavailable");
    expect(value(await f.runtime().lastCheck(f.source))).toBe(null);
  });

test.each(["", "latest", "^5.1.10", "5.1", "../5.1.10", "5.1.10-", "5.1.10+.", "05.1.10"])("pinned OmO refuses nonexact target %s before HTTP", async omoTargetVersion => {
  const f = await owned("omo");
  const runtime = createCheckRuntime({ store: f.store, admit: f.admit, request: f.request, omoTargetVersion });
  expect(value(await runtime.check(f.source))).toMatchObject({ kind: "unavailable", failure: { code: "verification_failed" } });
  expect(f.requests).toEqual([]);
});

test("private OmO target cannot alter Pi resolution or retained policy", async () => {
  const f = await owned("pi");
  const runtime = createCheckRuntime({ store: f.store, admit: f.admit, request: f.request, omoTargetVersion: "5.1.10" });
  expect(value(await runtime.check(f.source))).toMatchObject({ kind: "update-available", availableVersion: "1.2.0" });
  expect(value(await f.runtime().lastCheck(f.source))?.result).toMatchObject({ availableVersion: "1.2.0" });
  expect(f.requests.at(-1)?.url).toBe("https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent/1.2.0");
});

test.each(["omo", "pi"] as const)("checks actual %s package bytes, two HTTP responses and committed lastCheck", async family => {
  // Given: physical package files, a real HTTP peer and the real store.
  const f = await owned(family), runtime = f.runtime(), before = structuredClone(f.source.installation);
  // When
  const checked = value(await runtime.check(f.source));
  // Then: values come from independent fixture inputs, not check output.
  expect(checked).toMatchObject({ kind: "update-available", installedVersion: family === "omo" ? "5.1.9" : "1.1.0",
    availableVersion: family === "omo" ? "5.1.10" : "1.2.0" });
  expect(checked.checkedAt).toBeGreaterThan(0);
  expect(value(await runtime.lastCheck(f.source))).toEqual({ checkedAt: checked.checkedAt, result: checked });
  expect(f.source.installation).toEqual(before);
  const name = family === "omo" ? "omo-ai" : "%40earendil-works%2Fpi-coding-agent";
  expect(f.requests.map(request => request.url)).toEqual([
    `https://registry.npmjs.org/-/package/${name}/dist-tags`,
    `https://registry.npmjs.org/${name}/${family === "omo" ? "5.1.10" : "1.2.0"}`,
  ]);
  // Bun reflects Request.credentials as include even when constructed with omit;
  // assert the emitted HTTP boundary rather than that inaccurate reflector.
  expect(f.requests.every(request => request.method === "GET" && request.redirect === "error"
    && request.headers.every(([name]) => name !== "cookie" && name !== "authorization"))).toBe(true);
  expect(f.wireRequests.every(request => request.method === "GET"
    && request.headers.every(([name]) => name !== "cookie" && name !== "authorization"))).toBe(true);
  const stored = value(await f.store.get(checkSubjectKey(f.source)));
  expect(stored?.metadata).toHaveLength(2);
  expect(stored?.metadata.every(receipt => receipt.acquiredAt <= checked.checkedAt && /^[a-f0-9]{64}$/.test(receipt.bodyDigest))).toBe(true);
});

test("returns an actual up-to-date comparison without rewriting unknown channel", async () => {
  // Given
  const f = await owned(); f.state.latest = "1.1.0";
  // When
  const checked = value(await f.runtime().check(f.source));
  // Then
  expect(checked).toMatchObject({ kind: "up-to-date", installedVersion: "1.1.0" });
  expect(f.source.installation.channel).toBe("unknown");
});

test("uses the actual private managed engine string without retagging its identity", async () => {
  // Given: a genuine-shaped association contains the physical Pi identity/version.
  const f = await owned("omo");
  const managedEngine = { family: "pi" as const, installationId: `install:${digest(f.engineExecutable)}`,
    executableRealpath: f.engineExecutable, installedVersion: "2026.10.1-3" };
  const source = { ...f.source, managedEngine };
  // When
  const checked = value(await f.runtime().check(source));
  // Then
  expect(checked.kind).toBe("update-available");
  expect(source.installation.family).toBe("omo");
  expect(source.managedEngine).toEqual(managedEngine);
  expect((await f.runtime().check({ ...source, managedEngine: { ...managedEngine, installedVersion: "2026.10.1-99" } })).ok).toBe(false);
});

test("absent retained metadata does not require new package check qualification", async () => {
  // Given: actual source pins and registry remain verified, but no result exists.
  const f = await owned(), source = { ...f.source, packageManifest: f.registration };
  // When / Then: absence is not a qualified cached check.
  expect(value(await f.runtime().lastCheck(source))).toBe(null);
  expect((await f.runtime().check(source)).ok).toBe(false);
});

test.each(["absent", "wrong-package", "mismatched-version", "http-error", "oversized"] as const)(
  "keeps latest %s unavailable with real attempt time", async boundary => {
    // Given
    const f = await owned();
    if (boundary === "absent") f.state.latest = null;
    if (boundary === "wrong-package") f.state.name = "@code-yeongyu/senpi";
    if (boundary === "http-error") f.state.status = 503;
    if (boundary === "oversized") f.state.body = " ".repeat(1024 * 1024 + 1);
    const request = boundary === "mismatched-version" ? async (input: Request) =>
      new URL(input.url).pathname.endsWith("/dist-tags") ? f.request(input)
        : Response.json({ name: "@earendil-works/pi-coding-agent", version: "1.2.99" }) : f.request;
    // When
    const checked = value(await f.runtime({ request }).check(f.source));
    // Then
    expect(checked).toMatchObject({ kind: "unavailable" });
    expect(checked.checkedAt).toBeGreaterThan(0);
    expect(value(await f.store.get(checkSubjectKey(f.source)))?.result).toEqual(checked);
  });

test.each(["omp", "claude", "codex", "agy", "cursor", "grok"] as const)(
  "keeps unregistered %s profile unavailable without a request", async family => {
    // Given
    const f = await owned(family);
    const source = { ...f.source, installation: { ...f.source.installation,
      installedVersion: { kind: "unknown" as const, reason: "not_captured" as const } }, packageManifest: null };
    // When
    const checked = value(await f.runtime().check(source));
    // Then
    expect(checked).toMatchObject({ kind: "unavailable", failure: { code: "unsupported" } });
    expect(checked.checkedAt).toBeGreaterThan(0);
    expect(f.requests).toEqual([]);
  });

test.each([
  ["claude", "@anthropic-ai/claude-code"], ["codex", "@openai/codex"],
  ["omp", "@oh-my-pi/pi-coding-agent"], ["grok", "@xai-official/grok"],
] as const)("checks and retains the official %s release without granting mutation ownership", async (family, name) => {
  const f = await owned(family), installedVersion = "1.0.0", availableVersion = "1.0.1";
  const body = JSON.stringify({ name, version: installedVersion, bin: { [family]: "bin/engine.js" } });
  if (!f.source.packageManifest) throw new TypeError("test_manifest_missing");
  await writeFile(f.source.packageManifest, body);
  const resources = f.source.installation.resources.map(row => row.realpath === f.source.packageManifest
    ? { ...row, fingerprint: `sha256:${digest(body)}` } : row);
  const source = { ...f.source, installation: { ...f.source.installation,
    installedVersion: { kind: "known" as const, version: installedVersion }, resources,
    resourcesFingerprint: `sha256:${digest(JSON.stringify(resources))}` },
    pins: f.source.pins.map(pin => pin.path === f.source.packageManifest ? { ...pin, sha256: digest(body) } : pin) };
  const requests: string[] = [];
  const runtime = f.runtime({ request: async input => {
    requests.push(input.url);
    const path = new URL(input.url).pathname;
    return Response.json(path.endsWith("/dist-tags") ? { latest: availableVersion }
      : new URL(input.url).hostname === "api.github.com"
        ? { tag_name: `rust-v${availableVersion}`, draft: false, prerelease: false }
        : { name, version: availableVersion });
  } });
  const checked = await runtime.check(source);
  expect(requests.length).toBeGreaterThan(0);
  expect(value(checked)).toMatchObject({ kind: "update-available", installedVersion, availableVersion });
  const captured = value(await runtime.lastCheck(source));
  expect(captured?.result).toMatchObject({ kind: "update-available", availableVersion });
  expect(value(await f.store.get(checkSubjectKey(source)))?.metadata).toHaveLength(family === "codex" ? 3 : 2);
  expect(requests.every(url => url.startsWith("https://registry.npmjs.org/") || url === "https://api.github.com/repos/openai/codex/releases/latest")).toBe(true);
  expect(source.installation.owner).toEqual({ kind: "unknown", reason: "unverified_owner" });
});

test("Cursor sends the actual channel POST and retains its private release receipt", async () => {
  const f = await owned("cursor");
  const source = { ...f.source, packageManifest: null,
    installation: { ...f.source.installation, channel: "prod",
      installedVersion: { kind: "known" as const, version: "2026.01.23-916f423" } } };
  const requests: { readonly url: string; readonly method: string; readonly body: string }[] = [];
  const runtime = f.runtime({ request: async input => {
    requests.push({ url: input.url, method: input.method, body: await input.text() });
    expect(input.headers.get("content-type")).toBe("application/json");
    return Response.json({ url: "https://downloads.cursor.com/lab/2026.10.01-e373342/", version: "2026.10.01-e373342" });
  } });
  expect(value(await runtime.check(source))).toMatchObject({ kind: "update-available", availableVersion: "2026.10.01-e373342" });
  expect(requests).toEqual([{ url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl",
    method: "POST", body: '{"channel":"prod"}' }]);
  expect(value(await f.store.get(checkSubjectKey(source)))?.metadata[0]?.method).toBe("POST");
  expect(value(await runtime.lastCheck(source))?.result).toMatchObject({ kind: "update-available" });
});

test.each(["executable", "manifest", "dependency", "alias", "registration"] as const)(
  "rejects %s changes at the actual response barrier", async boundary => {
    // Given: the response, not a sleep, gates the real asynchronous boundary.
    const f = await owned(boundary === "dependency" ? "omo" : "pi");
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const runtime = f.runtime({ request: async input => { entered.resolve(); await release.promise; return f.request(input); } });
    const pending = runtime.check(f.source);
    await entered.promise;
    // When
    if (boundary === "alias") { await rm(f.alias); await symlink(f.manifest, f.alias); }
    else if (boundary === "registration") await writeFile(f.registration, '{"allowed":false}');
    else {
      const path = boundary === "executable" ? f.executable : boundary === "manifest" ? f.manifest : f.engine;
      await writeFile(path, (await readFile(path, "utf8")) + " ");
    }
    release.resolve();
    // Then
    expect((await pending).ok).toBe(false);
    expect(value(await f.store.get(checkSubjectKey(f.source)))).toBe(null);
  });

test("rejects a source change at the actual publication admission", async () => {
  // Given: store commit is real; fifth source admission precedes response publication.
  const f = await owned(); let admissions = 0;
  const runtime = f.runtime({ admit: async source => {
    const admitted = await f.admit(source);
    if (++admissions === 5) await writeFile(f.executable, "changed-at-publication");
    return admitted;
  } });
  // When
  const result = await runtime.check(f.source);
  // Then: an old-key record is not published or inherited by changed bytes.
  expect(result).toEqual({ ok: false, error: { code: "stale_selection" } });
  expect((await runtime.lastCheck(f.source)).ok).toBe(false);
});

test("same subject joins one operation and retains a detached caller snapshot", async () => {
  // Given
  const f = await owned(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const runtime = f.runtime({ request: async input => { entered.resolve(); await release.promise; return f.request(input); } });
  const resources = [...f.source.installation.resources];
  const supplied = { ...f.source, installation: { ...f.source.installation, resources } };
  // When
  const first = runtime.check(supplied), second = runtime.check(f.source);
  await entered.promise; resources.splice(0);
  release.resolve();
  // Then
  expect(first).toBe(second);
  expect(value(await first).kind).toBe("update-available");
  expect(f.requests).toHaveLength(2);
  expect(value(await runtime.lastCheck(f.source))?.result.kind).toBe("update-available");
});

test("refuses the sixty fifth distinct active subject without losing the first sixty four", async () => {
  // Given: exact admission barrier holds every distinct source before GET.
  const f = await owned("omp"), release = Promise.withResolvers<void>();
  const runtime = f.runtime({ admit: async source => { await release.promise; return f.admit(source); } });
  const subjects = Array.from({ length: 65 }, (_, index) => ({ ...f.source,
    installation: { ...f.source.installation, channel: `observed:${index}`,
      installedVersion: { kind: "unknown" as const, reason: "not_captured" as const } }, packageManifest: null }));
  // When
  const pending = subjects.map(source => runtime.check(source));
  const refused = await pending[64];
  release.resolve();
  // Then
  expect(refused).toEqual({ ok: false, error: { code: "resources_busy" } });
  expect((await Promise.all(pending.slice(0, 64))).every(result => result.ok)).toBe(true);
});

test("whole deadline fence rejects a completed but late response without storing success", async () => {
  // Given
  const f = await owned(); let monotonic = 0;
  const runtime = f.runtime({ clock: { now: Date.now, monotonic: () => monotonic }, request: async input => {
    const response = await f.request(input); monotonic = 3500; return response;
  } });
  // When
  const result = await runtime.check(f.source);
  // Then
  expect(result).toEqual({ ok: false, error: { code: "resources_busy" } });
  expect(value(await f.store.get(checkSubjectKey(f.source)))).toBe(null);
});

test("real failed store admission cannot become a check success", async () => {
  // Given: corrupt the actual store boundary, not a put-success mock.
  const f = await owned(); await writeFile(join(f.root, "worker.checks"), "foreign");
  // When
  const result = await f.runtime().check(f.source);
  // Then
  expect(result).toEqual({ ok: false, error: { code: "recovery_required" } });
});

test("unexpected release implementation errors are not swallowed into a latest result", async () => {
  // Given
  const f = await owned(), unexpected = new Error("unexpected private implementation error");
  const runtime = f.runtime({ request: async () => { throw unexpected; } });
  // When / Then
  await expect(runtime.check(f.source)).rejects.toBe(unexpected);
  expect(value(await f.store.get(checkSubjectKey(f.source)))).toBe(null);
});

test.each(["abort", "deadline"] as const)("returns resources_busy on %s while retaining exact pending cancellation", async trigger => {
  // Given: real stream, source/store and exact production-read/cancel barriers.
  // When: caller abort or the deadline signal fires while actual cancel is held.
  const report = await cancellationScenario("corrected", trigger);
  // Then: no success, no premature slot retirement; real cancellation owns the lock.
  expect(report.result).toEqual({ ok: false, error: { code: "resources_busy" } });
  expect(report.events.indexOf("reply-settled")).toBeLessThan(report.events.indexOf("cancel-settled"));
  expect(report.events).toContain("exact-active-slot-retained");
  expect(report.events).toContain("actual-cleanup-retired-new-operation");
  expect(report.events.at(-1)).toBe("cleanup:fixture-peer-stopped-root-absent-ownedcleanup0");
});

test("releases the actual reader lock when cancellation rejects", async () => {
  // Given: the real oversized-body path, with a rejecting stream cancel hook.
  // When
  const report = await cancellationScenario("corrected", "reject");
  // Then: releaseLock runs on rejection, not just fulfilled cancellation.
  expect(report.cancelSettled).toBe(true);
  expect(report.locked).toBe(false);
  expect(report.events.indexOf("lock-released")).toBeLessThan(report.events.indexOf("reply-settled"));
});
