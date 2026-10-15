import { readFileSync, realpathSync } from "node:fs";
import { z } from "zod";
import { prepareOmoInstallationRuntime, OmoPreparationError } from "../service/prepare-omo-runtime";
import { AppError } from "./types";
import { privateDirectory } from "./store";

const requestSchema = z.object({
  directory: z.string(), prefix: z.string(), bun: z.string(),
  ownerDirectory: z.string(), socketDirectory: z.string(),
  parentPid: z.number().int().positive(),
}).strict();

if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path || realpathSync(path) !== path) throw new AppError("invalid_request");
    const input = requestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (input.parentPid !== process.ppid || input.parentPid <= 1) throw new AppError("conflict", "service_incarnation_changed");
    privateDirectory(input.directory);
    privateDirectory(input.ownerDirectory);
    privateDirectory(input.socketDirectory);
    const prepared = await prepareOmoInstallationRuntime({
      directory: input.directory, prefix: input.prefix, bun: input.bun,
      ownerDirectory: input.ownerDirectory, socketDirectory: input.socketDirectory,
      registeredSockets: [], rootPids: [input.parentPid],
    });
    process.send?.({ kind: "prepared", configuration: prepared.configurationPin,
      targetVersion: prepared.inputs.update.qualification.target.version,
      beforeVersion: prepared.inputs.update.qualification.installation.installedVersion });
  } catch (error) {
    process.send?.({ kind: "failed",
      code: error instanceof OmoPreparationError ? error.reason : error instanceof AppError ? error.code : "unavailable",
      detail: error instanceof OmoPreparationError ? error.detail.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1024) : "preparation_failed" });
    process.exitCode = 1;
  }
}
