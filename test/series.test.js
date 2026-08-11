/* Series detection is the one piece of the best-of-3 feature that decides
 * something on its own rather than showing what it was told. It runs on every
 * dashboard load, it rewrites records, and the thing it must never do is revise
 * a grouping the user made by hand - so the rule, its six conditions and its
 * idempotence are all pinned here.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const S = require("../dashboard/series.js");

const T0 = Date.parse("2026-05-09T20:00:00.000Z");
const at = (min) => new Date(T0 + min * 60000).toISOString();

let seq = 0;
function match(over) {
  seq++;
  return Object.assign(
    {
      id: "m" + seq,
      startedAt: at(0),
      endedAt: at(20),
      opponentName: "vashiri",
      mode: "Ranked",
      result: "win",
      durationMs: 20 * 60000,
      deckName: "Hollowmark Aggro",
    },
    over
  );
}

/** n games back to back, 10 minutes apart, with the given results. */
function backToBack(results, over) {
  return results.map((result, i) =>
    match(Object.assign({ id: "g" + (i + 1), startedAt: at(i * 30), endedAt: at(i * 30 + 20), result }, over))
  );
}

const run = (matches, opts) => S.detect(matches, opts).matches;
const byId = (matches, id) => matches.find((m) => m.id === id);

// ---- the rule ----------------------------------------------------------

test("two back-to-back matches against the same opponent become a series", () => {
  const out = run(backToBack(["win", "loss"]));
  const g1 = byId(out, "g1");
  const g2 = byId(out, "g2");
  assert.ok(g1.seriesId, "first game should be in a series");
  assert.equal(g1.seriesId, g2.seriesId);
  assert.equal(g1.seriesGame, 1);
  assert.equal(g2.seriesGame, 2);
  assert.equal(g1.seriesFormat, "bo3");
  assert.equal(g1.seriesSource, "auto");
});

test("a lone match is not a series", () => {
  const out = run([match({ id: "only" })]);
  assert.equal(byId(out, "only").seriesId, null);
});

test("a different opponent breaks the series", () => {
  const games = backToBack(["win", "loss"]);
  games[1].opponentName = "brassline_02";
  const out = run(games);
  assert.equal(byId(out, "g1").seriesId, null);
  assert.equal(byId(out, "g2").seriesId, null);
});

test("a different mode breaks the series", () => {
  const games = backToBack(["win", "loss"]);
  games[1].mode = "Casual";
  const out = run(games);
  assert.equal(byId(out, "g1").seriesId, null);
});

test("an empty opponent name never groups - two unknowns are not a rematch", () => {
  const games = backToBack(["win", "loss"], { opponentName: "" });
  const out = run(games);
  assert.equal(byId(out, "g1").seriesId, null);
  assert.equal(byId(out, "g2").seriesId, null);
});

test("a gap wider than the window leaves the matches alone", () => {
  const games = [
    match({ id: "g1", startedAt: at(0), endedAt: at(20) }),
    match({ id: "g2", startedAt: at(120), endedAt: at(140) }), // 100 minutes later
  ];
  const out = run(games, { windowMinutes: 45 });
  assert.equal(byId(out, "g1").seriesId, null);
});

test("the window is configurable, and a wider one catches the same pair", () => {
  const games = [
    match({ id: "g1", startedAt: at(0), endedAt: at(20) }),
    match({ id: "g2", startedAt: at(120), endedAt: at(140) }),
  ];
  const out = run(games, { windowMinutes: 120 });
  assert.ok(byId(out, "g1").seriesId);
});

test("a previous match that never ended cannot start a series", () => {
  const games = [
    match({ id: "g1", startedAt: at(0), endedAt: null }),
    match({ id: "g2", startedAt: at(30), endedAt: at(50) }),
  ];
  const out = run(games);
  assert.equal(byId(out, "g2").seriesId, null);
});

test("a match starting before the previous one ended is not joined", () => {
  const games = [
    match({ id: "g1", startedAt: at(0), endedAt: at(60) }),
    match({ id: "g2", startedAt: at(30), endedAt: at(80) }),
  ];
  const out = run(games);
  assert.equal(byId(out, "g2").seriesId, null);
});

