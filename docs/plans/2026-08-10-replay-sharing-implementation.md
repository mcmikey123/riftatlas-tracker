# Replay Sharing Implementation Plan

**Goal:** share a visual replay as a short clickable URL that plays in any browser with no extension, no account and no software.

**Architecture:** the extension compresses and encrypts a replay client-side with a fresh random key, uploads the ciphertext to a Cloudflare Worker backed by R2, and builds a link to that same Worker carrying the object id and key in the URL fragment. The Worker serves both the viewer page and the ciphertext, so there is one origin and CORS never applies. A bucket-wide R2 lifecycle rule deletes objects after 7 days.

**Tech Stack:** Manifest V3 extension (no build step, vendored deps only), Cloudflare Workers + R2 free tier, `crypto.subtle` AES-GCM-256, `CompressionStream('deflate-raw')`, `node --test` for pure units.

**Design doc:** `docs/specs/2026-08-10-replay-sharing-design.md`
**Decision record:** `docs/adr/0001-remain-on-the-workers-free-plan.md`
**Glossary:** `CONTEXT.md`

---

## Status

**Revised 2026-08-10.** This replaces the first draft of this plan. Eleven decisions were settled
during a grilling pass and are folded in below; the sections the first draft marked as verified
research (host testing, payload measurements, crypto timings, rejected designs) survive unchanged
and are restated in the design doc rather than repeated here.

Nothing is implemented yet.

---

## 0. The credentials constraint

**This repo belongs to someone else. The Cloudflare account belongs to the contributor.** That
asymmetry is a hard design constraint, not a deployment detail.

1. **No `wrangler.toml` in git.** Commit `wrangler.toml.example` with placeholders; gitignore the
   real one. Wrangler reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the
   environment — use that, never a file.
2. **The repo has no `.gitignore` at all today.** Creating one is Task 0 and blocks everything
   else, because the first `wrangler` run will otherwise drop an account id into the working tree.
3. **Anyone can self-host.** `share/worker/README.md` must take the repo owner from a clean
   checkout to a working instance in under ten minutes with no contributor-specific values.
4. **The default endpoint is a public URL and belongs in the source**, labelled as the
   contributor's instance and overridable from extension settings without a code change.
5. **Nothing shipped inside a distributed extension is a secret.** The upload token is a public
   speed bump and the code must say so in a comment.
6. Run the `audit-public` skill over the diff and the history before the first push.
7. **Never commit a value that did not come from a `*.example` file.**

---

## 1. Current state

`main` is at `6e70c3d`. Branch is `feat/replay-sharing`, currently one commit ahead
(`3764ab0`, the first draft of this plan).

**46 tests pass** via `node --test 'test/*.test.js'`. Plain `node --test test/` is broken on this
Node version and will look like a failure — do not be fooled by it.

| File | What it gives you |
|---|---|
| `store/replay-store.js` | `get(matchId) → {meta, events}` — decompressed and CSS-rehydrated |
| `store/idb.js` | IndexedDB wrapper on the extension origin, driven from the service worker |
| `store/css-assets.js` | pure extract/rehydrate of stylesheet text by content hash |
| `background.js` | `ra:visual:*` message router; already uses `CompressionStream('deflate-raw')` |
| `dashboard/replay-html.js` | 532-line viewer: pure helpers, playback core and dashboard chrome, mixed |
| `dashboard/format.js` | defines `window.RATrackerFormat = { esc, fmtClock }` |
| `dashboard/dashboard.html` | loads `replay-html.js` at line 145 |
| `vendor/rrweb-replay.min.js` | IIFE global `rrwebReplay`, 80 KB — reused verbatim by the share viewer |
| `test/vendor-contract.test.js` | asserts rrweb members used by `dashboard/replay-html.js` exist on the bundle |

---

## 2. Settled decisions

Folded in from the grilling pass. Do not relitigate without new evidence.

| # | Decision | Why |
|---|---|---|
| 1 | Layered abuse control, **stay on the Workers Free plan** | Its 100k req/day hard stop is the only spend ceiling Cloudflare offers. See ADR 0001. |
| 1b | Per-IP limit via the **Workers rate-limiting binding** | Added after discovering the account has no zones; WAF rate-limiting rules are zone-scoped and unavailable on `workers.dev`. |
| 2 | **One fixed bucket-wide TTL**, no `shareTtlDays` setting | Lifecycle rules are a bucket property, not an object property. A per-share setting would need prefix partitioning or expiry metadata. |
| 3 | **No early revocation**, no `DELETE` route, no delete token | Simplest Worker. Operator can delete manually via `wrangler` for takedowns. |
| 4 | **TTL = 7 days** | Survives the week people take to click a link. ~45 MB steady state, ~$40/mo abuse ceiling. |
| 5 | Link's leading char is a **format version**, host ids stay internal | The viewer is served by the Worker that stores the object; its own origin identifies the backend. |
| 6 | Task 5 splits **three ways, and splits `wireControls` too** | Cleanest separation. Largest blast radius — mitigated by a manual checklist. |
| 7 | **Gitignored `public/` + a sync script** for Worker assets | Single source of truth in git, no build step added to the extension. |
| 8 | **Spike runs end-to-end against a deployed Worker** | Validates the real production path. Inverts ordering: needs Cloudflare access before anything is visually validated. |
| 9 | **Real exported replay** as spike input, supplied by the contributor | Only real data proves CSS rehydration against real Tailwind and real CDN art. |
| 10 | **12 MB upload cap** | 3.3× the largest observed replay (3.59 MB). The cap is headroom, not abuse control — the rate limit is. |
| 11 | **Reassurance-forward disclosure**, caveats secondary | The encryption property is real and worth stating. Caveats stay present, not deleted. |
| 12 | **Re-strip CSS with `extractCssAssets` before compressing a share** | `get()` returns CSS rehydrated inline, and compressing that directly is 42% larger — 5.95 MB against 3.48 MB, measured. It does *not* breach the cap; the reason is efficiency, not correctness. See the measurements below. |

