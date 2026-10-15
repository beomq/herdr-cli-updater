import { expect, test } from "bun:test";
import { version } from "../package.json";

const root = new URL("../", import.meta.url).pathname;

async function invoke(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("manifest routes the independent pane through the actual entrypoint", async () => {
  // Given: the actual manifest, not a fixture or string search.
  const source = await Bun.file(`${root}herdr-plugin.toml`).text();
  // When: Bun parses the same TOML consumed by herdr.
  const manifest = Bun.TOML.parse(source);
  // Then: argv arrays and pane/action identity follow the real manifest schema.
  expect(manifest).toMatchObject({
    id: "beomq.cli-updater",
    version,
    build: [
      { command: ["bun", "install", "--frozen-lockfile"] },
      { command: ["bun", "run", "build"] },
    ],
    startup: [{ command: ["bun", "scripts/plugin.ts", "start"] }],
    panes: [{
      id: "updater",
      placement: "overlay",
      command: ["bun", "scripts/plugin.ts", "open"],
    }],
    actions: [{
      id: "updater",
      contexts: ["workspace"],
      command: ["bun", "scripts/plugin.ts", "action"],
    }],
  });
});

test("version succeeds with the package semver", async () => {
  // Given: the real source entrypoint.
  const args = ["src/index.ts", "--version"];
  // When: a separate Bun process executes it.
  const result = await invoke(args);
  // Then: it emits machine-consumed semver, not an updater success.
  expect(result).toEqual({ stdout: `${version}\n`, stderr: "", exitCode: 0 });
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("help succeeds without running the updater", async () => {
  // Given: the supported help argument.
  const args = ["src/index.ts", "--help"];
  // When: the real CLI executes.
  const result = await invoke(args);
  // Then: output exists and exit succeeds, without pinning prose.
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length).toBeGreaterThan(0);
  expect(result.stderr).toBe("");
});

test.each([
  { args: ["--bogus"] },
  { args: ["--version", "--bogus"] },
  { args: ["--help", "--version"] },
  { args: ["check"] },
  { args: ["update"] },
  { args: ["job"] },
  { args: ["tui"] },
])("unsupported argv %j exits without success output", async ({ args }) => {
  // Given: unsupported, conflicting, or future-product argv.
  const invocation = ["src/index.ts", ...args];
  // When: the actual entrypoint receives it.
  const result = await invoke(invocation);
  // Then: failure cannot look like a successful update.
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr.length).toBeGreaterThan(0);
});

test("importing the CLI is silent and leaves exit status unchanged", async () => {
  // Given: a consumer importing rather than launching the entrypoint.
  const args = ["-e", 'await import("./src/index.ts")'];
  // When: a subprocess imports it.
  const result = await invoke(args);
  // Then: import has no printing or process-exit side effects.
  expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});