test("a match between two others breaks adjacency", () => {
  const games = [
    match({ id: "g1", startedAt: at(0), endedAt: at(20) }),
    match({ id: "other", startedAt: at(25), endedAt: at(45), opponentName: "someone-else" }),
    match({ id: "g2", startedAt: at(50), endedAt: at(70) }),
  ];
  const out = run(games);
  assert.equal(byId(out, "g1").seriesId, null);
  assert.equal(byId(out, "g2").seriesId, null);
});

// ---- completion --------------------------------------------------------

test("a Bo3 stops at two wins, and the next game starts a new series", () => {
  const out = run(backToBack(["win", "win", "win", "win"]));
  const g1 = byId(out, "g1");
  const g2 = byId(out, "g2");
  const g3 = byId(out, "g3");
  const g4 = byId(out, "g4");
  assert.equal(g1.seriesId, g2.seriesId, "2-0 takes the first series");
  assert.notEqual(g3.seriesId, g1.seriesId, "the third game cannot join a finished series");
  assert.equal(g3.seriesId, g4.seriesId, "it starts a second one instead");
});

test("a Bo3 that goes the distance holds all three games", () => {
  const out = run(backToBack(["win", "loss", "win"]));
  const ids = new Set(["g1", "g2", "g3"].map((id) => byId(out, id).seriesId));
  assert.equal(ids.size, 1, "all three games share one series");
  assert.equal(byId(out, "g3").seriesGame, 3);
});

test("a Bo5 needs three wins, so 2-0 keeps growing", () => {
  const out = run(backToBack(["win", "win", "loss"]), { format: "bo5" });
  const ids = new Set(["g1", "g2", "g3"].map((id) => byId(out, id).seriesId));
  assert.equal(ids.size, 1);
  assert.equal(byId(out, "g1").seriesFormat, "bo5");
});

test("draws and unknowns take the series nowhere but still occupy a game", () => {
  const out = run(backToBack(["draw", "draw", "unknown"]));
  const s = S.group(out)[0];
  assert.equal(s.games.length, 3);
  assert.equal(s.result, "unfinished");
});

// ---- manual is a fact --------------------------------------------------

test("a manual grouping is never revised by a later detection pass", () => {
  const games = backToBack(["win", "loss"]);
  games[0].seriesId = "s_mine";
  games[0].seriesGame = 1;
  games[0].seriesFormat = "bo5";
  games[0].seriesSource = "manual";
  const out = run(games);
  const g1 = byId(out, "g1");
  assert.equal(g1.seriesId, "s_mine");
  assert.equal(g1.seriesFormat, "bo5");
  assert.equal(g1.seriesSource, "manual");
});

test("a manual match walls off the automatic pass on either side of it", () => {
  const games = backToBack(["win", "loss", "win"]);
  games[1].seriesSource = "manual";
  games[1].seriesId = "s_mine";
  const out = run(games);
  assert.equal(byId(out, "g1").seriesId, null, "cannot join across a manual record");
  assert.equal(byId(out, "g3").seriesId, null);
});

test("detection can be turned off, and then clears its own guesses", () => {
  const grouped = run(backToBack(["win", "loss"]));
  assert.ok(byId(grouped, "g1").seriesId);
  const off = run(grouped, { enabled: false });
  assert.equal(byId(off, "g1").seriesId, null);
});

test("turning detection off leaves manual groupings standing", () => {
  const games = backToBack(["win", "loss"]);
  games.forEach((g) => {
    g.seriesId = "s_mine";
    g.seriesSource = "manual";
  });
  const out = run(games, { enabled: false });
  assert.equal(byId(out, "g1").seriesId, "s_mine");
});

// ---- idempotence -------------------------------------------------------

test("a second run over the same data changes nothing", () => {
  const first = S.detect(backToBack(["win", "loss", "win"]));
  assert.ok(first.changed > 0, "the first run has work to do");
  const second = S.detect(first.matches);
  assert.equal(second.changed, 0, "the second must be a no-op, or every load writes storage");
});

test("the series id is derived from the first game, so it is stable across runs", () => {
  const a = run(backToBack(["win", "loss"]));
  const b = run(backToBack(["win", "loss"]));
  assert.equal(byId(a, "g1").seriesId, byId(b, "g1").seriesId);
});

test("detect does not mutate the array it is given", () => {
  const games = backToBack(["win", "loss"]);
  S.detect(games);
  assert.equal(games[0].seriesId, undefined, "the caller's records are untouched");
});

