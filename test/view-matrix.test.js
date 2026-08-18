"use strict";

/* The Matchups view, actually run.
 *
 * This is the first test that drives one of the dashboard's ES MODULES.
 * test/dashboard-boot.test.js loads the classic scripts and works them; the
 * modules are deferred and are not part of it, so until this file the whole
 * module half - main.js's graph, the shell, the two table views and this one -
 * had no test that ever evaluated it.
 *
 * That gap shipped a blank dashboard: view-matrix.js imported `setView` from
 * shell.js, which had been un-exported earlier on this branch as dead, and the
 * page died on the first line of main.js's graph with "does not provide an
 * export named setView". test/dashboard-wiring.test.js now holds the import
 * names statically; this holds the half that static shape cannot reach - that
 * the grid actually draws, over the rows the Overview says are in view, and
 * that a cell click narrows the controls it claims to narrow.
 *
 * The page is dashboard.html itself (test/fake-page.js), not a fixture: the
 * view renders into `[data-matrix]` and reaches for the real filter controls,
 * and a hand-written stub that happened to have those would prove nothing
 * about the markup that ships.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadPage } = require("./fake-page.js");

const root = path.join(__dirname, "..");
const page = loadPage(fs.readFileSync(path.join(root, "dashboard/dashboard.html"), "utf8"));

/* The modules read `window.RATracker*` as they evaluate, and the classic half
 * publishes those onto the same global object the browser gives both. */
global.document = page.document;
global.window = global;
global.CSS = { escape: (s) => s };
global.Event = class Event {
  constructor(type, init) {
    this.type = type;
    this.bubbles = !!(init && init.bubbles);
  }
};

global.RATrackerFormat = require("../dashboard/format.js");
global.RATrackerTable = require("../dashboard/table.js");
global.RATrackerStats = require("../dashboard/stats.js");
/* setView persists the view it moved to; the grid does not care what storage
 * does with it, only that it is not missing when the click lands. */
global.RATrackerStorage = { patchSettings() {}, defaultSettings: {} };

const OVERVIEW = require("../dashboard/view-overview.js");
global.RATrackerViewOverview = OVERVIEW;

const m = (over) =>
  Object.assign(
    {
      id: "m",
      startedAt: "2026-08-01T10:00:00.000Z",
      result: "win",
      myChampion: "Alba, the Dawnbreaker",
      opponentChampion: "Corin, Tidecaller",
    },
    over
  );

/* Alba is 1-1 into Corin and 1-0 into Vex. Bram's only game was never scored,
 * so it is in the history and out of the stats - which is the clause that makes
 * the Overview's predicate different from the Matches table's, and the reason
 * this view has to use the Overview's. */
const MATCHES = [
  m({ id: "1", result: "win" }),
  m({ id: "2", result: "loss" }),
  m({ id: "3", result: "win", opponentChampion: "Vex, the Undertow" }),
  m({ id: "4", result: "unknown", myChampion: "Bram, Stonewarden", opponentChampion: "Vex, the Undertow" }),
];

OVERVIEW.mount({
  matches: () => MATCHES,
  readOnly: () => false,
  archive: () => null,
  render: () => {},
});

const host = () => page.document.querySelector("[data-matrix]");

// The import is what broke; awaiting it here is the assertion that it resolves.
const loaded = import(path.join(root, "dashboard/view-matrix.js"));

test("the view's module graph resolves at all", async () => {
  const mod = await loaded;
  assert.equal(typeof mod.renderMatrix, "function");
  assert.equal(typeof mod.mountMatrix, "function");
});

test("dashboard.html has the element the view renders into", () => {
  assert.ok(host(), "no [data-matrix] in the markup for renderMatrix to fill");
});

test("the grid draws a row per champion played and a column per champion faced", async () => {
  const { renderMatrix } = await loaded;
  renderMatrix(host());
  const html = host().innerHTML;

  assert.match(html, /<table/, "the grid is a table");
  assert.match(html, /Alba/);
  assert.match(html, /Corin/);
  assert.match(html, /Vex/);
});

test("the grid is drawn over the rows the Overview says are in view", async () => {
  const { renderMatrix } = await loaded;
  renderMatrix(host());
  const html = host().innerHTML;

  /* Bram appears in exactly one match and its result was never read, so the
   * stats exclude it. A grid that had sampled the filter controls itself - or
   * read a `countUnknown` that state.js does not define - would show a Bram row
   * beside tiles that do not count him. */
  assert.ok(!html.includes("Bram"), "a champion with no decided games is not a matchup row");
});

test("each cell carries its rate and the number of games under it", async () => {
  const { renderMatrix } = await loaded;
  renderMatrix(host());
  const html = host().innerHTML;

  // Alba into Corin: one win, one loss, so 50% over 2 games.
  assert.match(html, /50%<\/span><span class="mx-n">2</, "50% of 2 is stated with its denominator");
  // Alba into Vex: one win, so 100% - over a single game, which is why the
  // count beside it is the point.
  assert.match(html, /100%<\/span><span class="mx-n">1</);
});

test("an empty set says so rather than drawing an empty table", async () => {
  const { renderMatrix } = await loaded;
  const only = MATCHES.splice(0, MATCHES.length);
  try {
    renderMatrix(host());
    assert.match(host().innerHTML, /no matchups to grid/);
    assert.ok(!host().innerHTML.includes("<table"));
  } finally {
    MATCHES.push(...only);
  }
});

test("clicking a cell narrows the real controls, not a private query", async () => {
  const { renderMatrix, mountMatrix } = await loaded;
  renderMatrix(host());
  mountMatrix(host());

  const champion = page.document.querySelector("#fMyChampion");
  const search = page.document.querySelector("#fSearch");
  assert.ok(champion && search, "the filter row the view drives is not in the markup");

  /* The champion filter is a <select>, and legacy.js fills its options from the
   * match array. Nothing here has run that, so the option is added by hand -
   * what is under test is that the view writes the value and fires the events
   * a hand would, not how the list got there. */
  champion.value = "";
  search.value = "";

  const seen = [];
  champion.addEventListener("change", () => seen.push("change"));
  search.addEventListener("input", () => seen.push("input"));

  const cell = page.document.querySelector("[data-mine]");
  assert.ok(cell, "the grid drew no clickable cell");
  page.dispatch(cell, "click", { target: cell });

  assert.equal(champion.value, cell.dataset.mine, "the champion filter is set to the row played");
  assert.equal(search.value, cell.dataset.theirs, "the search is set to the champion faced");
  assert.deepEqual(
    seen,
    ["change", "input"],
    "both controls must be told they changed, or the views they drive never repaint"
  );
});
