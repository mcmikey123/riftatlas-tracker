"use strict";

/* The opponent publisher, driven end to end against a fake page: the same
 * board scrape the match record uses, through the same sticky memory the deck
 * picker uses, out to the pendingOpponent key the popup reads. The popup's
 * scouting line is only as alive as this pipeline, and every stage of it is
 * silent when it misses.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { el } = require("./fake-dom.js");

const writes = [];
globalThis.chrome = {
  storage: {
    local: {
      set(obj) {
        writes.push(JSON.parse(JSON.stringify(obj)));
      },
      get(defaults, cb) {
        cb(defaults);
      },
    },
  },
};

/* The page-side card the sighting offers. Stubbed so the tests can see what
 * would have been drawn - and because it throwing must never break a watch. */
const cards = [];
globalThis.RATPageUI = { showScoutCard: (s) => cards.push(s) };

require("../capture/sticky-memory.js");
require("../capture/match-log.js"); // board-read reads stripRepeatedTime off it
require("../capture/board-read.js");
const scout = require("../capture/scout.js");

/* The sticky memory floors reads at 250 ms apart - mutation-driven calls
 * arrive every frame on the site - so consecutive tests must wait it out or
 * their watch() is a no-op and the assertion passes for the wrong reason. */
const settle = () => new Promise((r) => setTimeout(r, 300));

const onPage = (page, fn) => {
  globalThis.document = page;
  try {
    return fn();
  } finally {
    globalThis.document = undefined;
  }
};

const opponentZone = (alt) =>
  el({
    sel: ['[data-zone-owner="opponent"]'],
    kids: [el({ tag: "img", alt, sel: ['[data-drop-zone="champion"] img[alt]'] })],
  });

test("an opponent champion on screen is published under pendingOpponent", () => {
  writes.length = 0;
  const page = el({ kids: [opponentZone("Viktor, Herald of the Arcane")] });
  onPage(page, () => scout.watch());
  const write = writes.find((w) => w.pendingOpponent);
  assert.ok(write, "seeing an opponent must reach storage");
  assert.equal(write.pendingOpponent.champion, "Viktor, Herald of the Arcane");
  assert.ok(Number.isFinite(write.pendingOpponent.at), "the popup's freshness window needs the stamp");
});

test("a page with no opponent publishes nothing", async () => {
  await settle();
  writes.length = 0;
  onPage(el({}), () => scout.watch());
  assert.deepEqual(writes, []);
});

test("a face-down card is not an opponent", async () => {
  await settle();
  writes.length = 0;
  const page = el({ kids: [opponentZone("Hidden Card")] });
  onPage(page, () => scout.watch());
  assert.deepEqual(writes, [], "a card back says nothing about who you are playing");
});
