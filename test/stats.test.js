/* Recent form, win rate by week and the matchup grid.
 *
 * Tested because each one carries a claim that is easy to get quietly wrong:
 * recent form must count decided games rather than rows, the weekly buckets
 * must hold at local week boundaries and keep quiet weeks as real gaps, and
 * the grid's ordering decides which corner of it carries the evidence.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const STATS = require("../dashboard/stats.js");

/** A match at a local date. `new Date(y, m, d, h)` is local time, matching the
 * dashboard's own "local days" rule. */
const at = (y, m, d, h, result) => ({
  startedAt: new Date(y, m, d, h === undefined ? 12 : h).toISOString(),
  result,
});

// ---- recent form -------------------------------------------------------

test("recent form counts the most recent decided games, not the most recent rows", () => {
  const rows = [
    at(2026, 0, 1, 12, "win"), // oldest decided - outside the window of 3
    at(2026, 0, 2, 12, "loss"),
    at(2026, 0, 3, 12, "unknown"), // never decided: not a claimable result
    at(2026, 0, 4, 12, "win"),
    at(2026, 0, 5, 12, "draw"), // decided-adjacent but neither a win nor a loss
    at(2026, 0, 6, 12, "win"),
  ];
  const form = STATS.recentForm(rows, 3);
  assert.deepEqual(form, { wins: 2, losses: 1, decided: 3, rate: 2 / 3 });
});

test("recent form works from dates, not array order", () => {
  const rows = [at(2026, 0, 9, 12, "loss"), at(2026, 0, 1, 12, "win"), at(2026, 0, 5, 12, "loss")];
  const form = STATS.recentForm(rows, 2);
  assert.deepEqual({ wins: form.wins, losses: form.losses }, { wins: 0, losses: 2 });
});

test("recent form states the decided games it actually has", () => {
  const form = STATS.recentForm([at(2026, 0, 1, 12, "win")], 10);
  assert.equal(form.decided, 1, "asked for 10, has 1 - the tile writes the truthful denominator");
  assert.equal(form.rate, 1);
});

test("recent form over nothing is a null rate, not zero", () => {
  const form = STATS.recentForm([], 10);
  assert.equal(form.rate, null, "no games is no claim; 0% would read as losses");
});

// ---- week bucketing ----------------------------------------------------

test("weekStart lands on the local Monday midnight", () => {
  // 2026-08-14 is a Friday; its week starts Monday 2026-08-10.
  const friday = new Date(2026, 7, 14, 22, 30).getTime();
  assert.equal(STATS.weekStart(friday), new Date(2026, 7, 10).getTime());
  // A Monday is its own week start, however early in the day.
  const monday = new Date(2026, 7, 10, 0, 0).getTime();
  assert.equal(STATS.weekStart(monday), new Date(2026, 7, 10).getTime());
  // A Sunday belongs to the week that began the previous Monday.
  const sunday = new Date(2026, 7, 16, 23, 59).getTime();
  assert.equal(STATS.weekStart(sunday), new Date(2026, 7, 10).getTime());
});

test("weekly win rate buckets by local week and rates only the decided games", () => {
  const rows = [
    at(2026, 7, 10, 12, "win"), // Mon
    at(2026, 7, 12, 12, "loss"), // Wed, same week
    at(2026, 7, 13, 12, "unknown"), // counted in games, not in the rate
    at(2026, 7, 17, 12, "win"), // the Monday after: next week
  ];
  const { weeks } = STATS.weeklyWinRate(rows);
  assert.equal(weeks.length, 2);
  assert.deepEqual(
    { games: weeks[0].games, wins: weeks[0].wins, losses: weeks[0].losses, rate: weeks[0].rate },
    { games: 3, wins: 1, losses: 1, rate: 0.5 }
  );
  assert.equal(weeks[0].start, new Date(2026, 7, 10).getTime());
  assert.equal(weeks[1].rate, 1);
});

test("a quiet week between games is kept as a gap, not skipped", () => {
  const rows = [at(2026, 7, 3, 12, "win"), at(2026, 7, 17, 12, "loss")]; // two weeks apart
  const { weeks } = STATS.weeklyWinRate(rows);
  assert.equal(weeks.length, 3, "the empty middle week is a real week of not playing");
  assert.deepEqual(
    { games: weeks[1].games, rate: weeks[1].rate },
    { games: 0, rate: null }
  );
});

test("the week cap keeps the newest weeks and reports what it dropped", () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(at(2026, 0, 5 + i * 7, 12, "win")); // ten consecutive weeks
  const { weeks, omitted } = STATS.weeklyWinRate(rows, 4);
  assert.equal(weeks.length, 4);
  assert.equal(omitted, 6);
  assert.equal(weeks[weeks.length - 1].start, STATS.weekStart(new Date(2026, 0, 5 + 9 * 7).getTime()));
});

test("undated matches are reported rather than silently unplotted", () => {
  const rows = [at(2026, 7, 10, 12, "win"), { startedAt: "", result: "loss" }];
  const out = STATS.weeklyWinRate(rows);
  assert.equal(out.undated, 1);
  assert.equal(out.weeks[0].games, 1);
});

test("no dated rows at all is an empty chart, not a crash", () => {
  assert.deepEqual(STATS.weeklyWinRate([]), { weeks: [], omitted: 0, undated: 0 });
});

// ---- matchup matrix ----------------------------------------------------

const game = (mine, theirs, result) => ({
  myChampion: mine,
  opponentChampion: theirs,
  result,
});

test("the grid aggregates per matchup and rates only the decided games", () => {
  const grid = STATS.matchupMatrix([
    game("Ashe", "Viktor", "win"),
    game("Ashe", "Viktor", "loss"),
    game("Ashe", "Viktor", "unknown"),
    game("Ashe", "Jinx", "win"),
  ]);
  assert.deepEqual(grid.cell("Ashe", "Viktor"), {
    games: 3,
    wins: 1,
    losses: 1,
    decided: 2,
    rate: 0.5,
  });
  assert.equal(grid.cell("Ashe", "Jinx").rate, 1);
  assert.equal(grid.cell("Jinx", "Ashe"), null, "an unplayed matchup is no cell at all");
});

test("rows and columns are ordered by games played, names breaking the ties", () => {
  const grid = STATS.matchupMatrix([
    game("Ashe", "Viktor", "win"),
    game("Teemo", "Viktor", "win"),
    game("Teemo", "Jinx", "loss"),
    game("Zed", "Jinx", "loss"),
  ]);
  assert.deepEqual(grid.mine, ["Teemo", "Ashe", "Zed"], "most games first, then alphabetical");
  assert.deepEqual(grid.theirs, ["Jinx", "Viktor"]);
});

test("champions come through the legend fallback and the champ() split", () => {
  const grid = STATS.matchupMatrix([
    { myLegend: "Ashe, Queen of Ice", opponentLegend: "Viktor, Machine", result: "win" },
  ]);
  assert.equal(grid.cell("Ashe", "Viktor").wins, 1);
});

test("a matchup with no decided games has a null rate, not zero", () => {
  const grid = STATS.matchupMatrix([game("Ashe", "Viktor", "unknown")]);
  assert.equal(grid.cell("Ashe", "Viktor").rate, null);
});
