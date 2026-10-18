---
slug: herdr-cli-updater
status: reviewed
intent: clear
review_required: true
plan_path: .omo/plans/herdr-cli-updater.md
plan_sha256: 3cbe007d79794b6402499f758e7c55c15eb1eb112da99dcec6b5cf1292dca04f
review_round_id: herdr-cli-updater-replan-r2
review_round_limit: 5
pending-action: none; planning complete, implementation requires separate execution
review:
  plan_reviewer:
    status: approved
    workspace_root: /Users/beomseok/Desktop/portfolio
    runtime_home: /Users/beomseok/.omo/agent
    target: .omo/plans/herdr-cli-updater.md
    round_id: herdr-cli-updater-replan-r2
    plan_sha256: 3cbe007d79794b6402499f758e7c55c15eb1eb112da99dcec6b5cf1292dca04f
    launch_id: st_01a0fd64
    session: agent://st_01a0fd64
    result: OKAY
approach: Independent plugin and TUI with install-aware adapters, durable jobs, verified safe restart fence and exact-session restoration; minimal upstream web-ui integration after plugin verification.
---

# Draft: herdr-cli-updater

## Affected user and ideal state
IS-1 | Terminal users select installed CLI updates without opening another UI; installed and running version facts are separate.
IS-2 | Current work is never interrupted; exactly the same conversation, cwd, options and pane are resumed only after verified completion.
IS-3 | Terminal UI and later upstream web-ui contribution consume one independent plugin contract; closing UI does not cancel durable jobs.
IS-4 | Eight CLI families are represented honestly by capability: supported operations vs missing/unknown guarantees.
GAP-1 | Proposed commands and pane restart semantics remain unverified; read installed help and source before choosing implementation.
<!-- Who this output touches (a customer, another programmer, a program or agent consuming it - often more than one) and how each uses it today and will use it after. -->
<!-- IS-n | property of the ideal state: nothing snags, feels odd, regresses, or degrades for them | reason -->
<!-- GAP-n | difference between IS-n and today | reason | closed by todo(s) -->

## Components (topology ledger)
C1 | Independent herdr plugin and TUI workflow | active | local herdr CLI and web-ui manifest research
C2 | Eight CLI install/update/resume adapters | active | official contracts research
C3 | Durable update/restart state machine with herdr pane bindings | active | herdr source contract research
C4 | Minimal upstream herdr-web-ui consumer PR | deferred until plugin verified | /Users/beomseok/Desktop/herdr-web-ui
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

## Open assumptions (announced defaults)
macOS-first local execution is the default for the first validated artifact; cross-platform claims require explicit evidence.
Unknown busy/completion/resume identity means preserve session and expose unsupported operation, never infer idle from silence.
Public PR creation and any live CLI update/restart are outside this planning request.
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

## Findings (cited - path:lines)
### herdr mechanisms/gaps matrix
| Mechanism | Confirmed evidence | Missing guarantee / plan task |
| --- | --- | --- |
| Plugin lifetime | herdr-web-ui/scripts/plugin.ts:1-16,143-164 one-shot startup, detached worker, explicit socket | durable job ownership separate; task2,9 |
| Pane binding | server/herdr/client.ts:10-25,142-154,219-284 explicit socket/pane; schema process identity optional | immutable launch generation/argv completeness; task1,3,7 |
| Completion | server/completion.ts:8-25,80-103 display done/idle | no root/tools/subagent-drained guarantee; task1,7 |
| Input exclusion | local pane send-text/run/agent.start help | no atomic completion claim+all-input fence established; task1,7 |
| Event recovery | server/collector.ts:18-38,151-180; collector.test.ts:446-510 | missed exit not inferable; task7,9 |
| Same-pane launch | agent.start help shell prompt readiness, omo absent enum | exact-session launch and graceful old-root shutdown; task1,10 |
| Shared update | OmO update help pinned Senpi, real package identity | install ownership/locks across sockets; task3,8,9 |

Eight CLI matrix (research nodes completed; exact local help supplemented by parent):

