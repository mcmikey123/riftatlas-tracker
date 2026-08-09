# Visual Replay Implementation Plan

**Goal:** Record each match as an rrweb event stream so it replays exactly as the site rendered it, stored compressed in the extension's own IndexedDB.

**Architecture:** A vendored rrweb recorder runs in the content script behind a thin policy layer (keyframe timing, byte budget, perf kill-switch). Batches of events go to the service worker over `chrome.runtime.sendMessage`; the worker extracts repeated stylesheet text into a content-addressed asset store, deflates each batch, and appends it to IndexedDB on the extension origin. The dashboard replays with rrweb's own `Replayer`. The existing structured track is untouched and remains the fallback.

**Tech Stack:** Manifest V3, rrweb 2.0.0-alpha.4 (vendored IIFE bundles, no build step), IndexedDB, `CompressionStream('deflate-raw')`, `node --test` for pure units.

---

## File map

| File | Status | Single responsibility |
|---|---|---|
| `vendor/rrweb-record.min.js` | vendored | recorder, global `rrwebRecord` |
| `vendor/rrweb-replay.min.js` | vendored | replayer, global `rrwebReplay` |
| `vendor/rrweb.min.css` | vendored | replayer styles |
| `vendor/README.md` | new | version, SHA-256, MIT notice |
| `capture/capture-policy.js` | new | **pure** keyframe + budget + kill-switch state machine |
| `capture/dom-recorder.js` | new | rrweb lifecycle, settle timing, messaging; exposes `globalThis.RATRec` |
| `store/css-assets.js` | new | **pure** extract/rehydrate stylesheet text by content hash |
| `store/idb.js` | new | IndexedDB open/put/get/getAll/delete |
| `store/replay-store.js` | new | batching, compression, budget accounting, retention GC |
| `background.js` | modify | route `ra:visual:*` messages to the store |
| `manifest.json` | modify | register vendor + capture scripts, `web_accessible_resources` not needed |
| `content.js` | modify | **3 call sites only**: start / stop / mark |
| `dashboard/replay-html.js` | new | Visual replay viewer |
| `dashboard/dashboard.js` | modify | **Visual** button + diagnostics panel wiring |
| `dashboard/dashboard.html` | modify | script tags, panel markup |
| `test/css-assets.test.js` | new | round-trip, reuse, threshold, missing asset |
| `test/capture-policy.test.js` | new | keyframe triggers, budget transitions, kill latch |
| `test/replay-store.test.js` | new | batch boundaries, chunk framing, GC |

---

## Locked contracts

Every task below depends on these. A name used differently anywhere is a bug in the plan.

### Message protocol (content script → service worker)

```js
{ type: "ra:visual:start",  matchId, meta: { viewport: {w, h, dpr}, startedAt, href } }
{ type: "ra:visual:events", matchId, events: Array<RrwebEvent>, rawBytes: number }
{ type: "ra:visual:stop",   matchId, reason: string, truncatedAtTurn: number|null }
{ type: "ra:visual:get",    matchId }
{ type: "ra:visual:list" }
{ type: "ra:visual:gc",     keepNewest: number }
```

`ra:visual:events` resolves to `{ ok: boolean, compressedBytes: number, totalCompressedBytes: number }`.
The recorder updates its budget from `totalCompressedBytes` — the worker is authoritative.

### IndexedDB schema — db `ra-visual`, version 1

```
replays  keyPath "matchId"
  { matchId, startedAt, endedAt, viewport, cssRefs: string[], chunkCount,
    compressedBytes, rawBytes, state, truncatedAtTurn, incomplete, error, stats }
chunks   keyPath ["matchId", "seq"]
  { matchId, seq, firstEventIdx, bytes: Uint8Array }
assets   keyPath "hash"
  { hash, text }
```

`state` ∈ `"recording" | "complete" | "truncated" | "stopped" | "error"`.

### `capture/capture-policy.js`

