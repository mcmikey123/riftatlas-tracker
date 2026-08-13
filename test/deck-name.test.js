"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  championKey,
  deckMatchesBoard,
  resolveDeckName,
  pickDeckName,
  reviseDeckAtEnd,
  DECK_MEMORY_MS,
} = require("../capture/deck-name.js");

/* Which deck a match was played with is never stated on the board, so it is
 * reconstructed from four competing sources and labelled with where it came
 * from. Every mistake here is silent and permanent: a match filed under the
 * wrong deck skews the win rate of that deck AND of the one it really was.
 *
 * `sources` is what content.js scrapes off the page and hands over; `now` is
 * the clock it would otherwise have read inside. */

const NOW = 1700000000000;
// The picker names the deck's champion; the board shows legend/champion CARDS,
// whose titles differ for the same character. Both spellings appear below.
const PICKED_CHAMPION = "Diana, Scorn of the Moon";
const BOARD_LEGEND = "Diana, Aspect of the Moon";
const OTHER_LEGEND = "Yasuo, the Unforgiven";

const picker = (over) =>
  Object.assign({ name: "Bandle Bomb", champion: PICKED_CHAMPION, at: NOW }, over);
const board = (over) => Object.assign({ myLegend: null, myChampion: null }, over);
const sources = (over) =>
  Object.assign({ activeDeck: null, candidates: [], urlName: null }, over);

test("1. the champion is compared by character, not by card title", () => {
  // The whole cross-source check rests on this: "Diana, Scorn of the Moon" (the
  // picker's wording) and "Diana, Aspect of the Moon" (the board's) are the
  // same character and must key alike.
  assert.equal(championKey(PICKED_CHAMPION), championKey(BOARD_LEGEND));
  assert.equal(championKey(PICKED_CHAMPION), "diana");
  // Punctuation and case are noise; a name typed with an apostrophe or a
  // curly quote is the same champion either way.
  assert.equal(championKey("Rek'Sai, Breacher"), championKey("REK’SAI, Void Burrower"));
  assert.equal(championKey(null), "");
  assert.equal(championKey(""), "");
});

/* The tri-state is load-bearing. "No evidence either way" is what keeps a deck
 * name alive while the board has revealed nothing, and folding it into `false`
 * would drop every name that could not be confirmed. */
test("2. deckMatchesBoard says agrees / contradicted / cannot tell", () => {
  const deck = { champion: PICKED_CHAMPION };
  assert.equal(deckMatchesBoard(deck, board({ myLegend: BOARD_LEGEND })), true);
  assert.equal(deckMatchesBoard(deck, board({ myLegend: OTHER_LEGEND })), false);
  // Nothing on our side of the board yet - the cards are dealt face down for
  // the first few frames of every game.
  assert.equal(deckMatchesBoard(deck, board()), null);
  // The picker gave a name but no champion, so there is nothing to compare.
  assert.equal(deckMatchesBoard({ champion: null }, board({ myLegend: BOARD_LEGEND })), null);
  assert.equal(deckMatchesBoard(null, board({ myLegend: BOARD_LEGEND })), null);
});

test("3. either card on our side of the board can confirm the deck", () => {
  const deck = { champion: PICKED_CHAMPION };
  // The champion card is often revealed before the legend, and vice versa.
  assert.equal(deckMatchesBoard(deck, board({ myChampion: BOARD_LEGEND })), true);
  assert.equal(
    deckMatchesBoard(deck, board({ myLegend: OTHER_LEGEND, myChampion: BOARD_LEGEND })),
    true
  );
  assert.equal(
    deckMatchesBoard(deck, board({ myLegend: OTHER_LEGEND, myChampion: OTHER_LEGEND })),
    false
  );
});

test("4. a candidate whose legend matches ours is the deck, however many are listed", () => {
  const cands = [
    { name: "Yasuo Tempo", legend: OTHER_LEGEND },
    { name: "Bandle Bomb", legend: BOARD_LEGEND },
  ];
  assert.equal(resolveDeckName(BOARD_LEGEND, cands), "Bandle Bomb");
  // Verbatim match, because this is the same string read off the same card -
  // the champion-key softening is only for comparing across sources.
  assert.equal(resolveDeckName("diana, aspect of the moon", cands), null);
});

test("5. one deck on screen is the answer even without a legend to check", () => {
  // The common case: the deck-select screen showing the one deck we picked.
  assert.equal(resolveDeckName(null, [{ name: "Bandle Bomb", legend: BOARD_LEGEND }]), "Bandle Bomb");
  // The same deck listed twice under two legends is still one answer, because
  // the name is what gets stored.
  assert.equal(
    resolveDeckName(null, [
      { name: "Bandle Bomb", legend: BOARD_LEGEND },
      { name: "Bandle Bomb", legend: OTHER_LEGEND },
    ]),
    "Bandle Bomb"
  );
});

