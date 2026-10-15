import { isDeepStrictEqual } from "node:util";
import { isCapability } from "../adapters/types";
import type { AdapterCapabilities, Capability } from "../adapters/types";
import { isInstallSelection, isTargetSelection } from "../protocol";
import type { Failure, Installation, InstallSelection, Mode, Result, ServiceRequest, TargetSelection, VersionEvidence } from "../protocol";

/** Host-observed eligibility, not a core claim or resource lock. No catalog UI or
 * private queue API is consumed here. Host must freshly validate before dispatch.
 */
export type SelectionSnapshot = {
  readonly installation: Installation;
  readonly update: AdapterCapabilities["update"];
  readonly readiness: Capability;
  readonly targets: readonly ({
    readonly target: TargetSelection;
    readonly runningVersion: VersionEvidence;
    readonly readiness: Capability;
  } & Pick<AdapterCapabilities, "completion" | "resume" | "gracefulExit">)[];
};
type Body<T> = T extends ServiceRequest ? Omit<T, "version" | "requestId" | "token"> : never;
export type SelectionIntent = Body<Extract<ServiceRequest, { readonly operation: "create-job" }>>;
export type SelectionObservation = { readonly revision: number };
export type SelectionStage = "choosing" | "reviewing" | "confirming" | "emitted" | "cancelled";
export class SelectionError extends Error {
  readonly code = "malformed_request";
  constructor() { super("malformed_request"); }
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function installBody(installation: Installation): InstallSelection {
  return { installationId: installation.installationId, resourcesFingerprint: installation.resourcesFingerprint,
    owner: installation.owner, installedVersion: installation.installedVersion };
}
function capture(input: SelectionSnapshot): SelectionSnapshot {
  // Capture once BEFORE validation. Accessors cannot swap the validated object.
  // Clone errors fail closed; no raw private exception is rendered by this component.
  const value = structuredClone(input);
  if (!isInstallSelection(installBody(value.installation)) || !isCapability(value.update)
    || !isCapability(value.readiness) || !Array.isArray(value.targets)
    || value.targets.some(row => !isTargetSelection(row.target)
      || ![row.readiness, row.completion, row.resume, row.gracefulExit].every(isCapability)))
    throw new SelectionError();
  return freeze(value);
}
function supported(capability: Capability): boolean { return capability.kind === "supported"; }
function capabilityLabel(capability: Capability): string { return `${capability.kind}/${capability.reason}`; }
function version(value: VersionEvidence): string {
  switch (value.kind) {
    case "known": return value.version;
    case "unknown": return `unknown/${value.reason}`;
  }
}
function safe(text: string): string {
  return text
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|\u0090)[\s\S]*?(?:\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "");
}
function fit(text: string, columns: number): string {
  const clean = safe(text);
  if (Bun.stringWidth(clean) <= columns) return clean;
  const suffix = columns >= 3 ? "..." : "";
  const budget = columns - suffix.length;
  // sliceAnsi may include a wide grapheme crossing its ending column.
  // Accumulate complete graphemes and measure the actual resulting cell width.
  let clipped = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean)) {
    if (Bun.stringWidth(clipped + segment) > budget) break;
    clipped += segment;
  }
  return clipped + suffix;
}
function identity(target: TargetSelection): string {
  const b = target.expectedBinding;
  return `${b.socketId}/${b.paneId} gen:${b.paneGeneration} epoch:${b.socketEpoch} turn:${b.turnGeneration}`;
}

/** Pure local keyboard state. No I/O, store, worker, process or auth ownership.
 * Emitted bodies contain exact private binding references required by protocol,
 * never display projections; do not log them as public terminal text.
 */
export class SelectComponent {
  #snapshot: SelectionSnapshot;
  #mode: Mode = "update-only";
  #stage: SelectionStage = "choosing";
  #selected: readonly TargetSelection[] = Object.freeze([]);
  #revision = 0;
  #cursor = 0;
  #scroll = 0;
  #bodyHeight = 12;
  #details = false;
  #directConfirmation = false;

