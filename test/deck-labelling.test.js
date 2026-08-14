/* Who a bulk label touches, and what it says before it touches them.
 *
 * The recognition itself is fingerprint.js (test/fingerprint.test.js and
 * test/deck-name.test.js). What is asserted here is the layer above it, where
 * two things go wrong quietly:
 *
 *   the SET of matches a label lands on. It is computed twice per flow - once
 *   to size the dialog, once after it closes, because a dialog no longer blocks
 *   the event loop - and the two must be the same question, or the confirm
 *   promises one thing and the write does another.
 *
 *   the WORDING. Every one of these dialogs states a count and a scope, and a
 *   count that disagrees with what happens next is the only warning the user
 *   gets before a hundred matches are renamed.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const D = require("../dashboard/deck-labelling.js");
// The champion field as the labelling flows read it, so the fixtures below say
// what champ() actually makes of a name rather than assuming it.
const { champ } = require("../dashboard/format.js");

const match = (over) =>
  Object.assign({ id: "m" + Math.random(), myChampion: "Alba, the Dawnbreaker" }, over);

// ---- who gets a name ---------------------------------------------------

test("only matches with no name of their own are in scope", () => {
  const all = [
    match({ id: "a" }),
    match({ id: "b", deckName: "Aggro" }),
    match({ id: "c", deckName: "" }),
    match({ id: "d", deckName: "   " }),
  ];
  assert.deepEqual(D.unlabelled(all, "").map((m) => m.id), ["a", "c", "d"]);
});

test("a name that is only whitespace is not a name", () => {
  // It is what the picker leaves behind when a name is cleared, and a match
  // holding one has to stay labellable.
  assert.equal(D.unlabelled([match({ deckName: "\t\n " })], "").length, 1);
});

test("the champion filter narrows the scope, and the legend field is not the champion", () => {
  const all = [
    match({ id: "alba" }),
    match({ id: "corin", myChampion: "Corin, Tidecaller" }),
    match({ id: "legend", myChampion: null, myLegend: "Alba, the Dawnbreaker" }),
  ];
  assert.deepEqual(D.unlabelled(all, "Alba").map((m) => m.id), ["alba", "legend"]);
  assert.deepEqual(D.unlabelled(all, "Corin").map((m) => m.id), ["corin"]);
  // No filter means every champion, not "matches whose champion is empty".
  assert.equal(D.unlabelled(all, "").length, 3);
  assert.equal(D.unlabelled(all).length, 3);
});

test("a match with no champion at all is grouped under Unknown, not dropped", () => {
  const all = [match({ id: "x", myChampion: null })];
  assert.equal(D.unlabelled(all, "Unknown").length, 1);
  assert.equal(D.unlabelled(all, "Alba").length, 0);
});

test("the two bulk paths mean different things by an empty champion", () => {
  /* One predicate, two callers. The bulk-label button passes the My champion
   * FILTER, where empty is "no filter"; "apply to unlabelled X games" passes
   * one match's own champion, which is the scope and narrows whatever it reads.
   *
   * champ() floors at "Unknown", so the only champion that reads empty is one
   * that is truthy but degenerate - which takes an imported record. Small, but
   * it is the whole difference between the two flows, and merging them into a
   * predicate that skips its clause on any falsy champion loses it.
   */
  const all = [
    match({ id: "alba" }),
    match({ id: "comma", myChampion: ", x" }),
    match({ id: "space", myChampion: " " }),
  ];
  assert.equal(champ(", x"), "", "the one champion the two paths disagree about");

  // Bulk label, no filter set: every unlabelled match, whatever its champion.
  assert.deepEqual(D.unlabelled(all, "").map((m) => m.id), ["alba", "comma", "space"]);

  // Apply-to-unlabelled from the "comma" match: only what shares its champion.
  assert.deepEqual(D.unlabelled(all, champ(", x"), true).map((m) => m.id), ["comma", "space"]);
  // And a real champion narrows the same way from either path.
  assert.deepEqual(D.unlabelled(all, "Alba", true).map((m) => m.id), ["alba"]);
});

test("nothing to label is an empty list, not a throw", () => {
  assert.deepEqual(D.unlabelled(null, "Alba"), []);
  assert.deepEqual(D.unlabelled([], ""), []);
});

// ---- what the dialogs say ----------------------------------------------

test("the bulk prompt states the scope it is about to write to", () => {
  const filtered = D.bulkPrompt(12, "Alba");
  assert.equal(filtered.title, "Name 12 unlabelled Alba matches");
  assert.match(filtered.sub, /that is the champion filter you have set/);

  const everything = D.bulkPrompt(12, "");
  assert.equal(everything.title, "Name 12 unlabelled matches");
  assert.match(everything.sub, /Set the My champion filter first/, "the way to narrow it");
});

test("one match is not 1 matches", () => {
  assert.equal(D.bulkPrompt(1, "").title, "Name 1 unlabelled match");
  assert.equal(D.bulkPrompt(1, "Alba").title, "Name 1 unlabelled Alba match");
});

test("a blank name is refused rather than written", () => {
  // Applying "" would mark every match in scope manual and unlabelled at once,
  // which detection then leaves alone for good.
  const { validate } = D.bulkPrompt(3, "");
  assert.equal(validate("Hollowmark Aggro"), null);
  assert.ok(validate("   "), "whitespace is not a name");
  assert.ok(validate(""));
});

test("the group summary counts matches and cards per group", () => {
  const lines = D.clusterLines([
    { size: 7, cards: 31, ids: [] },
    { size: 1, cards: 12, ids: [] },
  ]);
  assert.equal(
    lines,
    "  Group 1: 7 matches (31 distinct cards)\n  Group 2: 1 match (12 distinct cards)"
  );
});

// ---- what detection proposes -------------------------------------------

const proposal = (deck, score) => ({ deck, score, match: { id: deck + score } });

test("the proposal dialog counts each deck and averages the overlap", () => {
  const d = D.proposalDialog(
    [proposal("Aggro", 0.9), proposal("Aggro", 0.8), proposal("Control", 0.7)],
    []
  );
  assert.match(d.sub, /^3 unlabelled games matched, average 80% card overlap$/);
  assert.ok(d.body.includes("2 × “Aggro”"));
  assert.ok(d.body.includes("1 × “Control”"));
  assert.equal(d.confirmLabel, "Apply 3 labels");
});

test("a single proposal reads as one game and one label", () => {
  const d = D.proposalDialog([proposal("Aggro", 1)], []);
  assert.match(d.sub, /^1 unlabelled game matched, average 100% card overlap$/);
  assert.equal(d.confirmLabel, "Apply 1 label");
});

test("what was left alone is stated, and only when there is any", () => {
  /* The promise this whole flow rests on: a match that sits between two decks
   * keeps "— unlabelled —" rather than being guessed at. Saying so is how the
   * user knows the count they are approving is not the whole history. */
  const some = D.proposalDialog([proposal("Aggro", 0.9)], [{ reason: "too few cards" }, {}]);
  assert.ok(some.body.includes("2 left alone"));
  assert.ok(some.body.includes("Nothing is guessed"));
  assert.ok(!D.proposalDialog([proposal("Aggro", 0.9)], []).body.includes("left alone"));
  assert.match(some.summary, /Names you typed yourself are never touched/);
});

test("a deck name carrying markup cannot inject any into the summary", () => {
  const d = D.proposalDialog([proposal('<img src=x>', 1)], []);
  assert.ok(!d.body.includes("<img"));
  assert.ok(d.body.includes("&lt;img"));
});
