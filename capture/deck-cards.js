/* Rift Atlas Stats Tracker - which of your cards this match revealed.
 *
 * Deck fingerprinting only ever needed one thing out of a match: the set of
 * YOUR OWN card codes (e.g. "UNL-199") that became visible while playing it. So
 * that set is what is accumulated, live, instead of storing a board snapshot per
 * game action and reducing it later.
 *
 * Rift Atlas bumps data-authoritative-sequence on every authoritative game
 * action, which is still the trigger: one scrape per real game event. Only codes
 * we have not seen before make the set dirty, so a board that reveals nothing
 * new costs a scrape and no write, and the write itself is throttled - the set
 * is rewritten whole each time, and mid-match it is only ever growing.
 *
 * The accumulator is keyed by match id and switches when the id does, so a
 * second game cannot inherit the first one's cards. `resume` exists for the
 * mid-game reload, where the record being adopted already has a stored set.
 */
(function (root) {
  "use strict";

  const CARDS_SAVE_MS = 5000; // how often to flush the card-code accumulator

  // The zones that reflect deck contents. Mirrors DECK_ZONES in
  // dashboard/fingerprint.js - legend and champion are excluded there because
  // they're identical across variants of the same champion, so harvesting them
  // here would only blur the distinction fingerprinting is drawing.
  const DECK_ZONES = ["battlefieldA", "battlefieldB", "base", "hand", "trash", "runeArea"];

  let held = { id: null, codes: new Set() };
  let lastSeq = null;
  let dirty = false;
  let savedAt = 0;

  const codeFromSrc = (src) => {
    const m = /\/cards\/[^/]+\/([A-Za-z0-9]+-[A-Za-z0-9]+)\.webp/.exec(src || "");
    return m ? m[1] : null;
  };

  /** Your own card codes currently visible in one deck zone. */
  function zoneCards(owner, zoneRoot) {
    const out = [];
    let roots;
    try {
      roots = document.querySelectorAll(
        `[data-drop-zone-root="${zoneRoot}"][data-zone-owner="${owner}"]`
      );
    } catch (_) {
      return out;
    }
    for (const r of roots) {
      for (const el of r.querySelectorAll("[data-card-id]")) {
        const img = el.querySelector("img[alt]");
        if (!img) continue;
        // Face-down cards say nothing about the deck.
        if (/hidden card|card back|rune back/i.test(img.alt || "")) continue;
        // Tokens are served from a different path, so they have no card code
        // and drop out here - which is right: they were never in the deck.
        const code = codeFromSrc(img.currentSrc || img.src);
        if (code) out.push(code);
      }
    }
    return out;
  }

  /** Fold whatever is on the board right now into this match's card set. */
  function collect(board, matchId) {
    if (!matchId || !board) return;
    const seq = board.dataset.authoritativeSequence || null;
    if (seq !== null && seq === lastSeq) return; // nothing authoritative changed
    lastSeq = seq;

    if (held.id !== matchId) held = { id: matchId, codes: new Set() };
    for (const zone of DECK_ZONES) {
      for (const code of zoneCards("self", zone)) {
        if (held.codes.has(code)) continue;
        held.codes.add(code);
        dirty = true;
      }
    }
  }

  function persist(force) {
    if (!dirty || !held.id) return;
    if (!force && Date.now() - savedAt < CARDS_SAVE_MS) return;
    savedAt = Date.now();
    dirty = false;
    try {
      chrome.storage.local.set({
        ["deckcards_" + held.id]: { id: held.id, codes: [...held.codes] },
      });
    } catch (err) {
      root.RATPageUI.reportStorageFailure("deck cards not saved", err);
    }
  }

  /** Adopt the set already stored for a record we are resuming mid-game. */
  function resume(matchId, codes) {
    held = { id: matchId, codes: new Set(codes) };
  }

  /* The dashboard deleted the match we were accumulating for. Dropped rather
   * than left alone, or the next flush would rewrite the deckcards_<id> key the
   * delete just took away. */
  function forget() {
    held = { id: null, codes: new Set() };
    dirty = false;
  }

  root.RATDeckCards = {
    collect,
    persist,
    resume,
    forget,
    codeFromSrc,
    zoneCards,
    DECK_ZONES,
    CARDS_SAVE_MS,
    // Tests assert on what was accumulated; nothing in the extension reads it.
    codes: () => [...held.codes],
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATDeckCards;
}
