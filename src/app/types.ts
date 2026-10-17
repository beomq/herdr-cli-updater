import type { Installation, InstallSelection, Job, SelectionMetadata, TargetSelection } from "../protocol";
import type { CatalogEntry, CatalogId, InstallJob } from "./catalog-types";
import type { RemovalJob } from './catalog-removal';
import type { CatalogUpdateJob } from './catalog-updates';
import type { CatalogDefaultJob } from './catalog-default-jobs';
import type { PaneRestartJob } from './pane-restart';
import type { CatalogBulk } from './catalog-bulk';
import type { OfficialMethod } from './catalog-official';

/** Public web data. No worker credentials, executable commands or private grants. */
export type ManagedSession = {
  readonly id: string;
  readonly installationId: string;
  readonly cwd: string;
  readonly generation: number;
  readonly pid: number | null;
  readonly state: "starting" | "ready" | "working" | "waiting" | "stopping" | "stopped" | "restarting" | "failed" | "unknown";
  readonly launchedVersion: string | null;
  readonly engineVersion: string | null;
  readonly durableSessionId: string | null;
  readonly updatedAt: number;
  readonly failure: string | null;
  readonly output: readonly string[];
  readonly approval: {
    readonly id: string;
    readonly method: "confirm" | "select" | "input" | "editor";
    readonly title: string;
    readonly options: readonly string[];
  } | null;
};
export type ExternalSession = {
  readonly origin?: 'herdr'|'chatgpt'|'vscode'|'terminal'|'background';
  readonly id: string;
  readonly pid: number;
  readonly family?: string;
  readonly tty?: string | null;
  readonly startedAt?: string | null;
  readonly installationId: string | null;
  readonly executable: string;
  /** Exact unique catalog executable match; confers no engine capability. */
  readonly catalogId?: CatalogId | null;
  readonly cwd: string | null;
  readonly runningVersion: string | null;
  /** Engine version from a live TUI's PID/start-validated registration, not the OmO package version. */
  readonly runningEngineVersion?: string | null;
  readonly omoActivity?: "working" | "blocked" | "idle" | "unknown";
  readonly omoSocket?: string;
  /** started-after-install: the process started after the package directory was last written, so the
   * disk version is the loaded one. started-before-install: the package changed after launch; the
   * loaded version is older than disk and unknown. unknown: no start time or no package. */
  readonly runningVersionEvidence?: 'launch-environment' | 'started-after-install' | 'started-before-install' | 'unknown';
  readonly diskPackage?: { readonly name: string; readonly version: string; readonly installedAt: number } | null;
  readonly processState?: "observed" | "exited" | "unknown";
  readonly observedAt?: number;
  readonly conversation?: { readonly id: string; readonly title: string | null; readonly path: string } | null;
  readonly isCurrentConversation?: boolean;
  readonly parentCliPid?: number;
  /** screenIdle: the pane's recent screen ends at an input prompt with no working spinner
   * (null when the screen was not readable). cpuPercent: CPU use of this pid between the last
   * two observations (null until two samples exist). Both are hints, never a reason to kill. */
  readonly herdrPane?: {
    readonly screenIdle?: boolean | null;
    readonly cpuPercent?: number | null;
    /** true only after two consecutive observations under the quiet limit. */
    readonly cpuQuiet?: boolean | null;
    readonly paneId: string;
    readonly status: "idle" | "working" | "blocked" | "done" | "unknown";
    readonly stateChangeSeq: number;
  } | null;
  readonly control: "observation-only" | "herdr-pane";
};
export type PaneSessionPolicy = "keep" | "restart-idle" | "restart-all";
export type PaneRestartResult = {
  readonly sessionId: string;
  readonly paneId: string;
  readonly outcome: "pending" | "completed" | "failed" | "skipped-working" | "skipped-blocked";
  readonly failure: string | null;
  readonly previousPid: number;
  readonly resumedPid: number | null;
};
export type UpdatePolicy = {
  readonly catalogBinding?: string | undefined;
  readonly installationId: string;
  readonly mode: "off" | "check" | "update" | "update-and-restart";
  readonly intervalMinutes: number;
  readonly firstCheck?: "now" | "after-interval";
  /** How herdr-pane sessions on this installation are handled after an update. */
  readonly paneSessions?: PaneSessionPolicy;
  readonly lastCheckedAt: number | null;
  readonly nextCheckAt: number | null;
  readonly waitingReason: string | null;
  /** Installed version seen at the last check; a later difference means an install happened outside this app. */
  readonly lastInstalledVersion?: string | null | undefined;
  /** When the app last reset the worker's pin baseline for this catalog (see catalog-rebaseline.ts). */
  readonly lastRebaselineAt?: number | null | undefined;
};
export type AppOperation = {
  readonly id: string;
  readonly requestId: string;
  readonly installationId: string;
  readonly kind: "prepare" | "update" | "stop" | "restart" | "native-restart";
  readonly stage: "preparing" | "ready" | "waiting" | "stopping" | "updating" | "verifying" | "restarting"
    | "completed" | "failed" | "uncertain" | "cancelled";
  readonly revision: number;
  readonly targetVersion: string | null;
  readonly beforeVersion: string | null;
  readonly installedVersion: string | null;
  /** Time this service verified installation success, independent of session restart. */
  readonly installedAt?: number | null;
  readonly sessionIds: readonly string[];
  /** External sessions observed on this installation at confirmation. They keep their
   * launched version until their own restart; the updater never stops them. */
  readonly externalSessionIds?: readonly string[];
  readonly paneSessions?: PaneSessionPolicy;
  readonly paneResults?: readonly PaneRestartResult[];
  readonly restart: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly failure: string | null;
  readonly detail: string | null;
  readonly jobId: string | null;
};
export type AppSnapshot = {
  readonly native?: {
    readonly selections: readonly SelectionMetadata[];
    readonly jobs: readonly Job[];
    readonly failure: string | null;
  };
  readonly serverInstance?:string;
  readonly host?: { readonly platform:string; readonly arch:string; readonly wsl:boolean };
  readonly revision: number;
  readonly service: "ready" | "connecting" | "unavailable";
  readonly installations: readonly Installation[];
  readonly managed: readonly ManagedSession[];
  readonly external: readonly ExternalSession[];
  readonly observedAt?: number | null;
  readonly observationFailure?: string | null;
  readonly operations: readonly AppOperation[];
  readonly policies: readonly UpdatePolicy[];
  readonly catalog?: readonly CatalogEntry[];
  readonly installJobs?: readonly InstallJob[];
  readonly removalJobs?: readonly RemovalJob[];
  readonly catalogUpdates?: readonly CatalogUpdateJob[];
  readonly catalogBulk?: CatalogBulk|undefined;
  readonly defaultJobs?: readonly CatalogDefaultJob[];
  readonly paneRestarts?: readonly PaneRestartJob[];
  readonly failure: string | null;
};
export type AppCommand =
  | { readonly kind: "refresh" }
  | { readonly kind: "native-restart"; readonly installation: InstallSelection; readonly target: TargetSelection }
  | { readonly kind:'automation'; readonly installationId:string; readonly enabled:boolean; readonly paneSessions?:PaneSessionPolicy|undefined }
  | { readonly kind:'catalog-select';readonly catalogId:CatalogId;readonly installationId:string;
    readonly reviewed?:{readonly path:string;readonly identityPath:string;readonly version:string;readonly makeDefault:boolean}|undefined }
  | { readonly kind:'default-plan';readonly catalogId:CatalogId;readonly installationId:string }
  | { readonly kind:'default-confirm';readonly jobId:string;readonly revision:number }
  | { readonly kind: "catalog-update-plan"; readonly catalogId: CatalogId }
  | { readonly kind: "catalog-check"; readonly catalogId: CatalogId }
  | { readonly kind: "catalog-check-all" }
  | { readonly kind: "catalog-update-all-plan" }
  | { readonly kind: "catalog-update-all-confirm"; readonly batchId:string; readonly revision:number }
  | { readonly kind: "catalog-update-confirm"; readonly jobId:string; readonly revision:number; readonly paneSessions?:PaneSessionPolicy|undefined }
  | { readonly kind: "catalog-update-recover"; readonly jobId:string; readonly revision:number; readonly action:'reconcile'|'archive-unverified' }
  | { readonly kind: "install-plan"; readonly catalogId: CatalogId;readonly method?:OfficialMethod|undefined;readonly makeDefault?:boolean|undefined }
  | { readonly kind: "install-confirm"; readonly jobId: string; readonly revision: number }
  | { readonly kind: "install-recover"; readonly jobId:string; readonly revision:number; readonly action:'inspect'|'archive' }
  | { readonly kind: "remove-plan"; readonly catalogId: CatalogId;readonly installationId?:string|undefined }
  | { readonly kind: "remove-confirm"; readonly jobId: string; readonly revision: number }
  | { readonly kind: "check"; readonly installationId: string }
  | { readonly kind: "prepare"; readonly installationId: string }
  | { readonly kind: "confirm"; readonly operationId: string; readonly revision: number;
      readonly sessions: readonly { readonly id: string; readonly generation: number }[]; readonly restart: boolean;
      readonly paneSessions?: PaneSessionPolicy | undefined }
  | { readonly kind: "cancel"; readonly operationId: string; readonly revision: number }
  | { readonly kind: "launch"; readonly installationId: string; readonly cwd: string }
  | { readonly kind: "stop" | "restart"; readonly sessionId: string; readonly generation: number }
  | { readonly kind: "pane-restart"; readonly sessionId: string; readonly paneId: string; readonly trustScreen?: boolean | undefined }
  | { readonly kind: "send"; readonly sessionId: string; readonly generation: number; readonly message: string }
  | { readonly kind: "respond"; readonly sessionId: string; readonly generation: number;
      readonly approvalId: string; readonly value: string | boolean }
  | { readonly kind: "policy"; readonly installationId: string; readonly mode: UpdatePolicy["mode"];
      readonly intervalMinutes: number; readonly firstCheck?: "now" | "after-interval"; readonly paneSessions?: PaneSessionPolicy | undefined };
export type CommandEnvelope = { readonly requestId: string; readonly command: AppCommand };
export type AppResponse =
  | { readonly ok: true; readonly snapshot: AppSnapshot }
  | { readonly ok: false; readonly error: string; readonly snapshot: AppSnapshot };

export class AppError extends Error {
  constructor(readonly code: "invalid_request" | "unauthorized" | "not_found" | "conflict" | "busy" | "unsupported"
    | "unavailable" | "timeout" | "protocol" | "uncertain" | "source_changed" | "cleanup_failed",
    readonly detail: string = code) {
    super(detail);
    this.name = "AppError";
  }
}
