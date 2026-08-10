# Replay Sharing — Implementation Plan

**Status:** ready to build. Nothing implemented yet.
**Written:** 2026-08-10, for a session with no prior context. Read this file top to bottom before writing code.

**Goal:** share a visual replay as a short, clickable URL. Recipient needs no extension, no account, and no software — they click a link and the replay plays in their browser.

**Architecture:** the extension encrypts a replay client-side with a fresh random key, uploads the ciphertext to a Cloudflare Worker backed by R2, and produces a link to that same Worker with the object id and decryption key in the URL **fragment**. The Worker serves both the viewer page and the ciphertext, so both live on one origin and CORS never enters the picture. Objects auto-expire via an R2 lifecycle rule.

**Stack:** Manifest V3 extension (no build step, vendored deps only), Cloudflare Workers + R2 free tier, `crypto.subtle` AES-GCM, `CompressionStream('deflate-raw')`, `node --test` for pure units.

---

## 0. Read this first: the credentials constraint

**This repo belongs to someone else. The Cloudflare account belongs to the contributor.** That asymmetry is a hard design constraint, not a deployment detail.

Three things must stay separate:

| Layer | Where it lives | Committed? |
|---|---|---|
| Worker source, deploy docs, extension code | this repo | **yes** |
| Cloudflare account id, bucket name, API tokens, custom domain | local config + `wrangler secret` | **never** |
| Which Worker the extension talks to | a constant with a settings override | yes — it is a public URL, not a secret |

Rules the implementation must honour:

1. **No `wrangler.toml` in git.** Commit `wrangler.toml.example` with placeholders; gitignore the real one. Wrangler reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment — use that, never a file.
2. **The repo has no `.gitignore` at all today.** Creating one is Task 0 and blocks everything else.
3. **Anyone can self-host.** `share/worker/README.md` must let the repo owner stand up his own instance from a clean checkout in under ten minutes, with no reference to the contributor's account. Deploying your own must be a documented, first-class path — not a reverse-engineering exercise.
4. **The default endpoint is a public URL and belongs in the source**, clearly labelled as "the instance run by <contributor>; change it in Settings or deploy your own — see `share/worker/README.md`". It must be overridable from extension settings without touching code.
5. **Nothing shipped inside a distributed extension is a secret.** If an upload token exists, treat it as a public speed bump and say so in a comment. Real abuse control is the size cap, the Cloudflare rate-limit rule, and the short TTL.
6. Before the first push, run the `audit-public` skill over the diff and the history.

---

## 1. Current state

