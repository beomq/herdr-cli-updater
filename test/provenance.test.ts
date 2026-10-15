import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { families, parseRegistry, sha256, verifyProvenance, verifyReceiptConsistency, parseRestrictedShellCase } from "../scripts/qa/provenance";
import type { IdentityQualification } from "../scripts/qa/provenance";
import type { Action } from "../scripts/qa/provenance";

type FixtureArtifact = { path: string; sha256: string };
type FixtureInstaller = {
  family: string;
  owner: IdentityQualification;
  channel: IdentityQualification;
  sourceUrl: string;
  source: FixtureArtifact;
  parser: FixtureArtifact;
};

async function command(argv: readonly string[], cwd: string) {
  const child = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")}: ${stderr}`);
  return stdout.trim();
}

async function fixture(root: string) {
  const schema = '{"protocol":22,"schema_version":1,"schemas":{}}\n';
  await Bun.write(join(root, "Cargo.toml"), '[package]\nname = "herdr"\nversion = "0.9.1"\n');
  await Bun.write(join(root, "docs/next/api/herdr-api.schema.json"), schema);
  await command(["git", "init", "-q"], root);
  await command(["git", "add", "Cargo.toml", "docs/next/api/herdr-api.schema.json"], root);
  await command(["git", "-c", "user.name=QA", "-c", "user.email=qa@invalid", "commit", "-qm", "fixture"], root);
  const sourceRef = await command(["git", "rev-parse", "HEAD"], root);
  await command(["git", "tag", "v0.9.1"], root);
  const archive = Bun.spawn(["git", "archive", "--format=tar", sourceRef], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const archiveBytes = new Uint8Array(await new Response(archive.stdout).arrayBuffer());
  expect(await archive.exited).toBe(0);
  // Isolated synthetic core only; this does not claim a real herdr release build.
  const binary = `#!${process.execPath}\nif (process.argv[2] === "--version") console.log("herdr 0.9.1"); else process.stdout.write(${JSON.stringify(schema)});\n`;
  const binaryHash = sha256(binary);
  const schemaHash = sha256(schema);
  async function file(path: string, body: string) {
    await Bun.write(join(root, path), body);
    return { path, sha256: sha256(body) };
  }
  const binaryArtifact = await file("bin/herdr", binary);
  await chmod(join(root, "bin/herdr"), 0o700);
  const buildReceipt = await file("build.json", JSON.stringify({ command: "cargo build --locked --release", exitCode: 0, sourceRef, toolchain: "synthetic-rustc", binarySha256: binaryHash }));
  const releaseReceipt = await file("release.json", JSON.stringify({ tag: "v0.9.1", sourceRef, version: "0.9.1", binarySha256: binaryHash, schemaSha256: schemaHash }));
  const installers = await Promise.all(families.map(async (family): Promise<FixtureInstaller> => {
    const source = await file(`${family}.sh`, "#!/bin/sh\ncase \"$1\" in\n-d|--dir) ;;\n-h|--help) ;;\n*) exit 2 ;;\nesac\n");
    const sourceUrl = `https://fixture.invalid/${family}`;
    const owner: IdentityQualification = { state: "qualified", value: `fixture-${family}`, evidence: source };
    const channel: IdentityQualification = { state: "qualified", value: "fixture", evidence: source };
    const parser = await file(`${family}.json`, JSON.stringify({ method: "restricted-shell-case", sourceSha256: source.sha256, sourceUrl, owner: owner.value, channel: channel.value, acceptedOptions: ["-d", "--dir", "-h", "--help"] }));
    return { family, owner, channel, sourceUrl, source, parser };
  }));
  return {
    manifestVersion: 1,
    core: { sourceRef, sourceArchiveSha256: sha256(archiveBytes), releaseTag: "v0.9.1", version: "0.9.1", protocol: 22, schemaVersion: 1, toolchain: "synthetic-rustc", binary: binaryArtifact, schema: await file("schema.json", schema), buildReceipt, releaseReceipt },
    installed: { version: "0.9.1", protocol: 22, schemaVersion: 1, binarySha256: binaryHash, schemaSha256: schemaHash },
    installers,
  };
}

test.each([null, {}, { manifestVersion: 2 }, { manifestVersion: 1, core: {}, installed: {}, installers: [] }])("blocks malformed registry %j at the machine boundary", (input) => {
  // Given: malformed machine input. When: the production parser reads it.
  // Then: no source command or installer can be reached.
  expect(() => parseRegistry(input)).toThrow();
});

test("reports fully pinned synthetic artifacts as consistency only, never observed support", async () => {
  const root = await mkdtemp(join(tmpdir(), "provenance-valid-"));
  try {
    // Given: synthetic receipts; no actual Rust build or official acquisition producer.
    const input = await fixture(root);
    const actions: Action[] = [];
    // When: the actual parser and verifier run including readonly core commands.
    const result = await verifyReceiptConsistency(parseRegistry(input), root, actions);
    // Then: all links agree, no update/restart command was launched.
    expect(result.status).toBe("CONSISTENT");
    expect(result.supportEnabled).toBe(false);
    expect(actions.some((action) => action.argv.includes("--version"))).toBe(true);
    expect(actions.some((action) => action.argv.includes("update") || action.argv.includes("install"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    expect(await Bun.file(join(root, "Cargo.toml")).exists()).toBe(false);
  }
});

test.each([
  ["source", "core.sourceRef"],
  ["schema", "releaseReceipt"],
  ["protocol", "schema"],
  ["build", "buildReceipt"],
  ["installer", "omo.sh"],
  ["agy-flags", "agy.parser"],
])("blocks %s mapping mismatch before installer effects", async (kind, field) => {
  const root = await mkdtemp(join(tmpdir(), "provenance-mismatch-"));
  try {
    // Given: an otherwise valid fixture with a changed provenance link.
    const input = await fixture(root);
    switch (kind) {
      case "source": input.core.sourceRef = "a".repeat(40); break;
      case "schema": input.installed.schemaSha256 = "b".repeat(64); break;
      case "protocol": input.installed.protocol = 23; break;
      case "build": input.core.toolchain = "wrong-toolchain"; break;
      case "installer": {
        const installer = input.installers[0];
        if (!installer) throw new Error("fixture missing installer");
        installer.source.sha256 = "c".repeat(64);
        break;
      }
      case "agy-flags": {
        const agy = input.installers.find((row) => row.family === "agy");
        if (!agy) throw new Error("fixture missing agy");
        if (agy.owner.state !== "qualified" || agy.channel.state !== "qualified") throw new Error("invalid fixture identity");
        const body = JSON.stringify({ method: "restricted-shell-case", sourceSha256: agy.source.sha256, sourceUrl: agy.sourceUrl, owner: agy.owner.value, channel: agy.channel.value, acceptedOptions: ["--dir", "--skip-path"] });
        await Bun.write(join(root, agy.parser.path), body);
        agy.parser.sha256 = sha256(body);
        break;
      }
    }
    const actions: Action[] = [];
    // When: consistency is checked without the independent-producer readiness gate.
    const verification = verifyReceiptConsistency(parseRegistry(input), root, actions);
    // Then: the intended machine boundary rejects; a later unrelated failure cannot mask it.
    await expect(verification).rejects.toMatchObject({ field });
    expect(actions.some((action) => action.argv.includes("update") || action.argv.includes("install"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    expect(await Bun.file(join(root, "Cargo.toml")).exists()).toBe(false);
  }
});

test("real CLI blocks a bad binary digest and emits evidence with zero resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "provenance-cli-"));
  try {
    // Given: isolated malformed digest with no live installation use.
    const input = await fixture(root);
    input.core.binary.sha256 = "d".repeat(64);
    const buildBody = JSON.stringify({ command: "cargo build --locked --release", exitCode: 0, sourceRef: input.core.sourceRef, toolchain: input.core.toolchain, binarySha256: input.core.binary.sha256 });
    await Bun.write(join(root, input.core.buildReceipt.path), buildBody);
    input.core.buildReceipt.sha256 = sha256(buildBody);
    await Bun.write(join(root, "registry.json"), JSON.stringify(input));
    const evidence = process.env["PROVENANCE_EVIDENCE_DIR"] ?? join(root, "evidence");
    // When: actual CLI entrypoint receives concrete registry/core/evidence arguments.
    const child = Bun.spawn([process.execPath, new URL("../scripts/qa/provenance.ts", import.meta.url).pathname, "--registry", join(root, "registry.json"), "--core-source", root, "--evidence-dir", evidence], { stdout: "pipe", stderr: "pipe", timeout: 15000 });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Then: nonzero blocked result and explicit no-effect cleanup are machine-readable.
    expect(code).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ status: "BLOCKED", updaterInvocations: 0, restartInvocations: 0 });
    expect(await Bun.file(join(evidence, "cleanup.json")).json()).toMatchObject({ resourcesCreated: 0, resourcesRemaining: 0 });
    expect(await Bun.file(join(evidence, "result.json")).json()).toMatchObject({ status: "BLOCKED" });
    if (process.env["PROVENANCE_EVIDENCE_DIR"]) {
      await Bun.write(join(evidence, "stdout.txt"), stdout);
      await Bun.write(join(evidence, "stderr.txt"), stderr);
      await Bun.write(join(evidence, "exit.json"), JSON.stringify({ exitCode: code, fixture: root }));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    expect(await Bun.file(join(root, "Cargo.toml")).exists()).toBe(false);
    const evidence = process.env["PROVENANCE_EVIDENCE_DIR"];
    if (evidence) await Bun.write(join(evidence, "fixture-cleanup.json"), JSON.stringify({ removed: root, exists: await Bun.file(join(root, "Cargo.toml")).exists(), resourcesRemaining: 0 }));
  }
});

test.each(["forged-build", "unknown-channel", "invented-parser-option", "agy-comment-only", "dirty-untracked"])("blocks adversarial CLI %s instead of false PASS", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "provenance-adversarial-"));
  const evidenceBase = process.env["PROVENANCE_REGRESSION_EVIDENCE_DIR"];
  const evidence = evidenceBase ? join(evidenceBase, scenario) : join(root, "evidence");
  try {
    // Given: concrete reproductions from the independent verifier, not matching assertions.
    const input = await fixture(root);
    const row = input.installers[0];
    if (!row) throw new Error("missing fixture installer");
    let blockedField = "";
    switch (scenario) {
      case "forged-build": {
        blockedField = "qualification.producer";
        input.core.toolchain = "rustc-NOT-INSTALLED";
        const body = JSON.stringify({ command: "cargo build --locked --release", exitCode: 0, sourceRef: input.core.sourceRef, toolchain: input.core.toolchain, binarySha256: input.core.binary.sha256 });
        await Bun.write(join(root, input.core.buildReceipt.path), body);
        input.core.buildReceipt.sha256 = sha256(body);
        break;
      }
      case "unknown-channel": {
        blockedField = "omo.owner";
        row.owner = { state: "unknown", reason: "unresolved local installation owner" };
        row.channel = { state: "unknown", reason: "unknown distribution channel" };
        const body = JSON.stringify({ method: "restricted-shell-case", sourceSha256: row.source.sha256, sourceUrl: row.sourceUrl, owner: "unresolved", channel: "unknown", acceptedOptions: ["-d", "--dir", "-h", "--help"] });
        await Bun.write(join(root, row.parser.path), body);
        row.parser.sha256 = sha256(body);
        break;
      }
      case "invented-parser-option": {
        blockedField = "omo.parser";
        if (row.owner.state !== "qualified" || row.channel.state !== "qualified") throw new Error("invalid fixture identity");
        const body = JSON.stringify({ method: "restricted-shell-case", sourceSha256: row.source.sha256, sourceUrl: row.sourceUrl, owner: row.owner.value, channel: row.channel.value, acceptedOptions: ["--option-not-in-source"] });
        await Bun.write(join(root, row.parser.path), body);
        row.parser.sha256 = sha256(body);
        break;
      }
      case "agy-comment-only": {
        blockedField = "parser.implementation";
        const agy = input.installers.find((item) => item.family === "agy");
        if (!agy) throw new Error("missing fixture agy");
        const body = "#!/bin/sh\n# -d|--dir)\n# -h|--help)\nexit 1\n";
        await Bun.write(join(root, agy.source.path), body);
        agy.source.sha256 = sha256(body);
        if (agy.owner.state !== "qualified" || agy.channel.state !== "qualified") throw new Error("invalid fixture identity");
        const parser = JSON.stringify({ method: "restricted-shell-case", sourceSha256: agy.source.sha256, sourceUrl: agy.sourceUrl, owner: agy.owner.value, channel: agy.channel.value, acceptedOptions: ["-d", "--dir", "-h", "--help"] });
        await Bun.write(join(root, agy.parser.path), parser);
        agy.parser.sha256 = sha256(parser);
        break;
      }
      case "dirty-untracked":
        blockedField = "core.inputs";
        await Bun.write(join(root, "build.rs"), 'fn main() { panic!("untracked build input"); }\n');
        break;
    }
    await Bun.write(join(root, "registry.json"), JSON.stringify(input));
    const argv = [process.execPath, new URL("../scripts/qa/provenance.ts", import.meta.url).pathname, "--registry", join(root, "registry.json"), "--core-source", root, "--evidence-dir", evidence];
    // When: the actual CLI evaluates each forged/missing boundary.
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", timeout: 15000 });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    await Bun.write(join(evidence, "execution.json"), JSON.stringify({ argv, env: {}, stdout, stderr, exitCode }, null, 2));
    // Then: no mutation case can advertise observed readiness.
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ status: "BLOCKED", supportEnabled: false, blockedField });
  } finally {
    await rm(root, { recursive: true, force: true });
    const exists = await Bun.file(join(root, "Cargo.toml")).exists();
    if (evidenceBase) await Bun.write(join(evidence, "fixture-cleanup.json"), JSON.stringify({ removed: root, exists, resourcesRemaining: 0 }));
    expect(exists).toBe(false);
  }
});

