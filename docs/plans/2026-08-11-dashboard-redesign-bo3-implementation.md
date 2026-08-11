# Dashboard Redesign + Best-of-3 Series Implementation Plan

**Goal:** Turn the single-page dashboard into a six-view shell with a left nav,
add sort/search/date-range/pagination to the match table, replace 25 native
dialogs with one component, and group matches into best-of-N series — with no
feature dropped, no build step, and the replay core untouched.

**Architecture:** Two module tiers. Pure logic (`series.js`, `table.js`) ships as
classic scripts with a `module.exports` tail so `node --test` can reach it; view
code ships as ES modules behind one `<script type="module">`. Classic scripts run
before any module, so the existing `window.RA*` globals are always present, and
the one classic→module call is a callback, not a dependency.

**Tech Stack:** Plain HTML/CSS/JS. No npm, no bundler, no framework. `node:test`
for the pure tier. Chrome MV3, `script-src 'self'`.

## Status

Phase 1 (tokens) landed in `4d7c4bb`. Phases 2–8 outstanding.

## Deviation from the plan-writing convention

This plan does not inline complete code blocks for every task. The convention
exists so a plan can be handed to someone who was not in the conversation; this
one is being executed immediately by its author, and reproducing ~5,000 lines of
implementation here first would be writing the work twice. What it does carry is
the file map, the per-task acceptance criteria, the exact commands, and the
invariants a reviewer needs. Where a contract has to be identical across tasks —
state shape, series field names, the detection rule — it is written out in full.

## 1. Current state

- `dashboard/dashboard.js` — 2207 lines, one IIFE, no exports.
- `dashboard/dashboard.html` — 179 lines; 13 classic `<script>` tags then
  `dashboard.js`.
- `dashboard/dashboard.css` — 344 lines before phase 1; tokens now at the top.
- Tests: `node --test 'test/*.test.js'` → **226 passing**. The quoting matters;
  plain `node --test test/` is broken on this Node version.
- No `package.json`, no CI.

## 2. Settled decisions

Full reasoning is in `docs/specs/2026-08-11-dashboard-redesign-bo3-design.md`.

1. Two module tiers, split by "can this be tested without a DOM".
2. Series detection runs in the dashboard, not `content.js` — which has two
   finalisers, and the `beforeunload` one would silently miss every tab-close.
3. `replay-html.js` is chrome and is in scope. `replay/replay-core.js` and
   `replay/replay-timeline.js` are not touched.
4. The replay modal stays full-viewport. The handoff's fixed 1180px would shrink
   the stage, which the current CSS deliberately maximises.
5. The result select stays editable on a live match. The handoff removes it; this
   round drops no controls.
6. `schemaVersion` is not bumped — nothing reads it and it lives in
   an out-of-scope file.
7. The popup ships, and `background.js`'s now-dead `action.onClicked` listener is
   removed in the same commit.

## 3. File map

### Created

| File | Single responsibility |
|---|---|
| `dashboard/series.js` | detection rule, grouping, series records, series stats, suggestion scan. Pure. |
| `dashboard/table.js` | sort, search, date range, pagination over an array. Pure. |
| `dashboard/state.js` | the one state object + `subscribe`/`emit` |
| `dashboard/storage.js` | every `chrome.storage` / `chrome.runtime` call |
| `dashboard/fmt.js` | champion, deck, duration, bytes, counts, dates |
| `dashboard/dialog.js` | the dialog component |
| `dashboard/filters.js` | the global filter row |
| `dashboard/shell.js` | header, menus, banners, nav, footer, view switching, delegation |
| `dashboard/view-overview.js` | tiles + three aggregate tables |
| `dashboard/view-matches.js` | match table, expanded row, selection bar |
| `dashboard/view-series.js` | series tiles, suggestion strip, series table |
| `dashboard/view-replays.js` | capture diagnostics |
| `dashboard/view-shares.js` | shared-links register |
| `dashboard/view-settings.js` | six settings cards |
| `dashboard/share-ui.js` | share panel component + share flow |
| `dashboard/main.js` | entry point |
| `popup/popup.html` `.css` `.js` | the toolbar popup |
| `test/series.test.js` | detection, stats, renumbering |
| `test/table.test.js` | sort, search, range, pagination |

### Modified

| File | Change |
|---|---|
| `dashboard/dashboard.html` | new shell markup; module entry replaces `dashboard.js` |
| `dashboard/dashboard.css` | tokens (done) then the full component sheet |
| `dashboard/replay-html.js` | `renderShell` + `openModal` restyled; handle contract unchanged |
| `manifest.json` | `action.default_popup` |
| `background.js` | remove the dead `action.onClicked` listener |
| `README.md` | document the views, series, and the popup |

### Deleted

| File | When |
|---|---|
| `dashboard/dashboard.js` | last, once every caller is ported |

## 4. The contracts every task shares

### Series fields, written exactly once, spelled identically everywhere

```
seriesId     : string | null
seriesGame   : 1..n   | null
seriesFormat : 'bo3' | 'bo5' | null
seriesSource : 'auto' | 'manual' | null
```

