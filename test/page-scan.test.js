"use strict";

/* The three readers that work on the site's own pages rather than on the board:
 * the card accumulator (capture/deck-cards.js), the deck picker and the deck
 * sweep (capture/deck-scan.js), and the lobby format (capture/match-format.js).
 *
 * All of them moved out of content.js, where nothing could reach them. The
 * accumulator is the one with real state - a set keyed by match id, gated on
 * the site's authoritative sequence counter and flushed on a throttle - and it
 * is the one whose failures are quietest: a deck fingerprinted from a set that
 * silently stopped growing is not obviously wrong, it is just a different deck.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { el } = require("./fake-dom.js");

const writes = [];
const disk = {};
globalThis.chrome = {
  storage: {
    local: {
      set(obj) {
        writes.push(JSON.parse(JSON.stringify(obj)));
        Object.assign(disk, obj);
      },
      get(defaults, cb) {
        const out = {};
        for (const key of Object.keys(defaults)) out[key] = key in disk ? disk[key] : defaults[key];
        cb(out);
      },
    },
  },
};
globalThis.RATPageUI = { reportStorageFailure() {} };
globalThis.location = { search: "" };

require("../capture/sticky-memory.js");
require("../capture/deck-name.js");
const deckCards = require("../capture/deck-cards.js");
const deckScan = require("../capture/deck-scan.js");
const matchFormat = require("../capture/match-format.js");

const onPage = (page, fn) => {
  globalThis.document = page;
  try {
    return fn();
  } finally {
    globalThis.document = undefined;
  }
};

/** Runs `fn` with the wall clock frozen at `at`. */
function at(when, fn) {
  const real = Date.now;
  Date.now = () => when;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

// ---------- the card accumulator ----------

const CARD = (code) => "https://cdn.example/cards/set/" + code + ".webp";

const card = (alt, src) =>
  el({ sel: ["[data-card-id]"], kids: [el({ tag: "img", alt, currentSrc: src, sel: ["img[alt]"] })] });

/** A board holding `cards` in one zone, plus the sequence counter. */
function boardWith(zone, cards, sequence) {
  const zoneRoot = el({
    sel: [`[data-drop-zone-root="${zone}"][data-zone-owner="self"]`],
    kids: cards,
  });
  const root = el({ dataset: { authoritativeSequence: sequence }, kids: [zoneRoot] });
  return { page: el({ kids: [root] }), root };
}

test("a card code is read out of its art URL, and only out of a card's", () => {
  assert.equal(deckCards.codeFromSrc(CARD("UNL-199")), "UNL-199");
  assert.equal(deckCards.codeFromSrc("https://cdn.example/cards/set/OGN-042.webp?v=2"), "OGN-042");
  // Tokens are served from a different path, so they have no code - which is
  // right: they were never in the deck.
  assert.equal(deckCards.codeFromSrc("https://cdn.example/tokens/x/UNL-199.webp"), null);
  assert.equal(deckCards.codeFromSrc("https://cdn.example/cards/set/UNL-199.png"), null);
  assert.equal(deckCards.codeFromSrc(""), null);
  assert.equal(deckCards.codeFromSrc(null), null);
});

test("only your own face-up cards are harvested", () => {
  const { page } = boardWith("hand", [
    card("Yordle Trap", CARD("UNL-1")),
    card("Hidden card", CARD("UNL-2")),
    card("Rune back", CARD("UNL-3")),
    el({ sel: ["[data-card-id]"] }), // a slot with no img at all
  ]);
  onPage(page, () => assert.deepEqual(deckCards.zoneCards("self", "hand"), ["UNL-1"]));
  onPage(page, () => assert.deepEqual(deckCards.zoneCards("opponent", "hand"), []));
  onPage(el({}), () => assert.deepEqual(deckCards.zoneCards("self", "hand"), []));
});

test("the set grows across zones and never repeats a code", () => {
  deckCards.forget();
  const zones = deckCards.DECK_ZONES.slice(0, 2);
  const page = el({
    kids: [
      el({
        dataset: { authoritativeSequence: "1" },
        kids: zones.map((zone, i) =>
          el({
            sel: [`[data-drop-zone-root="${zone}"][data-zone-owner="self"]`],
            kids: [card("A", CARD("UNL-" + i)), card("B", CARD("SHARED-9"))],
          })
        ),
      }),
    ],
  });
  const root = page.children[0];
  onPage(page, () => {
    deckCards.collect(root, "m1");
    assert.deepEqual(deckCards.codes().sort(), ["SHARED-9", "UNL-0", "UNL-1"]);
  });
});

test("an unchanged authoritative sequence is not rescraped", () => {
  /* The site bumps data-authoritative-sequence on every real game action, and
   * that is the whole trigger: without the gate this runs on every frame of
   * every animation for the length of a match. */
  deckCards.forget();
  const first = boardWith("hand", [card("A", CARD("UNL-1"))], "7");
  onPage(first.page, () => deckCards.collect(first.root, "m1"));
  assert.deepEqual(deckCards.codes(), ["UNL-1"]);

  // Same sequence, different cards on screen: not looked at.
  const stale = boardWith("hand", [card("B", CARD("UNL-2"))], "7");
  onPage(stale.page, () => deckCards.collect(stale.root, "m1"));
  assert.deepEqual(deckCards.codes(), ["UNL-1"]);

  const moved = boardWith("hand", [card("B", CARD("UNL-2"))], "8");
  onPage(moved.page, () => deckCards.collect(moved.root, "m1"));
  assert.deepEqual(deckCards.codes().sort(), ["UNL-1", "UNL-2"]);
});

test("a new match starts a new set", () => {
  deckCards.forget();
  const one = boardWith("hand", [card("A", CARD("UNL-1"))], "1");
  onPage(one.page, () => deckCards.collect(one.root, "m1"));
  const two = boardWith("hand", [card("B", CARD("UNL-2"))], "2");
  onPage(two.page, () => deckCards.collect(two.root, "m2"));

  assert.deepEqual(deckCards.codes(), ["UNL-2"], "the second game does not inherit the first's cards");
});

test("nothing is collected without a board or without a match", () => {
  deckCards.forget();
  const { root } = boardWith("hand", [card("A", CARD("UNL-1"))], "1");
  deckCards.collect(null, "m1");
  deckCards.collect(root, null);
  assert.deepEqual(deckCards.codes(), []);
});

test("the card set is written under its own key, on a throttle", () => {
  deckCards.forget();
  writes.length = 0;
  const first = boardWith("hand", [card("A", CARD("UNL-1"))], "1");
  onPage(first.page, () => deckCards.collect(first.root, "m1"));

  at(1_000_000, () => deckCards.persist(false));
  assert.deepEqual(writes.at(-1), { deckcards_m1: { id: "m1", codes: ["UNL-1"] } });

  // Nothing new revealed: no write, however often it is asked.
  const before = writes.length;
  at(1_000_000 + deckCards.CARDS_SAVE_MS + 1, () => deckCards.persist(false));
  assert.equal(writes.length, before, "a clean set is not rewritten");

  const second = boardWith("hand", [card("B", CARD("UNL-2"))], "2");
  onPage(second.page, () => deckCards.collect(second.root, "m1"));
  at(1_000_000 + 1, () => deckCards.persist(false));
  assert.equal(writes.length, before, "inside the throttle window, a dirty set waits");

  at(1_000_000 + 1, () => deckCards.persist(true));
  assert.deepEqual(writes.at(-1), { deckcards_m1: { id: "m1", codes: ["UNL-1", "UNL-2"] } },
    "the end of a match forces the flush");
});

test("a resumed match adopts its stored set; a deleted one drops it", () => {
  deckCards.forget();
  deckCards.resume("m_old", ["UNL-1", "UNL-2"]);
  assert.deepEqual(deckCards.codes().sort(), ["UNL-1", "UNL-2"]);

  writes.length = 0;
  deckCards.forget();
  assert.deepEqual(deckCards.codes(), []);
  at(2_000_000, () => deckCards.persist(true));
  assert.deepEqual(writes, [], "a dropped set must not rewrite the key the delete took away");
});

// ---------- the deck picker and the deck sweep ----------

const picker = (name, champion) => {
  const header = el({
    kids: [
      el({ kids: [el({ tag: "p", text: name, sel: [":scope > div p"] })] }),
      el({ kids: [el({ tag: "p", text: champion, sel: [":scope > div p"] })] }),
      el({
        sel: ['[role="tablist"]'],
        kids: [el({ tag: "button", sel: ["#deck-list-tab"] })],
      }),
    ],
  });
  return el({ kids: [header] });
};

test("the deck picker names the deck and its champion", () => {
  onPage(picker("Bandle Bomb", "Diana, Scorn of the Moon"), () => {
    assert.deepEqual(deckScan.readDeckPicker(), {
      name: "Bandle Bomb",
      champion: "Diana, Scorn of the Moon",
    });
  });
});

test("the picker is null when it is not on screen, or is saying nothing usable", () => {
  onPage(el({}), () => assert.equal(deckScan.readDeckPicker(), null));
  onPage(picker("", "Diana"), () => assert.equal(deckScan.readDeckPicker(), null));
  onPage(picker("x".repeat(deckScan.MAX_DECK_NAME + 1), "Diana"), () =>
    assert.equal(deckScan.readDeckPicker(), null, "longer than this and it isn't a deck name")
  );
});

const pairs = (...texts) =>
  el({ kids: texts.map((t) => el({ tag: "p", text: t, sel: ["p"] })) });

test("the sweep pairs a deck name with the legend under it", () => {
  onPage(pairs("latest", "Diana, Scorn of the Moon", "aggro", "Rek'Sai, Breacher"), () => {
    assert.deepEqual(deckScan.deckCandidates(), [
      { name: "latest", legend: "Diana, Scorn of the Moon" },
      { name: "aggro", legend: "Rek'Sai, Breacher" },
    ]);
  });
});

test("the sweep ignores prose that is not a legend", () => {
  /* Both halves of a legend start with a capital and contain no digits or
   * sentence punctuation, which is what keeps log lines out - "Rolled 16, monke
   * rolled 4." is shaped exactly like a name and a legend otherwise. */
  onPage(pairs("someone", "Rolled 16, monke rolled 4.", "x".repeat(200), "Diana, Scorn of the Moon"), () => {
    assert.deepEqual(deckScan.deckCandidates(), []);
  });
  onPage(el({}), () => assert.deepEqual(deckScan.deckCandidates(), []));
});

test("the same pair listed twice is one candidate", () => {
  onPage(pairs("latest", "Diana, Scorn of the Moon", "latest", "Diana, Scorn of the Moon"), () => {
    assert.deepEqual(deckScan.deckCandidates(), [
      { name: "latest", legend: "Diana, Scorn of the Moon" },
    ]);
  });
});

test("the URL names a deck, in priority order, and the DOM attribute is the fallback", () => {
  const page = el({ kids: [el({ sel: ["[data-deck-name]"], attrs: { "data-deck-name": "From DOM" } })] });
  onPage(page, () => {
    globalThis.location = { search: "?deck=From+Query&list=Ignored" };
    assert.equal(deckScan.detectDeckName(), "From Query");
    globalThis.location = { search: "?list=Only+This" };
    assert.equal(deckScan.detectDeckName(), "Only This");
    globalThis.location = { search: "?deck=" + "x".repeat(deckScan.MAX_DECK_NAME + 1) };
    assert.equal(deckScan.detectDeckName(), "From DOM", "an absurd query value is not a deck name");
    globalThis.location = { search: "" };
    assert.equal(deckScan.detectDeckName(), "From DOM");
  });
  onPage(el({}), () => assert.equal(deckScan.detectDeckName(), null));
});

test("deck names seen before the board is dealt survive until a match claims them", () => {
  /* The lobby and deck-select screens name the deck; all of it unmounts the
   * moment the board mounts, which is when it is finally needed. */
  deckScan.clearPending();
  onPage(pairs("lobby deck", "Diana, Scorn of the Moon"), () => deckScan.rememberPregame());
  onPage(pairs("lobby deck", "Diana, Scorn of the Moon"), () => deckScan.rememberPregame());
  onPage(el({}), () => {
    assert.deepEqual(deckScan.sources().candidates, [
      { name: "lobby deck", legend: "Diana, Scorn of the Moon" },
    ], "remembered once, and still there when the page has nothing left on it");
  });

  deckScan.clearPending();
  onPage(el({}), () => assert.deepEqual(deckScan.sources().candidates, []));
});

// ---------- the lobby format ----------

const pressed = (label) =>
  el({ kids: [el({ tag: "button", text: label, sel: ['button[aria-pressed="true"]'] })] });

const summary = (title) =>
  el({ kids: [el({ sel: ["[title]"], attrs: { title } })] });

test("the format is read from whichever lobby is on screen", () => {
  onPage(pressed("Best of 3"), () => assert.equal(matchFormat.readMatchFormat(), "bo3"));
  onPage(pressed("Best of 1"), () => assert.equal(matchFormat.readMatchFormat(), "bo1"));
  onPage(summary("1v1 · Constructed · Best of 3 · Standard"), () =>
    assert.equal(matchFormat.readMatchFormat(), "bo3", "the joiner never sees the buttons")
  );
});

test("a format we do not recognise is not invented", () => {
  // Only Bo1 and Bo3 exist; a number we don't know means the read went
  // somewhere unexpected, and null is safer than a format nobody played.
  onPage(pressed("Best of 5"), () => assert.equal(matchFormat.readMatchFormat(), null));
  onPage(pressed("Ranked"), () => assert.equal(matchFormat.readMatchFormat(), null));
  onPage(el({}), () => assert.equal(matchFormat.readMatchFormat(), null));
});

test("the format a match is filed under is the live read, else the remembered one", () => {
  const seen = 5_000_000;
  at(seen, () => onPage(pressed("Best of 3"), () => matchFormat.watch()));

  // The lobby has unmounted by the time the board mounts, which is the case
  // that matters: the memory is what answers, and says so.
  at(seen + 1000, () =>
    onPage(el({}), () =>
      assert.deepEqual(matchFormat.current(), { format: "bo3", source: "memory" })
    )
  );

  // A live read always beats it.
  at(seen + 2000, () =>
    onPage(pressed("Best of 1"), () =>
      assert.deepEqual(matchFormat.current(), { format: "bo1", source: "live" })
    )
  );

  // And a memory older than the format's own window is not a format anybody
  // chose for this game.
  const stale = seen + matchFormat.FORMAT_MEMORY_MS + 1;
  at(stale, () => onPage(el({}), () => assert.equal(matchFormat.current(), null)));
});

test("the format memory ages out long before the deck picker's does", () => {
  /* The bug this window exists for: a Bo1 joined by room code, with no lobby
   * ever on screen, filed as a Bo3 because an unrelated Bo3 lobby had been
   * looked at within the deck's two hours. Nothing on the board states a
   * format, so there is no second chance to notice - only the window. */
  assert.ok(
    matchFormat.FORMAT_MEMORY_MS < globalThis.RATDeckName.DECK_MEMORY_MS,
    "the format must not inherit the deck's window again"
  );

  const seen = 9_000_000;
  at(seen, () => onPage(pressed("Best of 3"), () => matchFormat.watch()));
  const afterFormatWindow = seen + matchFormat.FORMAT_MEMORY_MS + 1;
  at(afterFormatWindow, () => onPage(el({}), () => assert.equal(matchFormat.current(), null)));
  assert.ok(
    afterFormatWindow - seen < globalThis.RATDeckName.DECK_MEMORY_MS,
    "and the case must fall inside the deck's window, or it proves nothing"
  );
});
