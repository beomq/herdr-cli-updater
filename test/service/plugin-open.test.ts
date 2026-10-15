import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { attachWorker, discoverWorker, stopWorker } from "../../src/service/worker";

const roots: string[] = [];
const terminals: Bun.Subprocess[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const terminal of terminals.splice(0)) {
    if (terminal.exitCode === null) terminal.kill("SIGTERM");
    await terminal.exited;
    terminal.terminal?.close();
  }
  for (const directory of directories.splice(0)) {
    await stopWorker(discoverWorker(directory));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

test("default open starts once, reuses the authenticated worker and leaves it alive when UI closes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plugin-open-")));
  roots.push(root);
  const directory = join(root, "worker");
  directories.push(directory);
  const env = { ...process.env, HOME: root, PATH: dirname(process.execPath), HERDR_SOCKET: "",
    XDG_CONFIG_HOME: join(root, "config"), HERDR_CLI_UPDATER_SOURCE_PREFIXES: "",
    HERDR_CLI_UPDATER_DIRECTORY: directory };
  let firstPid: number | undefined;
  for (const command of [[], ["open"]]) {
    const shown = Promise.withResolvers<void>();
    let output = "";
    const terminal = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/plugin.ts"), ...command], {
      cwd: root, env, terminal: { cols: 80, rows: 24, data(_terminal, data) {
        output += Buffer.from(data).toString("utf8");
        if (Bun.stripANSI(output).includes("CLI UPDATER")) shown.resolve();
      } },
    });
    terminals.push(terminal);
    await Promise.race([shown.promise, terminal.exited.then(() => { throw new Error(`Plugin exited before UI: ${Bun.stripANSI(output)}`); })]);
    const owner = discoverWorker(directory);
    if (firstPid === undefined) firstPid = owner.pid;
    else expect(owner.pid).toBe(firstPid);
    const closing = terminal.exited;
    terminal.terminal!.write("q");
    expect({ exit: await closing, output: Bun.stripANSI(output) }).toMatchObject({ exit: 0 });
    terminal.terminal!.close();
    const connection = await attachWorker(directory);
    connection.close();
  }
}, 30000);
