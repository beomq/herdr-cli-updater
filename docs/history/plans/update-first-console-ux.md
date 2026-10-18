# update-first-console-ux - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**Who this is for and what changes for them:** herdr에서 CLI를 쓰는 사용자가 업데이트 가능 여부, 실패 이유, 다음 행동을 바로 이해하도록 바꾼다.

**What you'll get:** 업데이트 중심 첫 화면, 구분된 설치·최신·실행 버전, 명확한 설치 제거와 세션 재시작, 원본 Pi 지원. 자동 업데이트 비교 오류와 공식 설치 최신 조회 누락도 고친다.

**Why this approach:** 설치를 먼저 업데이트하고 실행 세션은 유지한다. 기존 안전 검증을 보존하면서 화면 흐름과 실제 오류를 함께 정리한다.

**What it will NOT do:** 운영 설치를 바꾸거나 세션을 종료하지 않는다. 기존 Senpi를 자동 교체·삭제하지 않고, 지원하지 않던 재시작 기능을 약속하지 않는다.

**Effort:** Large
<!-- Effort is exactly ONE band, never hours/days. Quick = single edit, minutes of agent work; Short = one focused change, a few files; Medium = multi-file feature in one session; Large = several waves, one long session; XL = multi-session or architectural work. A written duration is rewritten to a band. -->
**Risk:** High - 설치 출처, 저장된 자동화 정책과 실행 세션의 호환성을 함께 보존해야 한다.
**Decisions to sanity-check:** 원본 Pi 지원, 새 자동화 기본값은 세션 유지, 기존 정책 보존, 미확정 업데이트를 성공으로 바꾸지 않는 복구 절차.

Your next move: 계획 고정밀 검토가 승인되면 별도 실행 요청으로 구현을 시작한다. 아래는 실행 상세다.

---

> TL;DR (machine): Large; High risk; 9 implementation tasks, 4 final checks; update-first UX, source-correct updates, upstream Pi, no operational mutations.

## Scope
### Affected user and ideal state
<!-- From the draft ledger: who this touches and how they use the result, then one IS row per property with its reason, then one GAP row per difference with its reason. Every todo below closes a GAP row; ## Success criteria proves every IS row. -->
**Affected user:** herdr에서 여러 CLI를 쓰는 사용자. 업데이트 가능 여부와 실행 결과를 첫 화면에서 판단하고, 설치 관리와 실행 세션을 혼동하지 않아야 한다. 구현 대상 /Users/beomseok/Desktop/herdr-cli-updater, 계획·증거 위치 /Users/beomseok/Desktop/portfolio/.omo. 모든 아래 상대 소스 경로는 구현 대상 기준이다.

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | 첫 화면에서 업데이트와 불가 이유를 찾는다 | 핵심 제품 목적 |
| IS-2 | 설치·최신·실행 버전과 미확인 이유가 구분된다 | 잘못된 최신/구버전 확신 방지 |
| IS-3 | 설치 업데이트는 세션을 기본 유지하며 재시작은 별도다 | 대화·작업 보존 |
| IS-4 | 설치 대상·셸 기본값·제거 범위가 명확하다 | 잘못된 경로 변경 방지 |
| IS-5 | 조회·자동화·미확정 결과가 일관되고 복구 가능하다 | 실패를 성공으로 보이지 않음 |
| IS-6 | Pi는 원본이며 기존 Senpi와 구분된다 | 승인된 제품 정체성 |
| IS-7 | 지원 7종과 세션 전용 범위가 유지된다 | 범위와 기능 약속 일치 |
| GAP-1 | 업데이트 버튼과 작업 결과가 여러 화면에 분산 | IS-1; tasks 5,6,9 |
| GAP-2 | 미확인·엔진 버전·설치 버전 혼재 | IS-2; tasks 1,5,7 |
| GAP-3 | 자동화 설명은 세션 유지이나 기본값 restart-idle | IS-3; tasks 2,7 |
| GAP-4 | 단일 설치에도 정리 흐름, 기본값/대상 혼동 | IS-4; task 8 |
| GAP-5 | 자동화는 버전 불일치만 검사; OpenCode official 조회 누락; 미확정 작업 잠금 | IS-5; tasks 2,3,4,6 |
| GAP-6 | Pi 레이블이 Senpi 패키지를 가리킴 | IS-6; task 1 |
| GAP-7 | 7종 지원과 설치 방식/재시작 능력 차이가 불명확 | IS-7; tasks 1,5,7,9 |

