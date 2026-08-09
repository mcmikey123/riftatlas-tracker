/* Rift Atlas Stats Tracker - shared formatting helpers
 *
 * Both replay viewers and the dashboard build markup as strings, so they all
 * need the same escaper and the same clock. Loaded before every consumer in
 * dashboard.html.
 */
(function (root) {
  "use strict";

  /** HTML-escape for interpolation into a template string. */
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /**
   * `m:ss` from a duration in ms, clamped at zero. `fallback` is what a
   * non-numeric duration renders as; the structured viewer wants an empty
   * string there, the visual one wants a zeroed clock.
   */
  function fmtClock(ms, fallback) {
    if (!Number.isFinite(ms)) return fallback === undefined ? "0:00" : fallback;
    const t = Math.max(0, Math.round(ms / 1000));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  }

  root.RATrackerFormat = { esc, fmtClock };
})(typeof window !== "undefined" ? window : globalThis);
