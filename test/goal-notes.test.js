"use strict";

/* Which goals the game page (and the popup) show for a given opponent.
 *
 * `goalsFor` is the one selection every surface draws from - the in-page
 * panel at match start, and the toolbar popup beside its scouting line - so
 * what it decides is asserted rather than trusted:
 *
 *   - A MATCHUP GOAL WAITS FOR ITS CHAMPION. Before anyone is across the
 *     table there is nothing to match, and a goal about Corin shown against
 *     Viktor is a reminder about the wrong game.
 *   - THE MATCH IS ON THE CHAMPION, NOT THE SPELLING. The board's alt text is
 *     "Corin, Tidecaller" while a goal typed by hand usually says "Corin";
 *     both name the same opponent and both must match either way around.
 *   - DONE IS DONE. A goal ticked off in the dashboard is kept for the
 *     record, and showing it before a game would un-finish it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const GN = require("../capture/goal-notes.js");

const g = (over) =>
  Object.assign({ id: "g1", text: "Mulligan for early units", opponent: "", done: false }, over);

const texts = (goals) => goals.map((x) => x.text);

test("a generic goal shows in every game; a matchup goal waits for its champion", () => {
  const goals = [
    g({ id: "a", text: "always" }),
    g({ id: "b", text: "vs corin only", opponent: "Corin" }),
  ];

  const before = GN.goalsFor(goals, null);
  assert.deepEqual(texts(before.generic), ["always"]);
  assert.deepEqual(before.matchup, [], "nobody across the table yet");

  const vsCorin = GN.goalsFor(goals, "Corin, Tidecaller");
  assert.deepEqual(texts(vsCorin.matchup), ["vs corin only"]);
  assert.deepEqual(texts(vsCorin.generic), ["always"]);

  const vsOther = GN.goalsFor(goals, "Viktor, Herald of the Arcane");
  assert.deepEqual(vsOther.matchup, [], "a Corin goal is not a Viktor goal");
});

test("the champion matches whichever way the spelling runs", () => {
  // A goal typed as the full alt text still matches the board's alt text, and
  // a goal typed as the bare name matches it too - both are the same split
  // dashboard/format.js's champ() makes.
  const goals = [
    g({ id: "a", text: "bare name", opponent: "Corin" }),
    g({ id: "b", text: "full alt", opponent: "Corin, Tidecaller" }),
  ];
  const { matchup } = GN.goalsFor(goals, "Corin, Tidecaller");
  assert.deepEqual(texts(matchup), ["bare name", "full alt"]);
});

test("a done goal, a blank goal and a corrupt entry are never shown", () => {
  const goals = [
    g({ id: "a", text: "live" }),
    g({ id: "b", text: "finished", done: true }),
    g({ id: "c", text: "   " }),
    null,
    g({ id: "d", text: "finished matchup", opponent: "Corin", done: true }),
  ];
  const { matchup, generic } = GN.goalsFor(goals, "Corin, Tidecaller");
  assert.deepEqual(texts(generic), ["live"]);
  assert.deepEqual(matchup, []);
});

test("no goals at all is two empty lists, not a crash", () => {
  assert.deepEqual(GN.goalsFor(null, "Corin"), { matchup: [], generic: [] });
  assert.deepEqual(GN.goalsFor(undefined, null), { matchup: [], generic: [] });
});
