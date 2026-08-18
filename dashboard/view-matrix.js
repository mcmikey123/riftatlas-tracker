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
  return `${mine} vs ${theirs}: ${rate} (${record}) — click to open these matches`;
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

export function renderMatrix(container) {
  if (!container) return;

  const grid = STATS.matchupMatrix(OVERVIEW.filtered());
  if (!grid.size) {
    container.innerHTML =
      '<p class="empty-view">No matches under the current filters, so there are no matchups to grid.</p>';
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
    </div>`;
}

export function mountMatrix(container) {
  if (!container) return;
  container.addEventListener("click", (e) => {
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