### Must have
- 기본 화면 Updates, Terminal sessions, History. CLI 추가는 Updates의 명시적 진입점, 관리·자동화는 CLI 상세에 둔다. 기존 저장된 화면 키는 대응 화면으로 이동한다.
- 업데이트 버튼은 설치 카드에서 발견 가능하고 상태별 실행/차단 이유를 표시한다. latest 조회 전에는 조회를 안내하며 실패를 최신으로 표시하지 않는다.
- 기존 engine/catalog 명령과 revision·source·installation 검증을 보존한다. UI는 같은 CLI를 통합하되 실행 대상을 모호하게 합치지 않는다.
- 원본 Pi 선택 및 계획 작성·검토 승인: 2026-10-15. upstream README는 @earendil-works/pi-coding-agent를 안내한다. 과거 @mariozechner 이름을 현재 기본값으로 추측하지 않는다.
### Must NOT have (guardrails, anti-slop, scope boundaries)
- 운영 설치/삭제/업데이트, 세션 종료, 배포, npm 게시 없음. 계획 실행은 로컬 구현 및 격리 검증까지. 별도 운영 승인이 있어야 실제 변경한다.
- Senpi 기존 설치·대화·준비 작업을 Pi로 재명명하거나 자동 교체하지 않는다. herdr 밖 세션은 관리하지 않는다. 지원 ID는 기존 7개 유지.
- GJC/OpenCode 동일 대화 재시작 신규 개발, 백엔드 전체 통합, 권한·출처 가드 완화, 무관한 리팩터링 없음.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: existing Bun/jsdom tests, regressions first for behavior defects; implementation and associated test in same task. No sleep/poll-based tests, prose snapshots or weakened guards.
- E = /Users/beomseok/Desktop/portfolio/.omo/evidence/update-first-console-ux/execution. Each task writes task-N.md with command, exit code and assertions; UI captures task-N-{desktop,mobile}-{light,dark}.png. Do not put secrets or conversation content in receipts.
- Relevant tests per increment; final `bun test`, `bun run typecheck`, `bun run build`, `bun run build:site` with diagnostics before build. Use isolated TMPDIR/caches, monitors for runs, clean owned browser/server/cache afterward. Prior 547 passing tests are historical, not current proof.
- Read-only operating baseline already captured four PNGs in parent evidence folder. Execution QA uses fixture app with mocked command transport and real rendered browser; no operating API mutations. Fixture success does not certify seven real CLI installations.

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Wave 1: tasks 1–4 source/behavior foundations. Tasks 2 and 4 serialize shared controller edits; task 1 package changes precede task 3 final integration. Four cohesive tasks intentionally avoid splitting coupled state reasoning.
- Wave 2: tasks 5–9 UI, session and management integration. Assign a single owner for app.tsx/dashboard integration; tasks 7 and 8 can develop isolated components but must not edit shared integration concurrently. Task 9 follows integrated behavior.
- Final: F1–F4 evidence checks. Parent executes manual QA; one independent reviewer covers F1/F2/F4 rather than a costly review panel.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 3,5,7,9 | 2 |
| 2 | none | 4,5,7 | 1,3 |
| 3 | 1 | 5,6 | 2,4 |
| 4 | 2 | 6 | 3 |
| 5 | 1,2,3 | 6,7,8,9 | none (shared integration owner) |
| 6 | 4,5 | 9 | 7,8 in distinct files |
| 7 | 2,5 | 9 | 6,8 in distinct files |
| 8 | 5 | 9 | 6,7 in distinct files |
| 9 | 1–8 | F1–F4 | none |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. 원본 Pi 출처와 기존 Senpi 식별 분리
  Recommended task executor category: deep-low — package identity crosses discovery, jobs and session recognition.
  What to do / Must NOT do: Verify official https://github.com/earendil-works/pi and packages/coding-agent/package.json against npm metadata; make upstream package the Pi recipe/latest identity. Inventory every hardcoded Senpi identity in discovery, observations, removal, default selection and restart. Existing Senpi is unsupported terminal-only, not upstream Pi. Preserve records; invalidate Senpi-bound ready jobs/policies from execution without deleting history. Never overwrite existing pi executable from Senpi without a separate explicit reviewed install; retain legacy upstream packages as individually proven identities, not automatic source rewrites.
  Closes: GAP-2, GAP-6, GAP-7. Parallelization: Wave 1; dependencies per matrix.
  Migration boundary: OmO-owned Senpi is an OmO engine, never an upstream Pi candidate. Preserve src/adapters/omo.ts, adapters/update-context.ts, service/prepare-omo-runtime.ts, omo-update-runtime.ts and plugin-runtime.ts identity contracts. Change standalone Pi recognition coherently in src/adapters/pi.ts:61,111,149, app/catalog-inventory.ts:18, service/catalog-provider.ts:280,506, catalog-sources.ts:59,63, check-runtime.ts:50 and restart-runtime.ts:63–64. Do not carry Senpi's pi===senpi bin assumption into upstream. Upstream Pi resume/restart is unsupported until its contract is independently proven; this plan does not implement that extension. Standalone Senpi sessions are terminal-only, with a source-change explanation for paused old policies; no new catalog ID. Legacy @mariozechner upstream may be observed as Pi with legacy-source status but cannot automatically switch package scope. OmO-owned engine must never gain Pi update/removal actions.
  References: src/app/catalog-registry.ts:14–40; catalog-types.ts:5; catalog-latest.ts:59–80; observations.ts; pane-restart.ts; catalog-removal-target.ts; test/app/observations.test.ts; official https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md (2026-10-15 redirects content to earendil-works).
  Acceptance criteria: isolated fixtures identify upstream Pi, Senpi and OmO using package identity not executable basename alone; stale Senpi jobs cannot execute against upstream; existing Senpi bytes and histories unchanged. Official npm identity verified without installation.
  Additional regression anchors: test/adapters/pi.test.ts, test/discovery.test.ts:245, test/service/catalog-sources.test.ts and catalog-provider.test.ts; upstream package has only pi bin, standalone Senpi has pi/senpi bins, OmO-owned Senpi remains compound OmO. Existing standalone Senpi removal is not exposed through upstream Pi, regardless of historical removal support.
  QA scenarios: happy — `bun test test/app/observations.test.ts test/app/catalog-latest.test.ts` plus adjacent registry/discovery regressions, upstream recognized; failure — same bin name Senpi and stale stored pi binding cannot update/delete/restart as upstream. Evidence E/task-1.md.
  Commit: N; see Commit strategy.

