/* Rift Atlas Stats Tracker - the Series view
 *
 * One row per series, expandable into its games.
 *
 * The tiles are the reason this view exists. Series win rate against game win
 * rate, how often you recover after dropping game one, and how often you reach
 * a decider are all things the existing data already contains and the current
 * dashboard cannot show.
 *
 * Automatic grouping is DERIVED, never stored - see dashboard/series.js and the
 * design document. What this file writes is only what the user does by hand:
 * grouping a selection, removing a game, changing one series' format. Each of
 * those is stamped seriesSource 'manual' and is then left alone by every later
 * pass, which is the same contract deckSource and resultSource already use.
 */
import { state, emit } from "./state.js";

const S = window.RATrackerSeries;
const T = window.RATrackerTable;
const STORE = window.RATrackerStorage;
const { esc, champ, fmtDuration, fmtDay, fmtTime, fmtScore, fmtPercent } = window.RATrackerFormat;

const LEGACY = () => window.RATrackerLegacy;

export const GRID = "30px 126px 1fr 78px 96px 104px 190px 72px 36px";

/* Four results, not two. "Unfinished" is a real outcome - a 1-1 Bo3 somebody
 * walked away from - and "in game" means a live match belongs to it, so its
 * total length is not a number yet. */
const RESULT_LABEL = {
  win: "Series win",
  loss: "Series loss",
  unfinished: "Unfinished",
  live: "In game",
};
const RESULT_DOT = { win: "win", loss: "loss", unfinished: "draw", live: "accent" };

// ---- which series a render shows ---------------------------------------

/**
 * The series present, after the global filters.
 *
 * A champion or deck filter keeps a series when ANY of its games matches. That
 * is the only odd rule here and it is deliberate: a series is a unit, and
 * showing two thirds of one would make the games column contradict the result
 * column beside it.
 */
export function visibleSeries(all) {
  const t = state.tables.series;
  const f = state.filters;

  let list = S.group(all);

  if (f.champion) {
    list = list.filter((s) => s.games.some((m) => champ(m.myChampion || m.myLegend) === f.champion));
  }
  if (f.deck) {
    list = list.filter((s) => s.games.some((m) => ((m.deckName || "").trim() || "Unlabelled") === f.deck));
  }
  if (f.mode) list = list.filter((s) => s.mode === f.mode);

  list = T.inRange(list, f.dateRange, "startedAt");
  list = T.search(list, t.search, ["opponentName", "mode", (s) => s.decks.join(" ")]);
  return T.sortBy(list, sortKeyFor(t.sortKey), t.sortDir);
}

function sortKeyFor(key) {
  switch (key) {
    case "opponent": return (s) => s.opponentName;
    case "format": return (s) => s.format;
    case "games": return (s) => s.wins + s.losses;
    case "result": return (s) => s.result;
    case "total": return (s) => s.totalMs;
    default: return (s) => Date.parse(s.startedAt || "") || null;
  }
}

const COLUMNS = [
  { key: "", label: "" },
  { key: "date", label: "Date" },
  { key: "opponent", label: "Opponent" },
  { key: "format", label: "Format" },
  { key: "games", label: "Games" },
  { key: "result", label: "Result" },
  { key: "", label: "Decks used" },
  { key: "total", label: "Total" },
  { key: "", label: "" },
];

// ---- rendering ---------------------------------------------------------

function tiles(stats) {
  /* Unfinished series count in the games figures but are excluded from the
   * series win rate - a series still in progress has not been won or lost, and
   * averaging it in either direction would be an invention. The tile says so
   * rather than leaving the two percentages looking inconsistent. */
  return `<div class="tiles">
    <div class="tile"><span class="tile-label">Series</span><span class="tile-value">${stats.series}</span></div>
    <div class="tile"><span class="tile-label">Series record</span>
      <span class="tile-row"><span class="tile-value win">${stats.wins}</span>
      <span class="tile-value dash">–</span><span class="tile-value loss">${stats.losses}</span></span></div>
    <div class="tile" title="Unfinished series are left out of this rate, but their games still count towards the games figure.">
      <span class="tile-label">Series win rate</span>
      <span class="tile-row"><span class="tile-value">${fmtPercent(stats.winRate)}</span>
      <span class="tile-sub">games ${fmtPercent(stats.gameWinRate)}</span></span></div>
    <div class="tile"><span class="tile-label">After losing game 1</span>
      <span class="tile-row"><span class="tile-value">${fmtPercent(stats.lostFirstRate)}</span>
      <span class="tile-sub">${stats.lostFirstRecovered} of ${stats.lostFirst}</span></span></div>
    <div class="tile"><span class="tile-label">Went to a decider</span>
      <span class="tile-row"><span class="tile-value">${stats.deciders}</span>
      <span class="tile-sub">of ${stats.series}</span></span></div>
  </div>`;
}

