import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// A new, explicit installation only. Never changes PATH, the shared Bun prefix,
// user credentials, or any running conversation.
const [root, originalBun] = process.argv.slice(2);
if (!root || !originalBun || !isAbsolute(root) || !isAbsolute(originalBun)
  || realpathSync(dirname(root)) !== dirname(root))
  throw new TypeError("usage: bun scripts/install-isolated-omo.ts NEW_ABSOLUTE_ROOT ORIGINAL_BUN");
const bun = realpathSync(originalBun), nodePath = Bun.which("node");
if (!nodePath) throw new TypeError("original Node is required by OmO postinstall");
const node = realpathSync(nodePath);
for (const path of [bun, node]) {
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0)
    throw new TypeError("unowned or unsafe original interpreter");
}
mkdirSync(root, { mode: 0o700 }); // Existing destinations are deliberately refused.
const prefix = join(root, "prefix"), global = join(prefix, "install/global"), home = join(root, "home"), cache = join(root, "cache");
for (const path of [global, home, cache]) mkdirSync(path, { recursive: true, mode: 0o700 });
writeFileSync(join(global, "package.json"), JSON.stringify({ dependencies: { "omo-ai": "5.1.9" },
  trustedDependencies: ["omo-ai"] }), { mode: 0o600, flag: "wx" });
const sub = (path: string) => `(subpath ${JSON.stringify(path)})`;
const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
const policy = `(version 1)(allow default)(deny file-read* file-write*)(allow file-read-metadata)
(allow file-read* ${[literal("/"), sub(root), literal(bun), literal(node),
  ...["/System", "/usr/lib", "/usr/share", "/Library/Apple", "/System/Cryptexes",
    "/System/Volumes/Preboot/Cryptexes", "/private/var/db/dyld", "/private/var/db/timezone", "/private/etc/ssl"].map(sub),
  ...["/private/etc/hosts", "/private/etc/resolv.conf", "/private/etc/localtime", "/dev/null", "/dev/random",
    "/dev/urandom", "/bin/sh", "/bin/bash", "/usr/bin/env"].map(literal)].join(" ")})
(allow file-write* ${sub(root)})(allow file-write-data (literal "/dev/null"))
(deny signal)(allow signal (target same-sandbox))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.CredentialStore"))`;
writeFileSync(join(root, "installation.sb"), policy, { mode: 0o600, flag: "wx" });
const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", policy, bun, "add", "-g", "omo-ai@5.1.9",
  "--registry", "https://registry.npmjs.org", "--cache-dir", cache, "--linker", "hoisted"], {
  cwd: global, env: { BUN_INSTALL: prefix, HOME: home, PATH: `${dirname(bun)}:${dirname(node)}` },
  stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
const deadline = setTimeout(() => child.kill("SIGKILL"), 240_000);
try {
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(root, "installation.stdout"), stdout, { mode: 0o600, flag: "wx" });
  writeFileSync(join(root, "installation.stderr"), stderr, { mode: 0o600, flag: "wx" });
  if (status !== 0) throw new Error(`isolated OmO installation exited ${status}; ${join(root, "installation.stderr")}`);
  process.stdout.write(`Isolated OmO 5.1.9 installed. Shared installation unchanged.\n${prefix}\n`);
} finally { clearTimeout(deadline); }