### Measured share payloads, 6 real replays, 2026-08-10

Measured in the dashboard page against live data — not estimated.

| stored | events | keyframes | sheets | rehydrated | naive deflate | **re-stripped deflate** |
|---|---|---|---|---|---|---|
| 3.59 MB | 39,659 | 34 | 3 | 58.78 MB | 5.95 MB | **3.48 MB** |
| 3.54 MB | 39,798 | 33 | 3 | 58.03 MB | 5.87 MB | **3.47 MB** |
| 3.31 MB | 38,612 | 32 | 3 | 53.93 MB | 5.58 MB | **3.25 MB** |
| 3.07 MB | 34,068 | 32 | 3 | 51.48 MB | 5.37 MB | **3.05 MB** |
| 1.67 MB | 19,149 | 16 | 3 | 27.00 MB | 2.81 MB | **1.67 MB** |
| 0.18 MB | 828 | 3 | 3 | 3.32 MB | 0.41 MB | **0.25 MB** |

What this settles:

- **Worst-case share payload is 3.48 MB.** The 12 MB cap has 3.4× headroom, and 2× even if the
  re-strip were skipped entirely.
- **Re-stripping saves ~42%** (5.95 → 3.48 MB worst case). Worth doing, but it is an efficiency
  measure. An earlier revision of this plan claimed the naive path would breach the cap; that was
  wrong, and the measurement above is why.
- **A re-stripped whole-stream deflate slightly beats the stored size** (3.48 vs 3.59 MB), because
  storage deflates per 256 KB chunk while a share compresses the stream in one pass. The CSS
  therefore costs essentially nothing once deduplicated — the earlier "+50–80 KB" allowance was
  pessimistic.
- **The rehydrated object reaches 58.78 MB in memory.** This, not payload size, is the real cost
  of the rehydrate-then-re-strip round trip: `JSON.stringify` over 58 MB runs on the dashboard's
  UI thread before any compression happens. Task 7 must not block the UI on it, and it is the
  strongest argument for adding a `ra:visual:getRaw` message that skips rehydration.
- Every replay references exactly **3** shared stylesheets.

### Earlier per-match storage figures, from 7 recordings

Largest 3.59 MB, mean 2.67 MB, both compressed and CSS-stripped. Shared stylesheets are
993.3 KB uncompressed across 4 blobs, stored once locally by content hash — but **every share
must carry its own copy of the CSS it used**, roughly 50–80 KB deflated. Worst case observed is
therefore **~3.65 MB**, confirming the original ~3.6 MB design target against real data.

One of the 7 recordings is `0 B / error`. Matches with no usable replay must not show a Share
control at all.

---

## 3. File map

| Path | Single responsibility | New |
|---|---|---|
| `.gitignore` | keep credentials and generated assets out of git | yes |
| `CONTEXT.md` | domain glossary | yes (written) |
| `share/payload.js` | build and parse the encrypted frame; key generation | yes |
| `share/hosts.js` | base64url, link construction and parsing, uploader registry | yes |
| `share/worker/src/worker.js` | three routes, size cap, token check, kill switch | yes |
| `share/worker/wrangler.toml.example` | config template with placeholders | yes |
| `share/worker/sync-assets.sh` | copy vendored and shared files into `public/` | yes |
| `share/worker/README.md` | deploy-your-own instructions | yes |
| `share/worker/public/_headers` | CSP and security headers for the asset layer, which runs before the Worker | yes |
| `share/worker/public/index.html` | share viewer page | yes |
| `share/worker/public/viewer.js` | fragment parsing, fetch, decrypt, mount | yes |
| `replay/replay-timeline.js` | pure timeline, chapters, truncation text | yes |
| `replay/replay-core.js` | rrweb Replayer lifecycle, pinning, scale fit, transport | yes |
| `dashboard/replay-html.js` | dashboard chrome only; delegates to the core | modified |
| `dashboard/dashboard.html` | load the two new `replay/` modules | modified |
| `dashboard/dashboard.js` | Share control in the expanded match row; shares list | modified |
| `test/share-payload.test.js` | frame round-trip and the four failure modes | yes |
| `test/share-hosts.test.js` | link build/parse and malformed input | yes |
| `test/replay-timeline.test.js` | net-new coverage for the extracted pure helpers | yes |
| `test/vendor-contract.test.js` | retarget the rrweb source map at `replay/replay-core.js` | modified |

---

## 4. Tasks

Each task: write the failing test, run it, watch it fail with the expected message, implement,
run it, watch it pass, commit. Conventional Commits. **No AI attribution trailers of any kind.**
Stage files by exact path — never `git add -A`.

Pure logic gets `node --test` coverage. Browser and network code does not, and must instead be
kept small and obviously correct.

---

### Task 0 — `.gitignore` and config hygiene *(blocks everything)*

Create `.gitignore`:

```gitignore
# Cloudflare — never commit anything that identifies or authenticates an account
share/worker/wrangler.toml
share/worker/.env
share/worker/.dev.vars
.wrangler/
.dev.vars
.env

# Generated: synced into the Worker's static assets directory before deploy
share/worker/public/vendor/
share/worker/public/replay/
share/worker/public/share/

# Spike scratch
share/spike/

# Tooling
node_modules/
*.local

# OS noise
.DS_Store
Thumbs.db
desktop.ini
```

Create `share/worker/wrangler.toml.example`:

```toml
# Copy to wrangler.toml and fill in. wrangler.toml is gitignored — never commit it.
# Account id and API token come from the environment, not from this file:
#   export CLOUDFLARE_ACCOUNT_ID=...
#   export CLOUDFLARE_API_TOKEN=...

name = "riftatlas-replay-share"
main = "src/worker.js"
compatibility_date = "2026-08-10"

[assets]
directory = "public"
binding = "ASSETS"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "REPLACE_WITH_YOUR_BUCKET_NAME"

[vars]
UPLOADS_ENABLED = "true"
MAX_UPLOAD_BYTES = "12582912"

# UPLOAD_TOKEN is set with `wrangler secret put UPLOAD_TOKEN`, never here.
```

