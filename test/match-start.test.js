"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { decideStart, WIN_SCORE, MAX_ENDS } = require("../capture/match-start.js");

/* The site leaves the board in "in_game" under the end overlay, so the content
 * script is told a game is in progress several times a second after one has
 * finished. Reading that wrongly is silent both ways: a duplicate half-record
 * for a game already filed, or a rematch appended onto the previous game's row.
 *
 * `latch` is content.js's `lastEnded`; `board` is what the DOM says right now. */

const ROOM = "ABC123";
const ended = (over) =>
  ({
    roomCode: ROOM,
    record: Object.assign(
      { turns: 12, myScore: 3, opponentScore: 4, resultSource: "auto", endReason: null, endCount: 1 },
      over
    ),
  });
// Mid-game turn counter: well past the previous game's, so nothing was dealt.
const lingering = { roomCode: ROOM, turnNow: 14, myScore: 3 };

test("1. with no match ended here, an in_game board starts a record", () => {
  assert.deepEqual(decideStart(null, { roomCode: ROOM, turnNow: 1, myScore: 0 }), {
    verdict: "start",
    clearLatch: false,
  });
  // Mid-game arrival (a tab opened onto a running game) is still a start.
  assert.deepEqual(decideStart(null, { roomCode: ROOM, turnNow: 9, myScore: 2 }), {
    verdict: "start",
    clearLatch: false,
  });
});

test("2. a match ended in another room says nothing about this one", () => {
  const other = decideStart(ended(), { roomCode: "ZZZ999", turnNow: 14, myScore: 0 });
  assert.deepEqual(other, { verdict: "start", clearLatch: false });
  // A room code we could not read must not match a remembered one either.
  assert.deepEqual(decideStart({ roomCode: null, record: {} }, { roomCode: null, turnNow: 14, myScore: 0 }), {
    verdict: "start",
    clearLatch: false,
  });
});

/* Four ways a finished game is known to be finished. Each one is a case where
 * reopening the record would be wrong, and together they are what stops an
 * end/resume loop: every tick of a lingering board hits one of them. */
test("3. a score-decided game is over, whichever side reached the target", () => {
  assert.equal(decideStart(ended({ myScore: WIN_SCORE }), lingering).verdict, "suppress");
  assert.equal(decideStart(ended({ opponentScore: WIN_SCORE }), lingering).verdict, "suppress");
  assert.equal(decideStart(ended({ myScore: WIN_SCORE - 1 }), lingering).verdict, "reopen");
});

test("4. a result a human confirmed is never reopened", () => {
  // The toast is the player telling us what happened; nothing we read off the
  // board afterwards outranks it.
  assert.equal(decideStart(ended({ resultSource: "manual" }), lingering).verdict, "suppress");
});

test("5. an end reason of \"score\" is never a false end", () => {
  // Distinct from case 3: the record's stored scores can lag the board, so the
  // reason the match ended is checked as well as the numbers behind it.
  assert.equal(decideStart(ended({ endReason: "score", myScore: 0, opponentScore: 0 }), lingering).verdict, "suppress");
  assert.equal(decideStart(ended({ endReason: "text:VICTORY" }), lingering).verdict, "reopen");
});

test("6. after enough ends the record latches shut", () => {
  /* The hard stop. The three checks above it can each be argued with, and a
   * record that has been ended and reopened this often is one where they are
   * being argued with every tick - so the count decides instead. */
  assert.equal(decideStart(ended({ endCount: MAX_ENDS - 1 }), lingering).verdict, "reopen");
  assert.equal(decideStart(ended({ endCount: MAX_ENDS }), lingering).verdict, "suppress");
  assert.equal(decideStart(ended({ endCount: MAX_ENDS + 9 }), lingering).verdict, "suppress");
  // A record from before the counter existed reads as zero, not as latched.
  assert.equal(decideStart(ended({ endCount: undefined }), lingering).verdict, "reopen");
});

test("7. nothing decisive plus a game still being played is a false end", () => {
  /* The path that recovers a match ended by a stray "VICTORY" in card text: the
   * previous record IS this game, so it is handed back rather than replaced -
   * a new record would lose the turns, log and cards already collected. */
  assert.deepEqual(decideStart(ended(), lingering), { verdict: "reopen", clearLatch: false });
});

test("8. a turn counter back at the start is a genuine rematch", () => {
  // Same room, same players, new game - it gets its own record, and the latch
  // that was guarding the old one is spent.
  for (const turnNow of [0, 1]) {
    assert.deepEqual(decideStart(ended(), { roomCode: ROOM, turnNow, myScore: 0 }), {
      verdict: "start",
      clearLatch: true,
    }, "turn " + turnNow);
  }
  // An unreadable turn counter arrives here as 0 and reads as a fresh deal -
  // deliberately, since the alternative is never recording the rematch.
  assert.deepEqual(decideStart(ended(), { roomCode: ROOM, turnNow: 0, myScore: 0 }).verdict, "start");
});

test("9. a turn counter below the previous game's high-water mark is a rematch too", () => {
  /* Bo3 games two and three are dealt into the same room, and the board can be
   * several turns in before we look at it. Turn 5 after a game that reached 12
   * cannot be that game. */
  assert.deepEqual(decideStart(ended({ turns: 12 }), { roomCode: ROOM, turnNow: 5, myScore: 0 }), {
    verdict: "start",
    clearLatch: true,
  });
  assert.equal(decideStart(ended({ turns: 12 }), { roomCode: ROOM, turnNow: 12, myScore: 0 }).verdict, "reopen");
  // A record with no turn count behaves as if it reached turn 1.
  assert.equal(decideStart(ended({ turns: undefined }), { roomCode: ROOM, turnNow: 4, myScore: 0 }).verdict, "reopen");
});

test("10. a board already at match point is not the start of anything", () => {
  /* Belt and braces for the case the latch cannot cover: the room code was
   * never read, so a lingering finished board looks brand new. */
  assert.deepEqual(decideStart(null, { roomCode: null, turnNow: 14, myScore: WIN_SCORE }), {
    verdict: "suppress",
    clearLatch: false,
  });
  assert.equal(decideStart(null, { roomCode: null, turnNow: 14, myScore: WIN_SCORE - 1 }).verdict, "start");
  // An unreadable score track is not evidence of anything and must not block a
  // real game from being recorded.
  assert.equal(decideStart(null, { roomCode: ROOM, turnNow: 1, myScore: null }).verdict, "start");
});

test("11. a rematch spends the latch even when the board is then refused", () => {
  /* The one case where the verdict and the latch disagree, and the reason
   * `clearLatch` is not folded into the verdict: the turn counter has said this
   * is a new deal, so the old record can never be reopened again - and if the
   * latch survived the refusal, the same stale record would be re-consulted on
   * every tick for the rest of the session. */
  assert.deepEqual(decideStart(ended(), { roomCode: ROOM, turnNow: 1, myScore: WIN_SCORE }), {
    verdict: "suppress",
    clearLatch: true,
  });
});

test("12. suppress and reopen always leave the latch in place", () => {
  // Both verdicts are about the previous record, so dropping the latch would
  // throw away the very thing the caller is being told to act on.
  assert.equal(decideStart(ended({ resultSource: "manual" }), lingering).clearLatch, false);
  assert.equal(decideStart(ended(), lingering).clearLatch, false);
});
