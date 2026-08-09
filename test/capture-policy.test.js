"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCapturePolicy } = require("../capture/capture-policy.js");

// Small budget so byte counts read as obvious percentages.
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

test("4. below the coalesce ratio the policy stays normal", () => {
  const p = make();
  p.onBytes(790);
  assert.equal(p.state(), "normal");
  assert.equal(p.minFrameIntervalMs(), 0);
  assert.equal(p.usedRatio(), 0.79);
});

test("5. at the coalesce ratio the policy throttles frames", () => {
  const p = make();
  p.onBytes(850);
  assert.equal(p.state(), "coalescing");
  assert.equal(p.minFrameIntervalMs(), 3000);
});

test("6. a full budget stops capture and blocks keyframes", () => {
  const p = make();
  p.onBytes(1000);
  assert.equal(p.state(), "stopped");
  assert.equal(p.minFrameIntervalMs(), 0);
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
  assert.equal(p.minFrameIntervalMs(), 0);
  assert.equal(p.shouldKeyframe({ reason: "turn", turnNumber: 1 }), false);
});

test("8. state only ever advances", () => {
  const p = make();
  p.onBytes(850);
  assert.equal(p.state(), "coalescing");
  p.onBytes(0);
  assert.equal(p.state(), "coalescing");
  p.onBytes(100);
  assert.equal(p.state(), "coalescing");
  p.onBytes(1000);
  assert.equal(p.state(), "stopped");
  p.onBytes(10);
  assert.equal(p.state(), "stopped");
  // Stopped takes no frames at all, so it imposes no gap; only coalescing does.
  assert.equal(p.minFrameIntervalMs(), 0);

  const q = make();
  q.onBytes(1000);
  assert.equal(q.state(), "stopped");
  q.onBytes(850);
  assert.equal(q.state(), "stopped");
});
