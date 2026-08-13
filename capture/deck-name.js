/* Rift Atlas Stats Tracker - which deck was this match played with?
 *
 * Nothing on the board says. The picker that named the deck unmounts the
 * instant the game is dealt, the lobby list goes with it, and what is left is a
 * legend card whose title names a CHAMPION, not a deck - so two decks built on
 * the same champion look identical from there ("Diana Aggro" vs "Diana
 * Control").
 *
 * The name is therefore reconstructed from whatever is still standing, best
 * evidence first, and the answer carries where it came from: `deckSource` is
 * rendered by the dashboard, because "we watched you pick this" and "we
 * guessed" are not the same claim, and only the player can settle the
 * difference.
 *
 * Being wrong costs more than saying nothing. A match filed under a deck it was
 * not played with skews two win rates at once - the deck it was credited to and
 * the deck it really was - and neither is ever noticed. That asymmetry is the
 * rule the module turns on, and `reviseDeckAtEnd` is where it is spelled out:
 * only an explicit contradiction clears a name, never the mere absence of
 * evidence.
 *
 * Nothing in here reads the DOM or the clock. content.js sweeps the page for
 * name/legend pairs, reads the picker and the URL, and hands them over as plain
 * data along with the current time; every decision made from them is here.
 * Nothing in here logs, either - the two notices on the returned verdict are
 * the only diagnosis a mislabelled match ever gets, so the caller prints them.
 */
