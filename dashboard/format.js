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

  /* One spelling of the wall-clock options, shared by the two helpers below so
   * a share row and a replay row cannot start rendering the time differently. */
  const HOUR_MINUTE = { hour: "2-digit", minute: "2-digit" };

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

  /**
   * `02/05/2026 20:14` - an absolute date and time in one string.
   *
   * Distinct from fmtDay above, which is deliberately RELATIVE ("Today",
   * "Yesterday") because the history it labels is mostly recent. The rows that
   * use this one are not: a shared link and a stored recording both outlive the
   * match they came from, and "Yesterday" on a share that expires in six days
   * tells you nothing about when it lapses.
   */
  function fmtStamp(when) {
    /* Takes epoch milliseconds as well as an ISO string, because its callers
     * genuinely hold both: a match dates from `startedAt`, an ISO string, while
     * a replay record and a share record both date from a Date.now() number
     * (store/replay-store.js and share/share-ui-support.js). The hand-written
     * code this replaced used `new Date(x)`, which takes either - so parsing
     * only strings silently blanked two whole columns. */
    const t = typeof when === "number" ? when : Date.parse(when || "");
    if (!Number.isFinite(t)) return DASH;
    const d = new Date(t);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], HOUR_MINUTE);
  }

  /** `20:14`, the 24-hour wall clock a match started at. */
  function fmtTime(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return DASH;
    return new Date(t).toLocaleTimeString([], HOUR_MINUTE);
  }

  /** `8–5`, or an em dash when neither side was ever scored. */
  function fmtScore(m) {
    if (!m || (m.myScore == null && m.opponentScore == null)) return DASH;
    return `${m.myScore ?? 0}–${m.opponentScore ?? 0}`;
  }

  const fmtPercent = (rate) => (rate === null || !Number.isFinite(rate) ? "–" : Math.round(rate * 100) + "%");

  /**
   * Which of the four win-rate hue steps a rate falls in.
   *
   * The break points are quarters of the range rather than anything about good
   * or bad: this encodes magnitude, not judgement. It lives here, beside
   * fmtPercent, because four surfaces now colour a rate - the Overview's
   * aggregate bars, the weekly trend's columns, the matchup grid's cells, and
   * whatever comes next - and three of them arrived holding their own copy of
   * this line. A fifth copy drifting is how one page ends up showing the same
   * rate in two different colours.
   */
  const rateStep = (rate) => (rate >= 0.75 ? 4 : rate >= 0.5 ? 3 : rate >= 0.25 ? 2 : 1);

  root.RATrackerFormat = {
    esc,
    fmtClock,
    fmtDuration,
    fmtBytes,
    fmtCount,
    fmtMs,
    fmtDay,
    fmtStamp,
    fmtTime,
    fmtScore,
    fmtPercent,
    rateStep,
    champ,
    deckOf,
    DASH,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerFormat;
}
