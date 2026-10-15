import { isDeepStrictEqual, types } from "node:util";
import type { Failure, FailureCode, Job, Receipt, Result, TargetTransaction } from "../protocol";

export type RecoveryObservation = { readonly jobId: string; readonly expectedRevision: number };
/** Not a ServiceRequest. The host must authenticate and freshly check revision/bindings. */
export type RecoveryIntent = (RecoveryObservation & { readonly operation: "inspect-job" })
  | { readonly operation: "back" };
export class RecoveryError extends Error {
  readonly code = "malformed_request";
  constructor() { super("malformed_request"); this.name = "RecoveryError"; }
}

/** Descriptor admission before cloning: structuredClone alone would execute getters. */
function snapshot<T>(input: T): T {
  const ancestors = new WeakSet<object>();
  function admit(value: unknown): void {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) throw new RecoveryError();
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new RecoveryError();
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new RecoveryError();
      const child: unknown = descriptor.value;
      admit(child);
    }
    ancestors.delete(value);
  }
  admit(input);
  return structuredClone(input);
}
function fit(text: string, width: number): string {
  const clean = Bun.stripANSI(text).replace(/[\p{Cc}\p{Cf}]/gu, "");
  if (Bun.stringWidth(clean) <= width) return clean;
  const suffix = ".".repeat(Math.min(3, width));
  const budget = width - suffix.length;
  const slice = Bun.sliceAnsi(clean, 0, budget);
  const head = Bun.stringWidth(slice) <= budget ? slice : Bun.sliceAnsi(clean, 0, Math.max(0, budget - 1));
  return head + suffix;
}
function effect(receipt: Receipt | null): "unknown" | "updated" | "stopped" | "started" {
  if (receipt === null) return "unknown";
  switch (receipt.kind) {
    case "absent": case "in-progress": case "uncertain": return "unknown";
    case "completed": return receipt.effect;
    default: return receipt satisfies never;
  }
}
function identity(target: TargetTransaction): "absent" | "verified" | "mismatch" {
  const receipt = target.receipt;
  if (receipt?.kind !== "completed" || receipt.identity === null) return "absent";
  const actual = receipt.identity;
  const expected = target.expectedBinding;
  switch (receipt.effect) {
    case "updated": return "mismatch";
    case "stopped": return isDeepStrictEqual(actual, expected) ? "verified" : "mismatch";
    case "started":
      return actual.socketId === expected.socketId && actual.socketEpoch === expected.socketEpoch
        && actual.paneId === expected.paneId && actual.paneGeneration > expected.paneGeneration
        && isDeepStrictEqual(actual.session, expected.session) && actual.cwd === expected.cwd
        && actual.optionsRef === expected.optionsRef
        && actual.rootIncarnation.executableRealpath === expected.rootIncarnation.executableRealpath
        && actual.rootIncarnation.startIdentity !== expected.rootIncarnation.startIdentity
        && actual.turnGeneration >= expected.turnGeneration ? "verified" : "mismatch";
    default: return receipt.effect satisfies never;
  }
}
const steps = {
  malformed_request: "Inspect the public observation format.",
  unsupported_version: "Check the host protocol version.",
  unauthorized: "Check host authentication without displaying credentials.",
  not_found: "Refresh the persisted job list.",
  stale_selection: "Refresh the selected job and target.",
  stale_binding: "Inspect the exact socket, epoch and process generation.",
  revision_conflict: "Refresh the persisted job revision before inspection.",
  request_conflict: "Inspect the existing request association.",
  unsupported: "Refresh observations, then inspect the available actions.",
  resources_busy: "Inspect resource owners; do not stop another consumer.",
  external_writer: "Inspect the installation fingerprint for an external change.",
  cancel_unsafe: "Inspect durable receipts before considering any action.",
  missing_session: "Check saved-session existence through an authenticated inspector.",
  identity_mismatch: "Compare exact session and process identity through the host.",
  update_failed: "Inspect the installer receipt and version evidence.",
  verification_failed: "Inspect independent installation and process verification.",
  receipt_uncertain: "Query the existing operation receipt; do not replay the operation.",
  recovery_required: "Inspect each persisted effect and its independent verification.",
} as const satisfies Record<FailureCode, string>;

