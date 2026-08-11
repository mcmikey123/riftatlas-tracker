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
| 5 | a live match has "no result select" (README, and again in panel 1j) | the select is editable today | **Keep the control.** Removing it drops a control, which this round forbids. |
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

**Tier 2 — DOM. ES modules, loaded as `<script type="module" src="main.js">`. Not unit tested,** per the project's standing rule that browser and network code gets no unit tests and must instead stay small and obviously correct.

| Module | Holds |
|---|---|
| `state.js` | one exported state object plus `subscribe`/`emit`; replaces the scattered module-level Maps |
| `storage.js` | every `chrome.storage` and `chrome.runtime` call |
| `fmt.js` | `champ`, `deckOf`, `fmtDuration`, `fmtBytes`, `fmtCount`, `fmtMs`, date/time |
| `dialog.js` | the one dialog component |
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

### Detection runs in the dashboard, not in `content.js`

The handoff says detection happens "on match end". That is `content.js`, which
this round leaves unchanged — and `content.js` has **two** finalisers, not one:
`endMatch` (`:697-744`) and a `beforeunload` path (`:1007-1020`) that never calls
it, sets no `resultSource`, stops no recorder and shows no toast. A hook in
`endMatch` would silently miss every tab-close ending.

So detection is a pure function over the match array, run by the dashboard:

- on load, over all matches;
- on `storage.onChanged` for `matches`, which is how a match finished in the game
  tab reaches an open dashboard today;
- on demand from **Re-scan history** in Settings.

This makes `Re-scan history` and first-run detection the same code path, makes the
rule unit-testable with no DOM and no `chrome.*`, and keeps `content.js`
untouched. The cost is that `seriesSource: 'auto'` is written the first time the
dashboard sees the matches rather than at the moment the match ends — which is
invisible to the user, because the only surface that reads it is the dashboard.

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

## Error handling

The dialog replaces 25 native calls. Native `confirm`/`prompt`/`alert` are
synchronous; the replacement is not, so every call site converts from
`if (confirm(...)) { ... }` to a promise or callback continuation. The archive
flow's `setTimeout(..., 800)` before its confirm exists to let the download start
before the page blocks, and survives as an await.

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