/* Proposed, never applied. A pair just outside the window is exactly the case
 * where guessing would be wrong often enough to matter, so it is offered with
 * both answers and the dismissal is remembered. */
function suggestionStrip(suggestion) {
  if (!suggestion) return "";
  return `<div class="suggestion">
    <span class="sugg-tag">Suggestion</span>
    <span class="sugg-text">2 matches against <b>${esc(suggestion.opponentName)}</b> on
      ${esc(fmtDay(suggestion.startedAt))} sit ${suggestion.gapMinutes} minutes apart — outside the
      ${suggestion.windowMinutes}-minute window, so they were left alone. Group them?</span>
    <span class="sugg-actions">
      <button class="btn btn-sm btn-primary" data-sugg-group="${esc(suggestion.key)}">Group as a Bo3</button>
      <button class="btn btn-sm btn-quiet" data-sugg-dismiss="${esc(suggestion.key)}">Not a series</button>
    </span>
  </div>`;
}

function seriesRow(s, readOnly) {
  const open = state.openSeries.has(s.id);
  const dates = `${fmtTime(s.startedAt)}${s.endedAt ? " – " + fmtTime(s.endedAt) : ""}`;
  return `<div class="srow ${open ? "on" : ""}">
    <span class="cell expander ${open ? "on" : ""}" data-sertoggle="${esc(s.id)}" role="button" tabindex="0">${open ? "▾" : "▸"}</span>
    <span class="cell cell-date"><span class="d1">${esc(fmtDay(s.startedAt))}</span><span class="d2">${esc(dates)}</span></span>
    <span class="cell cell-matchup"><span class="d1">${esc(s.opponentName || "—")}</span>
      <span class="d2">${esc(s.mode || "—")}${s.source === "manual" ? " · grouped by you" : ""}</span></span>
    <span class="cell"><span class="series-badge">${esc(s.format.toUpperCase())}</span></span>
    <span class="cell num"><span class="win">${s.wins}</span>–<span class="loss">${s.losses}</span></span>
    <span class="cell"><span class="ser-result"><span class="dot dot-${RESULT_DOT[s.result]}"></span>${esc(RESULT_LABEL[s.result])}</span></span>
    <span class="cell dim decks">${esc(s.decks.join(", "))}</span>
    <span class="cell num dim">${s.totalMs === null ? "—" : esc(fmtDuration(s.totalMs))}</span>
    <span class="cell"></span>
  </div>`;
}

/* The games are inserted as sunk sub-rows IN THE SAME GRID, so the columns stay
 * aligned with the series rows around them. Each keeps its own result editor
 * and its own way back out of the series. */
function gameRows(s, readOnly) {
  return s.games
    .map((m) => {
      const decider = s.decider === m.id;
      return `<div class="grow">
      <span class="cell"></span>
      <span class="cell cell-date ${decider ? "is-decider" : ""}">
        <span class="d1">G${esc(m.seriesGame == null ? "?" : m.seriesGame)}${decider ? " ●" : ""}</span>
        <span class="d2">${esc(fmtTime(m.startedAt))}</span></span>
      <span class="cell cell-matchup"><span class="d1">
        <span class="dot dot-${RESULT_DOT[m.result === "win" ? "win" : m.result === "loss" ? "loss" : "unfinished"]}"></span>
        ${esc(champ(m.myChampion || m.myLegend))} <span class="vs">vs</span> ${esc(champ(m.opponentChampion || m.opponentLegend))}</span></span>
      <span class="cell num">${esc(fmtScore(m))}</span>
      <span class="cell dim">${esc(m.result || "unknown")}</span>
      <span class="cell num dim">${esc(fmtDuration(m.durationMs, "—"))}</span>
      <span class="cell dim decks">${esc((m.deckName || "").trim() || "— unlabelled —")}</span>
      <span class="cell">${
        LEGACY().hasVisual(m.id)
          ? `<button class="link" data-visual="${esc(m.id)}">replay</button>`
          : '<span class="none">none</span>'
      }</span>
      <span class="cell cell-more">${
        readOnly ? "" : `<button class="row-more" data-serremove="${esc(m.id)}" title="Remove from series">✕</button>`
      }</span>
    </div>`;
    })
    .join("");
}

