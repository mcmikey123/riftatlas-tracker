/* Rift Atlas Stats Tracker - everything the page can tell us about the deck.
 *
 * capture/deck-name.js decides WHICH deck a match was played with; this is what
 * hands it the evidence. Four readers, none of which can be taken at the moment
 * the answer is wanted:
 *
 *   - the deck picker's header, which unmounts the instant the board mounts, so
 *     what it said is remembered (capture/sticky-memory.js) and mirrored into
 *     storage against a reload or a game opened in a fresh tab;
 *   - a sweep for name/legend pairs anywhere on the page, which is how a deck is
 *     still identified when the picker was never seen;
 *   - the same sweep run over the pre-game screens, whose deck names vanish once
 *     the board is dealt, kept until a match starts;
 *   - the URL, for a room link that names the list.
 *
 * `sources()` takes all of them in one go and hands over plain data. The
 * decision made from it is not here, and neither is the record it lands on.
 */
(function (root) {
  "use strict";

  // Deck picker (site pages, not the board): the tab strip we walk up from.
  const DECK_TAB = "#deck-list-tab";
  const MAX_DECK_NAME = 60; // longer than this and it isn't a deck name
  const MAX_PENDING = 12; // pre-game sightings kept while we wait for a board
  /* How far above the tab strip the heading that names the deck may sit.
   * Level 0 is the strip's own parent - today's toolbar, the heading itself on
   * the markup before it - so two levels covers today's lobby and the third is
   * slack for another wrapper appearing between them. Bounded, because every
   * level up widens the scope towards the whole page, where "the deck nearest
   * the tab strip" stops meaning anything. */
  const PICKER_LEVELS = 3;

  const cleanText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  // Rift Atlas writes a deck as a pair of sibling <p> elements:
  //   <p>latest</p><p>Diana, Scorn of the Moon</p>
  // i.e. the name you gave the deck, followed by its legend. That one shape is
  // how every deck on the site is read - the one open in the picker and the
  // ones merely listed alike - so the pairing rule lives in one place.
  // "Diana, Scorn of the Moon" / "Rek'Sai, Breacher" / "Nunu & Willump, Boy
  // and His Yeti" / "Yasuo, the Unforgiven" - both halves start with a capital
  // (or the article "the") and contain no digits or sentence punctuation,
  // which keeps log lines like "Rolled 16, monke rolled 4." from being
  // mistaken for a legend, and prose like "Bob, and then he left" with them.
  // The "&" and the article are not decoration: a legend this rejects is a
  // deck the module cannot name at all, and the caller's last resort is the
  // deck you played last - a wrong label, not a missing one.
  const LEGEND_RE = /^\p{Lu}[\p{L}'’.&\- ]{1,28},\s+(?:the\s+)?\p{Lu}[\p{L}'’&\- ]{1,38}$/u;

  /**
   * The decks named inside `scope`, in document order, each listed once.
   *
   * `pairs` counts every adjacent <p><p> seen, legible or not, and `decks` is
   * the subset that reads as a deck. The difference matters to the walk below:
   * an element holding a pair we cannot read is still the element that names
   * the deck, and must not be walked past as though it said nothing.
   */
  function pairsIn(scope) {
    const decks = [];
    const seen = new Set();
    let pairs = 0;
    let ps;
    try {
      ps = scope.querySelectorAll("p");
    } catch (_) {
      return { pairs, decks };
    }
    for (const p of ps) {
      const next = p.nextElementSibling;
      if (!next || next.tagName !== "P") continue;
      pairs++;
      const name = cleanText(p);
      const legend = cleanText(next);
      if (!name || name.length > MAX_DECK_NAME) continue;
      if (!LEGEND_RE.test(legend)) continue;
      const key = name + "|" + legend;
      if (seen.has(key)) continue;
      seen.add(key);
      decks.push({ name, legend });
    }
    return { pairs, decks };
  }

  /* The heading that names the chosen deck sits above the deck/tab strip, with
   * the strip nested a level or two under it:
   *   <div>                                      <- heading
   *     <div>…<p>Bandle Bomb</p>                         <- the deck's name
   *            <p>Diana, Scorn of the Moon</p>…</div>    <- its champion
   *     <div>…<div role="tablist"><button id="deck-list-tab">…  <- anchor
   * The tab id is the only stable hook on it - class names change every deploy
   * - so the heading is found by walking up from there. How MANY levels up is
   * not fixed, because the site has moved the strip before: it was a direct
   * child of the heading, and a toolbar now sits in between.
   */

  /**
   * The deck currently open in the picker, or null if it isn't on screen.
   *
   * The walk stops at the first ancestor that names anything at all, and that
   * ancestor is the heading: one deck there is the strip's own, and anything
   * else - several decks (the library), or a pair too garbled to read - names
   * nothing. It stops on the garbled pair rather than climbing past it because
   * the level above is a wider slice of the page, where a single unrelated
   * deck (a "recently played" card, a one-entry list) would be picked up and
   * returned as yours. That is the mislabelling this module exists to avoid,
   * and it is worse than the silence.
   *
   * This is the whole value of the read - the sweep below sees every deck on
   * the page, and only the tab strip says which of them is the one you picked.
   */
  function readDeckPicker() {
    let at = document.querySelector(DECK_TAB)?.closest('[role="tablist"]')?.parentElement;
    for (let up = 0; at && up < PICKER_LEVELS; up++, at = at.parentElement) {
      const { pairs, decks } = pairsIn(at);
      if (!pairs) continue; // nothing named here at all: the heading is higher
      if (decks.length !== 1) return null;
      return { name: decks[0].name, champion: decks[0].legend };
    }
    return null;
  }

  // Fallback for games we never saw the picker for: every deck the page names,
  // wherever it names them. Matching a candidate's legend against the one we
  // independently read off the board is what makes this safe when several
  // decks are listed on screen.
  const deckCandidates = () => pairsIn(document).decks;

  function detectDeckName() {
    try {
      const u = new URLSearchParams(location.search);
      for (const k of ["deck", "deckName", "deckId", "list"]) {
        const v = u.get(k);
        if (v && v.length <= MAX_DECK_NAME) return v;
      }
      const el = document.querySelector("[data-deck-name]");
      if (el) return el.getAttribute("data-deck-name");
    } catch (_) {}
    return null;
  }

  /* Last deck seen in the picker, with the last time we saw it. Mirrored into
   * its own storage key because the picker unmounts the moment the board
   * mounts, and because the game may be opened in a fresh tab (or the page
   * reloaded) between choosing a deck and playing it. Its own key rather than
   * a field on `settings`, so a write here can't clobber a settings write
   * happening in the dashboard at the same moment. */
  let picked = null;

  // Built on first use, not at load: reading RATSticky here would make the
  // manifest's order among the capture modules load-bearing, where today it
  // only has to put all of them before content.js.
  function memory() {
    if (!picked) {
      picked = root.RATSticky.createStickyMemory({
        key: "activeDeck",
        read: readDeckPicker,
        same: (held, found) => held.name === found.name && held.champion === found.champion,
        isStored: (stored) => !!stored.name,
        onChange: (deck) =>
          console.info(
            "[RA-Tracker] deck picker:",
            deck.name,
            deck.champion ? "(" + deck.champion + ")" : ""
          ),
      });
    }
    return picked;
  }

  // Deck name/legend pairs spotted on the lobby & deck-select screens, kept
  // so the deck can still be identified once the board reveals our legend.
  let pending = [];

  /** Deck names shown on the setup screens vanish once the board is dealt. */
  function rememberPregame() {
    for (const c of deckCandidates()) {
      if (!pending.some((x) => x.name === c.name && x.legend === c.legend)) {
        pending.push(c);
        if (pending.length > MAX_PENDING) pending.shift();
      }
    }
  }

  /* Everything capture/deck-name.js needs to name the deck, gathered in one
   * read. The sweep and the URL are cheap enough to take every time rather
   * than only on the paths that end up using them, and taking them together
   * means the decision sees one consistent picture of the page. */
  const sources = () => ({
    activeDeck: memory().get(),
    candidates: deckCandidates().concat(pending),
    urlName: detectDeckName(),
  });

  /* The two notices a deck verdict can carry. capture/deck-name.js does not
   * log, and these are the only trace left when a match ends up under the
   * wrong deck - or under none - so they are printed where the verdict is
   * used. The ambiguity warning fires once a session: the sweep that raises it
   * runs at the start and end of every match, and the page it is complaining
   * about does not change in between. */
  let severalDecksWarned = false;

  function noteVerdict(pick, match, from) {
    if (pick.ambiguous && !severalDecksWarned) {
      severalDecksWarned = true;
      console.info(
        "[RA-Tracker] several decks on screen, can't tell which is active:",
        from.candidates
      );
    }
    if (pick.pickerContradicted) {
      console.info(
        "[RA-Tracker] ignoring picked deck “%s” (%s): board shows %s",
        from.activeDeck.name,
        from.activeDeck.champion,
        match.myLegend || match.myChampion || "nothing yet"
      );
    }
  }

  /** New matches fall back to this when nothing can be detected. */
  function rememberLast(name) {
    try {
      chrome.storage.local.get({ settings: {} }, (d) => {
        const s = Object.assign({}, d && d.settings, { lastDeck: name });
        chrome.storage.local.set({ settings: s });
      });
    } catch (_) {}
  }

  /** The deck used last, for a match nothing else could name. */
  function lastUsed(cb) {
    try {
      chrome.storage.local.get({ settings: {} }, (d) => {
        cb((d && d.settings && d.settings.lastDeck) || null);
      });
    } catch (_) {}
  }

  root.RATDeckScan = {
    watch: () => memory().watch(),
    load: () => memory().load(),
    rememberPregame,
    clearPending: () => {
      pending = [];
    },
    sources,
    noteVerdict,
    rememberLast,
    lastUsed,
    // Reached by tests; the extension itself only ever goes through `sources`.
    readDeckPicker,
    deckCandidates,
    detectDeckName,
    MAX_DECK_NAME,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATDeckScan;
}