/** Frozen public Job -> local viewport and inspection intents. No IO or action authority. */
export class RecoveryComponent {
  #job: Job;
  #selected: TargetTransaction | null;
  #offset = 0;
  #details = false;

  constructor(job: Job, private readonly label = "CLI update") {
    this.#job = snapshot(job);
    this.#selected = this.#job.targetTxns[0] ?? null;
  }
  get observation(): RecoveryObservation {
    return { jobId: this.#job.jobId, expectedRevision: this.#job.revision };
  }
  get view() {
    const job = this.#job;
    const install = job.installTxn;
    const installVerified = install.state === "succeeded" && install.failure === null
      && install.receipt?.kind === "completed" && install.receipt.effect === "updated" && install.receipt.identity === null;
    const transactions: readonly TargetTransaction[] = job.targetTxns;
    const targets = transactions.map(target => {
      const matching = job.selectedTargets.some(selected => selected.targetId === target.targetId
        && selected.runtimeId === target.runtimeId && selected.installationId === target.installationId
        && isDeepStrictEqual(selected.expectedBinding, target.expectedBinding));
      const session = identity(target);
      return { targetId: target.targetId, socketId: target.expectedBinding.socketId,
        socketEpoch: target.expectedBinding.socketEpoch, paneId: target.expectedBinding.paneId,
        paneGeneration: target.expectedBinding.paneGeneration, state: target.state,
        receipt: target.receipt?.kind ?? "missing", effect: effect(target.receipt), identity: session,
        observedGeneration: target.receipt?.kind === "completed" ? target.receipt.identity?.paneGeneration ?? null : null,
        verified: matching && installVerified && target.state === "completed" && target.failure === null
          && target.receipt?.kind === "completed" && target.receipt.effect === "started" && session === "verified",
        diagnostic: target.failure?.code ?? null };
    });
    const verified = job.status === "completed" && job.failure === null && installVerified
      && targets.length === job.selectedTargets.length && targets.every(target => target.verified)
      && new Set(targets.map(target => target.targetId)).size === targets.length;
    const diagnostic = job.failure?.code ?? install.failure?.code ?? targets.find(target => target.diagnostic)?.diagnostic ?? null;
    return { outcome: job.status === "completed" && !verified ? "unverified" : job.status, verified,
      diagnostic, selectedTargetId: this.#selected?.targetId ?? null, targets,
      installation: { installationId: install.selection.installationId, state: install.state,
        beforeVersion: snapshot(install.selection.installedVersion), observedVersion: null,
        receipt: install.receipt?.kind ?? "missing", effect: effect(install.receipt), verified: installVerified },
      reconcile: "not-connected" as const };
  }
  refresh(job: Job): Result<RecoveryObservation, Failure> {
    const next = snapshot(job);
    if (next.jobId !== this.#job.jobId) return { ok: false, error: { code: "stale_selection" } };
    if (next.revision < this.#job.revision || (next.revision === this.#job.revision && !isDeepStrictEqual(next, this.#job)))
      return { ok: false, error: { code: "revision_conflict" } };
    const selected = this.#selected;
    this.#selected = selected ? next.targetTxns.find(target => target.targetId === selected.targetId
      && target.runtimeId === selected.runtimeId && target.installationId === selected.installationId
      && isDeepStrictEqual(target.expectedBinding, selected.expectedBinding)) ?? null : null;
    this.#job = next;
    this.#offset = 0;
    return { ok: true, value: this.observation };
  }
  input(key: string, observed: RecoveryObservation = this.observation): Result<RecoveryIntent, Failure> | null {
    if (key === "Escape" || key === "\x1b" || key === "b") return { ok: true, value: { operation: "back" } };
    const current = snapshot(observed);
    if (current.jobId !== this.#job.jobId) return { ok: false, error: { code: "stale_selection" } };
    if (current.expectedRevision !== this.#job.revision) return { ok: false, error: { code: "revision_conflict" } };
    switch (key) {
      case "d": this.#details = !this.#details; this.#offset = 0; return null;
      case "Enter": case "\r":
      case "i": return { ok: true, value: { operation: "inspect-job", ...this.observation } };
      case "ArrowDown": case "\x1b[B": case "ArrowUp": case "\x1b[A": {
        const index = this.#job.targetTxns.findIndex(target => target === this.#selected);
        const down = key === "ArrowDown" || key === "\x1b[B";
        this.#selected = this.#job.targetTxns[Math.max(0, Math.min(this.#job.targetTxns.length - 1, index + (down ? 1 : -1)))] ?? null;
        this.#offset = Math.max(0, this.#job.targetTxns.findIndex(target => target === this.#selected)
          * (this.#details ? 6 : 2) + (this.#details ? 4 : 3));
        return null;
      }
      case "PageDown": case "\x1b[6~": this.#offset++; return null;
      case "PageUp": case "\x1b[5~": this.#offset = Math.max(0, this.#offset - 1); return null;
      default: return null;
    }
  }
  render(columns: number, height: number): string {
    const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
    const rows = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    const view = this.view;
    const before = view.installation.beforeVersion;
    const details = this.#details ? [
      `installation ${view.installation.installationId}: ${view.installation.state}`,
      `receipt ${view.installation.receipt} | effect ${view.installation.effect} | ${view.installation.verified ? "VERIFIED installation" : "UNVERIFIED installation"}`,
      `before version: ${before.kind === "known" ? before.version : `unknown (${before.reason})`}`,
      "observed version: unknown (not recorded in Job)",
    ] : [
      `Installation: ${view.installation.verified ? "verified" : "not yet verified"}`,
      `Before update: ${before.kind === "known" ? before.version : "unknown"}`,
      `Restarts verified: ${view.targets.filter(target => target.verified).length}/${view.targets.length}`,
    ];
    for (const target of view.targets) {
      if (!this.#details) {
        details.push(
          `${target.targetId === view.selectedTargetId ? ">" : " "} ${target.socketId}/${target.paneId}: ${target.verified ? "restart verified" : "restart not verified"}`,
          `  ${target.diagnostic ?? target.state}`,
        );
        continue;
      }
      details.push(
      `${target.targetId === view.selectedTargetId ? ">" : " "} target ${target.targetId}: ${target.state}`,
      `socket ${target.socketId} | epoch ${target.socketEpoch}`,
      `pane ${target.paneId} | expected generation ${target.paneGeneration} | observed ${target.observedGeneration ?? "unknown"}`,
      `receipt ${target.receipt} | effect: ${target.effect === "unknown" ? "unknown" : `known ${target.effect}`} | ${target.verified ? "VERIFIED start" : "UNVERIFIED start"}`,
      `receipt session identity: ${target.identity}`,
      `diagnostic: ${target.diagnostic ?? "none"}${target.diagnostic ? ` | ${steps[target.diagnostic]}` : ""}`,
      );
    }
    const budget = Math.max(0, rows - 4);
    const start = Math.min(this.#offset, Math.max(0, details.length - budget));
    const visible = details.slice(start, start + budget);
    while (visible.length < budget) visible.push("");
    const frame = [
      this.#details ? `${view.outcome} | ${view.diagnostic ?? "none"} | ${view.verified ? "VERIFIED completion" : "UNVERIFIED completion"}`
        : `${view.outcome.replaceAll("_", " ")} | ${view.verified ? "Completion verified" : "Completion not verified"}`,
      this.#details ? `RECOVERY ${this.#job.jobId} rev${this.#job.revision} | target ${view.selectedTargetId ?? "none"} | reconcile not-connected`
        : `${this.label} | Inspection only; no automatic retry`,
      `next: ${this.#details ? view.diagnostic ? steps[view.diagnostic] : "Inspect persisted receipts and independent verification."
        : "Enter to inspect the latest result. Do not repeat uncertain changes."}`,
      ...visible,
      `Enter/i inspect | d details | b/Esc back | Up/Down target | Pg scroll`,
    ];
    return frame.slice(0, rows).map(line => fit(line, width)).join("\n");
  }
}
