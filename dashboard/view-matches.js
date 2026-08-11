/* Rift Atlas Stats Tracker - the Matches view
 *
 * The history table. Today's thirteen columns become twelve cells carrying the
 * same thirteen fields, plus a selection checkbox and a series badge, and gain
 * sorting, search, a date range and pagination - all client-side over the array
 * the page has already filtered. None of it touches storage or the schema.
 *
 * WHAT THIS FILE DOES NOT OWN. The rows it draws carry the same data-*
 * attributes legacy.js already listens for - data-toggle, data-deck, data-id,
 * data-notes, data-log, data-visual, data-share, data-del. Those listeners are
 * document-level, so a row drawn here is driven by handlers over there without
 * either side importing the other. That is what lets the port happen a view at
 * a time instead of in one commit, and it is why the attribute names are not
 * up for tidying.
 */
import { state, emit, resetPaging } from "./state.js";

const T = window.RATrackerTable;
const S = window.RATrackerSeries;
const {
  esc, champ, fmtDuration, fmtDay, fmtTime, fmtScore,
} = window.RATrackerFormat;

const LEGACY = () => window.RATrackerLegacy;

/* Twelve cells. The checkbox and the series badge are the two the handoff's
 * stated grid left out, having added both elsewhere in the same document. */
export const GRID = "26px 30px 128px 1fr 96px 128px 168px 62px 62px 104px 96px 36px";

const RESULTS = ["win", "loss", "draw", "unknown"];

/* Where a deck name came from. The dot is the colour; the sentence is what the
 * expanded row shows underneath the picker. Both survive - the handoff replaced
 * a tooltip with a dot and separately asked for one wording per source, and
 * dropping either would lose information that is on screen today. */
const DECK_SOURCE = {
  picker: {
    dot: "win",
    words: "The deck you had open in the picker, and its champion matched the board.",
  },
  "picker-unverified": {
    dot: "unknown",
    words: "The deck you had open in the picker. Its champion was never checked against the board, so it is a guess.",
  },
  board: { dot: "unknown", words: "Read off the game board, so it is whatever the board called it." },
  url: { dot: "unknown", words: "Read from the room URL, so it is a guess." },
  last: { dot: "unknown", words: "Assumed - it is the deck you played in your previous match." },
  fingerprint: { dot: "accent", words: "Matched by the cards you actually played during the match." },
  manual: { dot: "draw", words: "You typed this name, so nothing will overwrite it." },
};
const deckSourceOf = (m) => DECK_SOURCE[m.deckSource] || { dot: "unknown", words: "Where this name came from was not recorded." };

// ---- the rows a render works from --------------------------------------

/**
 * Filter, search, range and sort - in that order, and the order matters.
 *
 * The count above the table is taken after filtering and searching but before
 * paging, because "41 matches match your filters" is a claim about the whole
 * set, not about the page you happen to be on.
 */
export function visibleMatches(all) {
  const t = state.tables.matches;
  const f = state.filters;

  let rows = (all || []).filter((m) => {
    if (f.champion && champ(m.myChampion || m.myLegend) !== f.champion) return false;
    if (f.deck && ((m.deckName || "").trim() || "Unlabelled") !== f.deck) return false;
    if (f.mode && m.mode !== f.mode) return false;
    return true;
  });

  rows = T.inRange(rows, f.dateRange, "startedAt");
  rows = T.search(rows, t.search, [
    "opponentName",
    "roomCode",
    (m) => champ(m.myChampion || m.myLegend),
    (m) => champ(m.opponentChampion || m.opponentLegend),
    "deckName",
  ]);
  return T.sortBy(rows, sortKeyFor(t.sortKey), t.sortDir);
}

function sortKeyFor(key) {
  switch (key) {
    case "matchup": return (m) => champ(m.myChampion || m.myLegend);
    case "mode": return (m) => m.mode;
    case "deck": return (m) => (m.deckName || "").trim();
    case "score": return (m) => (m.myScore == null ? null : Number(m.myScore));
    case "length": return (m) => (Number.isFinite(m.durationMs) ? m.durationMs : null);
    case "result": return (m) => m.result;
    case "source": return (m) => (m.endedAt ? m.resultSource || "" : "in game");
    case "series": return (m) => m.seriesId || null;
    default: return (m) => Date.parse(m.startedAt || "") || null;
  }
}

