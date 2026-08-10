"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCapturePolicy } = require("../capture/capture-policy.js");

// Small ceiling so byte counts read as obvious percentages.
const BUDGET = 1000;
const make = (opts) => createCapturePolicy(Object.assign({ budgetBytes: BUDGET }, opts));

// The recorder owns "has this turn already been keyframed" and only ever passes
// `reason: "turn"` once the turn has actually moved, so the policy takes that
// reason at face value - and asking twice must not change the answer.
test("1. a turn reason always keyframes, and the predicate is pure", () => {
  const p = make();
  assert.equal(p.shouldKeyframe({ reason: "turn", turnNumber: 4 }), true);
  assert.equal(p.shouldKeyframe({ reason: "turn", turnNumber: 4 }), true);
  assert.equal(p.shouldKeyframe({ reason: "turn", turnNumber: 5 }), true);

  const ratio = { reason: "ratio", bytesSinceKeyframe: 100, lastKeyframeBytes: 90 };
  assert.equal(p.shouldKeyframe(ratio), true);
  assert.equal(p.shouldKeyframe(ratio), true);
});

test("2. an unknown reason never keyframes", () => {
  const p = make();
  assert.equal(p.shouldKeyframe({}), false);
  assert.equal(p.shouldKeyframe({ reason: "start" }), false);
});

test("3. ratio keyframes when the delta outgrows the last keyframe", () => {
  const p = make();
  assert.equal(
    p.shouldKeyframe({ reason: "ratio", bytesSinceKeyframe: 100, lastKeyframeBytes: 90 }),
    true,
  );
  assert.equal(
    p.shouldKeyframe({ reason: "ratio", bytesSinceKeyframe: 50, lastKeyframeBytes: 90 }),
    false,
  );
});

/* Fidelity is the product, so there is no partial mode to fall into: anything
 * short of the ceiling captures exactly as much as an empty store would. These
 * two guard against a degradation ladder being reintroduced by accident. */
test("4. well below the ceiling the policy stays normal", () => {
  const p = make();
  p.onBytes(790);
  assert.equal(p.state(), "normal");
  assert.equal(p.usedRatio(), 0.79);
  assert.equal(p.shouldKeyframe({ reason: "turn", turnNumber: 1 }), true);
});

test("5. close under the ceiling capture is still at full fidelity", () => {
  const p = make();
  p.onBytes(999);
  assert.equal(p.state(), "normal");
  assert.equal(p.shouldKeyframe({ reason: "turn", turnNumber: 1 }), true);
  assert.equal(
    p.shouldKeyframe({ reason: "ratio", bytesSinceKeyframe: 100, lastKeyframeBytes: 90 }),
    true,
  );
});

test("6. reaching the ceiling stops capture and blocks keyframes", () => {
  const p = make();
  p.onBytes(1000);
  assert.equal(p.state(), "stopped");
  assert.equal(p.shouldKeyframe({ reason: "turn", turnNumber: 1 }), false);
  assert.equal(
    p.shouldKeyframe({ reason: "ratio", bytesSinceKeyframe: 100, lastKeyframeBytes: 1 }),
    false,
  );
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
  assert.equal(p.shouldKeyframe({ reason: "turn", turnNumber: 1 }), false);
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
    assert.equal(p.shouldKeyframe({ reason: "turn", turnNumber: 1 }), true);
    // The perf kill switch is unaffected by any of this.
    p.onCaptureDuration(151);
    assert.equal(p.state(), "killed");
  }
});
