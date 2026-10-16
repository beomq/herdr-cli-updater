import { expect, test } from "bun:test";
import type { HerdrPaneAgent, HerdrPaneClient } from "../../src/app/herdr-panes";
import { parseResumeId, restartInPane } from "../../src/app/pane-restart";
import type { PaneRestartJob } from "../../src/app/pane-restart";
import type { ExternalSession } from "../../src/app/types";

const session: ExternalSession = { id: "external:300:t", pid: 300, family: "omo", installationId: null, executable: "/bin/omo",
  cwd: "/work", runningVersion: null, control: "herdr-pane", herdrPane: { paneId: "w1:p1", status: "idle", stateChangeSeq: 5 } };

function fakePane(script: {
  status?: HerdrPaneAgent["status"]; waitStatus?: HerdrPaneAgent["status"] | null; exitPrints?: string;
  exitsAfterSends?: number; resumedPid?: number | null; foregroundNow?: number[]; paneAgent?: string;
  screen?: string; trustScreen?: boolean; cpuPercent?: number | null;
}) {
  const calls: string[] = [];
  let pids = script.foregroundNow ?? [300];
  let sends = 0;
  const agent = (status: HerdrPaneAgent["status"]): HerdrPaneAgent => ({ paneId: "w1:p1", workspaceId: "w1", terminalId: "t",
    agent: script.paneAgent ?? "pi", status, stateChangeSeq: 6, cwd: "/work", title: null, foregroundPids: pids });
  const client: HerdrPaneClient = {
    socketPath: "/fake",
    agents: async () => [agent(script.status ?? "idle")],
    agent: async () => { calls.push("agent"); return agent(sends >= 2 ? "idle" : script.status ?? "idle"); },
    foregroundPids: async () => { calls.push("pids"); return pids; },
    read: async () => { calls.push("read"); return sends === 0 ? (script.screen ?? "") : (script.exitPrints ?? ""); },
    sendLine: async (_pane, line) => {
      calls.push(`send:${line}`); sends++;
      if (sends === (script.exitsAfterSends ?? 1)) pids = [];
      if (line.startsWith("omo --session")) pids = script.resumedPid === null ? [] : [script.resumedPid ?? 301];
    },
    wait: async (_pane, until) => {
      calls.push(`wait:${until.join("|")}`);
      if (sends >= 2) return script.resumedPid === null ? null : agent("idle");
      return script.waitStatus === null ? null : agent(script.waitStatus ?? "idle");
    },
  };
  return { client, calls };
}
async function run(script: Parameters<typeof fakePane>[0], overrides: Partial<ExternalSession> = {}) {
  const { client, calls } = fakePane(script);
  const stages: string[] = [];
  let now = 0;
  const job = await restartInPane({ herdr: client, session: { ...session, ...overrides }, now: () => (now += 50), initialSeq: 5,
    exitTimeoutMs: 1_000, resumeTimeoutMs: 1_000, isAlive: pid => pid !== 300, pause: async () => {},
    publish: (job: PaneRestartJob) => stages.push(job.stage),
    ...(script.trustScreen ? { trustScreen: true } : {}), cpuPercent: () => script.cpuPercent ?? null });
  return { job, calls, stages };
}

test("parseResumeId takes the last printed resume hint per family and rejects shell metacharacters", () => {
  expect(parseResumeId("omo", "x\nTo resume this session: omo --session 01a1300b-f131-7cf3-a037-7bf50e61a5f4\n")).toBe("01a1300b-f131-7cf3-a037-7bf50e61a5f4");
  expect(parseResumeId("codex", "codex resume 01a1300b-f131-7cf3-a037-7bf50e61a5f4")).toBe("01a1300b-f131-7cf3-a037-7bf50e61a5f4");
  expect(parseResumeId("omp", "omp --resume=/tmp/s.jsonl;rm -rf /")).toBeNull();
  expect(parseResumeId("omo", "nothing here")).toBeNull();
});

test.each(['pi','senpi','gjc','opencode','qwen','custom-cli'])('observing %s never grants pane restart input',async family=>{
  const {client,calls}=fakePane({});
  await expect(restartInPane({herdr:client,session:{...session,family},now:()=>0,initialSeq:5,isAlive:()=>true,publish:()=>{}})).rejects.toThrow('pane_restart_unsupported');
  expect(calls).toEqual([]);
});

test("idle agent: exit, read resume id, resume in the same pane, new pid observed", async () => {
  // Given / When
  const { job, calls, stages } = await run({ exitPrints: "To resume this session: omo --session 01a1300b-f131-7cf3-a037-7bf50e61a5f4" });
  // Then
  expect(job).toMatchObject({ stage: "completed", previousPid: 300, resumedPid: 301, resumeId: "01a1300b-f131-7cf3-a037-7bf50e61a5f4", failure: null });
  expect(stages).toEqual(["waiting-idle", "exiting", "resuming", "completed"]);
  expect(calls.filter(call => call.startsWith("send:"))).toEqual(["send:/exit", "send:omo --session 01a1300b-f131-7cf3-a037-7bf50e61a5f4"]);
});