const COLUMNS = [
  { key: "", label: "", sortable: false },
  { key: "", label: "", sortable: false },
  { key: "date", label: "Date" },
  { key: "matchup", label: "Matchup" },
  { key: "series", label: "Series" },
  { key: "mode", label: "Mode · Room" },
  { key: "deck", label: "Deck" },
  { key: "score", label: "Score" },
  { key: "length", label: "Length" },
  { key: "result", label: "Result" },
  { key: "source", label: "Source" },
  { key: "", label: "", sortable: false },
];

// ---- cells -------------------------------------------------------------

/* The series badge, in every state the handoff lists. A match in no series -
 * which is most of them - gets a flat dash rather than an empty cell, so the
 * column reads as "not in one" instead of "nothing rendered here". */
function seriesBadge(m, deciderIds) {
  if (!m.seriesId) return '<span class="series-none">—</span>';
  const fmt = (m.seriesFormat || "bo3").toUpperCase();
  const game = m.seriesGame == null ? "?" : m.seriesGame;
  const manual = m.seriesSource === "manual";
  const decider = deciderIds.has(m.id);
  const cls = [
    "series-badge",
    m.seriesGame == null ? "series-unordered" : "",
    decider ? "series-decider" : "",
  ].filter(Boolean).join(" ");
  return `<span class="${cls}" title="${manual ? "You grouped this, so detection leaves it alone" : "Detected automatically"}">${esc(fmt)} · G${esc(game)}${
    manual ? " ✓" : ""
  }${decider ? " ●" : ""}</span>`;
}

/* A native <select> wearing the chip's clothes, rather than a bespoke menu.
 * It keeps the data-deck attribute legacy.js already listens for, so choosing a
 * name still runs the single setDeckName path - and it gets keyboard handling,
 * type-ahead and the platform's own popup for free. The source dot sits beside
 * it because a <select> cannot carry one inside its own box. */
function deckCell(m, readOnly) {
  const name = (m.deckName || "").trim();
  const src = deckSourceOf(m);
  const names = LEGACY().deckNames();
  return `<span class="deck-chip ${name ? "" : "deck-chip-empty"}" title="${esc(src.words)}">
    ${name ? `<span class="dot dot-${src.dot}"></span>` : ""}
    <select class="deck-inline" data-deck="${esc(m.id)}" ${readOnly ? "disabled" : ""}
            aria-label="Deck for this match">
      <option value="" ${name ? "" : "selected"}>— unlabelled —</option>
      ${names.map((d) => `<option value="${esc(d)}" ${d === name ? "selected" : ""}>${esc(d)}</option>`).join("")}
      <option value=" new">＋ New deck name…</option>
    </select>
  </span>`;
}

/* The row's ⋯ menu. Delete lives here rather than as its own column, which is
 * where the thirteenth column went - so it keeps legacy.js's data-del
 * attribute and its confirm. Danger is last and is the only red item. */
function rowMenu(m, readOnly) {
  if (state.openRowMenu !== m.id) return "";
  return `<div class="menu-list menu-right row-menu" data-rowmenu-list>
    ${
      LEGACY().hasVisual(m.id)
        ? `<button class="menu-item" data-share="${esc(m.id)}">Share replay</button>`
        : ""
    }
    <button class="menu-item" data-copyid="${esc(m.id)}">Copy match id</button>
    ${readOnly ? "" : `<button class="menu-item menu-danger" data-del="${esc(m.id)}">Delete</button>`}
  </div>`;
}

