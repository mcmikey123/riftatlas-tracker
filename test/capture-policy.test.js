"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCapturePolicy, KEYFRAME_EVERY_MS } = require("../capture/capture-policy.js");

// Small ceiling so byte counts read as obvious percentages.
const BUDGET = 1000;
const make = (opts) => createCapturePolicy(Object.assign({ budgetBytes: BUDGET }, opts));

/* Snapshots are timed, and time is the only trigger. The two it replaced were
 * both proxies for elapsed time that something else could accelerate: one per
 * turn change (~36s apart on a measured replay), and a byte ratio that fired
 * whenever accumulated deltas outgrew the snapshot they diffed against. They
 * shared a counter, so loosening either tightened the other - thinning the turn
 * rule took a 3-minute match from 7 keyframes to 9. Every failure here is silent:
 * too many snapshots and playback flashes, too few and a chapter jump has to
 * replay minutes of mutations. */
test("1. the cadence is a floor on the gap, and the predicate is pure", () => {
  const p = make();
  const due = { nowMs: KEYFRAME_EVERY_MS, lastKeyframeAtMs: 0 };
  // Asking repeatedly must not drift: the recorder asks on every settle.
  for (let n = 0; n < 5; n++) assert.equal(p.shouldKeyframe(due), true);
  const early = { nowMs: KEYFRAME_EVERY_MS - 1, lastKeyframeAtMs: 0 };
  for (let n = 0; n < 5; n++) assert.equal(p.shouldKeyframe(early), false);
});

test("2. a missing clock reading never keyframes", () => {
  /* Answering "yes" without a clock would snapshot on every settle for the rest
   * of the match - precisely the flash the cadence exists to stop - whereas a
   * missed anchor costs only seek time. */
  const p = make();
  for (const nowMs of [null, undefined, "", NaN, Infinity, "soon"]) {
    assert.equal(p.shouldKeyframe({ nowMs, lastKeyframeAtMs: 0 }), false, String(nowMs));
  }
  assert.equal(p.shouldKeyframe({}), false);
  assert.equal(p.shouldKeyframe(), false);
});

test("3. a recording with no anchor at all takes one", () => {
  /* `Number(null)` is 0, a perfectly finite instant, so a missing timestamp read
   * naively looks like the whole match has elapsed - a snapshot every settle.
   * These have to be told apart from a real `lastKeyframeAtMs` of 0. */
  const p = make();
  for (const missing of [null, undefined, ""]) {
    assert.equal(p.shouldKeyframe({ nowMs: 1000, lastKeyframeAtMs: missing }), true, String(missing));
  }
  // A genuine zero is a real instant and obeys the cadence like any other.
  assert.equal(p.shouldKeyframe({ nowMs: 1000, lastKeyframeAtMs: 0 }), false);
});

/* Fidelity is the product, so there is no partial mode to fall into: anything
 * short of the ceiling captures exactly as much as an empty store would. These
 * two guard against a degradation ladder being reintroduced by accident. */
test("4. well below the ceiling the policy stays normal", () => {
  const p = make();
  p.onBytes(790);
  assert.equal(p.state(), "normal");
  assert.equal(p.usedRatio(), 0.79);
  assert.equal(p.shouldKeyframe({ nowMs: KEYFRAME_EVERY_MS, lastKeyframeAtMs: 0 }), true);
});

test("5. close under the ceiling capture is still at full fidelity", () => {
  const p = make();
  p.onBytes(999);
  assert.equal(p.state(), "normal");
  assert.equal(p.shouldKeyframe({ nowMs: KEYFRAME_EVERY_MS, lastKeyframeAtMs: 0 }), true);
});

test("6. reaching the ceiling stops capture and blocks keyframes", () => {
  const p = make();
  p.onBytes(1000);
  assert.equal(p.state(), "stopped");
  // Overdue by a mile and still refused: a wound-down capture spends nothing.
  assert.equal(p.shouldKeyframe({ nowMs: KEYFRAME_EVERY_MS * 100, lastKeyframeAtMs: 0 }), false);
});

test("7. a slow capture latches killed permanently", () => {
  const p = make();
  assert.equal(p.state(), "normal");
  p.onCaptureDuration(150); // exactly killMs is still acceptable
  assert.equal(p.state(), "normal");
  p.onCaptureDuration(151);
  assert.equal(p.state(), "killed");
  p.onBytes(0);
  p.onCaptureDuration(1);
  assert.equal(p.state(), "killed");
  assert.equal(p.shouldKeyframe({ nowMs: KEYFRAME_EVERY_MS, lastKeyframeAtMs: 0 }), false);
});

// Only one transition is left - normal -> stopped - and it is still one-way: a
// late or out-of-order byte total must not resurrect a wound-down capture.
test("8. state only ever advances", () => {
  const p = make();
  assert.equal(p.state(), "normal");
  p.onBytes(850);
  assert.equal(p.state(), "normal");
  p.onBytes(0);
  assert.equal(p.state(), "normal");
  p.onBytes(1000);
  assert.equal(p.state(), "stopped");
  p.onBytes(10);
  assert.equal(p.state(), "stopped");
  p.onBytes(850);
  assert.equal(p.state(), "stopped");

  // The kill switch is an independent latch, not a step on that path: it can
  // take over from either state and nothing walks it back.
  const q = make();
  q.onBytes(1000);
  assert.equal(q.state(), "stopped");
  q.onCaptureDuration(999);
  assert.equal(q.state(), "killed");
  q.onBytes(0);
  assert.equal(q.state(), "killed");
});

/* The setting offers an explicit "no limit", which arrives here as a blank, a
 * zero or nothing at all. Uncapped must mean uncapped: no byte total, however
 * large, may stop capture. */
test("9. a non-positive or non-finite ceiling means no ceiling at all", () => {
  for (const budgetBytes of [0, -1, NaN, Infinity, null, undefined, ""]) {
    const p = createCapturePolicy({ budgetBytes });
    p.onBytes(50 * 1024 * 1024 * 1024);
    assert.equal(p.state(), "normal", "budgetBytes " + String(budgetBytes));
    assert.equal(p.usedRatio(), 0, "budgetBytes " + String(budgetBytes));
    assert.equal(p.shouldKeyframe({ nowMs: KEYFRAME_EVERY_MS, lastKeyframeAtMs: 0 }), true);
    // The perf kill switch is unaffected by any of this.
    p.onCaptureDuration(151);
    assert.equal(p.state(), "killed");
  }
});
