# CLI updater terminal design

## October 19 session-apply contract (current)
This section supersedes conflicting session-restart rules below. Manual and bulk
updates apply to open sessions by default: the review dialogs carry the pane-session
choice preset to restart-all (idle panes restart into the same conversation right
away, working panes once they finish, blocked panes are skipped). Choosing keep
leaves sessions alone; the Terminal sessions batch review below then applies them
later. Pane restarts run in the background per update and never delay the next CLI.

- Organize installations: today's PATH-default copy is held only while the kept
  installation is not itself reachable on PATH. When it is, removing the default copy
  merely shifts the command to the kept copy and no shell file changes; the panel says
  so. A configured new-terminal default is never removable.

- Updates shows a fourth compact metric, Sessions to apply N: herdr-pane sessions whose
  recorded running version differs from the installed version. Inferred running versions
  never count. The metric navigates to Terminal sessions and performs nothing.
- Terminal sessions leads with Review restart of N outdated sessions, counting only
  outdated panes that can restart right now (engine idle, or the screen rule). Working
  panes are never queued; they stay on their card's own button. The dialog lists each
  pane with a checkbox (all selected), its running and installed versions and the rule
  that admits it, warns when any item relies on the screen rule, binds to the server
  instance and every pane's pid, start, conversation and state sequence, and sends one
  pane-restart-batch command. The service restarts the selected panes one at a time and
  reports each through the existing per-pane restart job on its card.
- The screen rule: when the engine exposes no session-activity signal (activity
  unknown), a pane is admitted only while herdr reports idle or done, the screen ends
  at a prompt, and the pid was quiet for two consecutive observations. The default
  Review session restart stays locked for unknown activity; only Review screen-based
  restart opens, with a notice that background monitors and child tasks stay unverified.
  The server re-verifies the same three readings before the exit command.
- Automatic policy restarts (restart-idle, restart-all) use the same screen rule and record
  one result per pane; History shows them under the update as Session restarts after the
  update, with completed, skipped-working, skipped-blocked and failed reasons.
- An OmO session without a conversation file is refused before any input (session_empty).
- Update check and Update all re-read installed versions before comparing.

Verification boundary: static render tests for metric, batch button and history results;
browser fixture test for the batch dialog (selection, drift); controller tests with an
engine that exposes no activity. Live proof on one macOS machine with OmO 5.1.35 only.

## October 16 card-first update workspace contract (current)
This section supersedes conflicting workspace and automation rules below. Keep
the existing tokens, typography, stack/cluster, cli-entry, Button, Badge, Notice,
Facts and revision-bound Dialog. No dependencies or decorative motion are added.

- Updates leads with Update check and, only when eligible updates exist, Update
  all N. Preparation remains an internal read-only step before explicit review.
  No always-visible Refresh or Prepare control. Checking never enables automation.
  Summary counts remain compact inline metrics rather than tall tiles, including
  on mobile, so navigation statistics do not displace the installation cards.
- Each family card owns its check, progress and latest outcome. Bulk results do
  not create a second list above the cards. Snapshot events retain card keys,
  details state and main scroll position; no automatic History expansion or focus.
  Full job diagnostics stay in History. A compact live status uses text as well
  as color and separates current disk version from historical update proof.
- Automatic update toggles are directly on cards. One Automatic update settings
  dialog edits the shared after-update session policy. Saving applies it to all
  stored and future automatic policies without enabling, rescheduling or restarting
  now. Before explicit save, legacy per-policy choices can differ; show that fact.
  Manual update review retains its separate session confirmation semantics.
- Multiple installation paths have a prominent count and Organize installations
  action opening the existing retained-install selection and cleanup flow. Optional
  general-terminal PATH changes are distinct from herdr launch selection. Do not
  claim a herdr connection is applied without a supporting server contract.
- Uncertain jobs show their past failure, date and current selected version; use
  Check current installation state, not an ambiguous result check. Reuse existing
  revision-bound recovery; fresh inspection is not historical success and does not
  unlock retries alone. Cards also expose explicit archive-unverified review after
  inspection; safe archival releases only the stale lock for a fresh verified plan.
  Global in-flight guards use the complete snapshot, even when a
  card or History display is family-scoped.

