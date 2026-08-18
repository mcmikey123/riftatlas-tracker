"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { decideResult, MAX_REASON_TEXT } = require("../capture/match-end.js");

/* This decides the result of every match that does not end by score, and until
 * this file existed nothing tested it. A miss files a real win as "unknown"
 * once the board unmounts; a false positive ends a game still being played.
 * Both are silent in a browser. */

// The record's own shape - decideResult is handed `currentMatch` itself.
const match = (over) =>
  Object.assign({ myName: "Kite", opponentName: "monke", myScore: 0, opponentScore: 0 }, over);

test("1. a victory banner is a win and a defeat banner is a loss", () => {
  assert.deepEqual(decideResult("VICTORY", match()), { result: "win", reason: "text:VICTORY" });
  assert.equal(decideResult("You won the game", match()).result, "win");
  assert.equal(decideResult("DEFEAT", match()).result, "loss");
  assert.equal(decideResult("You lost", match()).result, "loss");
});

/* The end words are deliberately strict because card and battlefield names land
 * in the same log this scans. "Won" and "left" on their own are card text. */
test("2. ordinary board and log text ends nothing", () => {
  for (const text of [
    "Conquered Howling Abyss and scored 1.",
    "monke played Abandoned Outpost",
    "Rolled 16, monke rolled 4.",
    "You draw a card",
    "",
  ]) {
    assert.equal(decideResult(text, match()), null, JSON.stringify(text));
  }
  assert.equal(decideResult(undefined, match()), null);
});

test("3. the opponent leaving is a win, and leaving yourself is a loss", () => {
  assert.equal(decideResult("monke LEFT", match()).result, "win");
  assert.equal(decideResult("Kite LEFT", match()).result, "loss");
  // The names are matched with a word boundary, so a longer name that contains
  // ours is still the other player leaving.
  assert.equal(decideResult("Kitesurfer LEFT", match({ opponentName: "Kitesurfer" })).result, "win");
});

/* KNOWN, PINNED AS-IS - a concede is decided by the score, not by who conceded.
 *
 * "conceded" / "concedes" / "wins the game" end the match (they are in
 * END_TEXT_RE) but appear in neither WIN_TEXT_RE nor LOSS_TEXT_RE, so the name
 * in the line is never read and the score leader decides. That is right often
 * enough to hide: players usually concede from behind. When someone concedes
 * while AHEAD - the one moment conceding is surprising enough to be worth
 * recording - the match is filed as the opposite of what happened, with a
 * confirmation toast that says "LOSS detected" over a game that was won.
 *
 * Left alone deliberately: fixing it means matching the conceding player's name
 * out of the line, which is the same name-rail reading that is already the
 * weakest input here, and this refactor changes no behaviour. */
test("3b. a concede is read off the score leader, so conceding while ahead inverts the result", () => {
  assert.equal(decideResult("monke conceded", match({ myScore: 5, opponentScore: 2 })).result, "win");
  assert.equal(decideResult("monke conceded", match({ myScore: 2, opponentScore: 5 })).result, "loss");
  assert.equal(decideResult("monke wins the game", match({ myScore: 5, opponentScore: 2 })).result, "win");
});

/* The leave modal is the reason the score fallback exists: it appears with a
 * "LEAVE GAME" button and, when the name rails were never read, names nobody. */
test("4. a leave modal naming neither player falls back to the score leader", () => {
  const anon = { myName: null, opponentName: null };
  assert.equal(decideResult("LEAVE GAME", match(Object.assign({ myScore: 5, opponentScore: 3 }, anon))).result, "win");
  assert.equal(decideResult("LEAVE GAME", match(Object.assign({ myScore: 1, opponentScore: 6 }, anon))).result, "loss");
});

test("5. a level score has no leader, so the result is unknown rather than a guess", () => {
  /* "unknown" is what makes the confirmation toast read as a question instead
   * of as a wrong answer, and it is the only honest reading of a tied board. */
  const tied = decideResult("LEAVE GAME", match({ myName: null, opponentName: null, myScore: 4, opponentScore: 4 }));
  assert.equal(tied.result, "unknown");
  const fresh = decideResult("LEAVE GAME", match({ myName: null, opponentName: null }));
  assert.equal(fresh.result, "unknown");
});

/* Names are typed by the player and go straight into a RegExp. Unescaped, "C++"
 * is a syntax error ("nothing to repeat") thrown out of the scan - which in the
 * content script aborts the whole mutation tick, so the victory modal in the
 * same batch is never read and the match ends as "unknown" minutes later. */
test("6. a player name made of regex metacharacters is matched literally, not compiled", () => {
  const meta = match({ myName: "C++", opponentName: "a.c" });
  assert.doesNotThrow(() => decideResult("C++ LEFT", meta));
  assert.equal(decideResult("C++ LEFT", meta).result, "loss");
  assert.equal(decideResult("a.c LEFT", meta).result, "win");
  // "a.c" unescaped would match "abc" - a match ended for the wrong player.
  assert.equal(decideResult("abc left the lobby", meta), null);
  for (const name of ["(", "[", "\\", "$", "?"]) {
    assert.doesNotThrow(() => decideResult("someone left", match({ myName: name })), name);
  }
});

test("7. the end reason quotes the text that triggered it, trimmed and bounded", () => {
  const long = "Victory! " + "x".repeat(200);
  const { reason } = decideResult(long, match());
  assert.equal(reason, "text:" + long.slice(0, MAX_REASON_TEXT));
  assert.equal(reason.length, "text:".length + MAX_REASON_TEXT);
  // Whitespace around a banner is layout, not evidence.
  assert.equal(decideResult("\n  VICTORY  \n", match()).reason, "text:VICTORY");
});

test("8. a match with no names read at all still detects a banner", () => {
  // The name rails are rotated single letters and often unreadable; that must
  // cost the leave-modal direction, never the banner.
  const anon = { myName: null, opponentName: null, myScore: 0, opponentScore: 0 };
  assert.equal(decideResult("VICTORY", anon).result, "win");
  assert.equal(decideResult("VICTORY", undefined).result, "win");
});