Create `share/worker/env.example`, matching the convention already used by the contributor's
other Worker at `html-utils/workers/userscript-install`. Note the missing leading dot: the
pre-commit secret guard blocks any staged file whose *name* matches `.env.example`, regardless
of contents, so the template is named `env.example` and copied to the gitignored `.env`.

```sh
# Copy to .env and fill in. .env is gitignored — never commit it.
# Named without the leading dot so it does not trip secret-scanning filename rules.
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
CLOUDFLARE_API_TOKEN=your_token_here
```

Verify:

```bash
node --test 'test/*.test.js'                              # 46 passing, unchanged
git check-ignore -v share/worker/wrangler.toml            # prints the matching .gitignore rule
git check-ignore -v share/worker/.env                     # prints the matching rule
git check-ignore -v share/worker/public/vendor/rrweb.js   # prints the matching rule
git status --porcelain                                    # only the two new files
```

Commit — note `CONTEXT.md`, the design doc and the ADR ride along here as the documentation
that describes what follows:

```bash
git add .gitignore share/worker/wrangler.toml.example share/worker/env.example CONTEXT.md \
        docs/specs/2026-08-10-replay-sharing-design.md \
        docs/adr/0001-remain-on-the-workers-free-plan.md \
        docs/plans/2026-08-10-replay-sharing-implementation.md
git commit -m "chore: add gitignore, worker config template and sharing design docs"
```

---

### Task 1 — `share/payload.js`, the encrypted frame *(pure, testable)*

Deals in bytes only. No URLs, no base64 — those belong to Task 2.

**Frame layout:** `RAR1` magic (4 B) ‖ flags `uint8` (1 B) ‖ IV (12 B) ‖ ciphertext ‖ GCM tag
(16 B). 33 B overhead. Flags bit 0 means deflate-raw compressed, always set in v1; all other bits
reserved and must be zero.

Write `test/share-payload.test.js` first:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSharePayload,
  parseSharePayload,
  generateKey,
  exportKey,
  importKey
} = require("../share/payload.js");

// Node 24 provides crypto, CompressionStream and DecompressionStream as globals, so these
// tests exercise the real defaults. The deps seam exists so callers can stub them; an empty
// object takes exactly the path the extension takes.
const deps = {};
const fixture = {
  meta: { matchId: "m1", viewport: { w: 1920, h: 1080 } },
  events: [{ type: 2, timestamp: 1 }, { type: 3, timestamp: 2 }],
  assets: { abc123: ".board{color:red}" }
};

test("a payload round-trips through build and parse", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepStrictEqual(await parseSharePayload(bytes, key, deps), fixture);
});

test("the frame carries the RAR1 magic and the deflate flag", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  assert.deepStrictEqual([...bytes.slice(0, 4)], [0x52, 0x41, 0x52, 0x31]);
  assert.strictEqual(bytes[4], 0x01);
});

test("the wrong key is rejected as OperationError, not as a format error", async () => {
  const bytes = await buildSharePayload(fixture, await generateKey(deps), deps);
  const wrong = await generateKey(deps);
  await assert.rejects(() => parseSharePayload(bytes, wrong, deps), { name: "OperationError" });
});

test("a flipped ciphertext byte is rejected as OperationError", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  bytes[25] ^= 0xff;
  await assert.rejects(() => parseSharePayload(bytes, key, deps), { name: "OperationError" });
});

test("bad magic is a distinct named error, not a decryption failure", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  bytes[0] = 0x58;
  await assert.rejects(() => parseSharePayload(bytes, key, deps), {
    name: "ShareFormatError",
    message: /not a Rift Atlas replay/
  });
});

test("a truncated buffer is a distinct named error", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  await assert.rejects(() => parseSharePayload(bytes.slice(0, 20), key, deps), {
    name: "ShareTruncatedError"
  });
});

test("an unknown flag bit is refused rather than ignored", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  bytes[4] = 0x03;
  await assert.rejects(() => parseSharePayload(bytes, key, deps), { name: "ShareFormatError" });
});

