const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const workerSource = fs.readFileSync(path.join(root, "share/worker/src/worker.js"), "utf8");
const headersFile = fs.readFileSync(path.join(root, "share/worker/public/_headers"), "utf8");
const wranglerExample = fs.readFileSync(
  path.join(root, "share/worker/wrangler.toml.example"),
  "utf8"
);

// The policy exists twice by necessity, in two different syntaxes: Cloudflare's asset
// layer serves the viewer page without ever invoking the Worker, so a header set in
// Worker code never reaches it, and a header in _headers never reaches GET /b/<id>.
// Two hand-maintained copies of one policy is exactly the shape that drifts, so the
// agreement is asserted rather than left to a comment.
function cspFromWorker() {
  const array = workerSource.match(/const CSP = \[([\s\S]*?)\]\.join/);
  assert.ok(array, "worker.js must declare CSP as an array joined into a string");
  return [...array[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join("; ");
}

function cspFromHeaders() {
  const line = headersFile.match(/^\s*Content-Security-Policy:\s*(.+)$/m);
  assert.ok(line, "_headers must set Content-Security-Policy");
  return line[1].trim();
}

test("the Worker and the asset layer serve the same CSP", () => {
  assert.strictEqual(cspFromHeaders(), cspFromWorker());
});

test("the CSP allows what rrweb needs and nothing broader", () => {
  const csp = cspFromWorker();
  // rrweb injects styles at runtime, and builds its own sandboxed replay iframe.
  assert.match(csp, /style-src [^;]*'unsafe-inline'/);
  assert.match(csp, /frame-src [^;]*blob:/);
  // Card art comes from the game's CDN; nothing else is a permitted image source.
  assert.match(csp, /img-src [^;]*https:\/\/assets\.riftatlas-workers\.com/);
  // Scripting must stay same-origin only — inline script would defeat the whole point.
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-eval'/);
  assert.match(csp, /default-src 'none'/);
});

// An extension page's fetch rejects outright when a response carries no CORS header, so a
// json() call that forgets `request` turns a precise 413 or 411 into "couldn't reach the
// server" — the wrong remedy, on the paths a first-run self-hoster is most likely to hit.
// One call was missed exactly this way, so the invariant is asserted rather than reviewed.
test("every json() response in the Worker carries the request, so CORS headers are set", () => {
  const calls = [...workerSource.matchAll(/return json\(([\s\S]*?)\);/g)].map((m) => m[1]);
  assert.ok(calls.length > 5, "expected to find the Worker's json() responses");
  for (const args of calls) {
    assert.match(
      args.replace(/\s+/g, " "),
      /,\s*request$/,
      `json(${args.replace(/\s+/g, " ").slice(0, 60)}…) must pass request as its third argument`
    );
  }
});

// The cap is declared twice by necessity: the Worker refuses an oversized PUT, and the
// dashboard refuses before spending ~600 ms building a frame nobody will accept. If the
// client's copy is the larger of the two, that early refusal stops firing and the user
// gets an unexplained 413 after the whole build instead of a message naming the size.
test("the upload cap agrees between the Worker's config and the client", () => {
  const { MAX_UPLOAD_BYTES } = require("../share/share-ui-support.js");
  const declared = wranglerExample.match(/^\s*MAX_UPLOAD_BYTES\s*=\s*"(\d+)"/m);
  assert.ok(declared, "wrangler.toml.example must declare MAX_UPLOAD_BYTES");
  assert.strictEqual(MAX_UPLOAD_BYTES, Number(declared[1]));
});

// The Worker is the only layer that talks to storage, and an id R2 rejects throws — which
// escapes as a bare 500 with none of this file's headers. It was doing exactly that for an
// over-long key, so the guard is pinned rather than reviewed.
test("the Worker validates object ids before reaching for storage", () => {
  const re = workerSource.match(/const OBJECT_ID_RE = (\/.+?\/);/);
  assert.ok(re, "worker.js must declare OBJECT_ID_RE");
  const pattern = new RegExp(re[1].slice(1, -1));
  const { OBJECT_ID_CHARS } = require("../share/hosts.js");

  assert.ok(pattern.test("A".repeat(OBJECT_ID_CHARS)), "must accept a well-formed id");
  for (const bad of ["", "abc", "A".repeat(OBJECT_ID_CHARS + 1), "A".repeat(1200), "../secret", "a/b"]) {
    assert.ok(!pattern.test(bad), `must reject ${JSON.stringify(bad.slice(0, 20))}`);
  }
  assert.match(
    workerSource,
    /if \(!OBJECT_ID_RE\.test\(id\)\)/,
    "download() must test the id before calling BUCKET.get"
  );
  assert.match(
    workerSource.slice(workerSource.indexOf("async function download")),
    /try \{[\s\S]*?BUCKET\.get/,
    "download() must wrap BUCKET.get so a read failure cannot escape unhandled"
  );
});

test("the object id length agrees between the Worker and the link parser", () => {
  const { OBJECT_ID_CHARS } = require("../share/hosts.js");
  const bytes = Number(workerSource.match(/const OBJECT_ID_BYTES = (\d+)/)[1]);
  // base64url of N bytes, unpadded, is ceil(N * 4 / 3) characters.
  assert.strictEqual(Math.ceil((bytes * 4) / 3), OBJECT_ID_CHARS);
});
