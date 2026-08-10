/* The arithmetic behind the replay transport.
 *
 * These helpers decide which moments the chapter chips and the step buttons
 * land on, and what a truncated capture tells the viewer it covered. They were
 * extracted out of the dashboard viewer to be shared with the standalone share
 * viewer, and being pure is the whole reason that was possible — so they get
 * the coverage the mixed file never could have.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_SCALE,
  SEEK,
  quantise,
  resumesAfterSeek,
  shouldAutoplay,
  turnOf,
  timeline,
  evenly,
  truncationText
} = require("../replay/replay-timeline.js");

const CUSTOM = 5;
const FULL_SNAPSHOT = 2;

/** A recorder turn marker, as `capture/dom-recorder.js` emits them. */
const turnEvent = (timestamp, turnNumber) => ({
  type: CUSTOM,
  timestamp,
  data: { tag: "ra:turn", payload: { turnNumber } }
});

const snapshot = (timestamp) => ({ type: FULL_SNAPSHOT, timestamp, data: { node: {} } });
const mutation = (timestamp) => ({ type: 3, timestamp, data: {} });

test("the timeline is measured from the first event, not from the epoch", () => {
  const marks = timeline([mutation(5000), turnEvent(5000, 1), mutation(6000), turnEvent(7500, 2)]);
  assert.deepStrictEqual(marks, [
    { ms: 0, turn: 1 },
    { ms: 2500, turn: 2 }
  ]);
});

test("recorder turn markers win over full snapshots", () => {
  const marks = timeline([
    snapshot(1000),
    turnEvent(1000, 4),
    snapshot(2000),
    turnEvent(2000, 5)
  ]);
  assert.deepStrictEqual(
    marks.map((m) => m.turn),
    [4, 5],
    "the recorder's own turn numbers must survive, not be renumbered from one"
  );
});

test("without turn markers every full snapshot is a board state, numbered from one", () => {
  const marks = timeline([snapshot(100), mutation(150), snapshot(600), snapshot(1100)]);
  assert.deepStrictEqual(marks, [
    { ms: 0, turn: 1 },
    { ms: 500, turn: 2 },
    { ms: 1000, turn: 3 }
  ]);
});

test("a stream with neither markers nor snapshots has no board states", () => {
  assert.deepStrictEqual(timeline([mutation(10), mutation(20)]), []);
});

test("an empty stream has no board states rather than throwing", () => {
  assert.deepStrictEqual(timeline([]), []);
  assert.deepStrictEqual(timeline(undefined), []);
});

test("a turn marker is recognised by tag and by either payload spelling", () => {
  assert.strictEqual(turnOf(turnEvent(0, 3)), 3);
  assert.strictEqual(turnOf({ type: CUSTOM, data: { tag: "ra:turn", payload: { turn: 9 } } }), 9);
  assert.strictEqual(turnOf({ type: CUSTOM, data: { tag: "ra:turn", payload: { turnNumber: "7" } } }), 7);
});

test("anything that is not a numbered turn marker is not a board state", () => {
  assert.strictEqual(turnOf(null), null);
  assert.strictEqual(turnOf(snapshot(0)), null, "a full snapshot is not a custom event");
  assert.strictEqual(turnOf({ type: CUSTOM, data: { tag: "ra:mulligan", payload: { turnNumber: 2 } } }), null);
  assert.strictEqual(turnOf({ type: CUSTOM, data: { tag: "ra:turn", payload: { turnNumber: "x" } } }), null);
  assert.strictEqual(turnOf({ type: CUSTOM, data: { tag: "ra:turn" } }), null);
});

test("turn zero is a board state, not a falsy near-miss", () => {
  assert.strictEqual(turnOf(turnEvent(0, 0)), 0);
});

test("a mark list under the cap is passed through untouched", () => {
  const marks = [{ ms: 0, turn: 1 }, { ms: 10, turn: 2 }];
  assert.strictEqual(evenly(marks, 5), marks);
});

test("evenly caps the marks and always keeps the first and the last", () => {
  const marks = Array.from({ length: 97 }, (_, n) => ({ ms: n * 1000, turn: n + 1 }));
  const chips = evenly(marks, 30);

  assert.strictEqual(chips.length, 30);
  assert.deepStrictEqual(chips[0], marks[0]);
  assert.deepStrictEqual(chips[chips.length - 1], marks[marks.length - 1]);
  assert.deepStrictEqual(chips, [...chips].sort((a, b) => a.ms - b.ms), "chips must stay in order");
  assert.strictEqual(new Set(chips.map((c) => c.turn)).size, 30, "no turn should be shown twice");
});

