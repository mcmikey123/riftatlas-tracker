/* The export/import file format.
 *
 * `parseBundle` is the entry point for a file the user picked off their own
 * disk, and every one of its outcomes is a sentence somebody reads instead of
 * their history: it is the whole UX of a failed import, so all five are pinned
 * here. The most-reported one is the stats-summary file - the extension writes
 * both, they sit next to each other in Downloads, and the wrong one produces a
 * valid JSON object with no `matches` key.
 *
 * `csvCell` is here for a different reason. It writes a file that is opened in
 * a spreadsheet, and one of its columns is a name a stranger chose.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const B = require("../dashboard/bundle.js");

// ---- parseBundle -------------------------------------------------------

test("a bare array of matches is a bundle with no card lists", () => {
  const parsed = B.parseBundle('[{"id":"a"},{"id":"b"}]');
  assert.deepEqual(parsed.matches, [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(parsed.deckCards, {});
});

test("a v2 bundle keeps its matches and its card lists", () => {
  const parsed = B.parseBundle(
    JSON.stringify({
      format: "riftatlas-tracker-archive",
      version: 2,
      matches: [{ id: "a" }],
      deckCards: { a: ["01AA001"] },
    })
  );
  assert.deepEqual(parsed.matches, [{ id: "a" }]);
  assert.deepEqual(parsed.deckCards, { a: ["01AA001"] });
});

test("a v1 bundle imports, dropping the board snapshots nothing reads", () => {
  // The whole reason `replays` is ignored rather than rejected: a backup taken
  // before deckCards existed is still a backup of those matches.
  const parsed = B.parseBundle(
    JSON.stringify({ version: 1, matches: [{ id: "a" }], replays: { a: [{ snapshot: 1 }] } })
  );
  assert.deepEqual(parsed.matches, [{ id: "a" }]);
  assert.deepEqual(parsed.deckCards, {});
  assert.equal(parsed.replays, undefined, "a v1 file's snapshots must not survive the parse");
});

test("a stats summary file is recognised and says where the real export is", () => {
  const summary = JSON.stringify({ totalMatches: 40, winRate: 0.55, byOpponentChampion: {} });
  assert.throws(
    () => B.parseBundle(summary),
    (err) => {
      assert.match(err.message, /stats SUMMARY file/);
      // Naming the files is the entire value of this branch: without it the
      // user is told what they have, not what to look for instead.
      assert.match(err.message, /riftatlas-matches-<date>\.json/);
      return true;
    }
  );
});

test("any one summary marker is enough to recognise it", () => {
  // The three are checked independently, so a summary written before one of
  // them existed is still recognised rather than falling through to the
  // generic key listing.
  for (const marker of [{ totalMatches: 0 }, { winRate: 0 }, { byOpponentChampion: {} }]) {
    assert.throws(() => B.parseBundle(JSON.stringify(marker)), /stats SUMMARY file/);
  }
});

test("an unrecognised object lists its top-level keys", () => {
  assert.throws(
    () => B.parseBundle(JSON.stringify({ alpha: 1, beta: 2 })),
    /Top-level keys found: alpha, beta/
  );
});

test("the key listing stops at eight, so a huge object is still readable", () => {
  const wide = {};
  for (let i = 0; i < 20; i++) wide["k" + i] = i;
  assert.throws(
    () => B.parseBundle(JSON.stringify(wide)),
    (err) => {
      const listed = err.message.split("Top-level keys found: ")[1];
      assert.equal(listed.split(", ").length, 8);
      return true;
    }
  );
});

test("an object with nothing in it still names what was expected", () => {
  assert.throws(() => B.parseBundle("{}"), /Top-level keys found: \(none\)/);
  assert.throws(() => B.parseBundle("null"), /Top-level keys found: \(none\)/);
});

test("invalid JSON reports the parser's own complaint", () => {
  // The position the parser names is the only clue a truncated download gives.
  assert.throws(
    () => B.parseBundle("{not json"),
    (err) => {
      assert.match(err.message, /^That file isn't valid JSON \(/);
      assert.ok(err.message.length > "That file isn't valid JSON ().".length);
      return true;
    }
  );
});

test("a bundle whose matches key is not an array is not a bundle", () => {
  // `matches: {}` is the shape a half-written or hand-edited file has, and
  // accepting it would fail later with a stack trace instead of a sentence.
  assert.throws(() => B.parseBundle('{"matches":{}}'), /Unrecognised file/);
});

// ---- csvCell -----------------------------------------------------------

test("plain values pass through unquoted", () => {
  assert.equal(B.csvCell("Hollowmark"), "Hollowmark");
  assert.equal(B.csvCell(42), "42");
  assert.equal(B.csvCell(0), "0");
  assert.equal(B.csvCell(false), "false");
});

test("an absent value is an empty cell, not the word undefined", () => {
  assert.equal(B.csvCell(null), "");
  assert.equal(B.csvCell(undefined), "");
});

test("commas, quotes and newlines are quoted per RFC 4180", () => {
  assert.equal(B.csvCell("a,b"), '"a,b"');
  assert.equal(B.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(B.csvCell("line\nline"), '"line\nline"');
});

test("a name that would run as a formula is neutralised", () => {
  /* opponentName is column 7 and is a display name a remote player chose. A
   * spreadsheet evaluates a cell starting with one of these whether or not the
   * field was quoted, so RFC 4180 quoting alone leaves the export executing a
   * stranger's input on the machine of the person who played them. */
  assert.equal(B.csvCell("=1+1"), "'=1+1");
  assert.equal(B.csvCell("@SUM(A1:A9)"), "'@SUM(A1:A9)");
  assert.equal(B.csvCell("+1-2"), "'+1-2");
  assert.equal(
    B.csvCell('=HYPERLINK("http://evil.example","click")'),
    '"\'=HYPERLINK(""http://evil.example"",""click"")"',
    "neutralising must happen before quoting, so both apply"
  );
});

