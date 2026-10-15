import { expect, test } from "bun:test";
import { AGY_INSTALLER_SHA256, AGY_MANIFEST_CHANNEL } from "../../src/adapters/agy";
import type { InstallationIdentity } from "../../src/adapters/types";
import type { CheckResult, FailureCode } from "../../src/protocol";
import { checkNativeFamilyRelease } from "../../src/service/native-family-release";

const checkedAt = 42;
const registry = "https://registry.npmjs.org/%40xai-official%2Fgrok";
const tagsUrl = "https://registry.npmjs.org/-/package/%40xai-official%2Fgrok/dist-tags";
const cursorEndpoint = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl";
function installation(overrides: Partial<InstallationIdentity> = {}): InstallationIdentity {
  return {
    family: "grok", installationId: "install:fixture", resourcesFingerprint: "sha256:fixture",
    executableRealpath: "/fixture/grok", resources: [],
    owner: { kind: "unknown", reason: "unverified_owner" },
    installedVersion: { kind: "known", version: "1.0.45" }, channel: "unknown",
    ...overrides,
  };
}
function reader(responses: Readonly<Record<string, unknown>>) {
  const urls: string[] = [];
  return {
    urls,
    read: async (url: string): Promise<unknown> => {
      urls.push(url);
      if (!Object.hasOwn(responses, url)) throw new TypeError("unexpected_url");
      return responses[url];
    },
  };
}
const native = { kind: "native", prefix: "/fixture", installerDigest: "sha256:fixture" } as const;
function agy(overrides: Partial<InstallationIdentity> = {}): InstallationIdentity {
  return installation({ family: "agy", channel: AGY_MANIFEST_CHANNEL,
    owner: { ...native, installerDigest: `sha256:${AGY_INSTALLER_SHA256}` }, ...overrides });
}
function manifest(version = "1.2.16") {
  return { version, sha512: "a".repeat(128),
    url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-5594158052802560/darwin-arm/cli_mac_arm64.tar.gz` };
}
const unavailable = (code: FailureCode): CheckResult => ({ kind: "unavailable", failure: { code }, checkedAt });

test.each([
  ["1.2.15", "update-available"], ["1.2.16", "up-to-date"], ["1.2.17", "unavailable"],
] as const)("AGY compares %s against the official darwin_arm64 manifest", async (version, kind) => {
  const subject = agy({ installedVersion: { kind: "known", version } });
  const http = reader({ [AGY_MANIFEST_CHANNEL]: manifest() });
  const result = await checkNativeFamilyRelease(subject, http.read, checkedAt);
  expect(result.kind).toBe(kind);
  expect(result.checkedAt).toBe(checkedAt);
  if (kind === "update-available") expect(result).toMatchObject({ availableVersion: "1.2.16" });
  if (kind === "unavailable") expect(result).toEqual(unavailable("verification_failed"));
  expect(http.urls).toEqual([AGY_MANIFEST_CHANNEL]);
});

test.each([
  null, [], { ...manifest(), extra: true }, { ...manifest(), version: "01.2.16" }, { ...manifest(), version: "1.2.16-alpha" },
  { ...manifest(), sha512: "a".repeat(127) }, { ...manifest(), sha512: "A".repeat(128) },
  { ...manifest(), sha512: undefined },
  { ...manifest(), url: manifest("1.2.17").url },
  { ...manifest(), url: manifest().url.replace("darwin-arm", "linux-arm") },
  { ...manifest(), url: manifest().url.replace("storage.googleapis.com", "storage.googleapis.com.evil") },
  { ...manifest(), url: `${manifest().url}?download=1` },
  { ...manifest(), url: manifest().url.replace("https://", "https://user@") },
])("AGY rejects malformed or disagreeing release metadata %#", async body => {
  const http = reader({ [AGY_MANIFEST_CHANNEL]: body });
  const result = await checkNativeFamilyRelease(agy(), http.read, checkedAt);
  expect(result).toEqual(unavailable("verification_failed"));
});

test.each([
  { owner: { kind: "unknown", reason: "unverified_owner" }, code: "receipt_uncertain" },
  { owner: native, code: "identity_mismatch" },
  { channel: "stable", code: "identity_mismatch" },
  { channel: AGY_MANIFEST_CHANNEL.replace("darwin_arm64", "linux_x64"), code: "identity_mismatch" },
] satisfies readonly (Partial<InstallationIdentity> & { readonly code: FailureCode })[])(
  "AGY requires independently bound native ownership and exact endpoint %#", async ({ code, ...change }) => {
    const http = reader({});
    const result = await checkNativeFamilyRelease(agy(change), http.read, checkedAt);
    expect(result).toEqual(unavailable(code));
    expect(http.urls).toEqual([]);
  },
);

test.each([
  ["1.0.45", "update-available"], ["1.0.46", "up-to-date"], ["1.0.47", "unavailable"],
  ["1.0.46+local", "up-to-date"], ["1.0.46-alpha.9", "update-available"],
] as const)("Grok registry compares genuinely known version %s despite unknown owner", async (version, kind) => {
  const subject = installation({ installedVersion: { kind: "known", version } });
  const http = reader({ [tagsUrl]: { latest: "1.0.46" },
    [`${registry}/latest`]: { name: "@xai-official/grok", version: "1.0.46" } });
  const result = await checkNativeFamilyRelease(subject, http.read, checkedAt);
  expect(result.kind).toBe(kind);
  expect(subject.owner.kind).toBe("unknown");
  expect(http.urls).toEqual([tagsUrl, `${registry}/latest`]);
});

test.each([
  [{ latest: "1.0.46" }, { name: "grok", version: "1.0.46" }],
  [{ latest: "1.0.46" }, { name: "@xai-official/grok", version: "1.0.47" }],
  [{ latest: "1.0.46" }, { name: "@xai-official/grok" }],
  [{ latest: "1.0.46-alpha.01" }, { name: "@xai-official/grok", version: "1.0.46-alpha.01" }],
  [{}, null], [[], []], [{ latest: "not-version" }, {}],
] as const)("Grok rejects registry name/version/tag disagreement %#", async (tags, latest) => {
  const http = reader({ [tagsUrl]: tags, [`${registry}/latest`]: latest });
  const result = await checkNativeFamilyRelease(installation(), http.read, checkedAt);
  expect(result).toEqual(unavailable("verification_failed"));
});

test("Grok original npm latest channel remains a registry lookup, not a native channel", async () => {
  const http = reader({ [tagsUrl]: { latest: "1.0.46" }, [`${registry}/latest`]: { name: "@xai-official/grok", version: "1.0.46" } });
  expect(await checkNativeFamilyRelease(installation({ channel: "latest" }), http.read, checkedAt))
    .toMatchObject({ kind: "update-available", availableVersion: "1.0.46" });
  expect(http.urls).toEqual([tagsUrl, `${registry}/latest`]);
  expect(await checkNativeFamilyRelease(installation({ channel: "latest", owner: native }), http.read, checkedAt))
    .toEqual(unavailable("unsupported"));
});

test.each([
  ["stable", "1.0.46", undefined, "1.0.46"],
  ["alpha", "1.0.50", "1.0.49", "1.0.50"],
  ["alpha", "1.0.46", "1.0.49", "1.0.49"],
  ["alpha", "1.0.49-alpha.9", "1.0.49-alpha.10", "1.0.49-alpha.10"],
] as const)("Grok native %s chooses the channel maximum %#", async (channel, stable, alpha, available) => {
  const http = reader({ "https://x.ai/cli/stable": `${stable}\n`, "https://x.ai/cli/alpha": alpha });
  const result = await checkNativeFamilyRelease(installation({ owner: native, channel }), http.read, checkedAt);
  expect(result).toEqual({ kind: "update-available", installedVersion: "1.0.45",
    availableVersion: available, checkedAt });
  expect(http.urls).toEqual(channel === "stable" ? ["https://x.ai/cli/stable"]
    : ["https://x.ai/cli/stable", "https://x.ai/cli/alpha"]);
});

test("Grok npm alpha checks selected version identity rather than a floating alpha assumption", async () => {
  const subject = installation({ channel: "alpha", owner: {
    kind: "package", manager: "npm", packageName: "@xai-official/grok", prefix: "/fixture",
  } });
  const http = reader({ [tagsUrl]: { latest: "1.0.46", alpha: "1.0.49-alpha.10" },
    [`${registry}/latest`]: { name: "@xai-official/grok", version: "1.0.46" },
    [`${registry}/1.0.49-alpha.10`]: { name: "@xai-official/grok", version: "1.0.49-alpha.10" } });
  const result = await checkNativeFamilyRelease(subject, http.read, checkedAt);
  expect(result).toMatchObject({ kind: "update-available", availableVersion: "1.0.49-alpha.10" });
  expect(http.urls).toEqual([tagsUrl, `${registry}/latest`, `${registry}/1.0.49-alpha.10`]);
});

test("Grok npm alpha uses newer stable without downgrading to an old alpha tag", async () => {
  const http = reader({ [tagsUrl]: { latest: "1.0.50", alpha: "1.0.49" },
    [`${registry}/latest`]: { name: "@xai-official/grok", version: "1.0.50" } });
  const result = await checkNativeFamilyRelease(installation({ channel: "alpha" }), http.read, checkedAt);
  expect(result).toMatchObject({ kind: "update-available", availableVersion: "1.0.50" });
  expect(http.urls).toEqual([tagsUrl, `${registry}/latest`]);
});

test.each([
  ["1.0.49", "1.0.49", "up-to-date"],
  ["1.0.50", "1.0.49", "unavailable"],
  ["1.0.49-alpha.999999999999999999999", "1.0.49-alpha.1000000000000000000000", "update-available"],
  ["999999999999999999999.0.0", "1000000000000000000000.0.0", "update-available"],
] as const)("Grok native alpha compares %s precisely without downgrade", async (installed, alpha, kind) => {
  const http = reader({ "https://x.ai/cli/stable": "1.0.46", "https://x.ai/cli/alpha": alpha });
  const result = await checkNativeFamilyRelease(installation({ owner: native, channel: "alpha",
    installedVersion: { kind: "known", version: installed } }), http.read, checkedAt);
  expect(result.kind).toBe(kind);
  if (kind === "unavailable") expect(result).toEqual(unavailable("verification_failed"));
});

test.each([
  { name: "foreign", version: "1.0.49" },
  { name: "@xai-official/grok", version: "1.0.48" },
  null,
] as const)("Grok rejects selected npm alpha metadata disagreement %#", async body => {
  const http = reader({ [tagsUrl]: { latest: "1.0.46", alpha: "1.0.49" },
    [`${registry}/latest`]: { name: "@xai-official/grok", version: "1.0.46" },
    [`${registry}/1.0.49`]: body });
  const result = await checkNativeFamilyRelease(installation({ channel: "alpha" }), http.read, checkedAt);
  expect(result).toEqual(unavailable("verification_failed"));
});

test.each([null, {}, "1.0", "v1.0.46", "1.0.46\nforeign", "01.0.46"])(
  "Grok native rejects malformed text pointer %#", async body => {
    const http = reader({ "https://x.ai/cli/stable": body });
    const result = await checkNativeFamilyRelease(installation({ owner: native, channel: "stable" }), http.read, checkedAt);
    expect(result).toEqual(unavailable("verification_failed"));
  },
);

test.each([
  { owner: native, channel: "unknown", code: "receipt_uncertain" },
  { channel: "enterprise", code: "unsupported" },
  { channel: "https://evil/stable", code: "unsupported" },
  { owner: { kind: "package", manager: "npm", packageName: "grok", prefix: "/fixture" }, code: "identity_mismatch" },
  { owner: { kind: "package", manager: "bun", packageName: "@xai-official/grok", prefix: "/fixture" }, code: "identity_mismatch" },
  { installedVersion: { kind: "unknown", reason: "not_captured" }, code: "receipt_uncertain" },
  { installedVersion: { kind: "known", version: "1.0.46-alpha.01" }, code: "verification_failed" },
] satisfies readonly (Partial<InstallationIdentity> & { readonly code: FailureCode })[])(
  "Grok never guesses native channels or package names %#", async ({ code, ...change }) => {
    const http = reader({});
    const result = await checkNativeFamilyRelease(installation(change), http.read, checkedAt);
    expect(result).toEqual(unavailable(code));
    expect(http.urls).toEqual([]);
  },
);

test.each(["static", "unknown", "stable", "https://evil/prod"])(
  "Cursor %s cannot use public install distribution as effective release channel", async channel => {
    const http = reader({ "https://cursor.com/install": 'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.10.01-e373342/${OS}/${ARCH}/agent-cli-package.tar.gz"' });
    const result = await checkNativeFamilyRelease(installation({ family: "cursor", channel, owner: native,
      installedVersion: { kind: "known", version: "2026.01.23-916f423" } }), http.read, checkedAt);
    expect(result).toEqual(unavailable(channel === "unknown" ? "receipt_uncertain" : "unsupported"));
    expect(http.urls).toEqual([]);
  },
);

function cursor(overrides: Partial<InstallationIdentity> = {}): InstallationIdentity {
  return installation({ family: "cursor", channel: "prod", owner: native,
    installedVersion: { kind: "known", version: "2026.01.23-916f423" }, ...overrides });
}
function cursorRelease(version = "2026.10.01-e373342") {
  return { version, url: `https://downloads.cursor.com/lab/${version}/` };
}

test.each(["prod", "lab", "staging", "prod-stable-internal"])(
  "Cursor sends the observed %s channel through the exact public POST API", async channel => {
    const requests: { readonly url: string; readonly request: unknown }[] = [];
    const read: Parameters<typeof checkNativeFamilyRelease>[1] = async (url, request) => {
      requests.push({ url, request });
      return cursorRelease();
    };
    const result = await checkNativeFamilyRelease(cursor({ channel }), read, checkedAt);
    expect(result).toEqual({ kind: "update-available", installedVersion: "2026.01.23-916f423",
      availableVersion: "2026.10.01-e373342", checkedAt });
    expect(requests).toEqual([{ url: cursorEndpoint, request: { method: "POST",
      body: JSON.stringify({ channel: channel === "prod-stable-internal" ? "prod" : channel }) } }]);
  },
);

test.each([
  ["2026.10.01-e373342", "2026.10.01-e373342", "up-to-date"],
  ["2026.09.30-fffffff", "2026.10.01-0000000", "update-available"],
  ["2026.10.01-0000000", "2026.09.30-fffffff", "unavailable"],
  ["2026.10.01-fffffff", "2026.10.01-0000000", "update-available"],
  ["2026.10.01-0000000", "2026.10.01-fffffff", "update-available"],
  ["2024.02.29-916f423", "2026.10.01-e373342", "update-available"],
] as const)("Cursor compares date and hash without lexical hash ordering %#", async (installed, available, kind) => {
  const http = reader({ [cursorEndpoint]: cursorRelease(available) });
  const result = await checkNativeFamilyRelease(cursor({ installedVersion: { kind: "known", version: installed } }),
    http.read, checkedAt);
  expect(result.kind).toBe(kind);
  if (kind === "unavailable") expect(result).toEqual(unavailable("verification_failed"));
  if (kind === "up-to-date") expect(result).toEqual({ kind, installedVersion: installed, checkedAt });
  if (kind === "update-available") expect(result).toEqual({ kind, installedVersion: installed,
    availableVersion: available, checkedAt });
});

test.each([
  null, [], {}, { version: "2026.10.01-e373342" }, { url: cursorRelease().url },
  { ...cursorRelease(), url: cursorRelease("2026.09.30-e373342").url },
  { ...cursorRelease(), url: cursorRelease().url.replace("lab", "prod") },
  { ...cursorRelease(), url: cursorRelease().url.replace("https:", "http:") },
  { ...cursorRelease(), url: cursorRelease().url.replace("downloads.cursor.com", "downloads.cursor.com.evil") },
  { ...cursorRelease(), url: cursorRelease().url.replace("https://", "https://user@") },
  { ...cursorRelease(), url: cursorRelease().url.slice(0, -1) },
  { ...cursorRelease(), url: `${cursorRelease().url}?download=1` },
  cursorRelease("2026.13.01-e373342"), cursorRelease("2026.02.30-e373342"),
  cursorRelease("2026.02.29-e373342"), cursorRelease("2026.10.1-e373342"),
  cursorRelease("2026.10.01-E373342"), cursorRelease("2026.10.01-e3733420"),
  cursorRelease("2026.10.01-e373342\n"), cursorRelease("1.0.46"),
])("Cursor rejects malformed version or disagreeing official artifact URL %#", async body => {
  const http = reader({ [cursorEndpoint]: body });
  const result = await checkNativeFamilyRelease(cursor(), http.read, checkedAt);
  expect(result).toEqual(unavailable("verification_failed"));
  expect(http.urls).toEqual([cursorEndpoint]);
});

test.each(["2026.02.29-916f423", "2026.01.00-916f423", "unknown", "2026.01.23-916f42"])(
  "Cursor rejects malformed installed version %s before requesting a release", async version => {
    const http = reader({});
    const result = await checkNativeFamilyRelease(cursor({ installedVersion: { kind: "known", version } }), http.read, checkedAt);
    expect(result).toEqual(unavailable("verification_failed"));
    expect(http.urls).toEqual([]);
  },
);

test("Cursor comparison does not promote unknown ownership into update authority", async () => {
  const subject = cursor({ owner: { kind: "unknown", reason: "unverified_owner" } });
  const http = reader({ [cursorEndpoint]: cursorRelease() });
  const result = await checkNativeFamilyRelease(subject, http.read, checkedAt);
  expect(result.kind).toBe("update-available");
  expect(subject.owner).toEqual({ kind: "unknown", reason: "unverified_owner" });
});

test("Cursor POST transport rejection remains a typed unavailable result", async () => {
  const result = await checkNativeFamilyRelease(cursor(), async () => {
    throw new TypeError("public_http_failed");
  }, checkedAt);
  expect(result).toEqual(unavailable("receipt_uncertain"));
});

test("public reader rejection becomes a typed unavailable result without inspecting the exception", async () => {
  const result = await checkNativeFamilyRelease(installation(), async () => {
    throw new Proxy({}, { get: () => { throw new TypeError("must_not_inspect"); } });
  }, checkedAt);
  expect(result).toEqual(unavailable("receipt_uncertain"));
});

test("unrelated family remains explicitly unsupported without HTTP", async () => {
  const http = reader({});
  const result = await checkNativeFamilyRelease(installation({ family: "pi" }), http.read, checkedAt);
  expect(result).toEqual(unavailable("unsupported"));
  expect(http.urls).toEqual([]);
});
