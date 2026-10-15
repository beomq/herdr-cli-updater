import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isCheckResult, readCatalog, validateCatalogSelection } from "../catalog";
import type { CatalogReaders } from "../catalog";
import { JobError } from "../jobs/jobs";
import { JobStore } from "../jobs/store";
import type { DisplaySession, FailureCode, ServiceRequest, ServiceResponse, TargetTransaction } from "../protocol";
import { FAMILIES } from "../adapters/types";
import type { RequestHandler } from "./socket";
import type { createUpdateOnlyJobRunner } from "./job-runner";
import { MAX_RESPONSE_BYTES, responseFits } from "./socket";

/** Durable sibling of the ephemeral socket owner. Stop never erases the queue. */
export function domainStoreDirectory(directory: string): string {
  return join(realpathSync(dirname(directory)), `${basename(directory)}.jobs`);
}

function failure(code: JobError["code"]): FailureCode {
  switch (code) {
    case "not_found": case "request_conflict": case "revision_conflict":
    case "cancel_unsafe": case "resources_busy": return code;
    case "invalid_input": return "malformed_request";
    case "invalid_transition": return "cancel_unsafe";
    case "receipt_mismatch": case "unsafe_path": case "storage_failure": case "corrupt_store":
      return "recovery_required";
    default: return unreachable(code);
  }
}
function unreachable(_value: never): never { throw new JobError("invalid_input"); }

/** Private construction only: socket owns authentication and strips no authority
 * from a public DTO. Readers must be explicitly registered by the local owner;
 * neither wire commands nor installation discovery supply them.
 */
