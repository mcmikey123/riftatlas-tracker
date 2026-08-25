/* Rift Atlas Stats Tracker - the Matchups view
 *
 * The champion-by-champion grid: every champion you have played down the side,
 * every champion you have faced along the top, and in each cell your record
 * between the two. The arithmetic is stats.js's matchupMatrix, pure and
 * tested; the rows come through the Overview's own `filtered()`, so the grid
 * narrows with the filter row like everything else and cannot disagree with
 * the tiles about which matches are in view.
 *
 * Every cell states its denominator. 100% of 2 and 100% of 40 are different
 * claims, and a grid of bare percentages would make them look the same - so
 * the game count sits in the cell, and the full record is in its tooltip.
 *
 * A cell is a button: clicking it opens Matches narrowed to that matchup. It
 * does that by driving the SAME controls a hand would - the champion filter
 * and the search field - rather than by a private query, so what the user
 * lands on visibly says how it was narrowed and how to undo it.
 */
import { setView } from "./shell.js";

const STATS = window.RATrackerStats;
const OVERVIEW = window.RATrackerViewOverview;
const { esc, fmtPercent, rateStep } = window.RATrackerFormat;

const $ = (s) => document.querySelector(s);

function cellTip(mine, theirs, c) {
  const record = `${c.wins}–${c.losses}` + (c.games > c.decided ? ` of ${c.games} games` : "");
  const rate = c.rate === null ? "no decided games" : fmtPercent(c.rate);
  // The going-first split, when any of the cell's games carry it. Absent
  // otherwise: "first 0–0" would look like data about games that never said.
  const halves = [];
  if (c.first && c.first.wins + c.first.losses) halves.push(`first ${c.first.wins}–${c.first.losses}`);
  if (c.second && c.second.wins + c.second.losses)
    halves.push(`second ${c.second.wins}–${c.second.losses}`);
  const split = halves.length ? ` · going ${halves.join(", ")}` : "";
  return `${mine} vs ${theirs}: ${rate} (${record})${split} — click to open these matches`;
}

function cellHtml(mine, theirs, c) {
  if (!c) return "<td></td>";
  const cls = c.rate === null ? "mx-cell mx-undecided" : `mx-cell mx-rate-${rateStep(c.rate)}`;
  const pct = c.rate === null ? "–" : fmtPercent(c.rate);
  return `<td><button class="${cls}" data-mine="${esc(mine)}" data-theirs="${esc(theirs)}"
    title="${esc(cellTip(mine, theirs, c))}">
    <span class="mx-pct">${pct}</span><span class="mx-n">${c.games}</span>
  </button></td>`;
}

/* The last battlefield analysis, kept across re-renders. Logs are a bulk read
 * the page must not repeat every three seconds, so the table is computed when
 * asked and the card says which draw of the filters it belongs to. */
let bf = null; // { rows, games, withLogs }

function battlefieldCard() {
  const head = `<div class="card-head"><h2>Battlefields</h2>
    <span class="card-actions"><button class="btn btn-sm" data-bfanalyse>${
      bf ? "Analyse again" : "Analyse game logs"
    }</button></span></div>
    <p class="card-band">Which battlefields you win on, read from the conquests in your stored game
    logs. A battlefield counts a match when either side conquered it at least once that game.
    Reading every log is a heavier lookup than the grid above, so it runs when you ask, over the
    filters as they stood.</p>`;

  if (!bf) return `<div class="card">${head}</div>`;
  if (!bf.rows.length) {
    return `<div class="card">${head}
      <p class="empty-view">No conquests found in the ${bf.withLogs} stored log${
        bf.withLogs === 1 ? "" : "s"
      } these filters cover.</p></div>`;
  }

  const rows = bf.rows
    .map((r) => {
      const pct = r.rate === null ? 0 : Math.round(r.rate * 100);
      return `<tr>
        <td>${esc(r.name)}</td>
        <td>${r.games}</td><td>${r.wins}</td><td>${r.losses}</td>
        <td>${r.myTakes}–${r.oppTakes}</td>
        <td><div class="bar-wrap"><div class="bar-track">${
          r.rate === null ? "" : `<div class="bar rate-${rateStep(r.rate)}" style="width:${pct}%"></div>`
        }</div><span class="pct">${fmtPercent(r.rate)}</span></div></td>
      </tr>`;
    })
    .join("");

  return `<div class="card">${head}
    <table class="agg bf">
      <thead><tr><th>Battlefield</th><th>Games</th><th>W</th><th>L</th><th>Conquests for–against</th><th>Match win rate</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="card-band">From ${bf.withLogs} of ${bf.games} filtered matches that still have a log.</p>
  </div>`;
}

async function analyseBattlefields() {
  const A = window.RATrackerAnalysis;
  const LEGACY = window.RATrackerLegacy;
  const rows = OVERVIEW.filtered();
  const logs = await window.RATrackerLogs.readLogs(rows.map((m) => m.id), {
    readOnly: LEGACY.readOnly,
    cachedLog: LEGACY.cachedLog,
  });
  const games = rows
    .filter((m) => logs.has(m.id))
    .map((m) => ({ result: m.result, conquests: A.conquests(logs.get(m.id)) }));
  bf = { rows: STATS.battlefieldStats(games), games: rows.length, withLogs: games.length };
}

export function renderMatrix(container) {
  if (!container) return;

  const grid = STATS.matchupMatrix(OVERVIEW.filtered());
  if (!grid.size) {
    container.innerHTML =
      '<p class="empty-view">No matches under the current filters, so there are no matchups to grid.</p>' +
      battlefieldCard();
    return;
  }

  const head = grid.theirs.map((t) => `<th scope="col"><span class="mx-head">${esc(t)}</span></th>`).join("");
  const body = grid.mine
    .map(
      (mine) =>
        `<tr><th scope="row">${esc(mine)}</th>${grid.theirs
          .map((theirs) => cellHtml(mine, theirs, grid.cell(mine, theirs)))
          .join("")}</tr>`
    )
    .join("");

  container.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Matchup matrix</h2></div>
      <p class="card-band">
        Your champions down the side, your opponents' along the top. Each cell is your win rate over
        that matchup's decided games, with how many games it rests on beside it &mdash; the same
        percentage of 2 games and of 40 are different claims. Ordered by games played, so the
        top-left corner is where the numbers carry weight. Click a cell to open those matches.
      </p>
      <div class="mx-scroll">
        <table class="mx">
          <thead><tr><th scope="col" class="mx-corner">You \\ Opp</th>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>
    ${battlefieldCard()}`;
}

export function mountMatrix(container) {
  if (!container) return;
  container.addEventListener("click", (e) => {
    const analyse = e.target.closest?.("[data-bfanalyse]");
    if (analyse) {
      analyse.disabled = true;
      analyse.textContent = "Reading logs…";
      analyseBattlefields()
        .catch((err) => console.error("[RA-Tracker] battlefield analysis failed:", err))
        .then(() => window.RATrackerLegacy.render());
      return;
    }

    const cell = e.target.closest?.("[data-mine]");
    if (!cell) return;

    /* Driving the real controls keeps one source of truth: the change event
     * runs legacy.js's filter handler and the input event runs main.js's
     * search sync, exactly as typing would. */
    const mySel = $("#fMyChampion");
    if (mySel) {
      mySel.value = cell.dataset.mine;
      mySel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const search = $("#fSearch");
    if (search) {
      search.value = cell.dataset.theirs;
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setView("matches");
  });
}
