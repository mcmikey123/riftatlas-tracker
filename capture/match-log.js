/* Rift Atlas Stats Tracker - merging a re-scraped game log into the stored one.
 *
 * The match-log panel is re-rendered wholesale by the site: every scrape hands
 * back brand-new nodes for lines that were already on screen a frame ago, so
 * node identity - the obvious way to tell an old line from a new one - says
 * nothing at all. Nor can the text: a game log genuinely repeats itself
 * ("Drew a card." twice in a turn is two events, not one).
 *
 * So the merge counts. A line already stored N times is only appended when the
 * scrape shows it an (N+1)th time. Ordering comes from the scrape being in
 * document order and the log only ever growing at the end.
 *
 * Pure over its arguments: the DOM scrape stays in content.js and hands plain
 * `{t, actor, text}` objects here. `mergeLog` returns a new array rather than
 * pushing into the one it was given, so a caller cannot half-apply a merge.
 */
(function (root) {
  "use strict";

  /** Identity of a log line, for counting. The whole line is the identity. */
  const logSig = (e) => e.t + "|" + e.actor + "|" + e.text;

  /* Chat rows render their own header and repeat the time after the message, so
   * the raw text carries the same timestamp up to three times
   * ("16:34You at 16:34: nice?16:34"). The row's time is stored once in `t` and
   * drawn by the dashboard, so every standalone repeat of it is noise. Only
   * repeats of THIS row's own time are touched - a time that genuinely differs
   * is part of what was said and stays put.
   *
   * `t` is interpolated into a RegExp unescaped. That is safe only because the
   * caller reads it with /^\d{1,2}:\d{2}$/ - see the test named for it. */
  function stripRepeatedTime(text, t) {
    return text
      .replace(new RegExp("^" + t + "\\s*"), "")
      .replace(new RegExp("\\s*" + t + "$"), "")
      .replace(new RegExp("\\s+at\\s+" + t + "\\s*:"), ":")
      .trim();
  }

  /**
   * Fold a fresh scrape into the log already stored for this match.
   *
   * @param {Array<{t,actor,text}>} existing - the log so far, oldest first.
   * @param {Array<{t,actor,text}>} entries - the whole panel, oldest first.
   * @param {number} max - ceiling on stored lines; the oldest go first.
   * @returns {Array<{t,actor,text}>} a new array; `existing` is untouched.
   */
  function mergeLog(existing, entries, max) {
    const merged = (existing || []).slice();
    const stored = new Map();
    for (const e of merged) {
      const s = logSig(e);
      stored.set(s, (stored.get(s) || 0) + 1);
    }
    const seen = new Map();
    for (const e of entries || []) {
      const s = logSig(e);
      const n = (seen.get(s) || 0) + 1;
      seen.set(s, n);
      if (n > (stored.get(s) || 0)) {
        merged.push(e);
        if (merged.length > max) merged.shift();
      }
    }
    return merged;
  }

  root.RATMatchLog = { mergeLog, logSig, stripRepeatedTime };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATMatchLog;
}
