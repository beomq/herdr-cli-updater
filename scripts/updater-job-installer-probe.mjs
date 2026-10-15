import { cpSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { discoverExecutable } from "../src/discovery.ts";
import { qualifyOmoUpdate, createOmoUpdateSpec, executeOmoUpdate } from "../src/adapters/update-context.ts";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/updater-single-job";
const set = JSON.parse(readFileSync("/Users/beomseok/.local/share/herdr-cli-updater/runtime.json"));
const input = JSON.parse(readFileSync(set.configurations.find(p => p.path.startsWith(root + "/")).path));
const probe = process.argv[2] ?? join(root, `installer-probe-${Date.now()}`), prefix = join(probe, "prefix"), home = join(probe, "home");
if (!process.argv[2]) {
  mkdirSync(probe, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  cpSync(input.coverage.prefix, prefix, { recursive: true, dereference: false });
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pin = path => ({ path: realpathSync(path), sha256: hash(readFileSync(path)) });
const mapped = path => join(prefix, relative(input.coverage.prefix, path));
const installation = input.update.qualification.installation;
const resources = installation.resources.filter(row => row.realpath !== join(input.coverage.prefix, "discovery.json"))
  .map(row => ({ path: mapped(row.realpath), sha256: pin(mapped(row.realpath)).sha256 }));
const discovery = { family: "omo", executable: mapped(installation.executableRealpath), channel: "latest",
  packageManifest: join(prefix, "install/global/node_modules/omo-ai/package.json"),
  owner: { ...installation.owner, prefix, engineResourceId: `resource:${hash(join(prefix, "install/global/node_modules/@code-yeongyu/senpi/package.json"))}` }, resources };
const provenancePath = join(prefix, "discovery.json");
writeFileSync(provenancePath, JSON.stringify(discovery), { mode: 0o600 });
const found = await discoverExecutable({ executable: discovery.executable, family: "omo", provenance: [pin(provenancePath)] });
if (!found.ok) throw new Error(`Probe discovery failed: ${JSON.stringify(found.error)}`);
const now = Date.now();
const qualification = { ...input.update.qualification, installation: found.value.installation,
  env: { ...input.update.qualification.env, HOME: home, BUN_INSTALL: prefix },
  target: { ...input.update.qualification.target, checkedAt: now, expiresAt: now + 300000,
    postinstall: input.update.qualification.target.postinstall.map(p => ({ ...p, path: mapped(p.path) })) } };
const receiptPath = join(probe, "qualification.json");
writeFileSync(receiptPath, JSON.stringify(qualification), { mode: 0o600 });
const qualified = await qualifyOmoUpdate({ qualification, receipt: pin(receiptPath) }, now, input.overlays);
if (!qualified.ok) throw new Error(`Probe qualification failed: ${qualified.error.code}`);
const spec = createOmoUpdateSpec(qualified.value, "update-only", Date.now());
if (!spec.ok) throw new Error(`Probe specification failed: ${spec.error.code}`);
const result = await executeOmoUpdate(spec.value, { now: Date.now, run: async command => {
  const child = Bun.spawn([command.executable, ...command.args], { cwd: command.cwd, env: command.env,
    stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  writeFileSync(join(probe, "manager-output.json"), JSON.stringify({ stdout, stderr, status }), { mode: 0o600 });
  console.log(`INSTALLER_PROBE_EXIT ${status}\n${stderr}`);
  return { status, signal: null };
} });
writeFileSync(join(probe, "result.json"), JSON.stringify(result), { mode: 0o600 });
console.log(`INSTALLER_PROBE_RESULT ${JSON.stringify(result)} ${probe}`);
