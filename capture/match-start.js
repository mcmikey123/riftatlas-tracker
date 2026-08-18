/* Rift Atlas Stats Tracker - is this "in_game" board actually a new game?
 *
 * ONE ENTRY PER GAME is the rule this exists to keep. The site does not unmount
 * the board when a match finishes: it draws the end overlay on top and leaves
 * the phase at "in_game", so the content script goes on being told, several
 * times a second, that a game is in progress. Three different things look
 * identical from there:
 *
 *   - a finished game whose board is lingering under the overlay,
 *   - a game we ended too early (a stray "VICTORY" in a card name, a leave
 *     modal that turned out to be someone else's) which is still being played,
 *   - a genuine rematch in the same room, which deserves its own record.
 *
 * Reading them apart wrongly is silent both ways: a duplicate half-record for a
 * game already filed, or a rematch appended onto the previous game's row. The
 * turn counter is the evidence - it resets when a new game is dealt - and the
 * suppression conditions below are the ones under which a "finished" verdict is
 * never revisited, so an end/resume loop cannot form.
 *
 * The verdicts are the interface. Every mutation they imply - clearing the
 * latch, reopening the previous record, building a new one - stays in
 * content.js, which owns that state.
 */
(function (root) {
  "use strict";

  // First to 8 points takes the match. Duplicated in content.js, which uses it
  // for score-based end detection; test/content-wiring.test.js pins the pair.
  const WIN_SCORE = 8;

  /* After this many ends, the record is closed for good.
   *
   * A hard latch rather than another condition: each of the checks above it can
   * be argued with, and a match that has already been ended and reopened twice
   * is one where they are being argued with every tick. Three is "twice was a
   * coincidence"; it also bounds the confirmation toast, which stops appearing
   * at the same count. */
  const MAX_ENDS = 3;

  /**
   * @param {{roomCode, record}|null} latch - the last match we ended
   *   (content.js's `lastEnded`), or null when nothing has ended here.
   * @param {{roomCode: ?string, turnNow: number, myScore: ?number}} board
   *   what the board says right now.
   * @returns {{verdict: "suppress"|"reopen"|"start", clearLatch: boolean}}
   *   `clearLatch` is separate from the verdict because a turn-counter reset
   *   spends the latch even in the one case where the board is then refused -
   *   without it that refusal would be re-decided from a stale latch forever.
   */
  function decideStart(latch, board) {
    const { roomCode, turnNow, myScore } = board || {};
    const sameRoom = !!(latch && latch.roomCode && latch.roomCode === roomCode);
    let clearLatch = false;

    if (sameRoom) {
      const prev = latch.record;
      const turns = turnNow || 0;
      /* A new game deals from turn 1, so a counter at or below 1 is a fresh
       * board - and one BELOW the highest turn we recorded is a fresh board
       * too, for the game that was reloaded or rejoined partway in. */
      const isNewGame = turns <= 1 || turns < (prev.turns || 1);
      if (!isNewGame) {
        const decidedByScore =
          prev.myScore >= WIN_SCORE || prev.opponentScore >= WIN_SCORE;
        if (
          decidedByScore ||
          prev.resultSource === "manual" || // a human said so
          prev.endReason === "score" || // a score-decided end is never false
          (prev.endCount || 0) >= MAX_ENDS
        ) {
          return { verdict: "suppress", clearLatch: false };
        }
        // Nothing decisive ended it and the game is still going: it was a false
        // end, and the record it produced is this game's.
        return { verdict: "reopen", clearLatch: false };
      }
      clearLatch = true; // turn counter reset: genuine rematch, record it
    }

    // Belt and braces: a game that is starting is not already won. Guards the
    // path where the room code was never read, so the latch above matched
    // nothing and a lingering finished board looks brand new.
    if (myScore !== null && myScore >= WIN_SCORE) {
      return { verdict: "suppress", clearLatch };
    }
    return { verdict: "start", clearLatch };
  }

  root.RATMatchStart = { decideStart, WIN_SCORE, MAX_ENDS };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATMatchStart;
}
