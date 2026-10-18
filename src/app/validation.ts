import { z } from "zod";
import { AppError } from "./types";
import type { AppOperation, CommandEnvelope, UpdatePolicy } from "./types";
import { catalogIds } from "./catalog-types";
import type { InstallJob } from "./catalog-types";
import { isInstallSelection, isTargetSelection } from "../protocol";
import type { InstallSelection, TargetSelection } from "../protocol";
import { officialMethodSchema, officialPlanSchema } from './catalog-official';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestamp = z.number().int().nonnegative().safe();
const generation = z.number().int().nonnegative().safe();
const path = z.string().min(1).max(4096).startsWith("/").regex(/^[^\x00-\x1f\x7f]*$/);
const policyMode = z.enum(["off", "check", "update", "update-and-restart"]);
export const paneSessionPolicy = z.enum(["keep", "restart-idle", "restart-all"]);
const interval = z.number().int().min(5).max(10080);
const firstCheck = z.enum(["now", "after-interval"]);
const envelope = z.object({
  requestId: id,
  command: z.discriminatedUnion("kind", [
    z.object({kind:z.literal('automation-settings'),paneSessions:paneSessionPolicy}).strict(),
    z.object({ kind: z.literal("refresh") }).strict(),
    z.object({ kind: z.literal("native-restart"), installation: z.custom<InstallSelection>(isInstallSelection),
      target: z.custom<TargetSelection>(isTargetSelection) }).strict(),
    z.object({kind:z.literal('automation'),installationId:id,enabled:z.boolean()}).strict(),
    z.object({kind:z.literal('catalog-select'),catalogId:z.enum(catalogIds),installationId:id,
      reviewed:z.object({path,identityPath:path,version:z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]*$/),makeDefault:z.boolean()}).strict().optional()}).strict(),
    z.object({kind:z.literal('default-plan'),catalogId:z.enum(catalogIds),installationId:id}).strict(),
    z.object({kind:z.literal('default-confirm'),jobId:id,revision:generation}).strict(),
    z.object({ kind:z.literal("catalog-update-plan"),catalogId:z.enum(catalogIds) }).strict(),
    z.object({ kind:z.literal("catalog-check"),catalogId:z.enum(catalogIds) }).strict(),
    z.object({kind:z.literal('catalog-check-all')}).strict(),
    z.object({kind:z.literal('catalog-update-all-plan')}).strict(),
    z.object({kind:z.literal('catalog-update-all-confirm'),batchId:id,revision:generation}).strict(),
    z.object({ kind:z.literal("catalog-update-confirm"),jobId:id,revision:generation,paneSessions:paneSessionPolicy.optional() }).strict(),
    z.object({kind:z.literal('catalog-update-recover'),jobId:id,revision:generation,action:z.enum(['reconcile','archive-unverified'])}).strict(),
    z.object({ kind: z.literal("install-plan"), catalogId: z.enum(catalogIds),method:officialMethodSchema.optional(),makeDefault:z.boolean().optional() }).strict(),
    z.object({ kind: z.literal("install-confirm"), jobId: id, revision: generation }).strict(),
    z.object({ kind:z.literal("install-recover"),jobId:id,revision:generation,action:z.enum(['inspect','archive']) }).strict(),
    z.object({ kind: z.literal("remove-plan"), catalogId: z.enum(catalogIds),installationId:id.optional() }).strict(),
    z.object({ kind: z.literal("remove-confirm"), jobId: id, revision: generation }).strict(),
    z.object({ kind: z.literal("check"), installationId: id }).strict(),
    z.object({ kind: z.literal("prepare"), installationId: id }).strict(),
    z.object({ kind: z.literal("confirm"), operationId: id, revision: generation,
      sessions: z.array(z.object({ id, generation }).strict()).max(64)
        .refine(value => new Set(value.map(row => row.id)).size === value.length),
      restart: z.boolean(), paneSessions: paneSessionPolicy.optional() }).strict(),
    z.object({ kind: z.literal("cancel"), operationId: id, revision: generation }).strict(),
    z.object({ kind: z.literal("launch"), installationId: id, cwd: path }).strict(),
    z.object({ kind: z.enum(["stop", "restart"]), sessionId: id, generation }).strict(),
    z.object({ kind: z.literal("pane-restart"), sessionId: z.string().min(1).max(256), paneId: z.string().regex(/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/), trustScreen: z.boolean().optional() }).strict(),
    z.object({ kind: z.literal("pane-restart-batch"), trustScreen: z.boolean().optional(),
      items: z.array(z.object({ sessionId: z.string().min(1).max(256), paneId: z.string().regex(/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/) }).strict()).min(1).max(64) }).strict(),
    z.object({ kind: z.literal("send"), sessionId: id, generation, message: z.string().min(1).max(16000) }).strict(),
    z.object({ kind: z.literal("respond"), sessionId: id, generation, approvalId: id,
      value: z.union([z.string().max(16000), z.boolean()]) }).strict(),
    z.object({ kind: z.literal("policy"), installationId: id, mode: policyMode, intervalMinutes: interval,
      firstCheck: firstCheck.default("now"), paneSessions: paneSessionPolicy.optional() }).strict(),
  ]),
}).strict() satisfies z.ZodType<CommandEnvelope>;

