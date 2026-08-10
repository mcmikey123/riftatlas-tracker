# Replay Sharing — Design

Date: 2026-08-10
Status: accepted

## Goal

Share a visual replay as a short, clickable URL. The recipient needs no extension, no account
and no software: they click a link and the replay plays in their browser.

The replay is encrypted in the sharer's browser before it leaves the machine. The service that
stores it cannot read it.

## Architecture

The extension compresses and encrypts a replay with a fresh random key, uploads the ciphertext
to a Cloudflare Worker backed by R2, and builds a link to that same Worker carrying the object
id and the key in the URL **fragment**.

```
extension (chrome-extension://)              instance (one Worker + one R2 bucket)
┌───────────────────────────────┐            ┌──────────────────────────────────────┐
│ store/replay-store.js get()   │            │ PUT /u    size cap, token, stream to │
│   → {meta, events} rehydrated │            │           R2, return {id}            │
│ store/idb.js  assets          │  PUT /u    │ GET /b/id stream object back         │
│   ↓                           │ ─────────► │ GET /     viewer page (static assets)│
│ share/payload.js              │            │                                      │
│   JSON → deflate → AES-GCM    │            │ R2 lifecycle rule: delete after 7d   │
│   → frame                     │            └──────────────────────────────────────┘
│   ↓                           │                        ▲
│ share/hosts.js  → link        │                        │ GET /  then GET /b/id
└───────────────────────────────┘            recipient's browser, no extension
```

**The Worker serves both the viewer page and the ciphertext.** One origin, so CORS never
enters the picture. This is the keystone: CORS is what disqualified six of ten candidate hosts
during research, including a host that passed a `curl` test and failed in a real browser.

### Why the key is in the fragment

URL fragments are never sent to the server. The key therefore stays out of Cloudflare's request
logs and out of intermediate proxies. It costs nothing — same length, one character — so it is
done regardless of how relaxed anyone feels about the alternative.

The IV travels inside the ciphertext frame rather than the link, saving 17 URL characters for
no loss.

### Trust model, stated plainly

| Party | Can read a share? |
|---|---|
| The instance operator, Cloudflare, anyone with bucket access | **No** — they hold ciphertext and never see the key |
| Anyone holding the link | **Yes** |
| Anyone enumerating object ids | No — 128 random bits, and the key is not derivable from the id |

The link is a **bearer token**, not an access control. Anyone it is forwarded to can read the
share. The UI must not imply otherwise.

## Components

| File | Responsibility | Pure / testable |
|---|---|---|
| `replay/replay-timeline.js` | quantise, turn extraction, timeline, chapter marks, truncation text | **pure** |
| `replay/replay-core.js` | rrweb Replayer lifecycle, viewport pinning, scale fit, transport (play/pause/seek/step/tick) | no |
| `dashboard/replay-html.js` | dashboard chrome: shell markup, modal, fullscreen, keyboard | no |
| `share/payload.js` | build/parse the encrypted frame | **pure** (crypto injected) |
| `share/hosts.js` | link construction and parsing; uploader registry | **pure** |
| `share/worker/src/worker.js` | the three routes | no |
| `share/worker/public/` | viewer page + synced assets (**gitignored**) | no |

### The Task 1 split

`dashboard/replay-html.js` currently mixes three concerns across 532 lines. They separate as:

- **pure** (lines 50–112) — `quantise`, `turnOf`, `timeline`, `evenly`, `truncationText`. These
  have no DOM dependency today and gain unit tests on extraction. `esc` is applied at the call
  sites, not inside them, so they are already clean.
- **core** (169–225, plus the transport half of `wireControls`) — the Replayer, `pin`, `fit`,
  `refit`, seek, play/pause, step. No markup, no CSS class names, no `RATrackerFormat`.
- **chrome** (113–167, 313–443, 476–532) — `renderShell`, fullscreen, input wiring, `openModal`.
  Stays in `dashboard/`.

The two portable modules move to a new top-level `replay/` directory because they are no longer
owned by the dashboard — the share viewer is an equal consumer. Copying them out of `dashboard/`
at deploy time would enshrine a false ownership. Consequence: `dashboard/dashboard.html` gains
two script tags ahead of `replay-html.js`.

