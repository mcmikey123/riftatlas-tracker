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
  seekOutcome,
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

test("seeking to the very end resumes nothing, and does not restart from zero", () => {
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.JUMP, ms: 10000 })), false);
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.SCRUB, ms: 99999 })), false);
});

test("seeking to one tick short of the end still carries on playing", () => {
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.CHAPTER, ms: 9999 })), true);
});

test("an unnamed seek is treated as a scrub, not as a pause", () => {
  assert.strictEqual(resumesAfterSeek(seeking({})), true);
  assert.strictEqual(resumesAfterSeek(null), false, "no seek at all must not resume anything");
});

test("a reason nobody recognises resumes, because resuming is the general rule", () => {
  // Every exemption is named; a reason that is not one of them — a caller from
  // the future, a typo — must land on the rule rather than silently pausing.
  assert.strictEqual(resumesAfterSeek(seeking({ reason: "teleport" })), true);
});

/* The transport's state machine: the resume decision and the drag latch, which
 * have to be decided together. `seekOutcome` is the only thing that assigns the
 * latch, so the table below is the whole of it. */

const moving = (extra) =>
  Object.assign({ playing: false, held: false, finished: false, ms: 1000, total: 10000 }, extra);

test("a drag begun while playing latches, and every later input keeps the latch", () => {
  const first = seekOutcome(moving({ reason: SEEK.DRAG, playing: true }));
  assert.deepStrictEqual(first, { resume: false, held: true }, "the first input holds playback");
  // By the second input the engine is long since stopped, so only the latch is
  // left to say the transport was running.
  const second = seekOutcome(moving({ reason: SEEK.DRAG, held: true, ms: 2000 }));
  assert.deepStrictEqual(second, { resume: false, held: true });
});

test("a drag begun while paused latches nothing, so its release starts nothing", () => {
  assert.deepStrictEqual(seekOutcome(moving({ reason: SEEK.DRAG })), { resume: false, held: false });
});

test("releasing the slider is the seek that reads the latch and resumes", () => {
  assert.deepStrictEqual(seekOutcome(moving({ reason: SEEK.SCRUB, held: true })), {
    resume: true,
    held: false
  });
});

test("releasing the slider on the very end resumes nothing", () => {
  assert.deepStrictEqual(seekOutcome(moving({ reason: SEEK.SCRUB, held: true, ms: 10000 })), {
    resume: false,
    held: false
  });
});

test("a latch left behind by a drag whose end went unseen cannot start playback", () => {
  // Gecko fires `change` only when the value moved, so a drag away and back, or
  // one cancelled with Escape, used to leave the latch set — and the next
  // chapter chip started playing though nobody ever pressed play.
  for (const reason of [SEEK.CHAPTER, SEEK.JUMP, SEEK.STEP]) {
    assert.deepStrictEqual(
      seekOutcome(moving({ reason, held: true })),
      { resume: false, held: false },
      `a stale latch made ${reason} resume`
    );
  }
});

test("any seek that is not a drag clears the latch rather than carrying it on", () => {
  assert.strictEqual(seekOutcome(moving({ reason: SEEK.CHAPTER, held: true })).held, false);
  assert.strictEqual(seekOutcome(moving({ reason: SEEK.SCRUB, held: true })).held, false);
});

test("seeking back into a replay that ran to its end carries on playing from there", () => {
  // The state the core really produces after a finish: stopped, nothing latched,
  // but stopped because it ran out rather than because the viewer asked.
  assert.strictEqual(seekOutcome(moving({ reason: SEEK.CHAPTER, finished: true })).resume, true);
  assert.strictEqual(seekOutcome(moving({ reason: SEEK.JUMP, finished: true, ms: 0 })).resume, true);
});

test("dragging out of a finished replay latches, so the release resumes", () => {
  const held = seekOutcome(moving({ reason: SEEK.DRAG, finished: true })).held;
  assert.strictEqual(held, true);
  assert.strictEqual(seekOutcome(moving({ reason: SEEK.SCRUB, held })).resume, true);
});

test("stepping out of a finished replay stays put, and stepping again still does", () => {
  // The step is the viewer parking the transport, so what it parks on is a
  // deliberate pause: the finish no longer counts for the seeks that follow.
  assert.deepStrictEqual(seekOutcome(moving({ reason: SEEK.STEP, finished: true })), {
    resume: false,
    held: false
  });
});

test("a paused transport stays paused whatever the seek", () => {
  for (const reason of Object.values(SEEK)) {
    assert.deepStrictEqual(
      seekOutcome(moving({ reason })),
      { resume: false, held: false },
      `${reason} started playback from a standing stop`
    );
  }
});

test("autoplay happens only when a surface asked for it", () => {
  assert.strictEqual(shouldAutoplay(true, false), true);
  assert.strictEqual(shouldAutoplay(false, false), false);
  assert.strictEqual(shouldAutoplay(undefined, false), false);
});

test("prefers-reduced-motion overrides a surface that asked to autoplay", () => {
  assert.strictEqual(shouldAutoplay(true, true), false);
});
