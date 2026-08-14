/* The Replays table's record-to-label decisions.
 *
 * Every one of these fails silently when it is wrong. A `playable` that says
 * yes too often puts a Play button on a row that opens a modal only to
 * apologise; a `statOf` that returns 0 instead of null prints a measured zero
 * where nothing was measured; a state cell that drops the reason turns a
 * partial recording into what reads as a broken one. None of that throws, and
 * none of it shows up in a console.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

require("../dashboard/format.js"); // publishes RATrackerFormat on globalThis
const P = require("../dashboard/replay-panel.js");

// ---- statOf ------------------------------------------------------------

test("a recorded counter comes back as its number", () => {
  const record = { stats: { keyframes: 12, meanDeltaBytes: 0 } };
  assert.equal(P.statOf(record, "keyframes"), 12);
  // A genuine zero is a measurement and must survive, which is the whole
  // reason null is the "not recorded" answer rather than 0.
  assert.equal(P.statOf(record, "meanDeltaBytes"), 0);
});

test("a counter that was never recorded is null, not zero and not NaN", () => {
  assert.equal(P.statOf({ stats: {} }, "keyframes"), null, "a live match has no counters yet");
  assert.equal(P.statOf({}, "keyframes"), null, "a record from before stats existed");
  assert.equal(P.statOf({ stats: null }, "keyframes"), null);
});

test("a counter that is not a finite number is not a measurement", () => {
  for (const bad of [NaN, Infinity, -Infinity, "12", null, true]) {
    assert.equal(P.statOf({ stats: { keyframes: bad } }, "keyframes"), null, String(bad));
  }
});

// ---- sumStat -----------------------------------------------------------

test("the footer totals only the records that carried the counter", () => {
  const records = [{ stats: { keyframes: 3 } }, { stats: {} }, { stats: { keyframes: 4 } }];
  assert.equal(P.sumStat(records, "keyframes"), 7);
});

test("a column no record measured totals to null, not zero", () => {
  // An empty column printing "0" would claim every recording had none, which
  // is a different statement from "this build never counted them".
  assert.equal(P.sumStat([{ stats: {} }, {}], "keyframes"), null);
  assert.equal(P.sumStat([], "keyframes"), null);
});

test("a column of real zeroes totals to zero", () => {
  assert.equal(P.sumStat([{ stats: { keyframes: 0 } }], "keyframes"), 0);
});

// ---- visualLabel -------------------------------------------------------

const STARTED = Date.parse("2026-05-02T20:14:00Z");

test("a row is labelled with when it was recorded and who was in it", () => {
  const label = P.visualLabel(
    { matchId: "a", startedAt: STARTED },
    { id: "a", myChampion: "Lux, Sorcery", opponentChampion: "Darius, Might" }
  );
  // The clock is the platform's own locale formatting, so what is asserted is
  // the shape around it: the champions, trimmed to their first field.
  assert.match(label, / · Lux vs Darius$/);
  /* Positively, not just "does not start with a separator". A record's
   * startedAt is epoch MILLISECONDS, not an ISO string, and a formatter that
   * only parses strings returns the em dash for every row - which the weaker
   * assertion happily accepted. */
  assert.ok(
    label.startsWith(new Date(STARTED).toLocaleDateString()),
    `expected the recording date at the front of ${label}`
  );
});

test("legend fields stand in when a champion was never recorded", () => {
  const label = P.visualLabel(
    { matchId: "a", startedAt: STARTED },
    { id: "a", myLegend: "Lux, Sorcery", opponentLegend: "Darius, Might" }
  );
  assert.match(label, / · Lux vs Darius$/);
});