// ---- grouping and records ----------------------------------------------

test("group builds one record per series, newest first", () => {
  const early = backToBack(["win", "win"]);
  const late = [
    match({ id: "h1", startedAt: at(600), endedAt: at(620), opponentName: "kell" }),
    match({ id: "h2", startedAt: at(630), endedAt: at(650), opponentName: "kell" }),
  ];
  const out = run(early.concat(late));
  const series = S.group(out);
  assert.equal(series.length, 2);
  assert.equal(series[0].games[0].id, "h1", "newest series first");
});

test("a series record reports the win, the score and the decider", () => {
  const out = run(backToBack(["loss", "win", "win"]));
  const s = S.group(out)[0];
  assert.equal(s.result, "win");
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.decider, "g3", "the game that reached the second win");
  assert.equal(s.format, "bo3");
});

test("a series with a game still in progress is live and has no total length", () => {
  const games = backToBack(["win", "loss"]);
  games[1].endedAt = null;
  games[1].durationMs = null;
  // Joining needs the FIRST match to have ended, which it has.
  const out = run(games);
  const s = S.group(out)[0];
  assert.equal(s.result, "live");
  assert.equal(s.live, true);
});

test("1-1 in a Bo3 is unfinished, not a loss", () => {
  const out = run(backToBack(["win", "loss"]));
  const s = S.group(out)[0];
  assert.equal(s.result, "unfinished");
  assert.equal(s.decider, null);
});

test("decks used lists each distinct name once, unlabelled included", () => {
  const games = backToBack(["win", "loss", "win"]);
  games[1].deckName = "";
  const out = run(games);
  const s = S.group(out)[0];
  assert.deepEqual(s.decks, ["Hollowmark Aggro", "— unlabelled —"]);
});

test("a series of untimed games has a null total, never a zero", () => {
  const games = backToBack(["win", "loss"]).map((g) => Object.assign(g, { durationMs: null }));
  const out = run(games);
  assert.equal(S.group(out)[0].totalMs, null);
});

// ---- statistics --------------------------------------------------------

test("unfinished series are excluded from the series win rate but counted in games", () => {
  const won = run(backToBack(["win", "win"]));
  const open = run([
    match({ id: "u1", startedAt: at(600), endedAt: at(620), opponentName: "kell", result: "win" }),
    match({ id: "u2", startedAt: at(630), endedAt: at(650), opponentName: "kell", result: "loss" }),
  ]);
  const stats = S.stats(S.group(won).concat(S.group(open)));
  assert.equal(stats.series, 2);
  assert.equal(stats.decided, 1, "only the finished series counts toward the record");
  assert.equal(stats.winRate, 1);
  assert.equal(stats.gameWins, 3, "the unfinished series' games still count");
  assert.equal(stats.gameLosses, 1);
});

test("win rate is null rather than zero when nothing is decided", () => {
  const out = run(backToBack(["win", "loss"]));
  const stats = S.stats(S.group(out));
  assert.equal(stats.winRate, null);
});

test("after losing game 1 counts only finished series", () => {
  const recovered = run(backToBack(["loss", "win", "win"]));
  const lost = run([
    match({ id: "l1", startedAt: at(600), endedAt: at(620), opponentName: "kell", result: "loss" }),
    match({ id: "l2", startedAt: at(630), endedAt: at(650), opponentName: "kell", result: "loss" }),
  ]);
  const stats = S.stats(S.group(recovered).concat(S.group(lost)));
  assert.equal(stats.lostFirst, 2);
  assert.equal(stats.lostFirstRecovered, 1);
  assert.equal(stats.lostFirstRate, 0.5);
});

test("a decider is a series that ran to its format's full length", () => {
  const three = run(backToBack(["win", "loss", "win"]));
  const two = run([
    match({ id: "t1", startedAt: at(600), endedAt: at(620), opponentName: "kell", result: "win" }),
    match({ id: "t2", startedAt: at(630), endedAt: at(650), opponentName: "kell", result: "win" }),
  ]);
  const stats = S.stats(S.group(three).concat(S.group(two)));
  assert.equal(stats.deciders, 1);
});

// ---- suggestions -------------------------------------------------------

