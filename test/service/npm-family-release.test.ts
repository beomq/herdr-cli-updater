import { expect, test } from "bun:test";
import type { InstallationIdentity } from "../../src/adapters/types";
import { checkNpmFamilyRelease } from "../../src/service/npm-family-release";

const checkedAt = 1234;
const profiles = [
  { family: "claude", name: "@anthropic-ai/claude-code", channel: "latest", version: "2.1.289" },
  { family: "codex", name: "@openai/codex", channel: "stable/npm-latest", version: "0.160.0" },
  { family: "omp", name: "@oh-my-pi/pi-coding-agent", channel: "stable", version: "18.6.1" },
] as const;
type Profile = (typeof profiles)[number];
function installation(profile: Profile, version = "0.0.0"): InstallationIdentity {
  return { installationId: "install:fixture", family: profile.family, channel: profile.channel,
    executableRealpath: "/fixture/bin", resourcesFingerprint: "sha256:fixture",
    owner: { kind: "package", manager: "npm", packageName: profile.name, prefix: "/fixture" },
    installedVersion: { kind: "known", version },
    resources: [{ resourceId: "resource:fixture", realpath: "/fixture/bin", fingerprint: "sha256:fixture" }] };
}
function releases(profile: Profile, version: string = profile.version) {
  const encoded = encodeURIComponent(profile.name);
  const urls = [`https://registry.npmjs.org/${encoded}/latest`,
    `https://registry.npmjs.org/-/package/${encoded}/dist-tags`,
    ...(profile.family === "codex" ? ["https://api.github.com/repos/openai/codex/releases/latest"] : [])];
  const bodies: unknown[] = [{ name: profile.name, version }, { latest: version },
    ...(profile.family === "codex" ? [{ tag_name: `rust-v${version}`, prerelease: false, draft: false }] : [])];
  const requests: string[] = [];
  const read = async (url: string): Promise<unknown> => {
    requests.push(url);
    const index = urls.indexOf(url);
    if (index < 0) throw new TypeError("unexpected_request");
    return bodies[index];
  };
  return { urls, bodies, requests, read };
}

for (const manager of ["npm", "bun"] as const) {
test.each([...profiles])(`recognizes the original npm latest channel for ${manager} $family`, async profile => {
  const f = releases(profile);
  const source = { ...installation(profile), channel: "latest",
    owner: { kind: "package" as const, manager, packageName: profile.name, prefix: "/fixture" } };
  expect(await checkNpmFamilyRelease(source, f.read, checkedAt)).toMatchObject({ kind: "update-available", availableVersion: profile.version });
  expect(f.requests).toEqual(f.urls);
});
test.each([...profiles])(`uses official $family latest, tags and release URLs for ${manager}`, async profile => {
  // Given
  const f = releases(profile), source = installation(profile);
  const owned = { ...source, owner: { kind: "package", manager, packageName: profile.name, prefix: "/fixture" } } as const;
  // When
  const result = await checkNpmFamilyRelease(owned, f.read, checkedAt);
  // Then
  expect(result).toEqual({ kind: "update-available", installedVersion: "0.0.0",
    availableVersion: profile.version, checkedAt });
  expect(f.requests).toEqual(f.urls);
  expect(owned.channel).toBe(profile.channel);
});
}

for (const profile of profiles) {
  test.each([
    ["1.2.3", "1.2.3", "up-to-date"],
    ["2.0.0", "1.99.99", "up-to-date"],
    ["1.10.0", "1.9.99", "up-to-date"],
    ["1.2.4", "1.2.3", "up-to-date"],
    ["1.9.99", "1.10.0", "update-available"],
    ["1.99.99", "2.0.0", "update-available"],
    ["1.2.3", "1.2.4", "update-available"],
    ["9007199254740990.0.0", "9007199254740991.0.0", "update-available"],
  ] as const)(`${profile.family} compares %s to %s as %s without a downgrade`, async (installed, latest, kind) => {
    // Given
    const f = releases(profile, latest);
    // When
    const result = await checkNpmFamilyRelease(installation(profile, installed), f.read, checkedAt);
    // Then
    expect(result).toEqual(kind === "up-to-date" ? { kind, installedVersion: installed, checkedAt }
      : { kind, installedVersion: installed, availableVersion: latest, checkedAt });
    expect(f.requests).toEqual(f.urls);
  });

  test.each([null, [], "1.2.3", {}, { version: profile.version }, { name: "foreign", version: profile.version },
    { name: profile.name }, { name: profile.name, version: 123 }])(
    `${profile.family} rejects malformed latest metadata %j`, async latest => {
      // Given
      const f = releases(profile); f.bodies[0] = latest;
      // When / Then
      await expect(checkNpmFamilyRelease(installation(profile), f.read, checkedAt)).rejects.toBeInstanceOf(TypeError);
      expect(f.requests).toEqual(f.urls.slice(0, 1));
    });

  test.each([null, [], "1.2.3", {}, { latest: "99.0.0" }, { latest: 123 }])(
    `${profile.family} rejects malformed or disagreeing tags %j`, async tags => {
      // Given
      const f = releases(profile); f.bodies[1] = tags;
      // When / Then
      await expect(checkNpmFamilyRelease(installation(profile), f.read, checkedAt)).rejects.toBeInstanceOf(TypeError);
      expect(f.requests).toEqual(f.urls.slice(0, 2));
    });
}

