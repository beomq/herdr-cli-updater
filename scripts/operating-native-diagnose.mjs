import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const root = "/Users/beomseok/.local/share/herdr-cli-updater/operating-native/evidence";
const c = JSON.parse(readFileSync(`${root}/candidate.json`));
const body = JSON.stringify(c.update.qualification), path = `${root}/qualification-debug.json`;
writeFileSync(path, body, { mode: 0o600 });
const built = await Bun.build({ entrypoints: [join(import.meta.dirname, "../src/adapters/update-context.ts")], target: "bun", sourcemap: "inline",
  plugins: [{ name: "private-stack-only", setup(build) {
    build.onLoad({ filter: /update-context\.ts$/ }, args => ({ loader: "ts", contents: readFileSync(args.path, "utf8")
      .replace("} catch { return failure(); }\n}\nexport function createOmoUpdateSpec", "} catch (error) { console.error(error instanceof Error ? error.stack : 'non_error'); return failure(); }\n}\nexport function createOmoUpdateSpec") }));
  } }] });
if (!built.success) throw new Error("Diagnostic build failed");
const module = await import(`data:text/javascript;base64,${Buffer.from(await built.outputs[0].text()).toString("base64")}`);
console.log(JSON.stringify(await module.qualifyOmoUpdate({ qualification: c.update.qualification, receipt: { path, sha256: createHash("sha256").update(body).digest("hex") } }, Date.now(), c.overlays)));