| CLI | Actual identity/update | Exact resume | Safe completion |
| --- | --- | --- | --- |
| omo | omo5.1.9, `omo update`, pinned Senpi engine | `--session <full path>` from local help | no safe restart fence verified |
| omp | @oh-my-pi/pi-coding-agent17.1.8, `omp update`; can1357/oh-my-pi/docs/cli-reference.md | `--resume=<full path>` | no safe restart fence verified |
| pi | local Senpi2026.10.1-3, ownership shared with omo; standalone upstream Pi is different | `--session <full path>` from local help | no safe restart fence verified |
| claude | Claude Code; installation-specific `claude update`/native/package manager | `--resume <exact ID>` | lifecycle hooks exist, shutdown fence unverified |
| codex | codex-cli0.156.0; local `update` exists, official install-specific upgrade | `resume <UUID>` no prompt | app-server events not universal interactive safe-exit proof |
| agy | Google Antigravity CLI, user confirmed; local binary1.2.12. Official native installer supports install/upgrade to ~/.local/bin/agy | `--conversation <conversation-id>` verified in official resume docs and local help | safe post-turn restart fence unverified |
| cursor | Cursor CLI `agent update`; local `cursor` absent, agent PATH currently Grok alias | explicit actual Cursor binary `--resume=<chat-id>` | unknown |
| grok | Grok Build1.0.46, xai-org/grok-build; `grok update` | `--resume <UUID>` | /exit documented; post-turn fence unverified |

