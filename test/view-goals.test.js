"use strict";

/* The Goals view: what counts as a goal, how the list groups, and that the
 * markup it draws carries the attributes its own handlers listen for.
 *
 * Three things are decidable from data and asserted rather than trusted:
 *
 *   - WHAT THE NAV COUNTS. Active goals only: a goal ticked off is kept for
 *     the record, and counting it would say you are working on more than you
 *     are. Blank text and id-less entries are not goals at all.
 *   - HOW A MATCHUP IS NAMED. A goal stores whatever was typed -
 *     "Corin, Tidecaller" or "Corin" - and groups under the champion name
 *     every other surface compares on, format.js's champ() split.
 *   - WHAT THE MATCHUP FIELD OFFERS. Champions you have faced plus champions
 *     goals already name, deduplicated - and never "Unknown", which is
 *     format.js's bucket for a champion that was never read, not an opponent.
 *
 * The page is dashboard.html itself (test/fake-page.js), same as
 * view-notes.test.js, and the same Node >= 22.12 require(esm) constraint.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadPage } = require("./fake-page.js");

const root = path.join(__dirname, "..");
const page = loadPage(fs.readFileSync(path.join(root, "dashboard/dashboard.html"), "utf8"));

global.document = page.document;
global.window = global;
global.RATrackerFormat = require("../dashboard/format.js");
global.RATrackerStorage = require("../dashboard/storage.js");

const V = require("../dashboard/view-goals.js");

const g = (over) =>
  Object.assign(
    { id: "g_" + Math.random().toString(36).slice(2, 8), text: "a goal", opponent: "", done: false },
    over
  );

const texts = (goals) => goals.map((x) => x.text);
const host = () => page.document.querySelector("[data-goals-view]");

test("dashboard.html has the element the view renders into", () => {
  assert.ok(host(), "no [data-goals-view] in the markup for renderGoals to fill");
});

// ---- what counts --------------------------------------------------------

test("blank text, a missing id and a done goal are not active goals", () => {
  const goals = [
    g({ id: "a", text: "real" }),
    g({ id: "b", text: "   " }),
    g({ id: null, text: "no id" }),
    g({ id: "c", text: "finished", done: true }),
    null,
  ];
  assert.deepEqual(texts(V.activeGoals(goals)), ["real"]);
  assert.deepEqual(V.activeGoals(null), []);
});

// ---- grouping -----------------------------------------------------------

test("goals group into generic, per-champion and done - champions by name", () => {
  const goals = [
    g({ id: "a", text: "every game" }),
    g({ id: "b", text: "vs viktor", opponent: "Viktor, Herald of the Arcane" }),
    g({ id: "c", text: "vs corin", opponent: "Corin" }),
    g({ id: "d", text: "was vs corin", opponent: "Corin", done: true }),
  ];
  const groups = V.groupGoals(goals);
  assert.deepEqual(texts(groups.generic), ["every game"]);
  assert.deepEqual(
    groups.matchups.map((m) => m.champion),
    ["Corin", "Viktor"],
    "champion groups sort by name, and the full alt text groups under the champion"
  );
  assert.deepEqual(texts(groups.matchups[0].goals), ["vs corin"]);
  assert.deepEqual(texts(groups.done), ["was vs corin"]);
});

test("the matchup a goal stores is compared as the champion name", () => {
  assert.equal(V.opponentOf(g({ opponent: "Corin, Tidecaller" })), "Corin");
  assert.equal(V.opponentOf(g({ opponent: "  Corin  " })), "Corin");
  assert.equal(V.opponentOf(g({ opponent: "" })), "");
  assert.equal(V.opponentOf(null), "");
});

// ---- the matchup suggestions -------------------------------------------

test("the matchup field offers faced champions plus named ones, never Unknown", () => {
  const all = [
    { opponentChampion: "Corin, Tidecaller" },
    { opponentChampion: null, opponentLegend: "Viktor, Herald of the Arcane" },
    { opponentChampion: null, opponentLegend: null }, // champ() calls this Unknown
    { opponentChampion: "Corin, Tidecaller" }, // duplicate
  ];
  const goals = [g({ opponent: "Alba" })];
  assert.deepEqual(V.championOptions(all, goals), ["Alba", "Corin", "Viktor"]);
  assert.deepEqual(V.championOptions(null, null), []);
});

// ---- the markup ---------------------------------------------------------

test("the rendered rows carry the attributes the handlers listen for", () => {
  const container = host();
  V.renderGoals(container, [], [
    g({ id: "one", text: "every game" }),
    g({ id: "two", text: "vs corin", opponent: "Corin" }),
    g({ id: "three", text: "finished", done: true }),
  ]);

  assert.ok(container.querySelector('[data-goaldone="one"]'), "each goal has a done toggle");
  assert.ok(container.querySelector('[data-goaldel="two"]'), "each goal has a delete");
  assert.ok(container.querySelector("[data-goaladd]"), "the add button is drawn");
  assert.ok(container.querySelector("[data-goal-text]"), "the text field is drawn");
  assert.ok(container.querySelector("[data-goal-vs]"), "the matchup field is drawn");
  const done = container.querySelector('[data-goaldone="three"]');
  assert.ok(done && "checked" in done.attributes, "a done goal renders ticked");
});

test("with no goals at all the view says so instead of rendering nothing", () => {
  const container = host();
  V.renderGoals(container, [], []);
  assert.ok(
    container.textContent.includes("No goals yet"),
    "an empty list needs an empty state, not a blank card"
  );
});

// ---- the handlers, driven ----------------------------------------------

test("clicking Add goal writes it to storage, and delete removes it", async () => {
  /* The unit tests above prove the arithmetic; this drives the actual click
   * path - mountGoals's delegated listener, addFrom's field reads, and the
   * read-modify-write through storage.js - because "the view renders but the
   * button saves nothing" is invisible to a render test. */
  let stored = [];
  global.chrome = {
    runtime: {},
    storage: {
      local: {
        get: (defaults, cb) => cb({ goals: stored }),
        set: (obj, cb) => {
          stored = JSON.parse(JSON.stringify(obj.goals));
          if (cb) cb();
        },
      },
    },
  };
  const flush = () => new Promise((r) => setImmediate(r));

  const container = host();
  V.mountGoals(container);
  V.renderGoals(container, [], []);

  container.querySelector("[data-goal-text]").value = "Mulligan for early units";
  container.querySelector("[data-goal-vs]").value = "Mel";
  container.querySelector("[data-goaladd]").click();
  await flush();

  assert.equal(stored.length, 1, "the goal reached storage");
  assert.equal(stored[0].text, "Mulligan for early units");
  assert.equal(stored[0].opponent, "Mel");
  assert.equal(stored[0].done, false);

  V.renderGoals(container, [], stored);
  container.querySelector(`[data-goaldel="${stored[0].id}"]`).click();
  await flush();
  assert.deepEqual(stored, [], "delete removes it from storage");
});

test("goal text is escaped on the way into the markup", () => {
  const container = host();
  V.renderGoals(container, [], [g({ id: "x", text: '<img src=x onerror="1">' })]);
  assert.ok(
    !container.querySelector("img"),
    "a goal's text must render as text, never as markup"
  );
});