Accessibility: main remains the scroll owner; existing modal focus containment,
preventScroll restoration, keyboard switches, wrapping paths and touch targets
remain. Card live regions do not automatically move focus or open details.
Verification boundary: focused behavior tests are this implementation unit's
gate; parent owns desktop/mobile light/dark screenshots and integrated QA. Fixture
success does not prove operating updates, herdr adoption or user understanding.

## October 15 update-first Console contract (current)
This section supersedes conflicting older web/navigation and capability notes
below; terminal sections 1-8 retain their scope. Reuse the current tokens,
Panel, Facts, Notice, Badge, Button and revision-bound Dialog; no new visual
system, dependencies or animation are introduced by the documentation update.

- Primary navigation is Updates, Terminal sessions, History. Add CLI is an
  explicit Updates entry; target selection, installation management and
  automation live in CLI details. Stored dashboard/policies map to Updates,
  operations to History, installations to Add CLI. Unknown views use Updates.
- Exactly seven management IDs: claude, codex, gjc, omp, omo, opencode, pi.
  Pi is upstream @earendil-works/pi-coding-agent. Standalone Senpi remains
  unsupported terminal-only; existing installations, conversations and history
  are preserved. OmO-owned Senpi remains an OmO engine. Pi, OpenCode and GJC
  do not offer unproven same-conversation restart.
- Inclusion in the catalog is not source-specific authority. Installation,
  latest lookup, update, removal and restart have separate checks. Missing
  ownership, unsupported OS/method or lookup failure stays explicit, never current.
- Keep installed, checked latest (with check time), verified update result and
  session launch/running versions separate. Unknown running evidence stays unknown.
  Review names the exact target and source. Catalog execution uses then-latest,
  not a promise to install the previously checked version.
- New automation policies keep sessions. Preserve stored explicit choices and
  legacy missing paneSessions as restart-idle, with their actual choice visible.
  Bulk updates keep sessions and preserve per-item outcomes. Update target and
  future-shell default are separate; one-copy removal is not consolidation.
- Recovery review is action-specific: reconcile checks source/disk without an
  installer; archive-unverified acknowledges uncertainty after fresh checks and
  never claims success. Both retain all active-operation guards, including jobs
  outside the displayed bulk subset. Reload/reconnect never repeats a command.
- Preserve metadata: localhost is Console | herdr-cli-updater; public homepage
  is herdr-cli-updater — Overview & Download, subpages <Page> | herdr-cli-updater.
  Public site remains the existing dark mint editorial surface in both system
  appearance preferences; it does not acquire Console light/dark tokens.

Verification: owned fixture browser evidence, separate desktop/mobile captures
under light/dark preferences, actual public build and existing site tests.
Fixtures do not prove operational updates, session adoption or user understanding.

## October 15 supported CLI scope
Management supports exactly OmO, Pi, OMP, OpenCode, Claude Code, Codex and GJC.
This supersedes earlier 24-entry catalog and unsupported installation-card rules.
All other observed herdr sessions remain visible only in Terminal sessions, with
a neutral Not yet supported notice and no update, automation or restart action.
Reuse Panel, Badge, Notice and Facts; no new styles, dependencies or motion.
Existing installations and conversations are not removed. Public catalog content
uses the same seven-entry registry; inclusion does not promise every installation
method or same-conversation restart capability.

## 1. Identity
Preserve the existing terminal panel and focus highlight. The catalog is a compact comparison table; arrow navigation never opens extra rows.

## 2. Color
Reuse `ink` in `src/tui/presentation.ts`: cyan title, inverse focus, gray borders/hints, green verified success, yellow unknown/waiting, red failure. Terminal theme owns the background.

## 3. Typography
Use the terminal monospace font and fixed cell widths. Sanitize untrusted text and use grapheme-aware clipping. No browser font or dependency changes.

## 4. Spacing and layout
Reuse `space`: one-cell gap/padding/border, one reserved terminal column, five chrome rows. Catalog columns are CLI, installed, latest, open, working, ready. Shrink columns at narrow widths and preserve all three counts. Scroll belongs to the existing catalog viewport.

## 5. Primitives and states
`tableRow` fits columns; `panel` frames and colors output. One row per installation in normal view. Focus changes only the highlight. `d` explicitly toggles diagnostic details. Unknown is `-`; observed empty is `0`. Working means herdr observed working. Ready counts only verified update/restart eligibility and observed completed work, never merely idle status. Multiple same-family installations share family-observed counts; counts are not installation ownership.

