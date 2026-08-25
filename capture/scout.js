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

  /* "Viktor, Machine Herald" -> "Viktor". The same split dashboard/format.js's
   * champ() makes; restated because content scripts do not load that file, the
   * same trade capture/deck-name.js already makes for championKey. */
  const championLabel = (v) => String((v && (v.champion || v.legend)) || "").split(",")[0].trim();

  /**
   * What the scouting card says about `name`: your record against that
   * champion, and the matchup note written for them. Pure; tested.
   */
  function scoutSummary(matches, notes, name) {
    let wins = 0;
    let losses = 0;
    for (const m of matches || []) {
      if (championLabel({ champion: m.opponentChampion, legend: m.opponentLegend }) !== name) continue;
      if (m.result === "win") wins++;
      else if (m.result === "loss") losses++;
    }
    const decided = wins + losses;
    return {
      name,
      wins,
      losses,
      decided,
      rate: decided ? wins / decided : null,
      note: String((notes || {})[name] || "").trim() || null,
    };
  }

  /* One card per opponent per stretch of play. A Bo3's second game is the same
   * person minutes later, and being told again what you were just told is the
   * kind of noise that gets a feature turned off. */
  const CARD_THROTTLE_MS = 10 * 60 * 1000;
  let lastCard = { name: null, at: 0 };

  function offerCard(sighting) {
    const name = championLabel(sighting);
    if (!name) return;
    const at = Date.now();
    if (lastCard.name === name && at - lastCard.at < CARD_THROTTLE_MS) return;
    lastCard = { name, at };
    try {
      chrome.storage.local.get({ matches: [], matchupNotes: {} }, (data) => {
        root.RATPageUI.showScoutCard(
          scoutSummary((data && data.matches) || [], (data && data.matchupNotes) || {}, name)
        );
      });
    } catch (_) {
      /* an orphaned script cannot read storage; the card is a convenience */
    }
  }

  const memory = root.RATSticky.createStickyMemory({
    key: "pendingOpponent",
    read,
    same: (a, b) => a.champion === b.champion && a.legend === b.legend && a.name === b.name,
    // Never read back on this side, but the factory asks; a stored value with
    // neither card would be one `read` can never have produced.
    isStored: (v) => !!(v && (v.champion || v.legend)),
    onChange: (v) => {
      console.info("[RA-Tracker] opponent on screen:", v.champion || v.legend);
      offerCard(v);
    },
  });

  root.RATScout = { watch: memory.watch, scoutSummary };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATScout;
}
