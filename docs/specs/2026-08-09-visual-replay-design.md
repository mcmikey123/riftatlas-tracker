# Visual Replay — Design

Date: 2026-08-09
Status: accepted

## Goal

Record each match so it can be replayed **as the game actually rendered it**, and store that
recording small enough to keep on disk.

The existing replay viewer (`dashboard/replay.js`) re-implements the Rift Atlas board from
structured data. That reimplementation can only ever lag the real site: every visual change
upstream is maintenance here, and until someone does that maintenance the replay is wrong.

### The objective, stated precisely

Pixel-identical replay is not achievable and is not the target. Serialized DOM cannot carry
canvas pixels, in-flight animation state, or images that never entered the viewport, and card
art is served from a live CDN that can rotate underneath us.

What *is* achievable, and what this design commits to:

> **No reimplementation drift.** The replay renders the site's own markup through the site's
> own stylesheets, captured at the moment of play. It cannot diverge from the real board
> because nobody updated our renderer, because we no longer have a renderer.

## Architecture

Two tracks record every match, independently.

| Track | Produces | Consumers | Always on |
|---|---|---|---|
| **Structured** (existing, unchanged) | `replay_<id>` — zone/card/score snapshots | `replay.js`, `fingerprint.js`, `analysis.js` | yes |
| **Visual** (new) | rrweb event stream in IndexedDB | `replay-html.js` | yes, at full fidelity |

The structured track is untouched. It is the analysis substrate, the fallback when visual
capture stops, and the reason every match ever recorded still opens.

### Data flow

```
play.riftatlas.com tab                    extension service worker
┌────────────────────────────┐            ┌──────────────────────────────┐
│ vendor/rrweb-record.min.js │            │ store/replay-store.js        │
│   ↓ emits rrweb events     │            │   batch 256KB / 5s           │
│ capture/dom-recorder.js    │  runtime   │   ↓                          │
│   settle, keyframe policy, │ ─sendMsg─► │ store/css-assets.js          │
│   budget state machine     │            │   extract CSS → sha-256 ref  │
│   (capture/capture-policy) │            │   ↓                          │
└────────────────────────────┘            │ CompressionStream deflate-raw│
        ▲ ~15 new lines in content.js     │   ↓                          │
        │ start / stop / mark             │ store/idb.js → IndexedDB     │
                                          └──────────────────────────────┘
                                                       │
dashboard ── replay-html.js ── vendor/rrweb-replay.min.js (rrweb Replayer)
```

### Why the service worker owns persistence

A content script's `indexedDB` is **`play.riftatlas.com`'s database**, not the extension's.
Writing replays there would expose them to the site and destroy them whenever the user clears
site data. All persistence therefore routes through the service worker, which runs on the
extension origin.

`chrome.storage.local` is rejected for the payload: it has no append operation, and the
existing `persistReplay` rewrites its whole value every 5 seconds. At visual-replay volumes
that is hundreds of megabytes of disk writes per match. IndexedDB appends one chunk record.

## Components

| File | Responsibility | Pure / testable |
|---|---|---|
| `vendor/rrweb-record.min.js` | rrweb 2.0.0-alpha.4 recorder, IIFE global `rrwebRecord` | vendored |
| `vendor/rrweb-replay.min.js` | rrweb replayer, IIFE global `rrwebReplay` | vendored |
| `capture/capture-policy.js` | keyframe policy + stop/kill state machine | **pure** |
| `capture/dom-recorder.js` | rrweb lifecycle, settle timing, perf guard, messaging | no |
| `store/css-assets.js` | extract/rehydrate stylesheet text by content hash | **pure** |
| `store/idb.js` | IndexedDB open/put/get/delete | no |
| `store/replay-store.js` | batching, compression, budget accounting, retention | no |
| `dashboard/replay-html.js` | Visual replay viewer | no |

`content.js` gains **start/stop/mark calls only** — no capture logic. It is already ~1200 lines
and does not grow meaningfully.

### Capture root

`document.documentElement`, not the board root. Board-root-only capture provably loses:

