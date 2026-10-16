import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerPreparedRuntime } from "../../scripts/plugin";
import { configurePluginRuntime, RUNTIME_SET_PROFILE } from "../../src/service/plugin-runtime";
import { loadRestartRuntime, RESTART_RUNTIME_PROFILE, validateRestartRuntimeInputs } from "../../src/service/restart-runtime";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(family: "codex" | "omp" | "pi" | "omo" | "claude" = "codex") {
  const root = realpathSync(mkdtempSync("/tmp/restart-runtime-input-"));
  const executable = join(root, "codex");
  writeFileSync(executable, "fixture", { mode: 0o600 });
  const pin = { path: executable, sha256: hash("fixture") };
  const resources = [{ resourceId: `resource:${hash(executable)}`, realpath: executable, fingerprint: `sha256:${pin.sha256}` }];
  const input = { schemaVersion: 1, profile: RESTART_RUNTIME_PROFILE, ownerDirectory: join(root, "worker"),
    installation: { installationId: `install:${hash(executable)}`, family, channel: "latest",
      executableRealpath: executable, installedVersion: { kind: "known", version: "2.0.0" },
      resourcesFingerprint: `sha256:${hash(JSON.stringify(resources))}`, resources,
      owner: { kind: "package", manager: "npm", packageName: { codex: "@openai/codex", omp: "@oh-my-pi/pi-coding-agent",
        pi: "@code-yeongyu/senpi", omo: "omo-ai", claude: "@anthropic-ai/claude-code" }[family], prefix: root } },
    provenance: [pin], native: { coreSocket: join(root, "core.sock"), operationsPath: join(root, "operations"),
      runtimeId: "runtime", profile: "codex", sessionPath: join(root, "session.jsonl"), node: pin, paneId: "pane" } } as const;
  return { root, input };
}
test.each(["codex", "omp", "omo", "claude"] as const)("%s restart preparation registers independently and replaces the same installation profile", async family => {
  const { root, input } = fixture(family);
  try {
    const configuration = join(root, "restart.json"), runtime = join(root, "runtime.json");
    configurePluginRuntime(configuration, input);
    const pin = { path: configuration, sha256: hash(readFileSync(configuration, "utf8")) };
    await registerPreparedRuntime(runtime, pin);
    expect(JSON.parse(readFileSync(runtime, "utf8"))).toEqual({ schemaVersion: 1, profile: RUNTIME_SET_PROFILE, configurations: [pin] });
    const next = join(root, "next.json");
    configurePluginRuntime(next, input);
    const nextPin = { path: next, sha256: hash(readFileSync(next, "utf8")) };
    await registerPreparedRuntime(runtime, nextPin);
    expect(JSON.parse(readFileSync(runtime, "utf8"))).toEqual({ schemaVersion: 1, profile: RUNTIME_SET_PROFILE, configurations: [nextPin] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test.each(["@code-yeongyu/senpi", "@earendil-works/pi-coding-agent"])("rejects unqualified Pi restart package %s", packageName => {
  const { root, input } = fixture("pi");
  try {
    expect(() => validateRestartRuntimeInputs({ ...input, installation: { ...input.installation,
      owner: { ...input.installation.owner, packageName } } })).toThrow("verification_failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("restart input cannot carry a serialized binding, update spec or another owner socket", async () => {
  const { root, input } = fixture();
  try {
    expect(() => validateRestartRuntimeInputs({ ...input, native: { ...input.native, expectedBinding: {} } })).toThrow();
    expect(() => validateRestartRuntimeInputs({ ...input, update: {} })).toThrow();
    const config = join(root, "restart.json");
    configurePluginRuntime(config, input);
    await expect(loadRestartRuntime({ directory: input.ownerDirectory, coreSocket: join(root, "foreign.sock") },
      { path: config, sha256: hash(readFileSync(config, "utf8")) }, input)).rejects.toThrow("verification_failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex native restart retains its actual installer owner without inventing a package", () => {
  // Given
  const { root, input } = fixture();
  const installation = { ...input.installation,
    owner: { kind: "native", prefix: root, installerDigest: "a".repeat(64) } } as const;
  try {
    // When
    const result = validateRestartRuntimeInputs({ ...input, installation });
    // Then
    expect(result.installation.owner).toEqual(installation.owner);
    expect(() => validateRestartRuntimeInputs({ ...input, installation: { ...installation, family: "omp" } })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
