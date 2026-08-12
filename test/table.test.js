/* Sort, search, date range and pagination.
 *
 * These are tested because the dashboard re-renders every three seconds while a
 * match is live, which turns two normally-cosmetic bugs into serious ones: an
 * unstable sort makes the table shuffle while you read it, and an unclamped
 * page renders blank the moment a search narrows the set under you.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const T = require("../dashboard/table.js");

const rows = (...keys) => keys.map((k, i) => ({ k, id: "r" + i }));

// ---- sorting -----------------------------------------------------------

test("sorts ascending and descending by a key function", () => {
  const data = rows(3, 1, 2);
  assert.deepEqual(
    T.sortBy(data, (r) => r.k, "asc").map((r) => r.k),
    [1, 2, 3]
  );
  assert.deepEqual(
    T.sortBy(data, (r) => r.k, "desc").map((r) => r.k),
    [3, 2, 1]
  );
});

test("sorting is stable, so equal keys keep their order in both directions", () => {
  const data = [
    { k: 1, id: "a" },
    { k: 1, id: "b" },
    { k: 1, id: "c" },
  ];
  assert.deepEqual(
    T.sortBy(data, (r) => r.k, "asc").map((r) => r.id),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    T.sortBy(data, (r) => r.k, "desc").map((r) => r.id),
    ["a", "b", "c"],
    "descending must not reverse ties - the table would shuffle every re-render"
  );
});

test("does not mutate the array it is given", () => {
  const data = rows(3, 1, 2);
  T.sortBy(data, (r) => r.k, "asc");
  assert.deepEqual(data.map((r) => r.k), [3, 1, 2]);
});

test("empty values sort last whichever way the column points", () => {
  const data = [{ k: 5 }, { k: null }, { k: 1 }];
  assert.deepEqual(T.sortBy(data, (r) => r.k, "asc").map((r) => r.k), [1, 5, null]);
  assert.deepEqual(T.sortBy(data, (r) => r.k, "desc").map((r) => r.k), [5, 1, null]);
});

test("strings sort naturally, so game 10 follows game 9", () => {
  const data = rows("game 10", "game 9", "game 1");
  assert.deepEqual(
    T.sortBy(data, (r) => r.k, "asc").map((r) => r.k),
    ["game 1", "game 9", "game 10"]
  );
});

test("string sorting ignores case", () => {
  const data = rows("beta", "Alpha");
  assert.deepEqual(T.sortBy(data, (r) => r.k, "asc").map((r) => r.k), ["Alpha", "beta"]);
});

// ---- search ------------------------------------------------------------

const matches = [
  { opponentName: "brassline_02", roomCode: "RA-8842", champion: "Hollowmark", deckName: "Aggro" },
  { opponentName: "quietwake", roomCode: "RA-1190", champion: "Morrow", deckName: "Control" },
];

test("search is case-insensitive substring over the nominated fields", () => {
  const found = T.search(matches, "BRASS", ["opponentName", "roomCode", "champion", "deckName"]);
  assert.equal(found.length, 1);
  assert.equal(found[0].opponentName, "brassline_02");
});

test("search matches a room code, a champion and a deck name too", () => {
  const fields = ["opponentName", "roomCode", "champion", "deckName"];
  assert.equal(T.search(matches, "1190", fields).length, 1);
  assert.equal(T.search(matches, "morrow", fields).length, 1);
  assert.equal(T.search(matches, "control", fields).length, 1);
});

test("an empty or whitespace term returns everything", () => {
  const fields = ["opponentName"];
  assert.equal(T.search(matches, "", fields).length, 2);
  assert.equal(T.search(matches, "   ", fields).length, 2);
});

test("search accepts a derived field, not only a property name", () => {
  const found = T.search(matches, "hollow", [(m) => m.champion + " vs " + m.opponentName]);
  assert.equal(found.length, 1);
});

test("a term matching nothing returns nothing rather than everything", () => {
  assert.equal(T.search(matches, "zzz", ["opponentName"]).length, 0);
});

// ---- date range --------------------------------------------------------

const NOW = new Date(2026, 4, 20, 14, 30).getTime(); // 20 May 2026, local

test("all time places no bounds", () => {
  assert.deepEqual(T.resolveRange({ preset: "all" }, NOW), { from: null, to: null });
  assert.deepEqual(T.resolveRange(null, NOW), { from: null, to: null });
});

test("last 7 days counts today plus the six before it", () => {
  const { from } = T.resolveRange({ preset: "7" }, NOW);
  assert.equal(from, new Date(2026, 4, 14).getTime());
});

test("a custom range is inclusive of both end days", () => {
  const { from, to } = T.resolveRange({ preset: "custom", from: "2026-05-01", to: "2026-05-02" }, NOW);
  assert.equal(from, T.startOfDay(new Date(2026, 4, 1).getTime()));
  // The end is the last millisecond of its day, so a match played that evening
  // is inside the range.
  assert.equal(to, T.startOfDay(new Date(2026, 4, 2).getTime()) + 86399999);
});

test("a custom range with only one end bounds only that end", () => {
  const open = T.resolveRange({ preset: "custom", from: "2026-05-01" }, NOW);
  assert.ok(open.from !== null);
  assert.equal(open.to, null);
});

test("filtering keeps the boundary days at both ends", () => {
  const data = [
    { startedAt: new Date(2026, 4, 1, 0, 0).toISOString() },
    { startedAt: new Date(2026, 4, 2, 23, 59).toISOString() },
    { startedAt: new Date(2026, 4, 3, 0, 1).toISOString() },
  ];
  const kept = T.inRange(data, { preset: "custom", from: "2026-05-01", to: "2026-05-02" }, "startedAt", NOW);
  assert.equal(kept.length, 2, "both boundary days are inside the range");
});

test("a row with no date is excluded from a bounded range, not included by default", () => {
  const data = [{ startedAt: null }, { startedAt: new Date(2026, 4, 19).toISOString() }];
  assert.equal(T.inRange(data, { preset: "7" }, "startedAt", NOW).length, 1);
});

test("an unbounded range keeps rows with no date", () => {
  const data = [{ startedAt: null }];
  assert.equal(T.inRange(data, { preset: "all" }, "startedAt", NOW).length, 1);
});

// ---- pagination --------------------------------------------------------

const many = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));

test("a page is 25 rows and reports its own range", () => {
  const p = T.paginate(many(41), 1);
  assert.equal(p.rows.length, 25);
  assert.equal(p.pages, 2);
  assert.equal(p.total, 41);
  assert.equal(p.first, 1);
  assert.equal(p.last, 25);
});

test("the last page holds the remainder", () => {
  const p = T.paginate(many(41), 2);
  assert.equal(p.rows.length, 16);
  assert.equal(p.first, 26);
  assert.equal(p.last, 41);
});

test("a page past the end clamps, and says which page it clamped to", () => {
  // Typing in the search box while sitting on page 3 is the way this happens.
  const p = T.paginate(many(12), 3);
  assert.equal(p.page, 1, "the caller writes this back, or the footer lies");
  assert.equal(p.rows.length, 12);
});

test("a page below the first clamps up", () => {
  assert.equal(T.paginate(many(30), 0).page, 1);
  assert.equal(T.paginate(many(30), -5).page, 1);
});

test("a nonsense page falls back to the first rather than emptying the table", () => {
  assert.equal(T.paginate(many(30), undefined).page, 1);
  assert.equal(T.paginate(many(30), "nonsense").page, 1);
});

test("no rows reads as 0-0 of 0, never 1-0", () => {
  const p = T.paginate([], 1);
  assert.equal(p.first, 0);
  assert.equal(p.last, 0);
  assert.equal(p.pages, 1, "one empty page, so the footer still renders");
});

test("the page list gaps long histories instead of drawing 400 buttons", () => {
  assert.deepEqual(T.pageList(1, 3), [1, 2, 3]);
  assert.deepEqual(T.pageList(10, 20), [1, null, 9, 10, 11, null, 20]);
  assert.deepEqual(T.pageList(1, 20), [1, 2, null, 20]);
  assert.deepEqual(T.pageList(1, 1), [1]);
});

test("the page list never repeats the first or last page", () => {
  const list = T.pageList(2, 3);
  assert.deepEqual(list, [1, 2, 3]);
  assert.equal(new Set(list).size, list.length);
});
