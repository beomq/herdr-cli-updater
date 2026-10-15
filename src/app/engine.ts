import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { attachAuthenticatedWorker, ClientError } from "../service/client";
import type { DomainRequest, WorkerAttachment, WorkerSubscription } from "../service/client";
import { startWorker } from "../service/worker";
import { idleWorker, registerPreparedRuntime, retireWorker } from "../../scripts/plugin";
import type { Installation, Job, SelectionMetadata } from "../protocol";
import { AppError } from "./types";
import { privateDirectory } from "./store";
import { installationPrefix } from "./observations";
import { releaseFailedPreparation } from "../service/preparation-retention";
import { isSupportedCli } from './catalog-types';

const pinSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const preparedSchema = z.object({ kind: z.literal("prepared"), configuration: pinSchema, targetVersion: z.string(),
  beforeVersion: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("known"), version: z.string() }).strict(),
    z.object({ kind: z.literal("unknown"), reason: z.string() }).strict(),
  ]) }).strict();
const failedSchema = z.object({ kind: z.literal("failed"), code: z.string(), detail: z.string() }).strict();
export type Preparation = z.infer<typeof preparedSchema>;
type Options = {
  readonly directory: string;
  readonly home: string;
  readonly path: string;
  readonly prefixes: readonly string[];
  readonly onChange: () => void;
};

