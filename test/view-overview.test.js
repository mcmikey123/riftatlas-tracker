/* What the Overview is describing, and what it says about it.
 *
 * Three things here are decidable from data alone, and each has been wrong in a
 * way nothing throws on:
 *
 *   - WHICH matches the view covers. The date range was read by the Matches
 *     table and not by this one, so "Last 7 days" narrowed the history and left
 *     every tile showing all-time numbers under a note promising otherwise.
 *   - What the tiles say. A win rate over no decided games has to be a dash;
 *     0% reads as "lost them all".
 *   - What an aggregate table's body says, including the cap and its footer.
 *
 * `overviewRows` and `aggHtml` are checked against a REFERENCE COPY of the
 * pre-move implementations, transcribed from legacy.js as it stood before this
 * wave, over a generated space of matches and control settings. The point is
 * not that the two texts look alike - it is that a transcription slip in a
 * move this size is invisible otherwise.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const format = require("../dashboard/format.js");
const tableLib = require("../dashboard/table.js");
const seriesLib = require("../dashboard/series.js");

/* view-matches.js reads window.RATracker* at module scope, so the stub has to
 * exist before anything is required. view-overview.js binds the same two
 * globals, and falls back to require() when they are absent - either way it is
 * the same format.js and the same table.js. */
global.window = {
  RATrackerFormat: format,
  RATrackerTable: tableLib,
  RATrackerSeries: seriesLib,
  RATrackerLegacy: { deckNames: () => [], hasVisual: () => false },
};

const { esc, champ, deckOf, fmtDuration } = format;
const O = require("../dashboard/view-overview.js");
const { state } = require("../dashboard/state.js");
const VM = require("../dashboard/view-matches.js");

// ---- the reference implementations -------------------------------------

/* legacy.js's `filtered()` as it stood before the move, with the four control
 * READS replaced by the values they returned. `val()` answered "" for a control
 * that was not in the markup, so "" is what an unset filter looks like here
 * too. */
function referenceFiltered(all, c) {
  const mc = c.champion;
  const mode = c.mode;
  const deck = c.deck;
  const inclUnknown = c.unknown;
  const rows = all.filter((m) => {
    if (mc && champ(m.myChampion || m.myLegend) !== mc) return false;
    if (deck && deckOf(m) !== deck) return false;
    if (mode && m.mode !== mode) return false;
    if (!inclUnknown && (m.result === "unknown" || !m.result)) return false;
    return true;
  });
  return tableLib.inRange(
    rows,
    { preset: c.preset || "all", from: c.from, to: c.to },
    "startedAt"
  );
}

const AGG_LIMIT = 8;
const rateStep = (rate) => (rate >= 0.75 ? 4 : rate >= 0.5 ? 3 : rate >= 0.25 ? 2 : 1);

/** legacy.js's `renderAgg`, minus the two lines that touched a tbody. */
function referenceAgg(rows, keyFn, key, open) {
  const agg = new Map();
  for (const m of rows) {
    const k = keyFn(m);
    const a = agg.get(k) || { games: 0, w: 0, l: 0 };
    a.games++;
    if (m.result === "win") a.w++;
    if (m.result === "loss") a.l++;
    agg.set(k, a);
  }
  if (!agg.size) {
    return '<tr><td colspan="5" class="empty">No matches recorded yet.</td></tr>';
  }
  const all = [...agg.entries()].sort((a, b) => b[1].games - a[1].games);
  const shown = open ? all : all.slice(0, AGG_LIMIT);
  return (
    shown
      .map(([name, a]) => {
        const decided = a.w + a.l;
        const rate = decided ? a.w / decided : null;
        const pct = rate === null ? 0 : Math.round(rate * 100);
        const unlabelled = name === "Unlabelled";
        const label = unlabelled ? "— unlabelled —" : esc(name);
        return `<tr>
          <td class="${unlabelled ? "unlabelled" : ""}">${label}</td>
          <td>${a.games}</td><td>${a.w}</td><td>${a.l}</td>
          <td><div class="bar-wrap"><div class="bar-track">${
            rate === null ? "" : `<div class="bar rate-${rateStep(rate)}" style="width:${pct}%"></div>`
          }</div><span class="pct">${rate === null ? "–" : pct + "%"}</span></div></td>
        </tr>`;
      })
      .join("") +
    (all.length > AGG_LIMIT
      ? `<tr><td colspan="5" class="agg-more">Showing ${shown.length} of ${all.length}
             <button data-aggmore="${esc(key)}">${open ? "show fewer" : "see all"}</button></td></tr>`
      : "")
  );
}

