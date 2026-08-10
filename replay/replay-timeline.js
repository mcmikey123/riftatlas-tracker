/* Rift Atlas Stats Tracker - replay timeline helpers
 *
 * The arithmetic behind a replay's transport: which moments are settled board
 * states, how many of them a chip row can show, how far a truncated capture
 * actually got, and what scale the board is drawn at.
 *
 * Pure by construction: no DOM, no escaping, no chrome APIs, no rrweb. Callers
 * escape whatever they interpolate into markup, so the same functions serve the
 * extension dashboard and the standalone share viewer.
 */
(function (root) {
  "use strict";

  const FULL_SNAPSHOT = 2; // rrweb EventType.FullSnapshot
  const CUSTOM = 5; // rrweb EventType.Custom
  const MAX_CHIPS = 30; // more than this and the chip row stops being scannable

  /**
   * Captures are ~1280x800, so on anything bigger than a laptop panel a replay
   * that refused to pass 1:1 would sit in one corner of the screen — which is
   * the complaint fullscreen exists to answer. Upscaling is therefore allowed,
   * capped at 2x: the board is DOM text that the compositor re-rasters at the
   * transform's scale, so it stays sharp, but past 2x there is no more detail
   * in the capture to reveal and the card art is only getting blurrier.
   */
  const MAX_SCALE = 2;
  /**
   * Scale is quantised to this step, and snapped to exactly 1 whenever it lands
   * within one step of it. 1:1 is the one ratio where every captured pixel maps
   * onto one device pixel with no resampling at all, so it is worth a percent
   * of unused room; the quantising itself stops a drag-resize from re-rastering
   * the iframe at a new fractional scale on every single frame.
   */
  const SCALE_STEP = 0.01;

  /** The scale to render at, given how much room the raw fit would allow. */
  function quantise(raw) {
    const capped = Math.min(raw, MAX_SCALE);
    if (Math.abs(capped - 1) < SCALE_STEP) return 1;
    // Floored, never rounded: a scale above the raw fit would overflow the stage.
    return Math.max(SCALE_STEP, Math.floor(capped / SCALE_STEP) * SCALE_STEP);
  }

  /** Turn number carried by an rrweb custom event, or null if it isn't one. */
  function turnOf(event) {
    if (!event || event.type !== CUSTOM || !event.data) return null;
    if (!/turn/i.test(String(event.data.tag || ""))) return null;
    const p = event.data.payload || {};
    const n = p.turnNumber != null ? p.turnNumber : p.turn;
    return Number.isFinite(Number(n)) ? Number(n) : null;
  }

  /**
   * Settled board states, as ms from the first event. Recorder-supplied turn
   * markers win; otherwise every full snapshot is one, which is what the
   * recorder takes on each turn change.
   */
  function timeline(events) {
    // No events, no board states. Both callers happen to guard on a minimum
    // length before they get here, but this is an exported pure helper and
    // reading events[0] out of an empty list is not its caller's problem.
    if (!events || !events.length) return [];
    const t0 = events[0].timestamp || 0;
    const marked = [];
    for (const e of events) {
      const turn = turnOf(e);
      if (turn !== null) marked.push({ ms: (e.timestamp || t0) - t0, turn });
    }
    if (marked.length) return marked;
    const frames = [];
    for (const e of events) {
      if (e && e.type === FULL_SNAPSHOT) {
        frames.push({ ms: (e.timestamp || t0) - t0, turn: frames.length + 1 });
      }
    }
    return frames;
  }

  /** At most `max` entries, evenly spaced, first and last always kept. */
  function evenly(marks, max) {
    if (marks.length <= max) return marks;
    const step = (marks.length - 1) / (max - 1);
    const out = [];
    for (let n = 0; n < max; n++) out.push(marks[Math.round(n * step)]);
    return out;
  }

  /** Banner copy for a capture that stopped before the match did. */
  function truncationText(meta, match, marks) {
    const last = marks.length ? marks[marks.length - 1].turn : null;
    const coveredTo = Number.isFinite(Number(meta.truncatedAtTurn)) ? Number(meta.truncatedAtTurn) : last;
    const turns = Number(match && match.turns);
    if (coveredTo == null) return "This replay stops before the end of the match.";
    const covered = `This replay covers turns 1–${coveredTo}`;
    return Number.isFinite(turns) && turns > coveredTo
      ? `${covered} of ${turns}; capture ran out of budget after that`
      : `${covered} of this match`;
  }

  // Same dual export as store/css-assets.js: a global for the browser, CommonJS
  // for `node --test`.
  const api = {
    FULL_SNAPSHOT,
    CUSTOM,
    MAX_CHIPS,
    MAX_SCALE,
    SCALE_STEP,
    quantise,
    turnOf,
    timeline,
    evenly,
    truncationText,
  };

  root.RAReplayTimeline = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
