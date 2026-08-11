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
import { renderSeries, mountSeries } from "./view-series.js";
import * as dialog from "./dialog.js";
import { toast } from "./toast.js";

/* legacy.js is a classic script and cannot import a module, so the two
 * components it needs are published on window for it. This is the only bridge
 * that goes module -> classic, and it disappears with legacy.js.
 *
 * Timing is safe: modules are deferred, so this runs after legacy.js's
 * top-level code - but everything over there that opens a dialog does so from
 * an event handler, which cannot fire before the page is interactive.
 *
 * The wrapper is what makes the deferred reload work. A dialog no longer
 * blocks the event loop the way confirm() did, so a storage change arriving
 * while one is open would reload the match array out from under the decision
 * being made - and legacy.js reassigns `all` to fresh objects, so a target list
 * captured before the dialog would then be mutating orphans. legacy.js parks
 * the reload while a dialog is up; this is what releases it afterwards. */
let deferredReload = null;

const flushDeferred = () => {
  if (dialog.isOpen() || !deferredReload) return;
  const run = deferredReload;
  deferredReload = null;
  run();
};

const wrap = (fn) => (...args) => fn(...args).finally(flushDeferred);

window.RATrackerDialog = {
  isOpen: dialog.isOpen,
  open: wrap(dialog.open),
  confirm: wrap(dialog.confirm),
  alert: wrap(dialog.alert),
  textPrompt: wrap(dialog.textPrompt),
  /** legacy.js hands its reload here instead of running it under a dialog. */
  defer(run) {
    deferredReload = run;
  },
};
window.RATrackerToast = toast;

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
  renderSeries($("[data-series]"), withSeries, state.readOnly);
  paintSettings();
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

}

// ---- Settings ----------------------------------------------------------

/* The data controls appear both in the header and in Settings on purpose: the
 * header for speed, Settings with the explanation beside them. Rather than two
 * sets of handlers that could drift, the ones in Settings forward the click to
 * the header button that already owns the behaviour. */
function mountSettings() {
  document.addEventListener("click", (e) => {
    const proxy = e.target.closest?.("[data-proxy]");
    if (!proxy || proxy.disabled) return;
    const target = document.getElementById(proxy.dataset.proxy);
    if (target) target.click();
  });

  const detect = $("#sDetect");
  const window_ = $("#sWindow");

  if (detect) {
    detect.addEventListener("change", () =>
      STORE.patchSettings({ seriesDetect: detect.checked })
    );
  }
  if (window_) {
    window_.addEventListener("change", () => {
      // Clamped rather than rejected: the input's own min/max only constrain
      // its spinner, not what can be typed or pasted into it.
      const n = SERIES.clampWindow(window_.value);
      window_.value = n;
      STORE.patchSettings({ seriesWindowMinutes: n });
    });
  }
}

/** Settings controls this module owns, painted from whatever storage holds. */
function paintSettings() {
  const detect = $("#sDetect");
  const window_ = $("#sWindow");
  if (detect) detect.checked = settings.seriesDetect !== false;
  if (window_ && document.activeElement !== window_) {
    window_.value = SERIES.clampWindow(settings.seriesWindowMinutes);
  }

  const all = LEGACY.matches() || [];

  /* The gap rule only applies to matches recorded before content.js began
   * reading the format off the lobby. On a fresh install that is none of them,
   * and for everyone else it is a set that only shrinks - so the control
   * appears while it can still change something and goes away once it cannot,
   * rather than sitting there permanently inert. */
  const formatless = all.filter((m) => m && !m.matchFormat).length;
  const windowRow = $("[data-legacy-window]");
  if (windowRow) windowRow.hidden = formatless === 0;
  const windowNote = $("[data-legacy-count]");
  if (windowNote) {
    windowNote.textContent =
      formatless === 1
        ? "1 match was recorded before the format was read from the lobby."
        : `${formatless} matches were recorded before the format was read from the lobby.`;
  }

  const status = $("[data-series-status]");
  if (!status) return;
  const grouped = SERIES.group(
    SERIES.detect(all, {
      enabled: settings.seriesDetect !== false,
      windowMinutes: settings.seriesWindowMinutes,
      format: settings.seriesFormatDefault,
    }).matches
  );
  const byHand = grouped.filter((s) => s.source === "manual").length;
  status.textContent = `${grouped.length} series · ${byHand} you grouped yourself`;
}

// ---- boot --------------------------------------------------------------

function boot() {
  mountShell();
  mountFilters();
  mountMatches();
  mountSeries();
  mountSettings();
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
    state.seriesSettings = s;
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
      state.seriesSettings = s;
      emit();
    });
  });
}

boot();
