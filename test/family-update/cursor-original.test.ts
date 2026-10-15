import { expect, test } from "bun:test";
import { parseCursorOriginalVersion, prepareCursorOriginalUpdate } from "../../scripts/family-update/cursor-original.mjs";

const input = {
  executable: "/owned/vendor/cursor-agent",
  home: "/owned/home",
  version: "2026.10.01-e373342",
  urlPrefix: "file:///owned/supply/",
};

test("prepares the original fixed-target command without an executor", () => {
  // Given: an admitted original and an isolated supply prefix.
  // When: the parent requests command preparation.
  const result = prepareCursorOriginalUpdate(input);
  // Then: arguments select the real hidden install command.
  expect(result.command).toBe(input.executable);
  expect(result.args).toEqual(["install", input.version, "file:///owned/supply"]);
  expect(result.cwd).toBe(input.home);
  expect(result.env.HOME).toBe(input.home);
  expect(result.env.AGENT_CLI_CREDENTIAL_STORE).toBe("file");
  expect(result.env.PATH).toBe("/usr/bin:/bin");
  expect(result.env.TMPDIR).toBe("/owned/home/tmp");
});

test("reports all native aliases, shim, versions and detached cleanup", () => {
  // Given: the original agent-cli product.
  // When: preparing its update.
  const result = prepareCursorOriginalUpdate(input);
  // Then: cleanup is not reduced to the requested version directory.
  expect(result.aliases).toEqual(["/owned/home/.local/bin/agent", "/owned/home/.local/bin/cursor-agent"]);
  expect(result.cursorShim).toBe("/owned/home/.local/bin/cursor");
  expect(result.writeRoots).toEqual([
    "/owned/home/.local/share/cursor-agent", "/owned/home/.local/bin",
    "/owned/home/config", "/owned/home/data", "/owned/home/compile-cache", "/owned/home/tmp",
  ]);
  expect(result.detachedCleanup).toEqual({
    command: "/owned/home/.local/share/cursor-agent/versions/2026.10.01-e373342/cursor-agent",
    args: ["cleanup-install-versions", input.version],
  });
});

test.each(["../escape", "latest", "--help", "2026.10.01-e373342/escape"])(
  "rejects non-fixed version %s", version => {
    // Given: an unsafe or moving target.
    // When/Then: preparation rejects it before any execution.
    expect(() => prepareCursorOriginalUpdate({ ...input, version })).toThrow(TypeError);
  },
);

test.each(["https://user:secret@example.com/lab", "https://example.com/lab?q=1", "https://example.com/lab#x", "ssh://example.com/lab"])(
  "rejects ambiguous supply prefix %s", urlPrefix => {
    // Given: a credential-bearing or unsupported supply.
    // When/Then: preparation rejects it.
    expect(() => prepareCursorOriginalUpdate({ ...input, urlPrefix })).toThrow(TypeError);
  },
);

test.each(["home", "/"])("rejects unconfined home %s", home => {
  // Given: an unconfined destination.
  // When/Then: preparation refuses it.
  expect(() => prepareCursorOriginalUpdate({ ...input, home })).toThrow(TypeError);
});

test("parses the actual original version output", () => {
  // Given: native --version output.
  // When/Then: the parser returns one exact fixed version.
  expect(parseCursorOriginalVersion("2026.10.01-e373342\n")).toBe(input.version);
});

test("rejects version output containing extra lines", () => {
  // Given: output that cannot attest one native version.
  // When/Then: the parser refuses it.
  expect(() => parseCursorOriginalVersion("2026.10.01-e373342\nunexpected")).toThrow(TypeError);
});
