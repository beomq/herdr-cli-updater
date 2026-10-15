import type { Failure, InstallState, Job, Receipt, Result, TargetState } from "../protocol";

export type JobObservation = { readonly jobId: string; readonly expectedRevision: number };
/** Caller intent only. Host checks the revision again and adds authentication.
 * inspect-job's expectedRevision is local observation metadata, not a wire DTO field.
 */
export type JobAction = JobObservation & { readonly operation: "cancel-job" | "inspect-job" };

function fit(text: string, width: number): string {
  const clean = Bun.stripANSI(text).replace(/[\p{Cc}\p{Cf}]/gu, "");
  if (Bun.stringWidth(clean) <= width) return clean;
  const suffix = ".".repeat(Math.min(3, width));
  const budget = width - suffix.length;
  const slice = Bun.sliceAnsi(clean, 0, budget);
  // Bun includes a wide glyph crossing the end column; exclude that boundary glyph.
  const head = Bun.stringWidth(slice) <= budget ? slice : Bun.sliceAnsi(clean, 0, Math.max(0, budget - 1));
  return `${head}${suffix}`;
}
function effect(receipt: Receipt | null): string {
  if (receipt === null) return "unknown (no receipt)";
  switch (receipt.kind) {
    case "absent": case "in-progress": case "uncertain": return `unknown (${receipt.kind})`;
    case "completed": return `known ${receipt.effect} (verification separate)`;
    default: return receipt satisfies never;
  }
}
const installLabels = {
  not_required: "Installation unchanged (restart only)",
  queued: "Waiting to start", waiting_resources: "Waiting for installation resources",
  updating: "Updating the CLI", verifying: "Verifying the installed CLI",
  succeeded: "Installation verified", failed: "Installation failed",
  recovery_required: "Installation needs inspection",
} as const satisfies Record<InstallState, string>;
const targetLabels = {
  waiting_completion: "Working now; restart after work finishes", claimed: "Work finished; restart reserved",
  stopping: "Stopping safely", exited: "Stopped", launching: "Starting saved session",
  verifying: "Verifying restart", completed: "Restart verified",
  recovery_required: "Needs inspection", cancelled: "Cancelled",
} as const satisfies Record<TargetState, string>;

/** One persisted public Job observation. No IO, store writes, execution or optimistic outcome. */
export class JobComponent {
  private job: Job;
  private offset = 0;
  private details = false;

  constructor(job: Job, private readonly label = "CLI update") { this.job = structuredClone(job); }

  get observation(): JobObservation {
    return { jobId: this.job.jobId, expectedRevision: this.job.revision };
  }
  get canCancel(): boolean {
    const job = this.job;
    return job.status !== "cancelled" && job.status !== "completed"
      && job.installTxn.receipt === null
      && ["queued", "waiting_resources"].includes(job.installTxn.state)
      && job.targetTxns.every(target => target.receipt === null
        && ["waiting_completion", "claimed"].includes(target.state));
  }

  /** This component stays bound to one job. A different job needs a new component. */
  refresh(job: Job): Result<JobObservation, Failure> {
    if (job.jobId !== this.job.jobId) return { ok: false, error: { code: "stale_selection" } };
    if (job.revision < this.job.revision) return { ok: false, error: { code: "revision_conflict" } };
    // Same revision cannot legitimately carry different persisted data.
    if (job.revision === this.job.revision && JSON.stringify(job) !== JSON.stringify(this.job))
      return { ok: false, error: { code: "revision_conflict" } };
    this.job = structuredClone(job);
    return { ok: true, value: this.observation };
  }

  input(key: string, observed: JobObservation = this.observation): Result<JobAction, Failure> | null {
    if (observed.jobId !== this.job.jobId) return { ok: false, error: { code: "stale_selection" } };
    if (observed.expectedRevision !== this.job.revision)
      return { ok: false, error: { code: "revision_conflict" } };
    switch (key) {
      case "d": this.details = !this.details; this.offset = 0; return null;
      case "c":
        return this.canCancel
          ? { ok: true, value: { operation: "cancel-job", ...this.observation } }
          : { ok: false, error: { code: "cancel_unsafe" } };
      case "Enter": case "\r":
      case "i": return { ok: true, value: { operation: "inspect-job", ...this.observation } };
      case "ArrowDown": case "j":
      case "PageDown": case "\x1b[6~": this.offset += 1; return null;
      case "ArrowUp": case "k":
      case "PageUp": case "\x1b[5~": this.offset = Math.max(0, this.offset - 1); return null;
      default: return null;
    }
  }

