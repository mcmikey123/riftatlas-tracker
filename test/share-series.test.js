"use strict";

/* The series share's pure decisions: what its record is labelled, and what
 * the consent dialog claims. Both are sentences that carry counts, and a
 * count that drifts from what the upload actually holds is a small lie told
 * at the exact moment of consent. */

const test = require("node:test");
const assert = require("node:assert/strict");

const SERIES = require("../dashboard/share-series.js");

test("the record's label names the format, the opponent and the game count", () => {
  assert.equal(
    SERIES.seriesLabel({ format: "bo3", opponentName: "monke" }, 3),
    "BO3 series vs monke · 3 games"
  );
  assert.equal(
    SERIES.seriesLabel({ format: null, opponentName: null }, 1),
    "BO3 series vs unknown · 1 game"
  );
});

test("the consent sentence states what is in the link and why the rest is not", () => {
  assert.match(SERIES.consentBody(3, 3), /3 of 3 games still have a recording/);
  assert.ok(!SERIES.consentBody(3, 3).includes("retention"), "nothing missing, nothing to explain");
  assert.match(SERIES.consentBody(3, 2), /the other has none/);
  assert.match(SERIES.consentBody(3, 1), /1 of 3 games still has a recording/);
  assert.match(SERIES.consentBody(4, 2), /the others have none/);
});
