/* Rift Atlas Stats Tracker - table arithmetic
 *
 * Sort, search, date range and pagination for the Matches and Series tables.
 * All four are client-side over the array the page has already filtered: none
 * of them touches storage, and none of them changes the schema.
 *
 * Pure, so the fiddly parts are tested rather than discovered. The fiddly
 * parts, in order of how easy they are to get wrong:
 *
 *   - Sorting must be STABLE, or rows with equal keys shuffle between renders.
 *     The dashboard re-renders every three seconds while a match is live, so an
 *     unstable sort is not a rare cosmetic issue - it is a table that will not
 *     sit still while you read it.
 *   - The page must be CLAMPED. Sitting on page 3 and typing in the search box
 *     narrows the set to one page, and an unclamped page 3 renders a blank
 *     table with working Previous/Next buttons under it.
 *   - A date range is inclusive at both ends and works in LOCAL days, because
 *     "today" means the user's today, not UTC's.
 */
(function (root) {
  "use strict";

  const PAGE_SIZE = 25;

  const text = (v) => String(v == null ? "" : v).trim();
  const ms = (iso) => {
    const t = Date.parse(iso || "");
    return Number.isFinite(t) ? t : null;
  };

  /**
   * Stable sort by a key function.
   *
   * Array.prototype.sort is specified as stable since ES2019, but only with
   * respect to the comparator: a comparator returning 0 for unequal rows
   * preserves their order. That is exactly what is wanted here, so the index
   * tiebreak below is belt and braces for the one case it does not cover -
   * a comparator that is inconsistent because a value changed mid-sort, which
   * a live match's score can do.
   */
  const isEmpty = (v) => v === null || v === undefined || v === "";

  function sortBy(rows, keyFn, dir) {
    const sign = dir === "asc" ? 1 : -1;
    return rows
      .map((row, i) => ({ row, i, key: keyFn(row) }))
      .sort((a, b) => {
        /* Empties are settled BEFORE the direction is applied, so they stay at
         * the bottom whichever way the column points. A match with no length is
         * not "the shortest" - it is unmeasured, and floating it to the top of a
         * descending sort would put the rows carrying no information where the
         * eye lands first. */
        const aEmpty = isEmpty(a.key);
        const bEmpty = isEmpty(b.key);
        if (aEmpty || bEmpty) {
          if (aEmpty && bEmpty) return a.i - b.i;
          return aEmpty ? 1 : -1;
        }
        const c = compare(a.key, b.key);
        return c !== 0 ? c * sign : a.i - b.i;
      })
      .map((x) => x.row);
  }

  /** Ordering of two present values. Emptiness is `sortBy`'s business. */
  function compare(a, b) {
    if (isEmpty(a) && isEmpty(b)) return 0;
    if (isEmpty(a)) return 1;
    if (isEmpty(b)) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  /**
   * Free-text search over whichever fields a caller nominates.
   *
   * Case-insensitive substring, not fuzzy and not tokenised: the terms people
   * type here are a fragment of an opponent's name or a room code, and
   * anything cleverer would start matching things they did not ask for.
   */
  function search(rows, term, fields) {
    const q = text(term).toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      fields.some((f) => {
        const v = typeof f === "function" ? f(row) : row[f];
        return text(v).toLowerCase().indexOf(q) !== -1;
      })
    );
  }

  /* The preset ranges the Dates control offers, as day counts back from today.
   * `null` is "all time" and `custom` is the two-date form. */
  const DATE_PRESETS = [
    { id: "all", label: "All time", days: null },
    { id: "7", label: "Last 7 days", days: 7 },
    { id: "30", label: "Last 30 days", days: 30 },
    { id: "90", label: "Last 90 days", days: 90 },
    { id: "365", label: "Last year", days: 365 },
    { id: "custom", label: "Custom…", days: null },
  ];

  /** Local midnight at the start of the day `iso` (or a timestamp) falls in. */
  function startOfDay(value) {
    const t = typeof value === "number" ? value : Date.parse(value || "");
    if (!Number.isFinite(t)) return null;
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  /**
   * Resolve a range spec to `{ from, to }` in ms, either end possibly null.
   *
   * `to` is the END of its day, so a range ending "today" includes a match
   * played a minute ago rather than stopping at this morning's midnight.
   */
  function resolveRange(range, now) {
    const at = now === undefined ? Date.now() : now;
    if (!range || range.preset === "all" || (!range.preset && !range.from && !range.to)) {
      return { from: null, to: null };
    }
    if (range.preset === "custom") {
      const from = range.from ? startOfDay(range.from) : null;
      const to = range.to ? startOfDay(range.to) + 86400000 - 1 : null;
      return { from, to };
    }
    const preset = DATE_PRESETS.find((p) => p.id === String(range.preset));
    if (!preset || preset.days === null) return { from: null, to: null };
    // Inclusive of today: "last 7 days" is today plus the six before it, which
    // is what someone counting back on a calendar means by it.
    return { from: startOfDay(at) - (preset.days - 1) * 86400000, to: null };
  }

  function inRange(rows, range, field, now) {
    const { from, to } = resolveRange(range, now);
    if (from === null && to === null) return rows;
    return rows.filter((row) => {
      const t = ms(typeof field === "function" ? field(row) : row[field]);
      if (t === null) return false;
      if (from !== null && t < from) return false;
      if (to !== null && t > to) return false;
      return true;
    });
  }

  /**
   * Slice one page out, clamping the page into range first.
   *
   * Returns the clamped page alongside the rows, so the caller can write it
   * back to state - otherwise the page number and the rows on screen disagree
   * the moment a filter shrinks the set.
   */
  function paginate(rows, page, size) {
    const per = size || PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(rows.length / per));
    const clamped = Math.min(Math.max(1, Math.round(Number(page)) || 1), pages);
    const start = (clamped - 1) * per;
    return {
      rows: rows.slice(start, start + per),
      page: clamped,
      pages,
      total: rows.length,
      // 1-based and inclusive, for "1–25 of 41". Zero rows reads as "0–0 of 0"
      // rather than "1–0".
      first: rows.length ? start + 1 : 0,
      last: Math.min(start + per, rows.length),
    };
  }

  /**
   * Which page numbers to draw, with gaps for long histories.
   *
   * Always the first and last page, plus a window around the current one, so
   * the control stays one row wide at 400 pages. Gaps are `null`.
   */
  function pageList(page, pages, span) {
    const width = span === undefined ? 1 : span;
    if (pages <= 1) return [1];
    const wanted = new Set([1, pages]);
    for (let p = page - width; p <= page + width; p++) {
      if (p >= 1 && p <= pages) wanted.add(p);
    }
    const sorted = [...wanted].sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    for (const p of sorted) {
      if (prev && p - prev > 1) out.push(null);
      out.push(p);
      prev = p;
    }
    return out;
  }

  root.RATrackerTable = {
    sortBy,
    search,
    resolveRange,
    inRange,
    paginate,
    pageList,
    startOfDay,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerTable;
}
