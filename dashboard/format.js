/* Rift Atlas Stats Tracker - shared formatting helpers
 *
 * The replay viewer and the dashboard both build markup as strings, so they
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
   * non-numeric duration renders as, for callers that want a blank rather
   * than a zeroed clock.
   */
  function fmtClock(ms, fallback) {
    if (!Number.isFinite(ms)) return fallback === undefined ? "0:00" : fallback;
    const t = Math.max(0, Math.round(ms / 1000));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  }

  /**
   * `h:mm:ss` or `m:ss` from a duration in ms. Distinct from `fmtClock`, which
   * is the replay transport's readout and never shows hours: a match lasts
   * minutes and its clock should stay two fields wide, while a *summed* length
   * - a series total, an average across a filtered history - runs past an hour
   * often enough that dropping the hours would be a lie.
   */
  function fmtDuration(ms, fallback) {
    if (!Number.isFinite(ms) || ms <= 0) return fallback === undefined ? "–" : fallback;
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /* Stands in wherever a number was never recorded. It must never be a 0: a
   * match still in progress, or one captured before a counter existed, has no
   * value for it, and a zero would read as a measurement. */
  const DASH = "—";

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return DASH;
    if (n < 1024) return Math.round(n) + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  const fmtCount = (v) => (v === null || !Number.isFinite(v) ? DASH : String(v));
  const fmtMs = (v) => (v === null || !Number.isFinite(v) ? DASH : v + " ms");

  /* A legend field carries "Name, Something Else"; the champion is the first
   * part. Falls back to "Unknown" rather than blank so a grouped table has a
   * row to put these under instead of an unlabelled one. */
  const champ = (name) => (name ? String(name).split(",")[0].trim() : "Unknown");

  /** A match's deck name, or the bucket unnamed ones are grouped under. */
  const deckOf = (m) => ((m && m.deckName) || "").trim() || "Unlabelled";

  /**
   * Today / Yesterday / "2 May" / "2 May 2025".
   *
   * The year is shown only when it is not the current one: history is mostly
   * recent, and repeating "2026" on every row is noise that pushes the part
   * that varies further right.
   */
  function fmtDay(iso, now) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return DASH;
    const d = new Date(t);
    const today = new Date(now === undefined ? Date.now() : now);
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(today) - midnight(d)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    const day = d.getDate() + " " + d.toLocaleString(undefined, { month: "short" });
    return d.getFullYear() === today.getFullYear() ? day : day + " " + d.getFullYear();
  }

  /** `20:14`, the 24-hour wall clock a match started at. */
  function fmtTime(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return DASH;
    return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /** `8–5`, or an em dash when neither side was ever scored. */
  function fmtScore(m) {
    if (!m || (m.myScore == null && m.opponentScore == null)) return DASH;
    return `${m.myScore ?? 0}–${m.opponentScore ?? 0}`;
  }

  const fmtPercent = (rate) => (rate === null || !Number.isFinite(rate) ? "–" : Math.round(rate * 100) + "%");

  root.RATrackerFormat = {
    esc,
    fmtClock,
    fmtDuration,
    fmtBytes,
    fmtCount,
    fmtMs,
    fmtDay,
    fmtTime,
    fmtScore,
    fmtPercent,
    champ,
    deckOf,
    DASH,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerFormat;
}