## 6. Interaction
Keep existing arrow/Space/Enter/Esc/q controls and live job events. No animations, timers or automatic mutation. Selection and final confirmation remain explicit.
Latest checks start after local catalog discovery without blocking navigation. `c` rechecks the focused CLI; results redraw immediately. Checking, not checked and failed are distinct from known versions. Up-to-date shows the verified installed version.
Unsupported checks show `unsupported`, not a red failure. The focused installation retains its own public check failure code; background checks cannot replace that diagnosis. The catalog states that version discovery does not imply update authority. Selection refusal retains its code and says runner/native connection is required rather than suggesting refresh will enable it.

## 7. Accessibility
Keep keyboard navigation, printable text, named column headers and status text in addition to color. Verify 120x40 and 80x24 with the existing PTY/xterm harness.

## 8. Accepted limits
Stock herdr observations can show family sessions without native update authority. Unknown classification/status stays unverified. Long diagnostics may clip in narrow terminals, but open/working/ready columns remain visible. Existing current worker may require a user-controlled restart to apply backend changes; do not restart it during development.

## 9. Independent localhost web surface

### English landing and canonical product identity
Product name is herdr-cli-updater everywhere; document title/description remain
English regardless of management UI language. Public introduction lives in site/
and deploys independently to Vercel; localhost / is the management workspace.
Remove the localhost /welcome route. Only site/dist is uploaded; it contains no
API, process data, app script or localhost connection. Add canonical and og:url
only after the actual production alias is known. OG/site/application names use the exact name.
Reference: paste-20261011-073413-c2e5c7cd.png, bottom-left landing composition.
Landing only: near-black #0b0d0e, raised #1f2328, mint #22d39f/highlight #68edb2,
muted #b7c6c3, white #f5f7f6, fine #ffffff20 separators. Max width1160px,
24/48/80px spacing, hero two columns 1.05:1, 64px display/18px body, mobile40px.
Keep sheep artwork above a subtly tilted terminal illustration, radial mint glow,
pill CTA and three open feature columns. Terminal is explicitly a product overview,
not fabricated live version data. Static atmosphere, no animations. At768px stack
hero, wrap navigation, no horizontal overflow. Document owns scroll. 44px targets.
CTA opens the page's English early-access setup section, not localhost or an empty
GitHub README. Repository links remain real. Public downloads are not available;
say so instead of presenting npm install. Retain an instruction for existing app
holders to run cli-updater. No unverified
package-manager command, universal update promise or invented usage metrics.
This supersedes earlier shorter wordmark rules, not dashboard language preferences.
Homepage correction: install command and Copy belong directly beneath the hero
intro, not only in Guide. Public install.sh now downloads the packaged app; show
Bun/Node requirements rather than the obsolete provided-archive notice. Keep the
shell command one logical line, wrapping visually on narrow screens.
Use the existing dashboard AgentMark SVGs for all24 catalog entries and six home
CLI marks, rendered at build time without a client React bundle. Home representatives
are Codex, Claude Code, OmO, Oh My Pi, Gajae Code and Pi. State24 total catalog entries,
24 in-app installations on macOS; these are not24 update targets. Account login
is separate. Kiro's in-app installer is macOS-only; other platforms show a guide.
OS-aware install: detect the OS on load and show its command with a small detected
OS label. No manual OS switch. Unknown/mobile shows the common POSIX install
command and all24 CLI catalog entries with platform requirements, without asking
users to revisit. Windows instructions target WSL2, never imply
native PowerShell support. Dashboard OS comes from the service, not the browser.
Generate platform variants independently from the site build host, and remove
unmatched variants from the DOM after detection.
Features, Supported CLIs, and Guide have independent static pages /features/,
/clis/, /guide/, with aria-current on the active page. Get started
links to /guide/#install. Keep the approved landing palette and hero. Each page has
one h1, brief lead, and content specific to the navigation label. The CLI list is
generated from the app registry at build time so direct-install/official-guide
status cannot drift. It is not a universal update-support list.
081600 reference supplies the command primitive: dark bordered block, monospace
command, separate right copy button, visible focus and feedback. Adapt amber to
existing mint. Wrap long commands without splitting the clipboard value. Mobile
copy button sits below; 44px targets, 16px code, aria-live success/error. No animations.
Guide shows actual tarball installation commands, prerequisites, opening/stopping
the local service and support limits. No public installer/download exists yet;
label the required provided archive explicitly. Do not invent a curl installer.

