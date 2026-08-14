/* Rift Atlas Stats Tracker - the visual replay settings
 *
 * Three controls: whether to record at all, how many matches keep a recording,
 * and the byte ceiling that stops a runaway one. None of them is read here -
 * the recorder reads them out of storage at match start and the service worker
 * reads the retention count at every gc - so what this file owns is only the
 * painting of the fields and the clamping of what is typed into them.
 *
 * The clamps are settings-clamps.js, where they are pure and tested, because a
 * number input's min/max constrain its spinner and nothing else: anything at
 * all can be pasted into one, and these values reach a garbage collector that
 * deletes recordings. The shipped defaults are storage.js's.
 *
 * The Replays panel prices retention from the keep count, so setting it is also
 * telling that panel to repaint - which is why this file knows about it.
 */
(function (root) {
  "use strict";

  const CLAMP = root.RATrackerSettingsClamps || require("./settings-clamps.js");
  const STORE = () => root.RATrackerStorage;
  const REPLAYS = () => root.RATrackerViewReplays;

  const { KEEP_MIN, KEEP_MAX, CEILING_MIN_MB, CEILING_MAX_MB } = CLAMP;

  const $ = (s) => document.querySelector(s);
  const on = (sel, type, fn) => {
    const el = $(sel);
    if (el) el.addEventListener(type, fn);
    return el;
  };

  const clampKeep = (v) => CLAMP.clampKeep(v, STORE().defaultSettings.visualReplayKeepMatches);
  const clampCeiling = (v) => CLAMP.clampCeiling(v, STORE().defaultSettings.visualReplayMaxMatchMb);

  /** Paint all three fields from storage, and re-price retention. */
  function refresh() {
    // The spinners' bounds come from the constants above so the two can't drift.
    const keep = $("#visualKeep");
    const ceiling = $("#visualCeiling");
    if (keep) {
      keep.min = String(KEEP_MIN);
      keep.max = String(KEEP_MAX);
    }
    if (ceiling) {
      ceiling.min = String(CEILING_MIN_MB);
      ceiling.max = String(CEILING_MAX_MB);
    }
    STORE().getSettings((s) => {
      const enabled = $("#visualEnabled");
      if (enabled) enabled.checked = s.visualReplayEnabled !== false;
      // Read whether or not the field exists: the diagnostics panel projects
      // disk use from it, and that projection outlives this card's markup.
      const kept = clampKeep(s.visualReplayKeepMatches);
      if (keep) keep.value = kept;
      const mb = clampCeiling(s.visualReplayMaxMatchMb);
      // blank, not 0, is what "no limit" looks like
      if (ceiling) ceiling.value = mb > 0 ? mb : "";
      // The panel projects disk use from the retention count, so it has to be
      // redrawn whenever that number changes.
      REPLAYS().setKeepMatches(kept);
    });
  }

  function mount() {
    on("#visualEnabled", "change", (e) => {
      const enabled = e.target.checked;
      STORE().getSettings((s) => {
        s.visualReplayEnabled = enabled;
        STORE().setSettings(s);
      });
    });

    on("#visualKeep", "change", (e) => {
      const n = clampKeep(e.target.value);
      e.target.value = n; // show what was actually stored, clamp included
      STORE().getSettings((s) => {
        s.visualReplayKeepMatches = n;
        STORE().setSettings(s, refresh);
      });
    });

    on("#visualCeiling", "change", (e) => {
      const mb = clampCeiling(e.target.value);
      e.target.value = mb > 0 ? mb : "";
      STORE().getSettings((s) => {
        s.visualReplayMaxMatchMb = mb;
        STORE().setSettings(s);
      });
    });
  }

  root.RATrackerSettingsCapture = { refresh, mount };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerSettingsCapture;
}
