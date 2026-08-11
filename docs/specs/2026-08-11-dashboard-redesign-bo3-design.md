# Dashboard Redesign and Best-of-3 Series — Design

Status: accepted
Date: 2026-08-11

Supersedes nothing. The visual-replay and replay-sharing designs stay in force;
this changes the chrome around them and adds one feature to the match record.

## Goal

Two things, in one round.

1. **Restructure the dashboard.** Today it is one scrolling page: header, a filter
   row that also holds four settings, five stat tiles, three aggregate tables, a
   13-column match history, and two panels bolted to the bottom. It becomes a
   six-view shell — Overview · Matches · Series · Replays · Shared links ·
   Settings — with a sticky header, a left nav and a global filter row. A toolbar
   popup is added.
2. **Group matches into best-of-N series.** Automatically, with manual override,
   browsable in a sixth view.

**No feature is dropped.** The design handoff's panel `1k` carries a 23-row
coverage table mapping every current control to its new home; that table is the
acceptance checklist for this work.

### Constraints that shaped every decision

- **MV3 CSP** — `script-src 'self'`. No inline script, no `onclick=`, no CDN, no
  remote fonts, no remote CSS.
- **No build step, no framework, no npm.** The repo has no `package.json`.
- **Dark only.** No light mode, no `prefers-color-scheme` branch.
- **`body.read-only` archive mode** must visibly disable every mutating control.
- **The in-game overlay keeps `class="ra-tracker-block"`.** This is what excludes
  the extension's own UI from replay capture, and it is enforced by a test —
  `test/vendor-contract.test.js:86-101` reads `content.js` as text and asserts
  every `id = "ra-tracker-*"` has the block class within ~200 characters.
- **`replay/replay-core.js` and `replay/replay-timeline.js` must not change** and
  must not learn anything about the dashboard chrome. `CONTEXT.md` already draws
  this line: the *viewer core* "knows nothing about the dashboard or about
  sharing"; the *chrome* is "the UI wrapped around a viewer core".

## Where the handoff disagrees with the code

The handoff was written from a description of this repo, not from the repo. Its
own provenance note says the code wins. These are the differences found, and what
this design does about each.

| # | Handoff | Code | Resolution |
|---|---|---|---|
| 1 | "nine `confirm`/`prompt`/`alert` call sites" (README and panel 1k) | **25** | Build the dialog for all 25. This is the largest cost under-estimate in the handoff. |
| 2 | "seven header buttons become three" | six buttons + 2 hidden file inputs | Six. |
| 3 | Matches grid is 10 columns | the same document adds a Series column and a 26px selection checkbox | 12 columns; grid restated below. |
| 4 | replay states `ok` / `truncated` / `error` | `complete` / `truncated` / `error` / `recording` | Use the code's names; the legend gains `recording`. |
| 5 | a live match has "no result select" (README, and again in panel 1j) | the select is rendered unconditionally (`dashboard.js:378`) — but an edit to it is silently reverted within ~3s by `content.js`'s dirty-save, which replaces the record wholesale | **Keep the control, and fix it.** The handoff is right that it should not be a plain editable select; it is wrong that the answer is to remove it. Rendered as the handoff's dashed *in progress* chip, with the editor available and its write routed so `content.js` does not revert it. Reported as a pre-existing bug, not a behaviour being defended. |
| 6 | aggregate tables truncate to 5 rows with "see all" | every row renders | Ship "see all", but default the cap high enough that nothing is hidden on a normal history; the link expands in place. |
| 7 | replay modal is a fixed 1180px dialog | the modal is deliberately full-viewport so the stage gets every pixel (`dashboard.css:161-201`) | **Code wins.** Restyle the chrome, keep the sizing. |
| 8 | "bump `schemaVersion`" | `schemaVersion: 3` exists at `content.js:598` and is **read nowhere**; bumping means editing `content.js`, which is out of scope | Do not bump. The handoff's own reasoning — absent means "not in a series" — is why no migration is needed either way. |
| 9 | — | `endpointProblem()` says "The share endpoint **in Settings**…", but that field was removed in `bc229ec` | Reword; there is no such field. |
| 10 | "Rift Atlas Tracker" | "Rift Atlas **Stats** Tracker" | Use the real name. |
| 11 | detection runs "on match end" | match end is `content.js`, out of scope this round — and it has a second, divergent finaliser (`beforeunload`, `content.js:1007-1020`) that never calls `endMatch` | **Detection runs in the dashboard.** See below. |
| 12 | panel 2c: "three fields", "CSV gains three columns" | four fields are listed | Four fields, four CSV columns. |
| 13 | "one wording per `deckSource`", 7 sources | only one of the seven sentences is written in the canvas | The other six are written here. |

## Architecture

### Two module tiers

