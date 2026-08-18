"use strict";

/* The board scrapes, driven against a page.
 *
 * These moved out of content.js verbatim, where nothing could reach them. Each
 * one exists because the site gives us no clean hook for the fact it reads -
 * player names are a rail of rotated single letters, the opponent's current
 * score is identified by a colour baked into a generated class name - so each
 * carries a heuristic and a fallback, and a heuristic nothing drives is a
 * heuristic that rots.
 *
 * The contract they share is that a MISS IS NOT A ZERO. Every caller treats
 * null as "keep what you had", so a half-rendered score track must read as
 * nothing rather than as a match walking backwards.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { el } = require("./fake-dom.js");

require("../capture/match-log.js"); // board-read reads stripRepeatedTime off it
const board = require("../capture/board-read.js");

const onPage = (page, fn) => {
  globalThis.document = page;
  try {
    return fn();
  } finally {
    globalThis.document = undefined;
  }
};

const img = (alt, selector) => el({ tag: "img", alt, sel: [selector] });

// ---------- the board itself ----------

test("the board, its phase, its mode and its room code", () => {
  const page = el({
    kids: [
      el({
        sel: ['[data-testid="game-state"]'],
        dataset: { roomPhase: "in_game", roomMode: "ranked", turnNumber: "7" },
      }),
      el({ sel: ['[data-testid="room-code"]'], dataset: { roomCode: "ABC123" } }),
    ],
  });
  onPage(page, () => {
    const root = board.gameRoot();
    assert.ok(root);
    assert.equal(board.phase(root), "in_game");
    assert.equal(board.mode(root), "ranked");
    assert.equal(board.turnNumber(root), 7);
    assert.equal(board.roomCode(), "ABC123");
  });
});

test("a page with no board says so rather than throwing", () => {
  onPage(el({}), () => {
    assert.equal(board.gameRoot(), null);
    assert.equal(board.phase(null), null);
    assert.equal(board.mode(null), null);
    assert.equal(board.roomCode(), null);
    assert.equal(board.turnNumber(null), null, "an unreadable turn is null, not NaN");
    assert.equal(board.turnNumber(el({ dataset: {} })), null);
  });
});

// ---------- cards ----------

test("card alt text is read from the right zone and owner", () => {
  const page = el({
    kids: [
      el({
        sel: ['[data-zone-owner="self"]'],
        kids: [
          img("Diana, Scorn of the Moon", '[data-drop-zone="legend"] img[alt]'),
          img("Diana, Aspect of the Moon", '[data-drop-zone="champion"] img[alt]'),
        ],
      }),
      el({
        sel: ['[data-zone-owner="opponent"]'],
        kids: [img("Ahri, Nine-Tailed", '[data-drop-zone="legend"] img[alt]')],
      }),
    ],
  });
  onPage(page, () => {
    assert.equal(board.cardAlt("self", "legend"), "Diana, Scorn of the Moon");
    assert.equal(board.cardAlt("self", "champion"), "Diana, Aspect of the Moon");
    assert.equal(board.cardAlt("opponent", "legend"), "Ahri, Nine-Tailed");
    assert.equal(board.cardAlt("opponent", "champion"), null);
  });
});

test("a face-down card names nobody", () => {
  // "Hidden card" / "card back" are what the site renders before a reveal;
  // trusting them would file every match against a champion called Hidden.
  for (const alt of ["Hidden card", "CARD BACK", ""]) {
    const page = el({
      kids: [
        el({
          sel: ['[data-zone-owner="self"]'],
          kids: [img(alt, '[data-drop-zone="legend"] img[alt]')],
        }),
      ],
    });
    onPage(page, () => assert.equal(board.cardAlt("self", "legend"), null, alt));
  }
});

// ---------- scores ----------

const scoreGroup = (selector, kids) => el({ sel: [selector], kids });

test("your score is the pressed node of your track", () => {
  const page = el({
    kids: [
      scoreGroup('[role="group"][aria-label="Your score track"]', [
        el({ kids: [el({ tag: "span", text: "5", sel: ['[aria-pressed="true"] span'] })] }),
      ]),
    ],
  });
  onPage(page, () => assert.equal(board.myScore(), 5));
});

test("an unreadable score track is null, not zero", () => {
  onPage(el({}), () => assert.equal(board.myScore(), null, "no track at all"));

  const empty = el({
    kids: [scoreGroup('[role="group"][aria-label="Your score track"]', [])],
  });
  onPage(empty, () => assert.equal(board.myScore(), null, "a track with nothing pressed"));

  const nonsense = el({
    kids: [
      scoreGroup('[role="group"][aria-label="Your score track"]', [
        el({ kids: [el({ tag: "span", text: "—", sel: ['[aria-pressed="true"] span'] })] }),
      ]),
    ],
  });
  onPage(nonsense, () => assert.equal(board.myScore(), null, "a track showing no number"));
});

test("the opponent's score is found by the amber highlight, then by fallback", () => {
  /* Their nodes carry no aria-pressed, so the current one is identified by a
   * colour baked into a generated class name - with the longest class string
   * as a fallback, because that colour is exactly the kind of thing a restyle
   * changes. */
  const node = (className, value) =>
    el({ className, kids: [el({ tag: "span", text: value, sel: ["span"] })] });

  const gradient = el({
    kids: [
      scoreGroup('[role="group"][aria-label="Opponent score track"]', [
        node("bg-[rgb(20,20,20)]", "1"),
        node("bg-[rgb(108,75,39)]", "4"),
        node("bg-[rgb(20,20,20)]", "7"),
      ]),
    ],
  });
  onPage(gradient, () => assert.equal(board.opponentScore(), 4, "the amber gradient"));

  const ring = el({
    kids: [
      scoreGroup('[role="group"][aria-label="Opponent score track"]', [
        node("plain", "1"),
        node("ring-[rgb(255,224,181)]", "6"),
      ]),
    ],
  });
  onPage(ring, () => assert.equal(board.opponentScore(), 6, "the amber ring"));

  const restyled = el({
    kids: [
      scoreGroup('[role="group"][aria-label="Opponent score track"]', [
        node("a", "1"),
        node("this-node-carries-far-more-classes-than-the-others", "3"),
        node("b", "5"),
      ]),
    ],
  });
  onPage(restyled, () =>
    assert.equal(board.opponentScore(), 3, "neither colour: the busiest node wins")
  );

  const empty = el({
    kids: [scoreGroup('[role="group"][aria-label="Opponent score track"]', [])],
  });
  onPage(empty, () => assert.equal(board.opponentScore(), null));
});