Official evidence: https://github.com/can1357/oh-my-pi/blob/3b003d878c1c5e260e23b34dac4ceb3c967ecc94/docs/cli-reference.md ; https://github.com/code-yeongyu/senpi/blob/b39f9d46f0c1aa49527372d662064ceba717a241/packages/coding-agent/docs/sessions.md ; https://code.claude.com/docs/en/cli-reference ; https://developers.openai.com/codex/cli ; https://cursor.com/docs/cli/installation.md ; https://cursor.com/docs/cli/overview.md ; https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md .
`omo update --help` explicitly: engine pinned by omo and moves with it; supported flags --dry-run/--print. Therefore OmO and local Senpi pi may share installation dependencies; adapters must group installation/update ownership and detect version drift instead of independently upgrading pinned engine.
Actual plugin TUI entry is `herdr plugin pane open --plugin <ID> --entrypoint <ID> --placement overlay --focus`; documented help supports overlay/split/tab/zoomed. Proposed `herdr cli-updater` command is not real and should not appear as available usage.
`codex resume --help`: positional SESSION_ID accepts UUID or name; use full UUID only. Do not pass optional PROMPT because it starts a new turn during restoration.
Local herdr0.9.1 help: `agent start <NAME> --kind <KIND> --pane <ID> -- [AGENT_ARG]...` requires interactive shell prompt; readiness means expected agent detected in same terminal. Kind list includes omp/pi/claude/codex/cursor/agy/grok but NOT omo. This invalidates treating all8 as identical supported agent.start kinds.
Local `pane run <PANE_ID> <COMMAND>...` exists, but help alone does not prove argv-preserving safe launch, graceful exit or atomic idle claim; implementation must inspect protocol/source or require core support rather than guess.
Bundled `herdr api schema --json` parses successfully via full stdout stream. AgentSessionInfo requires source/agent/kind/value. PaneProcessInfo exposes tty, shell_pid, foreground process group; processes expose optional argv/cwd. Session identity and launch information can be missing, so fail-closed capability states are required.
Raw status is NOT a certified safe shutdown boundary: /Users/beomseok/Desktop/herdr-web-ui/server/completion.ts:8-25 documents omo child processes changing pi/working to claude/unknown/idle; UI-derived done cannot serve as safe completion proof.
`pi` PATH actually resolves @code-yeongyu/senpi2026.10.1-3, not upstream Pi. `omp` resolves @oh-my-pi/pi-coding-agent17.1.8 / can1357/oh-my-pi. Adapter identity must use real install package/executable, not command name.
Local actual help supports omo --session path|id; omp --resume=<value>; agy --conversation; codex resume; grok --resume session UUID/title. Exact immutable identifiers must be supplied, not recent-session/picker/title or create-if-missing flags.
Source history: web-ui HEAD01290a4 fixes status change during subscription reopen (#291), showing event/snapshot races must be tested.
Installed herdr path /Users/beomseok/.local/bin/herdr. Actual plugin actions use manifest argv arrays, not invented `herdr cli-updater` syntax: /Users/beomseok/Desktop/herdr-web-ui/herdr-plugin.toml.
Local web-ui HEAD 01290a4; user untracked .worktrees/ and omo-pane-icons-pr.md preserved.
Local PATH provides omo/omp/pi/claude/codex/agy/grok; `cursor` command absent. Exact family identities still under official help research.
Repository /Users/beomseok/Desktop/portfolio is not git; planning artifact location only.

## Decisions (with rationale)
User compared omo-webchat restart. Source at commit372a0bb confirms owned shared OmO RPC engine replacement, active chat warning not finish-wait, SIGTERM→SIGKILL. Compare sources internal/api/system_restart.go:21-55, internal/omorpc/restart.go:31-53, internal/omorpc/ensure_supervisor_unix.go:34-75. Read-only source/test comparison, no runtime execution. Patterns of ownership/install-runtime separation reusable; interruption semantics conflict with requested busy-work preservation.
User confirmed agy is Antigravity on 2026-10-02. Official sources now verified: https://antigravity.google/docs/cli/install and https://antigravity.google/docs/cli/commands/resume . The installer matches local ~/.local/bin/agy. Explicit conversation ID required; -c can silently start a fresh conversation if missing/deleted, so it is excluded from automatic restoration.
Proposed test strategy awaiting approval: tests-first for restart state transitions/races and adapter command construction; integration and actual TUI QA on isolated test panes. Never use live operational subscriptions as test fixtures. No timing-based sleeps; subscribe before triggering events with bounded timeouts.
Proposed deliverable gate: all eight CLI families represented, but automatic restart is enabled per adapter only after exact session binding, trustworthy completion fence, new-input exclusion, graceful shutdown and same-pane restoration are verified. Missing prerequisites remain explicit blockers; a discovery-only row does not count as completed automatic restart support.
Correct prior design: install-version vs runtime-version cannot be inferred from version executed after update; track only captured runtime launch evidence or unknown.
Use a separately supervised plugin worker per local update installation, durable queued jobs, snapshot reconciliation; plugin startup hooks are one-shot, not supervised daemons (scripts/plugin.ts:1-10,143-164).
Same-installation update serialization must span herdr session/socket instances; per-socket lock alone would permit duplicate global CLI updates.
Intent CLEAR: user specified workflow and confirmed independent plugin-first / upstream PR-later boundaries. Review required as requested.
Use parallel read-only explore (herdr/web-ui) and librarian (eight CLI contracts); parent synthesis. No product edits.

## Scope IN
Reassess update check, selection, update-only vs safe restart, immediate idle / queued busy restarts, exact resume and failure recovery; produce approval summary then approved plan and review.

## Scope OUT (Must NOT have)
No actual CLI update, pane exit/relaunch, product implementation, new web-ui product, or PR sending in this run. Do not modify company projects or live operational listeners.

## Open questions
agy identity resolved by user and official sources. No remaining product identity question.
Before final plan approval, announce four components and dependency gate: trusted completion+new-input freeze+exact binding required before claiming automatic queued restart; herdr core change may be necessary and cannot be hidden inside web-ui PR.
Only genuine owner decisions surviving source research will be asked; source-answerable mechanisms are not user questions.

## Approval gate
status: approved-for-plan
User selected "계획·리뷰 진행 (Recommended)" through request_user_input on 2026-10-02. Four components and tests-first strategy approved. This authorizes plan creation and canonical review only, not updater implementation, live updates/restarts, commits or PR transmission.
Consultant st_01a0fb77 completed: atomic completion/input fence is a distinct herdr prerequisite, shared-install dedup must cross sockets, exact launch restoration and failure recovery require tests. No further owner questions.
New independent explicit Discord request1555477711953203221 authorizes installation of omo-discord-question-patch, delegated st_01a0fb78; this is not updater product implementation and does not alter this plan scope.
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