test("negative numbers stay numbers", () => {
  // `-` leads a formula and also every negative measurement in the export.
  // Prefixing those would turn the numeric columns into text and break the
  // arithmetic a CSV export is opened to do.
  assert.equal(B.csvCell(-5), "-5");
  assert.equal(B.csvCell("-5"), "-5");
  assert.equal(B.csvCell("-0.25"), "-0.25");
  assert.equal(B.csvCell("-1.5e3"), "-1.5e3");
  assert.equal(B.csvCell("-2+3+cmd|' /C calc'!A0"), "'-2+3+cmd|' /C calc'!A0");
});

// ---- the envelope ------------------------------------------------------

test("the envelope names the format and the version an importer looks for", () => {
  const bundle = B.bundleFrom({
    matches: [{ id: "a" }],
    deckCards: { a: ["01AA001"] },
    exportedAt: "2026-08-13T10:00:00.000Z",
  });
  assert.deepEqual(bundle, {
    format: "riftatlas-tracker-archive",
    version: 2,
    exportedAt: "2026-08-13T10:00:00.000Z",
    matches: [{ id: "a" }],
    deckCards: { a: ["01AA001"] },
  });
});

test("an envelope with nothing to carry still round-trips through parseBundle", () => {
  // The two halves of this file are one format, so what one writes the other
  // has to accept - including the degenerate case a fresh install exports.
  const bundle = B.bundleFrom({ exportedAt: "2026-08-13T10:00:00.000Z" });
  assert.deepEqual(bundle.matches, []);
  assert.deepEqual(bundle.deckCards, {});
  assert.deepEqual(B.parseBundle(JSON.stringify(bundle)), { matches: [], deckCards: {} });
});

// ---- shaping a bundle out of a storage dump ----------------------------

test("each match gets its own log back inline", () => {
  const matches = [{ id: "a" }, { id: "b" }];
  const stored = {
    log_a: { id: "a", log: ["one", "two"] },
    log_b: { id: "b", log: ["three"] },
  };
  assert.deepEqual(B.inlineLogs(matches, stored), [
    { id: "a", log: ["one", "two"] },
    { id: "b", log: ["three"] },
  ]);
});

test("a match with no stored log exports with an empty one", () => {
  // A live match, or one recorded before logs were kept. Dropping it from the
  // export would lose the match to save its missing log.
  assert.deepEqual(B.inlineLogs([{ id: "a" }], {}), [{ id: "a", log: [] }]);
  assert.deepEqual(B.inlineLogs([{ id: "a" }], { log_a: { id: "a" } }), [{ id: "a", log: [] }]);
});

test("inlining a log does not touch the lean record it read from", () => {
  // `all` is the array the page renders and writes back. A log spliced onto a
  // record in place would be persisted, which is the ~21 KB-per-match write
  // the lean records exist to avoid.
  const match = { id: "a", deckName: "Hollowmark" };
  B.inlineLogs([match], { log_a: { id: "a", log: ["one"] } });
  assert.equal(match.log, undefined);
});

test("card lists are collected only for the matches that have them", () => {
  const matches = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const stored = {
    deckcards_a: { id: "a", codes: ["01AA001", "01AA002"] },
    // An empty list is not "no deck was recorded", so it is not carried: an
    // entry claiming an empty deck would import as a deck that was seen.
    deckcards_b: { id: "b", codes: [] },
  };
  assert.deepEqual(B.deckCardsFrom(matches, stored), { a: ["01AA001", "01AA002"] });
});

test("a malformed card record is skipped rather than exported", () => {
  const stored = { deckcards_a: { id: "a", codes: "01AA001" } };
  assert.deepEqual(B.deckCardsFrom([{ id: "a" }], stored), {});
});

// ---- the module itself -------------------------------------------------

test("the module loads under node with no window and exports its surface", () => {
  assert.equal(typeof window, "undefined", "this suite runs with no DOM shim");
  assert.equal(B, globalThis.RATrackerBundle, "the require export is the global legacy.js reads");
  for (const name of ["bundleFrom", "inlineLogs", "deckCardsFrom", "csvCell", "parseBundle"]) {
    assert.equal(typeof B[name], "function", `${name} must be exported`);
  }
  assert.equal(B.BUNDLE_VERSION, 2);
});