- the counter/buff overlay — already outside the zone tree at `[data-card-counter-overlay-root]`
- the score tracks, queried from `document` (`content.js:99,107`)
- the match log panel (`content.js:434`)
- the end-of-match modal, portalled to `<body>` — the single most important frame

Portal targets move without warning on site updates. Whole-document capture has no selector
dependency at all, which makes the visual track *more* robust to site changes than the
structured scraper, not less.

Exclusions: our own injected UI (`.ra-tracker-toast`, `#ra-tracker-banner`) via `blockSelector`;
chat input via `maskInputOptions`.

### Keyframes and seeking

An rrweb full snapshot is a keyframe. One is emitted:

1. at match start,
2. at every turn boundary — `data-turn-number` change,
3. when delta bytes since the last keyframe exceed the last keyframe's own byte size.

Rule 3 is self-calibrating: it needs no prior knowledge of frame size, and bounds keyframe
overhead at ~50% of the stream whether a snapshot is 50KB or 800KB. This matters because the
real DOM size cannot be measured before shipping.

Rule 2 aligns seek targets with the chapter chips the dashboard already renders from turn
numbers, so clicking "T7" lands on a keyframe. Turn boundaries are also a natural gameplay
pause, which keeps the expensive full serialization away from mid-combat.

### Compression

```
rrweb events → JSON per batch → deflate-raw → Uint8Array → one IDB chunk record
```

Batch closes at 256KB uncompressed or 5s, whichever first. Batching is what makes compression
work: deflate's window is 32KB, so it cannot dedupe across large frames — but a 256KB batch of
small deltas fits many frames inside one window, and consecutive deltas are near-identical.
`deflate-raw` over `gzip` saves the per-member header for framing we already track.

Compression runs in the service worker, never on the game's thread.

### Shared CSS assets

rrweb inlines every stylesheet into each full snapshot. The same Tailwind build is byte-identical
across every replay until the site redeploys, so storing it per-match is the single largest
avoidable cost.

`store/css-assets.js` walks outgoing full-snapshot events, replaces any stylesheet text over
`CSS_REF_MIN_BYTES` with `{__cssRef: "<sha-256>"}`, and stores the text once in an `assets`
object store. Rehydration on read is the exact inverse. Both directions are pure functions over
plain objects, and are the highest-value unit tests in the change.

### Bounding storage

Storage is bounded by **retention** — how many matches keep a replay — and by nothing else.

| Setting | Default | Range | Read by |
|---|---|---|---|
| `visualReplayKeepMatches` | 25 | 1–500 | the service worker, at every gc |
| `visualReplayMaxMatchMb` | 512 | 16–4096, or blank/0 for no limit | the recorder, at match start |

Capture has exactly two fidelities: full, or none. `capture-policy` is `normal → stopped`, plus
the independent `killed` latch, and there is no throttled middle.

**Why there is no degradation ladder.** An earlier revision of this design degraded capture as a
per-match byte budget filled: past 80% it coalesced to one frame per 3s, and only at 100% did it
stop. That was the wrong control, and it contradicted the feature's own premise. The whole point
of recording the site's own markup is that the replay cannot be wrong — and a recording that
silently thins its frames to fit a number is wrong, in the specific way that is hardest to
notice. It still looks like a replay. It just isn't the match that was played, and nothing in
the viewer can tell you which parts are missing. Fidelity is the product; a half-fidelity replay
is not a cheaper version of the product, it is a defect that costs disk anyway.

The cost of one recording is a property of the match, not a dial. So the dial is the *number* of
recordings kept, which is a decision the owner can actually reason about — "the last 25 matches",
priced by the mean per-match size the diagnostics panel reports. Retention deletes whole
recordings that have served their purpose; degradation damaged the one being made.

**The MB ceiling is a runaway guard.** It survives only to stop a pathological recording from
filling the disk before the match ends — a page in a redraw loop, a leak upstream. Defaulted to
512 MB against a typical 1–3 MB match, it should essentially never fire; if it does, that is a
bug report, not a tuning exercise. Blank or 0 disables it entirely (`createCapturePolicy` reads
any non-finite or non-positive `budgetBytes` as unlimited). Reaching it stops capture and marks
the record `truncated`, exactly as before.