// ---- the generated space ------------------------------------------------

const DAY = 86400000;
const NOW = Date.now();
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

const CHAMPIONS = ["Alba, the Dawnbreaker", "Corin, Tidecaller", "", null];
const RESULTS = ["win", "loss", "draw", "unknown", undefined, ""];
const DECKS = ["Aggro", "  Aggro  ", "", null, "Unlabelled"];
const MODES = ["ranked", "casual", undefined];

/* Every combination of the fields the predicate looks at, plus a spread of
 * dates so the range half is exercised rather than assumed. 360 matches. */
function generatedMatches() {
  const out = [];
  let n = 0;
  for (const myChampion of CHAMPIONS) {
    for (const result of RESULTS) {
      for (const deckName of DECKS) {
        for (const mode of MODES) {
          n++;
          out.push({
            id: "m" + n,
            myChampion,
            opponentChampion: CHAMPIONS[n % CHAMPIONS.length],
            result,
            deckName,
            mode,
            // A spread that straddles every preset boundary, and one match with
            // no date at all - which inRange drops from a bounded range.
            startedAt: n % 37 === 0 ? null : iso(n % 400),
            durationMs: n % 5 === 0 ? 0 : n * 1000,
          });
        }
      }
    }
  }
  return out;
}

const CONTROLS = [];
for (const champion of ["", "Alba", "Corin", "Unknown"]) {
  for (const deck of ["", "Aggro", "Unlabelled"]) {
    for (const mode of ["", "ranked"]) {
      for (const unknown of [false, true]) {
        for (const range of [
          { preset: "all", from: "", to: "" },
          { preset: "", from: "", to: "" },
          { preset: "7", from: "", to: "" },
          { preset: "365", from: "", to: "" },
          { preset: "custom", from: "", to: "" },
          {
            preset: "custom",
            from: new Date(NOW - 30 * DAY).toISOString().slice(0, 10),
            to: new Date(NOW).toISOString().slice(0, 10),
          },
        ]) {
          CONTROLS.push(Object.assign({ champion, deck, mode, unknown }, range));
        }
      }
    }
  }
}

test("overviewRows answers exactly what the pre-move filter answered", () => {
  const all = generatedMatches();
  let nonEmpty = 0;
  for (const controls of CONTROLS) {
    const expected = referenceFiltered(all, controls);
    if (expected.length) nonEmpty++;
    assert.deepEqual(
      O.overviewRows(all, controls).map((m) => m.id),
      expected.map((m) => m.id),
      "diverged for " + JSON.stringify(controls)
    );
  }
  // Or the assertion above is 288 comparisons of two empty arrays.
  assert.ok(nonEmpty > CONTROLS.length / 2, "the generated space barely selects anything");
});

test("an unset control is not a filter, whatever shape the markup hands back", () => {
  // val() answers "" for a control that has been ported out of the markup, and
  // "" must mean "no filter" rather than "matches whose mode is empty".
  const all = generatedMatches();
  const none = O.overviewRows(all, { champion: "", deck: "", mode: "", unknown: true });
  assert.equal(none.length, all.length);
  assert.equal(O.overviewRows(all, {}).length, all.filter((m) => m.result === "win" || m.result === "loss" || m.result === "draw").length);
});

test("a match with no result is left out of the stats unless the box is ticked", () => {
  /* The whole reason this predicate is not the Matches table's: a win rate that
   * counted unknowns as losses would be a false claim, while the history has to
   * list them because they are what you came to fix. */
  const all = [
    { id: "w", result: "win" },
    { id: "u", result: "unknown" },
    { id: "n" },
    { id: "e", result: "" },
  ];
  assert.deepEqual(O.overviewRows(all, {}).map((m) => m.id), ["w"]);
  assert.deepEqual(
    O.overviewRows(all, { unknown: true }).map((m) => m.id),
    ["w", "u", "n", "e"]
  );
});