**Viewport pinning is load-bearing.** The iframe is pinned to `meta.viewport.w × h` and scaled
with `transform: scale()`, never resized. Replaying at another width fires different media
queries and reintroduces the exact drift the visual-replay feature exists to remove.

**`test/vendor-contract.test.js` must be updated in the same change.** Its `sources` map
(line ~109) reads `dashboard/replay-html.js` from disk and asserts every rrweb member that file
calls exists on the vendored bundle. Once the `Replayer` construction moves, that assertion
passes vacuously against a file that no longer touches rrweb — a false green, which is worse
than a failure. The map must point at `replay/replay-core.js`.

## Data flow and interfaces

### Payload

`buildSharePayload({meta, events, assets}, key) → Uint8Array`, and its inverse
`parseSharePayload(bytes, key) → {meta, events, assets}`.

```
{meta, events, assets} → JSON → deflate-raw → AES-GCM-256 → frame
```

Compress **then** encrypt; the reverse makes compression useless. `compress`, `decompress` and
`crypto` are injected so tests can stub them, exactly as `store/replay-store.js` already does.

### CSS must be re-stripped before compressing

`store/replay-store.js` `get()` returns `{meta, events}` with stylesheet text **rehydrated back
inline**. It does not return an `assets` map. Compressing that directly is the single easiest
way to break this feature.

rrweb inlines every stylesheet into **every** full snapshot, and a typical match has 32–36 of
them. Rehydrating pushes the in-memory object to **58.78 MB** at worst, measured.

Measured across 6 real replays: compressing that rehydrated stream directly costs **5.95 MB**
worst case, against **3.48 MB** for a re-stripped one — a 42% saving. Both fit under the 12 MB
cap, so this is an efficiency measure, not a correctness one. (An earlier revision of this
document claimed the naive path breached the cap. It does not; `deflate` compresses each copy of
a highly repetitive Tailwind build well even without deduplicating across copies.)

The larger cost is the 58 MB intermediate itself: `JSON.stringify` over it runs on the
dashboard's UI thread before compression begins.

So the share path re-strips before compressing, using the same pure function storage uses:

```js
const { events, assets } = await extractCssAssets(replay.events, {
  hash: async (text) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
});
const payload = { meta: replay.meta, events, assets: Object.fromEntries(assets) };
```

`assets` is a `Map` and must be converted for JSON. The viewer runs `rehydrateCssAssets` after
decrypting, which is the exact inverse.

This is a rehydrate-then-re-strip round trip, which is wasteful but requires no service-worker
change. A `ra:visual:getRaw` message returning `{meta, events, assets}` un-rehydrated would
avoid it and is the better long-term shape; it is not required for this feature.

Note the known limitation inherited from `store/css-assets.js`: it only walks
`event.data.node`, so stylesheets arriving via mutation events stay inline. Shares carry the
same asymmetry storage does, no better and no worse.

A share still cannot use the local shared-asset store — it must carry its own copy of the CSS
it references, so sharing is structurally less efficient than local storage.

### Frame layout

| Offset | Bytes | Field |
|---|---|---|
| 0 | 4 | magic `RAR1` |
| 4 | 1 | flags |
| 5 | 12 | IV |
| 17 | n | ciphertext |
| 17+n | 16 | GCM tag |

33 bytes of overhead. Flags bit 0 means "payload is deflate-raw compressed", always set in v1;
remaining bits reserved and must be zero. The magic lets the viewer distinguish *not a replay*
from *wrong key* from *the host returned junk* — three failures with completely different
remedies.

### Link

```
https://<endpoint>/#1.<object-id>.<key>
                    │  │           └ 43 chars base64url, 256-bit AES key
                    │  └ 22 chars base64url, 128 random bits
                    └ link format version, 1 char
```

~107 characters, clickable everywhere.

**The leading character is a format version, not a host id.** The viewer is served by the same
Worker that stores the object, so its own origin already identifies the backend — nothing in the
link needs to say where to look. Host ids stay internal to `share/hosts.js`, where they select an
uploader. If a second backend is ever added, `2` introduces a host field; that is what versions
are for.

### Worker routes

| Route | Behaviour |
|---|---|
| `PUT /u` | Validate token header, reject if uploads disabled, enforce size cap, generate a 128-bit id, stream body to R2, return `{id}` |
| `GET /b/<id>` | Stream the object back; clean 404 when absent or expired |
| everything else | Static assets from `public/`, with `/` serving the viewer |