### Language dropdown revision
Replace the two fixed language buttons with the existing themed Select, not a
native popup. Choices: System, 한국어, English. Default System follows supported
browser language preferences and languagechange; explicit choices stay fixed.
Persist preference, not its resolved language. Keep existing ko/en saved values.
This supersedes the earlier two-immediate-choices rule; no new translations.
Language alone prefers a right-side popup on desktop (>768px): 8px gap,
minimum240px width, maximum480px height, 8px viewport inset, internal scroll.
Clamp its vertical position to the viewport. If right-side space is insufficient
or on phones, retain the existing above/below placement. Other Selects stay unchanged.

### Product metadata and compact type revision
GitHub and Star now share one footer link: local GitHub mark, GitHub label,
and outlined star. Clicking opens the repository and remembers the click locally
under a repository-specific key. Filled star uses --star (#8a6200 light,
#f2c94c dark); it is not proof of a GitHub Star. State is described by accessible
link text/title and a short visible local-record note. No OAuth or remote mutation.
Keep the same 44px target, focus ring, neutral hover and no decorative motion.
The October 11 `055733` reference puts a muted monospace version pill next to
the product wordmark. Use this package's version, not a sample version or an
observed CLI version. Repository and Star actions share the configured product
GitHub repository; an absent URL is explicitly unavailable, never guessed.
Star opens GitHub for the user's action; it does not star automatically or show
an invented count. Keep these actions in the navigation footer on both sizes.
Use local herdr-web-ui agent marks with their MIT notice beside catalog names,
32px in a 40px neutral tile; Letta uses a named L monogram when no mark exists.
Typography becomes h1 24, h2 20, h3 16, body 14, secondary 13, caption 12px.
Phone body is 15, secondary 14, caption 12px; inputs stay16px to avoid iOS zoom.
Click targets remain44px on touch. Version pill12px, border1px, existing radius.

### CLI-first workspace and selection revision
Consolidation-first revision: installed cards open Manage (one copy) or Organize
installations (multiple copies); only undiscovered entries lead with Install.
Catalog details are an in-page workspace with Back, never a long nested modal.
Lead with comparison and retained-install choice, then one review showing update
target, optional terminal default, removal candidates and held copies. Existing
copies are preferred; missing methods offer the existing installer and return to
this workspace on verified success. Advanced independent controls are collapsed.
Cleanup starts only after fresh verified selection/default transition; each actual
removal remains separately reviewed. Failure stops the sequence. Remaining copies
mean partial completion, never full consolidation. Reload observes jobs without
replaying approvals. Reuse current tokens and single-column card interiors.
Role separation revision (October 14): installation cards contain identity/version,
installation count and actions for Details and additional installation only. Stack
identity, actions and task notices vertically; never let action text size the title
column. Main remains the scroll owner; bounded detail dialogs own their body scroll.
Details separates installed copies/removal, the one update target, and terminal
default execution. Install dialogs never offer a shell-default checkbox. Shell
default is a separate revision-bound confirmation for an explicitly chosen copy;
it must not select that copy for updates. Automation only schedules the existing
update target and links to catalog details to change it. Show observed PATH and
configured future-shell default separately, including mismatch with update target.
Reuse stack/cluster, Select, Facts, Notice and Button tokens, no new dependencies.
Long/uncertain-state notices own a full card row at every viewport width. Validate
the reported Oh My Pi failure state on desktop cards as well as phone layouts.
Official installation revision: no new CLI payload or launcher belongs inside the
updater directory. Installation review selects an official method, links its source,
shows destination and optionally configures the new-shell default. Existing copies
remain; success transfers only the selected management/automation target. Display
the shell default separately. One automatic/bulk target per CLI, other copies are
manual. Existing app-owned copies show migration, never automatic removal. Reuse
Select, Dialog, Facts, Notice and existing spacing; no new visual tokens.
Bulk actions sit above the installed CLI list and apply to the whole installed
catalog, not the search filter. Reuse cluster, stack, Badge, Notice and Dialog.
Whole checks never mutate installations. Whole updates first show a revision-bound
review of current/checked latest versions and excluded rows with reasons, then
require one explicit confirmation. Execution is sequential and always keeps panes.
Show per-row progress, success, failure, uncertainty and exclusions outside the
dialog as well. Browser reload must not resubmit a batch. No new tokens or motion.
The installed catalog is the dashboard's primary list, including inactive and
unsupported CLIs. Group catalog installations once per CLI; show selected version,
latest check, family-level herdr pane count, automation and installation count.
Retain engine-only installations only when no catalog path matches. Unknown latest
and unavailable observations must not imply current or zero. Reuse cli-entry,
Facts and revision-bound Dialog. Checking never enables automation or installs.
Manual catalog updates require a source-verified plan and separate confirmation;
session restart is not implicit. No new visual tokens or decorative elements.
Dashboard revision: lead with three compact summary metrics (confirmed updates,
open operations, observed active sessions). Missing/stale observations display
unknown/last observation, never a healthy zero. Use current monochrome tokens,
three columns desktop and stacked narrow-phone layout. No new chart or animation.
Update installation rows hide filesystem paths until Details. Primary action is
Check latest, Prepare update, Review preparation, or View progress based on real
operation state. Uncertain operations route to inspection, never a retry shortcut.
Session count/automation label open their detail tabs directly. Preserve explicit
final execution confirmation. Observations outside update scope are grouped by
CLI, with separate matched-catalog/unmatched counts; grouping conveys no ownership.
Use a compact list, not repeated PID/path cards. Complete diagnostic data remains
in Sessions. Catalog links are display evidence only, never update/removal authority.
The 075000 screenshots supersede inline catalog expansion: it strands large
blank grid cells and breaks scanning. Catalog cards stay compact; Details opens
one bounded modal for the chosen CLI. Keep grid position/scroll on close. Details
groups installed state and setup data; omit nonexistent executable/ownership for
undiscovered installs, never equate not discovered with proven absent. Source is
a named link, not a repeated raw URL. Retain exact real paths and version errors.
Shared dialog has a sticky title/close row and a scrollable body, maximum560px
wide/viewport minus32px high. Initial focus lands on its non-interactive heading,
not an action or input. Remove input autoFocus. Restore focus with preventScroll.
Track keyboard versus pointer input in the root: pointer opens/closes have no
focus ring; Tab/arrow/Enter keyboard use retains visible focus. No blur-all hack
and no removal of keyboard focus containment or Escape behavior.
Catalog primary actions now say Install / Remove / Setup guide without ellipses.
Use a shared minimum96px width and44px height; guides are outlined button links
with the same footprint. Explain final confirmation once above the list.
Collapsed version failures use Version unavailable; full cause stays in Details.
Session and automation headings reuse AgentMark, 24px beside the CLI name with
an 8px gap; unknown identities have no invented provider mark. Persist only the
selected top-level tab in browser localStorage (cli-view), validating against the
five supported tabs. Invalid/missing preferences default to dashboard. Never
persist tokens, confirmation state or pending commands with the tab preference.
Desktop navigation sets the dialog open attribute without show(), so initial
render does not autofocus the brand link. Mobile explicit showModal() preserves
modal focus containment; keyboard focus rings are never hidden to mask this bug.
Installation catalog uses a compact two-column grid above 768px and one column
on phones. Each card keeps the CLI mark/name, installed version/status and primary
install/remove action visible. Native Details/Summary reveals description,
paths, source, ownership, timestamps and guidance. Cards align at the top;
opening one must not stretch its neighbor. Use 16px padding/gap and existing
44px targets; never shrink typography to increase density.
The user approved restructuring around CLI rows rather than disconnected summary
cards. Each installation row shows installed/latest evidence, linked running
sessions, policy and verified update time. Unlinked observed processes stay in
a separate group and never imply installation ownership. Inline details scope
overview/sessions/history/automation to the selected installation. Global views
remain available. Phone navigation lives behind a compact menu, not a permanent
wall of links. Existing confirmations and version evidence boundaries remain.
Language uses two immediate choices. All other dropdowns use one themed Select
primitive: visible label/chevron, selected check, active row, disabled state,
Arrow/Home/End/typeahead, Enter/Space commit, Escape cancellation and Tab exit.
Popup is viewport-bounded and placed above when below space is insufficient;
outside clicks close it. A popup within a modal remains inside that modal.
Do not submit a surrounding form from a select button. Presets hide numeric
input; Custom explicitly opens it even if the existing interval equals a preset.
First-check timing uses two visible radios. No native select popup remains.
Popup tokens: max-height 280px, gap 6px, shadow 0 12px 36px #0003, neutral border,
44px option minimum, 12px radius. Focus and selected rows use existing ink washes.

### October 11 language, appearance and identity revision
The latest reference `paste-20261011-041655-ec4d4932.png` supplies the sidebar
language selector and simultaneous sun/moon/monitor appearance options, not its
account-management content. Keep the neutral charcoal workspace, stronger
section hierarchy, compact controls and mint connected indicators. Identity is
an original terminal-prompt / upward-arrow monogram, drawn as a small vector
with a mint tile; no borrowed opencodex mark. Product name stays herdr updater.
Language supports Korean and English, browser default with explicit persisted
choice. Translate interface and dates, never user terminal output or identifiers.
Preferences stay at the sidebar foot and collapse into a native disclosure on
phones so they do not consume the working viewport. Theme is one native radio
group with light/dark/system options visible together, arrow-key navigation,
44px hit areas, localized labels and a visible selected state. System mode
tracks OS changes; language and theme survive reload. No settings trigger jobs.
New tokens: brand tile 40px, brand mint #78cda6 / ink #17382a, count pill 24px;
surface elevation 0 1px 2px #00000008. Main radius remains 12px. Localized text
uses word-break:keep-all plus overflow-wrap:anywhere for narrow edge cases.
No remote assets, added dependencies or decorative motion.

This section applies only to `web/`. Sections 1-8 remain the terminal contract.
The opt-in web policy modes do not change terminal automation or controls.

### Direction and references
An operational workspace for a developer managing their own CLI installations.
The approved screenshot `paste-20261011-033944-06c616f7.png` is the visual contract:
neutral charcoal navigation/header, fine gray dividers, compact rows and small
inline outlined actions. Mint belongs only to connected/verified status, never
large action panels. Unknown and waiting use explicit text, not success color.
No hero, synthetic metrics, remote assets, brand copies or decorative motion.
Read references: frontend `taste-skill.md`, `linear.app.md`, `layout-skill.md`;
[StyleGallery fixed-sidenav-shell](https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/fixed-sidenav-shell.md).
The fixed navigation precedes the main scroll owner in DOM order. Main is bounded
by 100dvh with min-block-size:0; console output is a separately named, bounded
scroll region. Below 48rem, navigation becomes a wrapping five-item top bar.

### Tokens
CSS variables in `web/styles.css` are the sole visual values. Light canvas
#f6f6f5, surface #ffffff, rail #f0f0ef, inset #ededeb, text #242424,
muted #636360, border #d9d9d6, accent #292929 and wash #e4e4e1.
Dark canvas #212121, surface #252525, rail #1b1b1b, inset #2b2b2b,
text #ededed, muted #b1b1ad, border #414141, accent #ededed, wash #333333.
Light success #216847 and dark success #78cda6; neutral warning tokens use
the muted ink/inset. Red failure #a52b36 / #ffabb3 is reserved for errors.
Theme follows system unless explicitly set to light or dark; persist theme and language.
Typography: local system Korean sans (`Apple SD Gothic Neo`, `Malgun Gothic`,
system-ui), local monospace (`SFMono-Regular`, Consolas, monospace) for version
and output. Scale h1 28, h2 22, h3 18, h4/body 16, small 14, caption 12px;
line height 1.55 and weight 400/600/700. Space scale 4/8/12/16/24/32/48px;
radii 6/12/full, border 1px, focus 3px + 2px offset. Inline desktop actions
are 36px, touch actions 44px; icon 18px, header 64px, fact width 160px.
Layout widths: rail 232px, content maximum 1160px, dialog 560px, console 240px;
responsive breakpoint 768px. Dialog uses a restrained shadow and dim backdrop.
The main scroll owner has a neutral sticky header. Navigation has five items
and wraps on mobile. Rows wrap paths and facts instead of horizontal scrolling.
Dashboard uses two columns on desktop with installation and next-check panels
first, then a four-session preview and recent history. The sessions view retains
the complete census. Mobile uses one column, 17px body / 15px secondary /
14px captions and a compact theme row; no horizontal navigation clipping.

### Primitives, states and composition
`Shell` contains semantic navigation, theme selector and a single main region.
`Panel` groups a task; `Button` has primary/secondary/danger, disabled and busy
states; `Field` provides a visible label; `Badge` always includes status text;
`Notice` expresses loading, empty, stale/offline, error and uncertainty without
changing data into success; `Facts` distinguishes installed/latest/launch/engine
evidence. `Dialog` uses the native modal dialog with initial focus, Escape,
focus containment and restoration. A pending request disables mutation controls.
`Icon` supplies local SVG navigation glyphs. `SectionHead` combines a compact
section heading, count and optional inline action. Dashboard groups installed
CLIs, active terminal sessions, next automatic checks and persistent operations.
Installation verification time comes only from update operations' `installedAt`;
operation completion/restart time must never stand in for installation time.
External metadata is evidence-only: absent family/tty/start/running versions
stay explicitly unknown. Managed start time is not derived from last observation.
The test-only primitive showcase must precede product screens. No fixtures are
imported by the production entry.

### Interaction, safety and accessibility
Removal support is a source hint, never authorization. Unsupported dependency or
unverified standalone rows show a disabled Remove button plus a dialog with
the specific reason and official guide. Keep the existing card and touch tokens.
Standalone confirmation names the exact executable, payload and preserved archive;
explain that removal archives bytes and preserves configuration, other versions
and shell PATH. Referencing configuration paths block the final confirmation.
Catalog removal reuses the revision-bound Dialog, neutral review button and
danger final confirmation. Show exact installation path, removal method and
preserved data before approval. Unknown ownership routes to official guidance;
User-facing actions say Install… / Remove…, then Install CLI / Remove CLI in
the confirmation. Do not expose plan revision numbers. Ready history states
explicitly say the CLI has not yet been installed/removed; receipt states stay
distinct from the currently discovered installation. Display Checked before
the disk-version timestamp. These copy changes do not weaken confirmation.
never equate executable discovery with deletion authority. Persistent removal
jobs show ready/removing/completed/uncertain states without automatic retries.
Disk version shows probe state/time separately from historical installation proof.
Removal dialog facts use a single column so exact long filesystem paths remain
readable rather than breaking across three narrow columns. User-provided sheep
symbol replaces the old generated brand glyph at the existing40/32px slots;
use supplied favicon sizes and180px apple-touch icon, preserve version and links.
No automatic mutation retry. One requestId per user intent; reconnect and reload
observe snapshots only. A lost response is an uncertainty notice and remains
blocked until a fresh snapshot is observed and the user dismisses it deliberately.
Token fragment is exchanged once then removed; it is never stored or rendered.
Invalid/expired access asks users to reopen via CLI. Foreign sessions have no
mutation controls. Dialogs capture the operation revision or session generation;
stale confirmations cannot silently follow newer terms. Server remains the
authority for cancellation and eligibility. Updates show exact target, affected
sessions and separate restart choice. Automation starts off, and enabling it
requires a consequence review. No executable commands or worker credentials in UI.
Policy onboarding explicitly states installation alone enables nothing. First
check is selectable now/after interval. Off saves immediately with no enabling
confirmation; existing in-flight work is separately observed, not silently cancelled.
Use visible labels, keyboard focus rings, status text in addition to color,
aria-live notices, native form validation, wrapping paths/output and 44px targets.
Reduced motion is static. No animations, so transitions require no timing probes.

### Verification boundary and accepted limits
Parent owns dependencies, build/server integration, shared public types and final
integrated QA/reviews. This unit uses only React 18, ReactDOM and native web APIs.
No router or state library. Test-only snapshots can exercise all visual states,
but are not evidence that the genuine service runs those operations. Desktop
1440/1920, tablet 768 and phone 390 light/dark plus focus/dialog/long-content
checks are recorded in `web/QA.md`. Live service, genuine session/update and
packed-package QA remain parent-owned; no integrated PASS can be inferred from
the showcase. External running version stays unknown, never inferred from disk.
