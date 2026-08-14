/* The dashboard is being ported one view at a time, and legacy.js still owns
 * several of them. It reaches for elements by id, and the redesign is moving
 * that markup around underneath it.
 *
 * The failure mode caught here is silent in a browser: an id legacy.js still
 * uses gets renamed or dropped from the markup, and the feature behind it stops
 * working with nothing in the console, because every access in that file is
 * null-guarded on purpose.
 *
 * NOT caught here, and worth knowing about: two owners for one control. A
 * module and legacy.js can both claim a data-* attribute, which is sometimes
 * the bug (two handlers on one click) and sometimes the design (the module
 * expands the row, legacy.js drives the panel inside it). Source shape cannot
 * tell those apart, so the seam is checked by reading it, not by this file.
 *
 * This is a source-shape test, which is the pattern the repo already uses for
 * invariants that span files - see test/vendor-contract.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "dashboard");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

const html = read("dashboard.html");
const idsInHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

/* Comments are stripped: this file's own explanations, and legacy.js's, both
 * mention selectors that are illustrations rather than real lookups. */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* legacy.js and the files drained out of it. A module that took a view out of
 * legacy.js took that view's element lookups with it, and they are exactly as
 * exposed to a markup rename as they were before the move - so the scan follows
 * them rather than quietly checking less than it used to. Each of these uses
 * legacy.js's null-guarded `$("#id")` idiom, which is what the scan below
 * knows how to read; the ES modules use `document.querySelector` and are not
 * part of this. */
const DRAINED = ["legacy.js", "shares-view.js", "view-overview.js", "view-replays.js", "deck-labelling.js", "data-io.js", "backups.js", "settings-capture.js"];

