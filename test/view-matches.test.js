/* Which rows the Matches table decides to show.
 *
 * `visibleMatches` is the only place the three filters, the date range, the
 * search box and the sort meet. Each primitive it calls is already covered in
 * table.test.js; what is NOT covered anywhere else is the ORDER it composes them
 * in, and that order is load-bearing:
 *
 *   - Filter, then range, then search, then sort. Searching the unfiltered set
 *     would resurrect rows the champion picker excluded; sorting before the
 *     search would order rows that are about to be thrown away.
 *   - Filtering happens before paging, and the count above the table is taken
 *     before paging too - "41 matches match your filters" is a claim about the
 *     whole set, not about the 25 rows you can see.
 *   - The page is clamped and WRITTEN BACK. Narrowing the set while sitting on
 *     page 3 otherwise renders a blank table under a working pager.
 *
 * These are characterization tests: they pin what the view does today so the
 * decomposition can move this logic without changing it. Where the current
 * behaviour looks wrong it is still pinned as-is, with the concern noted in a
 * comment rather than corrected here.
 *
 * NODE VERSION: this file loads an ES module from CommonJS via `require()`,
 * which is unflagged only on Node >= 22.12. On older Node the requires below
 * fail with ERR_REQUIRE_ESM - the fix is a newer Node, not a change here.
 */
