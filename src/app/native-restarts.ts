import { attachAuthenticatedWorker } from "../service/client";
import type { InstallSelection, Job, SelectionMetadata, TargetSelection } from "../protocol";
import { AppError } from "./types";
import { isSupportedCli } from './catalog-types';

export type NativeSnapshot = {
  readonly selections: readonly SelectionMetadata[];
  readonly jobs: readonly Job[];
  readonly failure: string | null;
};
/** The app consumes the same authenticated worker boundary as plugin clients.
 * No process discovery row or managed OmO session is a native target. */
export function createNativeRestarts(directory: string) {
  let snapshot: NativeSnapshot = { selections: [], jobs: [], failure: null };
  return {
    snapshot: () => snapshot,
    async refresh(): Promise<NativeSnapshot> {
      try {
        const client = await attachAuthenticatedWorker(directory, 5000);
        try {
          const jobs = await client.request({ operation: "jobs" });
          if (!jobs.ok) throw new AppError("unavailable", jobs.error.code);
          snapshot = { ...snapshot, jobs: jobs.result.jobs.filter(job => job.mode === "restart-only") };
          const installations = await client.request({ operation: "installations" });
          if (!installations.ok) throw new AppError("unavailable", installations.error.code);
          const selections: SelectionMetadata[] = [];
          let failure: string | null = null;
          for (const installation of installations.result.installations.filter(row => isSupportedCli(row.family))) {
            const result = await client.request({ operation: "targets", installationId: installation.installationId });
            if (!result.ok) { failure = result.error.code; continue; }
            if (result.result.selection?.targets.length) selections.push(result.result.selection);
          }
          snapshot = { selections, jobs: snapshot.jobs, failure };
        } finally { client.close(); }
      } catch (error) {
        snapshot = { ...snapshot, selections: [], failure: error instanceof AppError ? error.detail : "native_unavailable" };
      }
      return snapshot;
    },
    async restart(installation: InstallSelection, target: TargetSelection, requestId: string): Promise<Job> {
      const selected=snapshot.selections.find(row=>row.installation.installationId===installation.installationId);
      if(!selected||!isSupportedCli(selected.installation.family))throw new AppError('unsupported','cli_not_supported');
      const client = await attachAuthenticatedWorker(directory, 30_000);
      try {
        const result = await client.request({ operation: "create-job", mode: "restart-only",
          installation, selectedTargets: [target] }, requestId);
        if (!result.ok) throw new AppError(result.error.code === "resources_busy" ? "busy"
          : ["stale_selection", "stale_binding"].includes(result.error.code) ? "source_changed" : "uncertain", result.error.code);
        return result.result.job;
      } finally { client.close(); }
    },
  };
}