const malformedVersions: readonly unknown[] = ["", "latest", "v1.2.3", "01.2.3", "1.02.3", "1.2.03",
  "1.2", "1.2.3.4", "1.2.3-beta.1", "1.2.3+build", "^1.2.3", "../1.2.3", "1.2.3\n", "1.2.3\r",
  " 1.2.3", "1.2.3 ", "1.2.3\0", "9007199254740992.0.0", "0.9007199254740992.0",
  "0.0.9007199254740992", "9".repeat(129), null, 123];
for (const profile of profiles) {
  test.each([...malformedVersions])(`${profile.family} rejects nonexact or unsafe release version %j`, async version => {
    // Given
    const f = releases(profile); f.bodies[0] = { name: profile.name, version };
    // When / Then
    await expect(checkNpmFamilyRelease(installation(profile), f.read, checkedAt)).rejects.toBeInstanceOf(TypeError);
    expect(f.requests).toEqual(f.urls.slice(0, 1));
  });
  test.each(malformedVersions.filter((value): value is string => typeof value === "string"))(
    `${profile.family} rejects malformed installed version %j before HTTP`, async version => {
      // Given
      const f = releases(profile);
      // When / Then
      await expect(checkNpmFamilyRelease(installation(profile, version), f.read, checkedAt)).rejects.toBeInstanceOf(TypeError);
      expect(f.requests).toEqual([]);
    });
  test.each([0, 1, ...(profile.family === "codex" ? [2] : [])])(
    `${profile.family} propagates the failed read at boundary %i`, async index => {
      // Given
      const f = releases(profile), failed = new TypeError("failed_read"), attempted: string[] = [];
      const read = async (url: string) => {
        attempted.push(url);
        if (url === f.urls[index]) throw failed;
        return f.read(url);
      };
      // When / Then
      await expect(checkNpmFamilyRelease(installation(profile), read, checkedAt)).rejects.toBe(failed);
      expect(f.requests).toEqual(f.urls.slice(0, index));
      expect(attempted).toEqual(f.urls.slice(0, index + 1));
    });
}

test.each([null, [], {}, { tag_name: "rust-v0.160.0" },
  { tag_name: "rust-v0.159.0", draft: false, prerelease: false },
  { tag_name: "v0.160.0", draft: false, prerelease: false },
  { tag_name: "rust-v0.160.0-alpha.1", draft: false, prerelease: false },
  { tag_name: "rust-v0.160.0", draft: true, prerelease: false },
  { tag_name: "rust-v0.160.0", draft: false, prerelease: true },
  { tag_name: "rust-v0.160.0", draft: 0, prerelease: false },
  { tag_name: "rust-v0.160.0", draft: false, prerelease: "false" }])(
  "Codex rejects disagreeing, draft, prerelease or malformed GitHub response %j", async github => {
    // Given
    const profile = profiles[1], f = releases(profile); f.bodies[2] = github;
    // When / Then
    await expect(checkNpmFamilyRelease(installation(profile), f.read, checkedAt)).rejects.toBeInstanceOf(TypeError);
    expect(f.requests).toEqual(f.urls);
  });

