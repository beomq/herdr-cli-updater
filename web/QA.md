# Web frontend integration handoff

## Approved charcoal redesign unit (2026-10-11)

This receipt supersedes the historical cyan visual contract below. Changes are
limited to root `DESIGN.md` and `web/`. Production: `app.tsx`, `primitives.tsx`,
`styles.css`, `client.ts`. Test-only: `state-harness.tsx`, `app.test.ts`.
No dependencies, backend files, shared types, commits or production installs changed.

Default dashboard uses snapshot installations, active managed/external sessions,
enabled policies and the five most recent persisted update operations. No invented
history or metrics. Last verified installation time uses only update `installedAt`,
including a verified install whose subsequent restart failed; old records remain
unknown. External facts consume `family`, `tty`, ISO `startedAt`, runningVersion
and linked disk installation separately. Managed PID/launch/engine/disk versions
remain distinct; unavailable managed TTY/start time are explicit unknowns.
Unknown installation owner disables prepare/launch, rather than claiming ownership.

Process observation failure produces a global stale banner and neutral topbar,
with last successful `observedAt`; session rows are explicitly last observations.
Policy modes remain off/check/update/update-and-restart. First check now versus
after interval is sent explicitly. Off form submission sends directly without a
dialog, and enabled policy has a one-click off button. Non-off saves require a
consequence dialog. Installation alone never enables updates. Copy distinguishes
browser close from OS login/reboot autostart, which is not registered.

Local evidence: `bun test web/app.test.ts web/client.test.ts` passed 6 tests,
0 failures, 10 assertions. `tsc --noEmit -p tsconfig.web.json` exited 0. Bun
in-memory test-harness browser bundling succeeded. CSS LSP unavailable because
biome is not installed; no dependency was added to bypass that boundary.

Owned Bun WebView inspected primitives first, then desktop dark 1440x1000 shell,
dashboard, installation, managed session and policy surfaces; phone light 390x844
dashboard, navigation, policy and enabled-policy review dialog. Phone document/main
widths were 390px with no horizontal overflow. Actual theme selector exercised.
Policy off recorded exactly one off command and zero dialogs; selecting check
opened a native dialog without a new command. Temporary server/views were closed.
Screenshot evidence is attached to this child session tool results, not mixed
with historical PNGs. No exhaustive integrated visual PASS is claimed: parent
owns actual-service render, genuine lifecycle QA and full project build/tests.

> Parent integration completed on 2026-10-11. The original unit handoff below
> remains historical. Final genuine-service evidence is in
> `.omo/evidence/independent-package/README.md`. The dependency type issues below
> were resolved with the compatible `react-grab@0.1.47` and `react-scan/lite`
> entry, without suppression. Final typecheck/build passed. Current production
> UI exposes the observed installation path and expandable failure diagnostics;
> private worker credentials remain excluded. Integrated package update/resume,
> authentication expiry, policy persistence, 24 viewport/theme/view captures,
> scrolled mobile boundaries, and two independent visual passes are recorded
> separately from this frontend-only harness.

## Scope and entries

Changed production files: `web/index.html`, `web/main.tsx`, `web/app.tsx`,
`web/client.ts`, `web/primitives.tsx`, `web/styles.css`.
Added only section 9 to root `DESIGN.md`; terminal sections remain intact.
Test-only files: `web/showcase.tsx`, `web/state-harness.tsx`,
`web/client.test.ts`, this receipt and `web/evidence/*.png`.
Never ship the two harness bundles as production assets.

Build `web/main.tsx` as a browser entry with
`process.env.NODE_ENV` defined as `"production"`. Its CSS import emits `main.css`.
Serve browser outputs as `/assets/main.js` and `/assets/main.css`, and serve
`web/index.html` at `/`. The app is same-origin and has no router/history routes.
Only theme is persisted; no API data, commands or tokens in local storage.

Required runtime: `react@18.3.1`, `react-dom@18.3.1`.
Required types: `@types/react@18.3.18`, `@types/react-dom@18.3.5`.
Parent already provided the pinned dependencies and `tsconfig.web.json`.
No install or manifest/lock/tsconfig edits were performed by this frontend unit.
Parent's dev tools: `react-grab@0.2.0`, `react-scan@0.5.7`,
`react-doctor@0.9.17`. The first two are dynamic imports behind the development
condition in `main.tsx`. React Doctor is a CLI review tool, not a browser import.
No third-party font, icon, image, CDN, framework, router or state dependency.

## Contract coverage

- Authentication exchanges the URL fragment token once via POST `/api/session`,
  removes the fragment before awaiting, and uses same-origin cookie credentials.
  Missing/invalid/expired access renders a reopen-through-CLI message.
- GET `/api/state` and `snapshot` SSE events observe revisions without resending
  mutations. EventSource reconnects only the read-only stream. A stream failure
  probes state to distinguish expired authentication from offline service.
- Every user mutation sends one POST `/api/command` with one generated requestId.
  No retry queue. Lost responses become uncertainty and block further commands
  until fresh observation plus a deliberate acknowledgment.
- Installations show disk installed/latest separately, active managed/external
  counts, check, prepare and a launch form. Production rows come only from the
  shared snapshot. Unsupported launch/preparation is disabled; check can return
  the service's explicit unsupported status.
- Managed sessions show launch wrapper and observed engine versions separately,
  bounded wrapping output, input, stop/restart confirmation, and confirm/select/
  input approvals with captured generation and approval id. External sessions
  have no controls and never infer a running version from disk.
