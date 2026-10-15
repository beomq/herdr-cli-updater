import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { prepareCodexUpgradeProfile, prepareRestartRuntime } from "../src/service/restart-runtime";

/** Capture current source/native identity only. No installer or restart runs.
 * Register the resulting configuration with the existing prepared-runtime path. */
if (import.meta.main) {
  const args = parseArgs({ options: { candidate: { type: "string" }, output: { type: "string" } }, strict: true });
  const candidate = z.string().startsWith("/").parse(args.values.candidate);
  const output = z.string().startsWith("/").parse(args.values.output);
  const pin = z.object({ path: z.string().startsWith("/"), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
  const input = z.object({
    ownerDirectory: z.string().startsWith("/"), executable: z.string().startsWith("/"),
  family: z.enum(["codex", "omp", "pi", "omo", "claude"]).optional(),
    provenance: z.array(pin).min(1).max(32),
    native: z.object({
      coreSocket: z.string().startsWith("/"), operationsPath: z.string().startsWith("/"),
      runtimeId: z.string(), profile: z.string(), sessionPath: z.string().startsWith("/"),
      node: pin, paneId: z.string(),
    }).strict(),
    codexUpgrade: z.object({ previousProfile: pin, executable: pin,
      profile: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict().optional(),
  }).strict().parse(JSON.parse(readFileSync(candidate, "utf8")));
  if (input.codexUpgrade && input.family !== undefined && input.family !== "codex")
    throw new TypeError("Codex upgrade preparation requires Codex family");
  const native = input.codexUpgrade
    ? (await prepareCodexUpgradeProfile({ native: input.native, ...input.codexUpgrade })).native : input.native;
  console.log(JSON.stringify(await prepareRestartRuntime(output, { ...input, native })));
}