- [x] 2. 자동 업데이트 비교와 세션 정책 일치
  Recommended task executor category: deep-low — shared policy and version-state invariants.
  What to do / Must NOT do: Use latestResult/available eligibility for automatic updates; current/ahead/unknown/failed never launch installer. New policies explicitly keep sessions. Preserve stored explicit policies; materialize legacy missing paneSessions as existing restart-idle behavior with visible setting, not silent behavior change. Turning automation on cannot restart sessions unless policy visibly opts in.
  Closes: GAP-3, GAP-5. Parallelization: Wave 1.
  References: src/app/controller.ts:155–182,825–864; src/app/catalog-bulk.ts:56–64; web/catalog-updates.tsx:61–63; test/app/controller.test.ts.
  Stored policy schema default in src/app/validation.ts:82 remains restart-idle for compatibility; store.ts already materializes it on read. Do not introduce startup writes solely to backfill it. New-policy/absent-policy fallbacks at controller.ts:495,941,1029 and web/catalog-updates.tsx:62 become keep; test legacy confirm without a policy explicitly. Add raw legacy-row regression in test/app/store.test.ts. Existing opted-in restart policies remain visible, not silently disabled.
  Acceptance criteria: exact installer/restart call counts for available/current/ahead/null/uncomparable; explicit keep and legacy policy preserved after reload. No automatic downgrade.
  QA scenarios: happy — `bun test test/app/controller.test.ts` available updates once, new keep does not restart; failure — ahead/unknown/missing version produce zero installer calls; legacy explicit policy remains. Evidence E/task-2.md.
  Commit: N.