// ---------- player names ----------

const rail = (className, letters, containerClass) =>
  el({
    className: containerClass,
    sel: ['div[class*="absolute"]'],
    kids: [
      el({
        className: "grid content-center justify-items-center",
        sel: [".grid.content-center.justify-items-center"],
        kids: letters.map((c) => el({ tag: "span", className, text: c, sel: ["span"] })),
      }),
    ],
  });

test("names are read off the rotated letter rails, left rail first", () => {
  const page = el({
    kids: [
      rail("rotate-90", ["M", "E"], "absolute left-[10px]"),
      rail("rotate-90", ["O", "P", "P"], "absolute right-[10px]"),
    ],
  });
  onPage(page, () => assert.deepEqual(board.playerNames(), { mine: "ME", opponent: "OPP" }));
});

test("a -rotate-90 rail reads bottom-to-top", () => {
  const page = el({
    kids: [
      rail("-rotate-90", ["E", "M"], "absolute left-[10px]"),
      rail("-rotate-90", ["P", "P", "O"], "absolute right-[10px]"),
    ],
  });
  onPage(page, () => assert.deepEqual(board.playerNames(), { mine: "ME", opponent: "OPP" }));
});

test("names are optional and a page without them is not an error", () => {
  onPage(el({}), () => assert.deepEqual(board.playerNames(), { mine: null, opponent: null }));

  // A single letter is not a rail; two rails on the right and none on the left
  // leave `mine` unread rather than guessing.
  const oneSided = el({
    kids: [rail("rotate-90", ["X"], "absolute left-[10px]"), rail("rotate-90", ["O", "P"], "absolute right-[10px]")],
  });
  onPage(oneSided, () =>
    assert.deepEqual(board.playerNames(), { mine: null, opponent: "OP" })
  );
});

// ---------- the game log ----------

const logRow = (time, message, barClass) =>
  el({
    tag: "li",
    sel: ["ul li"],
    kids: [
      el({ tag: "span", className: barClass, sel: ["span", 'span[aria-hidden="true"]'] }),
      el({
        tag: "p",
        sel: ["p"],
        kids: [
          el({
            tag: "span",
            sel: ["span"],
            kids: [
              el({ tag: "span", text: time, sel: ["span"] }),
              el({ tag: "span", text: message, sel: ["span"] }),
            ],
          }),
        ],
      }),
    ],
  });

test("a log row yields its time, its actor and its text", () => {
  const page = el({
    kids: [
      logRow("16:11", "Conquered X and scored 1.", "bg-[rgba(120,221,183,0.4)]"),
      logRow("16:12", "Played a rune.", "bg-[rgba(255,187,110,0.4)]"),
      logRow("16:13", "The game began.", "bg-[rgba(9,9,9,0.4)]"),
    ],
  });
  onPage(page, () => {
    // The panel renders newest-first, so the scrape comes back reversed.
    assert.deepEqual(board.logEntries(), [
      { t: "16:13", actor: "system", text: "The game began." },
      { t: "16:12", actor: "opponent", text: "Played a rune." },
      { t: "16:11", actor: "self", text: "Conquered X and scored 1." },
    ]);
  });
});

test("a row with no time is not a log line", () => {
  /* The shape check is load-bearing beyond finding the time: `t` reaches
   * match-log.js's RegExps unescaped, and digits-and-a-colon is what keeps that
   * safe. Anything else on the page shaped like <ul><li> lands here too. */
  const page = el({
    kids: [
      logRow("later", "Not a log line at all", "x"),
      el({ tag: "li", sel: ["ul li"], kids: [] }), // no <p>
      logRow("16:11", "", "x"), // nothing said
    ],
  });
  onPage(page, () => assert.deepEqual(board.logEntries(), []));
});

test("a chat row's repeated timestamps are taken back out", () => {
  // Chat rows render their own header and repeat the time after the message.
  const row = el({
    tag: "li",
    sel: ["ul li"],
    kids: [
      el({
        tag: "p",
        sel: ["p"],
        kids: [
          el({
            tag: "span",
            sel: ["span"],
            kids: [
              el({ tag: "span", text: "16:34", sel: ["span"] }),
              el({ tag: "span", text: "You at 16:34: nice?16:34", sel: ["span"] }),
            ],
          }),
        ],
      }),
    ],
  });
  onPage(el({ kids: [row] }), () => {
    assert.deepEqual(board.logEntries(), [{ t: "16:34", actor: "system", text: "You: nice?" }]);
  });
});

test("a page with no log panel reads as no lines", () => {
  onPage(el({}), () => assert.deepEqual(board.logEntries(), []));
});