Frames are **never dropped from the front**. Dropping frame 0 of a delta chain destroys the
whole replay, not just its opening — the existing `replay.snaps.shift()` behaviour is not
carried over. When capture stops for any reason, the viewer says which turns the replay covers.
The match record, its game log, its result and its card list are produced by `content.js` and
run to the end of the match regardless; only the replay stops.

The perf kill switch below is unrelated to storage and unaffected by any of this.

### Performance guard

The extension's premise is that it never interferes with play. A full rrweb snapshot of a large
document is tens to hundreds of milliseconds of blocking serialization.

- keyframes only at turn boundaries (natural pause), never mid-combat
- capture on `requestIdleCallback` + 250ms settle after a sequence bump; a further bump during
  the settle cancels the pending frame — this also avoids freezing cards mid-animation
- if any single capture exceeds `CAPTURE_KILL_MS` (150ms), visual capture disables for the rest
  of the session and records why

### Viewer

`dashboard/replay-html.js` mounts an rrweb `Replayer`, which creates its own
`sandbox="allow-same-origin"` iframe with scripting disabled. That combination permits the parent
to patch the iframe incrementally — required for smooth stepping — while opponent-controlled
strings (display names, chat) stay inert. rrweb additionally strips `<script>` and `on*`
attributes at capture time.

Captured `innerWidth`/`innerHeight` size the iframe exactly, and a CSS `transform: scale()` fits
it to the modal. Replaying at a different width would fire different media queries and reintroduce
drift.

Matches keep their existing **Replay** button, always available. Matches with a visual track gain a
**Visual** button beside it.

## Error handling

| Failure | Response |
|---|---|
| rrweb throws during capture | stop visual track, keep structured, record `error` on the meta record |
| service worker evicted mid-match | up to 5s of unflushed events lost; replay marked `incomplete` |
| IDB quota exceeded | stop visual capture, surface in diagnostics, structured unaffected |
| chunk fails to decompress on read | viewer plays up to the last good chunk and says so |
| no visual track for a match | **Visual** button absent; **Replay** unchanged |

`sendMessage` from `beforeunload` is unreliable and is not relied upon.

## Testing strategy

`node --test` (built in, zero dependencies). No framework is added.

Pure units under test:
- `store/css-assets.js` — extract/rehydrate round-trip, ref reuse across snapshots, sub-threshold
  text left inline, missing-asset handling
- `capture/capture-policy.js` — keyframe triggers (start / turn change / byte ratio), full
  fidelity right up to the ceiling, the one-way `normal → stopped` transition, an uncapped
  ceiling never stopping capture, kill-switch latch
- `store/replay-store.js` — batch boundary selection and chunk framing (compression stubbed)

Not unit tested (no browser available, and asserted by the diagnostics panel instead): rrweb
itself, IDB wiring, viewer rendering.

## Diagnostics

Because the real DOM size cannot be measured before shipping, the feature measures itself. A
dashboard panel reports, per match: compressed size, chunk and keyframe counts, mean delta size,
capture time p50/max, end state, and shared-CSS blob size.

Its job is to let the owner **choose a retention number**, so it also totals current disk use —
the sum of the retained replays plus the shared stylesheet blob — and the mean per-match size,
from which keeping *N* matches prices directly. Those are the numbers any later change to the
default 25 should come from.

## Out of scope

- export/import of visual replays, and viewing them from an archive file. `Archive & clear`
  already stringifies everything in memory and would OOM well before this feature's volumes;
  visual replays are **excluded from archive** here and the streaming rewrite is separate work.
- font embedding as `data:` URIs (fallback fonts accepted for now)
- canvas capture
- animation/timing fidelity — frames are stepped, not animated
- hover-preview parity with `replay.js` (the site's own hover needs scripting, which stays off)
- any change to `fingerprint.js`, `analysis.js`, or `replay.js`
- backwards compatibility for pre-existing visual replays (none exist)