const test = require("node:test");
const { beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/* view-matches.js reads window.RATracker* at MODULE scope, so the stub has to
 * exist before it is required - not before the first test. */
const format = require("../dashboard/format.js");
const tableLib = require("../dashboard/table.js");
const seriesLib = require("../dashboard/series.js");
// The row's note dot and the expanded row's summary both read a match's
// timestamped notes off this, which is pure and has no page behind it.
const notesLib = require("../dashboard/replay-notes.js");

global.window = {
  RATrackerFormat: format,
  RATrackerTable: tableLib,
  RATrackerSeries: seriesLib,
  RATrackerReplayNotes: notesLib,
  // Only what a collapsed row reaches for. Expanded rows need a real DOM and
  // are not exercised here.
  RATrackerLegacy: { deckNames: () => [], hasVisual: () => false },
};

const { state } = require("../dashboard/state.js");
const V = require("../dashboard/view-matches.js");

/* `state` is a live singleton shared with every other view, so anything a test
 * sets has to be put back or the next test inherits it. */
function resetState() {
  Object.assign(state.filters, {
    champion: "",
    deck: "",
    mode: "",
    dateRange: { preset: "all", from: null, to: null },
  });
  Object.assign(state.tables.matches, { sortKey: "date", sortDir: "desc", search: "", page: 1 });
  Object.assign(state.tables.series, { sortKey: "date", sortDir: "desc", search: "" });
  state.openRows.clear();
  state.selection.clear();
  state.openRowMenu = null;
}

beforeEach(resetState);

let seq = 0;
function match(over) {
  seq++;
  return Object.assign(
    {
      id: "m" + seq,
      startedAt: new Date(2026, 4, 10, 12, 0).toISOString(),
      endedAt: new Date(2026, 4, 10, 12, 20).toISOString(),
      mode: "Ranked",
      result: "win",
      myChampion: "Hollowmark",
      opponentChampion: "Morrow",
      opponentName: "vashiri",
      roomCode: "RA-8842",
      deckName: "Aggro",
      durationMs: 20 * 60000,
      myScore: 8,
      resultSource: "auto",
    },
    over
  );
}

const ids = (rows) => rows.map((m) => m.id);

// ---- the filters -------------------------------------------------------

test("the champion filter matches the champion as the table displays it", () => {
  // A legend field carries "Name, Something Else" and the picker offers only the
  // first part, so the filter has to compare the derived name or nothing matches.
  const all = [
    match({ id: "plain", myChampion: "Hollowmark" }),
    match({ id: "legend", myChampion: null, myLegend: "Hollowmark, The Deep" }),
    match({ id: "other", myChampion: "Morrow" }),
  ];
  state.filters.champion = "Hollowmark";
  assert.deepEqual(ids(V.visibleMatches(all)).sort(), ["legend", "plain"]);
});

test("a match with no champion at all is filed under Unknown, not dropped", () => {
  const all = [match({ id: "known" }), match({ id: "blank", myChampion: null, myLegend: null })];
  state.filters.champion = "Unknown";
  assert.deepEqual(ids(V.visibleMatches(all)), ["blank"]);
});

test("the deck filter treats an empty or whitespace name as Unlabelled", () => {
  const all = [
    match({ id: "named", deckName: "Aggro" }),
    match({ id: "empty", deckName: "" }),
    match({ id: "spaces", deckName: "   " }),
    match({ id: "missing", deckName: undefined }),
  ];
  state.filters.deck = "Unlabelled";
  assert.deepEqual(ids(V.visibleMatches(all)).sort(), ["empty", "missing", "spaces"]);
});

test("the deck filter compares trimmed names, so a stray space still matches", () => {
  const all = [match({ id: "padded", deckName: "  Aggro " }), match({ id: "other", deckName: "Control" })];
  state.filters.deck = "Aggro";
  assert.deepEqual(ids(V.visibleMatches(all)), ["padded"]);
});

test("the mode filter is an exact match, so Ranked does not catch ranked", () => {
  const all = [match({ id: "ranked", mode: "Ranked" }), match({ id: "lower", mode: "ranked" })];
  state.filters.mode = "Ranked";
  assert.deepEqual(ids(V.visibleMatches(all)), ["ranked"]);
});

test("the three filters narrow together rather than widening each other", () => {
  const all = [
    match({ id: "all3", myChampion: "Hollowmark", deckName: "Aggro", mode: "Ranked" }),
    match({ id: "wrongdeck", myChampion: "Hollowmark", deckName: "Control", mode: "Ranked" }),
    match({ id: "wrongmode", myChampion: "Hollowmark", deckName: "Aggro", mode: "Casual" }),
    match({ id: "wrongchamp", myChampion: "Morrow", deckName: "Aggro", mode: "Ranked" }),
  ];
  state.filters.champion = "Hollowmark";
  state.filters.deck = "Aggro";
  state.filters.mode = "Ranked";
  assert.deepEqual(ids(V.visibleMatches(all)), ["all3"]);
});

test("an unset filter is not a filter for the empty string", () => {
  // The controls sit at "" when nobody has touched them, and a row with no mode
  // recorded must not be the only thing that survives that.
  const all = [match({ id: "a", mode: "Ranked" }), match({ id: "b", mode: "" })];
  assert.equal(V.visibleMatches(all).length, 2);
});

// ---- range and search combine ------------------------------------------

const MAY = { preset: "custom", from: "2026-05-05", to: "2026-05-20" };
const at = (month, day) => new Date(2026, month, day, 12, 0).toISOString();

test("the date range and the search term both have to be satisfied", () => {
  const all = [
    match({ id: "inside", startedAt: at(4, 10), opponentName: "vashiri" }),
    match({ id: "outside", startedAt: at(5, 10), opponentName: "vashiri" }),
    match({ id: "wrongname", startedAt: at(4, 10), opponentName: "quietwake" }),
  ];
  state.filters.dateRange = MAY;
  state.tables.matches.search = "vashiri";
  // The search runs over the ranged set, so a June match cannot be pulled back
  // in by typing its opponent's name.
  assert.deepEqual(ids(V.visibleMatches(all)), ["inside"]);
});

test("the search covers both champions, the opponent, the room code and the deck", () => {
  const all = [
    match({ id: "mine", myChampion: "Hollowmark", opponentChampion: "Morrow" }),
    match({ id: "theirs", myChampion: "Morrow", opponentChampion: "Hollowmark" }),
    match({ id: "neither", myChampion: "Morrow", opponentChampion: "Morrow" }),
  ];
  state.tables.matches.search = "hollow";
  assert.deepEqual(ids(V.visibleMatches(all)).sort(), ["mine", "theirs"]);

  state.tables.matches.search = "RA-88";
  assert.equal(V.visibleMatches(all).length, 3);

  state.tables.matches.search = "aggro";
  assert.equal(V.visibleMatches(all).length, 3);
});

test("searching a champion name matches the displayed name, not the raw legend", () => {
  const all = [match({ id: "legend", myChampion: null, myLegend: "Hollowmark, The Deep" })];
  state.tables.matches.search = "hollowmark";
  assert.equal(V.visibleMatches(all).length, 1);
  // The part after the comma is not in the searched text, because the table does
  // not show it either.
  state.tables.matches.search = "the deep";
  assert.equal(V.visibleMatches(all).length, 0);
});

test("searching for unknown surfaces the matches with no champion recorded", () => {
  // Characterization, and arguably a surprise: the champion fields are searched
  // through champ(), which substitutes the literal "Unknown" for a missing name.
  const all = [match({ id: "blank", myChampion: null, myLegend: null }), match({ id: "known" })];
  state.tables.matches.search = "unknown";
  assert.deepEqual(ids(V.visibleMatches(all)), ["blank"]);
});

test("an empty search term leaves the set alone rather than emptying it", () => {
  const all = [match({}), match({})];
  state.tables.matches.search = "   ";
  assert.equal(V.visibleMatches(all).length, 2);
});

// ---- sorting on top of the rest ----------------------------------------

test("the sort orders what survived the search, not the whole history", () => {
  const all = [
    match({ id: "excluded", opponentName: "quietwake", myScore: 1 }),
    match({ id: "high", opponentName: "vashiri", myScore: 9 }),
    match({ id: "low", opponentName: "vashiri", myScore: 3 }),
  ];
  state.tables.matches.search = "vashiri";
  state.tables.matches.sortKey = "score";
  state.tables.matches.sortDir = "asc";
  const rows = V.visibleMatches(all);
  assert.deepEqual(ids(rows), ["low", "high"], "the lowest score overall was filtered out first");
});

test("the default sort is newest first", () => {
  const all = [
    match({ id: "older", startedAt: at(4, 1) }),
    match({ id: "newer", startedAt: at(4, 9) }),
  ];
  assert.deepEqual(ids(V.visibleMatches(all)), ["newer", "older"]);
});

test("visibleMatches returns the whole filtered set, never a page of it", () => {
  // Paging is renderMatches's job. If this ever sliced, the count above the
  // table would silently start reporting 25.
  const all = Array.from({ length: 40 }, (_, i) => match({ id: "m" + i }));
  assert.equal(V.visibleMatches(all).length, 40);
});

test("visibleMatches does not mutate or reorder the array it is handed", () => {
  const all = [match({ id: "a", startedAt: at(4, 1) }), match({ id: "b", startedAt: at(4, 9) })];
  V.visibleMatches(all);
  assert.deepEqual(ids(all), ["a", "b"]);
});

test("no matches yet is an empty list, not a crash", () => {
  assert.deepEqual(V.visibleMatches(null), []);
  assert.deepEqual(V.visibleMatches(undefined), []);
  assert.deepEqual(V.visibleMatches([]), []);
});

// ---- the sort keys behind the columns ----------------------------------

test("an unrecognised column falls back to sorting by when the match started", () => {
  const m = match({ startedAt: at(4, 10) });
  assert.equal(V.sortKeyFor("nonexistent")(m), Date.parse(m.startedAt));
  assert.equal(V.sortKeyFor("date")(m), Date.parse(m.startedAt));
});

test("a match with an unreadable date has no sort key, so it sinks to the bottom", () => {
  assert.equal(V.sortKeyFor("date")({ startedAt: "not a date" }), null);
  assert.equal(V.sortKeyFor("date")({}), null);
});

test("the matchup column sorts by your champion, not your opponent's", () => {
  assert.equal(V.sortKeyFor("matchup")(match({ myChampion: "Hollowmark", opponentChampion: "Aardwing" })), "Hollowmark");
  assert.equal(V.sortKeyFor("matchup")(match({ myChampion: null, myLegend: "Morrow, The Quiet" })), "Morrow");
});

test("the deck column sorts by the trimmed name, and unlabelled rows sink", () => {
  assert.equal(V.sortKeyFor("deck")(match({ deckName: "  Aggro " })), "Aggro");
  // Note this is "" and not the "Unlabelled" the deck FILTER buckets under -
  // deliberate here, since an empty key is what sortBy sends to the bottom.
  assert.equal(V.sortKeyFor("deck")(match({ deckName: "   " })), "");
  assert.equal(V.sortKeyFor("deck")(match({ deckName: undefined })), "");

  const rows = tableLib.sortBy(
    [match({ id: "none", deckName: "" }), match({ id: "aggro", deckName: "Aggro" })],
    V.sortKeyFor("deck"),
    "desc"
  );
  assert.deepEqual(ids(rows), ["aggro", "none"]);
});

test("the score column sorts numerically, and an unscored match has no key", () => {
  // Scores arrive off the board as strings often enough that a lexicographic
  // sort would put 10 before 9.
  assert.equal(V.sortKeyFor("score")(match({ myScore: "10" })), 10);
  assert.equal(V.sortKeyFor("score")(match({ myScore: 0 })), 0, "a nil-all match is scored, not unscored");
  assert.equal(V.sortKeyFor("score")(match({ myScore: null })), null);
  assert.equal(V.sortKeyFor("score")(match({ myScore: undefined })), null);
});

test("the length column ignores a duration that is not a finite number", () => {
  assert.equal(V.sortKeyFor("length")(match({ durationMs: 90000 })), 90000);
  assert.equal(V.sortKeyFor("length")(match({ durationMs: undefined })), null);
  assert.equal(V.sortKeyFor("length")(match({ durationMs: NaN })), null);
});

test("the source column reads 'in game' for a live match, whatever it was told", () => {
  // A match still running has a resultSource on the record but nothing the user
  // would call a source yet, so live rows group together instead of scattering.
  assert.equal(V.sortKeyFor("source")(match({ endedAt: null, resultSource: "auto" })), "in game");
  assert.equal(V.sortKeyFor("source")(match({ resultSource: "manual" })), "manual");
  assert.equal(V.sortKeyFor("source")(match({ resultSource: undefined })), "");
});

test("mode, result and series read straight off the record", () => {
  assert.equal(V.sortKeyFor("mode")(match({ mode: "Casual" })), "Casual");
  assert.equal(V.sortKeyFor("result")(match({ result: "loss" })), "loss");
  assert.equal(V.sortKeyFor("series")(match({ seriesId: "s1" })), "s1");
  assert.equal(V.sortKeyFor("series")(match({ seriesId: undefined })), null, "matches in no series sink, not sort as ''");
});

// ---- the header ---------------------------------------------------------

test("the header has exactly one column per grid track", () => {
  // The grid is a CSS string and the columns are an array; nothing but this
  // makes them agree, and a mismatch shifts every cell in every row.
  assert.equal(V.COLUMNS.length, V.GRID.trim().split(/\s+/).length);
});

test("the three chrome columns carry no label and no sort", () => {
  // Checkbox, expander and the row's ⋯ menu.
  const chrome = V.COLUMNS.filter((c) => c.sortable === false);
  assert.equal(chrome.length, 3);
  for (const c of chrome) {
    assert.equal(c.key, "");
    assert.equal(c.label, "");
  }
});

test("every sortable column has a sort key of its own", () => {
  // A column added to the header without a matching sortKeyFor branch silently
  // sorts by date instead, which looks like a broken header rather than a bug.
  const sample = match({ seriesId: "s1" });
  const fallback = V.sortKeyFor("__no_such_column__")(sample);
  for (const c of V.COLUMNS) {
    if (c.sortable === false || c.key === "date") continue;
    assert.notEqual(V.sortKeyFor(c.key)(sample), fallback, `${c.key} falls through to the date sort`);
  }
});

// ---- where a deck name came from ---------------------------------------

test("the picker's verified and unverified cases are told apart", () => {
  // Same origin, different confidence: one had its champion checked against the
  // board and one did not, and the dot is the only thing that says so.
  assert.equal(V.deckSourceOf({ deckSource: "picker" }).dot, "win");
  assert.equal(V.deckSourceOf({ deckSource: "picker-unverified" }).dot, "unknown");
  assert.notEqual(
    V.deckSourceOf({ deckSource: "picker" }).words,
    V.deckSourceOf({ deckSource: "picker-unverified" }).words
  );
});

test("a name you typed and a name matched from play are their own sources", () => {
  assert.equal(V.deckSourceOf({ deckSource: "manual" }).dot, "draw");
  assert.equal(V.deckSourceOf({ deckSource: "fingerprint" }).dot, "accent");
});

test("an unrecorded source still gets a dot and a sentence", () => {
  // Old records predate deckSource entirely; the expanded row prints this
  // sentence unconditionally, so an undefined would be shown to the user.
  for (const m of [{}, { deckSource: "somethingnew" }, { deckSource: null }]) {
    const src = V.deckSourceOf(m);
    assert.equal(src.dot, "unknown");
    assert.ok(src.words.length > 0);
  }
});

test("every deck source uses a dot the legend explains", () => {
  // The legend under the table lists these four and nothing else, so a fifth
  // colour would be an unexplained dot on screen.
  const legend = new Set(["win", "draw", "accent", "unknown"]);
  const sources = ["picker", "picker-unverified", "board", "url", "last", "fingerprint", "manual"];
  for (const s of sources) {
    assert.ok(legend.has(V.deckSourceOf({ deckSource: s }).dot), `${s} uses a dot the legend does not explain`);
  }
});

// ---- filtering before paging -------------------------------------------

/* renderMatches only ever writes to container.innerHTML, so an object with that
 * one property is enough to observe what it decided without a DOM. Rows are
 * left collapsed: the expanded row calls into legacy.js and does need one. */
const sink = () => ({ innerHTML: "" });
const rowCount = (html) => (html.match(/data-row="/g) || []).length;

test("filtering happens before paging, so a narrowed set is not a slice of the old one", () => {
  const all = [
    ...Array.from({ length: 55 }, (_, i) => match({ id: "c" + i, mode: "Casual" })),
    ...Array.from({ length: 5 }, (_, i) => match({ id: "r" + i, mode: "Ranked" })),
  ];
  state.filters.mode = "Ranked";
  const out = sink();
  V.renderMatches(out, all, false);
  // Paging first would page the 60 and then filter the 25 on that page, leaving
  // a handful of rows or none at all.
  assert.equal(rowCount(out.innerHTML), 5);
  assert.match(out.innerHTML, /5 matches match your filters/);
});

test("the count above the table is the whole filtered set, not the page", () => {
  const all = Array.from({ length: 60 }, (_, i) => match({ id: "m" + i }));
  const out = sink();
  V.renderMatches(out, all, false);
  assert.equal(rowCount(out.innerHTML), 25, "one page of rows");
  assert.match(out.innerHTML, /60 matches match your filters/, "but the whole set in the count");
});

test("a page past the end is clamped and written back, not rendered blank", () => {
  const all = Array.from({ length: 30 }, (_, i) => match({ id: "m" + i }));
  state.tables.matches.page = 3; // two pages exist; a search got here first
  const out = sink();
  V.renderMatches(out, all, false);
  assert.equal(state.tables.matches.page, 2, "written back, or the footer disagrees with the table");
  assert.equal(rowCount(out.innerHTML), 5);
  assert.doesNotMatch(out.innerHTML, /mempty/, "a blank table with a working pager under it is the failure");
});

test("a filter that leaves nothing says so instead of drawing an empty table", () => {
  const all = [match({ mode: "Ranked" })];
  state.filters.mode = "Casual";
  const out = sink();
  V.renderMatches(out, all, false);
  assert.equal(rowCount(out.innerHTML), 0);
  assert.match(out.innerHTML, /No matches match your filters/);
});

test("a search that leaves nothing names the term that found nothing", () => {
  const all = [match({ opponentName: "vashiri" })];
  state.tables.matches.search = "zzz";
  const out = sink();
  V.renderMatches(out, all, false);
  assert.match(out.innerHTML, /Nothing matches/);
  assert.match(out.innerHTML, /zzz/);
});

test("the clear-filters affordance tracks the row count, not whether a filter is set", () => {
  // Characterization of a real gap: a filter that happens to exclude nothing
  // leaves no way to see it is on. Pinned as-is rather than corrected.
  const all = [match({ mode: "Ranked" }), match({ mode: "Ranked" })];
  state.filters.mode = "Ranked";
  const out = sink();
  V.renderMatches(out, all, false);
  assert.doesNotMatch(out.innerHTML, /data-clearfilters/);
});

// ---- timestamped replay notes ------------------------------------------

/* The notes themselves are replay-notes.js's and are tested there. What is the
 * table's own is where they show up: a dot on the collapsed row, and a summary
 * in the expanded one whose timestamps open the replay at the moment they name.
 *
 * The expanded row reaches into legacy.js for the log, the analysis and the
 * deck names, so this section widens the stub above for the rows it opens. */
const withLegacy = (over, run) => {
  const before = global.window.RATrackerLegacy;
  global.window.RATrackerLegacy = Object.assign(
    {
      deckNames: () => [],
      hasVisual: () => false,
      logFor: () => [],
      analyse: () => ({
        verdict: "No read",
        detail: "",
        hasLog: false,
        lines: 0,
        unmatched: 0,
        self: {},
        opponent: {},
      }),
      shareOpenHas: () => false,
      shareBoxInner: () => "",
    },
    over
  );
  try {
    run();
  } finally {
    global.window.RATrackerLegacy = before;
  }
};

const NOTED = [{ id: "n1", atMs: 125000, text: "traded the wrong unit" }];

test("a match reviewed only through timestamped notes still carries the row's dot", () => {
  // The dot said "there is writing on this match" and knew about one kind of
  // writing, so a match noted entirely from the replay read as having none.
  const out = sink();
  V.renderMatches(out, [match({ id: "noted", notes: "", timedNotes: NOTED })], false);
  assert.match(out.innerHTML, /note-dot/);
  assert.match(out.innerHTML, /1 timestamped note/);
});

test("the expanded row summarises the notes, each timestamp opening the replay there", () => {
  state.openRows.add("noted");
  withLegacy({ hasVisual: (id) => id === "noted" }, () => {
    const out = sink();
    V.renderMatches(out, [match({ id: "noted", timedNotes: NOTED })], false);
    assert.match(out.innerHTML, /Replay notes/);
    assert.match(out.innerHTML, /traded the wrong unit/);
    // The same attribute Open full screen carries, plus the moment: one path
    // from a click to a modal, and the modal is told where to open.
    assert.match(out.innerHTML, /data-visual="noted" data-at="125000"/);
    assert.match(out.innerHTML, /data-notedrop="noted:n1"/);
  });
});

test("notes outlive the recording they were written against, minus the jump", () => {
  state.openRows.add("noted");
  withLegacy({ hasVisual: () => false }, () => {
    const out = sink();
    V.renderMatches(out, [match({ id: "noted", timedNotes: NOTED })], false);
    assert.match(out.innerHTML, /traded the wrong unit/, "the notes are still worth reading");
    assert.doesNotMatch(out.innerHTML, /data-at=/, "but there is nothing left to open");
    assert.match(out.innerHTML, /tn-at-gone/);
  });
});

test("an archive shows its notes and offers no way to delete one", () => {
  state.openRows.add("noted");
  withLegacy({}, () => {
    const out = sink();
    V.renderMatches(out, [match({ id: "noted", timedNotes: NOTED })], true);
    assert.match(out.innerHTML, /traded the wrong unit/);
    assert.doesNotMatch(out.innerHTML, /data-notedrop/);
  });
});

test("a match with no notes gets no summary at all, not an empty heading", () => {
  state.openRows.add("plain");
  withLegacy({}, () => {
    const out = sink();
    V.renderMatches(out, [match({ id: "plain" })], false);
    assert.doesNotMatch(out.innerHTML, /Replay notes/);
  });
});
