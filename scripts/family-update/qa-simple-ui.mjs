import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveDomainWorker } from "../../src/service/worker.ts";
import { startTerminal, openTerminalCapture } from "../../.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/terminal.mjs";

const project = await realpath(join(import.meta.dirname, "../.."));
const root = await realpath(await mkdtemp(join(tmpdir(), "updater-six-ui-")));
const evidence = join(project, ".omo/evidence/herdr-cli-updater/six-families/simple-ui");
await mkdir(evidence, { recursive: true });
let worker, terminal, capture;
const signal = AbortSignal.timeout(180000);
try {
  const directory = join(root, "worker");
  worker = await serveDomainWorker(directory);
  const env = { ...process.env, HERDR_CLI_UPDATER_DIRECTORY: directory };
  delete env.HERDR_CLI_UPDATER_RUNTIME_CONFIG;
  delete env.HERDR_CLI_UPDATER_RUNNER_FACTORY;
  capture = await openTerminalCapture({ paths: { tmp: root } },
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", env);
  terminal = startTerminal([process.execPath, join(project, "scripts/plugin.ts"), "tui"], project, env, signal, 120, 38);
  await terminal.expect(async raw => {
    const text = await capture.screen(raw, terminal.cols, terminal.rows);
    return text.includes("Installed CLIs:") && text.includes("Working") && text.includes("Ready")
      && !text.includes("Checking") && !text.includes("Not checked");
  }, 0, 60000);
  const sink = async (name, bytes) => Bun.write(join(evidence, name), bytes);
  await capture.capture(terminal, "catalog-120", sink);
  const small = terminal.expect(async raw => {
    const text = await capture.screen(raw, terminal.cols, terminal.rows);
    return text.includes("Installed CLIs:") && text.includes("Working") && text.includes("Ready");
  });
  terminal.resize(80, 24);
  await small;
  await capture.capture(terminal, "catalog-80", sink);
  const closed = terminal.child.exited;
  terminal.write("q");
  await closed;
  console.log("SIMPLE_UI_QA_OK", evidence);
} finally {
  await terminal?.close();
  await capture?.close();
  await worker?.stop();
  await rm(root, { recursive: true });
}
