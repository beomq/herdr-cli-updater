import type { HerdrPaneAgent, HerdrPaneClient } from "./herdr-panes";
import { screenLooksIdle } from "./observations";
import { AppError } from "./types";
import type { ExternalSession } from "./types";
import type { OmoActivity } from "./omo-threads";

export type PaneRestartStage = "waiting-idle" | "exiting" | "resuming" | "completed" | "failed";
export type PaneRestartJob = {
  readonly id: string;
  readonly sessionId: string;
  readonly paneId: string;
  readonly family: "omo" | "omp" | "pi" | "claude" | "codex";
  readonly stage: PaneRestartStage;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly previousPid: number;
  readonly resumedPid: number | null;
  readonly resumeId: string | null;
  readonly failure: string | null;
};
type Family = PaneRestartJob["family"];

const exitCommand: Record<Family, string> = { omo: "/exit", pi: "/exit", omp: "/exit", codex: "/exit", claude: "/exit" };
const paneAgentFamilies: Readonly<Record<string, readonly Family[]>> = { pi: ["omo", "pi", "omp"], omo: ["omo"], omp: ["omp"], codex: ["codex"], claude: ["claude"] };
const paneAgentMatches = (agent: string | null, family: Family) => agent === null || (paneAgentFamilies[agent]?.includes(family) ?? false);
const resumePattern: Record<Family, RegExp> = {
  omo: /omo --session ([0-9a-f-]{36})/,
  pi: /pi --session ([0-9a-f-]{36})/,
  omp: /omp --resume=?\s?(\S+)/,
  codex: /codex resume ([0-9a-f-]{36})/,
  claude: /claude --resume ([0-9a-f-]{36})/,
};
function resumeCommand(family: Family, id: string): string {
  switch (family) {
    case "omo": return `omo --session ${id}`;
    case "pi": return `pi --session ${id}`;
    case "omp": return `omp --resume=${id}`;
    case "codex": return `codex resume ${id}`;
    case "claude": return `claude --resume ${id}`;
  }
}
export function parseResumeId(family: Family, screen: string): string | null {
  const matches = [...screen.matchAll(new RegExp(resumePattern[family].source, "g"))];
  const last = matches.at(-1)?.[1];
  return last && !/[\s"'`$;&|<>]/.test(last) ? last : null;
}

export type PaneRestartOptions = {
  readonly herdr: HerdrPaneClient;
  readonly session: ExternalSession;
  readonly now: () => number;
  readonly idleTimeoutMs?: number;
  readonly exitTimeoutMs?: number;
  readonly resumeTimeoutMs?: number;
  readonly isAlive: (pid: number) => boolean;
  readonly publish: (job: PaneRestartJob) => void;
  readonly initialSeq: number;
  readonly pause?: () => Promise<void>;
  /** A person judged the pane idle from its screen although herdr still reports working.
   * Honoured only when the screen really ends at a prompt and the pid is not computing. */
  readonly trustScreen?: boolean;
  readonly cpuPercent?: (pid: number) => number | null;
  readonly omoState?: (session: ExternalSession) => Promise<OmoActivity>;
  readonly observePane?: (paneId: string) => Promise<ExternalSession | null>;
};
export const trustScreenCpuLimit = 5;

/** Restart a CLI that runs inside a herdr pane the updater did not launch, using only
 * what a person would do at the keyboard: wait until the agent is idle, type its exit
 * command, read the resume ID it prints, and type the resume command in the same pane.
 * Nothing is killed; any step that cannot be observed fails the job honestly. */
export async function restartInPane(options: PaneRestartOptions): Promise<PaneRestartJob> {
  const { herdr, session } = options;
  if ((session.family!=='omo'&&session.family!=='omp'&&session.family!=='claude'&&session.family!=='codex') || !session.herdrPane) throw new AppError("unsupported", "pane_restart_unsupported");
  const family = session.family;
  const paneId = session.herdrPane.paneId;
  let job: PaneRestartJob = { id: crypto.randomUUID(), sessionId: session.id, paneId, family, stage: "waiting-idle",
    revision: 0, createdAt: options.now(), updatedAt: options.now(), previousPid: session.pid, resumedPid: null,
    resumeId: null, failure: null };
  const change = (fields: Partial<PaneRestartJob>) => {
    job = { ...job, ...fields, revision: job.revision + 1, updatedAt: options.now() };
    options.publish(job);
  };
  const fail = (failure: string) => { change({ stage: "failed", failure }); return job; };
  const pause = options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 250)));
  options.publish(job);

  const before = await herdr.agent(paneId);
  if (!before || !before.foregroundPids.includes(session.pid)) return fail("pane_changed");
  if (!paneAgentMatches(before.agent, family)) return fail("pane_agent_mismatch");
  if (before.stateChangeSeq < options.initialSeq) return fail("pane_changed");
  if (family === "omo" && options.observePane) {
    const current = await options.observePane(paneId);
    if (!current || current.pid !== session.pid || !session.startedAt || current.startedAt !== session.startedAt
      || !session.conversation || current.conversation?.id !== session.conversation.id) return fail("session_binding_changed");
  }
  let agent: HerdrPaneAgent | null = before;
  if (agent.status === "blocked") return fail("agent_blocked");
  if (family === "omo" && options.omoState) {
    let activity = await options.omoState(session);
    if (activity === "blocked") return fail("agent_blocked");
    if (activity === "working") {
      agent = await herdr.wait(paneId, ["idle", "done", "blocked"], options.idleTimeoutMs ?? 30 * 60_000);
      if (!agent) return fail("idle_wait_timeout");
      if (!agent.foregroundPids.includes(session.pid)) return fail("pane_changed");
      activity = await options.omoState(session);
    }
    if (activity === "blocked") return fail("agent_blocked");
    if (activity !== "idle") return fail("session_activity_unverified");
  } else if ((agent.status === "working" || agent.status === "unknown") && options.trustScreen) {
    const cpu = options.cpuPercent?.(session.pid) ?? null;
    if (!screenLooksIdle(await herdr.read(paneId)) || cpu === null || cpu > trustScreenCpuLimit) return fail("screen_not_idle");
  } else if (agent.status === "working" || agent.status === "unknown") {
    agent = await herdr.wait(paneId, ["idle", "done", "blocked"], options.idleTimeoutMs ?? 30 * 60_000);
    if (!agent) return fail("idle_wait_timeout");
    if (agent.status === "blocked") return fail("agent_blocked");
    if (!agent.foregroundPids.includes(session.pid)) return fail("pane_changed");
  }

  change({ stage: "exiting" });
  await herdr.sendLine(paneId, exitCommand[family]);
  const exitDeadline = options.now() + (options.exitTimeoutMs ?? 20_000);
  let exited = false;
  for (;;) {
    const pids = await herdr.foregroundPids(paneId);
    if (!pids.includes(session.pid) && !options.isAlive(session.pid)) { exited = true; break; }
    if (options.now() >= exitDeadline) break;
    await pause();
  }
  if (!exited) return fail("exit_not_observed");
  const screen = await herdr.read(paneId);
  const printedId = parseResumeId(family, screen);
  const knownId = family === "omo" ? session.conversation?.id : undefined;
  if (knownId && !/^[0-9a-f-]{36}$/.test(knownId)) return fail("resume_id_not_found");
  if (knownId && printedId && knownId !== printedId) return fail("resume_id_mismatch");
  const resumeId = knownId ?? printedId;
  if (!resumeId) return fail("resume_id_not_found");

  change({ stage: "resuming", resumeId });
  await herdr.sendLine(paneId, resumeCommand(family, resumeId));
  const resumeDeadline = options.now() + (options.resumeTimeoutMs ?? 60_000);
  let resumedPid: number | null = null;
  for (;;) {
    const current = await herdr.agent(paneId);
    const candidate = current?.foregroundPids.find(pid => pid !== session.pid && options.isAlive(pid)) ?? null;
    if (current && candidate !== null && (current.status === "idle" || current.status === "done" || current.status === "working")) {
      if (family === "omo" && options.observePane) {
        const resumed = await options.observePane(paneId);
        if (resumed?.conversation && resumed.conversation.id !== resumeId) return fail("resume_id_mismatch");
        if (resumed && resumed.pid !== session.pid && resumed.startedAt && resumed.startedAt !== session.startedAt
          && resumed.conversation?.id === resumeId && resumed.runningEngineVersion) { resumedPid = resumed.pid; break; }
      } else { resumedPid = candidate; break; }
    }
    if (current?.status === "blocked") return fail("agent_blocked");
    if (options.now() >= resumeDeadline) break;
    await pause();
  }
  if (resumedPid === null) return fail("resume_not_observed");
  change({ stage: "completed", resumedPid });
  return job;
}