function resultCell(m, readOnly) {
  // A live match has no result to edit yet, so it shows the dashed in-progress
  // chip. The editor is not removed - it moves into the expanded row, where
  // setting a result on a match still running is at least a deliberate act.
  if (!m.endedAt) return '<span class="chip chip-live">in progress</span>';
  const r = m.result || "unknown";
  return `<select class="chip chip-${esc(r)} result-edit result-${esc(r)}" data-id="${esc(m.id)}" ${readOnly ? "disabled" : ""}>
      ${RESULTS.map((v) => `<option value="${v}" ${v === r ? "selected" : ""}>${v}</option>`).join("")}
    </select>`;
}

function row(m, deciderIds, readOnly) {
  const open = state.openRows.has(m.id);
  const picked = state.selection.has(m.id);
  const live = !m.endedAt;
  return `<div class="mrow ${open ? "on" : ""} ${picked ? "picked" : ""}" data-row="${esc(m.id)}">
    <span class="cell cell-pick">
      <input type="checkbox" data-pick="${esc(m.id)}" ${picked ? "checked" : ""} ${readOnly ? "disabled" : ""}
             aria-label="Select this match" />
    </span>
    <span class="cell expander ${open ? "on" : ""}" data-toggle="${esc(m.id)}" role="button" tabindex="0"
          title="Show game summary">${open ? "▾" : "▸"}</span>
    <span class="cell cell-date"><span class="d1">${esc(fmtDay(m.startedAt))}</span><span class="d2">${esc(fmtTime(m.startedAt))}</span></span>
    <span class="cell cell-matchup">
      <span class="d1">${esc(champ(m.myChampion || m.myLegend))} <span class="vs">vs</span> ${esc(champ(m.opponentChampion || m.opponentLegend))}</span>
      <span class="d2">${esc(m.opponentName || "—")}</span>
    </span>
    <span class="cell">${seriesBadge(m, deciderIds)}</span>
    <span class="cell cell-mode"><span class="d1">${esc(m.mode || "—")}</span><span class="d2">${esc(m.roomCode || "—")}</span></span>
    <span class="cell cell-deck">${deckCell(m, readOnly)}</span>
    <span class="cell num">${esc(fmtScore(m))}</span>
    <span class="cell num dim">${live ? "—" : esc(fmtDuration(m.durationMs, "—"))}</span>
    <span class="cell">${resultCell(m, readOnly)}</span>
    <span class="cell cell-source">${
      live ? '<span class="src-live"><span class="dot dot-accent"></span>in game</span>' : esc(m.resultSource || "auto")
    }${m.notes ? '<span class="note-dot" title="Has notes">●</span>' : ""}</span>
    <span class="cell cell-more"><button class="row-more" data-rowmenu="${esc(m.id)}"
      aria-haspopup="true" aria-expanded="${state.openRowMenu === m.id}" aria-label="Row actions">⋯</button>${rowMenu(m, readOnly)}</span>
  </div>`;
}

// ---- the expanded row --------------------------------------------------

