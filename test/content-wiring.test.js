"use strict";

/* content.js is one IIFE with no exports, so nothing in it can be required.
 * What CAN be checked is the seam it now sits on: the decisions it used to make
 * inline live in capture/*.js, and the only thing that puts them in scope is
 * the order of the manifest's content-script array. There is no bundler and
 * must not be one - the load order IS the dependency graph.
 *
 * A file listed after content.js fails the same way in every case: the global
 * is undefined at the first call, the throw is swallowed by the try/catch
 * around the tick, and the extension goes on running with no end detection, no
 * game log, or no duplicate suppression. Nothing says so in the console beyond
 * a warning per frame.
 *
 * Source-shape assertions, which is the pattern the repo already uses for
 * invariants that span files - see test/viewer-assets.test.js and
 * test/shared-constants.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const content = read("content.js");
const manifest = JSON.parse(read("manifest.json"));
const scripts = manifest.content_scripts[0].js;

/* Comments are stripped: this file's own explanation and content.js's both name
 * the globals being scanned for. */
const code = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("every global content.js calls is published by a script loaded before it", () => {
  const contentAt = scripts.indexOf("content.js");
  assert.notEqual(contentAt, -1, "the manifest must load content.js");

  const wanted = [...new Set([...code(content).matchAll(/globalThis\.(RAT\w+)/g)].map((m) => m[1]))];
  assert.ok(
    wanted.length > 0,
    "no globalThis.RAT* calls found in content.js - the idiom this scan knows " +
      "about has changed, so it is no longer checking anything. Teach it the new one."
  );

  const earlier = scripts
    .slice(0, contentAt)
    .map((rel) => (fs.existsSync(path.join(root, rel)) ? read(rel) : ""))
    .join("\n");

  const missing = wanted.filter((name) => !new RegExp("root\\." + name + "\\s*=").test(earlier));
  assert.deepEqual(
    missing,
    [],
    "content.js calls these globals but no script loaded before it publishes one: " +
      missing.join(", ")
  );
});

test("every capture module is loaded, and none of them after content.js", () => {
  // Catches the file that is written, required, and never added to the manifest
  // - which in a browser looks exactly like the module being broken.
  const onDisk = fs
    .readdirSync(path.join(root, "capture"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => "capture/" + f)
    .sort();
  const listed = scripts.filter((s) => s.startsWith("capture/")).sort();
  assert.deepEqual(listed, onDisk, "capture/*.js and the manifest disagree about which files exist");
  for (const rel of listed) {
    assert.ok(
      scripts.indexOf(rel) < scripts.indexOf("content.js"),
      rel + " is loaded after content.js, which calls into it"
    );
  }
});

test("the winning score agrees between content.js and the start decision", () => {
  /* Both files need it - content.js to end a match on score, match-start.js to
   * recognise a board that is already decided - and neither can import the
   * other at the point it is read. A pair that drifts is silent: matches would
   * end at one number and be suppressed as finished at another. */
  const winScore = (source, where) => {
    const hit = source.match(/const WIN_SCORE = (\d+)/);
    assert.ok(hit, where + " must declare WIN_SCORE as a numeric literal");
    return hit[1];
  };
  assert.equal(
    winScore(content, "content.js"),
    winScore(read("capture/match-start.js"), "capture/match-start.js")
  );
});

/* The two fixes below cannot be reached from a test: both live inside the IIFE,
 * behind a MutationObserver and a rAF. Their shape is asserted instead, because
 * both regressed silently once already. */

test("the observer keeps every mutation batch, not just the one that scheduled the frame", () => {
  /* The observer can deliver several batches inside one frame and only the
   * first schedules it, so the batches have to be accumulated rather than read
   * off the callback argument. Scanning added nodes is the ONLY place a
   * victory / concede / "PLAYER LEFT" modal is ever read - the three-second
   * poll calls tick(null) - so a dropped batch is a match that ends as
   * "unknown" minutes later when the board unmounts. */
  const boot = code(content);
  assert.ok(
    /for \(const record of mutations\) pending\.push\(record\)/.test(boot),
    "the observer callback must accumulate its batches into `pending`"
  );
  assert.ok(
    /tick\(batch\)/.test(boot) && /pending\.concat\(observer\.takeRecords\(\)\)/.test(boot),
    "the frame must scan the accumulated batches plus anything still queued"
  );
  assert.ok(
    !/(?<!function\s)tick\(mutations\)/.test(boot), // the declaration itself is not a call
    "the frame is scanning the callback's own argument again - the batches " +
      "delivered after it in the same frame are being dropped"
  );
});

test("the record stored in the matches array never carries the game log", () => {
  /* The matches array is rewritten every few seconds during a live game, so a
   * log inside it is ~21 KB per match rewritten per captured line. The
   * dirty-check compares the same lean shape for the same reason: comparing
   * currentMatch sees `log` grow on every line and rewrites the whole array to
   * store bytes that never changed. Logs live under log_<id>. */
  const source = code(content);
  assert.ok(/function leanRecord\(record\)[\s\S]{0,200}delete lean\.log/.test(source),
    "leanRecord must strip the log before a record is stored");
  assert.ok(/JSON\.stringify\(leanRecord\(currentMatch\)\)/.test(source),
    "the periodic dirty-check must snapshot the lean record, not the live one");
  assert.ok(!/JSON\.stringify\(currentMatch\)/.test(source),
    "the dirty-check is snapshotting the live record, so log growth rewrites the matches array");
});