export function createEngine(options: Options) {
  const directory = join(privateDirectory(join(options.directory, "run")), "worker");
  const runtime = join(options.directory, "runtime.json");
  const preparations = privateDirectory(join(options.directory, "preparations"));
  let client: WorkerAttachment | undefined;
  let subscription: WorkerSubscription | undefined;
  let replacing = false;
  async function connect(): Promise<void> {
    await startWorker(directory, { home: options.home, path: options.path, prefixes: options.prefixes,
      socket: existsSync(runtime) ? process.env["HERDR_SOCKET"] ?? "" : "" },
      { entrypoint: fileURLToPath(new URL("./worker.ts", import.meta.url)),
        runtimeConfiguration: existsSync(runtime) ? runtime : null });
    const attached=await attachAuthenticatedWorker(directory, 30_000);
    try{
      const next=await attached.subscribe({ incarnation: attached.incarnation, sequence: "current" }, {
        event: () => options.onChange(),
        error: () => { if (!replacing) options.onChange(); },
      });
      subscription?.close();client?.close();
      client=attached;subscription=next;
    }catch(error){
      attached.close();
      throw error;
    }
  }
  async function prepare(installation: Installation, signal?: AbortSignal): Promise<Preparation> {
    if(!isSupportedCli(installation.family))throw new AppError('unsupported','cli_not_supported');
    await supportedInstallation(installation.installationId);
    await idleWorker(directory);
    if (signal?.aborted) throw new AppError("conflict", "preparation_cancelled");
    const prefix = installationPrefix(installation);
    const bun = realpathSync(existsSync(join(prefix, "bin/bun")) ? join(prefix, "bin/bun") : process.execPath);
    const root = mkdtempSync(join(preparations, "omo-"));
    const request = `${root}.request.json`;
    writeFileSync(request, JSON.stringify({ directory: root, prefix, bun, ownerDirectory: directory,
      socketDirectory: join(options.directory, "run"), parentPid: process.pid }), { mode: 0o600, flag: "wx" });
    const child = fork(fileURLToPath(new URL("./prepare.ts", import.meta.url)), [request], {
      execPath: process.execPath, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const outcome = Promise.withResolvers<Preparation>();
    let received = false;
    child.on("message", message => {
      const success = preparedSchema.safeParse(message);
      if (success.success) { received = true; outcome.resolve(success.data); return; }
      const failure = failedSchema.safeParse(message);
      received = true;
      outcome.reject(new AppError("unavailable", failure.success ? `${failure.data.code}: ${failure.data.detail}` : "preparation_protocol"));
    });
    child.once("error", () => outcome.reject(new AppError("unavailable", "preparation_start_failed")));
    child.once("exit", () => { if (!received) outcome.reject(new AppError("uncertain", "preparation_exit")); });
    const exited = Promise.withResolvers<void>();
    child.once("close", () => exited.resolve());
    const terminate = (error: AppError) => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGTERM"); }
        catch (failure) {
          if (!(failure instanceof Error && "code" in failure && failure.code === "ESRCH"))
            throw failure;
        }
      }
      outcome.reject(error);
    };
    const aborted = () => terminate(new AppError("conflict", "preparation_cancelled"));
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    const deadline = setTimeout(() => terminate(new AppError("timeout", "preparation_timeout")), 900_000);
    try {
      const result = await outcome.promise;
      await exited.promise;
      if (signal?.aborted) throw new AppError("conflict", "preparation_cancelled");
      return result;
    } catch (error) {
      await exited.promise;
      releaseFailedPreparation(root);
      throw error;
    } finally {
      clearTimeout(deadline); signal?.removeEventListener("abort", aborted);
      if (child.connected) child.disconnect();
      unlinkSync(request);
    }
  }
  async function activate(prepared: Preparation): Promise<void> {
    await idleWorker(directory);
    const bytes = readFileSync(prepared.configuration.path);
    if (createHash("sha256").update(bytes).digest("hex") !== prepared.configuration.sha256)
      throw new AppError("source_changed");
    replacing = true;
    subscription?.close(); client?.close(); client = undefined;
    try {
      await retireWorker(directory);
      await registerPreparedRuntime(runtime, prepared.configuration);
      await connect();
    } finally { replacing = false; options.onChange(); }
  }
  async function request<B extends DomainRequest>(body: B, requestId?: string) {
    const attached = client;
    if (!attached) throw new AppError("unavailable", "worker_unavailable");
    try { return await attached.request(body, requestId); }
    catch (error) {
      if (error instanceof ClientError) throw new AppError(error.code === "timeout" ? "timeout" : "unavailable", error.code);
      throw error;
    }
  }
  async function installations(): Promise<readonly Installation[]> {
    const result = await request({ operation: "installations" } satisfies DomainRequest);
    if (!result.ok) throw new AppError("unavailable", result.error.code);
    return result.result.installations.filter(row => row.family === "omo");
  }
  async function targets(installationId: string): Promise<SelectionMetadata> {
    await supportedInstallation(installationId);
    const result = await request({ operation: "targets", installationId });
    if (!result.ok || !("selection" in result.result))
      throw new AppError("unsupported", result.ok ? "selection_unavailable" : result.error.code);
    return result.result.selection;
  }
  async function jobs(): Promise<readonly Job[]> {
    const result = await request({ operation: "jobs" });
    if (!result.ok) throw new AppError("unavailable", result.error.code);
    return result.result.jobs;
  }
  async function check(installationId: string) {
    await supportedInstallation(installationId);
    const result = await request({ operation: "check", installationId });
    if (!result.ok) throw new AppError("unavailable", result.error.code);
    return result.result.result;
  }
  async function update(installation: Installation, requestId: string): Promise<Job> {
    if(!isSupportedCli(installation.family))throw new AppError('unsupported','cli_not_supported');
    await supportedInstallation(installation.installationId);
    const result = await request({ operation: "create-job", mode: "update-only", selectedTargets: [],
      installation: { installationId: installation.installationId, resourcesFingerprint: installation.resourcesFingerprint,
        owner: installation.owner, installedVersion: installation.installedVersion } }, requestId);
    if (!result.ok) throw new AppError("uncertain", result.error.code);
    return result.result.job;
  }
  async function supportedInstallation(id:string):Promise<void> {
    const result=await request({operation:'installations'});
    if(!result.ok)throw new AppError('unavailable',result.error.code);
    const installation=result.result.installations.find(row=>row.installationId===id);
    if(!installation)throw new AppError('not_found');
    if(!isSupportedCli(installation.family))throw new AppError('unsupported','cli_not_supported');
  }
  return {
    directory, connect, prepare, activate, installations, targets, jobs, check, update,
    async close(): Promise<void> {
      await idleWorker(directory);
      replacing = true;
      subscription?.close(); client?.close();
      await retireWorker(directory);
    },
  };
}
