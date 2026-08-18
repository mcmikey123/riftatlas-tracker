/* Rift Atlas Stats Tracker - how a match's result is read out of page text.
 *
 * Every match that does not end by score ends here: a victory banner, a
 * concede line in the game log, or the "<PLAYER> LEFT" modal. The result this
 * returns is the one the dashboard reports for the rest of time, and the whole
 * decision is made from a string plus four facts about the match, so it lives
 * on its own where `node --test` can reach it.
 *
 * Nothing in here touches the DOM. The caller still owns the two things that
 * are not a decision about text: ignoring the extension's own toast (whose
 * words would otherwise be read as a result), and ending the match.
 *
 * Every failure mode here is silent in a browser. A miss files a real win as
 * "unknown" minutes later when the board unmounts; a false positive ends a game
 * that is still being played, and the false-end latch in match-start.js then
 * has to undo it.
 */
(function (root) {
  "use strict";

  /* Deliberately strict: card and battlefield names appear in the match log,
   * so loose words ("abandoned", "won", "left") cause false match-ends. */
  const END_TEXT_RE = /\b(victory|defeat|you win|you lose|you won|you lost|wins the game|conceded|concedes)\b/i;
  const WIN_TEXT_RE = /\b(victory|you win|you won)\b/i;
  const LOSS_TEXT_RE = /\b(defeat|you lose|you lost)\b/i;
  // The modal that accompanies "<PLAYER> LEFT" - it names a player we may not
  // have read, so on its own it only says the game is over, not who won.
  const LEAVE_MODAL_RE = /\bleave game\b/i;

  // How much of the triggering text is kept on the record as the end reason.
  // Enough to recognise which banner fired when reading a match back; short
  // enough that a whole re-rendered log panel cannot land in the record.
  const MAX_REASON_TEXT = 60;

  /* Player names are typed by the player, so they arrive here as arbitrary
   * text and go straight into a RegExp. Unescaped, a name like "C++" is a
   * syntax error ("nothing to repeat") that throws out of the scan, and a name
   * like "a.c" quietly matches "abc". */
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const leftRe = (name) => new RegExp("\\b" + escRe(name) + "\\s+left\\b", "i");

  /**
   * What a piece of page text says about how this match ended.
   *
   * @param {string} text - the text of a node that just appeared.
   * @param {{myName?, opponentName?, myScore?, opponentScore?}} match
   * @returns {{result: "win"|"loss"|"unknown", reason: string}|null}
   *   null when the text says nothing about the match ending at all - which is
   *   almost every call, since this runs over every node the site renders.
   */
  function decideResult(text, match) {
    if (!text) return null;
    const { myName, opponentName, myScore, opponentScore } = match || {};

    // The "<PLAYER> LEFT" end-modal. Which player left is the whole result, so
    // it is worth matching the names even though they are read off a rail of
    // rotated single letters and are often missing.
    const oppLeft = !!opponentName && leftRe(opponentName).test(text);
    const iLeft = !!myName && leftRe(myName).test(text);
    const leaveModal = LEAVE_MODAL_RE.test(text);
    if (!END_TEXT_RE.test(text) && !oppLeft && !iLeft && !leaveModal) return null;

    let result = "unknown";
    if (WIN_TEXT_RE.test(text) || oppLeft) result = "win";
    else if (LOSS_TEXT_RE.test(text) || iLeft) result = "loss";
    else {
      /* The text says the game is over but not who won - a leave modal naming
       * neither player. The score leader is the best guess available, and a
       * level score has none, so it says so rather than inventing one: the
       * confirmation toast asks the player, and "unknown" is what makes it
       * appear as a question rather than as a wrong answer. */
      result = myScore === opponentScore ? "unknown" : myScore > opponentScore ? "win" : "loss";
    }
    return { result, reason: "text:" + text.trim().slice(0, MAX_REASON_TEXT) };
  }

  root.RATMatchEnd = { decideResult, MAX_REASON_TEXT };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATMatchEnd;
}