- Operations show all frozen stages and before/target/verified versions. Confirm
  captures the ready revision, affected session selection and restart choice.
  Stale preparation and generation block approval. Cancel is offered only before
  irreversible stages, with service revalidation and explicit unsafe-cancel errors.
- Policies default off when absent; all four modes, interval 5-10080 minutes and
  waiting reason are supported. Consequences are reviewed before saving.
- Private ids, request ids, durable routing ids, executable paths and worker
  credentials are not displayed as product facts. Errors/reasons are translated
  by code, never rendered as raw private enums.

## Actual local evidence (2026-10-10)

The temporary frontend-only server used in-memory Bun bundles and no backend.
React 18.3.1 was resolved from the existing Bun cache without installation.
Production `main.tsx`, primitives and state harness all bundled successfully
against that runtime. A direct project-resolution build failed while parent
dependency setup was still incomplete (`Could not resolve react/react-dom`);
parent must run its final build from the project with installation complete.

Transport regression command `bun test web/client.test.ts`: **4 pass, 0 fail,
8 assertions, exit 0**. It checks exactly-one POST on lost response, typed failure
with snapshot, read-only snapshot cookie credentials, and expired access.
`lsp_diagnostics(web)` reported zero diagnostics across five TSX files.

Full `tsc --noEmit -p tsconfig.web.json` has **two third-party declaration errors**:

1. `node_modules/react-scan/dist/index.d.mts:58:21` TS2304 missing `RenderChange`.
2. `node_modules/react-scan/node_modules/bippy/dist/core.d.ts:267:7` TS2403 conflicting
   `__REACT_DEVTOOLS_GLOBAL_HOOK__` declaration.

Initial frontend unused-import and dataset-index errors were corrected; subsequent
full checks reported only these two dependency errors. No suppression, skipLibCheck,
dependency patch or weakened test was added. Parent owns resolving the dev dependency
type issue before claiming a clean full typecheck. React Doctor was not run here.

## Visual QA

Read browser skill and owned-engine reference. Both Chrome/CDP pipe attempts
terminated (`Session with given id not found` / `CDP pipe browser exited`). Used
isolated Bun WebView (owned WKWebView storage, no user profile) instead. The only
Chromium profile created was temporary and was removed at teardown.
Screenshots are retina (2x); logical viewports are 390x844, 768x1024, 1440x1000 and
1920x1080. Waited for module import and animation-frame composition, never sleeps.
Theme captures use the actual theme selector change event, not a DOM override.

| Check | Result / evidence |
|---|---|
| Tokens and existing semantics | PASS: CSS tokens, cyan actions, text statuses, red failures, amber uncertainty; terminal design unchanged |
| Primitive-first sequence | PASS: showcase inspected at phone/tablet/desktop before product screens |
| Four views x four widths x two themes | PASS: 32 final `evidence/{phone,tablet,desktop,wide}-{light,dark}-{installations,sessions,operations,policies}.png` |
| Document and main horizontal overflow | PASS: 32 measured captures had scroll width equal to client width |
| Touch targets | PASS: all measured button/input/select targets >=44px; checkbox label has 44px minimum |
| Long paths/output | PASS: wrapping paths; bounded focusable console; no horizontal overflow |
| Light/dark/system theme | PASS: user selection updates theme; system mode uses matchMedia change subscription |
| Dialog label/focus/containment | PASS for native modal; captures show initial visible focus; Escape closes modal |
| Screen reader | NOT RUN with actual assistive technology; visible labels, landmarks, status/alert notices and dialog name are present |
| Reduced motion | PASS by inspection: no animation or transition is shipped |
| Offline/empty/expired access | PASS local visual states: `tablet-offline.png`, `tablet-empty.png`, `phone-expired-access.png` |
| Operation stages, uncertainty/failure | PASS local harness: all 11 stages rendered; `phone-operations-stages.png`, `desktop-operation-end.png` |
| Launch/stop/policy/update dialogs | PASS local visual inspection: `tablet-launch-dialog.png`, `tablet-stop-dialog.png`, `tablet-policy-dialog.png`, `phone-update-dialog.png` |
| Genuine API/SSE/update/session lifecycle | NOT RUN: parent-owned integrated QA |

No integrated PASS is claimed. Test state banners remain in test entries only.
The state harness's `act` only records in `window.harnessCommands`; it cannot
mutate real installations or run executable commands. The production entry does
not import either harness. Approval answer semantics, backend output sanitization,
safe cancellation and lifecycle safety remain genuine-service contracts to verify.

## Parent verification order

1. Finish installation and resolve the two dev-tool type errors without suppressing
   diagnostics; run project browser build with production define.
2. Verify HTML/JS/CSS paths and fragment exchange -> cookie -> state -> snapshot SSE.
   Drop a stream and a POST response separately; ensure only the stream reconnects.
3. On an isolated real installation: check -> prepare -> review -> confirm -> wait /
   update -> verify -> chosen restart. Exercise revision/generation conflicts,
   safe/unsafe cancel, all approval methods and external observation-only sessions.
4. Verify policy persistence, interval bounds, off default and waiting reasons.
5. Run integrated desktop/mobile QA and the independent reviews parent owns.

Troubleshooting: blank page -> inspect asset paths and bundle; expired access ->
reopen through CLI, never retry token POST; stale data -> check cookie and SSE;
uncertain mutation -> observe operation before acknowledging; safe-stop refusal ->
inspect managed state and waiting reason, never force-kill from this UI.