The handoff proposes ES modules, which is right for view code and wrong as a
blanket rule, because the test suite is CommonJS: files are loaded with
`require("../path/mod.js")` and run with `node --test 'test/*.test.js'`. Every
source file in the repo already carries a dual tail:

```js
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerAnalysis;
}
```

So the split is two-tier, and the tier a file lands in is decided by one
question: *can this be tested without a DOM?*

**Tier 1 — pure logic. Classic script + `module.exports`. Unit tested.**

| File | Holds |
|---|---|
| `dashboard/series.js` | the detection rule, grouping matches into series, series records and series statistics, suggestion scanning |
| `dashboard/table.js` | sort, search, date-range and pagination over an already-filtered array |
| `dashboard/format.js` | *existing.* Gains the pure formatters — `champ`, `deckOf`, `fmtDuration`, `fmtBytes`, `fmtCount`, `fmtMs` |

The formatters go into the existing `format.js` rather than a new `fmt.js`.
Two modules with near-identical names and overlapping purpose would be a
standing invitation to import the wrong one, `fmtDuration` and the existing
`fmtClock` are two spellings of the same idea, and `fmtDuration` is used by the
CSV export — putting it in the untestable tier for no reason would be a loss.

**Tier 2 — DOM. ES modules, loaded as `<script type="module" src="main.js">`. Not unit tested,** per the project's standing rule that browser and network code gets no unit tests and must instead stay small and obviously correct.

| Module | Holds |
|---|---|
| `state.js` | one exported state object plus `subscribe`/`emit`; replaces the scattered module-level Maps |
| `storage.js` | every `chrome.storage` and `chrome.runtime` call, and **the only module permitted to write** |
| `dialog.js` | the one dialog component |
| `toast.js` | one-line acknowledgements and inline status |
| `filters.js` | the global filter row |
| `shell.js` | header, menus, banner stack, left nav, footer, view switching, delegation root |
| `view-overview.js` … `view-settings.js` | one per view, six of them |
| `share-ui.js` | the share panel component and the whole share flow |
| `main.js` | entry point; wires the modules, `storage.onChanged`, initial load |

### Why this is safe without a bundler

Classic `<script>` tags execute in document order and all of them complete before
any `type="module"` runs, because modules are deferred by default. So every
`window.RA*` global — `RATrackerFormat`, `RATrackerAnalysis`,
`RATrackerFingerprint`, `RATrackerVisualReplay`, `RAShareUI`, `RAShare`,
`RAShareHosts`, `RAShareConfig`, `RAClipboard`, `RARepaint`, `extractCssAssets` —
is guaranteed present when tier 2 starts. No import of a classic script is needed
or possible; tier 2 reads them off `window`.

The one call that crosses the boundary the other way is the replay modal:

```js
window.RATrackerVisualReplay.openModal(m, payload, {
  shareMoment: (request) => shareMoment(request, m),
});
```

`replay-html.js` is a classic script that never imports anything from tier 2 — it
receives a closure at call time. That is a callback, not a dependency, so there is
no cycle.

### What `replay-html.js` is

It is **chrome, and it is in scope.** The constraint names two files precisely,
`replay/replay-core.js` and `replay/replay-timeline.js`, and `replay-html.js` is
neither. It is also not shared with the standalone viewer: `.gitignore` syncs
`share/worker/public/{vendor,replay,share,store}` into the Worker's assets, and
`dashboard/` is not among them. Roughly three-quarters of its 401 lines are modal
furniture, fullscreen handling and keyboard chrome; the actual binding to
`RAReplayCore.create()` is about 60 lines. The redesign rewrites `renderShell` and
`openModal` and leaves `wireControls`' handle contract alone.

Three strings in it already match the handoff's "verbatim" copy exactly — the
keyboard hint line and the three body states — so they are kept as they are.

## Best-of-3 series

### Data model

Four fields on the existing match record. No new storage key, no new object: a
series *is* the set of matches sharing a `seriesId`, grouped at render time the
same way the aggregate tables already group by deck.

```
seriesId     : string | null
seriesGame   : 1..n   | null
seriesFormat : 'bo3' | 'bo5' | null
seriesSource : 'auto' | 'manual' | null
```

`seriesSource` follows the convention `deckSource` and `resultSource` already
set: **auto is a guess the UI will revise, manual is a fact it will not touch.**

Consequences: absent fields mean "not in a series", so no migration runs and
`schemaVersion` does not need bumping. Export JSON carries them. Export CSV gains
four columns. Import merges by id as today. Deleting a match leaves its series
shorter and renumbers the rest. Archive view renders Series read-only.

### Automatic series are derived, never stored. Only manual ones are written.

The handoff says detection happens "on match end". That is `content.js`, which
this round leaves unchanged — and `content.js` has **two** finalisers, not one:
`endMatch` (`:697-744`) and a `beforeunload` path (`:1007-1020`) that never calls
it, sets no `resultSource`, stops no recorder and shows no toast. A hook in
`endMatch` would silently miss every tab-close ending.