### Settings keys added

```
seriesDetect        : true
seriesWindowMinutes : 45      // clamped 5..240
seriesFormatDefault : 'bo3'   // 'bo3' | 'bo5'
```

### The detection rule

Walk matches in `startedAt` order. Join a match to the previous match's series
when all of: same `opponentName`; same `mode`; gap from previous `endedAt` to
this `startedAt` within the window; no other match between them; the previous
series is not already complete (format length reached, or one side has taken it
— 2 in a Bo3, 3 in a Bo5); neither match is `seriesSource: 'manual'`.

## 4a. What adversarial review changed

The first draft of this plan was reviewed by a subagent briefed to argue against
it. Five objections were upheld and changed the design; they are recorded here
because each one is a trap the next person would otherwise fall into.

1. **`dashboard.js` cannot survive the middle phases.** It has 16 top-level
   `$("#id").addEventListener(...)` calls with no null check. The moment phase 2
   replaces the header markup, the first one throws and **the whole IIFE aborts**
   — including `load()` and the `storage.onChanged` listener. So `dashboard.js`
   is renamed to `dashboard/legacy.js`, every wire-up is null-guarded, and each
   phase drains its own slice out. Every commit stays shippable, and "nothing was
   dropped" is checkable at every commit rather than only at the last one.
2. **The build order had no Overview phase.** It is the first view on open, and
   it hosts `Detect decks from cards played` — the only entry point to the
   dialog that phase 4 exists to justify. Added.
3. **Matches must be built at its final width.** Phase 7 adds a selection
   checkbox and a Series column; building a 10-column grid first means rewriting
   the grid, the sort headers, the row template and the expanded row.
4. **Auto-detected series must not be persisted.** See the design document — it
   would fight `content.js`'s 3-second save in a permanent write loop. Derived at
   render time instead; only manual groupings are written.
5. **`storage.js` must be the only writer**, with the read-only guard inside it,
   and the six existing bypasses migrated *before* any new view is built.

Two smaller ones: the pure formatters go into the existing `format.js` rather
than a new `fmt.js`, and `readStoredShares()` must stay uncached — the share flow
documents at length why the read happens on the click, and caching it would
reintroduce double-uploading the same replay.

## 5. Tasks

Each task ends with a commit. Tests run before every commit. Every task's
acceptance includes: *every control in the handoff's `1k` coverage table is
either present in a new view or still served by `legacy.js`.*

### Task 1 — tokens *(done, `4d7c4bb`)*

### Task 2 — `series.js` + tests *(done)*

Pure, tested, no view. Built before the shell so the nav's Series count and the
Matches series badge have a source when they are needed.

### Task 3 — `legacy.js`, `state.js`, `storage.js`

Rename `dashboard.js` → `legacy.js`; null-guard all 16 wire-ups. Introduce
`state.js` and `storage.js`. Migrate the six direct `set({matches})` bypasses
(`legacy.js:1507, 1534, 1647, 1694, 1745, 1774`) onto `storage.writeMatches()`,
which throws in read-only mode. Move the pure formatters into `format.js`.

**Accept:** suite green; a source-shape test asserts no `storage.local.set({ matches`
outside `storage.js`; the dashboard still works exactly as before.

### Task 4 — shell, header, banners, nav, footer, Overview

Six-view shell. All six header buttons survive, regrouped as `Export ▾`,
`Import JSON`, `Archive ▾`, `⋯`; both hidden file inputs unchanged. Banner stack
keeps its exact conditions (≥3 matches AND (never backed up OR >14 days) AND
auto-backup off AND not dismissed in 7 days). Left nav 212px with the four live
counts and the read-only capture card — which needs `ra:visual:list`, so that
query moves into `storage.js` here rather than in the Replays task. Current view
persists in `settings`. Overview: five tiles, three aggregate tables with the
four-step ramp, italic `— unlabelled —` rows, the truncation footer, the deck
paragraph band and its two buttons.

**The filter row and the search field are static DOM that `render()` never
rewrites.** `content.js` saves every 3 seconds during a live match, which drives
`storage.onChanged` → `load()` → `render()`; a search input inside re-rendered
markup would lose its caret and value every three seconds.

**Accept:** all six views switch client-side; the view survives a reload;
Replays and Shared links are *removed* from the nav in archive mode, not
disabled; typing in the search field survives a live match's saves.

### Task 5 — Matches, at its final width

Twelve-column grid, including the selection checkbox and the Series cell, both
inert until Task 9. Sort on every header (date descending default, stable),
search over opponent/room/champion/deck, date-range preset menu with a custom
option, 25 per page with **page clamped whenever the set shrinks**. The count
line, `clear filters` link and the manual-marking sentence above the table. Deck
source dot legend under it — keeping both the four-colour dot mapping and all
seven `DECK_SOURCE_LABEL` wordings, which the expanded row shows as a sentence.
Expanded row: verdict badge, coaching sentence, seven-row metrics table, coverage
line verbatim, game log with three actor colours, deck picker + apply, notes with
debounced autosave, replay buttons, share panel. Two-column, collapsing to one
under 900px.

