/* The dashboard is being ported one view at a time, and legacy.js still owns
 * several of them. It reaches for elements by id, and the redesign is moving
 * that markup around underneath it.
 *
 * Two failure modes, both silent in a browser and both caught here:
 *
 *   - An id legacy.js still uses gets renamed or dropped from the markup. The
 *     feature behind it stops working, with nothing in the console, because
 *     every access in that file is null-guarded on purpose.
 *   - A module and a classic script both claim the same control, so a click
 *     runs two handlers.
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

test("every element id legacy.js reaches for is still in the markup", () => {
  const legacyPath = path.join(DIR, "legacy.js");
  if (!fs.existsSync(legacyPath)) return; // fully drained
  const legacy = stripComments(read("legacy.js"));

  const wanted = new Set();
  for (const m of legacy.matchAll(/\bon\("#([a-zA-Z][\w-]*)"/g)) wanted.add(m[1]);
  for (const m of legacy.matchAll(/\$\("#([a-zA-Z][\w-]*)["\s]/g)) wanted.add(m[1]);
  for (const m of legacy.matchAll(/\b(?:val|isChecked|setText|setHtml)\("#([a-zA-Z][\w-]*)"/g)) {
    wanted.add(m[1]);
  }

  const missing = [...wanted].filter((id) => !idsInHtml.has(id)).sort();
  assert.deepEqual(
    missing,
    [],
    "legacy.js still uses these ids but the markup no longer has them, so those " +
      "features are silently dead: " + missing.join(", ")
  );
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