function detail(m, readOnly) {
  const legacy = LEGACY();
  const log = legacy.logFor(m.id);
  if (log === null) return `<div class="mdetail"><p class="coverage">Loading game log…</p></div>`;

  const a = legacy.analyse(Object.assign({}, m, { log }));
  const src = deckSourceOf(m);
  const metrics = a.hasLog
    ? `<table class="metrics">
        <thead><tr><th>Metric</th><th>You</th><th>Opp.</th></tr></thead>
        <tbody>
          <tr><td>Units committed to battlefields</td><td>${a.self.commit}</td><td>${a.opponent.commit}</td></tr>
          <tr><td>Battlefields conquered</td><td>${a.self.conquer}</td><td>${a.opponent.conquer}</td></tr>
          <tr><td>Points scored (from log)</td><td>${a.self.points}</td><td>${a.opponent.points}</td></tr>
          <tr><td>Cards sent to trash</td><td>${a.self.trash}</td><td>${a.opponent.trash}</td></tr>
          <tr><td>Showdown actions</td><td>${a.self.showdown}</td><td>${a.opponent.showdown}</td></tr>
          <tr><td>Focus passed</td><td>${a.self.passFocus}</td><td>${a.opponent.passFocus}</td></tr>
          <tr><td>Total logged actions</td><td>${a.self.total}</td><td>${a.opponent.total}</td></tr>
        </tbody>
      </table>
      <p class="coverage">Based on ${a.lines} log line${a.lines === 1 ? "" : "s"}${
        a.unmatched ? ` · ${a.unmatched} line${a.unmatched === 1 ? "" : "s"} not recognised by the parser` : ""
      }. Turns: ${esc(m.turns || "?")}.</p>`
    : `<p class="coverage">No game log was captured for this match.</p>`;

  // The verdict reads posture, not quality: Aggressive and Passive are both
  // readings. "No read" omits the coaching line rather than inventing one.
  const verdictClass = a.verdict.toLowerCase().replace(/\s+/g, "-");
  const logLines = (log || [])
    .map((e) => `<div class="log-line log-${esc(e.actor)}"><span class="log-t">${esc(e.t)}</span>${esc(e.text)}</div>`)
    .join("");

  return `<div class="mdetail">
    <div class="mdetail-col">
      <span class="block-label">Game summary</span>
      <div class="verdict-row">
        <span class="verdict-badge verdict-${esc(verdictClass)}">${esc(a.verdict)}</span>
        ${a.verdict === "No read" ? "" : `<span class="verdict-detail">${esc(a.detail)}</span>`}
      </div>
      ${metrics}
      <div class="log-head">
        <button class="log-toggle" data-log="${esc(m.id)}"><span aria-hidden="true">▸</span> Game log</button>
        <span class="log-count">${(log || []).length} lines</span>
      </div>
      <div class="log-box" data-logbox="${esc(m.id)}" hidden>${
        logLines || '<div class="log-line">No log captured.</div>'
      }${
        (log || []).length >= 500
          ? '<div class="log-cap">Capped at 500 lines per match; earlier lines were not kept.</div>'
          : ""
      }</div>
    </div>

    <div class="mdetail-col">
      <span class="block-label">Deck</span>
      <div class="deck-row">
        ${deckSelectHtml(m, readOnly)}
        ${readOnly ? "" : `<button class="btn btn-sm" data-deckapply="${esc(m.id)}">Apply to unlabelled ${esc(champ(m.myChampion || m.myLegend))} games</button>`}
      </div>
      <p class="deck-source">${esc(src.words)}</p>

      <div class="notes-head">
        <span class="block-label">Notes</span>
        <span class="save-state" data-savestate="${esc(m.id)}"></span>
      </div>
      <textarea class="notes" data-notes="${esc(m.id)}" rows="4" ${readOnly ? "readonly" : ""}
        placeholder="What happened? What would you do differently?">${esc(m.notes || "")}</textarea>

      ${
        !m.endedAt && !readOnly
          ? `<span class="block-label">Result</span>
             <div class="live-result">
               <select class="result-edit" data-id="${esc(m.id)}">
                 ${RESULTS.map((v) => `<option value="${v}" ${(m.result || "unknown") === v ? "selected" : ""}>${v}</option>`).join("")}
               </select>
               <span class="hint-inline">This match has not ended. Setting a result marks it manual.</span>
             </div>`
          : ""
      }

      ${
        LEGACY().hasVisual(m.id)
          ? `<span class="block-label">Replay</span>
             <div class="replay-row">
               <button class="btn btn-sm btn-primary" data-visual="${esc(m.id)}">Open full screen</button>
               <button class="btn btn-sm" data-share="${esc(m.id)}">Share a link</button>
             </div>
             <div class="share-box" data-sharebox="${esc(m.id)}" ${LEGACY().shareOpenHas(m.id) ? "" : "hidden"}>${LEGACY().shareBoxInner(m.id)}</div>`
          : ""
      }
    </div>
  </div>`;
}

/* The picker keeps the same data-deck attribute legacy.js listens for, so
 * choosing a name still runs the one setDeckName path - including the "＋ New
 * deck name…" sentinel, which the dialog phase turns into an inline field. */