**The 10 ms CPU limit is the design constraint: the Worker must never buffer or transform the
body.** Stream it. Enforce the size cap from `Content-Length` *plus* a streaming byte-count
guard, because `Content-Length` is client-supplied and trivially wrong.

### Sizing

Two figures get confused here, so both are stated. Across 7 real recordings the **store's**
`meta.compressedBytes` runs to 3,760,696 B (3.59 MB) at worst, mean 2.67 MB — a per-chunk total,
and explicitly **not** what the size check may use. What is actually uploaded is one whole-stream
deflate of a re-stripped replay, encrypted: for that same worst recording the frame measures
**3,644,834 B (3.48 MB)**, the figure `share/share-ui-support.js` checks against.

**Upload cap: 12,582,912 B (12 MB)** — 3.4× the largest frame measured. The cap exists for
legitimate headroom, not as abuse control; a match long enough to exceed it should be
shareable. The share dialog
computes payload size and refuses early with a clear reason rather than failing a PUT.

## Abuse and cost control

The account absorbing abuse belongs to the contributor, not to the repo owner, and Cloudflare
provides **no hard spend cap** — budget alerts notify but do not pause services. Control is
therefore layered:

| Control | What it stops |
|---|---|
| **Remain on the Workers Free plan** | The 100k requests/day limit returns Error 1027 and stops serving until 00:00 UTC, at no charge. This is the only hard ceiling in the stack. |
| Per-IP rate limit on `PUT /u` | Sustained automated upload from one source. Uses the **Workers rate-limiting binding**, not a WAF rule — WAF rate limiting is zone-scoped and does not apply to a `workers.dev` deployment. Applied before the token check, so token guessing is throttled too. |
| 12 MB size cap | Unbounded single objects |
| 7-day TTL | Storage accumulation; bounds the bill and the privacy window together |
| Upload token | A speed bump only. It ships inside a distributed extension and is therefore public by construction. |
| `UPLOADS_ENABLED` var | Disables uploads from the Cloudflare dashboard without a wrangler deploy |
| Budget alert | Tells the operator abuse is happening; does not stop it |

Egress on R2 is always free, which is what keeps the worst case bounded — a public file host that
is expensive to *read* is what generates horror stories, and R2 structurally cannot do that.

## Expiry

A single bucket-wide R2 lifecycle rule deletes objects 7 days after creation. Objects go within
~24 hours of expiry.

TTL is fixed, not per-share. Lifecycle rules are a property of the bucket, not of the object, so
a per-share setting would require either prefix-partitioned rules or Worker-enforced expiry
metadata — complexity that a single sensible default does not justify.

**There is no early revocation.** A share cannot be unshared before its TTL elapses. The instance
operator can delete an object manually with `wrangler` in response to a takedown request; that is
the only escape hatch, and it is an operator action, not a user feature.

## Credentials and self-hosting

Three layers stay strictly separate:

| Layer | Where it lives | Committed |
|---|---|---|
| Worker source, deploy docs, extension code | this repo | **yes** |
| Account id, bucket name, API tokens, custom domain | local config and `wrangler secret` | **never** |
| Which instance the extension talks to | a constant with a settings override | yes — a public URL, not a secret |

- No `wrangler.toml` in git; `wrangler.toml.example` with placeholders instead. Wrangler reads
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment.
- **Self-hosting is a first-class path.** `share/worker/README.md` must take the repo owner from
  a clean checkout to a working instance in under ten minutes, with no contributor-specific
  values anywhere.
- The default endpoint is a public URL in the source, labelled as the contributor's instance and
  overridable from extension settings without touching code.
- `audit-public` runs over the diff and history before the first push.

### Asset delivery

`share/worker/public/` is a wrangler static-assets directory and is **gitignored**. A small
`sync-assets.sh` copies the vendored rrweb bundle, the two `replay/` modules and the parse half
of `share/payload.js` into it before deploy, and the README makes that step one.

This keeps a single source of truth in git and adds no build step to the extension — the copy
belongs to the Worker, not to the extension. CSP forces the files to be served as same-origin
URLs rather than inlined, since `script-src 'self'` deliberately excludes `'unsafe-inline'`.

