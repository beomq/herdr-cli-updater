# Terminal presentation contract

The existing five TUI components remain pure text/state projections. The host
composes them into one ANSI panel using `presentation.ts`; it sanitizes all
component and wire text BEFORE adding trusted style sequences. `HostFrame.text`
remains a printable, uncolored projection for consumers. No dependencies,
browser code, animation or color-only state.

## Tokens and primitives

Use the terminal's monospace font and default foreground/background. ANSI tokens:
`normal` reset (0), `title` bold cyan (1;36), `muted` gray (90), `focus` bold
reverse (1;7), `success` green (32), `warning` yellow (33), `error` red (31).
Border uses muted ink, focus uses a full-row reverse wash, and `[x]` still means
deliberate selection while `>` only means keyboard focus. Every colored line
ends with reset; panel resets before drawing and terminal cleanup resets again.
No palette-dependent background or color-only eligibility claim.

Hierarchy: H1 host title/tabs (bold cyan); H2 component heading (bold cyan);
H3 observed result (semantic ink); H4 list columns (bold cyan); body normal;
small/caption keyboard hints and panel border muted. These are terminal styles,
not font sizes. Spacing tokens are one-cell gap, one-cell panel padding,
two-cell details indentation and four-cell catalog indentation. Borders are
ASCII `+`, `-`, `|` (one cell); no radii, shadows or transitions.

`panel` owns border, padding, clipping and trusted styles. `tableRow` owns
sanitized, grapheme-safe column padding. `catalogColumns` assigns CLI 22%,
installed 16%, latest 16%, panes 8 cells and eligibility the remaining width,
with minimum widths 14/10/10/8 and one-cell gaps. Smaller terminals clip rather
than wrap. Panes show physical/observed counts, never an inferred restart count.
The installed and latest columns retain unknown evidence; the focused row's
detail lines preserve full observed reasons, running versions and check failures.

Catalog eligibility is explicitly `inspect` (or `check`/`unknown` for verified
read-only check capability), NOT permission to update or restart. Full effect
eligibility is shown only by SelectComponent's existing authenticated snapshot
and guards. Fallback discovery has no readiness metadata and shows `inspect`.
Never infer effect eligibility from a newer version, runtime count or color.

Tabs are `[1 Catalog]` and `[2 Jobs]`; the owning tab remains active on selection,
job progress and inspection subviews. Keep the existing keyboard routes.
Confirmation, progress and results retain their own headings, observed versions,
selected effects, waiting reasons, verification counts and explicit actions.

The spacing unit is one terminal cell and one line. Child content uses two cells
of indentation; catalog fields use four. Titles, primary summaries and keyboard
hints each occupy one line. A scrollable body sits between the summary and hints.
There are no pixel sizes, shadows or rounded surfaces in this terminal system.

Order content by the next decision: CLI name/channel, observed versions, update
or job outcome, affected panes, next action. `d` toggles diagnostic details;
catalog Enter/Space also retain their existing expansion shortcuts. IDs,
revisions, capabilities and receipt mechanics belong in details, never in the
default primary summary. Socket/pane labels may identify a deliberate restart
target; private session/process references must never be displayed.

Selection Enter opens the effects confirmation, then another Enter submits it.
The legacy review shortcut remains available. Navigation away from confirmation
revokes it. Mode changes clear deliberate restart selections. Presentation never
changes eligibility, fresh host validation, cancellation safety or stream ownership.

Fit output by terminal cell width, sanitize controls and reserve the host's last
physical column. Panel interior is physical columns minus five (free column,
two borders, two padding cells). Body height is physical rows minus five
(two borders, title, status, host actions). Keep summaries and actions outside
the scrollable body. Use the same layout at 80x24 and 120x40; smaller terminals
clip, without overflow. Panels of five columns or fewer, or fewer than four rows, degrade
to clipped plain text without attempting a broken border.
Show progress as observed steps/counts, not invented percentages or versions.

Unavailable observations remain distinct from a successful empty list. Offer
refresh/retry and inspection of an observed error; do not guess its root cause.
Actual xterm screenshot QA is owned by the parent task.

Accepted constraints: ANSI color interpretation depends on the user's palette;
monochrome still exposes all states. Fixture rendering and TUI tests validate
layout and safety locally; actual herdr userflow screenshots remain parent-owned.