test("6. several decks and nothing to tie them to this game is not a guess", () => {
  const cands = [
    { name: "Bandle Bomb", legend: BOARD_LEGEND },
    { name: "Yasuo Tempo", legend: OTHER_LEGEND },
  ];
  assert.equal(resolveDeckName(null, cands), null);
  // A legend that matches none of them says nothing either.
  assert.equal(resolveDeckName("Ahri, Nine-Tailed", cands), null);
  // Nothing on screen at all - a bare board, which is most of a match.
  assert.equal(resolveDeckName(BOARD_LEGEND, []), null);
  assert.equal(resolveDeckName(BOARD_LEGEND, undefined), null);
});

/* Tests 7-11 walk the four sources in order. `source` travels with the name
 * because the dashboard draws a watched pick differently from a guess. */

test("7. a picked deck the board confirms outranks everything else", () => {
  const pick = pickDeckName(
    board({ myLegend: BOARD_LEGEND }),
    sources({
      activeDeck: picker(),
      candidates: [{ name: "Yasuo Tempo", legend: OTHER_LEGEND }],
      urlName: "FromTheUrl",
    }),
    NOW
  );
  assert.deepEqual(pick, {
    name: "Bandle Bomb",
    source: "picker",
    pickerContradicted: false,
    ambiguous: false,
  });
});

test("8. the page beats a picked deck that could not be confirmed", () => {
  /* The picker is remembered but the board has revealed nothing, so it cannot
   * be checked - and a name read off the page right now, matched to our own
   * legend, is better evidence than a memory. */
  const pick = pickDeckName(
    board(),
    sources({
      activeDeck: picker(),
      candidates: [{ name: "Read Off Screen", legend: BOARD_LEGEND }],
      urlName: "FromTheUrl",
    }),
    NOW
  );
  assert.equal(pick.name, "Read Off Screen");
  assert.equal(pick.source, "board");
});

test("9. an unconfirmable picked deck is still the best thing available", () => {
  // Nothing to check it against and nothing on the page: the player did pick
  // this deck a moment ago, so it is reported - flagged as unverified, which
  // is the one source the end-of-match pass is allowed to take back.
  const pick = pickDeckName(board(), sources({ activeDeck: picker(), urlName: "FromTheUrl" }), NOW);
  assert.equal(pick.name, "Bandle Bomb");
  assert.equal(pick.source, "picker-unverified");
  assert.equal(pick.pickerContradicted, false);
});

test("10. the URL is the last resort, and no source at all is null", () => {
  const fromUrl = pickDeckName(board(), sources({ urlName: "FromTheUrl" }), NOW);
  assert.equal(fromUrl.name, "FromTheUrl");
  assert.equal(fromUrl.source, "url");

  const nothing = pickDeckName(board({ myLegend: BOARD_LEGEND }), sources(), NOW);
  // `source` is null exactly when `name` is: a source with no name would be
  // rendered by the dashboard as a claim about a deck called "".
  assert.deepEqual(nothing, {
    name: null,
    source: null,
    pickerContradicted: false,
    ambiguous: false,
  });
});

test("11. a picked deck the board contradicts is refused, and says so", () => {
  /* The guard that stops yesterday's deck labelling today's game. It only ever
   * rules a deck OUT - it cannot tell "Diana Aggro" from "Diana Control" - and
   * the notice is the only trace of the refusal, so it rides on the verdict for
   * the caller to log. */
  const pick = pickDeckName(
    board({ myLegend: OTHER_LEGEND }),
    sources({ activeDeck: picker(), urlName: "FromTheUrl" }),
    NOW
  );
  assert.deepEqual(pick, {
    name: "FromTheUrl",
    source: "url",
    pickerContradicted: true,
    ambiguous: false,
  });
});

test("12. a deck picked too long ago is not consulted at all", () => {
  const stale = sources({ activeDeck: picker({ at: NOW - DECK_MEMORY_MS }) });
  const confirmable = board({ myLegend: BOARD_LEGEND });
  // Even though the board would confirm it, the memory has expired: the deck
  // you browsed last week must never label today's match.
  assert.equal(pickDeckName(confirmable, stale, NOW).name, null);
  assert.equal(pickDeckName(confirmable, sources({ activeDeck: picker({ at: NOW - DECK_MEMORY_MS + 1 }) }), NOW).source, "picker");
  // A picker entry from before the stamp existed reads as epoch zero, i.e.
  // long expired, rather than as fresh.
  assert.equal(pickDeckName(confirmable, sources({ activeDeck: picker({ at: undefined }) }), NOW).name, null);
});