```js
createCapturePolicy({ budgetBytes = 8 * 1024 * 1024, coalesceAtRatio = 0.8,
                      coalesceMs = 3000, killMs = 150 }) -> policy

policy.shouldKeyframe({ reason, turnNumber, bytesSinceKeyframe, lastKeyframeBytes }) -> boolean
policy.onBytes(totalCompressedBytes) -> void
policy.onCaptureDuration(ms) -> void
policy.state() -> "normal" | "coalescing" | "stopped" | "killed"
policy.minFrameIntervalMs() -> number      // 0 normal, coalesceMs when coalescing
policy.usedRatio() -> number
```

`reason` ∈ `"start" | "turn" | "ratio"`. Keyframe when: `reason === "start"`; or `reason === "turn"` and `turnNumber` differs from the last keyframe's turn; or `bytesSinceKeyframe > lastKeyframeBytes`. Never keyframe in state `stopped` or `killed`. `killed` latches permanently once any `onCaptureDuration(ms)` exceeds `killMs`.

### `store/css-assets.js` (pure, hash injected)

```js
extractCssAssets(events, { minBytes = 2048, hash }) -> Promise<{ events, assets: Map<string,string> }>
rehydrateCssAssets(events, assets) -> events
```

`hash: (text: string) => Promise<string>`. Walks rrweb full-snapshot nodes; any node with
`attributes._cssText` longer than `minBytes` has that attribute replaced by
`attributes.__cssRef = "<hash>"` and the text collected into `assets`. `rehydrateCssAssets` is the
exact inverse; a `__cssRef` with no matching asset is left as an empty `_cssText` and does not throw.

### `store/replay-store.js`

> **Reconciled during implementation.** `decompress` was added — `store.get` cannot reverse its
> own compression without it. `stop` also accepts the recorder's `stats` snapshot, and
> `ra:visual:list` gained an additive `assets: {count, bytes}` field for the diagnostics panel.
> No existing name changed meaning.

```js
createReplayStore({ idb, compress, decompress, hash }) -> store
store.start(matchId, meta) -> Promise<void>
store.append(matchId, events, rawBytes) -> Promise<{ compressedBytes, totalCompressedBytes }>
store.stop(matchId, { reason, truncatedAtTurn }) -> Promise<void>
store.get(matchId) -> Promise<{ meta, events } | null>   // decompresses + rehydrates
store.list() -> Promise<Array<meta>>
store.gc(keepNewest) -> Promise<number>                  // returns replays deleted
```

`compress: (Uint8Array) => Promise<Uint8Array>`, injected so tests can stub it.
Batch closes at `BATCH_MAX_RAW = 256 * 1024` or `BATCH_MAX_MS = 5000`.

### `globalThis.RATRec` (content-script surface)

```js
RATRec.start(matchId)             // begin recording
RATRec.mark(seq, turnNumber)      // authoritative sequence bump observed
RATRec.stop(reason)               // end recording
RATRec.stats()                    // diagnostics snapshot
```

---

## Tasks

Each task: write the test, run it and see it fail, implement, run it and see it pass, commit.
Commit format is Conventional Commits. No AI attribution trailers.

### Task 1 — vendor provenance

Create `vendor/README.md` recording rrweb version `2.0.0-alpha.4`, the SHA-256 of both bundles
(`rrweb-record.min.js` = `bf8fa2f5…`, `rrweb-replay.min.js` = `54e8eb36…`), the MIT licence text,
and the one-line command used to obtain them (`npm pack rrweb@2.0.0-alpha.4`).

No test. Commit: `chore(vendor): add rrweb 2.0.0-alpha.4 record and replay bundles`.

### Task 2 — `capture/capture-policy.js`

Write `test/capture-policy.test.js` first. Cases:

1. `shouldKeyframe({reason:"start"})` → `true`.
2. `reason:"turn"` with a new `turnNumber` → `true`; same `turnNumber` again → `false`.
3. `reason:"ratio"` with `bytesSinceKeyframe: 100, lastKeyframeBytes: 90` → `true`; `50` vs `90` → `false`.
4. `onBytes` at 79% of budget → `state() === "normal"`, `minFrameIntervalMs() === 0`.
5. `onBytes` at 85% → `state() === "coalescing"`, `minFrameIntervalMs() === 3000`.
6. `onBytes` at 100% → `state() === "stopped"`, and `shouldKeyframe({reason:"start"})` → `false`.
7. `onCaptureDuration(151)` → `state() === "killed"`; a later `onBytes(0)` does **not** clear it.
8. State only ever advances: `normal → coalescing → stopped`, never back.

Run `node --test test/capture-policy.test.js`, confirm failures name the missing module. Implement.
Re-run, expect all pass. Commit: `feat(capture): add keyframe and budget policy`.

### Task 3 — `store/css-assets.js`

Write `test/css-assets.test.js` first, with a fake hash (`async t => "h" + t.length`) and a minimal
rrweb-shaped snapshot fixture: nested `childNodes`, one `<style>` node carrying
`attributes._cssText` of 5000 chars, one of 100 chars.

1. Round-trip: `rehydrateCssAssets((await extractCssAssets(ev,{hash})).events, assets)` deep-equals the input.
2. The 5000-char text is replaced by `__cssRef` and appears once in `assets`.
3. The 100-char text is left inline and absent from `assets`.
4. Two snapshots with identical CSS produce **one** asset entry and two refs to it.
5. Rehydrating a `__cssRef` with an empty `assets` map yields `_cssText: ""` and does not throw.
6. Input events are not mutated (extract returns new objects).

Run, fail, implement, pass. Commit: `feat(store): content-address stylesheet text by hash`.

### Task 4 — `store/idb.js`

Thin promise wrapper: `openDb()`, `put(store, value)`, `get(store, key)`, `getAll(store, query)`,
`del(store, key)`, `clearMatch(matchId)`. Creates the three object stores at version 1.

No unit test (needs a browser). Keep it under ~80 lines so it is reviewable by inspection.
Commit: `feat(store): add IndexedDB wrapper for visual replays`.

### Task 5 — `store/replay-store.js`

Write `test/replay-store.test.js` first with an in-memory fake `idb` (plain Maps), an identity
`compress` (returns input, so byte accounting is checkable), and the fake hash.

1. `start` then a single `append` writes exactly one `replays` record and one `chunks` record.
2. Events under `BATCH_MAX_RAW` accumulate into one chunk; crossing it opens a second chunk with
   the correct `firstEventIdx`.
3. `append` returns `totalCompressedBytes` equal to the sum of chunk byte lengths.
4. `stop({reason:"budget", truncatedAtTurn: 9})` sets `state: "truncated"` and `truncatedAtTurn: 9`.
5. `stop({reason:"end"})` sets `state: "complete"` and `endedAt`.
6. `get` returns events deep-equal to everything appended, with CSS rehydrated.
7. `gc(2)` with 4 replays deletes the 2 oldest by `startedAt` and their chunks, returns `2`.

Run, fail, implement, pass. Commit: `feat(store): batch, compress and persist replay chunks`.

### Task 6 — `capture/dom-recorder.js`

No unit test (needs a browser). Implements `globalThis.RATRec` per contract:

- `start` reads `viewport` from `window.innerWidth/innerHeight/devicePixelRatio`, sends
  `ra:visual:start`, then calls `rrwebRecord.record({ emit, blockSelector: ".ra-tracker-toast,#ra-tracker-banner", maskInputOptions: { text: true, password: true }, inlineStylesheet: true, recordCanvas: false, collectFonts: false, sampling: { mousemove: false, mouseInteraction: false, scroll: 1000, input: "last" } })`.