test("a recording whose match is gone is labelled by its timestamp alone", () => {
  /* Retention prunes recordings and matches on different schedules, so a
   * replay can outlive the match row that names it. The lookup happens in
   * legacy.js against the live array; null is what it hands over when it
   * misses, and the row still has to render. */
  const record = { matchId: "vanished", startedAt: STARTED };
  const label = P.visualLabel(record, null);
  assert.ok(!label.includes("·"), "with no match there is nobody to name");
  // And it is still the timestamp, not the dash a broken formatter would give -
  // this row has nothing else left to identify it by.
  assert.ok(
    label.startsWith(new Date(STARTED).toLocaleDateString()),
    `expected the recording date, got ${label}`
  );
  assert.equal(label, P.visualLabel(record, undefined));
});

test("a recording with no start time reads as unrecorded, not as the epoch", () => {
  // new Date(undefined) is Invalid Date, and printing it gives "Invalid Date"
  // in the row. The em dash is what the rest of the dashboard uses.
  assert.equal(P.visualLabel({ matchId: "a" }, null), "—");
});

// ---- visualStateCell ---------------------------------------------------

test("a state with nothing more to say is its own tooltip", () => {
  assert.equal(
    P.visualStateCell({ state: "complete" }),
    '<td><span class="vd-state vd-complete" title="complete">complete</span></td>'
  );
});

test("a record with no state at all is labelled unknown", () => {
  assert.match(P.visualStateCell({}), /vd-unknown" title="unknown">unknown</);
});

test("a truncated recording says what survived, not just that it stopped", () => {
  // "truncated" alone reads as a broken recording. Everything up to the turn
  // named is still playable, and this tooltip is the only place that is said.
  const cell = P.visualStateCell({ state: "truncated", truncatedAtTurn: 7 });
  assert.match(cell, /title="capture stopped at turn 7 - the replay covers everything up to there"/);
});

test("a truncation with no turn recorded falls back to the bare state", () => {
  assert.match(P.visualStateCell({ state: "truncated" }), /title="truncated"/);
  assert.match(P.visualStateCell({ state: "truncated", truncatedAtTurn: null }), /title="truncated"/);
});

test("turn zero is a turn, so it is reported rather than swallowed", () => {
  // `!= null` rather than a truthiness test: a capture that failed on the very
  // first turn is the most informative truncation there is.
  assert.match(P.visualStateCell({ state: "truncated", truncatedAtTurn: 0 }), /stopped at turn 0/);
});

test("an error carries its own message, or a general one", () => {
  assert.match(P.visualStateCell({ state: "error", error: "quota exceeded" }), /title="quota exceeded"/);
  assert.match(P.visualStateCell({ state: "error" }), /title="capture failed"/);
});

test("a state and an error message are both escaped into the cell", () => {
  /* Both reach here from the recorder, and the cell is built by string
   * concatenation into innerHTML. An error message is the likelier carrier -
   * it can quote whatever the browser threw. */
  const cell = P.visualStateCell({ state: "error", error: '"><img src=x onerror=alert(1)>' });
  assert.ok(!cell.includes("<img"), "an error message must not become markup");
  assert.match(cell, /&quot;&gt;&lt;img/);
});

// ---- playable ----------------------------------------------------------

test("a recording with chunks and no error can be played", () => {
  assert.equal(P.playable({ chunkCount: 3, state: "complete" }), true);
  assert.equal(P.playable({ chunkCount: 1, state: "truncated" }), true, "a partial replay still plays");
});

test("a recording with nothing in it gets no Play button", () => {
  for (const chunkCount of [0, null, undefined, "", NaN]) {
    assert.equal(P.playable({ chunkCount, state: "complete" }), false, String(chunkCount));
  }
});

test("an error recording gets no Play button however many chunks it has", () => {
  assert.equal(P.playable({ chunkCount: 9, state: "error" }), false);
});

// ---- the module itself -------------------------------------------------

test("the module loads under node with no window and exports its surface", () => {
  assert.equal(typeof window, "undefined", "this suite runs with no DOM shim");
  assert.equal(P, globalThis.RATrackerReplayPanel, "the require export is the global legacy.js reads");
  for (const name of ["statOf", "sumStat", "visualLabel", "visualStateCell", "playable"]) {
    assert.equal(typeof P[name], "function", `${name} must be exported`);
  }
});