  constructor(snapshot: SelectionSnapshot) { this.#snapshot = capture(snapshot); }
  get mode(): Mode { return this.#mode; }
  get stage(): SelectionStage { return this.#stage; }
  get observation(): SelectionObservation { return Object.freeze({ revision: this.#revision }); }
  get selectedTargets(): readonly TargetSelection[] { return this.#selected; }
  get effects(): { readonly installation: InstallSelection; readonly restartTargets: readonly TargetSelection[] } {
    return freeze({ installation: installBody(this.#snapshot.installation), restartTargets: this.#selected });
  }
  #targetFailure(target: TargetSelection): Failure | null {
    const rows = this.#snapshot.targets;
    const b = target.expectedBinding;
    const exact = rows.filter(row => isDeepStrictEqual(row.target, target));
    if (exact.length !== 1 || rows.filter(row =>
      row.target.expectedBinding.socketId === b.socketId && row.target.expectedBinding.paneId === b.paneId).length !== 1
      || rows.filter(row => row.target.targetId === target.targetId).length !== 1
      || rows.filter(row => row.target.expectedBinding.socketId === b.socketId
        && row.target.runtimeId === target.runtimeId).length !== 1
      || rows.some(row => row.target.expectedBinding.socketId === b.socketId
        && row.target.expectedBinding.socketEpoch !== b.socketEpoch))
      return { code: "stale_binding" };
    const row = exact[0];
    if (!row) return { code: "stale_binding" };
    if (target.installationId !== this.#snapshot.installation.installationId
      || b.resourcesFingerprint !== this.#snapshot.installation.resourcesFingerprint)
      return { code: "stale_selection" };
    if (![row.readiness, row.completion, row.resume, row.gracefulExit].every(supported))
      return { code: "unsupported" };
    return null;
  }
  #reviewFailure(): Failure | null {
    const { installation, update, readiness } = this.#snapshot;
    if (!supported(update) || !supported(readiness) || installation.owner.kind === "unknown")
      return { code: "unsupported" };
    const check = installation.lastCheck;
    if (!check || check.result.kind !== "update-available"
      || !Number.isSafeInteger(check.checkedAt) || check.checkedAt < 0
      || check.checkedAt !== check.result.checkedAt || installation.installedVersion.kind !== "known"
      || check.result.installedVersion !== installation.installedVersion.version)
      return { code: "stale_selection" };
    if (this.#mode === "update-and-restart") {
      if (this.#selected.length === 0) return { code: "unsupported" };
      for (const target of this.#selected) {
        const failure = this.#targetFailure(target);
        if (failure) return failure;
      }
    }
    return null;
  }
  get canReview(): boolean { return this.#reviewFailure() === null; }

  refresh(snapshot: SelectionSnapshot): void {
    const captured = capture(snapshot);
    if (isDeepStrictEqual(captured, this.#snapshot)) return;
    const installChanged = !isDeepStrictEqual(captured.installation, this.#snapshot.installation);
    const focused = this.#snapshot.targets[this.#cursor]?.target;
    this.#snapshot = captured;
    this.#selected = installChanged ? Object.freeze([]) : freeze(this.#selected.filter(target => this.#targetFailure(target) === null));
    // Focus may move for navigation; deliberate target selection never transfers.
    const index = captured.targets.findIndex(row => isDeepStrictEqual(row.target, focused));
    this.#cursor = Math.max(0, index);
    this.#stage = "choosing";
    this.#directConfirmation = false;
    this.#scroll = 0;
    this.#revision++;
  }

  input(key: string, observed: SelectionObservation = this.observation): Result<SelectionIntent, Failure> | null {
    if (observed.revision !== this.#revision) return { ok: false, error: { code: "stale_selection" } };
    if (this.#stage === "emitted" || this.#stage === "cancelled") return null;
    switch (key) {
      case "d":
        this.#details = !this.#details;
        this.#scroll = 0;
        this.#revision++;
        return null;
      case "Escape":
      case "\x1b":
        this.#stage = this.#stage === "confirming" ? this.#directConfirmation ? "choosing" : "reviewing"
          : this.#stage === "reviewing" ? "choosing" : "cancelled";
        this.#directConfirmation = false;
        this.#scroll = 0;
        this.#revision++;
        return null;
      case "m":
      case "ArrowLeft":
      case "ArrowRight":
        this.#mode = key === "ArrowLeft" ? "update-only" : key === "ArrowRight" ? "update-and-restart"
          : this.#mode === "update-only" ? "update-and-restart" : "update-only";
        this.#stage = "choosing";
        this.#directConfirmation = false;
        this.#selected = Object.freeze([]);
        this.#scroll = 0;
        this.#revision++;
        return null;
      case "ArrowDown":
      case "j":
      case "ArrowUp":
      case "k":
      case "PageDown":
      case "PageUp": {
        if (this.#stage === "confirming") this.#stage = "reviewing";
        this.#directConfirmation = false;
        const direction = ["ArrowDown", "j", "PageDown"].includes(key) ? 1 : -1;
        const step = key.startsWith("Page") ? this.#bodyHeight : 1;
        if (this.#stage === "choosing") {
          this.#cursor = Math.max(0, Math.min(this.#snapshot.targets.length - 1, this.#cursor + direction * step));
        } else this.#scroll = Math.max(0, this.#scroll + direction * step);
        this.#revision++;
        return null;
      }
      case " ":
        if (this.#stage !== "choosing" || this.#mode !== "update-and-restart") return null;
        {
          const target = this.#snapshot.targets[this.#cursor]?.target;
          if (!target) return null;
          const failure = this.#targetFailure(target);
          if (failure) return { ok: false, error: failure };
          this.#selected = freeze(this.#selected.some(row => isDeepStrictEqual(row, target))
            ? this.#selected.filter(row => !isDeepStrictEqual(row, target)) : [...this.#selected, target]);
          this.#revision++;
          return null;
        }
      case "r": {
        if (this.#stage !== "choosing") return null;
        const failure = this.#reviewFailure();
        if (failure) return { ok: false, error: failure };
        this.#stage = "reviewing";
        this.#scroll = 0;
        this.#revision++;
        return null;
      }
      case "\r":
      case "Enter": {
        const failure = this.#reviewFailure();
        if (failure) return { ok: false, error: failure };
        if (this.#stage === "choosing") {
          this.#stage = "confirming";
          this.#directConfirmation = true;
          this.#scroll = 0;
          this.#revision++;
          return null;
        }
        if (this.#stage === "reviewing") {
          this.#stage = "confirming";
          this.#directConfirmation = false;
          this.#revision++;
          return null;
        }
        const installation = installBody(this.#snapshot.installation);
        let body: SelectionIntent;
        if (this.#mode === "update-only") body = { operation: "create-job", mode: "update-only", installation, selectedTargets: [] };
        else {
          const [first, ...rest] = this.#selected;
          if (!first) return { ok: false, error: { code: "unsupported" } };
          body = { operation: "create-job", mode: "update-and-restart", installation, selectedTargets: [first, ...rest] };
        }
        this.#stage = "emitted";
        this.#revision++;
        return { ok: true, value: freeze(body) };
      }
      default: return null;
    }
  }

  render(columns: number, rows: number): string {
    const width = Math.max(1, Math.floor(columns)), height = Math.max(1, Math.floor(rows));
    const i = this.#snapshot.installation, check = i.lastCheck;
    const header = [
      `${i.family} [${i.channel}] | ${this.#stage === "choosing" ? "Choose update" : "Confirm effects"} (${this.#stage})`,
      `Version: ${version(i.installedVersion)} -> ${check?.result.kind === "update-available" ? check.result.availableVersion : "unknown"}`,
      this.#mode === "update-only" ? "Mode: update only | Existing panes are not restarted"
        : `Mode: update and restart | ${this.#selected.length} panes selected`,
    ];
    const footer = [
      this.#reviewFailure() ? `Unavailable: ${this.#reviewFailure()?.code}. Esc to return, then u to refresh.`
        : this.#mode === "update-and-restart" ? "Finish current work -> update CLI -> restart the same conversation."
          : "Existing sessions are not restarted. The update waits for resources to be free.",
      this.#stage === "choosing" ? this.#mode === "update-only"
        ? "Enter confirm | Left/Right/m mode | d details | Esc cancel"
        : "Up/Down focus | Space select | Enter confirm | m mode | d | Esc cancel"
        : this.#stage === "reviewing" ? "Enter final confirmation | Up/Down/Pg scroll | d details | Esc back"
          : this.#stage === "confirming" ? "Enter start update | Up/Down/Pg review | d details | Esc back"
            : "Selection closed. Job progress comes from the host.",
    ];
    if (i.family === "agy") footer.unshift("Official latest is resolved at update time; the installed result is verified.");
    const body: string[] = [];
    let focusedLine = 0;
    if (this.#stage === "choosing") {
      body.push(`Open sessions: ${this.#snapshot.targets.length} | Restart selected: ${this.#selected.length}`);
      body.push(this.#mode === "update-and-restart" ? "Select sessions to restart after their current work finishes."
        : "Update only: no sessions will be restarted.");
      this.#snapshot.targets.forEach((row, index) => {
        if (index === this.#cursor) focusedLine = body.length;
        const selected = this.#selected.some(target => isDeepStrictEqual(target, row.target));
        body.push(`${index === this.#cursor ? ">" : " "} [${selected ? "x" : " "}] Session ${row.target.expectedBinding.paneId}`);
        const failure = this.#targetFailure(row.target);
        body.push(`  Running version: ${version(row.runningVersion)} | ${failure?.code ?? "same conversation restart available"}`);
        if (selected) body.push("  After confirmation: restart when work finishes; no interruption.");
        if (this.#details) body.push(`  Binding: ${identity(row.target)}`);
        for (const name of ["completion", "resume", "gracefulExit", "readiness"] as const) {
          if (this.#details && !supported(row[name])) body.push(`  ${name}: ${capabilityLabel(row[name])}`);
        }
      });
    } else {
      body.push(`Open sessions: ${this.#snapshot.targets.length} | Restart selected: ${this.#selected.length}`);
      body.push(`Update ${i.family} once. Current work is allowed to finish first.`);
      this.#selected.forEach(target => {
        body.push(`  Restart pane ${target.expectedBinding.paneId} in the same saved session.`);
        body.push("  Wait for work to finish -> stop safely -> update -> resume.");
        if (this.#details) body.push(`  Binding: ${identity(target)}`);
      });
      body.push("Unselected panes will not be stopped or restarted.");
      if (this.#selected.length === 0) body.push("The update may wait for existing processes to exit.");
    }
    if (body.length === 0) body.push(this.#mode === "update-only"
      ? "Update the CLI without restarting existing panes."
      : "No restart targets observed. Choose update only or refresh the catalog.");
    if (this.#details) body.push(
      `Installation: ${i.installationId} | observation:${this.#revision}`,
      `Checked: ${check?.checkedAt ?? "unknown"} | ${check?.result.kind ?? "unknown"}`,
      `Update: ${capabilityLabel(this.#snapshot.update)}`,
      `Readiness: ${capabilityLabel(this.#snapshot.readiness)}`,
    );
    this.#bodyHeight = Math.max(1, height - header.length - footer.length);
    const maxScroll = Math.max(0, body.length - this.#bodyHeight);
    if (this.#stage === "choosing") {
      const line = focusedLine;
      if (line < this.#scroll) this.#scroll = line;
      if (line + 1 >= this.#scroll + this.#bodyHeight) this.#scroll = line + 2 - this.#bodyHeight;
    }
    this.#scroll = Math.max(0, Math.min(maxScroll, this.#scroll));
    const visible = body.slice(this.#scroll, this.#scroll + this.#bodyHeight);
    while (visible.length < this.#bodyHeight) visible.push("");
    return [...header, ...visible, ...footer].slice(0, height).map(line => fit(line, width)).join("\n");
  }
}
