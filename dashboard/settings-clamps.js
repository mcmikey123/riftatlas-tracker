/* Rift Atlas Stats Tracker - what a Settings field is allowed to become
 *
 * Three inputs the user can type into, and what each one has to be turned into
 * before it is stored. None of them can be trusted as typed: a number input's
 * min/max constrain its spinner and nothing else, so anything at all can be
 * pasted into one, and the values here feed the service worker's retention gc
 * and the content script's capture policy - places where a NaN or a zero is
 * not a bad setting but a broken feature.
 *
 * Every fallback is passed in rather than read from `RATrackerStorage`, so
 * what a field clamps to is decidable from the field alone.
 */
(function (root) {
  "use strict";

  // hosts.js is loaded first by dashboard.html; the require is for node.
  const HOSTS = root.RAShareHosts || require("../share/hosts.js");

  /* Retention is the storage control. Recordings are never degraded, so what a
   * replay costs is fixed by the match; the only lever over total disk use is
   * how many matches keep one. The MB ceiling below is a runaway guard. */
  const KEEP_MIN = 1;
  const KEEP_MAX = 500;

  /**
   * How many matches keep a replay.
   *
   * Out-of-range values are clamped rather than rejected: the number input's
   * own min/max only constrain its spinner, not what can be typed or pasted.
   *
   * KNOWN, and asserted as it stands in test/settings-clamps.test.js: a blank
   * field does NOT reach the fallback. Number("") is 0, which is finite, so it
   * is clamped up to KEEP_MIN - clearing the box sets retention to 1 and the
   * next gc deletes everything else. Left as it behaves rather than changed
   * under a refactor of the file this moved out of.
   */
  const clampKeep = (v, fallback) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(KEEP_MAX, Math.max(KEEP_MIN, n));
  };

  const CEILING_MIN_MB = 16;
  const CEILING_MAX_MB = 4096;

  /**
   * The per-match capture byte budget, in MB.
   *
   * A blank field is the explicit "no limit" affordance and is stored as 0,
   * which the capture policy reads as uncapped. Anything else is clamped into
   * range, so the guard can never be set so low that it shapes normal capture.
   */
  const clampCeiling = (v, fallback) => {
    if (v === "" || v === null || v === undefined) return 0;
    const mb = Math.round(Number(v));
    if (!Number.isFinite(mb)) return fallback;
    if (mb <= 0) return 0;
    return Math.min(CEILING_MAX_MB, Math.max(CEILING_MIN_MB, mb));
  };

  /**
   * The share endpoint.
   *
   * Blank is the "put it back to the default" affordance, so an endpoint can
   * never be cleared into a state where sharing silently has nowhere to go.
   */
  const cleanEndpoint = (value, fallback) => {
    const text = String(value == null ? "" : value).trim();
    return text ? HOSTS.normaliseEndpoint(text) : fallback;
  };

  root.RATrackerSettingsClamps = {
    KEEP_MIN,
    KEEP_MAX,
    CEILING_MIN_MB,
    CEILING_MAX_MB,
    clampKeep,
    clampCeiling,
    cleanEndpoint,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerSettingsClamps;
}