- `mark(seq, turnNumber)` schedules a settled capture: `requestIdleCallback` then a 250ms timer;
  a further `mark` during the settle cancels the pending one. On fire, consult
  `policy.shouldKeyframe` and call `rrwebRecord.takeFullSnapshot()` when true.
- Buffers emitted events; flushes to the worker every 5s or 256KB, and updates the policy from the
  reply's `totalCompressedBytes`.
- Wraps every capture in `performance.now()` timing and feeds `policy.onCaptureDuration`.
- On `state()` transition to `stopped`/`killed`, calls `rrwebRecord` stop handle and sends
  `ra:visual:stop` with the reason. Never throws into the page.

Commit: `feat(capture): record the live DOM with rrweb`.

### Task 7 — wire the extension

`manifest.json`: add to the existing `content_scripts` entry, in order —
`vendor/rrweb-record.min.js`, `capture/capture-policy.js`, `capture/dom-recorder.js`, `content.js`.
Keep `run_at: "document_idle"`.

`background.js`: import the store modules and route the six `ra:visual:*` messages, returning
`true` from the listener for async replies.

`content.js`: exactly three call sites, guarded by `globalThis.RATRec &&` so the file still works if
capture is absent —
- in `startMatch`, after the record is created: `RATRec.start(currentMatch.id)`
- beside the existing `takeSnapshot(root)` call: `RATRec.mark(seq, turnNumber)`
- in `endMatch`: `RATRec.stop(reason)`

Commit: `feat(capture): wire visual replay into the extension`.

### Task 8 — `dashboard/replay-html.js` + viewer wiring

Mount `rrwebReplay.Replayer` into a modal container, sized to the captured viewport and scaled to
fit. Controls: play/pause, step, slider, and the same turn chapter chips the structured viewer
renders. Shows a banner when `state === "truncated"` naming the covered turn range and pointing at
the structured replay.

`dashboard/dashboard.js`: add the **Visual** button, shown only when `ra:visual:get` returns a
record. Existing **Replay** button and behaviour unchanged.

`dashboard/dashboard.html`: script tags for `vendor/rrweb-replay.min.js`, `vendor/rrweb.min.css`,
`dashboard/replay-html.js`.

Commit: `feat(dashboard): add visual replay viewer`.

### Task 9 — diagnostics panel

Dashboard panel listing per-match visual-replay stats from `ra:visual:list`: compressed bytes, chunk
count, keyframe count, mean delta size, capture p50/max ms, state, shared CSS asset total. This is
how the 8 MB default gets validated against real play.

Commit: `feat(dashboard): report visual replay capture diagnostics`.

### Task 10 — settings, retention, docs

- Setting `visualReplayEnabled` (default `true`) and `visualReplayBudgetMb` (default `8`), read by
  the recorder at `start`.
- Call `ra:visual:gc` with `keepNewest: 25` after each `stop`.
- README: a **Visual replay** section covering what it captures, the storage cost, the budget and
  degradation behaviour, and that visual replays are excluded from `Archive & clear`.

Commit: `feat(visual-replay): add settings, retention and documentation`.

---

## Self-review

**Spec coverage.** Goal/architecture → Tasks 6–7. Capture root and exclusions → Task 6.
Keyframes/seeking → Tasks 2, 8. Compression → Task 5. Shared CSS → Task 3. Budget/degradation →
Tasks 2, 5, 10. Perf guard → Tasks 2, 6. Viewer → Task 8. Error handling → Tasks 5, 6, 8.
Testing → Tasks 2, 3, 5. Diagnostics → Task 9. Out-of-scope items have no tasks, as intended.

**Placeholders.** None: no `TBD`, no `similar to Task N`, no undefined references. Every contract
used in a task is defined in *Locked contracts* above.

**Type consistency.** `matchId`, `seq`, `turnNumber`, `rawBytes`, `compressedBytes`,
`totalCompressedBytes`, `truncatedAtTurn`, `state`, `cssRefs`, `__cssRef`, `_cssText` are used
identically in every task and match the IDB schema and message protocol.