test("synthetic consistency cannot enable support without an independent producer", async () => {
  const root = await mkdtemp(join(tmpdir(), "provenance-unobserved-"));
  try {
    // Given: caller can generate internally consistent receipts.
    const registry = parseRegistry(await fixture(root));
    // When: no trusted observer is supplied at the API boundary.
    const verification = verifyProvenance(registry, root, []);
    // Then: no observed readiness can be returned.
    await expect(verification).rejects.toMatchObject({ field: "qualification.producer" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ignored build.rs is rejected even when Git tracked diff is clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "provenance-ignored-"));
  try {
    // Given: ignored inputs are visible to Cargo but absent from the immutable archive.
    const registry = parseRegistry(await fixture(root));
    await Bun.write(join(root, ".git/info/exclude"), "build.rs\n");
    await Bun.write(join(root, "build.rs"), 'fn main() { panic!("ignored"); }\n');
    // When: the production consistency checker inventories build inputs.
    const verification = verifyReceiptConsistency(registry, root, []);
    // Then: it names the source-input boundary rather than approving clean tracked diff.
    await expect(verification).rejects.toMatchObject({ field: "core.inputs" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legitimate generated target outputs do not count as extra source inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "provenance-generated-"));
  try {
    // Given: normal generated build artifacts beside honest synthetic consistency fixtures.
    const registry = parseRegistry(await fixture(root));
    await Bun.write(join(root, "target/generated/build.rs"), "generated-output");
    // When: tracked source plus untracked/ignored inventory is checked.
    const result = await verifyReceiptConsistency(registry, root, []);
    // Then: outputs are allowed, but never promoted to observed readiness.
    expect(result).toMatchObject({ status: "CONSISTENT", supportEnabled: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([
  '#!/bin/sh\n# case "$1" in\n# --dir) ;;\n# *) exit 2 ;;\n# esac\nexit 1\n',
  'echo \'case "$1" in\'\n--dir) ;;\n*) exit 2 ;;\nesac\n',
  'if false; then\ncase "$1" in\n--dir) ;;\n*) exit 2 ;;\nesac\nfi\n',
])("comments quoted data and dead shell blocks are not accepted parser implementations", (source) => {
  // Given: option-shaped text with no actual supported executable dispatch.
  // When: the restricted implementation parser examines whole syntax.
  // Then: extraction cannot promote incidental bytes into accepted options.
  expect(() => parseRestrictedShellCase(source)).toThrow();
});