function deckSelectHtml(m, readOnly) {
  const current = (m.deckName || "").trim();
  const names = LEGACY().deckNames();
  return `<select class="deck-select deck-wide" data-deck="${esc(m.id)}" ${readOnly ? "disabled" : ""}>
    <option value="" ${current ? "" : "selected"}>— unlabelled —</option>
    ${names.map((d) => `<option value="${esc(d)}" ${d === current ? "selected" : ""}>${esc(d)}</option>`).join("")}
    <option value=" new">＋ New deck name…</option>
  </select>`;
}

// ---- the view ----------------------------------------------------------

export function renderMatches(container, all, readOnly) {
  if (!container) return;
  const t = state.tables.matches;
  const rows = visibleMatches(all);
  const page = T.paginate(rows, t.page);
  // Written back, or the footer's "1-25 of 41" disagrees with the rows above it
  // the moment a search narrows the set under a page that no longer exists.
  t.page = page.page;

  // Deciders are a property of a series, not of a match, so they are computed
  // once per render rather than per row.
  const deciderIds = new Set(S.group(all).map((s) => s.decider).filter(Boolean));

  const filtered = rows.length !== (all || []).length;
  const selection = state.selection.size;

  container.innerHTML = `
    <div class="table-lead">
      <span class="lead-count">${rows.length} match${rows.length === 1 ? "" : "es"} match your filters</span>
      ${filtered ? '<button class="link" data-clearfilters>clear filters</button>' : ""}
      <span class="lead-note">Editing a result or a deck name here marks the match manual and it is never overwritten again.</span>
    </div>

    ${selection ? selectionBar(selection) : ""}

    <div class="card">
      <div class="mtable" style="--mgrid:${GRID}">
        <div class="mhead">
          ${COLUMNS.map((c) =>
            c.sortable === false
              ? '<span class="cell"></span>'
              : `<button class="cell msort ${t.sortKey === c.key ? "on" : ""}" data-sort="${c.key}">${esc(c.label)}${
                  t.sortKey === c.key ? (t.sortDir === "asc" ? " ↑" : " ↓") : ""
                }</button>`
          ).join("")}
        </div>
        ${
          page.rows.length
            ? page.rows
                .map((m) => row(m, deciderIds, readOnly) + (state.openRows.has(m.id) ? detail(m, readOnly) : ""))
                .join("")
            : emptyState(t.search, (all || []).length)
        }
      </div>
      ${paginationFooter(page)}
    </div>

    <div class="deck-legend">
      <span class="legend-item"><span class="dot dot-win"></span>verified — the deck you had open, champion checked</span>
      <span class="legend-item"><span class="dot dot-draw"></span>you typed it</span>
      <span class="legend-item"><span class="dot dot-accent"></span>matched by the cards you played</span>
      <span class="legend-item"><span class="dot dot-unknown"></span>assumed</span>
    </div>`;
}

function emptyState(term, total) {
  if (term) {
    return `<div class="mempty">Nothing matches “${esc(term)}”. <button class="link" data-clearfilters>clear filters</button></div>`;
  }
  if (!total) {
    return '<div class="mempty">Play a match on play.riftatlas.com with the extension installed.</div>';
  }
  return '<div class="mempty">No matches match your filters. <button class="link" data-clearfilters>clear filters</button></div>';
}

function selectionBar(n) {
  return `<div class="sel-bar">
    <span class="sel-count">${n} selected</span>
    <button class="btn btn-sm btn-primary" data-groupseries="bo3" ${n < 2 ? "disabled" : ""}>Group as a Bo3 series</button>
    <button class="btn btn-sm" data-groupseries="bo5" ${n < 2 ? "disabled" : ""}>Group as a Bo5 series</button>
    <span class="sel-end">
      <span class="sel-note">Game order is taken from the timestamps.</span>
      <button class="btn btn-sm btn-quiet" data-clearselection>Clear selection</button>
    </span>
  </div>`;
}

