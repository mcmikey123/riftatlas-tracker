/* The share viewer's file list exists in three places, and nothing but this
 * file makes them agree.
 *
 * public/ subdirectories are gitignored: git holds one copy of each shared
 * module at the repo root, and sync-assets.sh copies it into public/ before a
 * deploy. So adding a module the viewer needs means editing three lists - the
 * <script> tags in index.html, the copy list in sync-assets.sh, and the globals
 * viewer.js checks for at boot. Miss the second and the deploy 404s; miss the
 * third and the page loads a module nobody reads.
 *
 * The symptom of any of those is identical and appears only in a recipient's
 * browser, on a link the sender cannot see fail: "This replay viewer is
 * missing part of itself." Cheaper to assert here, the same way the Worker's
 * CSP and object-id length are pinned in worker-headers.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const worker = path.join(__dirname, "..", "share", "worker");
const read = (p) => fs.readFileSync(path.join(worker, p), "utf8");

const indexHtml = read("public/index.html");
const syncScript = read("sync-assets.sh");
const viewerSource = read("public/viewer.js");

/** Everything index.html loads, in order, as repo-relative paths. */
function scriptsInIndex() {
  return [...indexHtml.matchAll(/<script[^>]*\ssrc="\/([^"]+)"/g)].map((m) => m[1]);
}

/** The `for rel in \ ... ` list sync-assets.sh copies into public/. */
function pathsInSync() {
  const block = syncScript.match(/for rel in\s*\\\n([\s\S]*?)\ndo\n/);
  assert.ok(block, "sync-assets.sh must copy its files from a `for rel in \\` list");
  return block[1]
    .split("\n")
    .map((line) => line.replace(/\\\s*$/, "").trim())
    .filter(Boolean);
}

test("every script the viewer page loads is one the deploy script copies", () => {
  const scripts = scriptsInIndex();
  // viewer.js and its stylesheet live in public/ already and are not copied.
  const copied = scriptsInIndex().filter((src) => src !== "viewer.js");
  assert.ok(scripts.length > 0, "no <script src> found in index.html - has the markup changed?");

  const synced = new Set(pathsInSync());
  const missing = copied.filter((src) => !synced.has(src));
  assert.deepEqual(
    missing,
    [],
    "index.html loads these but sync-assets.sh never copies them, so the deploy " +
      "serves a 404 for each: " + missing.join(", ")
  );
});

test("the deploy script copies nothing the viewer page does not load", () => {
  const loaded = new Set(scriptsInIndex());
  // The stylesheet is referenced by <link>, not <script>, so it is expected here.
  const stray = pathsInSync().filter((rel) => !loaded.has(rel) && !rel.endsWith(".css"));
  assert.deepEqual(
    stray,
    [],
    "sync-assets.sh copies these but index.html never loads them - either the page " +
      "lost a script tag or the list has gone stale: " + stray.join(", ")
  );
});

test("every global viewer.js requires at boot is loaded before it", () => {
  /* viewer.js refuses to start unless each of these is present, which is the
   * check that turns a missing script into a readable message. If the required
   * list names a global no script provides, that message fires on every load. */
  const required = viewerSource.match(/const REQUIRED = \[([\s\S]*?)\]/);
  assert.ok(required, "viewer.js must declare its prerequisites as a REQUIRED array");
  const names = [...required[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0, "REQUIRED is empty - viewer.js has stopped checking its own deps");

  const before = scriptsInIndex();
  const viewerAt = before.indexOf("viewer.js");
  assert.notEqual(viewerAt, -1, "index.html must load viewer.js");

  // Each required global has to be published by some script the page loads
  // ahead of viewer.js. Read the sources rather than trusting the names.
  const earlier = before.slice(0, viewerAt);
  const published = earlier
    .map((rel) => {
      const full = path.join(worker, "public", rel);
      return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
    })
    .join("\n");

  // vendor bundles are minified and publish their globals in forms a source
  // scan cannot see, so they are named rather than scraped.
  const fromVendor = new Set(["rrwebReplay"]);
  const unpublished = names.filter(
    (n) => !fromVendor.has(n) && !new RegExp("\\b" + n + "\\b").test(published)
  );
  assert.deepEqual(
    unpublished,
    [],
    "viewer.js requires these globals but no script loaded before it defines one: " +
      unpublished.join(", ")
  );
});