- [x] 3. OpenCode 공식 설치 최신 조회 연결
  Recommended task executor category: deep-low — official release channel must match executor.
  What to do / Must NOT do: Match official standalone executor's release source/channel with bounded latest metadata lookup. Keep npm/Bun/Brew channels separate, validate returned identity/version/artifact, and expose source-specific unsupported reason where no proven path exists. No installer runs for a check.
  Closes: GAP-5. Parallelization: Wave 1.
  References: src/app/catalog-official-update.ts:12–25; catalog-latest.ts:59–128; catalog-update-target.ts:42–46; test/app/catalog-latest.test.ts; test/app/catalog-official-update.test.ts.
  Verified official source (2026-10-15 read-only fetch https://opencode.ai/install): unpinned latest uses https://api.github.com/repos/anomalyco/opencode/releases/latest and github.com/anomalyco/opencode/releases/latest/download/$filename. Bind standalone lookup to that GitHub stable release and platform asset, recheck source before implementation; never execute downloaded script during planning.
  Acceptance criteria: discovered official OpenCode target checks latest and reaches available/current; source mismatch and malformed/network responses fail explicitly.
  QA scenarios: happy — `bun test test/app/catalog-latest.test.ts test/app/catalog-official-update.test.ts` fixture official release yields comparable version; failure — wrong channel/package/timeouts never current and no installer invocation. Evidence E/task-3.md.
  Commit: N.

- [x] 4. 미확정 업데이트 결과의 안전한 재확인
  Recommended task executor category: deep-high — reconcile job evidence without replaying mutations.
  What to do / Must NOT do: Add revision-bound read-only reconciliation for uncertain catalog jobs. Re-discover the exact installation and source, probe installed version, record evidence. Mark completed only if existing job target and intended release evidence prove outcome; otherwise remain uncertain with concrete reason. If an uncertain job has no pinned intended version, verified current disk state alone is not historical success: provide explicit archive-as-unverified acknowledgement after proving no active executor, then release lock without changing outcome to completed. Revalidation occurs before new plan; never retry installer automatically. Other CLI checks remain independent.
  Closes: GAP-5. Parallelization: Wave 1, after task 2 controller work.
  Evidence boundary: latest observed at plan time is not an expected executed version when installer resolves then-latest. Store checkedVersion separately from expectedVersion; expectedVersion is nullable and only set from actual pinned/resolved execution provenance. Legacy rows default null. Do not infer failed merely because disk equals beforeVersion, nor success from fresh network latest. Capture pre-mutation rejection as failed only when executor proves mutation never started; otherwise uncertain. Reconciliation must also verify recorded executable/file identity using the existing install recovery pattern in src/app/catalog.ts:153–224, not path equality alone.
  References: src/app/catalog-updates.ts:39–50,77–101; src/app/controller.ts; src/app/types.ts; web/catalog-dashboard.tsx:24–37; test/app/catalog-updates.test.ts; test/app/controller.test.ts.
  Acceptance criteria: reconciliation issues zero install commands, preserves revision/source guards; archived unverified stays distinct in history; active/missing/changed targets cannot be acknowledged to bypass an active job lock.
  QA scenarios: happy — `bun test test/app/catalog-updates.test.ts test/app/controller.test.ts` exact target verified or explicit unverified closure recorded; failure — changed path, active runner, missing expected version do not falsely complete or replay. Evidence E/task-4.md.
  Commit: N.

- [x] 5. 업데이트 중심 탐색과 카드 상태 통합
  Recommended task executor category: visual-engineering — primary journey and responsive state presentation.
  What to do / Must NOT do: Build Updates/Sessions/History navigation, migrate persisted view keys, explicit Add CLI. One CLI row with selected installation identity; engine and catalog remain distinct discriminated execution routes within row. Always discoverable Update control with reason when unavailable; Check latest separate. Render installed/latest/evidence distinctly and accessible busy/error states. Do not hide engine-only inventory or silently reroute it to catalog.
  Closes: GAP-1,GAP-2,GAP-7. Parallelization: Wave 2.
  References: web/app.tsx:24–30,189; web/dashboard.ts:30–44; web/catalog-dashboard.tsx:24–96; web/install-status.ts; web/app.test.ts; web/dashboard.test.ts; baseline dashboard-desktop.png.
  Acceptance criteria: one family row preserves every installation route; all check/job states have deterministic action/reason; unknown is not latest; keyboard navigation and saved navigation restore work.
  Add focused web/catalog-dashboard.test.tsx beside existing web/catalog-updates.test.tsx because primary card lacks dedicated coverage. Assert action availability/disabled semantics and structured reason codes, not prose wording. Update affordance remains discoverable for ahead/unknown but cannot execute.
  QA scenarios: happy — `bun test web/app.test.ts web/dashboard.test.ts` and fixture browser `page.goto(fixtureUrl)`, `page.snapshot()`, `page.screenshot()` at 1440/390 light/dark; failure — failed inventory not misinstalled, missing latest not current, engine-only row still actionable. Evidence E/task-5.md and four PNGs.
  Commit: N.

- [x] 6. 업데이트 검토·진행·복구 결과 연결
  Recommended task executor category: visual-engineering — action confirmations and history continuity.
  What to do / Must NOT do: Route update button to review showing exact location, source, installed version, latest checked version/time and whether execution fetches then-latest rather than pins it. Keep existing command/revision contracts. Progress and completed/failed/uncertain outcomes stay accessible in global History and CLI detail. Connect task 4 reconciliation and acknowledgement; retain bulk per-item results and recovery access. Filtering never silently changes bulk scope.
  Closes: GAP-1,GAP-5. Parallelization: Wave 2.
  References: web/catalog-dashboard.tsx:45–103; web/catalog-bulk.tsx; web/catalog-updates.tsx; src/app/catalog-bulk.ts; web/app.tsx Operations; adjacent web tests.
  Acceptance criteria: review cannot execute after selected target/server/revision changes; double activation makes one request; update complete never implies session updated; uncertain work has truthful bounded recovery.
  QA scenarios: happy — `bun test web` plus fixture browser review → progress → completed with recorded command transport; failure — swap target/server after review, partial bulk and uncertain job show recovery without duplicate command. Evidence E/task-6.md and screenshots.
  Commit: N.

- [x] 7. 실행 세션 정보와 재시작의 의미 정리
  Recommended task executor category: visual-engineering — evidence-aware sessions and capability display.
  What to do / Must NOT do: Primary session fields CLI identity, activity and running-version evidence; engine version/path under technical detail. File-time evidence labeled inferred, unknown never called exact old version. Link install changes only by matching installation identity, not family-wide timestamps. Rename restart entry to explicit session restart with same-conversation consequence in review; display unsupported/blocked reason. Preserve pane/native/managed distinct guards and session-ID confirmation. Empty managed section collapses; unsupported CLI terminal-only. No new restart support.
  Closes: GAP-2,GAP-3,GAP-7. Parallelization: Wave 2.
  References: web/app.tsx:215–267; web/native-restarts.tsx; web/pane-session-choice.tsx; src/app/observations.ts:279–287,459–462; src/app/pane-restart.ts:75,99–118; test/app/observations.test.ts:24–35.
  Acceptance criteria: installation A change does not mark B stale; observed/working/unknown activity remain separate; unsupported GJC/OpenCode/Senpi offers no restart; explicit policy labels match task 2.
  QA scenarios: happy — `bun test web test/app/observations.test.ts test/app/pane-restart.test.ts` and fixture session screenshot at 1440/390 both themes; failure — unknown activity/version or ambiguous identity cannot promise safe resume or latest version. Evidence E/task-7.md and PNGs.
  Commit: N.

- [x] 8. 설치·대상 선택·기본 실행·제거 UX 분리
  Recommended task executor category: visual-engineering — management hierarchy and destructive review.
  What to do / Must NOT do: CLI detail sections show installation locations, update target selection, new terminal default and explicit per-location removal. Single location bypasses duplicate-cleanup wizard; multiple locations can enter existing consolidation. Add CLI/another location clearly separate from update. Removal review shows exact path, version, method, preserved data and usage blocker. Changing update selection never silently changes shell default; unsupported source reason visible.
  Closes: GAP-4. Parallelization: Wave 2.
  References: web/catalog.tsx; web/catalog-installations.tsx:91–110; web/catalog-cleanup.tsx; src/app/catalog-removal-support.ts:6–22; catalog-removal-guard.ts:8–28; docs/learning/tasks/installation-consolidation-ui.md.
  Acceptance criteria: one-copy/manage and multi-copy/consolidation flows both work; retain frozen review, source revisions, automation/active-consumer deletion guards and preserved data.
  QA scenarios: happy — `bun test web` and fixture browser one/two-location selection/remove review without actual deletion; failure — active use, policy binding or changed location blocks confirm and never shows completion. Evidence E/task-8.md and four viewport/theme PNGs.
  Commit: N.

- [x] 9. 지원 설명·랜딩·사용 시나리오 일치
  Recommended task executor category: writing — document verified capability without overclaiming.
  What to do / Must NOT do: Update README, current DESIGN decision, learning task and public support pages for upstream Pi, update-first navigation and source-specific capabilities. Preserve Console/public metadata distinction and seven supported IDs. Explain install success versus running session adoption. Add no prose-pinning tests; existing machine-consumed catalog/asset assertions remain valid.
  Closes: GAP-1,GAP-6,GAP-7. Parallelization: Wave 2 after 1–8.
  References: README.md; DESIGN.md; docs/learning/tasks/seven-cli-support.md; site/build.ts (수정 원본); site/index.html; site/features.html; site/dist/clis/index.html (생성 결과, 직접 수정 금지); web/index.html.
  Acceptance criteria: generated seven-item support list matches registry; no Senpi described as upstream Pi, no unproven restart/support promise. Document choice rationale, limits, failure diagnosis order and direct fixture verification.
  QA scenarios: happy — `bun run build:site` and existing site tests, browser public preview desktop/mobile light/dark; failure — absent/unsupported install capability is explicitly represented, metadata stays distinct. Evidence E/task-9.md and PNGs.
  Commit: N.

- [x] 10. 엔진 승인과 상세 복구 통합 결함 수정
  Final audit followup, blocks F1/F2/F4 acceptance. Own web/app.tsx, dashboard.ts and relevant web tests; catalog recovery props only if required. Engine absent-policy default must be keep and visibly match submitted choice. Freeze review server, installation identity/executable and revision; drift disables confirmation with zero sends. CLI detail may filter displayed jobs but must retain full global active-job guard context. Reproduce final-audit.md three actual-App SSE/browser cases before fix; test full App routes and real fixture at desktop/mobile both themes, zero forbidden sends and happy path once. Preserve existing explicit policy values and backend guards. Independent re-review required; no operating mutations or deployment.

## Final verification wave
- [x] 11. Pi 통합 기대값과 PTY 실패 원인 해결
  F3 followup: update test/service/domain.test.ts upstream Pi machine-value expectations to actual migrated fixture without weakening metadata/core-read assertions. Diagnose test/plugin-entry.test.ts preparation-rejection PTY failure with durable event-stage output, no sleeps or timeout inflation. Fix only caused regression, or prove baseline equivalent failure with evidence. Capture focused green or exact preexisting classification, source bytes and cleanup. No UI task10 files, operating sessions or installs touched. Independent verification required.

> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
  Compare every task and source-bound receipt against accepted scope; no operating mutations or missing Senpi preservation. Evidence E/final-compliance.md.
- [x] F2. Code quality review
  One independent reviewer after parent QA; review correctness, source/revision guards, policy migration and new regression tests. Use LSP diagnostics and final command exit codes. Evidence E/final-review.md.
- [x] F3. Real manual QA
  Parent runs fixture browser journeys tasks 5–8 and public preview, 1440/390 light/dark, keyboard and failure states; assert no horizontal overflow/blank content, inspect screenshots, log browser errors. Final `bun test`, `bun run typecheck`, `bun run build`, `bun run build:site` exit 0 or explain preexisting failures. No new live installation authority. Evidence E/final-qa.md.
- [x] F4. Ideal-state fidelity
  Reviewer maps IS-1–7 one-to-one to actual QA receipts; unproven item fails, becomes follow-up task, not claimed complete. Evidence E/final-fidelity.md.

## Commit strategy
No product commits under planning approval. Target repository was unborn with unrelated untracked files; never stage whole tree or manufacture baseline. Execution must inspect status and use explicit paths; if later user requests commits/PR, resolve baseline/worktree constraint before git writes. Korean messages and no Co-Authored-By. Plan-only artifacts retained in portfolio/.omo; no deployment.

## Success criteria
> One row per IS row. The plan is complete only when every IS row has a delivering todo and a proving QA scenario; F4 checks the delivered behavior against these rows 1:1, and a shortfall becomes new `- [ ] N.` rows, never a note.
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 5,6 | visible update + review/progress/history | E/task-5.md, E/task-6.md |
| IS-2 | 1,5,7 | unknown/version evidence and A/B identity | E/task-1.md, E/task-7.md |
| IS-3 | 2,7 | explicit keep, preserved legacy policy, guarded restart | E/task-2.md, E/task-7.md |
| IS-4 | 8 | one/two-copy flows and blocked removal | E/task-8.md |
| IS-5 | 2,3,4,6 | no downgrade, official latest, uncertain no replay | E/task-2.md, E/task-3.md, E/task-4.md, E/task-6.md |
| IS-6 | 1,9 | upstream identity and preserved Senpi | E/task-1.md, E/task-9.md |
| IS-7 | 5,7,9 | seven catalog IDs, unsupported terminal-only | E/task-5.md, E/task-7.md, E/task-9.md |