**Accept:** every one of today's 13 columns is on screen; open rows survive a
re-render; `＋ New deck name…` is an inline field, not `prompt()`; no-results and
empty states render their own copy.

### Task 6 — replay modal chrome

`replay-html.js`'s `renderShell` and `openModal` restyled: head with the result
word in its status colour, `TRUNCATED` tag banner, chapter chips above the
transport with unrecorded turns as flat text, restyled transport. `Share a link`
in the head is a **new control** and renders the same share panel component.
`wireControls`' handle contract is unchanged; the modal stays full-viewport.

**Accept:** `replay/replay-core.js` and `replay-timeline.js` byte-identical; the
hint line and three body states still verbatim; the stage still refits.

### Task 7 — dialog + toast, and the native call sites

`dialog.js`: backdrop, focus trap, Esc, backdrop click, **focus returned to the
invoking control**. `toast.js` for the 14 one-line acknowledgements. Nine true
dialogs, including the deck-detection report with inline name fields — which
runs both `suggestLabels` and `clusterDecks` and reconciles them, where today the
code takes one path or the other.

Two rules enforced at every converted site: **no `await` between reading a target
set and writing it** (re-resolve by id afterwards), and `storage.onChanged`
defers `load()` while a dialog is open. Archive & clear rebuilds its bundle after
the confirmation resolves. The cluster-naming `prompt` loop is deleted, not
awaited.

**Accept:** no `confirm(`/`prompt(`/`alert(` anywhere in `dashboard/`; the
detection report applies nothing until Apply is pressed.

### Task 8 — Settings

Six cards. Every long `title` tooltip in `dashboard.html:33, 34, 53, 57, 60, 63`
becomes visible body copy. Same clamps: retention 1–500, ceiling 16–4096 with
blank allowed, same permission request. Three new settings keys: `seriesDetect`,
`seriesWindowMinutes`, `seriesFormatDefault`.

**Accept:** every setting reachable today is reachable here, with the same
clamping behaviour; every control disables in archive mode.

### Task 9 — Replays and Shared links

Diagnostics: eight columns, `—` for never-recorded, all three footer rows, the
two intro tiles linking into Settings, the `?` reveal on truncated and error rows
replacing today's `title`, and the state legend replacing three tooltips — using
the code's real state names (`complete`, `truncated`, `error`, `recording`).
Shares: notice above the table, relative expiry with a dot, re-check as an
`aria-live` region, expired rows sunk with the link struck through and Copy
disabled, `Clear from list` on expired rows only and still confirming.

**Accept:** both views hidden in archive mode; a never-recorded value never
renders `0` or `NaN`.

### Task 10 — the share panel's seven states

Not a lift-and-shift. Today's panel has a bare progress paragraph and a flat
"another share is running" string. This builds: the four-bullet disclosure with
its `Nothing has been uploaded yet.` footer, the 5px progress track with
`Step N of 5`, per-state border colours, and **state 7 naming the match currently
uploading** — which matters more once pagination can scroll the running share off
screen while `shareBusy` still holds the global lock.

**Accept:** one state object per match id drives both the row and the modal.

### Task 11 — Series view and manual tagging

Selection column and bar in Matches, series badge in all seven states, series
block in the expanded match, Series view with five tiles, the suggestion strip
with **persisted** dismissals, expandable rows sharing the grid. Export CSV gains
four columns and Export JSON the four fields, both computed at export time.
Deleting a match renumbers its series.

**Accept:** `test/series.test.js` passes; a manual grouping is never revised;
every mutating control in the view, including the per-sub-row result editors,
disables in archive mode.

### Task 12 — popup

`popup/` trio plus `action.default_popup`. Remove the dead `onClicked` listener
and correct `manifest.json`'s now-false `default_title`. Four states: in game,
idle, no matches, recording off. **`In game now` needs a staleness cutoff** — a
force-killed tab never runs `beforeunload`, so `endedAt` stays null forever and
the popup would otherwise claim "in game now" indefinitely.

**Accept:** the popup reads live data even in archive mode; the dashboard is
still reachable in one click.

### Task 13 — verification

Full suite, CSP check with the extension loaded unpacked, archive-mode sweep over
all six views, replay modal refit check, and the panel `1k` coverage table walked
row by row.

## 6. Definition of done

- `node --test 'test/*.test.js'` — 226 baseline plus the new series and table
  tests, all passing.
- No `confirm(`, `prompt(` or `alert(` outside `dialog.js`.
- No inline script, no `onclick=`, no remote URL in any dashboard or popup file.
- `replay/replay-core.js` and `replay/replay-timeline.js` byte-identical to
  `origin/main`.
- `content.js`, `content.css` and `share/worker/public/` unchanged.
- Every row of panel `1k`'s coverage table has a verified home.
- `body.read-only` disables every mutating control in all six views.
