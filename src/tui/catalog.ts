import type { CatalogSnapshot } from "../catalog";
import type { AdapterCapabilities } from "../adapters/types";
import type { Installation, Job, Runtime, ServiceRequest, VersionEvidence } from "../protocol";
import { catalogColumns, fit, tableRow } from "./presentation";

/** Host adds authentication at dispatch. This component cannot request effects. */
export type CatalogCheckAction = Pick<Extract<ServiceRequest, { readonly operation: "check" }>,
  "operation" | "installationId">;
export type CatalogRow = {
  readonly installation: Installation;
  readonly aliases: readonly string[];
  readonly runtimes: readonly Runtime[];
};
const capabilityNames = ["check", "update", "busySafe", "completion", "resume", "gracefulExit"] as const satisfies readonly (keyof AdapterCapabilities)[];

function version(value: VersionEvidence): string {
  switch (value.kind) {
    case "known": return value.version;
    case "unknown": return `unknown (${value.reason})`;
  }
}

/** Stateful keyboard/viewport component only. No IO, worker, probes or readiness inference.
 * refresh accepts the public catalog17 snapshot and protocol Job DTOs.
 */
export class CatalogComponent {
  private snapshot: CatalogSnapshot;
  private jobs: readonly Job[];
  private selected: string | null;
  private expanded = new Set<string>();
  private offset = 0;

  constructor(snapshot: CatalogSnapshot, jobs: readonly Job[] = []) {
    this.snapshot = snapshot;
    this.jobs = jobs;
    this.offset = 0;
    this.selected = this.rows[0]?.installation.installationId ?? null;
  }

  get selectedInstallationId(): string | null { return this.selected; }

  get rows(): readonly CatalogRow[] {
    const canonical = (id: string) => this.snapshot.aliases.find(alias => alias.installationId === id)?.canonicalId ?? id;
    return this.snapshot.installations.map(installation => ({
      installation,
      aliases: this.snapshot.aliases.filter(alias => alias.canonicalId === installation.installationId)
        .map(alias => alias.installationId).filter(id => id !== installation.installationId),
      runtimes: this.snapshot.runtimes.filter(runtime => canonical(runtime.installationId) === installation.installationId),
    })).sort((a, b) => Number(b.runtimes.length > 0) - Number(a.runtimes.length > 0)
      || Number(b.installation.lastCheck?.result.kind === "update-available")
        - Number(a.installation.lastCheck?.result.kind === "update-available")
      || a.installation.family.localeCompare(b.installation.family)
      || a.installation.installationId.localeCompare(b.installation.installationId));
  }

  refresh(snapshot: CatalogSnapshot, jobs: readonly Job[] = this.jobs): void {
    const previous = this.rows;
    const resolve = (id: string): string | null => {
      const old = previous.find(row => row.installation.installationId === id);
      const identities = [id, ...(old?.aliases ?? [])];
      return snapshot.installations.find(install => identities.includes(install.installationId)
        || snapshot.aliases.some(alias => identities.includes(alias.installationId)
          && alias.canonicalId === install.installationId))?.installationId ?? null;
    };
    this.selected = this.selected === null ? null : resolve(this.selected);
    this.expanded = new Set([...this.expanded].flatMap(id => {
      const next = resolve(id);
      return next === null ? [] : [next];
    }));
    this.snapshot = snapshot;
    this.jobs = jobs;
    // Disappeared selection deliberately clears; never silently check a neighbor.
  }

  input(key: string): CatalogCheckAction | null {
    const rows = this.rows;
    const index = rows.findIndex(row => row.installation.installationId === this.selected);
    switch (key) {
      case "j":
      case "ArrowDown":
      case "\x1b[B":
        this.selected = rows[Math.min(rows.length - 1, index + 1)]?.installation.installationId ?? null;
        this.offset = 0;
        return null;
      case "k":
      case "ArrowUp":
      case "\x1b[A":
        this.selected = rows[Math.max(0, index - 1)]?.installation.installationId ?? null;
        this.offset = 0;
        return null;
      case "PageDown":
      case "\x1b[6~":
        this.offset += 10;
        return null;
      case "PageUp":
      case "\x1b[5~":
        this.offset = Math.max(0, this.offset - 10);
        return null;
      case "Enter":
      case "\r":
      case " ":
      case "d":
        this.offset = 0;
        if (this.selected !== null) {
          if (this.expanded.has(this.selected)) this.expanded.delete(this.selected);
          else this.expanded.add(this.selected);
        }
        return null;
      case "c": {
        const row = rows[index];
        if (!row) return null;
        const ids = [row.installation.installationId, ...row.aliases];
        const observations = this.snapshot.observations.filter(item =>
          ids.includes(item.contract.installation.installationId));
        if (observations.length === 0 || observations.some(item => item.contract.capabilities.check.kind !== "supported"))
          return null;
        return { operation: "check", installationId: row.installation.installationId };
      }
      default: return null;
    }
  }

