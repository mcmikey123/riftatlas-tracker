/* The yield-to-paint helper.
 *
 * Tested because the failure it exists to prevent is invisible in a foreground
 * tab: a share pipeline that awaits a frame that never comes stays parked, and
 * in the dashboard it holds the one-share-at-a-time lock while it does.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { REPAINT_FLOOR_MS, repaint } = require("../share/repaint.js");

/** A scheduler whose timers must be run by hand, and whose frames may never come. */
function fakeScheduler({ frames }) {
  const timers = [];
  return {
    frameCallbacks: [],
    timers,
    requestAnimationFrame(fn) {
      if (frames) this.frameCallbacks.push(fn);
    },
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    /** Fire every timer due at or before `ms`, oldest first. */
    runTimers(ms) {
      for (const timer of timers.splice(0)) {
        if (timer.ms <= ms) timer.fn();
        else timers.push(timer);
      }
    },
    runFrame() {
      for (const fn of this.frameCallbacks.splice(0)) fn();
    }
  };
}

test("a hidden tab, where no frame ever fires, still resolves on the timer floor", async () => {
  const w = fakeScheduler({ frames: false });
  let settled = false;
  const waiting = repaint(w).then(() => (settled = true));

  await Promise.resolve();
  assert.strictEqual(settled, false, "nothing has run yet, so it must still be waiting");

  w.runTimers(REPAINT_FLOOR_MS);
  await waiting;
  assert.strictEqual(settled, true);
});

test("a visible tab resolves on the frame rather than waiting out the floor", async () => {
  const w = fakeScheduler({ frames: true });
  let settled = false;
  const waiting = repaint(w).then(() => (settled = true));

  w.runFrame(); // rAF fired; it queues a zero-delay task
  w.runTimers(0);
  await waiting;
  assert.strictEqual(settled, true);
});

test("the floor and the frame cannot resolve it twice", async () => {
  const w = fakeScheduler({ frames: true });
  let settles = 0;
  const waiting = repaint(w).then(() => (settles += 1));

  w.runFrame();
  w.runTimers(REPAINT_FLOOR_MS); // the zero-delay task and the floor, both due
  await waiting;
  await Promise.resolve();
  assert.strictEqual(settles, 1);
});

test("the floor is short enough to keep a backgrounded pipeline moving", () => {
  // Five yields run through a share; a floor of seconds would turn switching
  // tabs into a visible stall rather than a slower run.
  assert.ok(REPAINT_FLOOR_MS > 0 && REPAINT_FLOOR_MS <= 500, `floor is ${REPAINT_FLOOR_MS}ms`);
});
