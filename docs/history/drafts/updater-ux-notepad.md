# Ultrawork Notepad — update-first Console UX plan
Started: 2026-10-15

## Plan
1. Read current decisions, history, source structure and earlier QA.
2. Consult architect on navigation and ultrabrain on version/update contracts; read-only independent lanes, no implementers. Parent owns live browser audit and synthesis.
3. Observe current Console dashboard, CLI detail and terminal sessions through authorized read-only browser actions; record desktop/mobile screenshots.
4. Verify lane claims against source and define ideal state, gaps, seven-CLI capability matrix and exact acceptance scenarios.
5. Present approach and only unresolved owner decisions; obtain approval for plan writing.
6. After approval, scaffold one .omo/plans/update-first-console-ux.md, fill executable tasks and QA, run required plan-reviewer and resolve findings.
7. Close owned browsers and remove owned run/cache root; retain evidence and draft.

## Success criteria + QA scenarios
Tier: HEAVY. The plan changes session/update interaction contracts; user explicitly requests considered UX design. No product edits/execution in this planning run.
C1: omowright page.goto('http://127.0.0.1:62204/#token=<authorized bootstrap>'), snapshot(), click navigation/detail refs read from that snapshot. PASS when dashboard, CLI detail and sessions findings have source/evidence and desktop/mobile screenshots. Do not click update/check/install/remove/restart or automation.
C2: read web/app.tsx, catalog*.tsx, src/app/catalog-latest.ts, catalog-update-target.ts, controller.ts and tests; PASS when each user concern maps to explicit intended behavior, test strategy and named unknown. Distinguish installed/running/latest and recipe support from live update proof.
C3: user approval followed by one decision-complete plan and native plan-reviewer approval. No approval means awaiting-approval, not completion. Stop when approved plan delivered with evidence and cleanup receipts.

## Now
Round 2 st_01a13e25 approved OKAY. Approved digest 56f44c93e9e54dc0af50eaba4f1db58ab2ea34040ff1df2e90233b5fd5cffa55. Final live path/digest check submitted before handoff. Nine implementation tasks and four final checks; no product code, operating changes, tests/builds or product commits in planning run. Owned browsers/temp resources already cleaned. Deliver plan and stop; execution requires user request.

## Todo
- Capture live Console read-only UX evidence.
- Integrate source-grounded advisory results and draft approach.
- Obtain plan-writing approval; create and review plan only afterward.
- Clean owned browser/profile/run root and append receipts.

## Findings
- Skills used: ulw-plan (workflow/approval/review); learning-development (explain observed behavior and decisions); frontend (existing DESIGN.md and UX contract, no implementation); browser (real Console inspection); bun-1-4 (kernel/runtime). Prior turns loaded bodies; this task does not implement frontend or perform a visual redesign yet. visual-qa relevant to downstream implementation and baseline capture only.
- Existing memory preserves seven CLI scope, unsupported sessions terminal-only, global-first update and session restart separated, Console title, Pi display != upstream package source.
- Prior 547 app/web tests and four installer tests passed, but do not prove seven real CLI update paths. Prior source record docs/learning/tasks/seven-cli-support.md read.
- git log lookup returned empty; repository previously unborn/untracked. Preserve all files, do not create a baseline commit containing unrelated work.
- LSP document-symbol lookup failed: `null is not an object (evaluating 'symbols.length')`. Use bounded reads for unavailable symbol map.
- create_goal attempted with detailed planning objective; rejected because an older blocked goal remains unfinished. get_goal confirms unrelated older blocked native-core rollout. Do not falsely mark it complete; this notepad/draft tracks current request.

## Learnings
- Parent fetched OpenCode official installer as text only: latest release API is anomalyco/opencode GitHub releases/latest; included in plan. npm registry metadata confirms @earendil-works/pi-coding-agent 1.2.0, bin pi=dist/bundle/cli.js, earendil-works/pi repository. No package installed.
- Review round 1 submitted for plan digest d4ec8e9e089f4fdf7e2cf160367728ebb340e5645740562650b94b6d60eefaf7; do not edit plan until verdict. Draft contains round/launch identity; persist returned task receipt next.
- Official upstream README and package.json fetched directly: earendil-works/pi, @earendil-works/pi-coding-agent, pi bin, Node >=22.19.0. Context7 discovery found tools but invocation failed Unknown tool; direct official documents are the evidence, not a successful Context7 lookup.
- Display-only Pi rename retained @code-yeongyu/senpi; planning must not silently promise upstream Pi.
- Narrow support listing is not evidence that updating each CLI works.
- Live read-only screenshots captured dashboard/installations/sessions desktop and sessions mobile (dark). Navigation only; no check/update/install/delete/restart clicks. First browser session expired; second browser captured all evidence in one cell and closed successfully.
- Source verified automation's unequal-version guard and OpenCode official latest omission. Both belong in a truthful update-first plan, not just cosmetic changes.
- Both advisory lanes completed without product edits, test execution, temp resources or process mutations. Parent retained global history and rejected unsupported exact old-version counts from their suggestions.
- Detailed evidence/gaps/defaults recorded in update-first-console-ux.md. No new test pass or operational success claimed.

## Resources
- Cleanup receipt: both owned browser handles closed; /tmp/updater-ux-plan-QhWQPv and empty bootstrap marker removed. Four PNG evidence files retained under .omo/evidence/update-first-console-ux/. Both advisors created no temporary resources.
- User answered Pi identity question: change to upstream Pi. Preserve existing Senpi installations, data and sessions; no automatic migration/removal. Next gate is approval to write and review the execution plan.
- RUN_TMP: /tmp/updater-ux-plan-QhWQPv. Every child command needs TMPDIR, NODE_COMPILE_CACHE and BUN_RUNTIME_TRANSPILER_CACHE_PATH under its owned root.
- mktemp note: /var/folders/3r/x0sqsx_d3012q12cpbyzhbp80000gn/T/ulw-20261015-ux.XXXXXX.md.cNkve4UwKA (empty bootstrap marker; durable notepad here because planner writes only .omo artifacts).
- Evidence destination: .omo/evidence/update-first-console-ux/.
- Advisory lanes: ux-architecture-advice and ux-version-contract, both read-only.
