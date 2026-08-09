/* Rift Atlas Stats Tracker - visual capture policy
 *
 * Decides when to spend a full DOM snapshot and when recording has to back off
 * or give up. Pure state machine: no timers, no DOM, no chrome APIs. Every
 * time-dependent input arrives as an argument, so the whole thing is testable
 * under `node --test`.
 */
(function (root) {
  "use strict";

  const DEFAULTS = {
    budgetBytes: 8 * 1024 * 1024,
    coalesceAtRatio: 0.8,
    coalesceMs: 3000,
    killMs: 150,
  };

  function createCapturePolicy(options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const { budgetBytes, coalesceAtRatio, coalesceMs, killMs } = opts;

    // High-water mark, not the latest reading. The worker is authoritative for
    // byte totals, but a late or out-of-order reply must never walk the budget
    // back and re-enable capture we already decided to wind down.
    let usedBytes = 0;
    // Once the page is stuttering under us we stay out for good: recovering and
    // resuming would just re-run the capture that caused the stall.
    let killed = false;

    function usedRatio() {
      return budgetBytes > 0 ? usedBytes / budgetBytes : 1;
    }

    function state() {
      if (killed) return "killed";
      const ratio = usedRatio();
      if (ratio >= 1) return "stopped";
      if (ratio >= coalesceAtRatio) return "coalescing";
      return "normal";
    }

    /* Pure predicate: same input, same answer, no matter how often it is asked.
     * The recorder owns "has this turn already been keyframed" - it is the only
     * side that knows which turn the last frame carried - and says so by passing
     * `reason: "turn"`, which is taken at face value here. */
    function shouldKeyframe(input) {
      const s = state();
      if (s === "stopped" || s === "killed") return false;

      const { reason, bytesSinceKeyframe, lastKeyframeBytes } = input || {};
      if (reason === "turn") return true;
      if (reason === "ratio") {
        // Self-calibrating: a delta stream that has grown past the keyframe it
        // was diffed against costs more to replay than a fresh snapshot would,
        // whatever the page's actual size. No absolute byte threshold to tune.
        return Number(bytesSinceKeyframe) > Number(lastKeyframeBytes);
      }
      return false;
    }

    function onBytes(totalCompressedBytes) {
      const n = Number(totalCompressedBytes);
      if (Number.isFinite(n) && n > usedBytes) usedBytes = n;
    }

    function onCaptureDuration(ms) {
      if (Number(ms) > killMs) killed = true;
    }

    // Coalescing is the only state that throttles frames; stopped and killed do
    // not take frames at all, so they impose no gap.
    function minFrameIntervalMs() {
      return state() === "coalescing" ? coalesceMs : 0;
    }

    return { shouldKeyframe, onBytes, onCaptureDuration, state, minFrameIntervalMs, usedRatio };
  }

  root.createCapturePolicy = createCapturePolicy;
  root.RATCapturePolicy = { createCapturePolicy };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATCapturePolicy;
}
