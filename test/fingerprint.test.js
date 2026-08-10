"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const FP = require("../dashboard/fingerprint.js");

// Card codes look like "UNL-199"; only their identity matters here, so the
// samples below are named after the deck they belong to.
const sun = (n) => `SUN-${n}`;
const moon = (n) => `MOON-${n}`;
const range = (n, make) => Array.from({ length: n }, (_, i) => make(i + 1));

const match = (id, deckName) => ({ id, deckName: deckName || "" });
const printsOf = (pairs) => new Map(pairs.map(([id, codes]) => [id, FP.fingerprint(codes)]));

test("1. fingerprint is the set of the stored codes", () => {
  const fp = FP.fingerprint(["SUN-1", "SUN-2", "SUN-1", "", null, "SUN-3"]);
  assert.ok(fp instanceof Set);
  assert.deepEqual([...fp].sort(), ["SUN-1", "SUN-2", "SUN-3"]);
});

test("2. a match with no stored codes fingerprints to nothing", () => {
  assert.equal(FP.fingerprint(undefined).size, 0);
  assert.equal(FP.fingerprint(null).size, 0);
  assert.equal(FP.fingerprint("SUN-1").size, 0); // not an array: not a sample
  assert.equal(FP.fingerprint([]).size, 0);
});

test("3. a sample below MIN_CARDS is too thin to label", () => {
  const thin = range(FP.MIN_CARDS - 1, sun);
  const prints = printsOf([
    ["labelled", range(10, sun)],
    ["thin", thin],
  ]);
  const { proposals, undecided } = FP.suggestLabels(
    [match("labelled", "Sun Aggro"), match("thin")],
    prints
  );
  assert.equal(proposals.length, 0);
  assert.equal(undecided.length, 1);
  assert.equal(undecided[0].match.id, "thin");
  assert.match(undecided[0].reason, /only 5 cards seen/);
});

test("4. a match with no card data at all is left undecided", () => {
  const prints = printsOf([["labelled", range(10, sun)]]);
  const { undecided } = FP.suggestLabels(
    [match("labelled", "Sun Aggro"), match("never-recorded")],
    prints
  );
  assert.equal(undecided.length, 1);
  assert.equal(undecided[0].reason, "no card data");
});

test("5. overlapping samples cluster together, a disjoint one does not", () => {
  const prints = printsOf([
    ["a", range(10, sun)],
    // 7 of the same 10 cards: 0.7 overlap, above CLUSTER_THRESHOLD.
    ["b", range(7, sun).concat(["SUN-90", "SUN-91", "SUN-92"])],
    ["c", range(10, moon)],
  ]);
  const clusters = FP.clusterDecks([match("a"), match("b"), match("c")], prints);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].ids.slice().sort(), ["a", "b"]);
  assert.equal(clusters[0].size, 2);
  assert.equal(clusters[0].cards, 13); // union of both samples
  assert.deepEqual(clusters[1].ids, ["c"]);
});

test("6. clustering ignores samples below MIN_CARDS", () => {
  const prints = printsOf([
    ["a", range(10, sun)],
    ["thin", range(FP.MIN_CARDS - 1, sun)],
  ]);
  const clusters = FP.clusterDecks([match("a"), match("thin")], prints);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].ids, ["a"]);
});

test("7. suggestLabels proposes the deck whose cards actually overlap", () => {
  const prints = printsOf([
    ["sun", range(8, sun)],
    ["moon", range(8, moon)],
    // Seven of the eight Sun cards, plus one the reference game never showed.
    ["unlabelled", range(7, sun).concat(["SUN-99"])],
  ]);
  const { proposals, undecided, labelledCount } = FP.suggestLabels(
    [match("sun", "Sun Aggro"), match("moon", "Moon Control"), match("unlabelled")],
    prints
  );
  assert.equal(labelledCount, 2);
  assert.equal(undecided.length, 0);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].match.id, "unlabelled");
  assert.equal(proposals[0].deck, "Sun Aggro");
  assert.equal(proposals[0].score, 7 / 8);
  assert.equal(proposals[0].cards, 8);
});

test("8. a sample split evenly between two decks stays undecided", () => {
  const prints = printsOf([
    ["sun", range(8, sun)],
    ["moon", range(8, moon)],
    // Half from each deck: both score exactly THRESHOLD, so neither wins by
    // MARGIN and guessing would quietly corrupt that deck's stats.
    ["split", range(4, sun).concat(range(4, moon))],
  ]);
  const { proposals, undecided } = FP.suggestLabels(
    [match("sun", "Sun Aggro"), match("moon", "Moon Control"), match("split")],
    prints
  );
  assert.equal(proposals.length, 0);
  assert.equal(undecided.length, 1);
  assert.equal(undecided[0].match.id, "split");
  assert.match(undecided[0].reason, /^ambiguous:/);
});

test("9. nothing is proposed when no labelled game overlaps enough", () => {
  const prints = printsOf([
    ["sun", range(8, sun)],
    ["moon", range(8, moon)],
  ]);
  const { proposals, undecided } = FP.suggestLabels(
    [match("sun", "Sun Aggro"), match("moon")],
    prints
  );
  assert.equal(proposals.length, 0);
  assert.equal(undecided.length, 1);
  assert.match(undecided[0].reason, /best match only 0%/);
});
