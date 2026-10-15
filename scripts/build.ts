import { mkdirSync, rmSync } from "node:fs";

mkdirSync("dist/web", { recursive: true });
const result = await Bun.build({
  entrypoints: ["web/main.tsx"], outdir: "dist/web", target: "browser",
  minify: true, splitting: false, define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) throw new AggregateError(result.logs, "web_build_failed");
await Bun.write("dist/web/index.html", Bun.file("web/index.html"));
for (const name of ["landing.html", "landing.css"]) rmSync(`dist/web/${name}`, { force: true });
await Bun.write("dist/web/brand.svg", Bun.file("web/brand.svg"));
for (const name of new Bun.Glob("*.{png,ico,txt}").scanSync("web/assets")) {
  await Bun.write(`dist/web/${name}`, Bun.file(`web/assets/${name}`));
}
await Bun.write("dist/web/agent-marks-LICENSE.md", Bun.file("web/agent-marks-LICENSE.md"));
console.log(`Built standalone web assets (${result.outputs.length} bundles). Runtime TS entries remain relocatable.`);
