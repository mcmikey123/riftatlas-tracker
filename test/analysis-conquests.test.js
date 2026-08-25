"use strict";

/* Conquest lines are the one reliable place battlefield names appear in a
 * stored log, and the extraction is tested because its failure is silent: a
 * regex that over-matches turns a clause into a "battlefield" and the table
 * shows it as a place. */

const test = require("node:test");
const assert = require("node:assert/strict");

const { conquests } = require("../dashboard/analysis.js");

const line = (actor, text) => ({ t: "16:11", actor, text });

test("conquest lines yield the battlefield's name and who took it", () => {
  const log = [
    line("self", "Conquered Sunken Temple and scored 2."),
    line("opponent", "Conquered The Grand Arena and scored 1."),
    line("self", "Conquered Sunken Temple."),
    line("self", "Played Ashe."),
  ];
  assert.deepEqual(conquests(log), [
    { name: "Sunken Temple", actor: "self" },
    { name: "The Grand Arena", actor: "opponent" },
    { name: "Sunken Temple", actor: "self" },
  ]);
});

test("a conquest clause too long to be a name is left out", () => {
  const log = [line("self", "Conquered " + "x".repeat(80) + " and scored 1.")];
  assert.deepEqual(conquests(log), []);
});

test("conquests over nothing is an empty list, not a crash", () => {
  assert.deepEqual(conquests([]), []);
  assert.deepEqual(conquests(undefined), []);
});