The obvious alternative — let the dashboard detect and write the fields — is
worse, and the reason is specific and verified. `content.js` runs a 3-second
dirty-save (`:986-1005`) that calls `saveMatch` (`:762-780`) whenever the live
record's JSON changes. `saveMatch` does `matches[idx] = lean`: it replaces the
stored record **wholesale** with its own in-memory copy. Its reconciliation
listener (`:1036-1050`) adopts exactly one field back from storage:

```js
if (!saved || saved.deckSource !== "manual") return; // only we write the rest
```

So a `seriesId` written onto a live match is erased within three seconds; the
erasure fires `storage.onChanged`; the dashboard reloads, re-detects and writes
it again. That is a permanent write-amplification loop for the length of every
match, and each turn of it rewrites the whole `matches` array in both directions.

So: **automatic grouping is derived at render time and never persisted.** This is
what the handoff itself describes — "a series *is* the set of matches sharing a
`seriesId`, grouped at render time the same way the aggregate tables group by
deck". Only what the user does by hand is written, as four fields with
`seriesSource: 'manual'`, through the same path `setDeckName` already uses and
which `content.js` already knows to respect.

Consequences, all of them improvements:

- No write loop, no cross-tab race, and no way for a detection pass to clobber a
  live match's score or result.
- Live matches can stay in the detection pass, because nothing is written — so
  the Series view's **In game** state survives, which excluding them would have
  cost.
- Changing the window from 45 to 60 minutes re-groups history immediately, which
  is the correct reading of "auto is a guess the UI will revise".
- The handoff's open question — detect over existing history on upgrade, or only
  forward? — dissolves. There is nothing to migrate.
