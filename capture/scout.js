/* Rift Atlas Stats Tracker - who is across the table right now.
 *
 * The popup's scouting line needs one fact only this side can see: which
 * champion the opponent is on, RIGHT NOW - visible from the mulligan and
 * battlefield-pick screens, minutes before a match record exists, and all
 * through the game after that. Published under its own `pendingOpponent`
 * storage key with a "last seen" stamp, so the popup can refuse to scout an
 * opponent from a past session.
 *
 * The mechanics are capture/sticky-memory.js's, configured rather than
 * restated: the read throttle, the restamp-on-sighting, and the throttled
 * mirror are exactly the sequence the deck picker and the lobby format
 * already run. The one difference is that nothing on this side ever reads the
 * memory back - the popup is the consumer - so `load` is not wired.
 */
(function (root) {
  "use strict";

  /** The opponent the page is showing, or null when no one is across yet. */
  function read() {
    const legend = root.RATBoard.cardAlt("opponent", "legend");
    const champion = root.RATBoard.cardAlt("opponent", "champion");
    if (!legend && !champion) return null;
    return {
      champion: champion || null,
      legend: legend || null,
      name: root.RATBoard.playerNames().opponent || null,
    };
  }

  const memory = root.RATSticky.createStickyMemory({
    key: "pendingOpponent",
    read,
    same: (a, b) => a.champion === b.champion && a.legend === b.legend && a.name === b.name,
    // Never read back on this side, but the factory asks; a stored value with
    // neither card would be one `read` can never have produced.
    isStored: (v) => !!(v && (v.champion || v.legend)),
    onChange: (v) => console.info("[RA-Tracker] opponent on screen:", v.champion || v.legend),
  });

  root.RATScout = { watch: memory.watch };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATScout;
}
