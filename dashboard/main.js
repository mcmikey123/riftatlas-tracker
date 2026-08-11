/* Rift Atlas Stats Tracker - dashboard entry point
 *
 * The module half of the dashboard starts here. Everything above it in
 * dashboard.html is a classic script, and classic scripts all run before any
 * module does - modules are deferred by default - so every window.RA* global is
 * present by the time this file's first line executes. That ordering is the
 * whole reason the split needs no bundler.
 *
 * legacy.js still owns several views and the match array behind them. It is
 * being drained one view at a time, and it publishes what the shell needs
 * through window.RATrackerLegacy. Each entry there disappears as its view is
 * ported.
 */
import { state, subscribe, emit, resetPaging } from "./state.js";
import { mountShell, paintShell, VIEWS } from "./shell.js";
import { renderMatches, mountMatches } from "./view-matches.js";

const STORE = window.RATrackerStorage;
const SERIES = window.RATrackerSeries;
const LEGACY = window.RATrackerLegacy;

const $ = (s) => document.querySelector(s);

/* Settings the shell reads. Held here rather than re-read on every paint,
 * because a paint happens every three seconds while a match is live and
 * chrome.storage.get is asynchronous - a render that had to wait for it would
 * paint the previous values and then flicker. */
let settings = STORE.defaultSettings;

// ---- what the nav shows ------------------------------------------------

function counts() {
  const all = LEGACY.matches() || [];
  const records = LEGACY.visualRecords() || [];
  const assets = LEGACY.visualAssets() || { bytes: 0 };

  /* Automatic series are derived, never stored, so this is simply a
   * computation over the current matches - the same call the Series view will
   * make. See docs/specs: persisting them would fight content.js's three-second
   * save for the live match. */
  const detected = SERIES.detect(all, {
    enabled: settings.seriesDetect !== false,
    windowMinutes: settings.seriesWindowMinutes,
    format: settings.seriesFormatDefault,
  }).matches;

  const bytes = records.reduce((n, r) => n + (Number(r.compressedBytes) || 0), 0);

  return {
    matches: all.length,
    series: SERIES.group(detected).length,
    // Null until the service worker has answered, so the nav shows nothing
    // rather than claiming zero recordings exist.
    replays: records.length ? records.length : null,
    shares: (LEGACY.shares() || []).length || null,
    captureOn: settings.visualReplayEnabled !== false,
    keepMatches: LEGACY.keepMatches(),
    replayBytes: records.length ? bytes + (Number(assets.bytes) || 0) : null,
  };
}

/* The filter row is static DOM shared by every view, and legacy.js reads it
 * straight off the elements. Rather than two sources of truth, the values are
 * copied into state on each render - one direction, from the controls the user
 * touched to the state the views read. */
function syncFilters() {
  const read = (id) => {
    const el = $(id);
    return el ? el.value : "";
  };
  state.filters.champion = read("#fMyChampion");
  state.filters.deck = read("#fDeck");
  state.filters.mode = read("#fMode");
  const unknown = $("#fUnknown");
  state.filters.countUnknown = !!(unknown && unknown.checked);
}

function render() {
  syncFilters();
  paintShell(counts());

  const all = LEGACY.matches() || [];
  /* Series are derived, so the badge in Matches reads the same computation the
   * Series view will - not a stored field. */
  const withSeries = SERIES.detect(all, {
    enabled: settings.seriesDetect !== false,
    windowMinutes: settings.seriesWindowMinutes,
    format: settings.seriesFormatDefault,
  }).matches;

  /* Unknown results are excluded from the STATS by the filter checkbox, but the
   * history has always listed them regardless - a match whose result was never
   * read is exactly the one you came here to fix. */
  renderMatches($("[data-matches]"), withSeries, state.readOnly);
}

// ---- the filter row ----------------------------------------------------

/* legacy.js already wires the four original filters through its own delegated
 * change handler, keyed on their ids - which is why the redesign kept those
 * ids. What is wired here is only what is new: the date range and the search
 * field, neither of which legacy.js knows about. */
function mountFilters() {
  const dates = $("#fDates");
  const custom = $("[data-custom-range]");
  const search = $("#fSearch");
  const clear = $("[data-search-clear]");

  const syncRange = () => {
    const preset = dates ? dates.value : "all";
    if (custom) custom.hidden = preset !== "custom";
    state.filters.dateRange = {
      preset,
      from: $("#fFrom") ? $("#fFrom").value : null,
      to: $("#fTo") ? $("#fTo").value : null,
    };
    resetPaging();
    emit();
  };

  if (dates) dates.addEventListener("change", syncRange);
  for (const id of ["#fFrom", "#fTo"]) {
    const el = $(id);
    if (el) el.addEventListener("change", syncRange);
  }

  const syncSearch = () => {
    const term = search ? search.value : "";
    state.tables.matches.search = term;
    state.tables.series.search = term;
    if (clear) clear.hidden = !term;
    resetPaging();
    emit();
  };
  if (search) search.addEventListener("input", syncSearch);
  if (clear) {
    clear.addEventListener("click", () => {
      if (search) search.value = "";
      syncSearch();
      if (search) search.focus();
    });
  }

  const format = $("#fFormat");
  if (format) {
    format.addEventListener("change", () => {
      state.filters.format = format.value;
      resetPaging();
      emit();
    });
  }
}

// ---- boot --------------------------------------------------------------

function boot() {
  mountShell();
  mountFilters();
  mountMatches();
  subscribe(render);

  /* legacy.js renders on its own schedule - on load, on every storage change,
   * and after each of its own writes. Rather than duplicating that, the shell
   * repaints on the back of it, which also guarantees the nav counts are drawn
   * from the same match array the tables were just drawn from. */
  LEGACY.onRender = () => {
    state.readOnly = LEGACY.readOnly();
    state.archiveName = LEGACY.archiveName();
    emit();
  };

  STORE.getSettings((s) => {
    settings = s;
    state.view = VIEWS.indexOf(s.view) === -1 ? "overview" : s.view;
    state.dismissedSuggestions = new Set(s.seriesDismissed || []);
    emit();
  });

  // Settings change from Settings, and from the header's own controls. Re-read
  // rather than tracked, because several of them are written by legacy.js.
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.settings) return;
    STORE.getSettings((s) => {
      settings = s;
      emit();
    });
  });
}

boot();