`main` is at `6e70c3d` (PR #2 merged). **46 tests pass** via `node --test 'test/*.test.js'` — note plain `node --test test/` is broken on this Node version and will look like a failure.

Relevant existing pieces:

| File | What it gives you |
|---|---|
| `store/replay-store.js` | `get(matchId) → {meta, events}` — decompressed and **CSS-rehydrated**. This is the share payload source. |
| `store/css-assets.js` | pure extract/rehydrate of stylesheet text by content hash |
| `store/idb.js` | IndexedDB wrapper, extension origin, driven from the service worker |
| `background.js` | `ra:visual:*` message router; already uses `CompressionStream('deflate-raw')` |
| `dashboard/replay-html.js` | the viewer — `mount(container, match, payload, opts)` where payload is exactly `{meta, events}` |
| `dashboard/dashboard.js` | `download()` helper (~:697); the replay control is in the expanded match row |
| `vendor/rrweb-replay.min.js` | IIFE global `rrwebReplay`, 80 KB — the Pages/Worker viewer reuses this verbatim |

**The viewer needs splitting.** `dashboard/replay-html.js` is currently coupled to the dashboard via `window.RATrackerFormat` (`esc`, `fmtClock`) and the dashboard's CSS classes. The share viewer needs the playback core without the dashboard's modal chrome. Extracting a portable core is the one refactor this feature genuinely requires — do it deliberately rather than copy-pasting the file.

---

## 2. Verified facts — do not re-research these

Measured, not estimated. Re-deriving them wastes a session.

**Payload size.** 3.53 MB worst case, 1.74 MB mean, `deflate-raw` compressed. That figure is the event stream *after* `extractCssAssets` has removed stylesheet text, so a share must add the assets back: **~75 KB deflated (estimated — verify by deflating the real `assets` store)**. Design for **~3.6 MB**.

**Crypto, measured in real Chromium on a 3,773,440-byte buffer:**
- AES-GCM 256: encrypt 11 ms, decrypt 6 ms, round-trip identical, tampering rejected with `OperationError`
- Ciphertext overhead 16 B; no chunking or streaming needed at this size
- Key raw 32 B → 43 chars base64url; IV 12 B
- `crypto.subtle`, `CompressionStream` and `DecompressionStream` all available in both a `chrome-extension://` page and an `https://` page — both are secure contexts

**Cloudflare free tier** (R2 10 GB-month storage, 1M Class A, 10M Class B, **egress always free**; Workers 100,000 req/day, 10 ms CPU/invocation). At ~50 shares/month with 7-day expiry: ~45 MB steady state, ~100 writes, ~500 reads. **$0 with ~1000× headroom.** R2 lifecycle rules support "delete after N days"; objects go within ~24 h of expiry.

**Hosts that were tested and rejected** — do not revisit without new information: Pastebin (512 KB cap, shipped API key, 10 unlisted pastes/day *total per key*), 0x0.st (uploads disabled), uguu.se / x0.at / tmpfiles.org (no CORS on raw GET — browser `fetch` blocked), filebin.net (CORS headers present but serves an **HTML interstitial to browsers** based on User-Agent; passes a curl test and fails in reality), GoFile (no direct link), transfer.sh (dead). GitHub Gist works and is fast but needs the sharer's own token; catbox.moe works but measured ~45 s to serve 3.6 MB and is geo-blocked in several countries.

**Card art is never in the payload.** rrweb serializes `<img src>` as URLs into `https://assets.riftatlas-workers.com`. Every shared replay needs the recipient online and that CDN reachable. Say so in the share UI; no option avoids it.

---

## 3. Decisions already made, with reasons

Do not relitigate these without new evidence.

- **Worker serves the viewer *and* the ciphertext.** Same origin ⇒ no CORS. CORS is what disqualified six of ten candidate hosts; this design removes the entire failure class, including the filebin-style browser/curl divergence.
- **Key in the URL fragment, not the querystring.** Costs nothing — same length, one character — and keeps the key out of Cloudflare's request logs and the recipient's browser history. The owner is relaxed about this; do it anyway because it is free.
- **IV travels in the ciphertext frame, not the link.** Saves 17 URL chars and has no reason to be in the URL.
- **Compress, then encrypt.** The reverse makes compression useless.
- **A magic header** so the viewer can distinguish "wrong key" from "not a replay" from "the host returned junk".
- **Short TTL is a feature**, doing double duty as abuse control and as the reason storage stays free.
- **Not building:** a self-contained `.html` export (rejected as too much friction), URL-embedded payloads (3.53 MB → ~5 M base64 chars against Chrome's hard 2,097,152-char URL cap — off by 2.4× at best, 2,500× for Discord; even a single frame does not fit), and P2P (MV3 evicts the service worker, so seeding is structurally impossible).

**Link anatomy**, ~107 chars, clickable everywhere:

```
https://<worker-host>/#<v>.<object-id>.<key>
        └ configurable  │  │            └ 43 chars base64url
                        │  └ 22 chars base64url of 128 random bits
                        └ format version, 1 char
```

---

## 4. Tasks

Each task: write the test, watch it fail, implement, watch it pass, commit. Conventional Commits, no AI attribution trailers. Pure functions get `node --test` coverage; anything needing a browser or network does not get a unit test and must instead be kept small and obviously correct.

### Task 0 — `.gitignore` and config hygiene *(blocks everything)*
Create `.gitignore` covering at minimum `share/worker/wrangler.toml`, `.dev.vars`, `.wrangler/`, `node_modules/`, `*.local`, and OS noise. Commit `share/worker/wrangler.toml.example` with placeholder `account_id`/bucket. Verify with `git check-ignore -v share/worker/wrangler.toml`.
`chore: add gitignore and worker config template`

### Task 1 — portable viewer core
Extract the playback engine from `dashboard/replay-html.js` into a module that takes `{meta, events}` and a container and has **no dependency on the dashboard** — no `RATrackerFormat`, no dashboard CSS classes. The dashboard keeps its modal chrome and delegates to the core; the share viewer uses the core directly. Behaviour in the dashboard must be unchanged: fullscreen, chapter chips, truncation banner, viewport pinning and the `transform: scale()` fit all still work.
**The viewport pinning is load-bearing** — the iframe is pinned to `meta.viewport.w × h` and scaled, never resized, because replaying at another width fires different media queries and reintroduces the drift this whole feature exists to remove.
`refactor(dashboard): extract a portable replay playback core`

### Task 2 — share payload builder *(pure, testable)*
`share/payload.js`: `buildSharePayload({meta, events, assets}) → Uint8Array` and its inverse `parseSharePayload(bytes) → {meta, events, assets}`.
Pipeline: JSON → `deflate-raw` → AES-GCM encrypt → frame. Frame: `"RAR1"` magic (4 B) ‖ flags `uint8` (1 B) ‖ IV (12 B) ‖ ciphertext ‖ GCM tag (16 B); 33 B overhead.
Inject `compress`/`decompress`/`crypto` so tests can stub them, exactly as `store/replay-store.js` already does.
Tests: round-trip identity; wrong key → `OperationError`; flipped byte → `OperationError`; bad magic → a distinct, named error; truncated buffer → a distinct, named error.
`feat(share): add the encrypted share payload format`

### Task 3 — host adapter registry *(pure, testable)*
`share/hosts.js`: a registry keyed by the single-character host id — `{ id, upload(bytes) → objectId, urlFor(objectId), linkFor(objectId, key) }`. Ship `w` (the Worker) now; the registry exists so a second backend can be added without touching the payload or UI layers.
Tests cover link construction and parsing round-trip, unknown host id, and malformed fragments. No network in tests.
`feat(share): add the pluggable share host registry`

### Task 4 — the Worker
`share/worker/` — source committed, config not. Routes:
- `PUT /u` → validate size cap and content type, generate a 128-bit id, `env.BUCKET.put(id, request.body)`, return `{id}`
- `GET /b/<id>` → stream the R2 object back; 404 cleanly when absent
- `GET /` → the viewer HTML

**The 10 ms CPU limit is the design constraint: the Worker must never buffer or transform the body.** Stream it. Enforce the size cap from `Content-Length` plus a streaming guard, not by reading the body.
Set the CSP via response header (a Worker *can* do this, unlike Pages): `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://assets.riftatlas-workers.com; connect-src 'self'; frame-src 'self' blob:`. `style-src 'unsafe-inline'` is required because rrweb injects styles at runtime; `frame-src` because it builds its own `sandbox="allow-same-origin"` replay iframe — keep scripting off in that iframe.
`share/worker/README.md`: deploy-your-own instructions — create bucket, set the lifecycle rule, `wrangler deploy`, point the extension at the result. No contributor-specific values anywhere.
`feat(worker): add the replay sharing worker`

### Task 5 — share UI
A **Share** control beside the existing replay control in the expanded match row. Flow: build payload → upload → **verify** → show the link with a copy button.
- **Post-upload verification is mandatory, not a nicety.** After upload, re-fetch the object under normal browser rules and check the magic bytes before showing the user a link. This is precisely what would have caught the filebin failure. Never present an unverified link.
- Disclose at share time: *"This replay includes your opponent's display name and the match chat, and will be readable by anyone with the link until it expires."*
- Distinguish the four failure states in the UI — 404 / network-or-CORS / bad key / bad frame — because the remedies differ completely and one generic "failed to load" is useless.
- Settings: `shareEndpoint` (default the public instance, overridable) and `shareTtlDays` if the Worker supports it.
`feat(dashboard): add replay sharing`

### Task 6 — the share viewer page
Served by the Worker at `/`. Parses the fragment, fetches `/b/<id>`, decrypts, inflates, and mounts the Task 1 core. Inlines or serves `vendor/rrweb-replay.min.js` and `vendor/rrweb.min.css`.
Must handle: missing/expired object, malformed fragment, wrong key, corrupt frame, and the card-art CDN being unreachable (replay plays, cards render blank — say so rather than looking broken).
`feat(worker): add the share viewer page`

### Task 7 — shares list
A dashboard list of active shares with a re-check button and a **delete** action. This is the privacy control the feature owes the user, given chat and opponent names are in the payload. Requires a `DELETE /b/<id>` route with a per-object delete token retained locally at share time.
`feat(dashboard): manage and revoke active shares`

---

## 5. The spike that must come first

**Before Task 2, prove the rrweb Replayer mounts and plays outside the extension.** Export one real replay via `get()`, encrypt and upload it with a throwaway script, hand-write the fragment, and build the viewer until it plays.

That single spike proves fragment parsing, `subtle.decrypt` at 3.6 MB, `DecompressionStream`, rrweb mounting on a plain page, **CSS rehydration**, card art loading cross-origin, and the viewer CSP. Every remaining unknown lives there. Do not build the share button before it plays.

---

## 6. Known outstanding issues (separate from this feature)

Found during the visual-replay work, not yet fixed. A session touching the viewer will meet some of them.

- **Replay flicker, unconfirmed.** Every rrweb full snapshot tears the iframe down (`document.open()`) and rebuilds — 36 times in a typical match. Two prime suspects: (T1) `.vr-scale iframe { background: #fff }` in `dashboard/dashboard.css` flashing white on a dark board, plus card art re-fetching; (T2) any surviving `<link rel=stylesheet>` makes rrweb **pause and rebuild a second time** (`loadTimeout` defaults to 0 and is never set) — reachable because `store/css-assets.js` rehydrates an unresolvable ref to `""`, which is falsy, so the node stays a `<link>`.
  Diagnostic, after playback passes one keyframe: `document.querySelector('.vr-scale iframe').contentDocument.head.querySelectorAll('link[rel="stylesheet"]').length` — **zero kills T2**.
- `speedOption: [1]` in `dashboard/replay-html.js` is inert dead config; it is an `rrweb-player` option, not a `Replayer` one.
- The Replayer is never told our `blockClass`, so it uses rrweb's default `"rr-block"` while the recorder blocks on `"ra-tracker-block"`. Our injected UI renders as unstyled boxes instead of being blocked. Cosmetic, constant.
- Chapter chips can seek to the *previous* keyframe: the `ra:turn` custom event is emitted just before `takeFullSnapshot()`, and rrweb slices from the last Meta at or before the baseline. Slow, not wrong.
- `docs/specs/2026-08-09-visual-replay-design.md` still says exclusions use `blockSelector`; the code has used `blockClass` since `761684d`.
- `store/css-assets.js` only walks `event.data.node`, so stylesheets arriving via mutation events are stored inline in every chunk rather than content-addressed. A storage-size asymmetry, not a correctness bug — it means the reported "shared stylesheets" figure undercounts the CSS actually in the stream.

---

## 7. Definition of done

- A link produced on one machine plays on another machine in a browser with no extension installed.
- Nothing in the repo identifies or authenticates any Cloudflare account; `audit-public` is clean over the diff and history.
- `share/worker/README.md` lets the repo owner deploy his own instance from a clean checkout, and the extension can be pointed at it from Settings without a code change.
- Shares expire on their own; the user can list and revoke them early.
- `node --test 'test/*.test.js'` passes, including new coverage for the payload format and the host registry.
