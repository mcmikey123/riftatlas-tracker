/* What a row of the Replays table says, what its footer adds up to, and what
 * deleting a recording promises before it happens.
 *
 * The judgements underneath a row - playable, the state cell, which counters
 * were measured - are replay-panel.js's and are tested there. What is asserted
 * here is what this view does with them, because each of the three has a silent
 * failure mode:
 *
 *   a Play button on a record with nothing to play opens a modal only to
 *   apologise;
 *   a footer that prints 0 where nothing was measured turns "not recorded" into
 *   a measurement, and the retention projection under it is the number people
 *   pick a keep count by;
 *   and the delete confirm is the last thing shown before a recording that is
 *   in no export and no archive goes for good.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { fmtBytes, DASH } = require("../dashboard/format.js");
const PANEL = require("../dashboard/share-panel.js");
const R = require("../dashboard/view-replays.js");

const record = (over) =>
  Object.assign(
    {
      matchId: "m1",
      startedAt: Date.parse("2026-05-02T20:14:00Z"),
      compressedBytes: 3_500_000,
      chunkCount: 12,
      state: "complete",
      stats: { keyframes: 4, meanDeltaBytes: 2048, captureP50Ms: 3, captureMaxMs: 40 },
    },
    over
  );

const row = (over, label, open) => R.replayRowHtml(record(over), label || "2 May · Alba vs Corin", !!open);

// ---- the row -----------------------------------------------------------

test("a playable recording gets a Play button and a Share button", () => {
  const html = row();
  assert.match(html, /data-visual="m1"/);
  assert.match(html, /data-share="m1"/);
  assert.match(html, /data-visualdel="m1"/, "every row can be deleted, playable or not");
  assert.ok(html.includes("2 May · Alba vs Corin"));
});

test("a recording with nothing to play is text, not a button that apologises", () => {
  for (const over of [{ chunkCount: 0 }, { chunkCount: undefined }, { state: "error" }]) {
    const html = row(over);
    assert.ok(!html.includes("data-visual="), `${JSON.stringify(over)} must not offer Play`);
    assert.ok(!html.includes("data-share="), "nor a share of a replay that cannot be read");
    assert.ok(html.includes("2 May · Alba vs Corin"), "the label is still shown");
    assert.match(html, /data-visualdel="m1"/, "and it can still be deleted");
  }
});

test("a counter that was never recorded is a dash, and a measured zero is a zero", () => {
  /* A match still in progress, or one recorded before a counter existed, has no
   * value for its counters - and a 0 there reads as a measurement. A chunk
   * count of 0 is the other way round: the recording is on disk and holds
   * nothing, which is a fact about it and is why the row offers no Play. */
  const html = row({ stats: {}, chunkCount: 0, compressedBytes: null });
  assert.equal(
    (html.match(new RegExp(DASH, "g")) || []).length,
    5,
    "size and the four capture counters were never measured"
  );
  assert.ok(html.includes("<td>0</td>"), "no chunks is a measurement, not a blank");
});

test("the share panel is drawn in its own full-width row, not inside a cell", () => {
  // Inside the first cell it would drag the numeric columns out of line.
  const open = row(undefined, undefined, true);
  assert.match(open, /<tr class="vd-share-row"><td colspan="9">/);
  assert.ok(open.includes('data-sharebox="m1"'));
  assert.ok(open.includes(PANEL.shareBoxInner("m1")), "the panel is the shared component's own");
  assert.ok(!row().includes("vd-share-row"), "and nothing is drawn while it is closed");
});

test("a match id or a label carrying markup cannot inject any", () => {
  const html = R.replayRowHtml(record({ matchId: '"><img src=x>' }), "<b>label</b>", true);
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<b>label"));
});

// ---- the footer --------------------------------------------------------

const totals = (records, assets, keep) =>
  R.totalsHtml(records, assets || { count: 0, bytes: 0 }, keep === undefined ? 25 : keep);

test("the footer totals what the rows hold, and says how many they are", () => {
  const html = totals([record(), record({ compressedBytes: 1_500_000, chunkCount: 3 })]);
  assert.ok(html.includes("Total · 2 matches"));
  assert.ok(html.includes(fmtBytes(5_000_000)));
  assert.ok(html.includes("<td>15</td>"), "chunks are summed");
  assert.ok(totals([record()]).includes("Total · 1 match<"), "one match is not 1 matches");
});

test("a counter no record carried totals to a dash rather than to zero", () => {
  // An empty column must not masquerade as a measured zero in the totals row.
  const html = totals([record({ stats: {} }), record({ stats: {} })]);
  assert.ok(html.includes(`<td>${DASH}</td>`));
});

test("a value that is not a number counts as nothing, not as NaN", () => {
  const html = totals([record({ compressedBytes: "big", chunkCount: null })]);
  assert.ok(!html.includes("NaN"));
});

test("the projection prices the retention setting, not the rows on screen", () => {
  /* This is the number people pick a keep count by: every replay is captured at
   * full fidelity, so the mean per match times the keep count is what the
   * setting will cost once that many have been played. */
  const html = totals([record({ compressedBytes: 2_000_000 }), record({ compressedBytes: 4_000_000 })], null, 50);
  assert.ok(html.includes(`${fmtBytes(3_000_000)} per match on average`));
  assert.ok(html.includes("keeping the newest 50"));
  assert.ok(html.includes(fmtBytes(150_000_000)));
});

test("the stylesheets are counted separately and added to the disk figure", () => {
  // They are stored once by content hash and shared by every match that used
  // them, so they belong to neither row above them.
  const html = totals([record({ compressedBytes: 1_000_000 })], { count: 7, bytes: 400_000 });
  assert.ok(html.includes("+ shared stylesheets · 7"));
  assert.ok(html.includes(fmtBytes(400_000)));
  assert.ok(html.includes(fmtBytes(1_400_000)), "on disk now is the two added together");
});

test("no recordings at all still totals rather than dividing by zero", () => {
  const html = totals([]);
  assert.ok(!html.includes("NaN"));
  assert.ok(html.includes("Total · 0 matches"));
});

// ---- the delete confirm ------------------------------------------------

test("deleting a recording says what survives it", () => {
  const c = R.deleteConfirm(fmtBytes(3_500_000), false);
  assert.ok(c.danger);
  assert.equal(c.sub, "Frees 3.34 MB");
  assert.ok(/game log/.test(c.body) && /card /.test(c.body), "the match itself is kept");
  assert.ok(/cannot be recovered/.test(c.body), "and the replay is not");
});

test("a recording whose size is unknown offers no figure rather than a wrong one", () => {
  assert.equal(R.deleteConfirm(null, false).sub, undefined);
});

test("deleting a SHARED recording says the share is not ours to delete", () => {
  /* The one thing this button cannot do. Clearing the local record would only
   * lose the key that opens a copy the endpoint keeps serving. */
  const shared = R.deleteConfirm(null, true).body;
  assert.ok(/does not delete the share/.test(shared));
  assert.ok(!/does not delete the share/.test(R.deleteConfirm(null, false).body));
});
