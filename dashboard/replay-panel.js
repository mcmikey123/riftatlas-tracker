/* Rift Atlas Stats Tracker - what a replay record says about itself
 *
 * The Replays view is a table of recordings, and every column of it is a
 * judgement about one record: whether it can be played at all, what its state
 * means in words, which of its counters were actually measured. The rendering
 * around them lives in legacy.js; the judgements are here because they are
 * decidable from the record alone, and because getting one of them wrong is
 * silent - a button that opens a modal only to apologise, or a blank column
 * that reads as a measured zero.
 *
 * `share/share-ui-support.js` is the same idea for the Share control.
 */
(function (root) {
  "use strict";

  // format.js is loaded first by dashboard.html; the require is for node.
  const FORMAT = root.RATrackerFormat || require("./format.js");
  const { esc, champ, fmtStamp, DASH } = FORMAT;

  /**
   * One capture counter off a record, or null.
   *
   * In-flight matches, and any recorded before a counter existed, simply have
   * no value here - which must read as "not recorded", never as NaN.
   */
  function statOf(record, key) {
    const v = record.stats ? record.stats[key] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  /**
   * A counter totalled across the table's footer.
   *
   * Null - not zero - when no record carried the counter at all, so an empty
   * column can't masquerade as a measured zero.
   */
  function sumStat(records, key) {
    const vals = records.map((r) => statOf(r, key)).filter((v) => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }

  /**
   * The row's label: when the recording started, and who was in it.
   *
   * `match` is the match this recording belongs to, or null when it is gone -
   * a replay outlives nothing, but a match can be deleted while its recording
   * is still on disk, and retention prunes the two on different schedules. The
   * timestamp alone is then the whole label, because it is the only true thing
   * left to say about the row.
   */
  function visualLabel(record, match) {
    const when = fmtStamp(record.startedAt);
    if (!match) return when;
    return `${when} · ${champ(match.myChampion || match.myLegend)} vs ${champ(
      match.opponentChampion || match.opponentLegend
    )}`;
  }

  /**
   * The state cell, with the reason in its tooltip.
   *
   * `truncated` is the one state that is useless on its own: it says capture
   * stopped without saying that everything before that point is still there,
   * which reads as a broken recording rather than a partial one.
   */
  function visualStateCell(record) {
    const state = record.state || "unknown";
    const why =
      state === "truncated" && record.truncatedAtTurn != null
        ? `capture stopped at turn ${record.truncatedAtTurn} - the replay covers everything up to there`
        : state === "error"
        ? record.error || "capture failed"
        : state;
    return `<td><span class="vd-state vd-${esc(state)}" title="${esc(why)}">${esc(state)}</span></td>`;
  }

  /**
   * Whether this row gets a Play button.
   *
   * Not every row can. A record with no chunks has nothing to play, and an
   * `error` recording is unplayable by definition - the legend on this view
   * says exactly that. Those stay as plain text rather than becoming a button
   * that opens a modal only to apologise.
   */
  const playable = (record) => (Number(record.chunkCount) || 0) > 0 && record.state !== "error";

  root.RATrackerReplayPanel = {
    statOf,
    sumStat,
    visualLabel,
    visualStateCell,
    playable,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerReplayPanel;
}
