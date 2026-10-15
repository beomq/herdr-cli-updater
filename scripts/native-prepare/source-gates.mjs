#!/usr/bin/env bun
// Executes original source checks and records observations; never qualifies a CLI.
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pin = async path => ({ path: await realpath(path), sha256: hash(await readFile(path)) });

export async function runSourceGates({ output, bun, npm, node, baseline, revision = "source-gates" }) {
  const preparationPath = join(output, "preparation.json");
  const preparation = JSON.parse(await readFile(preparationPath, "utf8"));
  if (preparation.status !== "LOCAL_SOURCE_OVERLAY_PACKED_NOT_INSTALL_QUALIFIED")
    throw new Error("Original native preparation must finish before source gates");
  const engine = join(output, "sources/engine");
  const wrapper = join(output, "sources/wrapper");
  const coding = join(engine, "packages/coding-agent");
  const directory = join(output, revision);
  await mkdir(directory); // Do not silently replace earlier gate observations.
  const env = { HOME: join(output, "home"), TMPDIR: join(output, "tmp"),
    PATH: `${dirname(bun)}:${dirname(node)}:${dirname(npm)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CI: "1", HUSKY: "0", npm_config_userconfig: "/dev/null", npm_config_cache: join(output, "npm-cache") };
  const changed = preparation.hooks.engine.files.map(row => row.path.slice(`${engine}/`.length));
  const specifications = [
    // The locked wrapper install contains stock declarations. Check the native
    // wrapper against its actual packed engine outputs, without changing manifests.
    { name: "paired-native-engine-type-outputs", cwd: wrapper,
      argv: ["/bin/cp", "-R", `${join(output, "stages/code-yeongyu-senpi", preparation.target.engineVersion, "dist")}/.`,
        join(await realpath(join(wrapper, "node_modules/@code-yeongyu/senpi")), "dist")] },
    { name: "original-wrapper-task-types", cwd: wrapper,
      argv: [join(wrapper, "node_modules/.bin/tsgo"), "--noEmit", "-p", "packages/senpi-task/tsconfig.json"] },
    { name: "original-wrapper-extension-types", cwd: wrapper,
      argv: [join(wrapper, "node_modules/.bin/tsgo"), "--noEmit", "-p", "packages/omo-senpi/tsconfig.json"] },
    { name: "original-native-bridge-tests", cwd: coding,
      argv: [join(engine, "node_modules/.bin/vitest"), "run", "test/updater-native-bridge.test.ts"] },
    { name: "original-applied-unbundled-build", cwd: engine,
      argv: [npm, "--prefix", "packages/coding-agent", "run", "build:unbundled"] },
    { name: "original-source-tsgo", cwd: engine,
      argv: [join(engine, "node_modules/.bin/tsgo"), "--noEmit", "-p", "packages/coding-agent/tsconfig.build.json"] },
    { name: "changed-source-and-test-biome", cwd: engine,
      argv: [join(engine, "node_modules/.bin/biome"), "check", "--error-on-warnings",
        "packages/coding-agent/src/core/agent-session.ts",
        "packages/coding-agent/src/modes/interactive/interactive-mode.ts",
        "packages/coding-agent/test/updater-native-bridge.test.ts"] },
    { name: "latest-adapted-source-biome", cwd: engine,
      argv: [join(engine, "node_modules/.bin/biome"), "check", "--error-on-warnings",
        "packages/tui/src/terminal.ts",
        "packages/coding-agent/src/modes/rpc/connection-handler.ts",
        "packages/coding-agent/src/modes/rpc/rpc-types.ts",
        "packages/coding-agent/src/modes/rpc/session-command-router.ts"] },
    { name: "original-managed-input-tests", cwd: join(engine, "packages/tui"),
      argv: [node, "--test", "--import", "tsx", "--import", "./test/setup-multiplexer-env.mjs",
        "test/stdin-buffer-managed-boundary.test.ts"] },
  ];
  if (baseline) specifications.push(
    { name: "baseline-root-tsgo-observation", cwd: baseline, observation: true,
      argv: [join(engine, "node_modules/.bin/tsgo"), "--noEmit"] },
    { name: "baseline-broad-biome-observation", cwd: baseline, observation: true,
      argv: [join(engine, "node_modules/.bin/biome"), "check", "--error-on-warnings", ...changed] },
  );
  const report = { schemaVersion: 1, target: preparation.target, nativeFlowQualified: false,
    preparation: await pin(preparationPath), sourceBinding: preparation.sourceBinding,
    tools: await Promise.all([bun, npm, node].map(pin)), checks: [] };
  const reportPath = join(directory, "source-gates.json");
  for (const specification of specifications) {
    console.log(`GATE START ${specification.name}`);
    const child = Bun.spawn(specification.argv, { cwd: specification.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const stdoutPath = join(directory, `${specification.name}.stdout.txt`);
    const stderrPath = join(directory, `${specification.name}.stderr.txt`);
    await writeFile(stdoutPath, stdout);
    await writeFile(stderrPath, stderr);
    report.checks.push({ ...specification, exitCode, stdout: await pin(stdoutPath), stderr: await pin(stderrPath) });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`GATE END ${specification.name} exit=${exitCode}`);
  }
  report.status = report.checks.filter(row => !row.observation).every(row => row.exitCode === 0) ? "SOURCE_CHECKS_PASSED" : "SOURCE_CHECKS_FAILED";
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  preparation.sourceGates = await pin(reportPath);
  await writeFile(preparationPath, JSON.stringify(preparation, null, 2));
  console.log(`${report.status} ${reportPath}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    if (!["output", "bun", "npm", "node", "baseline", "revision"].includes(key) || !args[i + 1] || options[key]) throw new Error("Invalid source gate argument");
    options[key] = args[i + 1];
  }
  for (const key of ["output", "bun", "npm", "node"]) if (!options[key]) throw new Error(`Missing --${key}`);
  const report = await runSourceGates(options);
  process.exitCode = report.status === "SOURCE_CHECKS_PASSED" ? 0 : 1;
}
