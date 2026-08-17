/* Rift Atlas Stats Tracker - Overview additions
 *
 * The recent-form tile and the win-rate-by-week chart. The arithmetic lives in
 * stats.js, pure and tested; this file only draws.
 *
 * Filtering: `statsRows` applies the SAME rules legacy.js's `filtered()` does -
 * champion, deck, mode, the unknown-results checkbox and the date range - so
 * every number on the Overview narrows together. It exists separately because
 * legacy.js reads the controls off the DOM while the module half reads
 * `state.filters`; the two are synced each render by main.js, and this is the
 * module half's copy of the rule. It is also what the Matchups view feeds its
 * grid from, for the same reason.
 *
 * The chart is HTML columns rather than SVG: the bars the aggregate tables
 * already draw are divs, the columns inherit the same tokens, and a flex row
 * reflows with the pane without any viewBox arithmetic.
 */
import { state } from "./state.js";

const T = window.RATrackerTable;
const STATS = window.RATrackerStats;
const { esc, champ, deckOf, fmtPercent } = window.RATrackerFormat;

const $ = (s) => document.querySelector(s);

/** The rows every Overview figure and the Matchups grid are computed from. */
export function statsRows(all) {
  const f = state.filters;
  const rows = (all || []).filter((m) => {
    if (f.champion && champ(m.myChampion || m.myLegend) !== f.champion) return false;
    if (f.deck && deckOf(m) !== f.deck) return false;
    if (f.mode && m.mode !== f.mode) return false;
    if (!f.countUnknown && (m.result === "unknown" || !m.result)) return false;
    return true;
  });
  return T.inRange(rows, f.dateRange, "startedAt");
}

// ---- recent form -------------------------------------------------------

const FORM_SHORT = 10;
const FORM_LONG = 20;

function paintForm(rows) {
  const value = $("#tForm");
  const sub = $("#tFormSub");
  if (!value || !sub) return;

  const short = STATS.recentForm(rows, FORM_SHORT);
  if (!short.decided) {
    value.textContent = "–";
    value.classList.add("dash");
    sub.textContent = "";
    return;
  }
  value.classList.remove("dash");
  value.textContent = `${short.wins}–${short.losses}`;

  const bits = [fmtPercent(short.rate)];
  // Claim only the games that exist: "last 10" with seven decided games is a
  // 7-game claim, and the tile says so.
  if (short.decided < FORM_SHORT) bits.push(`of last ${short.decided} decided`);
  const long = STATS.recentForm(rows, FORM_LONG);
  if (long.decided > short.decided) bits.push(`last ${long.decided}: ${fmtPercent(long.rate)}`);
  sub.textContent = bits.join(" · ");
}

// ---- win rate by week --------------------------------------------------

/* More weeks than this and each column is thinner than its own gap. The chart
 * says what it dropped rather than dropping it silently. */
const MAX_WEEKS = 52;

/* Same quarter-steps as the aggregate tables' bars: this encodes magnitude in
 * the same hue the rest of the page already uses for win rate. */
const rateStep = (rate) => (rate >= 0.75 ? 4 : rate >= 0.5 ? 3 : rate >= 0.25 ? 2 : 1);

function weekLabel(startMs, now) {
  const d = new Date(startMs);
  const label = d.getDate() + " " + d.toLocaleString(undefined, { month: "short" });
  const thisYear = new Date(now === undefined ? Date.now() : now).getFullYear();
  return d.getFullYear() === thisYear ? label : label + " " + d.getFullYear();
}

/** Roughly eight x-labels however many weeks there are, first and last kept. */
function labelled(count) {
  if (count <= 8) return new Set(Array.from({ length: count }, (_, i) => i));
  const step = Math.ceil(count / 8);
  const out = new Set();
  for (let i = 0; i < count; i += step) out.add(i);
  out.add(count - 1);
  return out;
}

function tipText(week, now) {
  const head = "Week of " + weekLabel(week.start, now);
  if (!week.games) return head + " · no games";
  if (!week.decided) return head + ` · ${week.games} game${week.games === 1 ? "" : "s"}, none decided`;
  const games = week.games === week.decided ? "" : ` · ${week.games} games`;
  return `${head} · ${fmtPercent(week.rate)} (${week.wins}–${week.losses})${games}`;
}

function renderTrend(rows) {
  const box = $("[data-trend]");
  const note = $("[data-trend-note]");
  if (!box) return;

  const { weeks, omitted, undated } = STATS.weeklyWinRate(rows, MAX_WEEKS);
  lastWeeks = weeks;

  const decidedWeeks = weeks.filter((w) => w.decided).length;
  if (decidedWeeks < 2) {
    box.innerHTML =
      '<p class="trend-empty">Not enough decided games to draw a trend yet — it needs two different weeks with results.</p>';
    if (note) note.textContent = "";
    return;
  }

  // Nothing hidden silently: the cap and the unplaceable rows are both stated.
  if (note) {
    const bits = [];
    if (omitted) bits.push(`last ${weeks.length} weeks — ${omitted} earlier not shown`);
    if (undated) bits.push(`${undated} undated match${undated === 1 ? "" : "es"} not placed`);
    note.textContent = bits.join(" · ");
  }

  const labels = labelled(weeks.length);
  const cols = weeks
    .map((w, i) => {
      const fill =
        w.rate === null
          ? ""
          : `<div class="trend-fill rate-${rateStep(w.rate)}" style="height:${Math.max(
              2,
              Math.round(w.rate * 100)
            )}%"></div>`;
      return `<div class="trend-col" data-wk="${i}" role="img" aria-label="${esc(tipText(w))}">
        <div class="trend-track">${fill}</div>
        <span class="trend-lab">${labels.has(i) ? esc(weekLabel(w.start)) : ""}</span>
      </div>`;
    })
    .join("");

  box.innerHTML = `
    <div class="trend-chart">
      <div class="trend-y" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
      <div class="trend-plot">
        <div class="trend-mid" aria-hidden="true"></div>
        <div class="trend-cols">${cols}</div>
      </div>
    </div>
    <div class="trend-tip" hidden></div>`;
}

/* The columns the tooltip describes, kept beside the render that drew them so
 * a hover between renders never reads a stale index off fresh markup. */
let lastWeeks = [];

function mountTrendTip() {
  const box = $("[data-trend]");
  if (!box) return;

  const move = (e) => {
    const tip = box.querySelector(".trend-tip");
    if (!tip) return;
    const col = e.target.closest?.(".trend-col");
    if (!col || !box.contains(col)) {
      tip.hidden = true;
      return;
    }
    const week = lastWeeks[Number(col.dataset.wk)];
    if (!week) {
      tip.hidden = true;
      return;
    }
    tip.textContent = tipText(week);
    tip.hidden = false;
    const boxRect = box.getBoundingClientRect();
    const colRect = col.getBoundingClientRect();
    const centre = colRect.left - boxRect.left + colRect.width / 2;
    // Clamped after paint, when the tip has a width to clamp by.
    const half = tip.offsetWidth / 2;
    const left = Math.min(Math.max(centre, half), boxRect.width - half);
    tip.style.left = left + "px";
  };

  box.addEventListener("mouseover", move);
  box.addEventListener("mouseout", move);
}

// ---- wiring ------------------------------------------------------------

export function mountOverviewExtras() {
  mountTrendTip();
}

export function renderOverviewExtras(all) {
  const rows = statsRows(all);
  paintForm(rows);
  renderTrend(rows);
}