  render(columns: number, height: number): string {
    const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
    const rows = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    const job = this.job;
    const install = job.installTxn;
    const verifiedTargets = job.targetTxns.filter(target => target.state === "completed" && target.failure === null
      && target.receipt?.kind === "completed" && target.receipt.effect === "started").length;
    const complete = job.status === "completed" && job.failure === null
      && (job.mode === "restart-only" || (install.state === "succeeded" && install.failure === null
        && install.receipt?.kind === "completed" && install.receipt.effect === "updated"))
      && verifiedTargets === job.selectedTargets.length && job.targetTxns.length === job.selectedTargets.length;
    let result: string;
    switch (job.status) {
      case "completed": result = complete ? "completed" : "unknown (verification missing)"; break;
      case "cancelled": result = "cancelled"; break;
      case "failed": result = "failed"; break;
      case "partial": result = "partial"; break;
      case "recovery_required": result = "recovery_required"; break;
      case "queued": case "waiting": case "running": result = "pending"; break;
      default: return job satisfies never;
    }
    const details: string[] = [installLabels[install.state]];
    details.push(`Restart sessions: ${job.selectedTargets.length} | Verified: ${verifiedTargets}`);
    if (!complete && job.mode === "update-and-restart"
      && job.targetTxns.some(target => target.state === "waiting_completion"))
      details.push("Current work will not be interrupted. Update and same-conversation restart follow completion.");
    if (job.mode === "update-and-restart") {
      const stopped = job.targetTxns.filter(target => ["exited", "launching", "verifying", "completed"].includes(target.state)).length;
      const finished = job.targetTxns.filter(target => ["claimed", "stopping", "exited", "launching", "verifying", "completed"].includes(target.state)).length;
      details.push(`Work finished: ${finished}/${job.selectedTargets.length}`);
      details.push(`Safe stop: ${stopped}/${job.selectedTargets.length} | Update: ${installLabels[install.state]}`);
      details.push(`Same conversation restart: ${verifiedTargets}/${job.selectedTargets.length} verified`);
    }
    if (complete) details.push(job.mode === "update-only" ? "No pane restart was requested."
      : `${verifiedTargets} selected panes restarted and verified.`);
    if (this.details) details.push(
      `JOB ${job.jobId} | revision ${job.revision} | ${job.mode}`,
      `installation: ${install.selection.installationId}`,
      `phase: ${install.state} | effect: ${effect(install.receipt)}`,
    );
    switch (install.selection.installedVersion.kind) {
      case "known": details.push(`${job.mode === "restart-only" ? "Installed version" : "Before update"}: ${install.selection.installedVersion.version}`); break;
      case "unknown": details.push(`${job.mode === "restart-only" ? "Installed version" : "Before update"}: unknown${this.details ? ` (${install.selection.installedVersion.reason})` : ""}`); break;
      default: return install.selection.installedVersion satisfies never;
    }
    if (complete && job.mode !== "restart-only") details.push("Updated version: not recorded here. Refresh the catalog to check.");
    if (install.state === "waiting_resources") details.push("waiting: installation resources");
    if (job.targetTxns.some(target => target.state === "waiting_completion"))
      details.push("waiting: selected target work completion");
    if (job.failure) details.push(`job error: ${job.failure.code}`);
    if (install.failure) details.push(`installation error: ${install.failure.code}`);
    details.push(`targets: ${verifiedTargets}/${job.selectedTargets.length} verified`);
    for (const target of job.targetTxns) {
      details.push(this.details ? `target ${target.targetId}: ${target.state}`
        : `  Pane ${target.expectedBinding.paneId}: ${targetLabels[target.state]}`);
      if (this.details) details.push(`  effect: ${effect(target.receipt)}`);
      if (target.failure) details.push(`  error: ${target.failure.code}`);
    }
    const budget = Math.max(0, rows - 4);
    const start = Math.min(this.offset, Math.max(0, details.length - budget));
    const visible = details.slice(start, start + budget);
    const hidden = details.length - visible.length;
    while (visible.length < budget) visible.push("");
    return [
      `${job.mode === "restart-only" ? "CLI restart" : this.label} | ${job.mode === "restart-only" ? "Restart only" : job.mode === "update-only" ? "Update only" : "Update and restart"}`,
      `persisted: ${job.status} | result: ${result}`,
      ...visible,
      `Cancel: ${this.canCancel ? "available before changes begin" : "unavailable; inspect progress instead"}${hidden > 0 ? ` | ${hidden} hidden` : ""}`,
      "Enter/i inspect | c cancel | d details | Up/Down/Pg scroll",
    ].slice(0, rows).map(line => fit(line, width)).join("\n");
  }
}