export function renderSeries(container, all, readOnly) {
  if (!container) return;
  const list = visibleSeries(all);
  const stats = S.stats(list);

  const settings = state.seriesSettings || {};
  const suggestions = S.suggestions(all, {
    windowMinutes: settings.seriesWindowMinutes,
    dismissed: state.dismissedSuggestions,
  });

  container.innerHTML = `
    ${tiles(stats)}
    ${suggestionStrip(suggestions[0])}
    <div class="card">
      <div class="mtable" style="--mgrid:${GRID}">
        <div class="mhead">
          ${COLUMNS.map((c) =>
            c.key
              ? `<button class="cell msort ${state.tables.series.sortKey === c.key ? "on" : ""}" data-sersort="${c.key}">${esc(c.label)}${
                  state.tables.series.sortKey === c.key ? (state.tables.series.sortDir === "asc" ? " ↑" : " ↓") : ""
                }</button>`
              : `<span class="cell">${esc(c.label)}</span>`
          ).join("")}
        </div>
        ${
          list.length
            ? list.map((s) => seriesRow(s, readOnly) + (state.openSeries.has(s.id) ? gameRows(s, readOnly) : "")).join("")
            : `<div class="mempty">${
                (all || []).length
                  ? "No series yet. Play two matches against the same opponent back to back, or select matches in Matches and group them."
                  : "Play a match on play.riftatlas.com with the extension installed."
              }</div>`
        }
      </div>
    </div>`;
}

// ---- the writes this view owns -----------------------------------------

/* Everything below writes, and everything below is a deliberate user action.
 * All of them go through storage.js, which refuses while an archive is open. */

/* The stored array carries series fields only where the user grouped by hand.
 * An edit aimed at a DERIVED series therefore has nothing to match on, so the
 * fields are materialised first, the edit runs against those, and stripAuto
 * puts everything the edit did not claim back to being derived. Without this,
 * "Remove from series" silently did nothing on every automatically detected
 * series - which is almost all of them. */
function editable() {
  return S.detect(LEGACY().matches(), {
    enabled: state.seriesSettings.seriesDetect !== false,
    windowMinutes: state.seriesSettings.seriesWindowMinutes,
    format: state.seriesSettings.seriesFormatDefault,
  }).matches;
}

function persist(matches, then) {
  try {
    STORE.writeMatches(matches, then);
  } catch (err) {
    // The only expected throw is the archive-mode refusal, which the disabled
    // controls should already have prevented. Reaching here is a bug, not a
    // user error, so it is logged rather than dressed up as a message.
    console.error("[RA-Tracker] refused a series write:", err);
  }
}

export function groupSelection(format) {
  const ids = [...state.selection];
  if (ids.length < 2) return;
  // The RAW stored array, not the one main.js decorated for rendering, so the
  // derived automatic fields are never written to storage.
  const { matches } = S.groupManually(LEGACY().matches(), ids, format);
  persist(matches, () => {
    state.selection.clear();
    emit();
  });
}

export function mountSeries() {
  document.addEventListener("click", (e) => {
    const toggle = e.target.closest?.("[data-sertoggle]");
    if (toggle) {
      const id = toggle.dataset.sertoggle;
      if (state.openSeries.has(id)) state.openSeries.delete(id);
      else state.openSeries.add(id);
      emit();
      return;
    }

    const sort = e.target.closest?.("[data-sersort]");
    if (sort) {
      const t = state.tables.series;
      const key = sort.dataset.sersort;
      if (t.sortKey === key) t.sortDir = t.sortDir === "asc" ? "desc" : "asc";
      else {
        t.sortKey = key;
        t.sortDir = "desc";
      }
      emit();
      return;
    }

    const group = e.target.closest?.("[data-groupseries]");
    if (group) {
      groupSelection(group.dataset.groupseries);
      return;
    }

    const remove = e.target.closest?.("[data-serremove]");
    if (remove) {
      // Removing renumbers what is left, and a series that would be left with
      // one game dissolves rather than leaving a lone match wearing a G1 badge.
      persist(S.stripAuto(S.removeFromSeries(editable(), remove.dataset.serremove)), emit);
      return;
    }



    const suggGroup = e.target.closest?.("[data-sugg-group]");
    if (suggGroup) {
      const ids = suggGroup.dataset.suggGroup.split("|");
      const { matches } = S.groupManually(LEGACY().matches(), ids, "bo3");
      persist(matches, emit);
      return;
    }

    const dismiss = e.target.closest?.("[data-sugg-dismiss]");
    if (dismiss) {
      state.dismissedSuggestions.add(dismiss.dataset.suggDismiss);
      // Persisted, or the same pair is offered again on the next reload.
      STORE.patchSettings({ seriesDismissed: [...state.dismissedSuggestions] }, emit);
      return;
    }
  });

  /* Same as the Matches expander: a <span role="button" tabindex="0"> takes
   * focus and announces itself as a button, but a span is activated by nothing
   * the platform provides. Forwarded to the click branch above so there stays
   * one place that opens a series. */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const toggle = e.target.closest?.("[data-sertoggle]");
    if (!toggle) return;
    e.preventDefault(); // Space would otherwise scroll the page.
    toggle.click();
  });
}