- **`Re-scan history` is dropped**, because there is nothing to re-scan: every
  render is a scan. Its status strip ("42 series detected · 3 you grouped
  yourself") stays, since those counts are still worth showing. This is a control
  the handoff invented, not one the current UI has, so no existing feature is
  lost by removing it.
- Export JSON and CSV compute the four fields at export time from the same pure
  function, so a series still survives a backup.

### The rule

Walk matches in `startedAt` order. Join a match into the previous match's series
when **all** hold:

- same `opponentName`
- same `mode`
- the gap from the previous match's `endedAt` to this match's `startedAt` is
  within the window (default 45 minutes, settable 5–240)
- no other match sits between them
- the previous match's series is not already complete — a series stops growing at
  the format length, or once one side has taken it (2 wins in a Bo3, 3 in a Bo5)
- neither match is `seriesSource: 'manual'`

If the previous match has no `seriesId`, mint one and write it to both.
`seriesGame` comes from `startedAt` order; `seriesFormat` from the configured
default; `seriesSource` is `'auto'`.

Anything grouped, ungrouped, renumbered or reformatted by hand is written
`seriesSource: 'manual'` and skipped by every later pass, including `Re-scan
history`.

Cases just outside the rule are **proposed, not applied** — a suggestion strip in
the Series view, with `Group as a Bo3` and `Not a series`. Dismissals are
remembered so the same pair is not offered twice.

### Answers to the handoff's open questions

- *Detection over existing history on upgrade, or forward only?* Forward-only is
  meaningless once detection lives in the dashboard. It runs over all history,
  and `Re-scan history` stays.
- *Should the end-of-match toast say "game 2 of your series"?* No — that is
  `content.js`, out of scope.
- *Arbitrary `seriesFormat` lengths?* No. `bo3` and `bo5`.
- *A notes field per series?* No. Not designed, and it is a new storage concern.
- *A champion or deck filter shows a series if any game matches.* Accepted, with
  one correction: the series tiles are then computed over the filtered set, or
  the numbers contradict the rows underneath them.

## Data flow and interfaces

Unchanged from today. `chrome.storage.local` holds `matches`, `shares`, the
`settings` object, and per-match `log_<id>` and `deckcards_<id>`. Replay bytes
live in the service worker's IndexedDB and are reached only through the seven
`ra:visual:*` messages. The dashboard adds no message type and no storage key.

Two new settings keys join the existing `settings` object:

```
seriesDetect        : true      // group back-to-back matches
seriesWindowMinutes : 45        // 5..240
seriesFormatDefault : 'bo3'     // 'bo3' | 'bo5'
```

## Writes: one module, one guard

`persist()` carries a `readOnly()` guard, but **six write sites bypass it** and
call `chrome.storage.local.set({ matches: all })` directly —
`dashboard.js:1507, 1534, 1647, 1694, 1745, 1774`. Each is protected only by a
`readOnly()` check at its caller. In archive mode `all` holds the *archive file's*
matches, so any one of them firing there would overwrite the user's live history
with a file they were only looking at. Today the callers hold; this round adds a
Series view full of new mutating controls — a selection bar, `Group as a Bo3`,
`Set deck for all N…`, `Remove from series`, and per-sub-row result editors — in
a view that renders in archive mode.

So `storage.js` is the **only** module permitted to write, its `writeMatches()`
carries the read-only guard, and it **throws** rather than returning quietly, so
a missing caller-side check surfaces in development instead of silently doing
nothing. A source-shape test asserts no `storage.local.set({ matches` appears in
`dashboard/*.js` outside `storage.js` — the repo already has precedent for
asserting cross-file invariants over source text
(`test/vendor-contract.test.js`, `test/worker-headers.test.js`).

## Error handling

### The native calls are not 25 dialogs

There are 25 `confirm`/`prompt`/`alert` call sites, and the handoff's "nine" is
right about how many are *dialogs*. They sort into four buckets:

| Bucket | Count | Goes to |
|---|---|---|
| Genuine dialogs — 7 confirms, 2 prompts | 9 | `dialog.js` |
| New deck name | 1 | an **inline field**; the handoff explicitly forbids a dialog here |
| "The replay for this match could not be read" | 1 | a replay-modal **body state** |
| One-line acknowledgements and inline errors | 14 | `toast.js` |

The handoff has no toast component and neither did the first draft of this
design. Routing "Labelled 3 matches" through a focus-trapping modal would be
worse than what exists today, so `toast.js` is added.

### Async conversion is a re-entrancy hazard

Native `confirm()` blocks the event loop: no `chrome.storage` callback and no
`storage.onChanged` handler can run while it is open. An in-page `<dialog>`
blocks nothing, and `load()` reassigns `all` to freshly deserialised objects, so
every flow that computes a target list *before* a dialog and mutates it *after*
is racing a reload driven by `content.js`'s 3-second save.

Two rules, both load-bearing:

1. **No `await` between reading a target set and writing it.** Re-resolve the
   targets by id from the current `all` after the dialog resolves. This covers
   the deck-apply and bulk-label flows, which today compute `targets`, confirm,
   and mutate in one synchronous block.
2. **`storage.onChanged` defers `load()` while a dialog is open**, restoring the
   property native modals gave for free. The existing guard checks
   `document.activeElement?.dataset` for `notes` or `deck`; with a modal open the
   active element is the dialog's own button, so that guard does not fire.

Two specific flows change shape:

- **Archive & clear** builds its bundle, downloads it, then confirms. With a
  non-blocking dialog the user can sit on that confirmation indefinitely while
  matches finish in another tab, and pressing OK would then wipe matches that are
  not in the archive file. The bundle is rebuilt after the confirmation resolves.
  The `setTimeout(..., 800)` that existed to stop a synchronous modal suppressing
  the download goes away with the modal that needed it.
- **The cluster-naming `prompt()` loop** is deleted rather than awaited.
  `clusters.forEach(async …)` would fire every dialog at once and reach the write
  with nothing named. The handoff replaces it with the detection report's inline
  name fields, which is what this builds.

Failure copy is unchanged. Share failures keep their existing taxonomy —
`ShareUiError` (already carries its message), `ShareUploadError` (status mapped by
`describeUploadFailure`), anything else (a local failure, no retry offered).

## Testing strategy

Per the project's standing rule: pure logic gets `node --test` coverage, browser
and network code does not.

New unit tests:

- `test/series.test.js` — the detection rule and its six conditions, series
  completion, renumbering after a delete, manual records never touched, the
  suggestion scan, and the series statistics including the "unfinished series are
  excluded from series win rate but counted in games" rule.
- `test/table.test.js` — sort stability, the four search fields, date-range
  boundaries, pagination arithmetic and page clamping when a filter shrinks the
  set under the current page.

The suite runs with `node --test 'test/*.test.js'` — the quoting matters; plain
`node --test test/` is broken on this Node version. Baseline before this work:
226 passing.

Manual verification, because it cannot be unit tested: load unpacked, confirm no
CSP violation in the console, confirm `body.read-only` disables every mutating
control in all six views, confirm the replay modal still fills the viewport and
refits, and confirm the popup reads live data in archive mode.

## Out of scope

- **The in-game overlay** (`content.js`, `content.css`) — the end-of-match toast
  and the orphan banner. Unchanged, keeps `ra-tracker-block`.
- **The standalone share viewer** (`share/worker/public/`). Unchanged.
- **`replay/replay-core.js` and `replay/replay-timeline.js`.** Unchanged.
- **Trends over time** (win rate by day or week). Explicitly deferred by the
  handoff; it is new product rather than repair.
- **Sharing a whole series.** That is a Worker feature, not a UI change.
- **A build step, a framework, npm.** Nothing here requires one.
- **Bumping `schemaVersion`.** Nothing reads it, and it lives in an out-of-scope
  file.
