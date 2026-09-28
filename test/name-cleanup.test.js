"use strict";

/* Player names saved before capture read the badge's printed name.
 *
 * TEMPORARY, with dashboard/name-cleanup.js: delete both after 2026-12-28.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { cleanNames } = require("../dashboard/name-cleanup.js");

test("the saved label suffix is stripped, recovering the name", () => {
  const { matches, changed } = cleanNames([
    { id: "a", myName: "curtyo profile and actions", opponentName: "ReX profile and actions" },
    { id: "b", myName: "curtyo menu", opponentName: "Oathion menu" },
  ]);
  assert.deepEqual(matches, [
    { id: "a", myName: "curtyo", opponentName: "ReX" },
    { id: "b", myName: "curtyo", opponentName: "Oathion" },
  ]);
  assert.equal(changed, 2);
});

test("a saved placeholder becomes no name, so it stops matching other opponents", () => {
  const { matches } = cleanNames([
    { id: "a", myName: "curtyo", opponentName: "... profile and actions" },
    { id: "b", myName: "curtyo", opponentName: "..." },
    { id: "c", myName: "curtyo", opponentName: "…" },
  ]);
  assert.deepEqual(
    matches.map((m) => m.opponentName),
    [null, null, null]
  );
});

test("names that were saved right are left alone, as the same records", () => {
  const input = [
    { id: "a", myName: "curtyo", opponentName: "ReX" },
    { id: "b", myName: null, opponentName: undefined },
    { id: "c", myName: "Menu", opponentName: "Actionman" },
  ];
  const { matches, changed } = cleanNames(input);
  assert.equal(changed, 0);
  matches.forEach((m, i) => assert.equal(m, input[i]));
});

test("the stored records are not mutated; repaired ones are copies", () => {
  const saved = { id: "a", myName: "curtyo menu", opponentName: "ReX", notes: "gg" };
  const { matches } = cleanNames([saved]);
  assert.equal(saved.myName, "curtyo menu");
  assert.deepEqual(matches[0], { id: "a", myName: "curtyo", opponentName: "ReX", notes: "gg" });
});
