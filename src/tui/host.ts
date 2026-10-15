import { isDeepStrictEqual } from "node:util";
import { StringDecoder } from "node:string_decoder";
import type { CatalogSnapshot } from "../catalog";
import type { Installation, Job, OperationResults, Runtime, ServiceResponse } from "../protocol";
import { attachAuthenticatedWorker, ClientError } from "../service/client";
import type { WorkerAttachment, WorkerSubscription } from "../service/client";
import { CatalogComponent } from "./catalog";
import { SelectComponent } from "./select";
import type { SelectionSnapshot } from "./select";
import { JobComponent } from "./job";
import { RecoveryComponent } from "./recovery";
import { catalogColumns, ink, panel, space, tableRow } from "./presentation";

export interface TerminalInput {
  readonly isTTY: boolean;
  readonly isRaw: boolean;
  readonly isPaused: boolean;
  readonly setRawMode: (raw: boolean) => void;
  readonly resume: () => void;
  readonly pause: () => void;
  readonly onData: (listener: (data: string) => void) => () => void;
  readonly onClose: (listener: () => void) => () => void;
}
export interface TerminalOutput {
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly write: (text: string) => void;
  readonly onResize: (listener: () => void) => () => void;
  readonly onClose: (listener: () => void) => () => void;
}
export type HostFrame = {
  readonly view: "catalog" | "jobs" | "job" | "recovery" | "selection";
  readonly text: string;
  readonly columns: number;
  readonly rows: number;
  readonly busy: boolean;
  readonly notice: string;
};
export type HostOptions = {
  readonly directory?: string;
  readonly input?: TerminalInput;
  readonly output?: TerminalOutput;
  /** Explicit initial cursor, or atomically subscribe to new live publications. */
  readonly afterSequence?: 0 | "current";
  /** Private, independently observed metadata; the wire API does not supply it.
   * Every use is compared with fresh authenticated DTOs. Absence stays unavailable.
   */
  readonly catalog?: CatalogSnapshot;
  readonly selections?: readonly SelectionSnapshot[];
  readonly onFrame?: (frame: HostFrame) => void;
  /** Trusted plugin opt-in. Called only after terminal and worker attachments detach. */
  readonly onPrepareInstallation?: (installation: Installation) => void;
};
export class HostError extends Error {
  constructor(readonly code: "not_terminal" | "terminal_failed" | "metadata_failed") {
    super(code);
    this.name = "HostError";
  }
}

/** Concrete attachment owns only its terminal listeners, never worker lifetime. */
export function productionTerminal(): { readonly input: TerminalInput; readonly output: TerminalOutput } {
  const stdin = process.stdin, stdout = process.stdout;
  return {
    input: {
      get isTTY() { return stdin.isTTY === true; },
      get isRaw() { return stdin.isRaw === true; },
      get isPaused() { return stdin.isPaused(); },
      setRawMode: raw => stdin.setRawMode(raw),
      resume: () => { stdin.resume(); },
      pause: () => { stdin.pause(); },
      onData: listener => {
        const decoder = new StringDecoder("utf8");
        const data = (chunk: Buffer | string) => listener(typeof chunk === "string" ? chunk : decoder.write(chunk));
        stdin.on("data", data);
        return () => { stdin.removeListener("data", data); };
      },
      onClose: listener => {
        stdin.on("end", listener);
        stdin.on("close", listener);
        stdin.on("error", listener);
        return () => {
          stdin.removeListener("end", listener);
          stdin.removeListener("close", listener);
          stdin.removeListener("error", listener);
        };
      },
    },
    output: {
      get isTTY() { return stdout.isTTY === true; },
      get columns() { return stdout.columns; },
      get rows() { return stdout.rows; },
      write: text => { stdout.write(text); },
      onResize: listener => {
        stdout.on("resize", listener);
        return () => { stdout.removeListener("resize", listener); };
      },
      onClose: listener => {
        stdout.on("close", listener);
        stdout.on("error", listener);
        return () => {
          stdout.removeListener("close", listener);
          stdout.removeListener("error", listener);
        };
      },
    },
  };
}

/** Only printable data survives; control sequences are produced by this host.
 * Credentials/raw exceptions/private bindings are never formatted.
 */
