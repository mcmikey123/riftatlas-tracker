"use strict";

/* The Notes view: which notes it shows, how it groups them, and that the range
 * chips it draws actually narrow the list.
 *
 * Three things here are decidable from data and are therefore asserted rather
 * than trusted:
 *
 *   - WHAT COUNTS AS A NOTE. A textarea that was opened and tabbed out of holds
 *     "" or "\n", and a view that counted those would list games with nothing
 *     to read on the row - and put a number beside Notes in the nav for them.
 *   - WHICH WINDOW A NOTE FALLS IN. "Last week" is table.js's 7-day preset, the
 *     same arithmetic the Matches table dates its rows with, so the two cannot
 *     come to disagree about what last week means.
 *   - WHAT A GROUP CLAIMS. The record beside a champion is over the NOTED games
 *     only. It is not your record into that champion, and printing it as if it
 *     were would be a different and wrong number.
 *
 * The page is dashboard.html itself (test/fake-page.js), not a fixture: the
 * view renders into `[data-notes-view]`, and a hand-written stub that happened
 * to have that element would prove nothing about the markup that ships.
 *
 * NODE VERSION: this file loads an ES module from CommonJS via `require()`,
 * unflagged only on Node >= 22.12 - the same constraint view-matches.test.js
 * carries.
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
global.RATrackerTable = require("../dashboard/table.js");

const V = require("../dashboard/view-notes.js");
const { state } = require("../dashboard/state.js");

/* A fixed present, so "last week" is a claim this file can check rather than
 * one that changes with the clock it is run under. */
const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const m = (over) =>
  Object.assign(
    {
      id: "m",
      startedAt: daysAgo(1),
      result: "win",
      myChampion: "Alba, the Dawnbreaker",
      opponentChampion: "Corin, Tidecaller",
      notes: "Held the middle battlefield too long.",
    },
    over
  );

const ids = (rows) => rows.map((r) => r.id);
const host = () => page.document.querySelector("[data-notes-view]");

test("dashboard.html has the element the view renders into", () => {
  assert.ok(host(), "no [data-notes-view] in the markup for renderNotes to fill");
});

// ---- what counts as a note ---------------------------------------------

test("a blank or whitespace note is not a note", () => {
  const all = [
    m({ id: "written" }),
    m({ id: "empty", notes: "" }),
    m({ id: "spaces", notes: "  \n " }),
    m({ id: "never", notes: undefined }),
  ];
  assert.deepEqual(ids(V.notedMatches(all, "all", NOW)), ["written"]);
  assert.equal(V.hasNote(all[1]), false);
  assert.equal(V.hasNote(all[2]), false);
  assert.equal(V.hasNote(all[3]), false);
});

test("no matches at all is an empty list, not a crash", () => {
  assert.deepEqual(V.notedMatches(null, "all", NOW), []);
  assert.deepEqual(V.notedMatches(undefined, "7", NOW), []);
  assert.deepEqual(V.groupNotes(null), []);
});

// ---- the three windows --------------------------------------------------

test("week, month and year each take the notes inside them and no others", () => {
  const all = [
    m({ id: "today", startedAt: daysAgo(0) }),
    m({ id: "thisWeek", startedAt: daysAgo(3) }),
    m({ id: "thisMonth", startedAt: daysAgo(20) }),
    m({ id: "thisYear", startedAt: daysAgo(200) }),
    m({ id: "older", startedAt: daysAgo(500) }),
  ];

  assert.deepEqual(ids(V.notedMatches(all, "7", NOW)), ["today", "thisWeek"]);
  assert.deepEqual(ids(V.notedMatches(all, "30", NOW)), ["today", "thisWeek", "thisMonth"]);
  assert.deepEqual(ids(V.notedMatches(all, "365", NOW)), [
    "today",
    "thisWeek",
    "thisMonth",
    "thisYear",
  ]);
  assert.equal(V.notedMatches(all, "all", NOW).length, 5, "all time keeps every note");
});

test("the windows are table.js's, not a second implementation of them", () => {
  /* "Last 7 days" is today plus the six before it in the Matches table, so a
   * note from six days ago is inside last week and one from seven is not. A
   * private day count here would drift from that by one and nothing would
   * throw. */
  const all = [m({ id: "sixth", startedAt: daysAgo(6) }), m({ id: "seventh", startedAt: daysAgo(7) })];
  assert.deepEqual(ids(V.notedMatches(all, "7", NOW)), ["sixth"]);
});

test("notes come back newest first", () => {
  const all = [
    m({ id: "older", startedAt: daysAgo(9) }),
    m({ id: "newest", startedAt: daysAgo(1) }),
    m({ id: "middle", startedAt: daysAgo(4) }),
  ];
  assert.deepEqual(ids(V.notedMatches(all, "all", NOW)), ["newest", "middle", "older"]);
});