  render(columns: number, height: number, counts?: ReadonlyMap<string, readonly string[]>,
    latestLabels?: ReadonlyMap<string, string>): string {
    const width = Math.max(1, Math.floor(columns));
    const rows = this.rows;
    const widths = catalogColumns(width);
    const lines: string[] = [];
    let anchor = 0;
    for (const row of rows) {
      const install = row.installation;
      const chosen = install.installationId === this.selected;
      if (chosen) anchor = lines.length;
      const open = this.expanded.has(install.installationId);
      const panes = new Set(row.runtimes.map(runtime => JSON.stringify([runtime.binding.socketId, runtime.binding.paneId])));
      const check = install.lastCheck?.result;
      let checkText = "unknown (not_checked)";
      if (check) {
        switch (check.kind) {
          case "update-available": checkText = `update -> ${check.availableVersion}`; break;
          case "up-to-date": checkText = "up-to-date"; break;
          case "unavailable": checkText = `unavailable (${check.failure.code})`; break;
        }
      }
      const latest = latestLabels?.get(install.installationId) ?? (check?.kind === "update-available" ? check.availableVersion
        : check?.kind === "up-to-date" ? check.installedVersion : check?.kind === "unavailable"
          ? check.failure.code === "unsupported" ? "unsupported" : "Failed" : "Not checked");
      lines.push(tableRow([
        `${chosen ? ">" : " "} ${install.family}`,
        version(install.installedVersion), latest,
        ...(counts?.get(install.installationId) ?? [String(panes.size), "-", "-"]),
      ], widths));
      if (open) {
        lines.push(`    channel: ${install.channel}`);
        lines.push(`    installed: ${version(install.installedVersion)}`);
        if (row.runtimes.length > 0)
          lines.push(`    running: ${[...new Set(row.runtimes.map(runtime => version(runtime.runningVersion)))].join(", ")}`);
        lines.push(`    check: ${checkText}`);
        lines.push(`    channel: ${install.channel} | ${row.runtimes.length > 0 ? "RUNNING" : "INSTALLED"}`);
        lines.push(`    path: ${install.executableRealpath}`);
      }
      if (open) {
        lines.push(`    installation: ${install.installationId}`);
        const checkedAt = install.lastCheck?.checkedAt;
        lines.push(`    checked: ${checkedAt === undefined ? "never" : checkedAt > 8_640_000_000_000_000
          ? String(checkedAt) : new Date(checkedAt).toISOString()}`);
        if (row.aliases.length > 0) lines.push(`    aliases: ${row.aliases.join(", ")}`);
        const ids = [install.installationId, ...row.aliases];
        const observations = this.snapshot.observations.filter(item => ids.includes(item.contract.installation.installationId));
        if (observations.length === 0) lines.push("    capabilities: unknown (not_verified)");
        for (const observation of observations) {
          lines.push(`    capabilities [${observation.sourceId}]:`);
          for (const name of capabilityNames) {
            const cap = observation.contract.capabilities[name];
            lines.push(`      ${name}: ${cap.kind} (${cap.reason})`);
          }
        }
      }
      if (open) for (const job of this.jobs.filter(job =>
        [install.installationId, ...row.aliases].includes(job.installTxn.selection.installationId)))
        lines.push(`    ${open ? `job ${job.jobId}` : "Update"}: ${job.status}${open ? ` / ${job.installTxn.state}` : ""}`);
      if (open) for (const runtime of row.runtimes)
        lines.push(`    ${runtime.binding.socketId}/${runtime.binding.paneId}`
          + ` running: ${version(runtime.runningVersion)}`
          + (row.runtimes.filter(other => other.binding.socketId === runtime.binding.socketId
            && other.binding.paneId === runtime.binding.paneId).length > 1 ? " [ambiguous]" : ""));
    }
    if (rows.length === 0) lines.push("No installations observed. Press u to refresh and retry.");
    for (const failure of this.snapshot.failures)
      lines.push(`Catalog read unavailable: ${failure.error.code}. Press u to retry.`);
    const budget = Math.max(0, Math.floor(height) - 4);
    const start = Math.min(anchor + this.offset, Math.max(0, lines.length - budget));
    const visible = lines.slice(start, start + budget);
    const hidden = lines.length - visible.length;
    while (visible.length < budget) visible.push("");
    return [
      "CLI CATALOG / installed and running versions",
      "Open: observed sessions | Working/Ready require current evidence",
      tableRow(["CLI", "Installed", "Latest", "Open", "Working", "Ready"], widths),
      ...visible,
      `PgUp/PgDn scroll${hidden > 0 ? ` | ${hidden} lines outside view` : ""}`,
    ].slice(0, Math.max(0, Math.floor(height))).map(line => fit(line, width)).join("\n");
  }
}