function fit(text: string, columns: number): string {
  const clean = text
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|\u0090)[\s\S]*?(?:\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "");
  let result = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean)) {
    if (Bun.stringWidth(result + segment) > columns) break;
    result += segment;
  }
  return result;
}
function dimension(value: number, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}

export async function openTerminalHost(options: HostOptions = {}) {
  const terminal = productionTerminal();
  const input = options.input ?? terminal.input, output = options.output ?? terminal.output;
  if (!input.isTTY || !output.isTTY) throw new HostError("not_terminal");
  const metadata = options.catalog ? structuredClone(options.catalog) : undefined;
  const selections = structuredClone(options.selections ?? []);
  const attachment: WorkerAttachment = await attachAuthenticatedWorker(options.directory, 15000);
  // Each authenticated connection serializes requests. Separate connections are
  // required for bounded concurrency, while preserving per-connection correlation.
  const attachments = [attachment];
  try {
    for (let index = 1; index < 3; index++) {
      const next = await attachAuthenticatedWorker(options.directory, 15000);
      attachments.push(next);
      if (next.incarnation !== attachment.incarnation) throw new ClientError("identity_mismatch");
    }
  } catch (error) {
    for (const current of attachments) current.close();
    throw error;
  }
  const ended = Promise.withResolvers<void>();
  let closed = false, entered = false, rawChanged = false, resumed = false, busy = true;
  let stream: WorkerSubscription | undefined;
  let view: HostFrame["view"] = "catalog", notice = "loading";
  let installations: readonly Installation[] | null = null, runtimes: readonly Runtime[] | null = null;
  let sessions: OperationResults["sessions"] | null = null;
  const readyCounts = new Map<string, number | null>();
  const checks = new Map<string, Promise<void>>();
  const checkSlots = [...attachments];
  const checkWaiters: ((attachment: WorkerAttachment | undefined) => void)[] = [];
  const latestLabels = new Map<string, string>();
  const checkFailures = new Map<string, string>();
  const unavailableUpdates = new Set<string>();
  let jobs: readonly Job[] | null = null, catalog: CatalogComponent | undefined;
  let selection: SelectComponent | undefined, job: JobComponent | undefined, recovery: RecoveryComponent | undefined;
  let cursor = 0, listOffset = 0, pendingKey = "";
  let installationCursor = 0;
  let details = false;
  let catalogOffset = 0;
  let selectionSnapshot: SelectionSnapshot | undefined;
  const disposers: (() => void)[] = [];
  const wasRaw = input.isRaw, wasPaused = input.isPaused;
  function jobLabel(value: Job): string {
    const install = installations?.find(row => row.installationId === value.installTxn.selection.installationId);
    return install ? `${install.family} [${install.channel}]` : "CLI update";
  }
  function close(): void {
    if (closed) return;
    closed = true;
    for (const release of checkWaiters.splice(0)) release(undefined);
    const errors: unknown[] = [];
    for (const dispose of disposers.splice(0)) {
      try { dispose(); } catch (error) { errors.push(error); }
    }
    stream?.close();
    for (const current of attachments) current.close();
    if (rawChanged) {
      try { input.setRawMode(wasRaw); } catch (error) { errors.push(error); }
    }
    if (resumed && wasPaused) {
      try { input.pause(); } catch (error) { errors.push(error); }
    }
    if (entered) {
      try { output.write(ink.normal + "\x1b[?25h\x1b[?1049l"); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) ended.reject(new HostError("terminal_failed"));
    else ended.resolve();
  }
  // A caller may acquire the close promise later; always own its rejection now.
  void ended.promise.catch(error => { if (!(error instanceof HostError)) throw error; });
  function draw(): void {
    if (closed) return;
    const columns = dimension(output.columns, 80, 120), rows = dimension(output.rows, 24, 40);
    // Leave the final physical column free: no autowrap pending on the last row.
    const framed = columns >= 6 && rows >= 4;
    const width = Math.max(0, columns - space.reservedColumn
      - (framed ? 2 * (space.padding + space.border) : 0));
    const height = Math.max(0, rows - (framed ? space.chromeRows : 3));
    const widths = catalogColumns(width);
    const counts = new Map((installations ?? []).map(row => [row.installationId, [
      sessions === null || sessions.unavailableSources > 0 ? "-"
        : String(sessions.sessions.filter(session => session.family === row.family).length),
      sessions === null || sessions.unavailableSources > 0
        || sessions.sessions.some(session => session.family === row.family && session.status === "unknown") ? "-"
        : String(sessions.sessions.filter(session => session.family === row.family && session.status === "working").length),
      readyCounts.get(row.installationId) === null || !readyCounts.has(row.installationId) ? "-"
        : String(readyCounts.get(row.installationId)),
    ]]));
    let body: string;
    switch (view) {
      case "catalog": {
        body = catalog ? catalog.render(Math.max(1, width), height, counts, latestLabels)
          : [installations === null ? "CLI CATALOG / discovery unavailable" : "CLI CATALOG / installed CLIs",
            installations === null ? "Press u to retry. Source details: bun scripts/plugin.ts doctor"
              : "Latest checks available. Enter selects an update only when its runner is verified.",
            installations === null ? "Installations unavailable"
              : `Installed CLIs: ${installations.length} | Open sessions: ${sessions === null ? "-"
                : sessions.sessions.length}${sessions?.unavailableSources ? " | Partial observation" : ""}`,
            tableRow(["CLI", "Installed", "Latest", "Open", "Working", "Ready"], widths),
            ...(installations ?? []).flatMap((row, index) => [
              tableRow([
                `${index === installationCursor ? ">" : " "} ${row.family}`,
                row.installedVersion.kind === "known" ? row.installedVersion.version : "unknown",
                latestLabels.get(row.installationId) ?? (row.lastCheck?.result.kind === "update-available" ? row.lastCheck.result.availableVersion
                  : row.lastCheck?.result.kind === "up-to-date" ? row.lastCheck.result.installedVersion
                    : row.lastCheck?.result.kind === "unavailable"
                      ? row.lastCheck.result.failure.code === "unsupported" ? "unsupported" : "Failed" : "Not checked"),
                ...(counts.get(row.installationId) ?? ["-", "-", "-"]),
              ], widths),
              ...(details && index === installationCursor ? [`  installation: ${row.installationId}`,
                `  path: ${row.executableRealpath}`,
                `  check: ${row.lastCheck?.result.kind === "unavailable" ? row.lastCheck.result.failure.code
                  : row.lastCheck?.result.kind ?? "not_checked"}`,
              ...[...new Set((runtimes ?? []).filter(runtime => runtime.installationId === row.installationId)
                .map(runtime => runtime.runningVersion.kind === "known" ? runtime.runningVersion.version : "unknown"))]
                .map(version => `  running: ${version}`)] : []),
            ]),
          ].join("\n");
        if (!catalog) {
          const lines = body.split("\n");
          const entries = lines.slice(4);
          const focused = entries.findIndex(line => line.startsWith(">"));
          const budget = Math.max(1, height - 4);
          const focusRows = Math.min(budget, details ? 2 : 1);
          if (focused >= 0) {
            if (focused < catalogOffset) catalogOffset = focused;
            if (focused + focusRows > catalogOffset + budget) catalogOffset = focused + focusRows - budget;
          }
          catalogOffset = Math.min(catalogOffset, Math.max(0, entries.length - budget));
          body = [...lines.slice(0, 4), ...entries.slice(catalogOffset, catalogOffset + budget)].join("\n");
        }
        break;
      }
      case "jobs": {
        const visible = Math.max(1, height - 2);
        listOffset = Math.max(0, Math.min(listOffset, cursor));
        if (cursor >= listOffset + visible) listOffset = cursor - visible + 1;
        body = jobs === null ? "JOBS unavailable" : [
          `JOBS ${jobs.length} | Up/Down move | Enter open | d details`,
          ...jobs.slice(listOffset, listOffset + visible).map((row, i) =>
            `${i + listOffset === cursor ? ">" : " "} ${details ? `${row.jobId} / revision ${row.revision}`
              : `${i + listOffset + 1}. ${jobLabel(row)}`} / ${row.status}`),
          `${jobs.length - Math.min(jobs.length, listOffset + visible)} below`,
        ].join("\n");
        break;
      }
      case "job": body = job?.render(Math.max(1, width), height) ?? "Job unavailable"; break;
      case "recovery": body = recovery?.render(Math.max(1, width), height) ?? "Recovery unavailable"; break;
      case "selection": body = selection?.render(Math.max(1, width), height) ?? "Selection unavailable"; break;
      default: body = view satisfies never;
    }
    const bodyLines = body.split("\n").slice(0, height);
    while (bodyLines.length < height) bodyLines.push("");
    const focusedId = catalog?.selectedInstallationId ?? installations?.[installationCursor]?.installationId;
    const focused = installations?.find(row => row.installationId === focusedId);
    const focusedFailure = focusedId ? checkFailures.get(focusedId) : undefined;
    const catalogNotice = view === "catalog" && focusedId && unavailableUpdates.has(focusedId)
      ? `${focused?.family ?? "CLI"}: update unavailable; runner/native not connected`
      : view === "catalog" && focusedFailure
        ? `${focused?.family ?? "CLI"}: check ${focusedFailure}${focusedFailure === "unsupported" ? "; not implemented" : "; c retry"}`
        : notice;
    const lines = [
      "CLI UPDATER  [1 Catalog]  [2 Jobs]  | u refresh | q close",
      `${busy ? "Working" : view === "catalog" && !metadata ? "Read-only" : "Ready"} | ${notice.startsWith("job ") ? "Selected update"
        : notice.startsWith("persisted cancellation / ") ? "Cancellation confirmed"
          : view === "job" && job && notice.startsWith("Discovery failed")
            ? "Job status verified; catalog needs refresh"
          : job && notice.endsWith(` / ${job.observation.jobId}`) ? "Update request recorded" : catalogNotice}`
          + ` | ${stream ? "Live progress" : "u refresh for progress"}`,
      ...bodyLines,
      ({
        catalog: "Up/Down choose | Enter/s select | d details | c recheck | u refresh",
        jobs: "Up/Down move | Enter open | u refresh",
        job: "Enter/i inspect | r recovery | u refresh | Esc jobs",
        recovery: "Enter/i inspect | b back | u refresh | No automatic retry",
        selection: "No changes until confirmation | q closes the view, not the job",
      } satisfies Record<HostFrame["view"], string>)[view],
    ].slice(0, rows).map(line => fit(line, width));
    const rendered = panel(lines, columns, rows, view === "catalog" || view === "selection" ? "catalog" : "jobs");
    const text = rendered.text;
    output.write("\x1b[H\x1b[2J" + rendered.ansi);
    options.onFrame?.({ view, text, columns, rows, busy, notice });
  }
  function acceptJob(next: Job): boolean {
    const existing = jobs?.find(item => item.jobId === next.jobId);
    if ((existing && (next.revision < existing.revision
      || (next.revision === existing.revision && !isDeepStrictEqual(existing, next))))
      || [job?.observation, recovery?.observation].some(observed =>
        observed?.jobId === next.jobId && next.revision < observed.expectedRevision)) {
      notice = "revision_conflict";
      return false;
    }
    if (job?.observation.jobId === next.jobId) {
      const refreshed = job.refresh(next);
      if (!refreshed.ok) { notice = refreshed.error.code; return false; }
    }
    if (recovery?.observation.jobId === next.jobId) {
      const refreshed = recovery.refresh(next);
      if (!refreshed.ok) { notice = refreshed.error.code; return false; }
    }
    jobs = jobs?.some(item => item.jobId === next.jobId)
      ? jobs.map(item => item.jobId === next.jobId ? next : item) : [...(jobs ?? []), next];
    if (catalog && metadata) catalog.refresh(metadata, jobs ?? []);
    return true;
  }
  function event(response: ServiceResponse): void {
    if (closed) return;
    switch (response.operation) {
      case "cancel-job":
      case "create-job":
      case "inspect-job":
        if (response.ok) acceptJob(response.result.job);
        else notice = response.error.code;
        break;
      default: notice = "event requires explicit refresh"; break;
    }
    draw();
  }
  async function checkLatest(installationId: string): Promise<void> {
    const pending = checks.get(installationId);
    if (pending) return pending;
    checkFailures.delete(installationId);
    latestLabels.set(installationId, "Checking");
    draw();
    const checked = (async () => {
      const current = checkSlots.shift()
        ?? await new Promise<WorkerAttachment | undefined>(resolve => checkWaiters.push(resolve));
      if (closed || !current) return;
      const response = await current.request({ operation: "check", installationId }).finally(() => {
        const next = checkWaiters.shift();
        if (next) next(current);
        else checkSlots.push(current);
      });
      if (closed) return;
      const result = response.ok ? response.result.result : { kind: "unavailable", failure: response.error,
        checkedAt: Date.now() } as const;
      if (response.ok) installations = installations?.map(row => row.installationId === installationId
        ? { ...row, lastCheck: { checkedAt: result.checkedAt, result } } : row) ?? null;
      if (result.kind === "unavailable") {
        checkFailures.set(installationId, result.failure.code);
        latestLabels.set(installationId, result.failure.code === "unsupported" ? "unsupported" : "Failed");
      } else {
        latestLabels.set(installationId, result.kind === "update-available" ? result.availableVersion : result.installedVersion);
        notice = "Latest version checked; c recheck";
      }
      if (catalog && metadata && installations) catalog.refresh({ ...metadata, installations }, jobs ?? []);
      draw();
    })().catch(error => {
      if (closed) return;
      if (!(error instanceof ClientError)) { fail(error); return; }
      checkFailures.set(installationId, error.code);
      latestLabels.set(installationId, "Failed");
      notice = `Version check failed (${error.code}); c retry`;
      draw();
    }).catch(fail).finally(() => checks.delete(installationId));
    checks.set(installationId, checked);
    return checked;
  }
  async function checkCatalog(): Promise<void> {
    await Promise.all((installations ?? []).map(installation =>
      closed ? undefined : checkLatest(installation.installationId)));
  }
  async function refresh(): Promise<void> {
    const selectedId = jobs?.[cursor]?.jobId;
    const [i, s, j, r] = await Promise.all([
      attachment.request({ operation: "installations" }),
      (attachments[1] ?? attachment).request({ operation: "sessions" }),
      (attachments[2] ?? attachment).request({ operation: "jobs" }),
      metadata ? attachment.request({ operation: "runtimes" }) : null,
    ]);
    if (closed) return;
    installations = i.ok ? i.result.installations : null;
    installationCursor = Math.min(installationCursor, Math.max(0, (installations?.length ?? 0) - 1));
    runtimes = r?.ok ? r.result.runtimes : null;
    sessions = s.ok ? s.result : null;
    readyCounts.clear();
    await Promise.all((installations ?? []).map(async installation => {
      if (!sessions || sessions.unavailableSources > 0) {
        readyCounts.set(installation.installationId, null); return;
      }
      const observed = sessions.sessions.filter(session => session.family === installation.family);
      if (observed.length === 0) { readyCounts.set(installation.installationId, 0); return; }
      if (observed.some(session => session.workComplete === null)) {
        readyCounts.set(installation.installationId, null); return;
      }
      const result = await attachment.request({ operation: "targets", installationId: installation.installationId });
      // Unsupported lifecycle is known ineligible. Other missing evidence is not zero.
      if (!result.ok) {
        readyCounts.set(installation.installationId, result.error.code === "unsupported" ? 0 : null);
        return;
      }
      if (result.result.targets.length === 0 || installation.lastCheck?.result.kind === "up-to-date") {
        readyCounts.set(installation.installationId, 0); return;
      }
      const metadata = result.result.selection;
      if (!metadata || sessions === null || sessions.unavailableSources > 0
        || installation.lastCheck?.result.kind !== "update-available") {
        readyCounts.set(installation.installationId, null); return;
      }
      if (metadata.update.kind !== "supported" || metadata.readiness.kind !== "supported") {
        readyCounts.set(installation.installationId, 0); return;
      }
      const ready = metadata.targets.filter(target => [target.readiness, target.completion,
        target.resume, target.gracefulExit].every(capability => capability.kind === "supported"));
      const observations = ready.map(target => sessions?.sessions.find(session =>
        session.socketId === target.target.expectedBinding.socketId && session.paneId === target.target.expectedBinding.paneId));
      readyCounts.set(installation.installationId, observations.some(session => !session || session.workComplete === null)
        ? null : observations.filter(session => session?.workComplete === true).length);
    }));
    if (closed) return;
    if (!j.ok) { jobs = null; job = undefined; recovery = undefined; notice = `jobs: ${j.error.code}`; }
    else {
      if (j.result.jobs.some(next => {
        const previous = jobs?.find(row => row.jobId === next.jobId);
        return previous && (next.revision < previous.revision
          || (next.revision === previous.revision && !isDeepStrictEqual(next, previous)));
      })) {
        notice = "revision_conflict";
        return;
      }
      for (const next of j.result.jobs) if (!acceptJob(next)) return;
      jobs = j.result.jobs;
      cursor = Math.max(0, jobs.findIndex(item => item.jobId === selectedId));
      if (job && !jobs.some(row => row.jobId === job?.observation.jobId)) {
        job = undefined; recovery = undefined; view = "jobs";
      }
      notice = !i.ok ? `Discovery failed (${i.error.code}); u retry or run doctor`
        : !s.ok ? "Session observation unavailable; counts are -"
          : s.result.unavailableSources > 0 ? "Some session sources unavailable; counts are -"
            : "Sessions observed by CLI family | Ready requires verified completion";
    }
    const matches = metadata && i.ok && r?.ok
      && isDeepStrictEqual(metadata.installations, installations)
      && isDeepStrictEqual(metadata.runtimes, runtimes);
    if (matches) {
      if (catalog) catalog.refresh(metadata, jobs ?? []);
      else catalog = new CatalogComponent(metadata, jobs ?? []);
    } else catalog = undefined;
    selection = undefined;
    selectionSnapshot = undefined;
    if (view === "selection") view = "catalog";
  }
  async function inspect(jobId: string): Promise<void> {
    const result = await attachment.request({ operation: "inspect-job", jobId });
    if (closed) return;
    if (!result.ok) { notice = result.error.code; return; }
    if (!acceptJob(result.result.job)) return;
    recovery = new RecoveryComponent(result.result.job, jobLabel(result.result.job));
    view = "recovery";
    notice = "inspection only; reconcile unsupported";
  }
  async function action(key: string): Promise<void> {
    if (key === "u") { await refresh(); return; }
    switch (view) {
      case "catalog": {
        if (key === "c") {
          const id = catalog?.selectedInstallationId ?? installations?.[installationCursor]?.installationId;
          if (id) void checkLatest(id);
          return;
        }
        if (!catalog && key === "d") {
          details = !details;
          if (details) {
            const result = await attachment.request({ operation: "runtimes" });
            if (!closed) runtimes = result.ok ? result.result.runtimes : null;
          }
          return;
        }
        if (!catalog && ["j", "k", "ArrowDown", "ArrowUp"].includes(key)) {
          installationCursor = Math.max(0, Math.min((installations?.length ?? 1) - 1,
            installationCursor + (key === "j" || key === "ArrowDown" ? 1 : -1)));
          return;
        }
        if (key === "s" || key === "Enter") {
          const id = catalog?.selectedInstallationId ?? installations?.[installationCursor]?.installationId;
          if (!id) { notice = "selection metadata unavailable"; return; }
          await checks.get(id);
          if (closed) return;
          const installation = installations?.find(row => row.installationId === id);
          if (installation?.lastCheck?.result.kind === "up-to-date") {
            unavailableUpdates.delete(id);
            notice = "up-to-date"; return;
          }
          const targets = await attachment.request({ operation: "targets", installationId: id });
          if (closed) return;
          if (installation?.family === "omo" && options.onPrepareInstallation
            && ((!targets.ok && targets.error.code === "unsupported")
              || (targets.ok && !targets.result.selection && !selections.some(row => row.installation.installationId === id)))) {
            const fresh = await attachment.request({ operation: "installations" });
            if (closed) return;
            const { lastCheck: _check, ...identity } = installation;
            const current = fresh.ok ? fresh.result.installations.find(row => row.installationId === id) : undefined;
            const { lastCheck: _currentCheck, ...currentIdentity } = current ?? {};
            if (!current || !isDeepStrictEqual(identity, currentIdentity)) {
              notice = fresh.ok ? "stale_selection" : fresh.error.code; return;
            }
            close();
            options.onPrepareInstallation(structuredClone(current));
            return;
          }
          if (!targets.ok) {
            if (targets.error.code === "unsupported") unavailableUpdates.add(id);
            notice = targets.error.code === "unsupported" ? "Update runner not connected; no changes made"
              : `Cannot select update (${targets.error.code}); u retry`;
            return;
          }
          unavailableUpdates.delete(id);
          const candidate = targets.result.selection ?? selections.find(row => row.installation.installationId === id);
          if (!candidate) {
            unavailableUpdates.add(id);
            notice = "unsupported"; return;
          }
          const { lastCheck: _candidateCheck, ...candidateIdentity } = candidate.installation;
          const { lastCheck: _lastCheck, ...identity } = installation ?? {};
          if (!isDeepStrictEqual(identity, candidateIdentity)) {
            notice = "stale_selection"; return;
          }
          if (candidate.installation.lastCheck?.result.kind === "up-to-date") {
            notice = "up-to-date"; return;
          }
          if (!isDeepStrictEqual(candidate.targets.map(row => row.target), targets.result.targets)) {
            notice = "stale_selection"; return;
          }
          // Check DTOs annotate the same identity; they do not grant runner authority.
          selectionSnapshot = candidate.installation.lastCheck || !installation?.lastCheck ? candidate
            : { ...candidate, installation: { ...candidate.installation, lastCheck: installation.lastCheck } };
          selection = new SelectComponent(selectionSnapshot); notice = ""; view = "selection"; return;
        }
        catalog?.input(key);
        return;
      }
      case "jobs":
        if (key === "d") details = !details;
        else if (key === "j" || key === "ArrowDown") cursor = Math.min(Math.max(0, (jobs?.length ?? 0) - 1), cursor + 1);
        else if (key === "k" || key === "ArrowUp") cursor = Math.max(0, cursor - 1);
        else if (key === "Enter") {
          const selected = jobs?.[cursor];
          if (selected) {
            job = new JobComponent(selected, jobLabel(selected)); recovery = undefined; view = "job";
            notice = `job ${selected.jobId}`;
          }
        }
        return;
      case "job": {
        if (key === "r" && job) { await inspect(job.observation.jobId); return; }
        const intent = job?.input(key);
        if (!intent) return;
        if (!intent.ok) { notice = intent.error.code; return; }
        const observed = intent.value;
        if (!jobs?.some(row => row.jobId === observed.jobId && row.revision === observed.expectedRevision)) {
          notice = "revision_conflict"; return;
        }
        if (observed.operation === "inspect-job") { await inspect(observed.jobId); return; }
        const result = await attachment.request({ operation: "cancel-job", jobId: observed.jobId,
          expectedRevision: observed.expectedRevision });
        if (!closed) {
          if (result.ok) {
            if (acceptJob(result.result.job)) notice = `persisted cancellation / ${result.result.job.jobId}`;
          }
          else notice = result.error.code;
        }
        return;
      }
      case "recovery": {
        if (key === "x") { notice = "reconcile unsupported; no retry"; return; }
        const intent = recovery?.input(key);
        if (!intent) return;
        if (!intent.ok) { notice = intent.error.code; return; }
        if (intent.value.operation === "back") { view = job ? "job" : "jobs"; return; }
        await inspect(intent.value.jobId); return;
      }
      case "selection": {
        if (key === "Escape" && selection?.stage === "emitted") { view = "catalog"; return; }
        const intent = selection?.input(key);
        if (selection?.stage === "cancelled") { view = "catalog"; return; }
        if (!intent) return;
        if (!intent.ok) { notice = intent.error.code; return; }
        const fresh = await attachment.request({ operation: "installations" });
        if (closed) return;
        if (!fresh.ok || !fresh.result.installations.some(row => {
          const { lastCheck: _lastCheck, ...identity } = row;
          const { lastCheck: _selectedCheck, ...selectedIdentity } = selectionSnapshot?.installation ?? {};
          return isDeepStrictEqual(identity, selectedIdentity);
        })) {
          notice = fresh.ok ? "stale_selection" : fresh.error.code; return;
        }
        if (intent.value.mode === "update-and-restart") {
          const targets = await attachment.request({ operation: "targets", installationId: intent.value.installation.installationId });
          if (closed) return;
          if (!targets.ok || (targets.result.selection && !isDeepStrictEqual(targets.result.selection, selectionSnapshot))
            || intent.value.selectedTargets.some(target =>
            !targets.result.targets.some(current => isDeepStrictEqual(current, target)))) {
            notice = targets.ok ? "stale_binding" : targets.error.code; return;
          }
        }
        // No optimistic job, execution or replay on unsupported/uncertain writes.
        const result = await attachment.request(intent.value);
        if (!closed) {
          if (!result.ok) { notice = result.error.code; return; }
          const observed = jobs?.find(row => row.jobId === result.result.job.jobId);
          const current = observed && observed.revision > result.result.job.revision ? observed : result.result.job;
          if (!acceptJob(current)) return;
          job = new JobComponent(current, jobLabel(current)); recovery = undefined; view = "job";
          notice = `${result.result.kind} / ${current.jobId}`;
        }
        return;
      }
      default: return view satisfies never;
    }
  }
  function fail(error: unknown): void {
    if (closed) return;
    notice = error instanceof ClientError ? error.code : "terminal_failed";
    busy = false;
    // Terminal/event boundary: never print or propagate raw callback exceptions.
    try { draw(); } catch (renderError) {
      if (renderError instanceof ClientError) notice = renderError.code;
      else notice = "terminal_failed";
    } finally { close(); }
  }
  function keypress(key: string): void {
    if (closed) return;
    if (key === "q" || key === "\x03") { close(); return; }
    if (busy) return; // Never queue effects from pasted or repeated input.
    if (key === "1" || key === "2") { view = key === "1" ? "catalog" : "jobs"; draw(); return; }
    if (key === "Escape" && view !== "selection" && view !== "recovery") { view = "jobs"; draw(); return; }
    busy = true;
    void action(key).then(() => { if (!closed) { busy = false; draw(); } }).catch(fail);
  }
  function data(chunk: string): void {
    if (chunk.length > 64) { pendingKey = ""; return; }
    pendingKey += chunk;
    const escapes = [["\x1b[A", "ArrowUp"], ["\x1b[B", "ArrowDown"],
      ["\x1b[C", "ArrowRight"], ["\x1b[D", "ArrowLeft"],
      ["\x1b[5~", "PageUp"], ["\x1b[6~", "PageDown"]] as const;
    while (pendingKey.length > 0 && !closed) {
      const match = escapes.find(([sequence]) => pendingKey.startsWith(sequence));
      if (match) { pendingKey = pendingKey.slice(match[0].length); keypress(match[1]); continue; }
      if (pendingKey !== "\x1b" && escapes.some(([sequence]) => sequence.startsWith(pendingKey))) return;
      const key = pendingKey[0];
      pendingKey = pendingKey.slice(1);
      if (key) keypress(key === "\r" || key === "\n" ? "Enter" : key === "\x1b" ? "Escape" : key);
    }
  }
  try {
    disposers.push(input.onData(chunk => {
      try { data(chunk); } catch (error) { fail(error); }
    }));
    disposers.push(input.onClose(close));
    disposers.push(output.onResize(() => {
      try { draw(); } catch (error) { fail(error); }
    }));
    disposers.push(output.onClose(close));
    if (!wasRaw) { rawChanged = true; input.setRawMode(true); }
    if (wasPaused) { resumed = true; input.resume(); }
    entered = true;
    output.write("\x1b[?1049h\x1b[?25l");
    draw();
    if (options.afterSequence !== undefined) {
      stream = await attachment.subscribe({ incarnation: attachment.incarnation, sequence: options.afterSequence }, {
        event: value => event(value.response),
        error: fail,
      });
      if (closed) stream.close();
    }
    if (!closed) {
      await refresh(); busy = false; draw();
      void checkCatalog().catch(fail);
    }
    return { close, closed: ended.promise, get isClosed() { return closed; } };
  } catch (error) {
    if (closed && error instanceof ClientError && error.code === "closed")
      return { close, closed: ended.promise, get isClosed() { return closed; } };
    close();
    if (error instanceof ClientError || error instanceof HostError) throw error;
    throw new HostError("terminal_failed");
  }
}
