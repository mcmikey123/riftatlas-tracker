/* Rift Atlas Stats Tracker - the export/import file format
 *
 * One side of this is what leaves the machine (the JSON envelope, and the CSV
 * cell), the other is what comes back in (`parseBundle`). They are one file
 * because they are one format: a change to the shape written here has to be a
 * change the reader below still accepts, and a v1 file written years ago still
 * has to import.
 *
 * All of it is decidable from data alone, so it is tested rather than trusted.
 * `buildBundle` in legacy.js stays where it is - it reads the live match array
 * and chrome.storage - but everything it does to the data once it has it is
 * here.
 */
(function (root) {
  "use strict";

  // v1 bundles carried `replays` (board snapshots); v2 carries `deckCards`.
  // v1 files still import - their replays are simply dropped, because nothing
  // reads snapshots any more.
  const BUNDLE_VERSION = 2;

  // The one string an importer recognises a Rift Atlas export by. It is written
  // into every file and never read back: `parseBundle` accepts anything with a
  // `matches` array, so hand-assembled files and bare arrays keep working.
  const BUNDLE_FORMAT = "riftatlas-tracker-archive";

  /**
   * The export envelope. Written from two places - a live export and an open
   * archive re-exported - and the two must produce the same file, so the shape
   * is stated once here rather than twice at the call sites.
   *
   * `exportedAt` is passed in rather than read from the clock, so what the
   * envelope looks like is decidable without one.
   */
  function bundleFrom(fields) {
    const f = fields || {};
    return {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: f.exportedAt,
      matches: f.matches || [],
      deckCards: f.deckCards || {},
    };
  }

  /**
   * The match array with each match's game log put back inline.
   *
   * `all` holds LEAN records - the log lives in a `log_<id>` key of its own, so
   * the array rewritten during a live game stays ~0.5 KB per match instead of
   * ~21 KB. An export is the one place that has to undo that, because a bundle
   * is a single portable file and a match without its log is not a backup of
   * that match. `stored` is a whole `chrome.storage.local.get(null)` dump.
   *
   * A match whose log key is missing gets an empty array rather than being
   * skipped: the match itself is still worth exporting.
   */
  function inlineLogs(matches, stored) {
    const data = stored || {};
    return (matches || []).map((m) =>
      Object.assign({}, m, { log: (data["log_" + m.id] || {}).log || [] })
    );
  }

  /**
   * The `deckCards` map: match id -> the card codes played, for the matches
   * that have any.
   *
   * Only non-empty lists are carried. An entry holding an empty array would
   * claim on import that the deck was recorded and happened to be empty, which
   * is not the same thing as never having been recorded.
   */
  function deckCardsFrom(matches, stored) {
    const data = stored || {};
    const deckCards = {};
    for (const m of matches || []) {
      const record = data["deckcards_" + m.id];
      if (record && Array.isArray(record.codes) && record.codes.length) {
        deckCards[m.id] = record.codes;
      }
    }
    return deckCards;
  }

  /* A cell a spreadsheet reads as a formula rather than as text.
   *
   * Excel, LibreOffice and Sheets all evaluate a cell whose first character is
   * one of these, quoted or not - quoting is RFC 4180 field syntax and is
   * stripped before the value is looked at, so it is no defence. Column 7 of
   * this export is `opponentName`, a display name chosen by a remote player,
   * so a name beginning `=` or `@` is a formula that runs when the person who
   * played them opens their own history in a spreadsheet.
   *
   * `-` is on the list and is the reason for the numeric test below: negative
   * numbers start with it too, and prefixing those would turn every real
   * measurement into text and break the sums the export exists to be fed into.
   * A value that parses as a plain number cannot be a formula, so it passes. */
  const FORMULA_LEAD = /^[=+\-@]/;
  const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

  /**
   * One CSV field: RFC 4180 quoting, plus the leading apostrophe that keeps a
   * hostile value from being evaluated.
   *
   * The apostrophe is the text marker every spreadsheet honours on import; it
   * is not displayed in the cell, so a name that needed neutralising still
   * reads as itself.
   */
  const csvCell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  /** Accepts the bundle format or a bare array of matches. */
  function parseBundle(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error("That file isn't valid JSON (" + err.message + ").");
    }
    if (Array.isArray(data)) return { matches: data, deckCards: {} };
    if (data && Array.isArray(data.matches)) {
      // A v1 bundle's `replays` key is ignored rather than rejected: its board
      // snapshots have no reader left, but its matches and logs are still good.
      return { matches: data.matches, deckCards: data.deckCards || {} };
    }
    // Be specific about what went wrong - "not an array" helps nobody.
    const looksLikeSummary =
      data &&
      (data.totalMatches !== undefined ||
        data.byOpponentChampion !== undefined ||
        data.winRate !== undefined);
    if (looksLikeSummary) {
      throw new Error(
        "This is a stats SUMMARY file — it holds totals like win rate and " +
          "per-champion records, but not the individual matches, so there is " +
          "nothing to import.\n\nYou want the export itself: look in Downloads " +
          "for riftatlas-archive-<date>.json, riftatlas-matches-<date>.json, " +
          "or riftatlas-backups/matches-<date>.json."
      );
    }
    const keys = Object.keys(data || {}).slice(0, 8).join(", ") || "(none)";
    throw new Error(
      'Unrecognised file: expected a Rift Atlas export with a "matches" array.\n\n' +
        "Top-level keys found: " + keys
    );
  }

  root.RATrackerBundle = {
    BUNDLE_VERSION,
    bundleFrom,
    inlineLogs,
    deckCardsFrom,
    csvCell,
    parseBundle,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerBundle;
}
