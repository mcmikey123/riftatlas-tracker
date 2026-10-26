/* The expanded row's Replay block: our recording, the site's official replay,
 * or both - and which of them is the primary button.
 *
 * A separate file from view-matches.test.js because the stub here differs per
 * test, and that file's RATrackerLegacy is fixed for every row it renders.
 *
 * NODE VERSION: loads an ES module via require(), unflagged on Node >= 22.12.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

global.window = {
  RATrackerFormat: require("../dashboard/format.js"),
  RATrackerTable: require("../dashboard/table.js"),
  RATrackerSeries: require("../dashboard/series.js"),
};

const V = require("../dashboard/view-matches.js");

const KEY = "8BXV8:1793031014195:1:1793031045596";

function legacy({ visual, official }) {
  window.RATrackerLegacy = {
    hasVisual: () => visual,
    officialFor: () => (official ? KEY : null),
    shareOpenHas: () => false,
    shareBoxInner: () => "<share/>",
  };
}

const block = (flags) => {
  legacy(flags);
  return V.replayBlock({ id: "m1" });
};

test("no recording and no official replay draws no Replay block at all", () => {
  assert.equal(block({ visual: false, official: false }), "");
});

test("a recording alone offers play and share, and no official button", () => {
  const html = block({ visual: true, official: false });
  assert.match(html, /btn-primary" data-visual="m1"/);
  assert.match(html, /data-share="m1"/);
  assert.ok(html.includes("<share/>"), "the share panel comes with the recording");
  assert.ok(!html.includes("data-official"));
});

test("an official replay alone is the primary button, with nothing to share", () => {
  const html = block({ visual: false, official: true });
  assert.match(html, /class="btn btn-sm btn-primary" data-official="8BXV8:1793031014195:1:1793031045596"/);
  assert.ok(!html.includes("data-visual") && !html.includes("data-share"));
  assert.ok(!html.includes("<share/>"), "there is no recording behind a share panel");
});

test("with both, the recording stays primary and the official replay sits beside it", () => {
  const html = block({ visual: true, official: true });
  assert.match(html, /btn-primary" data-visual="m1"/);
  assert.match(html, /class="btn btn-sm" data-official=/);
});