test("a key survives export and import as 32 raw bytes", async () => {
  const key = await generateKey(deps);
  const raw = await exportKey(key, deps);
  assert.strictEqual(raw.length, 32);
  const bytes = await buildSharePayload(fixture, key, deps);
  const reimported = await importKey(raw, deps);
  assert.deepStrictEqual(await parseSharePayload(bytes, reimported, deps), fixture);
});
```

Run it and confirm it fails with `Cannot find module '.../share/payload.js'`.

Implement `share/payload.js`:

```js
// Build and parse the encrypted frame that carries a shared replay.
//
// Frame: "RAR1" (4) | flags (1) | IV (12) | ciphertext | GCM tag (16) = 33 bytes overhead.
// Compress THEN encrypt; the reverse makes compression useless.
//
// crypto and the compression streams are injected so tests can run under node:crypto
// and stub them, exactly as store/replay-store.js already does.
(function (root) {
  "use strict";

  const MAGIC = [0x52, 0x41, 0x52, 0x31]; // "RAR1"
  const FLAG_DEFLATE = 0x01;
  const KNOWN_FLAGS = FLAG_DEFLATE;
  const IV_BYTES = 12;
  const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES; // 17
  const TAG_BYTES = 16;

  class ShareFormatError extends Error {
    constructor(message) {
      super(message);
      this.name = "ShareFormatError";
    }
  }

  class ShareTruncatedError extends Error {
    constructor(message) {
      super(message);
      this.name = "ShareTruncatedError";
    }
  }

  function subtleOf(deps) {
    return (deps && deps.crypto ? deps.crypto : globalThis.crypto).subtle;
  }

  function randomBytes(deps, n) {
    const c = deps && deps.crypto ? deps.crypto : globalThis.crypto;
    return c.getRandomValues(new Uint8Array(n));
  }

  async function defaultCompress(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function defaultDecompress(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function compressorOf(deps) {
    return (deps && deps.compress) || defaultCompress;
  }

  function decompressorOf(deps) {
    return (deps && deps.decompress) || defaultDecompress;
  }

  async function generateKey(deps) {
    return subtleOf(deps).generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt"
    ]);
  }

  async function exportKey(key, deps) {
    return new Uint8Array(await subtleOf(deps).exportKey("raw", key));
  }

  async function importKey(raw, deps) {
    return subtleOf(deps).importKey("raw", raw, { name: "AES-GCM" }, true, [
      "encrypt",
      "decrypt"
    ]);
  }

  async function buildSharePayload(payload, key, deps) {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const deflated = await compressorOf(deps)(json);
    const iv = randomBytes(deps, IV_BYTES);
    const sealed = new Uint8Array(
      await subtleOf(deps).encrypt({ name: "AES-GCM", iv }, key, deflated)
    );

    const frame = new Uint8Array(HEADER_BYTES + sealed.length);
    frame.set(MAGIC, 0);
    frame[MAGIC.length] = FLAG_DEFLATE;
    frame.set(iv, MAGIC.length + 1);
    frame.set(sealed, HEADER_BYTES);
    return frame;
  }

  async function parseSharePayload(bytes, key, deps) {
    if (bytes.length < HEADER_BYTES + TAG_BYTES) {
      throw new ShareTruncatedError("share frame is shorter than an empty frame");
    }
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC[i]) {
        throw new ShareFormatError("not a Rift Atlas replay share");
      }
    }

    const flags = bytes[MAGIC.length];
    if (flags & ~KNOWN_FLAGS) {
      throw new ShareFormatError("share frame uses a newer format than this viewer understands");
    }
    if (!(flags & FLAG_DEFLATE)) {
      throw new ShareFormatError("share frame is missing the compression flag");
    }

    const iv = bytes.subarray(MAGIC.length + 1, HEADER_BYTES);
    const sealed = bytes.subarray(HEADER_BYTES);

    // Propagates OperationError on a wrong key or tampered bytes. That name is
    // load-bearing: the UI distinguishes it from a format error.
    const deflated = new Uint8Array(
      await subtleOf(deps).decrypt({ name: "AES-GCM", iv }, key, sealed)
    );
    const json = await decompressorOf(deps)(deflated);
    return JSON.parse(new TextDecoder().decode(json));
  }

  // Same dual export as store/css-assets.js: a global for the extension, CommonJS for tests.
  const api = {
    ShareFormatError,
    ShareTruncatedError,
    HEADER_BYTES,
    TAG_BYTES,
    generateKey,
    exportKey,
    importKey,
    buildSharePayload,
    parseSharePayload
  };

  root.RAShare = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
```

Run `node --test 'test/*.test.js'` — 46 + 8 = **54 passing**.

```bash
git add share/payload.js test/share-payload.test.js
git commit -m "feat(share): add the encrypted share payload format"
```

---

### Task 2 — `share/hosts.js`, links and the uploader registry *(pure, testable)*

Deals in strings and URLs. The uploader is the only impure part and takes `fetch` as a
parameter so the pure surface stays testable without network.

Write `test/share-hosts.test.js` first:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  toBase64Url,
  fromBase64Url,
  buildLink,
  parseLink,
  hostFor
} = require("../share/hosts.js");

const KEY = new Uint8Array(32).fill(7);
const ENDPOINT = "https://share.example.workers.dev";
const OBJECT_ID = "AAAAAAAAAAAAAAAAAAAAAA";

test("base64url round-trips and uses no padding or unsafe characters", () => {
  const encoded = toBase64Url(KEY);
  assert.strictEqual(encoded.length, 43);
  assert.ok(!/[+/=]/.test(encoded));
  assert.deepStrictEqual([...fromBase64Url(encoded)], [...KEY]);
});

test("a link carries version, object id and key in the fragment", () => {
  const link = buildLink({ endpoint: ENDPOINT, objectId: OBJECT_ID, keyBytes: KEY });
  assert.strictEqual(link, `${ENDPOINT}/#1.${OBJECT_ID}.${toBase64Url(KEY)}`);
  assert.ok(link.length < 120, "links must stay short enough to paste anywhere");
});

test("a link round-trips through parseLink", () => {
  const link = buildLink({ endpoint: ENDPOINT, objectId: OBJECT_ID, keyBytes: KEY });
  const parsed = parseLink(link);
  assert.strictEqual(parsed.version, "1");
  assert.strictEqual(parsed.objectId, OBJECT_ID);
  assert.deepStrictEqual([...parsed.keyBytes], [...KEY]);
});

test("a bare fragment parses the same as a full link", () => {
  const parsed = parseLink(`#1.${OBJECT_ID}.${toBase64Url(KEY)}`);
  assert.strictEqual(parsed.objectId, OBJECT_ID);
});

test("a trailing slash on the endpoint does not double up", () => {
  const link = buildLink({ endpoint: `${ENDPOINT}/`, objectId: OBJECT_ID, keyBytes: KEY });
  assert.ok(!link.includes("//#"));
});

test("an unknown link version is refused by name", () => {
  assert.throws(() => parseLink(`#9.${OBJECT_ID}.${toBase64Url(KEY)}`), {
    name: "ShareLinkError",
    message: /newer/
  });
});

test("malformed fragments are refused rather than half-parsed", () => {
  for (const bad of ["", "#", "#1", `#1.${OBJECT_ID}`, "#1..", `#1.${OBJECT_ID}.`, "#1.a.b.c"]) {
    assert.throws(() => parseLink(bad), { name: "ShareLinkError" }, `expected refusal for ${bad}`);
  }
});

