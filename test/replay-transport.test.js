/* The transport row's decisions.
 *
 * The row itself is addEventListener over a chrome's own elements and gets no
 * unit tests, the same split replay-core.js and replay-timeline.js already run
 * on. What is left over is decidable from data alone - which key means what,
 * which chip is lit, what one paint puts on the slider and the clock, which
 * face the play button wears - and that is what a chrome would otherwise be
 * keeping its own copy of. It had two copies until this module, and they had
 * drifted twice.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

// Required for its side effect as well as its exports: the transport reads
// `targetOwnsKey` and `SEEK` off the global the same way it does in a browser,
// where a <script> tag ahead of it has installed them.
const { SEEK } = require("../replay/replay-timeline.js");
const { activeChip, readout, playFace, keyAction, handleKey } = require("../replay/replay-transport.js");
const { fmtClock } = require("../dashboard/format.js");

const chips = [{ ms: 0, turn: 1 }, { ms: 5000, turn: 2 }, { ms: 12000, turn: 3 }];

/** A keydown, as much of one as the transport ever reads. */
function keydown(key, target) {
  let prevented = false;
  return {
    key,
    target: target || { tagName: "BODY" },
    preventDefault: () => { prevented = true; },
    get prevented() { return prevented; }
  };
}

/** A transport that records what it was asked to do instead of doing it. */
function fakePlayback(totalTime) {
  const calls = [];
  return {
    totalTime: totalTime === undefined ? 60000 : totalTime,
    calls,
    togglePlay: () => calls.push(["togglePlay"]),
    stepTo: (dir) => calls.push(["stepTo", dir]),
    seek: (ms, reason) => calls.push(["seek", ms, reason])
  };
}

/* --- the active chip ---------------------------------------------------- */

test("no chip is lit before the first one", () => {
  assert.strictEqual(activeChip([{ ms: 3000, turn: 1 }], 0), -1);
});

test("the chip lit is the last one at or before the position", () => {
  assert.strictEqual(activeChip(chips, 0), 0);
  assert.strictEqual(activeChip(chips, 4990), 0);
  assert.strictEqual(activeChip(chips, 5000), 1);
  assert.strictEqual(activeChip(chips, 11000), 1);
  assert.strictEqual(activeChip(chips, 12000), 2);
});

test("a chip stays lit for the rest of the replay", () => {
  assert.strictEqual(activeChip(chips, 900000), 2);
});

test("a position one millisecond short still lights the chip it was aimed at", () => {
  // The engine reports where it landed, not where it was sent, so the chip a
  // seek was aimed at must not go dark on arrival.
  assert.strictEqual(activeChip(chips, 4999.5), 1);
  assert.strictEqual(activeChip(chips, 11999), 2);
});

test("a replay with no chips lights nothing rather than throwing", () => {
  assert.strictEqual(activeChip([], 1000), -1);
  assert.strictEqual(activeChip(undefined, 1000), -1);
});

/* --- one paint ---------------------------------------------------------- */

test("a paint sizes the slider as well as moving it", () => {
  // The range comes from the recording, which the caller has not been told the
  // length of when the first paint arrives from inside create().
  const next = readout(0, 91500, chips, fmtClock);
  assert.strictEqual(next.max, "91500");
  assert.strictEqual(next.value, "0");
});

test("the slider takes whole milliseconds, since that is what its step is", () => {
  const next = readout(4999.6, 91500.4, chips, fmtClock);
  assert.strictEqual(next.value, "5000");
  assert.strictEqual(next.max, "91500");
});

test("the clock reads position over length", () => {
  assert.strictEqual(readout(65000, 91500, chips, fmtClock).clock, "1:05 / 1:32");
});

test("a paint says which chip is lit", () => {
  assert.strictEqual(readout(5000, 91500, chips, fmtClock).active, 1);
  assert.strictEqual(readout(0, 91500, [], fmtClock).active, -1);
});

/* --- the play button ---------------------------------------------------- */

test("the play button wears the pause face while the replay is running", () => {
  assert.deepStrictEqual(playFace(true), { text: "❚❚", label: "Pause" });
});

test("the play button wears the play face while it is stopped", () => {
  assert.deepStrictEqual(playFace(false), { text: "▶", label: "Play" });
});

test("the button's accessible name moves with its glyph", () => {
  // The glyphs are a triangle and two bars; a name that stayed on "Play" while
  // the replay played is a button announcing the opposite of what it does.
  assert.notStrictEqual(playFace(true).label, playFace(false).label);
});

