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

// ---- the matchup note ---------------------------------------------------

test("the popup's matchup note surfaces for its champion, whichever way the key is spelled", () => {
  /* matchupNotes is the popup's per-champion key ("shows here whenever you
   * face X"); the panel reads the same store so a note written in the popup
   * is on the game page at the moment it was written to be read. */
  const notes = { Corin: "  she levels fast — race her  ", "Viktor, Herald of the Arcane": "slow game" };
  assert.equal(GN.noteFor(notes, "Corin, Tidecaller"), "she levels fast — race her");
  assert.equal(GN.noteFor(notes, "Viktor"), "slow game", "a full-alt key still matches its champion");
  assert.equal(GN.noteFor(notes, "Mel, Defiant Soul"), "", "no note for this champion");
  assert.equal(GN.noteFor(notes, null), "", "nobody across the table yet");
  assert.equal(GN.noteFor(null, "Corin"), "");
  assert.equal(GN.noteFor({ Corin: "   " }, "Corin"), "", "whitespace is not a note");
});

// ---- where the panel sits -----------------------------------------------

test("the anchor defaults to the mid-left edge and honours a dragged spot", () => {
  /* The game parks its own score rail and player badge in the corners, so
   * the default is the mid-left edge - and wherever the player drags the
   * panel wins from then on. */
  assert.deepEqual(GN.anchorFor(null, 1920, 1000), { x: 14, y: 420 });
  assert.deepEqual(GN.anchorFor({ x: 600, y: 200 }, 1920, 1000), { x: 600, y: 200 });
});

test("a remembered spot from a larger window is clamped back on screen", () => {
  const a = GN.anchorFor({ x: 2500, y: 1400 }, 1280, 720);
  assert.ok(a.x <= 1280 - 34 && a.y <= 720 - 34, "inside the viewport");
  const b = GN.anchorFor({ x: -50, y: -50 }, 1280, 720);
  assert.deepEqual(b, { x: 4, y: 4 });
  // Garbage stored is the default, not NaN styles.
  const c = GN.anchorFor({ x: "junk", y: null }, 1920, 1000);
  assert.deepEqual(c, { x: 14, y: 420 });
});

// ---- when the panel is on screen at all ---------------------------------

test("a pregame board shows the panel, a live match keeps it, anything else removes it", () => {
  /* content.js drives the panel through observe() on every tick, and
   * stateFor is the whole decision. The pregame case is the one this exists
   * for: the opponent is on screen during the mulligan, minutes before a
   * match record exists, and that is when a reminder can still change how
   * you play. */
  const live = { id: "m1" };
  assert.equal(GN.stateFor("mulligan", null), "pregame");
  assert.equal(GN.stateFor("battlefield_pick", null), "pregame");
  assert.equal(GN.stateFor("in_game", live), "live");
  // A live record outranks whatever the phase says mid-transition.
  assert.equal(GN.stateFor("mulligan", live), "live");
  // A finished game's board lingers in "in_game" with no record - that is a
  // game that is over, not one about to start.
  assert.equal(GN.stateFor("in_game", null), "off");
  assert.equal(GN.stateFor(null, null), "off");
});
