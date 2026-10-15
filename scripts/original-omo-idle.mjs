// Read process arguments only; never reads configuration or conversation files.
const prefix = "/Users/beomseok/.bun/install/global/node_modules/";
const child = Bun.spawn(["/bin/ps", "-axo", "pid=,uid=,command="], {
  env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdout: "pipe", stderr: "pipe",
});
const [text, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
if (exit !== 0) throw new Error(`Process census failed: ${stderr}`);
const consumers = text.split("\n").flatMap(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  if (!match || Number(match[2]) !== process.getuid()) return [];
  const command = match[3];
  return command.includes(prefix) && (command.includes("/omo-ai/") || command.includes("/@code-yeongyu/senpi/"))
    ? [Number(match[1])] : [];
});
console.log(consumers.length ? `ORIGINAL_OMO_BUSY ${consumers.length} pids=${consumers.join(",")}` : "ORIGINAL_OMO_IDLE");
process.exitCode = consumers.length ? 1 : 0;