### CSP

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: https://assets.riftatlas-workers.com; connect-src 'self';
frame-src 'self' blob:; frame-ancestors 'none'
```

Applied in **two** places, because the two routes are served by different layers:

- `GET /b/<id>` is served by the Worker, which sets the header itself.
- The viewer page and its scripts are served by Cloudflare's static-asset layer, which runs
  **before** the Worker — the `fetch` handler is never invoked for them, so a header set in
  Worker code never reaches the viewer. A `public/_headers` file supplies it instead.

`_headers` is used rather than `[assets] run_worker_first` deliberately: running the Worker
ahead of every asset fetch would spend Worker invocations on static files, and the Workers Free
daily invocation ceiling is this instance's only hard spend cap (ADR 0001). Verified against the
deployed instance — an earlier revision of this document claimed the Worker could set the CSP
for the viewer page, and that was wrong.

`frame-ancestors` is stated explicitly because it has no fallback: `default-src 'none'` does not
cover it, and without it any site could iframe the viewer.

`style-src 'unsafe-inline'` is required because rrweb injects styles at runtime. `frame-src` is
required because rrweb builds its own `sandbox="allow-same-origin"` replay iframe — scripting
stays off inside it, which is what keeps opponent-controlled display names and chat inert.

## Error handling

The four load-bearing failures have completely different remedies, so one generic "failed to
load" is useless.

| Failure | Detected by | Told to the user as |
|---|---|---|
| Object missing or expired | 404 from `/b/<id>` | "This share has expired or was never uploaded." |
| Network or host unreachable | fetch rejects | "Couldn't reach the server." — retryable |
| Wrong key | `OperationError` from `subtle.decrypt` | "This link is incomplete or was altered." |
| Corrupt or truncated frame | bad magic, or short buffer | "This isn't a valid replay file." |
| Card-art CDN unreachable | images fail to load | Replay plays, cards blank — **say so** rather than looking broken |
| Payload over cap | size computed before upload | Refused before uploading, with the size and the cap |
| Uploads disabled, or R2 unavailable | 503 from `PUT /u` | The endpoint isn't accepting uploads — may be transient, or the operator turned sharing off. The two are indistinguishable to the client, so the message covers both. |
| Rate limited | 429 from `PUT /u` | "Too many uploads — try again shortly." |
| No usable replay | meta state is `error`, 0 B | **Share** control absent entirely for that match |

**Post-upload verification is mandatory.** After uploading, re-fetch the object under normal
browser rules and check the magic bytes before showing a link. This is precisely what would have
caught the filebin failure during research — a host that passed `curl` and served an HTML
interstitial to browsers. Never present an unverified link.

## Testing strategy

`node --test 'test/*.test.js'` — note plain `node --test test/` is broken on this Node version and
looks like a failure. 46 tests pass today and must keep passing.

Pure logic gets tests. Browser and network code does not, and must instead be kept small and
obviously correct.

New coverage:
- `share/payload.js` — round-trip identity; wrong key → `OperationError`; flipped byte →
  `OperationError`; bad magic → a distinct named error; truncated buffer → a distinct named error
- `share/hosts.js` — link build/parse round-trip, unknown version, malformed fragment, missing
  fields
- `replay/replay-timeline.js` — timeline construction, chapter marks, even spacing, truncation
  text; net-new coverage that does not exist today
- `test/vendor-contract.test.js` — updated to track `replay/replay-core.js`

Not unit tested: the Worker, the upload path, rrweb itself, viewer rendering.

**The dashboard refactor has no automated safety net.** Task 1 is verified by an explicit manual
checklist — fullscreen enter/exit, Escape handling, chapter chips, truncation banner, viewport
pinning, scale fit on resize, and keyboard transport — run before and after the change.

## Out of scope

- Per-share TTL; a single bucket-wide 7-day rule is the mechanism
- Early revocation, a `DELETE` route, and delete tokens
- Multiple storage backends — the registry exists so one *could* be added, not because one is
- Password-protected or recipient-restricted shares; the link is the credential
- Custom domain for the instance
- Share analytics or view counts
- Export/import of replays as files, and archive integration
- Any fix to the outstanding issues listed in the implementation plan's known-issues section
