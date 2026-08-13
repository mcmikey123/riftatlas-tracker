/* Rift Atlas Stats Tracker - visual capture policy
 *
 * Decides when to spend a full DOM snapshot and when recording has to give up.
 * Pure state machine: no timers, no DOM, no chrome APIs. Every time-dependent
 * input arrives as an argument, so the whole thing is testable under
 * `node --test`.
 *
 * Capture has exactly two fidelities: full, or none. Fidelity *is* the product
 * here - a replay that quietly drops frames to fit a number is a replay that
 * lies about the match - so storage is bounded by how many matches are retained
 * (see the gc in background.js), never by degrading an individual recording.
 * `budgetBytes` survives only as a runaway guard, defaulted so high that
 * reaching it means something went wrong rather than that a match ran long.
 */
(function (root) {
  "use strict";

  const DEFAULTS = {
    budgetBytes: 512 * 1024 * 1024,
    killMs: 150,
  };

  /* How far apart full snapshots are allowed to be, in wall-clock ms.
   *
   * Snapshots are what make playback flash: rrweb rebuilds the entire iframe
   * document on every one it replays, the board's <img> elements are recreated,
   * and their bitmaps re-decode - so the card art blanks and pops back. The
   * board frame survives, being markup and colour, which is why it reads as the
   * cards specifically rather than as a rebuild.
   *
   * Time is the only trigger, and that is the point. Two earlier ones were tried
   * and both failed for the same reason - they were proxies for elapsed time
   * that something else could accelerate:
   *
   *   - one per turn change: turns run ~36s apart, so this was a flash every
   *     ~36s for the whole replay;
   *   - a self-calibrating byte ratio, snapshotting whenever accumulated deltas
   *     outgrew the snapshot they were diffed against. Loosening the turn rule
   *     simply handed the schedule to this one, which fired at arbitrary moments
   *     mid-turn and took a measured 3-minute match from 7 keyframes to 9. Both
   *     shared one counter, so relaxing either tightened the other.
   *
   * The cadence is the seek budget: rrweb replays forward from the nearest
   * snapshot, so a chapter jump costs at most this much of a match's mutations -
   * about 2.5k events a minute on a measured replay, which is well under a
   * tenth of a second to apply. Widening this trades seek speed for fewer
   * flashes and nothing else.
   *
   * Not a floor on fidelity: capture is full or nothing (see the header), and
   * every delta is recorded regardless. This governs only how often a fresh
   * anchor is spent. */
  const KEYFRAME_EVERY_MS = 60 * 1000;

  /* Milliseconds, or null when there aren't any.
   *
   * Not `Number()` on its own: `Number(null)` is 0, a perfectly finite instant,
   * and a missing timestamp read as "time zero" makes every elapsed check look
   * like the whole match has gone by - a snapshot on every settle. */
  function msValue(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function createCapturePolicy(options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const { killMs } = opts;
    // A blank, zero or nonsensical ceiling means "no ceiling": the setting
    // offers an explicit no-limit affordance, and this is where it lands.
    const budgetBytes = Number(opts.budgetBytes);
    const unlimited = !Number.isFinite(budgetBytes) || budgetBytes <= 0;

    // High-water mark, not the latest reading. The worker is authoritative for
    // byte totals, but a late or out-of-order reply must never walk the total
    // back and re-enable capture we already decided to wind down.
    let usedBytes = 0;
    // Once the page is stuttering under us we stay out for good: recovering and
    // resuming would just re-run the capture that caused the stall.
    let killed = false;

    function usedRatio() {
      return unlimited ? 0 : usedBytes / budgetBytes;
    }

    function state() {
      if (killed) return "killed";
      return usedRatio() >= 1 ? "stopped" : "normal";
    }

    /* Pure predicate: same input, same answer, no matter how often it is asked.
     * The recorder owns the clock - it is the only side holding one - and passes
     * both instants; the interval they are measured against is this file's.
     *
     * The recorder only asks on a settled board, so a snapshot never lands on a
     * half-transitioned one. That makes this a ceiling on how often a snapshot
     * may be spent, not a promise of when: a match whose board sits still for
     * three minutes gets its next snapshot when the board next settles. */
    function shouldKeyframe(input) {
      const s = state();
      if (s === "stopped" || s === "killed") return false;

      const { nowMs, lastKeyframeAtMs } = input || {};
      const now = msValue(nowMs);
      const last = msValue(lastKeyframeAtMs);
      /* No clock reading, no decision. Answering "yes" here would snapshot on
       * every settle for the rest of the match, which is the flash this cadence
       * exists to stop - and a missed anchor only costs seek time. */
      if (now === null) return false;
      // Nothing to measure against: rrweb's own opening snapshot is the anchor
      // the recorder starts this clock from, so this is a recording that somehow
      // has none, and it wants one.
      if (last === null) return true;
      return now - last >= KEYFRAME_EVERY_MS;
    }

    function onBytes(totalCompressedBytes) {
      const n = Number(totalCompressedBytes);
      if (Number.isFinite(n) && n > usedBytes) usedBytes = n;
    }

    function onCaptureDuration(ms) {
      if (Number(ms) > killMs) killed = true;
    }

    return { shouldKeyframe, onBytes, onCaptureDuration, state, usedRatio };
  }

  root.createCapturePolicy = createCapturePolicy;
  root.RATCapturePolicy = { createCapturePolicy, KEYFRAME_EVERY_MS };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATCapturePolicy;
}