test("working agent: waits for the server's idle transition before sending exit", async () => {
  const { job, calls } = await run({ status: "working", waitStatus: "idle", exitPrints: "omo --session 01a1300b-f131-7cf3-a037-7bf50e61a5f4" });
  expect(job.stage).toBe("completed");
  expect(calls.indexOf("wait:idle|done|blocked")).toBeLessThan(calls.indexOf("send:/exit"));
});

test("blocked agent, idle timeout, exit not observed and missing resume id each fail without resuming", async () => {
  expect((await run({ status: "blocked" })).job).toMatchObject({ stage: "failed", failure: "agent_blocked" });
  expect((await run({ status: "working", waitStatus: null })).job).toMatchObject({ stage: "failed", failure: "idle_wait_timeout" });
  const stuck = await run({ exitsAfterSends: 99 });
  expect(stuck.job).toMatchObject({ stage: "failed", failure: "exit_not_observed" });
  expect(stuck.calls.filter(call => call.startsWith("send:"))).toEqual(["send:/exit"]);
  expect((await run({ exitPrints: "goodbye" })).job).toMatchObject({ stage: "failed", failure: "resume_id_not_found" });
});

test("trusting the screen restarts a stuck-working pane without waiting when the prompt is visible and the pid is quiet", async () => {
  const { job, calls } = await run({ status: "working", waitStatus: null, trustScreen: true, cpuPercent: 0.3, screen: "done\n──\n❯\n──\nstatus", exitPrints: "omo --session 0f0f0f0f-0000-4000-8000-000000000001" });
  expect(job).toMatchObject({ stage: "completed", resumedPid: 301 });
  expect(calls.some(call => call.startsWith("wait"))).toBe(false);
});

test("trusting the screen is refused while the pid is still computing or the screen shows work", async () => {
  const busy = await run({ status: "working", trustScreen: true, cpuPercent: 42, screen: "❯" });
  expect(busy.job).toMatchObject({ stage: "failed", failure: "screen_not_idle" });
  expect(busy.calls.some(call => call.startsWith("send:"))).toBe(false);
  const spinning = await run({ status: "working", trustScreen: true, cpuPercent: 0, screen: "── ⠋ Working ──\n❯" });
  expect(spinning.job).toMatchObject({ stage: "failed", failure: "screen_not_idle" });
  const unknownCpu = await run({ status: "working", trustScreen: true, cpuPercent: null, screen: "❯" });
  expect(unknownCpu.job).toMatchObject({ stage: "failed", failure: "screen_not_idle" });
});

test("a pane whose agent is a different CLI is refused before any input", async () => {
  const { job, calls } = await run({ paneAgent: "claude" });
  expect(job).toMatchObject({ stage: "failed", failure: "pane_agent_mismatch" });
  expect(calls.some(call => call.startsWith("send:"))).toBe(false);
});

test("a pane whose foreground no longer holds the session pid is refused before any input", async () => {
  const { job, calls } = await run({ foregroundNow: [999] });
  expect(job).toMatchObject({ stage: "failed", failure: "pane_changed" });
  expect(calls.some(call => call.startsWith("send:"))).toBe(false);
});

test("OmO unknown activity refuses exit even when herdr and the screen claim idle", async () => {
  const { client, calls } = fakePane({ status: "idle", screen: "❯" });
  const job = await restartInPane({ herdr: client, session, now: () => 0, initialSeq: 5,
    isAlive: () => true, publish: () => {}, trustScreen: true, cpuPercent: () => 0,
    omoState: async () => "unknown" });
  expect(job.failure).toBe("session_activity_unverified");
  expect(calls.some(call => call.startsWith("send:"))).toBe(false);
});

test("OmO completion requires the same conversation on a new validated process", async () => {
  const id = "01a1300b-f131-7cf3-a037-7bf50e61a5f4";
  const original = { ...session, startedAt: "2026-10-01T00:00:00Z", conversation: { id, title: null, path: "/tmp/session.jsonl" } };
  const { client, calls } = fakePane({});
  let reads = 0;
  const job = await restartInPane({ herdr: client, session: original, now: () => 0, initialSeq: 5,
    isAlive: pid => pid !== 300, publish: () => {}, omoState: async () => "idle",
    observePane: async () => ++reads === 1 ? original : { ...original, pid: 301, startedAt: "2026-10-13T00:00:00Z", runningEngineVersion: "2026.10.12" } });
  expect(job).toMatchObject({ stage: "completed", resumedPid: 301, resumeId: id });
  expect(calls.filter(call => call.startsWith("send:"))).toEqual(["send:/exit", `send:omo --session ${id}`]);
});

test("OmO refuses a mismatched printed conversation rather than resuming it", async () => {
  const { client, calls } = fakePane({ exitPrints: "omo --session 00000000-0000-4000-8000-000000000001" });
  const original = { ...session, conversation: { id: "01a1300b-f131-7cf3-a037-7bf50e61a5f4", title: null, path: "/tmp/session.jsonl" } };
  const job = await restartInPane({ herdr: client, session: original, now: () => 0, initialSeq: 5,
    isAlive: pid => pid !== 300, publish: () => {}, omoState: async () => "idle" });
  expect(job.failure).toBe("resume_id_mismatch");
  expect(calls.filter(call => call.startsWith("send:"))).toEqual(["send:/exit"]);
});
