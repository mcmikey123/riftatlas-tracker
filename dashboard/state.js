/* Rift Atlas Stats Tracker - the dashboard's state, in one place
 *
 * This replaces a handful of module-level Maps and Sets that lived at the top
 * of the old dashboard.js. They were the right pattern - state held outside the
 * DOM survives a re-render, which is what stops an in-flight share or an open
 * row being lost when the table is rebuilt - but each one was private to the
 * file, and the redesign has six views that need to read them.
 *
 * So it is the same pattern, given a name and an address. Nothing here is
 * clever: it is a plain object, plus a way to be told when it changed.
 *
 * What is NOT here: the match array itself, and anything else that lives in
 * chrome.storage. Views read those through storage.js, which is the only thing
 * allowed to write them.
 */

/* Which of these survive a reload, and which do not, is a judgement about
 * whether the user would be surprised to find it still set. The view is
 * remembered - coming back to the tab you left is the point. Filters, sort and
 * search are not: arriving at a dashboard that is silently hiding most of your
 * history because of something you typed last week is a bug report waiting to
 * happen. */
export const state = {
  view: "overview",

  filters: {
    champion: "",
    deck: "",
    mode: "",
    dateRange: { preset: "all", from: null, to: null },
    countUnknown: false,
  },

  /* Matches and Series each own one of these. Kept separate so sorting one
   * table does not reorder the other, and so paging through Matches does not
   * drop you onto page 4 of a Series table that has two pages. */
  tables: {
    matches: { sortKey: "date", sortDir: "desc", search: "", page: 1 },
    series: { sortKey: "date", sortDir: "desc", search: "", page: 1 },
  },

  // Which rows are expanded. Ids, not elements, so they survive a re-render,
  // and survive being paginated away and back.
  openRows: new Set(),
  openSeries: new Set(),

  // Checked rows in Matches, for grouping a series by hand.
  selection: new Set(),

  // Which row's ⋯ menu is open. One at a time - two open menus in a table is
  // never what was meant by the second click.
  openRowMenu: null,

  /* matchId -> { phase, link, createdAt, reuse, error, retry }.
   * ONE entry per match, read by both the row's panel and the replay modal, so
   * a share begun in the row shows the same phase when the modal opens over it. */
  shares: new Map(),

  // objectId -> { busy } or a describeRecheck() result.
  recheck: new Map(),

  // Suggestion keys the user has said "not a series" to. Mirrored from
  // settings, because an in-memory set would re-offer the same pair on reload.
  dismissedSuggestions: new Set(),

  // Set while a dialog is open. storage.onChanged defers its reload until it
  // clears - see main.js for why that matters.
  dialogOpen: false,

  // Mirrored from storage so the Series view can describe its own window in
  // the suggestion strip without re-reading settings on every render.
  seriesSettings: {},

  readOnly: false,
  archiveName: "",
};

const listeners = new Set();

/** Subscribe to "something changed, repaint". Returns an unsubscribe. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let queued = false;

/**
 * Ask for a repaint.
 *
 * Coalesced to one per microtask: a single user action routinely touches state
 * three or four times - clear the selection, reset the page, change the sort -
 * and each one repainting would rebuild the table three or four times and throw
 * away the first two. Callers can therefore emit freely without thinking about
 * how many times they are doing it.
 */
export function emit() {
  if (queued) return;
  queued = true;
  Promise.resolve().then(() => {
    queued = false;
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        // One view throwing must not stop the others repainting, and must not
        // leave the queue flag stuck.
        console.error("[RA-Tracker] a view failed to render:", err);
      }
    }
  });
}

/** Repaint now, skipping the coalescing. For teardown paths that cannot wait. */
export function emitNow() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error("[RA-Tracker] a view failed to render:", err);
    }
  }
}

/** The table state for whichever table a view owns. */
export const tableFor = (name) => state.tables[name] || state.tables.matches;

/**
 * Reset paging after anything that can shrink the row set.
 *
 * Called on every filter, search and sort change. Without it, narrowing the set
 * while on page 3 leaves the page number pointing past the end - paginate()
 * clamps for the render, but the stored page stays wrong and the next widening
 * jumps somewhere the user did not ask for.
 */
export function resetPaging() {
  state.tables.matches.page = 1;
  state.tables.series.page = 1;
}