test("a note on a match with no usable date survives all time and no window", () => {
  /* A range has to drop it - it cannot be placed inside one - but "All time"
   * must not, or the note is unreachable from every control on the view. */
  const all = [m({ id: "undated", startedAt: null })];
  assert.deepEqual(ids(V.notedMatches(all, "all", NOW)), ["undated"]);
  assert.deepEqual(ids(V.notedMatches(all, "365", NOW)), []);
});

// ---- the grouping -------------------------------------------------------

test("notes group under the champion they were written against", () => {
  const rows = V.notedMatches(
    [
      m({ id: "a" }),
      m({ id: "b", opponentChampion: "Vex, the Undertow" }),
      m({ id: "c" }),
    ],
    "all",
    NOW
  );
  const groups = V.groupNotes(rows);
  assert.deepEqual(
    groups.map((g) => [g.champion, g.matches.length]),
    [["Corin", 2], ["Vex", 1]],
    "the champion written about most comes first"
  );
});

test("a group's record is over its noted games, not over the matchup", () => {
  const rows = V.notedMatches(
    [
      m({ id: "w", result: "win" }),
      m({ id: "l", result: "loss" }),
      m({ id: "u", result: "unknown" }),
      // Same matchup, no note - it is not one of the games this group is about.
      m({ id: "quiet", result: "win", notes: "" }),
    ],
    "all",
    NOW
  );
  const [corin] = V.groupNotes(rows);
  assert.equal(corin.matches.length, 3);
  assert.equal(corin.wins, 1);
  assert.equal(corin.losses, 1, "an unread result is neither a win nor a loss");
});

test("a match whose opponent was never read still has a group to sit in", () => {
  const rows = V.notedMatches([m({ id: "x", opponentChampion: null, opponentLegend: null })], "all", NOW);
  assert.deepEqual(V.groupNotes(rows).map((g) => g.champion), ["Unknown"]);
});

test("the summary line counts notes and opponents, over the named window", () => {
  const rows = V.notedMatches([m({ id: "a" }), m({ id: "b", opponentChampion: "Vex, the Undertow" })], "7", NOW);
  const line = V.summaryText(rows, "7");
  assert.match(line, /2 notes/);
  assert.match(line, /2 champions/);
  assert.match(line, /last 7 days/);
  assert.equal(V.summaryText([], "7"), "", "an empty set gets an empty state, not a line of zeroes");
});

// ---- the paint ----------------------------------------------------------

test("the view draws a group per champion, with the note text in it", () => {
  state.notes.range = "all";
  V.renderNotes(host(), [m({ id: "a", notes: "Mulliganed into nothing." }), m({ id: "b", opponentChampion: "Vex, the Undertow" })]);
  const html = host().innerHTML;

  assert.match(html, /Note summary/);
  assert.match(html, /vs Corin/);
  assert.match(html, /vs Vex/);
  assert.match(html, /Mulliganed into nothing\./);
});

test("a note is escaped, not interpolated", () => {
  /* Asserted over the parsed tree rather than the serialized string: the fake
   * page decodes entities as it parses and does not re-encode them on the way
   * out, so `&lt;img` reads back as `<img` whether or not the view escaped it.
   * What is decidable either way is whether an ELEMENT was created. */
  state.notes.range = "all";
  V.renderNotes(host(), [m({ id: "a", notes: "<img src=x onerror=alert(1)>" })]);

  assert.equal(host().querySelector("img"), null, "a note is user text and must never become markup");
  const cell = host().querySelector(".note-text");
  assert.ok(cell, "the note has nowhere to be");
  assert.equal(cell.textContent, "<img src=x onerror=alert(1)>", "it is shown as the text it is");
});

test("having no notes at all reads differently from having none in the window", () => {
  state.notes.range = "7";
  V.renderNotes(host(), []);
  assert.match(host().innerHTML, /No notes yet/, "an empty history is not a filtering problem");

  V.renderNotes(host(), [m({ id: "old", startedAt: daysAgo(400) })]);
  assert.match(
    host().innerHTML,
    /No notes in the last 7 days/,
    "notes exist but the window hides them, so the window is what to say"
  );
  state.notes.range = "all";
});

test("the range chips mark the one in force, and clicking another switches it", () => {
  state.notes.range = "all";
  V.renderNotes(host(), [m({ id: "a" })]);
  V.mountNotes(host());

  const chipFor = (id) => page.document.querySelector(`[data-noterange="${id}"]`);
  assert.ok(chipFor("7") && chipFor("30") && chipFor("365") && chipFor("all"), "a chip per window");
  assert.match(chipFor("all").attributes.class, /\bon\b/, "the window in force is the marked one");

  page.dispatch(chipFor("30"), "click", { target: chipFor("30") });
  assert.equal(state.notes.range, "30", "the chip sets the range the next render reads");
});

test("the chips are the view's own control, not the shared filter row", () => {
  /* Two date controls over one list can disagree about it, so the filter row is
   * hidden on this view - which means these chips are the only way to narrow it
   * and must live inside the container the view repaints. */
  V.renderNotes(host(), [m({ id: "a" })]);
  assert.ok(host().innerHTML.includes("data-noterange"), "the range control is drawn by the view");
});
