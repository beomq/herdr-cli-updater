---
slug: update-first-console-ux
status: reviewed
intent: clear
review_required: true
plan_path: .omo/plans/update-first-console-ux.md
plan_sha256: 56f44c93e9e54dc0af50eaba4f1db58ab2ea34040ff1df2e90233b5fd5cffa55
review_round_id: ux-review-2
review_round_limit: 5
pending-action: deliver approved plan; execution requires separate user request
review:
  plan_reviewer:
    status: approved
    workspace_root: /Users/<user>/Desktop/portfolio
    runtime_home: null
    target: .omo/plans/update-first-console-ux.md
    round_id: ux-review-2
    plan_sha256: 56f44c93e9e54dc0af50eaba4f1db58ab2ea34040ff1df2e90233b5fd5cffa55
    launch_id: ux-review-launch-2
    session: st_01a13e25
    result: OKAY
approach: Update-first Console with distinct installation/session facts and targeted correctness fixes
---

# Draft: update-first-console-ux

## Affected user and ideal state
<!-- Who this output touches (a customer, another programmer, a program or agent consuming it - often more than one) and how each uses it today and will use it after. -->
<!-- IS-n | property of the ideal state: nothing snags, feels odd, regresses, or degrades for them | reason -->
<!-- GAP-n | difference between IS-n and today | reason | closed by todo(s) -->

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

## Findings (cited - path:lines)

## Decisions (with rationale)

## Scope IN

## Scope OUT (Must NOT have)

## Open questions

## Approval gate
status: approved
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->

## Grounded approach — 2026-10-15
- User approved plan writing and high-accuracy review through approval question. Complete plan now created; consultant review in flight, native plan-reviewer follows after findings integrated.
- Target repository: /Users/<user>/Desktop/herdr-cli-updater. Planning artifacts remain in portfolio/.omo; no product edits authorized by this plan request.
- Intent CLEAR; review_required true. User wants understandable update-first UX, not visual-only polish.
- Primary navigation proposal: Updates, Terminal sessions, History. Installation management and automation live in each CLI detail; Add CLI is explicit. Preserve global history for uncertain jobs and recovery.
- One installed CLI row, explicit Update affordance, separate latest check and exact reason when update cannot run. Preserve underlying engine/catalog identities and approval revisions; no wholesale protocol replacement.
- Installed version, latest source version, and running-session evidence are distinct. Unknown running version must not be called old or replaced with disk version. File-time inference must be labeled as inference.
- Installation update keeps sessions by default. Session restart is an explicit secondary action with supported capability, identity and idle-state checks. No new GJC/OpenCode resume implementation in this UX scope.
- New automation defaults to keep; existing explicit policies remain visible and unchanged. Legacy missing-policy semantics require an explicit migration decision in the plan, not silent reinterpretation.
- Manage shows update target, terminal default, installation locations and per-location removal as different operations. Multi-copy cleanup only for multiple installations. Preserve removal/provenance/active-consumer guards.
- Include functional defects essential to truthful UX: automatic updates require available (not merely unequal strings); OpenCode standalone latest query must match its official update channel; uncertain GJC/OMP jobs need bounded read-only reconciliation before retry, never blind replay.
- Owner decision (2026-10-15): support upstream Pi, not Senpi. Plan must verify upstream official package, discovery and latest/update sources, distinguish existing Senpi installations, and preserve existing Senpi data/sessions without automatic replacement or removal. This authorizes planning the change, not operating installation changes.

## Evidence and gap ledger
- Live dark desktop dashboard: seven installed CLIs, all latest unchecked; GJC/OMP checks disabled and progress/result shown. This is not seven confirmed network failures. Evidence: .omo/evidence/update-first-console-ux/dashboard-desktop.png.
- Install page mixes management, duplicate cleanup and removal history. Evidence: catalog-desktop.png in the same directory.
- Session page gives unverified running version next to engine version and repeated same-conversation restart prose. Mobile devotes most first screen to explanations and empty managed sessions. Evidence: sessions-desktop.png and sessions-mobile.png. No visual redesign QA claimed; light theme/detail dialogs were not captured in this baseline.
- web/catalog-dashboard.tsx:45-70: update review and confirm exist; update button is conditional; confirm keeps sessions. Therefore the gap is discoverability and recoverability, not absent update implementation.
- src/app/controller.ts:833-856: automation records latestResult but only skips installed===latest before plan/confirm; ahead/unknown must not update automatically.
- src/app/catalog-latest.ts:68-74,128: official target bypasses npm; no OpenCode switch branch. Official standalone latest path is incomplete.
- web/catalog-updates.tsx:61-63: keep-sessions prose conflicts with default restart-idle policy choice.
- Advisor capability matrix: seven catalog IDs; pane restart only omo/omp/pi/claude/codex. Capability is per installation source, not catalog membership. Advisors read code/tests but ran no tests or operational changes.
- Architect proposed two views and old-session counts; parent rejects hiding global recovery history and inferring exact old versions from file timestamps alone.

## Verification to require in the execution plan
State-table tests for unchecked/checking/current/available/ahead/unknown/failed/unsupported; automation cannot downgrade; source-bound OpenCode latest; selected installation changes invalidate review; uncertain results reconcile without rerunning installer; unsupported sessions remain terminal-only; removal guards and session preservation remain intact. Run existing tests/typecheck/build once per meaningful increment. Actual desktop/mobile light/dark UI QA including keyboard, failures, management and confirmation. Real installation mutations and deployment require separate authority; fixture success is not seven-CLI operational certification.

## Review convergence ledger
- Round 1: st_01a13e21, REJECT; source digest d4ec8e9e089f4fdf7e2cf160367728ebb340e5645740562650b94b6d60eefaf7 verified unchanged at completion. IS/QA coverage satisfied; no design contradiction found.
- Accepted blockers: B1 incorrect consolidation doc path; B2 incorrect generated CLI page path. Both corrected to verified existing locations, no scope changes. Ledger frozen; subsequent review checks closure and regressions only, plus newly eligible blockers.
- Non-blocking notes: none. Review budget: 1/5 used.
- Round 2: st_01a13e25, OKAY; approved digest 56f44c93e9e54dc0af50eaba4f1db58ab2ea34040ff1df2e90233b5fd5cffa55. Both reference blockers closed; IS-1–7 mapped and executable. No tests/builds run by reviewer. Review budget: 2/5 used; no open blockers.