test("the Overview and the Matches table differ ONLY over undecided matches", () => {
  /* Asked because the two predicates look alike enough to be tempting to
   * merge. They apply the same three field filters and the same range - the
   * only difference is the clause above - so with unknowns included the two
   * select the same rows, and a future change that made them disagree about
   * anything else would land here.
   *
   * Not merged, all the same: the Matches table reads state.js (an ES module)
   * and this side reads the DOM, so a shared predicate would still need the
   * values passing in from both - and it would put one clause behind a flag
   * that means "this is the stats view", which is what the two names already
   * say. */
  const all = generatedMatches();
  for (const [champion, deck, mode] of [
    ["", "", ""],
    ["Alba", "", ""],
    ["", "Aggro", ""],
    ["", "", "ranked"],
    ["Corin", "Unlabelled", "casual"],
  ]) {
    Object.assign(state.filters, {
      champion,
      deck,
      mode,
      dateRange: { preset: "all", from: null, to: null },
    });
    state.tables.matches.search = "";
    const mine = O.overviewRows(all, { champion, deck, mode, unknown: true });
    const theirs = VM.visibleMatches(all);
    assert.deepEqual(
      new Set(mine.map((m) => m.id)),
      new Set(theirs.map((m) => m.id)),
      `the two views disagree for ${champion}/${deck}/${mode} about something other than unknowns`
    );
  }
});

// ---- the tiles ----------------------------------------------------------

test("the win rate is a dash, never 0%, when nothing has been decided", () => {
  const t = O.tileText([{ result: "draw" }, { result: "unknown" }]);
  assert.equal(t.winrate, "–");
  assert.equal(t.decided, "", "a denominator of nothing is not worth printing");
  assert.equal(t.games, 2);
});

test("the win rate carries its own denominator", () => {
  const t = O.tileText([{ result: "win" }, { result: "loss" }, { result: "draw" }]);
  assert.equal(t.winrate, "50%");
  assert.equal(t.decided, "of 2 decided", "57% of 207 and 57% of 7 are not the same claim");
  assert.equal(t.games, 3);
});

test("the average duration ignores matches that were never timed", () => {
  // A zero or a missing duration is not a fast game - it is an unmeasured one,
  // and averaging it in drags the figure toward zero.
  const t = O.tileText([
    { durationMs: 60000, result: "win" },
    { durationMs: 0, result: "loss" },
    { durationMs: null, result: "loss" },
    {},
  ]);
  assert.equal(t.duration, fmtDuration(60000));
  assert.equal(O.tileText([{}]).duration, "–");
});

// ---- the aggregate tables ----------------------------------------------

const byDeck = (m) => deckOf(m);

test("an aggregate table says what the pre-move one said, row for row", () => {
  const all = generatedMatches();
  for (const controls of CONTROLS.slice(0, 60)) {
    const rows = O.overviewRows(all, controls);
    for (const key of ["vsTable", "deckTable", "myTable"]) {
      for (const open of [false, true]) {
        const keyFn =
          key === "deckTable"
            ? byDeck
            : key === "myTable"
            ? (m) => champ(m.myChampion || m.myLegend)
            : (m) => champ(m.opponentChampion || m.opponentLegend);
        assert.equal(
          O.aggHtml(rows, keyFn, key, open),
          referenceAgg(rows, keyFn, key, open),
          `${key} diverged for ${JSON.stringify(controls)}`
        );
      }
    }
  }
});

test("a group with no decided games gets an empty bar and a dash", () => {
  // A zero-width bar at 0% reads as "lost them all", which is a different claim
  // from "none of these has finished".
  const html = O.aggHtml([{ result: "unknown", deckName: "Aggro" }], byDeck, "deckTable", false);
  assert.ok(!html.includes("<div class=\"bar rate-"), "no bar should be drawn at all");
  assert.ok(html.includes('<span class="pct">–</span>'));
});

test("an unnamed deck is shown as a hint, not as a deck called Unlabelled", () => {
  const html = O.aggHtml([{ result: "win" }], byDeck, "deckTable", false);
  assert.ok(html.includes("— unlabelled —"));
  assert.ok(html.includes('class="unlabelled"'));
});

