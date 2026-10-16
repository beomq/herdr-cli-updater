import { expect, test } from "bun:test";
import { upstreamPiFixture } from "../fixtures/pi-package";
import { createCheckRuntime } from "../../src/service/check-runtime";

test.each(["2.0.0-..", "02.0.0", "2.0.0-01", "2.0.0+..", "2.0.0\n"])("never publishes or retains malformed upstream latest %j", async version => {
  // Given: real package files, two HTTP responses and the real metadata store.
  const f = await upstreamPiFixture();
  try {
    f.state.latest = version;
    const runtime = createCheckRuntime({ store: f.store, admit: f.admit, request: f.request });
    // When
    const result = await runtime.check(f.source), retained = await runtime.lastCheck(f.source);
    // Then: failure remains failure after durable storage/reconstruction.
    expect(result).toMatchObject({ ok: true, value: { kind: "unavailable", failure: { code: "verification_failed" } } });
    if (!result.ok) throw new TypeError(result.error.code);
    expect(retained).toEqual({ ok: true, value: { checkedAt: result.value.checkedAt, result: result.value } });
    expect(f.wireRequests.length).toBe(version.endsWith('\n') ? 1 : 2);
  } finally { await f.cleanup(); }
});

test.each(["2.0.0-..", "02.0.0", "2.0.0-01", "2.0.0+.."])("rejects malformed installed upstream version %s", async version => {
  const f = await upstreamPiFixture(version);
  try {
    const runtime = createCheckRuntime({ store: f.store, admit: f.admit, request: f.request });
    expect(await runtime.check(f.source)).toMatchObject({ ok: true, value: { kind: "unavailable", failure: { code: "stale_selection" } } });
    expect(f.requests).toEqual([]);
    expect(await runtime.lastCheck(f.source)).toMatchObject({ ok: true, value: { result: { kind: "unavailable" } } });
  } finally { await f.cleanup(); }
});

test.each([
  ["1.1.0", "1.2.0-beta.1+build.2", "update-available"],
  ["1.2.0-beta.1+build.2", "1.2.0-beta.2+build.3", "update-available"],
  ["1.2.0+build.1", "1.2.0+build.2", "up-to-date"],
] as const)("retains valid upstream semver %s to %s", async (installed, latest, kind) => {
  const f = await upstreamPiFixture(installed);
  try {
    f.state.latest = latest;
    const runtime = createCheckRuntime({ store: f.store, admit: f.admit, request: f.request });
    const result = await runtime.check(f.source);
    expect(result).toMatchObject({ ok: true, value: { kind, installedVersion: installed } });
    if (!result.ok) throw new TypeError(result.error.code);
    if (kind === "update-available") expect(result.value).toMatchObject({ availableVersion: latest });
    expect(await runtime.lastCheck(f.source)).toEqual({ ok: true, value: { checkedAt: result.value.checkedAt, result: result.value } });
    expect(f.wireRequests).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test("upstream Pi checker uses exact upstream metadata and never borrows Senpi release identity", async () => {
  const f = await upstreamPiFixture();
  try {
    const runtime = createCheckRuntime({ store: f.store, admit: f.admit, request: f.request });
    expect(await runtime.check(f.source)).toMatchObject({ ok: true, value: { kind: "update-available", availableVersion: "1.2.0" } });
    expect(f.requests.map(row => row.url)).toEqual([
      "https://registry.npmjs.org/-/package/%40earendil-works%2Fpi-coding-agent/dist-tags",
      "https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent/1.2.0",
    ]);
    f.state.name = "@code-yeongyu/senpi";
    expect(await runtime.check(f.source)).toMatchObject({ ok: true, value: {
      kind: "unavailable", failure: { code: "verification_failed" },
    } });
  } finally { await f.cleanup(); }
});