export function parseCommand(value: unknown): CommandEnvelope {
  const result = envelope.safeParse(value);
  if (!result.success) throw new AppError("invalid_request");
  return result.data;
}
export const operationSchema = z.object({
  id, requestId: id, installationId: id,
  kind: z.enum(["prepare", "update", "stop", "restart", "native-restart"]),
  stage: z.enum(["preparing", "ready", "waiting", "stopping", "updating", "verifying", "restarting",
    "completed", "failed", "uncertain", "cancelled"]),
  revision: generation, targetVersion: z.string().nullable(), beforeVersion: z.string().nullable(),
  installedVersion: z.string().nullable(), sessionIds: z.array(id), restart: z.boolean(),
  externalSessionIds: z.array(z.string()).default([]),
  paneSessions: paneSessionPolicy.default("keep"),
  paneResults: z.array(z.object({ sessionId: z.string(), paneId: z.string(),
    outcome: z.enum(["pending", "completed", "failed", "skipped-working", "skipped-blocked"]),
    failure: z.string().nullable(), previousPid: z.number().int(), resumedPid: z.number().int().nullable() }).strict()).default([]),
  installedAt: timestamp.nullable().default(null),
  createdAt: timestamp, updatedAt: timestamp, failure: z.string().nullable(), detail: z.string().nullable(),
  jobId: id.nullable(),
}).strict() satisfies z.ZodType<AppOperation>;
export const policySchema = z.object({
  catalogBinding:z.string().max(16384).optional(),
  installationId: id, mode: policyMode, intervalMinutes: interval,
  firstCheck: firstCheck.default("now"), paneSessions: paneSessionPolicy.default("restart-idle"),
  lastCheckedAt: timestamp.nullable(), nextCheckAt: timestamp.nullable(), waitingReason: z.string().nullable(),
  lastInstalledVersion: z.string().max(128).nullable().optional(), lastRebaselineAt: timestamp.nullable().optional(),
}).strict() satisfies z.ZodType<UpdatePolicy>;

export const installJobSchema = z.object({
  official:officialPlanSchema.optional(),makeDefault:z.boolean().optional(),previousInstallationId:id.nullable().optional(),
  id, requestId: id, catalogId: z.enum(catalogIds), revision: generation,
  stage: z.enum(['ready','installing','verifying','completed','failed','uncertain']),
  sourceUrl: z.string().url(), method: z.string(), target: path, recipeHash: z.string(),
  createdAt: timestamp, updatedAt: timestamp, installedVersion: z.string().nullable(),
  executablePath: path.nullable(), failure: z.string().nullable(), log: z.array(z.string()).max(100),
  archivePath:path.nullable().default(null),
}).strict() satisfies z.ZodType<InstallJob>;