test("a table longer than the cap says how much it is holding back", () => {
  const rows = [];
  for (let i = 0; i < O.AGG_LIMIT + 3; i++) rows.push({ result: "win", deckName: "deck" + i });
  const closed = O.aggHtml(rows, byDeck, "deckTable", false);
  assert.equal((closed.match(/<tr>\s*<td class=/g) || []).length, O.AGG_LIMIT);
  assert.ok(closed.includes(`Showing ${O.AGG_LIMIT} of ${rows.length}`));
  assert.ok(closed.includes('data-aggmore="deckTable"'));
  assert.ok(closed.includes("see all"));

  const open = O.aggHtml(rows, byDeck, "deckTable", true);
  assert.equal((open.match(/<tr>\s*<td class=/g) || []).length, rows.length);
  assert.ok(open.includes(`Showing ${rows.length} of ${rows.length}`));
  assert.ok(open.includes("show fewer"), "an expanded table has to offer the way back");
});

test("a table at the cap offers no expander at all", () => {
  const rows = [];
  for (let i = 0; i < O.AGG_LIMIT; i++) rows.push({ result: "win", deckName: "deck" + i });
  assert.ok(!O.aggHtml(rows, byDeck, "deckTable", false).includes("data-aggmore"));
});

test("an empty table says so rather than rendering nothing", () => {
  assert.ok(O.aggHtml([], byDeck, "deckTable", false).includes("No matches recorded yet."));
});

test("a deck or opponent name cannot inject markup into a row", () => {
  const html = O.aggHtml(
    [{ result: "win", deckName: '<img src=x onerror="alert(1)">' }],
    byDeck,
    "deckTable",
    false
  );
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

// ---- the trend chart's labels and its tooltip --------------------------

/* The chart's arithmetic is stats.js's and is tested there. What is tested
 * here is the three decisions the DRAWING makes on top of it, all of which
 * state something to the user that can be wrong without throwing: which date a
 * column is labelled with, which columns get a label at all, and what the
 * tooltip claims about a week. */

test("a week in the current year is labelled without one, and an older week with it", () => {
  const now = new Date(2026, 7, 15).getTime();
  assert.ok(!O.weekLabel(new Date(2026, 0, 5).getTime(), now).includes("2026"));
  assert.ok(O.weekLabel(new Date(2025, 0, 6).getTime(), now).includes("2025"));
});

test("every column is labelled while there are few enough to read", () => {
  for (const n of [1, 4, 8]) {
    assert.equal(O.labelled(n).size, n, `${n} columns should all carry a label`);
  }
});

test("a long chart keeps its first and last column labelled, and thins the rest", () => {
  for (const n of [9, 17, 52]) {
    const marks = O.labelled(n);
    assert.ok(marks.has(0), "the first column is what the chart starts at");
    assert.ok(marks.has(n - 1), "the last column is what it ends at");
    assert.ok(marks.size <= 10, `${n} columns thinned to ${marks.size} labels`);
    for (const i of marks) assert.ok(i >= 0 && i < n, "no label points off the end");
  }
});

test("a week with no games says so rather than showing a rate", () => {
  const tip = O.tipText({ start: Date.now(), games: 0, wins: 0, losses: 0, decided: 0, rate: null });
  assert.match(tip, /no games/);
  assert.ok(!tip.includes("%"));
});

test("a week whose games were all unread says that, not 0%", () => {
  const week = { start: Date.now(), games: 3, wins: 0, losses: 0, decided: 0, rate: null };
  const tip = O.tipText(week);
  assert.match(tip, /none decided/);
  assert.ok(!tip.includes("0%"), "0% here would read as having lost all three");
});

test("a week carries its record, and its game count only when it differs", () => {
  const start = Date.now();
  const decided = O.tipText({ start, games: 4, wins: 3, losses: 1, decided: 4, rate: 0.75 });
  assert.match(decided, /75% \(3–1\)/);
  assert.ok(!/4 games/.test(decided), "all four were decided, so the total says nothing new");

  const partly = O.tipText({ start, games: 6, wins: 3, losses: 1, decided: 4, rate: 0.75 });
  assert.match(partly, /75% \(3–1\)/);
  assert.match(partly, /6 games/, "two games are not in the rate, so the total has to be stated");
});

test("one game is singular", () => {
  const tip = O.tipText({ start: Date.now(), games: 1, wins: 0, losses: 0, decided: 0, rate: null });
  assert.match(tip, /1 game,/);
});