export function createDomain(directory: string, readers?: CatalogReaders | ((signal?: AbortSignal, operation?: ServiceRequest["operation"]) => CatalogReaders | Promise<CatalogReaders>), publication?: {
  readonly admit: (response: ServiceResponse) => null;
  readonly publish: (response: ServiceResponse) => void;
}, configureRunner?: (store: JobStore) => ReturnType<typeof createUpdateOnlyJobRunner>) {
  const store = new JobStore(domainStoreDirectory(directory));
  const runner = configureRunner?.(store);
  function bounded<T extends ServiceResponse>(response: T): T {
    if (!responseFits(response)) throw new JobError("resources_busy");
    return response;
  }
  const handle: RequestHandler = async (request, signal) => {
    const envelope = { version: 1, requestId: request.requestId } as const;
    try {
      if (runner && (request.operation === "create-job" || request.operation === "reconcile-job"
        || request.operation === "inspect-job" || request.operation === "cancel-job"))
        return runner.handle(request, signal);
      switch (request.operation) {
        case "sessions": {
          const current = typeof readers === "function" ? await readers(signal, request.operation) : readers;
          if (!current) return { ...envelope, operation: "sessions", ok: false, error: { code: "unsupported" } };
          if (current.registrationFailure)
            return { ...envelope, operation: "sessions", ok: false, error: current.registrationFailure };
          // Display reads do not depend on installation discovery or RuntimeBinding.
          const snapshot = await readCatalog({ ...current, candidates: [],
            runtimeSources: [...(current.displaySources ?? []), ...(current.runtimeSources ?? [])] });
          const sessions = new Map<string, DisplaySession>();
          const unavailable = new Set(snapshot.failures.map(row => row.sourceId));
          const add = (row: DisplaySession) => {
            const socketId = row.socketId.startsWith("/")
              ? `socket:${createHash("sha256").update(row.socketId).digest("hex")}` : row.socketId;
            const key = JSON.stringify([socketId, row.paneId]);
            const previous = sessions.get(key);
            if (!previous || (previous.status === "unknown" && row.status !== "unknown"))
              sessions.set(key, { ...row, socketId });
          };
          for (const source of snapshot.runtimeAvailability) {
            if (source.kind === "unavailable") {
              if (source.reason === "source_unavailable") unavailable.add(source.sourceId);
              for (const row of source.observations) add({ socketId: source.sourceId, paneId: row.paneId,
                family: row.family === undefined ? FAMILIES.find(family => family === row.agent) ?? null : row.family,
                status: row.status ?? "unknown", workComplete: row.workComplete ?? null });
            }
          }
          for (const row of snapshot.observations) {
            const runtime = row.contract.runtime;
            if (runtime) add({ socketId: runtime.binding.socketId, paneId: runtime.binding.paneId,
              family: row.contract.family, status: "unknown", workComplete: null });
          }
          return bounded({ ...envelope, operation: "sessions", ok: true, result: {
            sessions: [...sessions.values()].sort((a, b) => a.socketId.localeCompare(b.socketId) || a.paneId.localeCompare(b.paneId)),
            unavailableSources: unavailable.size,
          } });
        }
        case "jobs": {
          const empty = { ...envelope, operation: request.operation, ok: true, result: { jobs: [] } } as const;
          const arrayBytes = MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(empty)) + 2;
          return bounded({ ...envelope, operation: request.operation, ok: true, result: { jobs: store.list(arrayBytes) } });
        }
        case "inspect-job": {
          const job = store.get(request.jobId);
          const transactions: readonly TargetTransaction[] = job.targetTxns;
          return bounded({ ...envelope, operation: request.operation, ok: true, result: {
            job, targets: transactions.map(target => {
              // No recovery/effect authority exists here. A recorded identity is
              // not proof that the process still exists or can be resumed.
              const receipt = target.receipt;
              return { target, effect: receipt?.kind === "completed" ? "known" : "unknown",
                lastIdentity: receipt?.kind === "completed" ? receipt.identity : null,
                safeAction: "inspect" } as const;
            }),
          } });
        }
        case "cancel-job": {
          let response: Extract<ServiceResponse, { readonly operation: "cancel-job"; readonly ok: true }> | undefined;
          store.change({ jobId: request.jobId, expectedRevision: request.expectedRevision }, { kind: "cancel" }, job => {
            if (job.status !== "cancelled") throw new JobError("invalid_transition");
            response = { ...envelope, operation: "cancel-job", ok: true,
              result: { kind: "cancelled", job: { ...job, status: "cancelled" } } };
            if (!responseFits(response, true)) throw new JobError("resources_busy");
            publication?.admit(response);
            return null;
          });
          if (!response) throw new JobError("invalid_transition");
          // No await between admission, commit and publication: another request
          // cannot advance the sequence or stop the owner in this synchronous path.
          publication?.publish(response);
          return response;
        }
        case "installations": case "runtimes": case "targets": {
          const current = typeof readers === "function" ? await readers(signal, request.operation) : readers;
          if (current?.registrationFailure)
            return { ...envelope, operation: request.operation, ok: false, error: current.registrationFailure };
          // A completed discovery with no candidates is an empty list, not a
          // missing reader or an unverified discovery failure.
          if (current?.emptyDiscovery === true && request.operation === "installations" && current.candidates.length === 0
            && current.sockets.length === 0 && (current.runtimeSources?.length ?? 0) === 0)
            return bounded({ ...envelope, operation: "installations", ok: true, result: { installations: [] } });
          if (!current || (current.candidates.length === 0 && current.sockets.length === 0
            && (current.runtimeSources?.length ?? 0) === 0))
            return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
          // Native runtime sources cannot prove installation discovery. Do not
          // make a readable installation wait on an incomplete/unreachable core.
          // Legacy verified socket contracts remain part of the frozen path.
          let snapshot = await readCatalog(request.operation === "installations" || (request.operation === "targets" && runner)
            ? { ...current, runtimeSources: [] } : current);
          const failed = snapshot.failures[0];
          if (failed) return { ...envelope, operation: request.operation, ok: false, error: failed.error };
          if (request.operation !== "installations" && snapshot.runtimeReadiness === "unavailable"
            && !(request.operation === "targets" && runner))
            return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
          switch (request.operation) {
            case "installations": return bounded({ ...envelope, operation: request.operation, ok: true,
              result: { installations: snapshot.installations } });
            case "runtimes": return bounded({ ...envelope, operation: request.operation, ok: true,
              result: { runtimes: snapshot.runtimes } });
            case "targets": {
              const installation = snapshot.installations.find(row => row.installationId === request.installationId);
              if (!installation)
                return { ...envelope, operation: request.operation, ok: false, error: { code: "not_found" } };
              const observed = await runner?.selection(installation, signal);
              if (observed && !observed.ok) return { ...envelope, operation: "targets", ok: false, error: observed.error };
              const selection = observed?.ok ? observed.value : undefined;
              if (selection) return bounded({ ...envelope, operation: "targets", ok: true,
                result: { targets: selection.targets.map(row => row.target), selection } });
              if (runner) {
                // A private restart source refreshes its binding before legacy
                // runtime observations. A prior generation must not veto the
                // fresh source, but unowned targets retain the catalog path.
                snapshot = await readCatalog(current);
                const failed = snapshot.failures[0];
                if (failed) return { ...envelope, operation: "targets", ok: false, error: failed.error };
              }
              // A runtime is observable even without restart support. Only
              // provider-verified completion, exit and resume make it selectable.
              const targets = snapshot.runtimes.filter(runtime => runtime.installationId === request.installationId
                && validateCatalogSelection(snapshot, installation, [runtime]).ok
                && snapshot.observations.some(row => row.contract.runtime !== null
                  && snapshot.aliases.some(alias => alias.installationId === row.contract.runtime?.installationId
                    && alias.canonicalId === runtime.installationId)
                  && isDeepStrictEqual({ ...row.contract.runtime, installationId: runtime.installationId }, runtime)
                  && row.contract.capabilities.completion.kind === "supported"
                  && row.contract.capabilities.gracefulExit.kind === "supported"
                  && row.contract.capabilities.resume.kind === "supported"))
                .map(runtime => ({ targetId: `target:${createHash("sha256").update(JSON.stringify([
                  runtime.binding.socketId, runtime.runtimeId,
                ])).digest("hex")}`,
                  runtimeId: runtime.runtimeId, installationId: runtime.installationId, expectedBinding: runtime.binding }));
              return bounded({ ...envelope, operation: request.operation, ok: true, result: { targets } });
            }
            default: return unreachable(request);
          }
        }
        case "check": {
          const current = typeof readers === "function" ? await readers(signal, request.operation) : readers;
          if (!current) return { ...envelope, operation: "check", ok: false, error: { code: "unsupported" } };
          if (current.registrationFailure) return { ...envelope, operation: "check", ok: false, error: { code: "verification_failed" } };
          if (!current.check) return { ...envelope, operation: "check", ok: false, error: { code: "unsupported" } };
          // The private hint only routes reads; admission still uses the freshly
          // observed contract, including unhinted legacy candidates.
          const snapshot = await readCatalog({ ...current,
            candidates: current.candidates.filter(candidate => candidate.installationId === undefined
              || candidate.installationId === request.installationId),
            sockets: [], runtimeSources: [] });
          const installation = snapshot.installations.find(row => row.installationId === request.installationId);
          if (!installation) return { ...envelope, operation: "check", ok: false,
            error: snapshot.failures.find(row => row.error.code === "recovery_required")?.error ?? { code: "not_found" } };
          const { lastCheck: _lastCheck, ...identity } = installation;
          const checked = await current.check(identity, signal);
          if (!checked.ok) return { ...envelope, operation: "check", ok: false, error: checked.error };
          if (!isCheckResult(checked.value) || (checked.value.kind !== "unavailable"
            && (installation.installedVersion.kind !== "known" || checked.value.installedVersion !== installation.installedVersion.version)))
            return { ...envelope, operation: "check", ok: false, error: { code: "verification_failed" } };
          return bounded({ ...envelope, operation: "check", ok: true,
            result: { installationId: installation.installationId, result: checked.value } });
        }
        case "create-job": case "reconcile-job":
          // Installed adapters and core mutation authority are not connected.
          return { ...envelope, operation: request.operation, ok: false, error: { code: "unsupported" } };
        default: return unreachable(request);
      }
    } catch (error) {
      if (!(error instanceof JobError)) throw error;
      return { ...envelope, operation: request.operation, ok: false, error: { code: failure(error.code) } };
    }
  };
  return { handle, close: () => {
    if (!runner) return store.close();
    return runner.close().finally(() => store.close());
  } };
}