test("a key of the wrong length is refused", () => {
  assert.throws(() => parseLink(`#1.${OBJECT_ID}.${toBase64Url(new Uint8Array(16))}`), {
    name: "ShareLinkError",
    message: /key/
  });
});

test("the worker host is registered and unknown ids are refused", () => {
  assert.strictEqual(hostFor("w").id, "w");
  assert.throws(() => hostFor("zz"), { name: "ShareLinkError" });
});
```

Run it and confirm it fails with `Cannot find module '.../share/hosts.js'`.

Implement `share/hosts.js`:

```js
// Link construction and parsing, plus the registry of things that can store a share.
//
// Link: https://<endpoint>/#<version>.<object-id>.<key>
//
// The leading character is a LINK FORMAT VERSION, not a host id. The viewer is served by
// the same Worker that stores the object, so its own origin already identifies the backend
// and nothing in the link needs to say where to look. Host ids stay internal to this file,
// where they select an uploader. A second backend would ship as version "2" with a host field.
(function (root) {
  "use strict";

  const LINK_VERSION = "1";
  const KEY_BYTES = 32;
  const OBJECT_ID_CHARS = 22; // 128 bits, base64url, unpadded

  class ShareLinkError extends Error {
    constructor(message) {
      super(message);
      this.name = "ShareLinkError";
    }
  }

  function toBase64Url(bytes) {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(text) {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function buildLink({ endpoint, objectId, keyBytes }) {
    const base = String(endpoint).replace(/\/+$/, "");
    return `${base}/#${LINK_VERSION}.${objectId}.${toBase64Url(keyBytes)}`;
  }

  function parseLink(input) {
    const hash = String(input).slice(String(input).indexOf("#"));
    if (!hash.startsWith("#")) throw new ShareLinkError("link has no fragment");

    const parts = hash.slice(1).split(".");
    if (parts.length !== 3) throw new ShareLinkError("link fragment is malformed");

    const [version, objectId, keyText] = parts;
    if (version !== LINK_VERSION) {
      throw new ShareLinkError("this link uses a newer format than this viewer understands");
    }
    if (objectId.length !== OBJECT_ID_CHARS || !/^[A-Za-z0-9_-]+$/.test(objectId)) {
      throw new ShareLinkError("link fragment is malformed");
    }
    if (!keyText || !/^[A-Za-z0-9_-]+$/.test(keyText)) {
      throw new ShareLinkError("link fragment is malformed");
    }

    const keyBytes = fromBase64Url(keyText);
    if (keyBytes.length !== KEY_BYTES) throw new ShareLinkError("link key is the wrong length");

    return { version, objectId, keyBytes };
  }

  // upload() is the only impure member; fetch is passed in rather than closed over.
  const WORKER_HOST = {
    id: "w",
    async upload(bytes, { endpoint, token, fetch: doFetch }) {
      const res = await doFetch(`${String(endpoint).replace(/\/+$/, "")}/u`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "x-share-token": token },
        body: bytes
      });
      if (!res.ok) {
        const err = new Error(`upload failed with ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const { id } = await res.json();
      return id;
    }
  };

  const HOSTS = { [WORKER_HOST.id]: WORKER_HOST };

  function hostFor(id) {
    const host = HOSTS[id];
    if (!host) throw new ShareLinkError(`unknown share host "${id}"`);
    return host;
  }

  // Same dual export as store/css-assets.js: a global for the extension, CommonJS for tests.
  const api = {
    ShareLinkError,
    LINK_VERSION,
    KEY_BYTES,
    toBase64Url,
    fromBase64Url,
    buildLink,
    parseLink,
    hostFor
  };

  root.RAShareHosts = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
```

Run `node --test 'test/*.test.js'` — 54 + 9 = **63 passing**.

```bash
git add share/hosts.js test/share-hosts.test.js
git commit -m "feat(share): add share link format and host registry"
```

---

### Task 3 — the Worker

**The 10 ms CPU limit is the design constraint: never buffer or transform the body.** Stream it.
Enforce the cap from `Content-Length` *and* a streaming byte counter, because `Content-Length` is
client-supplied and trivially wrong.

Create `share/worker/src/worker.js` (the version below is the corrected one that is actually deployed):

```js
// Three routes. Everything else falls through to the static assets binding,
// which serves the viewer page at /.
//
//   PUT /u      upload ciphertext, return {id}
//   GET /b/<id> stream the ciphertext back
//   GET /       viewer page (via ASSETS)
//
// The 10ms CPU limit is the design constraint: never buffer or transform the body.
// Objects are deleted by a bucket-wide R2 lifecycle rule, not by this Worker — there is
// no delete route and no revocation. See docs/specs/2026-08-10-replay-sharing-design.md.

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // rrweb injects styles at runtime
  "img-src 'self' data: https://assets.riftatlas-workers.com",
  "connect-src 'self'",
  "frame-src 'self' blob:" // rrweb builds its own sandboxed replay iframe
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};

function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS }
  });
}

function newObjectId() {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function upload(request, env) {
  if (env.UPLOADS_ENABLED !== "true") {
    return json({ error: "uploads are temporarily disabled" }, 503);
  }

  // Per-IP limit, applied before the token check so token guessing is throttled too.
  //
  // This uses the Workers rate-limiting binding rather than a WAF rate-limiting rule,
  // because WAF rules are zone-scoped and this Worker is served from workers.dev, which
  // has no zone. The binding is absent under `wrangler dev`, hence the guard.
  if (env.RATE_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return json({ error: "too many uploads, try again shortly" }, 429);
  }

  // A speed bump, not a secret: this token ships inside a distributed extension and is
  // public by construction. Real abuse control is the size cap, the Cloudflare rate-limit
  // rule, the short TTL, and the Workers Free daily ceiling. See docs/adr/0001.
  if (request.headers.get("x-share-token") !== env.UPLOAD_TOKEN) {
    return json({ error: "bad token" }, 403);
  }

  // Content-Length is required, not optional: R2 will not accept a stream of unknown
  // length, and FixedLengthStream below needs a number to enforce.
  const limit = Number(env.MAX_UPLOAD_BYTES);
  const declared = Number(request.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared <= 0) {
    return json({ error: "content-length required" }, 411);
  }
  if (declared > limit) return json({ error: "too large", limit, declared }, 413);
  if (!request.body) return json({ error: "empty body" }, 400);

  // FixedLengthStream gives R2 the known length it needs while keeping the body streamed,
  // and it fails the upload if the client's Content-Length was a lie in either direction.
  // That is the size guard: a client cannot declare 1 KB and then send 100 MB.
  const sized = new FixedLengthStream(declared);
  request.body.pipeTo(sized.writable).catch(() => {
    /* surfaces on the put() below */
  });

  const id = newObjectId();
  try {
    await env.BUCKET.put(id, sized.readable);
  } catch (err) {
    return json({ error: "upload failed", detail: String((err && err.message) || err) }, 400);
  }
  return json({ id }, 201);
}

async function download(id, env) {
  const object = await env.BUCKET.get(id);
  if (!object) return json({ error: "not found" }, 404);

  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=3600, immutable",
      ...SECURITY_HEADERS
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/u") {
      if (request.method !== "PUT") return json({ error: "method not allowed" }, 405);
      return upload(request, env);
    }

    if (url.pathname.startsWith("/b/")) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return download(url.pathname.slice(3), env);
    }

    return withHeaders(await env.ASSETS.fetch(request));
  }
};
```

Create `share/worker/sync-assets.sh`:

```bash
#!/usr/bin/env sh
# Copy the files the viewer shares with the extension into the static assets directory.
# public/ subdirectories are gitignored: git holds one copy, deploy gets a duplicate.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)

mkdir -p "$here/public/vendor" "$here/public/replay" "$here/public/share"
cp "$repo/vendor/rrweb-replay.min.js" "$here/public/vendor/"
cp "$repo/vendor/rrweb.min.css"       "$here/public/vendor/"
cp "$repo/replay/replay-timeline.js"  "$here/public/replay/"
cp "$repo/replay/replay-core.js"      "$here/public/replay/"
cp "$repo/share/payload.js"           "$here/public/share/"
cp "$repo/share/hosts.js"             "$here/public/share/"
echo "synced into $here/public"
```

Create `share/worker/README.md` covering, with no contributor-specific values anywhere:

1. Prerequisites: a Cloudflare account, `npx wrangler`, and the note that **R2 requires a payment
   method on file even for the free tier**.
2. `export CLOUDFLARE_ACCOUNT_ID=…` and `export CLOUDFLARE_API_TOKEN=…`.
3. `cp wrangler.toml.example wrangler.toml` and fill in `bucket_name`.
4. Create the bucket: `npx wrangler r2 bucket create <name>`.
5. **Set the lifecycle rule to delete objects after 7 days.** Sharing has no revocation, so this
   rule is the only thing that ever deletes anything.
6. `npx wrangler secret put UPLOAD_TOKEN`.
7. `sh sync-assets.sh && npx wrangler deploy`.
8. Add a per-IP rate limit rule on `PUT /u` in the dashboard.
9. **Stay on the Workers Free plan** — link to ADR 0001 and explain that the 100k req/day hard
   stop is the only spend ceiling Cloudflare offers.
10. Point the extension at the result: Settings → Share endpoint.

```bash
chmod +x share/worker/sync-assets.sh
node --test 'test/*.test.js'   # still 63 passing; the Worker has no unit tests by design
git add share/worker/src/worker.js share/worker/sync-assets.sh share/worker/README.md
git commit -m "feat(worker): add the replay sharing worker"
```

**Rate limiting uses the Workers binding, not a WAF rule.** The contributor's account has no
zones — only a `workers.dev` subdomain — and WAF rate-limiting rules are zone-scoped, so the
rule the first draft assumed is not available. A `[[ratelimits]]` binding keyed on
`cf-connecting-ip` replaces it, applied before the token check so token guessing is throttled
too. A self-hoster who puts their instance behind a domain gains a WAF rule as an extra layer.

**Verified against a live deployment on 2026-08-10.** Three corrections came out of it:

1. **`env.BUCKET.put` will not accept a stream of unknown length.** The first revision piped the
   body through a byte-counting `TransformStream`, which strips the length and makes every
   upload fail. `Content-Length` is now required (411 without it) and the body goes through
   `FixedLengthStream(declared)`, which both satisfies R2 and enforces the declared size — a
   client cannot claim 1 KB and send 100 MB. Verified byte-identical on a 3.7 MB round-trip.
2. **The `[[ratelimits]]` binding uses `name`, not `binding`**, and *is* available on the free
   tier — the deploy reports `env.RATE_LIMITER (20 requests/60s)`.
3. **Static assets are served before the Worker runs**, so the Worker cannot set the CSP on the
   viewer page. A `public/_headers` file does it instead. See the design doc.

Also learned: deploys take roughly 20–30 seconds to propagate. Testing immediately after
`wrangler deploy` hits the previous version and produces confusing results.

---

### 🔑 Gate A — Cloudflare access *(blocks Task 4)*

Task 4 cannot start until the contributor supplies, out of band and **never into the repo**:

- `CLOUDFLARE_ACCOUNT_ID` and a scoped `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, R2: Edit)
- the bucket name to use
- confirmation the 7-day lifecycle rule is set
- confirmation the account is on the Workers **Free** plan
- the deployed `*.workers.dev` hostname, which becomes the default endpoint constant

`api.cloudflare.com` is already allowed through the local proxy, so `wrangler` deploys work from
inside this environment once the token exists.

### 🔑 Gate B — a real exported replay *(blocks Task 4)*

One real replay exported from the contributor's extension — `get(matchId)` from the dashboard
devtools console, saved as JSON into `share/spike/` (gitignored). A synthesised fixture cannot
prove CSS rehydration against real Tailwind or card art against the real CDN, which are the two
things most likely to break.

---

### Task 4 — the end-to-end spike

**Nothing after this task is validated until this plays.** Throwaway code, gitignored, thrown
away afterwards; what survives is a findings section appended to the design doc.

1. Deploy the Task 3 Worker (Gate A).
2. Node script in `share/spike/` loads the Gate B replay, calls `buildSharePayload`, uploads via
   `WORKER_HOST.upload`, prints the link from `buildLink`.
3. Minimal viewer at `share/worker/public/index.html` — enough to parse the fragment, fetch,
   decrypt, inflate and hand `{meta, events}` to a bare `rrwebReplay.Replayer`.
4. **Open the link in the host browser on Windows, not in this container.**
   `assets.riftatlas-workers.com` is not in the local proxy allowlist, so card art cannot load
   from in here. The host browser fetches the CDN directly and the proxy never sees it.

Pass criteria — all must hold before Task 5 starts:

- [ ] Replayer mounts on a plain `https://` page outside the extension
- [ ] plays through at least one keyframe boundary without tearing
- [ ] CSS rehydration produces a styled board, not unstyled markup
- [ ] card art loads from `assets.riftatlas-workers.com`
- [ ] `subtle.decrypt` handles the real ~3.6 MB payload in-page
- [ ] `DecompressionStream('deflate-raw')` round-trips it
- [ ] the CSP in Task 3 does not break rrweb
- [ ] measured deflated size of the real `assets` store, to replace the 50–80 KB estimate
- [ ] **measured deflated size of a re-stripped share payload, against the 12 MB cap** — and the
      deflated size of the naive rehydrated stream alongside it, to confirm decision 12 with a
      number rather than arithmetic
- [ ] `rehydrateCssAssets` in the viewer reproduces a styled board from the re-stripped payload

Free diagnostic while a replay is open — this settles suspect T2 in the known-issues section at
no extra cost:

```js
document.querySelector("iframe").contentDocument
  .head.querySelectorAll('link[rel="stylesheet"]').length   // zero kills T2
```

```bash
git add docs/specs/2026-08-10-replay-sharing-design.md
git commit -m "docs(share): record end-to-end spike findings"
```

---

### Task 5 — portable viewer core

Split `dashboard/replay-html.js` (532 lines) three ways, and split `wireControls` along
transport-versus-chrome lines.

- `replay/replay-timeline.js` — **pure**: `quantise`, `turnOf`, `timeline`, `evenly`,
  `truncationText` (currently lines 50–112). No DOM, no `esc`.
- `replay/replay-core.js` — Replayer lifecycle, `pin`, `fit`, `refit`, and transport
  (`seek`, `play`, `pause`, `stepTo`, tick subscription). No markup, no CSS class names, no
  `RATrackerFormat`.
- `dashboard/replay-html.js` — chrome only: `renderShell`, fullscreen, input wiring, `openModal`.
  Delegates to the core.

They live in a new top-level `replay/` because the share viewer is an equal consumer; copying
them out of `dashboard/` at deploy time would enshrine a false ownership.
`dashboard/dashboard.html` gains two script tags before line 145.

**Viewport pinning is load-bearing.** The iframe is pinned to `meta.viewport.w × h` and scaled
with `transform: scale()`, never resized — replaying at another width fires different media
queries and reintroduces the drift this whole feature exists to remove.

**`test/vendor-contract.test.js` must be updated in the same commit.** Its `sources` map at
line ~109 reads `dashboard/replay-html.js` from disk and asserts every rrweb member that file
calls exists on the vendored bundle. Once the `Replayer` construction moves out, that assertion
passes vacuously against a file that no longer touches rrweb — a false green, worse than a
failure. Retarget it:

```js
  const sources = {
    "capture/dom-recorder.js": record,
    "replay/replay-core.js": replay
  };
```

Add `test/replay-timeline.test.js` covering the extracted pure helpers — timeline construction
from an event stream, chapter marks at turn boundaries, `evenly` capping marks, and truncation
text for complete / truncated / incomplete metas. This is net-new coverage; those functions have
none today.

**Manual verification checklist — there is no automated safety net for the chrome.** Run in the
dashboard before and after, on a match with a replay:

- [ ] replay opens, plays and pauses
- [ ] slider seeks; time display tracks
- [ ] step forward and back land on board states
- [ ] chapter chips seek to their turn
- [ ] truncation banner shows on a truncated replay
- [ ] fullscreen enters and exits, button `aria-pressed` flips
- [ ] Escape leaves fullscreen without closing the modal
- [ ] board stays pinned and scaled correctly on window resize
- [ ] keyboard: space, left, right, `f`

```bash
node --test 'test/*.test.js'   # 63 + timeline tests
git add replay/replay-timeline.js replay/replay-core.js dashboard/replay-html.js \
        dashboard/dashboard.html test/replay-timeline.test.js test/vendor-contract.test.js
git commit -m "refactor(dashboard): extract a portable replay playback core"
```

---

### Task 6 — the share viewer page

`share/worker/public/index.html` and `public/viewer.js`, promoted from the Task 4 spike. Parses
the fragment with `parseLink`, fetches `/b/<id>`, decrypts with `parseSharePayload`, rehydrates
CSS, mounts `replay/replay-core.js`.

Scripts load as separate same-origin `<script src>` tags, not inline — `script-src 'self'` has no
`'unsafe-inline'` on purpose.

Every failure gets its own message, because the remedies differ completely and one generic
"failed to load" is useless:

| Condition | Message |
|---|---|
| 404 from `/b/<id>` | "This share has expired or was never uploaded." |
| fetch rejects | "Couldn't reach the server." + retry button |
| `OperationError` | "This link is incomplete or was altered." |
| `ShareFormatError` / `ShareTruncatedError` | "This isn't a valid replay file." |
| `ShareLinkError` | "This link is malformed." |
| card art fails to load | replay plays, banner: "Card images couldn't load — the game's image server is unreachable." |

```bash
sh share/worker/sync-assets.sh && npx wrangler deploy   # from share/worker/
git add share/worker/public/index.html share/worker/public/viewer.js
git commit -m "feat(worker): add the share viewer page"
```

---

### Task 7 — share UI

A **Share** control beside the existing replay control in the expanded match row. Absent entirely
for matches with no usable replay — the diagnostics show a real `0 B / error` match, so this case
is live, not theoretical.

Flow: fetch replay → **re-strip CSS** → build payload → check size against the cap → upload →
**verify** → show the link with a copy button.

**The re-strip is not optional.** `ra:visual:get` returns `{meta, events}` with stylesheet text
rehydrated inline; there is no `assets` field to pass on. Compressing that directly puts roughly
34 MB of duplicated CSS through a 32 KB deflate window and exceeds the cap. Re-strip with the
same pure function storage uses, and hand the result to `buildSharePayload`:

```js
const reply = await new Promise((resolve) =>
  chrome.runtime.sendMessage({ type: "ra:visual:get", matchId }, resolve)
);
if (!reply || !reply.ok || !reply.replay) throw new Error("replay could not be read");

const sha256Hex = async (text) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const { events, assets } = await extractCssAssets(reply.replay.events, { hash: sha256Hex });
const payload = {
  meta: reply.replay.meta,
  events,
  assets: Object.fromEntries(assets) // assets is a Map; JSON needs a plain object
};
```

`dashboard/dashboard.html` must load `store/css-assets.js` for this — today only the service
worker does. The viewer calls `rehydrateCssAssets(events, new Map(Object.entries(assets)))`
after decrypting, which is the exact inverse.

- **Post-upload verification is mandatory, not a nicety.** Re-fetch the object under normal
  browser rules and check the magic bytes before showing a link. This is exactly what would have
  caught the filebin failure during research — a host that passed a `curl` test and served an HTML
  interstitial to real browsers. Never present an unverified link.
- Refuse oversized payloads *before* uploading, showing the size and the 12 MB cap.
- Disclosure, reassurance-forward with the caveats present and secondary:

  > **End-to-end encrypted — only people with the link can view this replay.**
  > Includes your opponent's display name and match chat. Expires after 7 days; it can't be
  > unshared before then.

- Settings: `shareEndpoint`, defaulting to the constant from Gate A and overridable without a
  code change. No `shareTtlDays` — TTL is fixed at the bucket.

```bash
git add dashboard/dashboard.js dashboard/dashboard.html dashboard/dashboard.css
git commit -m "feat(dashboard): add replay sharing"
```

---

### Task 8 — shares list

A read-only dashboard list of shares created from this machine: match, created time, expiry
countdown, the link with a copy button, and a **re-check** button that re-fetches the object and
reports whether it is still alive.

No delete action and no `DELETE` route — see settled decision 3. The list must say plainly that
shares cannot be revoked early and expire on their own. Entries past their TTL are shown as
expired and can be cleared from the local list, which removes the record, not the object.

```bash
git add dashboard/dashboard.js dashboard/dashboard.html dashboard/dashboard.css
git commit -m "feat(dashboard): list active shares"
```

---

## 5. Known outstanding issues — not this feature

Found during the visual-replay work. A session touching the viewer will meet some of them.
**Leave them alone unless one blocks a task.**

- **Replay flicker, unconfirmed.** Every full snapshot tears the iframe down (`document.open()`)
  and rebuilds — 36 times in a typical match. Suspects: (T1) `.vr-scale iframe { background: #fff }`
  in `dashboard/dashboard.css` flashing white on a dark board, plus card art re-fetching; (T2) any
  surviving `<link rel=stylesheet>` makes rrweb pause and rebuild a second time (`loadTimeout`
  defaults to 0 and is never set), reachable because `store/css-assets.js` rehydrates an
  unresolvable ref to `""`, which is falsy, so the node stays a `<link>`. **Task 4 settles T2 for
  free.**
- `speedOption: [1]` in `dashboard/replay-html.js` is inert dead config — an `rrweb-player`
  option, not a `Replayer` one.
- The Replayer is never told our `blockClass`, so it uses rrweb's default `"rr-block"` while the
  recorder blocks on `"ra-tracker-block"`. Our injected UI renders as unstyled boxes. Cosmetic.
- Chapter chips can seek to the *previous* keyframe: `ra:turn` is emitted just before
  `takeFullSnapshot()` and rrweb slices from the last Meta at or before the baseline.
- `docs/specs/2026-08-09-visual-replay-design.md` still says exclusions use `blockSelector`; the
  code has used `blockClass` since `761684d`.
- `store/css-assets.js` only walks `event.data.node`, so stylesheets arriving via mutation events
  are stored inline in every chunk rather than content-addressed. A storage asymmetry, not a
  correctness bug.

---

## 6. Definition of done

- A link produced on one machine plays on another machine in a browser with no extension.
- Nothing in the repo identifies or authenticates any Cloudflare account; `audit-public` is clean
  over the diff **and the history**.
- `share/worker/README.md` gets the repo owner from a clean checkout to his own instance, and the
  extension points at it from Settings without a code change.
- Shares expire on their own after 7 days; the UI says plainly that they cannot be revoked early.
- The share dialog states the encryption property accurately and does not imply the link is
  access-controlled.
- Matches with no usable replay show no Share control.
- `node --test 'test/*.test.js'` passes, including new coverage for the payload format, the link
  format and the extracted timeline helpers.
- The Task 5 manual checklist passes — dashboard replay behaviour is unchanged.
