const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const workerSource = fs.readFileSync(path.join(root, "share/worker/src/worker.js"), "utf8");
const headersFile = fs.readFileSync(path.join(root, "share/worker/public/_headers"), "utf8");

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

test("the object id length agrees between the Worker and the link parser", () => {
  const { OBJECT_ID_CHARS } = require("../share/hosts.js");
  const bytes = Number(workerSource.match(/const OBJECT_ID_BYTES = (\d+)/)[1]);
  // base64url of N bytes, unpadded, is ceil(N * 4 / 3) characters.
  assert.strictEqual(Math.ceil((bytes * 4) / 3), OBJECT_ID_CHARS);
});