function paginationFooter(page) {
  if (page.total <= 0) return "";
  const list = T.pageList(page.page, page.pages);
  return `<div class="mfoot">
    <span class="mfoot-range">${page.first}–${page.last} of ${page.total}</span>
    <span class="mfoot-pages">
      <button class="pgbtn" data-page="${page.page - 1}" ${page.page <= 1 ? "disabled" : ""}>Previous</button>
      ${list
        .map((p) =>
          p === null
            ? '<span class="pggap">…</span>'
            : `<button class="pgbtn pgnum ${p === page.page ? "on" : ""}" data-page="${p}">${p}</button>`
        )
        .join("")}
      <button class="pgbtn" data-page="${page.page + 1}" ${page.page >= page.pages ? "disabled" : ""}>Next</button>
    </span>
  </div>`;
}

// ---- events this view owns ---------------------------------------------

/* Only what legacy.js does not already handle. Sorting, paging, selection and
 * clearing filters are new, so they are wired here; the deck picker, the result
 * editor, the expander, notes, the log toggle and the share panel keep their
 * existing data-* attributes and their existing owners. */
export function mountMatches() {
  document.addEventListener("click", (e) => {
    const sort = e.target.closest?.("[data-sort]");
    if (sort && sort.dataset.sort) {
      const t = state.tables.matches;
      const key = sort.dataset.sort;
      // Clicking the active column flips it; a new column starts descending,
      // which is what "most recent / most of" means for every column here.
      if (t.sortKey === key) t.sortDir = t.sortDir === "asc" ? "desc" : "asc";
      else {
        t.sortKey = key;
        t.sortDir = "desc";
      }
      resetPaging();
      emit();
      return;
    }

    const page = e.target.closest?.("[data-page]");
    if (page && !page.disabled) {
      state.tables.matches.page = Number(page.dataset.page) || 1;
      emit();
      return;
    }

    if (e.target.closest?.("[data-clearfilters]")) {
      state.filters.champion = "";
      state.filters.deck = "";
      state.filters.mode = "";
      state.filters.dateRange = { preset: "all", from: null, to: null };
      state.tables.matches.search = "";
      resetPaging();
      // The filter row is static DOM this view does not own, so its controls
      // are put back by hand rather than by a re-render.
      for (const [id, value] of [["#fMyChampion", ""], ["#fDeck", ""], ["#fMode", ""], ["#fDates", "all"], ["#fSearch", ""]]) {
        const el = document.querySelector(id);
        if (el) el.value = value;
      }
      emit();
      return;
    }

    if (e.target.closest?.("[data-clearselection]")) {
      state.selection.clear();
      emit();
      return;
    }

    const toggle = e.target.closest?.("[data-toggle]");
    if (toggle) {
      const id = toggle.dataset.toggle;
      if (state.openRows.has(id)) state.openRows.delete(id);
      else state.openRows.add(id);
      emit();
      return;
    }

    const more = e.target.closest?.("[data-rowmenu]");
    if (more) {
      state.openRowMenu = state.openRowMenu === more.dataset.rowmenu ? null : more.dataset.rowmenu;
      emit();
      return;
    }

    const copyId = e.target.closest?.("[data-copyid]");
    if (copyId) {
      // Same helper the share links use, so a blocked clipboard leaves the same
      // fallback rather than a second, worse one.
      window.RAClipboard.copyToButton(copyId.dataset.copyid, copyId, {});
      return;
    }

    /* Any other click closes an open row menu. Deliberately last, so the
     * branches above - including the menu's own items - have already run and
     * this only sees clicks that were not meant for it. */
    if (
      state.openRowMenu &&
      !e.target.closest?.(".row-menu") &&
      // The series view's toggle is handled in its own listener, which runs
      // after this one - nulling the id here would make its second click
      // reopen the menu instead of closing it.
      !e.target.closest?.("[data-sermenu]")
    ) {
      state.openRowMenu = null;
      emit();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.openRowMenu) {
      state.openRowMenu = null;
      emit();
    }
  });

  document.addEventListener("change", (e) => {
    const pick = e.target?.dataset?.pick;
    if (!pick) return;
    if (e.target.checked) state.selection.add(pick);
    else state.selection.delete(pick);
    emit();
  });
}
