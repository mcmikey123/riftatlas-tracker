/* Rift Atlas Stats Tracker - the shell
 *
 * The frame every view sits in: the header and its menus, the left nav and its
 * counts, the capture card, and view switching.
 *
 * Two things here are less obvious than they look.
 *
 * The FILTER ROW IS STATIC DOM and nothing in this file rewrites it. The
 * dashboard re-renders whenever chrome.storage changes, and content.js saves
 * the live match every three seconds, so a filter row rebuilt on each render
 * would take the caret out of the search field roughly twenty times a minute.
 * Only the values it did not author - the champion, deck and mode option lists
 * - are refreshed, and those preserve the current selection.
 *
 * In ARCHIVE MODE, Replays and Shared links are REMOVED from the nav rather
 * than disabled. Neither has any meaning against an archive file: it carries no
 * recordings, and its matches have no relationship to what was shared from this
 * browser. A disabled item says "not now"; these are "not applicable".
 */
import { state, emit } from "./state.js";

const STORE = window.RATrackerStorage;
const { esc, fmtBytes } = window.RATrackerFormat;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

export const VIEWS = ["overview", "matches", "series", "replays", "shares", "settings"];

/* Hidden in archive mode rather than disabled - see the header comment. */
const LIVE_ONLY = new Set(["replays", "shares"]);

// ---- view switching ----------------------------------------------------

export function setView(view) {
  const next = VIEWS.indexOf(view) === -1 ? "overview" : view;
  if (state.view === next) return;
  state.view = next;
  // Remembered so a reload comes back where it left off. Settings, not a
  // separate key: it is a preference about this browser, and it stays writable
  // in archive mode because it is not match data.
  STORE.patchSettings({ view: next });
  emit();
}

/** Show one view, hide the rest. Cheap enough to run on every render. */
function paintViews() {
  // An archive has no Replays or Shared links, so a view persisted from a live
  // session must not strand the user on a blank pane.
  if (state.readOnly && LIVE_ONLY.has(state.view)) state.view = "overview";

  for (const section of $$(".view")) {
    section.hidden = section.dataset.view !== state.view;
  }
  for (const item of $$(".nav-item")) {
    const on = item.dataset.goto === state.view;
    item.classList.toggle("on", on);
    item.setAttribute("aria-current", on ? "page" : "false");
  }

  // The filter row is shared, but two of its controls are not: Format belongs
  // to Series, and the search field to the two table views.
  const searchable = state.view === "matches" || state.view === "series";
  const wrap = $("[data-search-wrap]");
  const note = $("[data-filter-note]");
  if (wrap) wrap.hidden = !searchable;
  if (note) note.hidden = searchable;
  const format = $(".filter-series");
  if (format) format.hidden = state.view !== "series";
}

// ---- the nav -----------------------------------------------------------

/**
 * Counts beside each nav item, and the capture card.
 *
 * `counts` is supplied by whoever knows: main.js, which has the match array and
 * the service worker's reply. Anything it does not know is left blank rather
 * than shown as 0 - "Replays 0" and "Replays, not asked yet" are different
 * claims and only one of them is true before the worker answers.
 */
export function paintNav(counts) {
  for (const el of $$("[data-count]")) {
    const n = counts[el.dataset.count];
    el.textContent = n === null || n === undefined ? "" : String(n);
  }

  for (const item of $$("[data-nav-live]")) {
    item.hidden = state.readOnly;
  }

  paintCaptureCard(counts);
}

function paintCaptureCard(counts) {
  const card = document.querySelector(".capture-card");
  if (!card) return;
  // The card mirrors live settings. Against an archive there is nothing to
  // mirror, so it goes rather than describing a browser the file knows nothing
  // about.
  card.hidden = state.readOnly;
  if (card.hidden) return;

  const dot = card.querySelector("[data-capture-dot]");
  const text = card.querySelector("[data-capture-text]");
  const meta = card.querySelector("[data-capture-meta]");
  const on = counts.captureOn !== false;
  if (dot) dot.className = "dot " + (on ? "dot-win" : "dot-off");
  if (text) text.textContent = on ? "Visual replay on" : "Visual replay off";
  if (meta) {
    const keep = counts.keepMatches;
    // Until the worker has answered there is no byte figure, and inventing a
    // "0 MB on disk" would read as a measurement.
    meta.textContent =
      counts.replayBytes === null || counts.replayBytes === undefined
        ? `Keeping the newest ${keep}`
        : `Keeping the newest ${keep} · ${fmtBytes(counts.replayBytes)} on disk`;
  }
}

// ---- menus -------------------------------------------------------------

/* Menus close on outside click, on Escape, and on choosing something. The
 * handlers are delegated from the document so a menu can be rebuilt without
 * rewiring, and so a click anywhere is a candidate for closing one. */
function closeMenus(except) {
  for (const list of $$("[data-menulist]")) {
    if (except && list.dataset.menulist === except) continue;
    list.hidden = true;
  }
  for (const btn of $$("[data-menubtn]")) {
    if (except && btn.dataset.menubtn === except) continue;
    btn.setAttribute("aria-expanded", "false");
  }
}

function toggleMenu(name) {
  const list = document.querySelector(`[data-menulist="${CSS.escape(name)}"]`);
  const btn = document.querySelector(`[data-menubtn="${CSS.escape(name)}"]`);
  if (!list || !btn) return;
  const open = list.hidden;
  closeMenus(open ? name : null);
  list.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

// ---- archive mode ------------------------------------------------------

/**
 * Reflect read-only state onto the page.
 *
 * `body.read-only` does the visual half in CSS - every control in a data view
 * drops to --ink-off with no hover. This adds the half CSS cannot do: the
 * `disabled` attribute, so the controls are also unreachable by keyboard and
 * announced as disabled rather than merely looking it.
 */
export function paintReadOnly() {
  document.body.classList.toggle("read-only", state.readOnly);

  for (const el of $$("[data-mutates]")) {
    el.disabled = state.readOnly;
  }
}

// ---- wiring ------------------------------------------------------------

export function mountShell() {
  document.addEventListener("click", (e) => {
    const goto = e.target.closest?.("[data-goto]");
    if (goto) {
      setView(goto.dataset.goto);
      return;
    }

    const menuBtn = e.target.closest?.("[data-menubtn]");
    if (menuBtn) {
      toggleMenu(menuBtn.dataset.menubtn);
      return;
    }

    // A menu item does its own thing - the ids inside are wired elsewhere -
    // but the menu should not stay open behind whatever it opened.
    if (e.target.closest?.(".menu-item")) {
      closeMenus();
      return;
    }

    // Anything else: an outside click.
    if (!e.target.closest?.(".menu")) closeMenus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Only if a menu is actually open, so Escape stays available to the modal
    // and the dialog, which own it when they are up.
    if ($$("[data-menulist]").some((l) => !l.hidden)) {
      closeMenus();
      e.stopPropagation();
    }
  });

  paintViews();
}

/** Called on every render. */
export function paintShell(counts) {
  paintViews();
  paintNav(counts);
  paintReadOnly();
}

export { closeMenus };