test("evenly spaces the chips it keeps rather than clustering them", () => {
  const marks = Array.from({ length: 100 }, (_, n) => ({ ms: n * 1000, turn: n + 1 }));
  const gaps = evenly(marks, 10)
    .map((c) => c.turn)
    .slice(1)
    .map((turn, n, all) => turn - (n === 0 ? 1 : all[n - 1]));
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `gaps were ${gaps}`);
});

test("a truncated capture reports how far it got against the match length", () => {
  const text = truncationText({ state: "truncated", truncatedAtTurn: 12 }, { turns: 20 }, []);
  assert.strictEqual(text, "This replay covers turns 1–12 of 20; capture ran out of budget after that");
});

test("with no match length to compare against, the coverage stands alone", () => {
  const text = truncationText({ state: "truncated", truncatedAtTurn: 12 }, {}, []);
  assert.strictEqual(text, "This replay covers turns 1–12 of this match");
});

test("a capture that reached the last turn does not claim it ran out of budget", () => {
  const text = truncationText({ truncatedAtTurn: 20 }, { turns: 20 }, []);
  assert.strictEqual(text, "This replay covers turns 1–20 of this match");
});

test("without a recorded truncation point the last board state stands in", () => {
  const marks = [{ ms: 0, turn: 1 }, { ms: 900, turn: 6 }];
  assert.strictEqual(
    truncationText({}, { turns: 11 }, marks),
    "This replay covers turns 1–6 of 11; capture ran out of budget after that"
  );
});

test("a capture with nothing to report says only that it stops early", () => {
  assert.strictEqual(
    truncationText({}, { turns: 11 }, []),
    "This replay stops before the end of the match."
  );
});

test("the scale never overflows the room it was given", () => {
  for (const raw of [0.25, 0.333, 0.5, 0.87, 1.5, 1.999]) {
    assert.ok(quantise(raw) <= raw + 1e-9, `quantise(${raw}) = ${quantise(raw)} overflows the stage`);
    assert.ok(quantise(raw) > 0);
  }
});

test("the scale snaps to exactly 1:1 when it lands within a step of it", () => {
  assert.strictEqual(quantise(1), 1);
  assert.strictEqual(quantise(1.005), 1);
  assert.strictEqual(quantise(0.995), 1, "a hair under 1:1 is worth the sliver of unused room");
});

test("upscaling is allowed but capped", () => {
  assert.ok(quantise(1.5) > 1);
  assert.ok(Math.abs(quantise(9) - MAX_SCALE) < 1e-9);
});

/* The resume policy. Seeking moves the position; the play state is supposed to
 * survive it, which is the whole point of pulling this decision out of the
 * rrweb-shaped code that cannot be tested. */

const seeking = (extra) => Object.assign({ playing: true, ms: 1000, total: 10000 }, extra);

test("a scrub, a chapter chip and a Home/End jump all keep playing", () => {
  for (const reason of [SEEK.SCRUB, SEEK.CHAPTER, SEEK.JUMP]) {
    assert.strictEqual(resumesAfterSeek(seeking({ reason })), true, `${reason} stopped playback`);
  }
});

test("a seek made while paused never starts playback", () => {
  for (const reason of Object.values(SEEK)) {
    assert.strictEqual(resumesAfterSeek(seeking({ reason, playing: false })), false);
  }
});

test("stepping pauses, because a step is a request to look at one board state", () => {
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.STEP })), false);
});

test("a mid-drag seek holds playback rather than restarting it per input event", () => {
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.DRAG })), false);
});

test("releasing the slider after a drag is the seek that resumes", () => {
  // The drag has already paused the engine, so the caller passes the play state
  // it latched, not the engine's current one.
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.SCRUB, playing: true })), true);
});

test("seeking to the very end resumes nothing, and does not restart from zero", () => {
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.JUMP, ms: 10000 })), false);
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.SCRUB, ms: 99999 })), false);
});

test("seeking backwards out of a finished replay carries on playing from there", () => {
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.CHAPTER, ms: 9999 })), true);
});

test("an unnamed seek is treated as a scrub, not as a pause", () => {
  assert.strictEqual(resumesAfterSeek(seeking({})), true);
  assert.strictEqual(resumesAfterSeek(null), false, "no seek at all must not resume anything");
});

test("autoplay happens only when a surface asked for it", () => {
  assert.strictEqual(shouldAutoplay(true, false), true);
  assert.strictEqual(shouldAutoplay(false, false), false);
  assert.strictEqual(shouldAutoplay(undefined, false), false);
});

test("prefers-reduced-motion overrides a surface that asked to autoplay", () => {
  assert.strictEqual(shouldAutoplay(true, true), false);
});
