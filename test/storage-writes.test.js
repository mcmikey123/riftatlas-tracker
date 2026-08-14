/* The dashboard has exactly one writer, and this is what keeps it that way.
 *
 * In archive mode the in-memory match array is the contents of a file the user
 * is looking at, not their history. A write of that array replaces a real
 * history with a file's, with no undo, because the write is the only copy.
 *
 * The old code guarded this in one place and had six write sites that went
 * around the guard, each safe only because its own caller happened to check
 * first. That is a rule enforced by memory, and the redesign adds a whole view
 * of new mutating controls - a selection bar, "Group as a Bo3", "Set deck for
 * all N…", "Remove from series", and a result editor on every expanded
 * sub-row - written by people who will not be thinking about archive mode.
 *
 * So the rule is asserted over the source instead. The repo already does this
 * where an invariant spans files and cannot be imported - see
 * test/vendor-contract.test.js and test/worker-headers.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "dashboard");
const WRITER = "storage.js";

/* Comments are stripped first: this file and storage.js both discuss the very
 * calls being banned, and a test that its own explanation trips is a test
 * nobody keeps. Strings are left alone - a write hidden in one would still be
 * a write. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sources = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ name: f, text: code(fs.readFileSync(path.join(DIR, f), "utf8")) }));

test("the dashboard ships a storage module", () => {
  assert.ok(
    sources.some((f) => f.name === WRITER),
    "dashboard/storage.js is missing - the write guard has nowhere to live"
  );
});

test("only storage.js writes chrome.storage", () => {
  const offenders = sources
    .filter((f) => f.name !== WRITER)
    .filter((f) => /chrome\.storage\.local\.(set|remove|clear)\s*\(/.test(f.text))
    .map((f) => f.name);
  assert.deepEqual(
    offenders,
    [],
    "these write chrome.storage directly and so bypass the archive-mode guard: " + offenders.join(", ")
  );
});

test("the write guard refuses, rather than quietly doing nothing", () => {
  const writer = sources.find((f) => f.name === WRITER).text;
  // A silent no-op reads as success at the call site, which paints "saved"
  // over a write that never happened.
  assert.match(writer, /throw new ReadOnlyWriteError/, "writeMatches must throw when read-only");
  assert.match(writer, /function writeMatches/, "the match writer must be named writeMatches");
});

test("storage.js loads after the config whose default endpoint it embeds", () => {
  // defaultSettings.shareEndpoint is read at load time from RAShareConfig. Put
  // storage.js first and the default silently becomes "", which only shows up
  // as a share failing against an endpoint nobody set.
  const html = fs.readFileSync(path.join(DIR, "dashboard.html"), "utf8");
  const config = html.indexOf("share/config.js");
  const storage = html.indexOf('src="storage.js"');
  assert.notEqual(config, -1, "share/config.js is not loaded");
  assert.notEqual(storage, -1, "storage.js is not loaded");
  assert.ok(config < storage, "storage.js must be loaded after share/config.js");
});

test("legacy.js and the files drained out of it never dereference a query result they did not check", () => {
  /* legacy.js is being drained one view at a time, so any element it reaches
   * for may already be gone - and one unguarded access throws during the
   * initial run, aborting the IIFE and taking load() and the storage listener
   * with it. A module carved out of it renders into that same moving markup and
   * carries the same rule with it, so the scan follows the code rather than
   * staying behind on the file it started in. */
  const drained = ["legacy.js", "shares-view.js", "view-overview.js", "view-replays.js", "deck-labelling.js", "data-io.js", "backups.js", "settings-capture.js"]
    .map((name) => sources.find((f) => f.name === name))
    .filter(Boolean);
  if (!drained.length) return; // fully drained; nothing left to check

  for (const file of drained) {
    /* The scan below looks for `$("#id").prop`, so it only says anything while
     * the file still reaches for elements that way. A port that changes the
     * idiom empties the match set and turns the assertion green without
     * checking a thing, so the presence of the idiom is asserted first - per
     * file, because the union would stay true for as long as any one of them
     * still used it.
     *
     * The accessors are part of the idiom, not an alternative to it: a file
     * that only ever reaches an element through `on`, `val`, `setText` and
     * their siblings has nothing to dereference unguardedly, which is the rule
     * being kept rather than a hole in it. What must never happen is a file
     * reaching for elements in some FOURTH way this scan cannot see. */
    assert.ok(
      /\$\("#[^"]+"\)|\b(?:on|val|isChecked|setText|setHtml)\("#[^"]+"/.test(file.text),
      `${file.name} no longer looks up elements as $("#id") or through the null-guarded ` +
        "accessors - this guard has stopped matching the code it exists to check, and must " +
        "be taught the new idiom."
    );

    const bare = file.text.match(
      /\$\("#[^"]+"\)\.(textContent|innerHTML|value|checked|click|hidden|min|max)/g
    );
    assert.deepEqual(bare || [], [], `unguarded element access in ${file.name}: ` + (bare || []).join(", "));
  }
});

test("reading the share list is never cached", () => {
  const writer = sources.find((f) => f.name === WRITER).text;
  // The reuse decision is made at the moment the button is pressed. A cached
  // list misses a share that landed from the replay modal in the meantime and
  // uploads a second, undeletable copy of the same replay.
  const fn = writer.slice(writer.indexOf("function readShares"));
  assert.match(fn.slice(0, 400), /chrome\.storage\.local\.get/, "readShares must hit storage every call");
});