/* --- the key map -------------------------------------------------------- */

test("the shared shortcuts are the five both surfaces have", () => {
  const body = { tagName: "BODY" };
  assert.strictEqual(keyAction(" ", body), "play");
  assert.strictEqual(keyAction("ArrowLeft", body), "prev");
  assert.strictEqual(keyAction("ArrowRight", body), "next");
  assert.strictEqual(keyAction("Home", body), "first");
  assert.strictEqual(keyAction("End", body), "last");
});

test("both spellings of the space key toggle playback", () => {
  // targetOwnsKey has always known "Spacebar"; the dashboard's own map did not,
  // so on an engine reporting the older name space did nothing at all there.
  assert.strictEqual(keyAction("Spacebar", { tagName: "BODY" }), "play");
});

test("keys only one surface has are not in the shared map", () => {
  // Escape closes the modal and f is fullscreen: both belong to the dashboard,
  // and a share viewer that grew either of them would be growing chrome it does
  // not have.
  for (const key of ["Escape", "f", "F", "PageDown", "Enter", "k"]) {
    assert.strictEqual(keyAction(key, { tagName: "BODY" }), null, `${key} is not a transport key`);
  }
});

test("a key named like an Object member is not an action", () => {
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.strictEqual(keyAction(key, { tagName: "BODY" }), null);
  }
});

test("an element that owns the key keeps it", () => {
  // The guard is targetOwnsKey, which has its own tests; what is asserted here
  // is that the map is behind it rather than beside it.
  assert.strictEqual(keyAction(" ", { tagName: "INPUT", type: "text" }), null);
  assert.strictEqual(keyAction("Home", { tagName: "INPUT", type: "text" }), null);
  assert.strictEqual(keyAction(" ", { tagName: "BUTTON" }), null);
  assert.strictEqual(keyAction("ArrowLeft", { tagName: "TEXTAREA" }), null);
  assert.strictEqual(keyAction("End", { tagName: "DIV", isContentEditable: true }), null);
});

test("the seek slider keeps the arrows away from its own nudge", () => {
  const slider = { tagName: "INPUT", type: "range" };
  assert.strictEqual(keyAction("ArrowLeft", slider), "prev");
  assert.strictEqual(keyAction("ArrowRight", slider), "next");
});

/* --- keys reaching the transport ---------------------------------------- */

test("each shortcut moves the transport the way both surfaces moved it", () => {
  const playback = fakePlayback(91500);
  for (const key of [" ", "ArrowLeft", "ArrowRight", "Home", "End"]) {
    handleKey(keydown(key), playback);
  }
  assert.deepStrictEqual(playback.calls, [
    ["togglePlay"],
    ["stepTo", -1],
    ["stepTo", 1],
    ["seek", 0, SEEK.JUMP],
    ["seek", 91500, SEEK.JUMP]
  ]);
});

test("End lands on the recording's own length", () => {
  const playback = fakePlayback(1234);
  handleKey(keydown("End"), playback);
  assert.deepStrictEqual(playback.calls, [["seek", 1234, SEEK.JUMP]]);
});

test("a handled key is claimed and taken away from the page", () => {
  const playback = fakePlayback();
  const event = keydown(" ");
  assert.strictEqual(handleKey(event, playback), true);
  assert.strictEqual(event.prevented, true, "space would scroll the page as well as toggling playback");
});

test("an unhandled key is left alone for the chrome around it", () => {
  // The modal's f and Escape arrive here first and have to survive the visit.
  const playback = fakePlayback();
  const event = keydown("f");
  assert.strictEqual(handleKey(event, playback), false);
  assert.strictEqual(event.prevented, false);
  assert.deepStrictEqual(playback.calls, []);
});

test("a key the focused element owns is neither claimed nor acted on", () => {
  const playback = fakePlayback();
  const event = keydown(" ", { tagName: "BUTTON" });
  assert.strictEqual(handleKey(event, playback), false);
  assert.strictEqual(event.prevented, false, "space is how a focused button is pressed");
  assert.deepStrictEqual(playback.calls, []);
});

test("keys pressed before there is a transport do nothing", () => {
  // Both surfaces listen on the document from before the replay is mounted, and
  // the share viewer keeps listening through a failure that leaves none.
  const event = keydown(" ");
  assert.strictEqual(handleKey(event, null), false);
  assert.strictEqual(event.prevented, false);
});