test("a pair just outside the window is suggested, not applied", () => {
  const games = [
    match({ id: "s1", startedAt: at(0), endedAt: at(20) }),
    match({ id: "s2", startedAt: at(94), endedAt: at(114) }), // 74 minutes after the first ended
  ];
  const out = run(games, { windowMinutes: 45 });
  assert.equal(byId(out, "s1").seriesId, null, "nothing is applied");
  const found = S.suggestions(out, { windowMinutes: 45 });
  assert.equal(found.length, 1);
  assert.equal(found[0].gapMinutes, 74);
  assert.deepEqual(found[0].ids, ["s1", "s2"]);
});

test("a pair inside the window is detected, so it is never also suggested", () => {
  const out = run(backToBack(["win", "loss"]));
  assert.equal(S.suggestions(out, {}).length, 0);
});

test("a pair far outside the window is not suggested either", () => {
  const games = [
    match({ id: "s1", startedAt: at(0), endedAt: at(20) }),
    match({ id: "s2", startedAt: at(600), endedAt: at(620) }),
  ];
  const found = S.suggestions(run(games), { windowMinutes: 45 });
  assert.equal(found.length, 0);
});

test("a dismissed suggestion is not offered again", () => {
  const games = [
    match({ id: "s1", startedAt: at(0), endedAt: at(20) }),
    match({ id: "s2", startedAt: at(94), endedAt: at(114) }),
  ];
  const out = run(games, { windowMinutes: 45 });
  const dismissed = new Set(["s1|s2"]);
  assert.equal(S.suggestions(out, { windowMinutes: 45, dismissed }).length, 0);
});

// ---- tagging by hand ---------------------------------------------------

test("grouping by hand numbers the games from their timestamps and marks them manual", () => {
  const games = [
    match({ id: "a", startedAt: at(60), endedAt: at(80) }),
    match({ id: "b", startedAt: at(0), endedAt: at(20) }),
  ];
  const { matches, seriesId } = S.groupManually(games, ["a", "b"], "bo5");
  assert.ok(seriesId);
  assert.equal(byId(matches, "b").seriesGame, 1, "earliest match is game 1, whatever order was passed");
  assert.equal(byId(matches, "a").seriesGame, 2);
  assert.equal(byId(matches, "a").seriesSource, "manual");
  assert.equal(byId(matches, "a").seriesFormat, "bo5");
});

test("grouping fewer than two matches does nothing", () => {
  const { seriesId } = S.groupManually([match({ id: "a" })], ["a"], "bo3");
  assert.equal(seriesId, null);
});

test("removing a game renumbers the ones that are left", () => {
  const out = run(backToBack(["win", "loss", "win"]));
  const after = S.removeFromSeries(out, "g2");
  assert.equal(byId(after, "g2").seriesId, null);
  assert.equal(byId(after, "g1").seriesGame, 1);
  assert.equal(byId(after, "g3").seriesGame, 2, "the gap is closed, not left as game 3");
});

test("a series cannot survive as one game", () => {
  const out = run(backToBack(["win", "loss"]));
  const after = S.removeFromSeries(out, "g2");
  assert.equal(byId(after, "g1").seriesId, null, "the last game left is not a series of one");
});

test("changing one series' format makes it manual, so the default stops applying", () => {
  const out = run(backToBack(["win", "loss"]));
  const id = byId(out, "g1").seriesId;
  const after = S.setFormat(out, id, "bo5");
  assert.equal(byId(after, "g1").seriesFormat, "bo5");
  assert.equal(byId(after, "g1").seriesSource, "manual");
  // And a later pass leaves it alone.
  const rescanned = run(after);
  assert.equal(byId(rescanned, "g1").seriesFormat, "bo5");
});

// ---- bounds ------------------------------------------------------------

test("the window is clamped to 5..240 and survives nonsense", () => {
  assert.equal(S.clampWindow(0), 5);
  assert.equal(S.clampWindow(9999), 240);
  assert.equal(S.clampWindow("45"), 45);
  assert.equal(S.clampWindow("nonsense"), 45);
  assert.equal(S.clampWindow(undefined), 45);
});

test("an unknown format falls back to bo3 rather than throwing", () => {
  assert.equal(S.normFormat("bo7"), "bo3");
  assert.equal(S.normFormat(undefined), "bo3");
  assert.equal(S.normFormat("bo5"), "bo5");
});

test("records with no id are ignored rather than crashing the pass", () => {
  const out = run([null, { startedAt: at(0) }, match({ id: "ok" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "ok");
});