test("every element id legacy.js and its offspring reach for is still in the markup", () => {
  const present = DRAINED.filter((f) => fs.existsSync(path.join(DIR, f)));
  if (!present.length) return; // fully drained

  const wanted = new Set();
  for (const file of present) {
    const source = stripComments(read(file));
    const found = new Set();
    for (const m of source.matchAll(/\bon\("#([a-zA-Z][\w-]*)"/g)) found.add(m[1]);
    for (const m of source.matchAll(/\$\("#([a-zA-Z][\w-]*)["\s]/g)) found.add(m[1]);
    for (const m of source.matchAll(/\b(?:val|isChecked|setText|setHtml)\("#([a-zA-Z][\w-]*)"/g)) {
      found.add(m[1]);
    }

    /* Per file, or this is vacuous rather than passing. It works by matching the
     * accessor idioms these files happen to use today; the moment a port
     * rewrites them - which is exactly what draining legacy.js means - the set
     * goes empty and the assertion below succeeds having checked nothing.
     * Checking only the union would hide that for every file but the last one
     * left. Same guard, and same reason, as test/vendor-contract.test.js. */
    assert.ok(
      found.size > 0,
      `no #id lookups found in ${file} - the accessor idiom this scan knows about has ` +
        "changed, so it is no longer checking anything. Teach it the new one, or drop " +
        "the file from DRAINED if it has stopped reaching for elements by id."
    );
    for (const id of found) wanted.add(id);
  }

  const missing = [...wanted].filter((id) => !idsInHtml.has(id)).sort();
  assert.deepEqual(
    missing,
    [],
    "these files still use these ids but the markup no longer has them, so those " +
      "features are silently dead: " + missing.join(", ")
  );
});

test("the share modules load before legacy.js, which reads them as it evaluates", () => {
  /* legacy.js takes all four off the global at eval time - the share panel it
   * draws inside a Replays row, the busy flag the delete confirm checks, the
   * shares list, the modal's share entry point - and mounts two of their click
   * listeners. Load one of them after legacy.js and every one of those bindings
   * is undefined for the life of the page.
   *
   * Being classic scripts is load-bearing too, and not only for the requires
   * the tests use: their listeners must be registered before view-matches.js's,
   * a deferred module, whose own [data-share] branch expands the row the panel
   * is drawn in. */
  const order = [...html.matchAll(/<script (?:type="module" )?src="([^"]+)"/g)].map((m) => m[1]);
  const at = (file) => order.findIndex((src) => src.endsWith(file));
  const legacy = at("legacy.js");
  assert.notEqual(legacy, -1, "legacy.js is not loaded");

  for (const file of ["share-panel.js", "share-pipeline.js", "share-moment.js", "shares-view.js"]) {
    assert.ok(at(file) !== -1, `dashboard.html must load ${file}`);
    assert.ok(at(file) < legacy, `${file} must load before legacy.js`);
    assert.ok(
      !new RegExp(`<script type="module" src="[^"]*${file}"`).test(html),
      `${file} must stay a classic script, or its click listeners register after view-matches.js's`
    );
  }
  // Each reads the one above it off the global as it evaluates.
  assert.ok(at("share-panel.js") < at("share-pipeline.js"));
  assert.ok(at("share-pipeline.js") < at("share-moment.js"));
  assert.ok(at("share-pipeline.js") < at("shares-view.js"));
  // And all of them read share/share-ui-support.js and share/hosts.js.
  assert.ok(at("share-ui-support.js") < at("share-panel.js"));
  assert.ok(at("hosts.js") < at("share-panel.js"));
  /* share-pipeline.js binds RATrackerSettingsClamps as it evaluates, to clamp
   * the endpoint the upload goes to. Load it later and CLAMP is undefined for
   * the life of the page - which is the failure this whole test exists for. */
  assert.ok(
    at("settings-clamps.js") < at("share-pipeline.js"),
    "settings-clamps.js must load before share-pipeline.js, which reads it at eval time"
  );
});

test("the views drained out of legacy.js load before it, as classic scripts", () => {
  /* Each of these was a section of legacy.js and is now a file with its own
   * delegated listener. Two things about the load order are load-bearing:
   *
   *   legacy.js binds every one of them off the global as it evaluates and
   *   calls its mount() - load one later and that binding is undefined for the
   *   life of the page, which is a whole view that silently does nothing;
   *
   *   being CLASSIC is what keeps their click branches where they were. Their
   *   listeners are registered from legacy.js's own evaluation, which happens
   *   before any deferred module runs - so they stay ahead of view-matches.js,
   *   whose fallback branch closes an open row menu and repaints on any click
   *   these branches also answer. Turn one into a module and it registers after
   *   that repaint instead of before it. */
  const order = [...html.matchAll(/<script (?:type="module" )?src="([^"]+)"/g)].map((m) => m[1]);
  const at = (file) => order.findIndex((src) => src.endsWith(file));
  const legacy = at("legacy.js");
  assert.notEqual(legacy, -1, "legacy.js is not loaded");

  const drained = [
    "view-overview.js",
    "view-replays.js",
    "deck-labelling.js",
    "data-io.js",
    "backups.js",
    "settings-capture.js",
  ];
  for (const file of drained.concat("notify.js")) {
    assert.ok(at(file) !== -1, `dashboard.html must load ${file}`);
    assert.ok(at(file) < legacy, `${file} must load before legacy.js, which mounts it as it evaluates`);
    assert.ok(
      !new RegExp(`<script type="module" src="[^"]*${file}"`).test(html),
      `${file} must stay a classic script, or its click listeners register after view-matches.js's`
    );
  }

  // notify.js is how a classic script reaches the toast and the dialog; every
  // one of these takes it off the global as it evaluates.
  for (const file of drained) {
    assert.ok(at("notify.js") < at(file), `notify.js must load before ${file}`);
  }
  // view-replays.js draws the share panel inside its own rows and asks the
  // pipeline whether an upload is in flight before it deletes a recording.
  assert.ok(at("share-panel.js") < at("view-replays.js"));
  assert.ok(at("shares-view.js") < at("view-replays.js"));
  // backups.js builds its file with data-io.js's bundle builder, and falls back
  // to its download when the downloads permission is declined.
  assert.ok(at("data-io.js") < at("backups.js"));
});

test("the module entry point is loaded as a module, and last", () => {
  // Modules are deferred, so every classic script above has run and every
  // window.RA* global exists by the time main.js starts. That ordering is what
  // lets the split work with no bundler.
  assert.match(html, /<script type="module" src="main\.js"><\/script>/);
  const main = html.indexOf('src="main.js"');
  for (const classic of ["format.js", "series.js", "table.js", "storage.js", "legacy.js"]) {
    const at = html.indexOf(`src="${classic}"`);
    assert.notEqual(at, -1, `${classic} is not loaded`);
    assert.ok(at < main, `${classic} must load before main.js`);
  }
});

test("no inline script body and no inline event handler survives the CSP", () => {
  // script-src 'self' rejects both outright, and the failure is a blank page.
  const inlineHandler = html.match(/\son[a-z]+\s*=\s*"/g);
  assert.deepEqual(inlineHandler || [], [], "inline event handlers are blocked by the extension CSP");
  const inlineScript = html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g);
  assert.deepEqual(inlineScript || [], [], "inline script bodies are blocked by the extension CSP");
});

test("nothing in the dashboard loads a remote origin", () => {
  // No CDN, no remote fonts, no remote CSS - everything ships in the repo.
  const files = fs.readdirSync(DIR).filter((f) => /\.(js|css|html)$/.test(f));
  for (const f of files) {
    const text = stripComments(read(f));
    const remote = text.match(/["'(]https?:\/\/[^"')\s]+/g) || [];
    // The share endpoint is a configured URL held in share/config.js, not a
    // resource this page loads.
    const loaded = remote.filter((u) => !/riftatlas\.com|workers\.dev|riftatlas-workers/.test(u));
    assert.deepEqual(loaded, [], `${f} references a remote origin: ${loaded.join(", ")}`);
  }
});

test("the hidden attribute beats every display rule in the stylesheet", () => {
  /* The UA's [hidden] { display: none } loses to any author selector that sets
   * display, and this sheet sets display on almost everything. That quietly
   * made every header menu permanently open, and had already caught the
   * banners, the search field, the custom date range, the capture card and the
   * archive-mode nav hiding - all of which toggle `hidden` from JS.
   *
   * Asserted here rather than fixed per component, because the component after
   * next would forget too. */
  const css = fs.readFileSync(path.join(DIR, "dashboard.css"), "utf8");
  assert.match(
    css,
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    "dashboard.css needs a global [hidden] { display: none !important } or JS-toggled elements stay visible"
  );
});

test("native form controls are told the page is dark", () => {
  // A <select>'s dropdown, a date picker and a scrollbar are painted by the
  // platform. Without color-scheme they render light on a dark page, which is
  // what a white option list behind a dark control is.
  const css = fs.readFileSync(path.join(DIR, "dashboard.css"), "utf8");
  assert.match(css, /color-scheme:\s*dark/, "dashboard.css must declare color-scheme: dark");
});

test("the filter row is static markup, not something a render rebuilds", () => {
  // content.js saves the live match every three seconds, which drives a
  // re-render. A search field inside re-rendered markup loses its caret and
  // its value about twenty times a minute.
  assert.match(html, /class="filter-row"/, "the filter row must exist in the document");
  assert.match(html, /id="fSearch"/, "the search field must be part of the static markup");

  for (const f of ["shell.js", "main.js"]) {
    const text = stripComments(read(f));
    assert.ok(
      !/\.filter-row[^\n]*innerHTML|innerHTML[^\n]*filter-row/.test(text),
      `${f} rewrites the filter row, which would drop the caret out of the search field`
    );
  }
});

test("the dashboard loads the replay store, and loads css-assets.js before it", () => {
  /* Reading a replay happens in the page, not the service worker: get() hands
   * back every stylesheet rehydrated into every keyframe, which took a real
   * 3.72 MB recording past the 64 MiB ceiling on a sendMessage payload and made
   * the match unopenable. The snapshot cadence has since cut keyframe counts by
   * roughly an order of magnitude; the ceiling has not moved and match length is
   * unbounded, so the read stays out of the message channel.
   *
   * The order is load-bearing, and gets no second chance: replay-store.js
   * destructures rehydrateCssAssets off the global as it evaluates, so loading
   * it before css-assets.js binds undefined for the life of the page. */
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const at = (file) => order.findIndex((src) => src.endsWith(file));

  /* css-assets.js is in this loop as well as the ordering assertion below:
   * `at()` answers -1 for a file that is absent entirely, and -1 sorts before
   * every real index, so an ordering check alone would pass most loudly at the
   * moment the file was deleted. */
  for (const file of ["idb.js", "replay-store.js", "css-assets.js"]) {
    assert.ok(at(file) !== -1, `dashboard.html must load store/${file} to read replays in the page`);
  }
  assert.ok(
    at("css-assets.js") < at("replay-store.js"),
    "css-assets.js must load before replay-store.js, which reads rehydrateCssAssets off the global at load time"
  );
  assert.ok(
    at("replay-store.js") < at("legacy.js"),
    "replay-store.js must load before legacy.js, which builds its reader as it evaluates"
  );
});

test("the dashboard reads replays directly, not over sendMessage", () => {
  /* The whole point of the page-side reader: a payload this large cannot cross
   * chrome.runtime.sendMessage, so a reintroduced ra:visual:get would fail on
   * exactly the largest replays and nowhere else.
   *
   * Every classic script the page loads, not legacy.js alone: the [data-visual]
   * handler that opens a replay - the one branch that could reintroduce the
   * message - has already moved out to view-replays.js, and a scan pinned to
   * the file it used to live in guards nothing the moment it moves again. Same
   * widening, and same reason, as the injected-element check in
   * test/vendor-contract.test.js. */
  const scripts = [...html.matchAll(/<script (?:type="module" )?src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => !src.includes("vendor/"));
  assert.ok(scripts.includes("view-replays.js"), "view-replays.js owns the replay-opening branch");

  for (const src of scripts) {
    // Relative to dashboard/, so ../store, ../share and ../replay come too:
    // the read is theirs as much as this folder's.
    const file = path.join(DIR, src);
    assert.ok(fs.existsSync(file), `dashboard.html loads ${src}, which is not in the repo`);
    assert.ok(
      !/ra:visual:get/.test(stripComments(fs.readFileSync(file, "utf8"))),
      `${src} must not fetch replays over sendMessage - payloads exceed the 64 MiB message ceiling`
    );
  }
});
