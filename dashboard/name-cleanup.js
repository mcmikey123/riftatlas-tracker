/* Rift Atlas Stats Tracker - player names saved before the badge-text fix
 *
 * TEMPORARY. Delete after 2026-12-28, by which point every affected match is
 * months old: this file, its <script> tag in dashboard.html, the two
 * `cleanNames` calls in legacy.js load(), and test/name-cleanup.test.js.
 *
 * In September 2026 the site reworded the identity badge's aria-label from
 * "{name} menu" to "{name} profile and actions", and capture read the whole
 * label as the name. It also saved the "..." the opponent badge shows before
 * the site knows who they are, and kept it for the match. Capture now reads
 * the badge's printed name instead (capture/board-read.js); this repairs what
 * was saved in between.
 *
 * The suffix is stripped, which recovers the real name. A placeholder becomes
 * null: the real name was never on the page, so there is nothing to recover -
 * and left as "...", every such match looks like the same opponent to series
 * detection.
 *
 * The wordings are frozen to what was actually saved rather than shared with
 * board-read.js, which will keep moving with the site after this is deleted.
 */
(function (root) {
  "use strict";

  const SAVED_SUFFIX_RE = /\s+(menu|profile and actions)$/i;
  const PLACEHOLDER_RE = /^[.…\s]*$/;
  const NAME_FIELDS = ["myName", "opponentName"];

  function cleanName(name) {
    if (typeof name !== "string") return name;
    const stripped = name.replace(SAVED_SUFFIX_RE, "").trim();
    return PLACEHOLDER_RE.test(stripped) ? null : stripped;
  }

  /**
   * @param {object[]} matches - left untouched.
   * @returns {{matches: object[], changed: number}} a new array; a record whose
   *   names needed nothing is passed through as the same object.
   */
  function cleanNames(matches) {
    let changed = 0;
    const out = matches.map((m) => {
      const fixed = {};
      for (const field of NAME_FIELDS) {
        const name = cleanName(m[field]);
        if (name !== m[field]) fixed[field] = name;
      }
      if (!Object.keys(fixed).length) return m;
      changed++;
      return Object.assign({}, m, fixed);
    });
    return { matches: out, changed };
  }

  root.RATrackerNameCleanup = { cleanNames };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerNameCleanup;
}