(function (root) {
  "use strict";

  /* How long a deck seen in the picker stays usable. Long enough to cover a
   * session (pick a deck, play several games), short enough that the deck you
   * browsed last week never labels today's match. content.js ages the lobby
   * format on this same window - it is chosen on the same screen, in the same
   * breath, and cannot change faster than a click either. */
  const DECK_MEMORY_MS = 2 * 60 * 60 * 1000;

  /* "Diana, Scorn of the Moon" -> "diana". The picker names the champion the
   * deck is built around; the board exposes legend and champion CARDS, whose
   * titles differ ("Diana, Scorn of the Moon" vs "Diana, Aspect of the Moon").
   * Comparing the character alone is what makes the check work across both. */
  const championKey = (s) =>
    String(s || "").split(",")[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

  /**
   * Does the picked deck agree with the cards on the board?
   *
   * @returns {?boolean} true = agrees, false = contradicted, null = not enough
   *   to tell. The third state is not a convenience: "no evidence either way"
   *   is what keeps a deck name alive when the board has revealed nothing yet,
   *   and folding it into `false` would throw away every name we could not
   *   confirm.
   */
  function deckMatchesBoard(deck, match) {
    const want = championKey(deck && deck.champion);
    if (!want) return null;
    const mine = [championKey(match.myLegend), championKey(match.myChampion)].filter(Boolean);
    if (!mine.length) return null;
    return mine.includes(want);
  }

  /**
   * Pick the deck whose legend matches ours; only guess when unambiguous.
   *
   * @param {?string} myLegend - the legend card on the board, verbatim.
   * @param {Array<{name, legend}>} candidates - name/legend pairs read off the
   *   page, plus any remembered from the pre-game screens.
   * @returns {?string} null when nothing is on screen, and null when several
   *   decks are and none can be tied to this game - the caller tells those two
   *   apart by whether it handed any candidates in.
   */
  function resolveDeckName(myLegend, candidates) {
    const cands = candidates || [];
    if (!cands.length) return null;
    if (myLegend) {
      const hit = cands.find((c) => c.legend === myLegend);
      if (hit) return hit.name;
    }
    // Names are what get stored, so names are what have to be unambiguous: the
    // same deck listed twice under two legends is still one answer.
    const names = [...new Set(cands.map((c) => c.name))];
    if (names.length === 1) return names[0];
    return null;
  }

  const verdict = (name, source, notices) => ({
    name,
    source,
    // The picker named a deck the board contradicts, and nothing else could be
    // read - so the match goes unlabelled rather than mislabelled.
    pickerContradicted: !!(notices && notices.pickerContradicted),
    // Several decks were on screen and none of them is tied to this game.
    ambiguous: !!(notices && notices.ambiguous),
  });

  /**
   * Decide which deck a match was played with, best source first.
   *
   * The champion check is a guard, not a proof: it rules the picked deck OUT
   * when the board shows a different champion, but it cannot tell two decks on
   * the same champion apart. The picker is still the best evidence there is -
   * it names the deck the player last had open - which is why an override
   * always stays one keystroke away.
   *
   * @param {{myLegend, myChampion}} match
   * @param {{activeDeck: ?{name, champion, at}, candidates: Array, urlName: ?string}} sources
   * @param {number} now - epoch ms, for ageing out `activeDeck`.
   * @returns {{name: ?string, source: ?string, pickerContradicted, ambiguous}}
   *   `source` is one of "picker" | "board" | "picker-unverified" | "url", and
   *   is null exactly when nothing could be named at all. It, not `name`, is
   *   what the caller tests: `name` is passed through verbatim from whatever
   *   named it, so gating on it would quietly re-decide the empty-name edge
   *   that every one of the readers already guards against.
   */
  function pickDeckName(match, sources, now) {
    const { activeDeck, candidates, urlName } = sources || {};
    const usable = !!activeDeck && now - (activeDeck.at || 0) < DECK_MEMORY_MS;
    const agrees = usable ? deckMatchesBoard(activeDeck, match) : null;
    if (usable && agrees === true) return verdict(activeDeck.name, "picker");

    const cands = candidates || [];
    const fromBoard = resolveDeckName(match.myLegend, cands);
    /* We got as far as naming it from the page and could not. Carried on every
     * verdict below rather than only the empty one, because the deck we fall
     * back to may still be the wrong one and this is the only hint of it. */
    const ambiguous = !fromBoard && cands.length > 0;

    if (fromBoard) return verdict(fromBoard, "board", { ambiguous });
    if (usable && agrees === null) {
      // Couldn't check either way (no champion text, or the board hasn't
      // revealed our cards yet) - the picker is still the best thing we have.
      return verdict(activeDeck.name, "picker-unverified", { ambiguous });
    }
    const notices = { pickerContradicted: agrees === false, ambiguous };
    return urlName
      ? verdict(urlName, "url", notices)
      : verdict(null, null, notices);
  }

  /**
   * The deck name, revisited now the match is over.
   *
   * A game can begin before the picker was ever seen (a room link opened
   * straight into a match, or a tab loaded mid-game), and by now the board has
   * long since revealed our legend - so a name we could not check at the start
   * can be improved, or contradicted, here.
   *
   * @returns {{verdict: "keep"|"revise"|"clear", name, source, pickerContradicted, ambiguous}}
   *   `name` and `source` are what the record should carry either way; the
   *   verdict says whether that is a change, and which of the two is happening.
   */
  function reviseDeckAtEnd(match, sources, now) {
    const held = match.deckSource;
    const keep = { verdict: "keep", name: match.deckName, source: held };
    // Names we already trust, and anything hand-typed, are left alone: they
    // were read closer to the moment the deck was actually chosen than
    // anything visible now.
    if (held === "manual" || held === "picker" || held === "board") {
      return Object.assign(keep, { pickerContradicted: false, ambiguous: false });
    }

    const late = pickDeckName(match, sources, now);
    const notices = { pickerContradicted: late.pickerContradicted, ambiguous: late.ambiguous };
    if (late.source && (late.name !== match.deckName || late.source !== held)) {
      return Object.assign({ verdict: "revise", name: late.name, source: late.source }, notices);
    }
    /* THE RULE: only an explicit contradiction clears a deck name, never the
     * absence of evidence. Reaching here having found nothing is the ordinary
     * case - the picker is gone, the page is bare - and treating that silence
     * as a correction would throw away the reading taken at the start of the
     * game, when the picker was still on screen and right.
     *
     * A board that shows a different champion is not silence. A guess we now
     * know is wrong is worse than no label at all: it silently skews that
     * deck's stats, and only the unverified guess is ever this cheap to drop.
     *
     * Note the ageing: the contradiction is read straight off `activeDeck`,
     * with no `usable` check. A picker memory too stale to NAME a deck is
     * still good enough to disown one. */
    const picked = sources && sources.activeDeck;
    if (held === "picker-unverified" && deckMatchesBoard(picked, match) === false) {
      return Object.assign({ verdict: "clear", name: "", source: null }, notices);
    }
    return Object.assign(keep, notices);
  }

  root.RATDeckName = {
    championKey,
    deckMatchesBoard,
    resolveDeckName,
    pickDeckName,
    reviseDeckAtEnd,
    DECK_MEMORY_MS,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATDeckName;
}
