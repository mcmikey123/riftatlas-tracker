/* Constants that two files must agree on, where neither can import the other.
 *
 * The extension runs code in two worlds that share no module system: a content
 * script injected into play.riftatlas.com, and the extension's own pages. A
 * value both sides depend on therefore exists twice, by necessity rather than
 * by carelessness - and the copies carry comments naming each other, which is
 * the honest way to hold a duplicate but does nothing to keep it true.
 *
 * This is the same technique test/worker-headers.test.js uses to pin the CSP
 * and the object-id length across the client/Worker boundary: read both
 * sources and assert they still say the same thing.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

/** The string contents of a `const <name> = [ ... ]` array literal. */
function arrayLiteral(source, name, where) {
  const block = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`));
  assert.ok(block, `${where} must declare ${name} as an array literal`);
  const items = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(items.length > 0, `${name} in ${where} is empty - has the declaration changed shape?`);
  return items;
}

test("the deck zones the capture and the dashboard read are the same list", () => {
  /* content.js harvests cards from these zones; fingerprint.js identifies a
   * deck from the cards that came back. A zone added to one and not the other
   * is not an error anywhere - the cards from it are simply never collected,
   * or never counted, and the deck is misidentified with no diagnostic. */
  const fromCapture = arrayLiteral(read("content.js"), "DECK_ZONES", "content.js");
  const fromDashboard = arrayLiteral(
    read("dashboard/fingerprint.js"),
    "DECK_ZONES",
    "dashboard/fingerprint.js"
  );
  assert.deepEqual(
    fromCapture,
    fromDashboard,
    "content.js and dashboard/fingerprint.js disagree about which zones hold deck cards"
  );
});

test("the log cap the recorder enforces is the one the dashboard tells the user about", () => {
  /* content.js stops a match log at MAX_LOG entries. The expanded row in the
   * dashboard both compares against that number and prints it in a sentence,
   * so raising the cap in the recorder without touching the view leaves the
   * sentence quietly lying about what was kept. */
  const cap = read("content.js").match(/const MAX_LOG = (\d+)/);
  assert.ok(cap, "content.js must declare MAX_LOG");

  const view = read("dashboard/view-matches.js");
  const mentions = [...view.matchAll(/\b(\d{3,})\b/g)].map((m) => m[1]);
  assert.ok(
    mentions.includes(cap[1]),
    `content.js caps the log at ${cap[1]} entries but dashboard/view-matches.js ` +
      "no longer mentions that number - the cap and the copy describing it have drifted"
  );
});