function native(channel = "latest", version = "2.1.247"): InstallationIdentity {
  return { ...installation(profiles[0], version), channel,
    owner: { kind: "native", installerDigest: "sha256:fixture", prefix: "/fixture" } };
}
test.each(["stable", "latest"])("Claude native requests actual %s text endpoint", async channel => {
  // Given
  const urls: string[] = [];
  const read = async (url: string) => { urls.push(url); return channel === "stable" ? "2.1.285" : "2.1.289\r\n"; };
  // When
  const result = await checkNpmFamilyRelease(native(channel), read, checkedAt);
  // Then
  expect(result).toEqual({ kind: "update-available", installedVersion: "2.1.247",
    availableVersion: channel === "stable" ? "2.1.285" : "2.1.289", checkedAt });
  expect(urls).toEqual([`https://downloads.claude.ai/claude-code-releases/${channel}`]);
});
test.each(["2.1.285", "2.1.286"])("Claude native does not update equal or newer installed %s", async version => {
  // Given
  const source = native("stable", version);
  // When
  const result = await checkNpmFamilyRelease(source, async () => "2.1.285\n", checkedAt);
  // Then
  expect(result).toEqual({ kind: "up-to-date", installedVersion: version, checkedAt });
});
test.each([...malformedVersions.filter(value => value !== "1.2.3\n"), {},
  { version: "2.1.289" }, "2.1.289\n\n", "<html>error</html>"])(
  "Claude native rejects malformed text release %j", async release => {
    // Given
    const source = native();
    // When / Then
    await expect(checkNpmFamilyRelease(source, async () => release, checkedAt)).rejects.toBeInstanceOf(TypeError);
  });
test("Claude native propagates a failed text read", async () => {
  // Given
  const failed = new Error("text_read_failed");
  // When / Then
  await expect(checkNpmFamilyRelease(native(), async () => { throw failed; }, checkedAt)).rejects.toBe(failed);
});

for (const profile of profiles) {
  const source = installation(profile);
  const unsupported: readonly InstallationIdentity[] = [
    { ...source, channel: "canary" },
    { ...source, owner: { kind: "wrapper", packageName: profile.name, engineResourceId: "resource:fixture", prefix: "/fixture" } },
    { ...source, owner: { kind: "package", manager: "homebrew", packageName: profile.name, prefix: "/fixture" } },
    { ...source, owner: { kind: "package", manager: "npm", packageName: "foreign", prefix: "/fixture" } },
    ...(profile.family !== "claude" ? [{ ...source, owner: { kind: "native", installerDigest: "fixture", prefix: "/fixture" } } as const] : []),
  ];
  test.each([...unsupported])(`${profile.family} refuses unsupported ownership/channel without HTTP %#`, async input => {
    // Given
    const f = releases(profile);
    // When
    const result = await checkNpmFamilyRelease(input, f.read, checkedAt);
    // Then
    expect(result).toEqual({ kind: "unavailable", failure: { code: "unsupported" }, checkedAt });
    expect(f.requests).toEqual([]);
  });
}
for (const profile of profiles) {
  test.each(["owner", "channel", "both"])(
    `${profile.family} detects official latest without mutation authority for unknown %s`, async field => {
      // Given: CheckRuntime source-fences the official package manifest/bin.
      const f = releases(profile), source = installation(profile);
      const input: InstallationIdentity = { ...source,
        channel: field === "owner" ? source.channel : "unknown",
        owner: field === "channel" ? source.owner : { kind: "unknown", reason: "unverified_owner" } };
      const before = structuredClone(input);
      // When
      const result = await checkNpmFamilyRelease(input, f.read, checkedAt);
      // Then
      expect(result).toEqual({ kind: "update-available", installedVersion: "0.0.0",
        availableVersion: profile.version, checkedAt });
      expect(f.requests).toEqual(f.urls);
      expect(input).toEqual(before);
    });
}
test.each(["unknown", "canary"])("Claude native requires actual channel rather than guessing %s", async channel => {
  // Given
  const f = releases(profiles[0]);
  // When
  const result = await checkNpmFamilyRelease(native(channel), f.read, checkedAt);
  // Then
  expect(result).toEqual({ kind: "unavailable", failure: { code: "unsupported" }, checkedAt });
  expect(f.requests).toEqual([]);
});
test.each(["omo", "pi", "agy", "cursor", "grok"] as const)("does not acquire unregistered %s releases", async family => {
  // Given
  const f = releases(profiles[0]);
  // When
  const result = await checkNpmFamilyRelease({ ...installation(profiles[0]), family }, f.read, checkedAt);
  // Then
  expect(result).toEqual({ kind: "unavailable", failure: { code: "unsupported" }, checkedAt });
  expect(f.requests).toEqual([]);
});
test.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid checkedAt %s before HTTP", async time => {
  // Given
  const f = releases(profiles[0]);
  // When / Then
  await expect(checkNpmFamilyRelease(installation(profiles[0]), f.read, time)).rejects.toBeInstanceOf(TypeError);
  expect(f.requests).toEqual([]);
});
test.each([...profiles])("rejects uncaptured $family version rather than claiming unsupported", async profile => {
  // Given
  const f = releases(profile), source = { ...installation(profile),
    installedVersion: { kind: "unknown", reason: "not_captured" } } as const;
  // When / Then
  await expect(checkNpmFamilyRelease(source, f.read, checkedAt)).rejects.toBeInstanceOf(TypeError);
  expect(f.requests).toEqual([]);
});