test("13. an unreadable screen is reported whichever source ends up winning", () => {
  const crowded = [
    { name: "Bandle Bomb", legend: BOARD_LEGEND },
    { name: "Yasuo Tempo", legend: OTHER_LEGEND },
  ];
  // The fallback may well be the wrong deck, and this notice is the only hint
  // of why - so it survives onto the verdict rather than being dropped once a
  // name is found elsewhere.
  const unverified = pickDeckName(board(), sources({ activeDeck: picker(), candidates: crowded }), NOW);
  assert.equal(unverified.source, "picker-unverified");
  assert.equal(unverified.ambiguous, true);

  const url = pickDeckName(board({ myLegend: "Ahri, Nine-Tailed" }), sources({ candidates: crowded, urlName: "FromTheUrl" }), NOW);
  assert.equal(url.ambiguous, true);
  // A picked deck the board confirmed never reaches the page sweep, so there
  // is nothing to complain about.
  assert.equal(
    pickDeckName(board({ myLegend: BOARD_LEGEND }), sources({ activeDeck: picker(), candidates: crowded }), NOW).ambiguous,
    false
  );
});

/* Tests 14-18: the end-of-match pass. The board has revealed our legend by now,
 * so a name taken on trust at the start can finally be checked. */

test("14. a name we already trust is never revisited", () => {
  const better = sources({ candidates: [{ name: "Read Off Screen", legend: BOARD_LEGEND }] });
  for (const source of ["manual", "picker", "board"]) {
    const m = { deckName: "Bandle Bomb", deckSource: source, myLegend: BOARD_LEGEND };
    assert.deepEqual(
      reviseDeckAtEnd(m, better, NOW),
      { verdict: "keep", name: "Bandle Bomb", source, pickerContradicted: false, ambiguous: false },
      source
    );
  }
});

test("15. a guess is upgraded once the board can name the deck", () => {
  // "last" is the weakest label there is - it only means "the deck you used
  // previously" - so a real reading at the end of the game replaces it.
  const m = { deckName: "Yesterday's Deck", deckSource: "last", myLegend: BOARD_LEGEND };
  assert.deepEqual(reviseDeckAtEnd(m, sources({ candidates: [{ name: "Bandle Bomb", legend: BOARD_LEGEND }] }), NOW), {
    verdict: "revise",
    name: "Bandle Bomb",
    source: "board",
    pickerContradicted: false,
    ambiguous: false,
  });
  // Same name, same source - nothing happened, and the caller must not log a
  // revision or re-stamp "last deck used" for it.
  const same = { deckName: "FromTheUrl", deckSource: "url", myLegend: BOARD_LEGEND };
  assert.equal(reviseDeckAtEnd(same, sources({ urlName: "FromTheUrl" }), NOW).verdict, "keep");
});

test("16. only an explicit contradiction clears a name, never the absence of evidence", () => {
  /* THE RULE, and the reason this file exists. The unverified reading was taken
   * when the picker was still on screen, which is the closest anyone ever gets
   * to watching the player choose. At the end of the game the picker is long
   * gone and the page is bare, so finding nothing is the ORDINARY case - and
   * treating that silence as a correction would throw the reading away every
   * single match. */
  const unverified = { deckName: "Bandle Bomb", deckSource: "picker-unverified" };
  const kept = reviseDeckAtEnd(
    Object.assign({}, unverified, board()), // board still shows us nothing
    sources({ activeDeck: picker() }),
    NOW
  );
  assert.deepEqual(kept, {
    verdict: "keep",
    name: "Bandle Bomb",
    source: "picker-unverified",
    pickerContradicted: false,
    ambiguous: false,
  });

  // A board showing a different champion IS a contradiction. A guess we now
  // know is wrong is worse than no label: it silently skews that deck's stats.
  const cleared = reviseDeckAtEnd(
    Object.assign({}, unverified, board({ myLegend: OTHER_LEGEND })),
    sources({ activeDeck: picker() }),
    NOW
  );
  assert.equal(cleared.verdict, "clear");
  assert.equal(cleared.name, "");
  assert.equal(cleared.source, null);
  assert.equal(cleared.pickerContradicted, true);
});

test("17. the unverified pick is the only name cheap enough to drop", () => {
  /* Every other source was either read off this game's own page or typed by a
   * human. The picker memory contradicting one of them is not evidence about
   * this match - it is evidence that the memory is about a different match. */
  for (const source of ["last", "url", null]) {
    const m = { deckName: "Bandle Bomb", deckSource: source, myLegend: OTHER_LEGEND };
    const out = reviseDeckAtEnd(m, sources({ activeDeck: picker() }), NOW);
    assert.equal(out.verdict, "keep", String(source));
    assert.equal(out.name, "Bandle Bomb", String(source));
  }
});

test("18. a picker memory too stale to name a deck can still disown one", () => {
  /* Deliberate asymmetry, and the one place the memory window is not consulted:
   * ageing out means "this is no longer evidence of what you played", but the
   * champion mismatch it reveals is evidence about the name already on the
   * record - which was written from that same memory. */
  const m = { deckName: "Bandle Bomb", deckSource: "picker-unverified", myLegend: OTHER_LEGEND };
  const out = reviseDeckAtEnd(m, sources({ activeDeck: picker({ at: NOW - DECK_MEMORY_MS - 1 }) }), NOW);
  assert.equal(out.verdict, "clear");
  // No notice: the stale picker was never consulted for a name, so nothing was
  // refused and there is nothing for the caller to report.
  assert.equal(out.pickerContradicted, false);
});
