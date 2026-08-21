/* Rift Atlas Stats Tracker - the Notes view
 *
 * Everything you wrote in a match's Notes box, in one place, grouped by the
 * champion you faced when you wrote it. A note is written one game at a time
 * and then never read again, because the only way back to it is to remember
 * which match it was on and expand that row; the point of this view is that
 * "what do I keep writing about Corin?" is a question you can answer by
 * looking rather than by hunting.
 *
 * THE RANGE CONTROL IS THIS VIEW'S OWN, and that is deliberate. The shared
 * filter row is hidden here (shell.js's FILTERED), so there is exactly one
 * date control on screen instead of two that would narrow the same list and
 * disagree about it. Its three windows are the ones the brief asked for - a
 * week, a month, a year - resolved by table.js's range arithmetic, the same
 * code the Matches table and the Overview date their rows with, so "last week"
 * cannot come to mean one thing here and another there.
 *
 * The arithmetic - which matches carry a note, which of those fall in the
 * window, and how they group - is pure and exported, because all three have a
 * right answer that is decidable from data and none of them needs a DOM to be
 * wrong in an interesting way.
 */
import { state, emit } from "./state.js";

const T = window.RATrackerTable;
const { esc, champ, deckOf, fmtDay, fmtTime, fmtScore } = window.RATrackerFormat;

/* Week, month and year as day counts back from today, plus the way out of all
 * three. The ids are table.js's preset ids, so resolveRange knows them without
 * a translation table in the middle - "30" is thirty days there and a month
 * here, and calling it a month is this view's labelling, not new arithmetic. */
export const RANGES = [
  { id: "7", label: "Last week", words: "the last 7 days" },
  { id: "30", label: "Last month", words: "the last 30 days" },
  { id: "365", label: "Last year", words: "the last 365 days" },
  { id: "all", label: "All time", words: "your whole history" },
];

const rangeOf = (id) => RANGES.find((r) => r.id === String(id)) || RANGES[RANGES.length - 1];

/** The champion a note was written against. The grouping key. */
export const opponentOf = (m) => champ(m.opponentChampion || m.opponentLegend);

/* Whitespace is not a note. A textarea that was opened, tabbed through and
 * left behind holds "" or "\n", and counting either would put a game in this
 * view with nothing to read on the row. */
export const hasNote = (m) => !!(m && typeof m.notes === "string" && m.notes.trim());

/**
 * The noted matches inside one window, newest first.
 *
 * `now` is threaded through rather than read from the clock so the tests can
 * stand somewhere fixed; every caller in the page omits it.
 */
export function notedMatches(all, range, now) {
  const rows = (all || []).filter(hasNote);
  const inWindow = T.inRange(rows, { preset: String(range || "all") }, "startedAt", now);
  return T.sortBy(inWindow, (m) => Date.parse(m.startedAt || "") || null, "desc");
}

/**
 * One group per champion faced, ordered by how much you have written about
 * them - which is the order that answers "what am I chewing over".
 *
 * Ties break on the champion's name rather than on encounter order, so the
 * list does not reshuffle under the three-second re-render while a match is
 * live. Each group carries its own record over the NOTED games only: it says
 * what happened in the games on the rows underneath it, not your record into
 * that champion, and calling it the latter would be a different and wrong
 * number.
 */
export function groupNotes(rows) {
  const groups = new Map();
  for (const m of rows || []) {
    const champion = opponentOf(m);
    if (!groups.has(champion)) {
      groups.set(champion, { champion, matches: [], wins: 0, losses: 0 });
    }
    const g = groups.get(champion);
    g.matches.push(m);
    if (m.result === "win") g.wins++;
    else if (m.result === "loss") g.losses++;
  }
  return [...groups.values()].sort(
    (a, b) => b.matches.length - a.matches.length || a.champion.localeCompare(b.champion)
  );
}

/**
 * The line above the groups: how much is in view, and over how many opponents.
 *
 * Notes are one per match, so "notes" and "games" are the same count and only
 * one of them is stated - two figures that can never differ read as two facts
 * and invite the reader to look for the difference.
 */
export function summaryText(rows, range) {
  const n = (rows || []).length;
  if (!n) return "";
  const champions = new Set((rows || []).map(opponentOf)).size;
  const notes = `${n} note${n === 1 ? "" : "s"}`;
  const vs = `${champions} champion${champions === 1 ? "" : "s"}`;
  return `${notes} across ${vs}, over ${rangeOf(range).words}.`;
}

// ---- markup ------------------------------------------------------------

function rangeChips(current) {
  return RANGES.map(
    (r) =>
      `<button class="chip note-range${r.id === current ? " on" : ""}" data-noterange="${r.id}"
        aria-pressed="${r.id === current}">${esc(r.label)}</button>`
  ).join("");
}

/* Win, loss and draw get the chip the rest of the dashboard gives them; a
 * result that was never read stays grey, because "we could not read it" is not
 * a result. Unclickable here - this view reads notes, it does not edit games. */
function resultChip(m) {
  const result = m.result || "unknown";
  return `<span class="chip chip-${esc(result)} chip-static">${esc(result)}</span>`;
}

function noteRow(m) {
  const deck = deckOf(m);
  return `<tr class="note-row">
    <td class="note-when">
      <span class="d1">${esc(fmtDay(m.startedAt))}</span><span class="d2">${esc(fmtTime(m.startedAt))}</span>
    </td>
    <td class="note-you">
      <span class="d1">${esc(champ(m.myChampion || m.myLegend))}</span><span class="d2">${esc(deck)}</span>
    </td>
    <td class="note-result">${resultChip(m)}<span class="d2">${esc(fmtScore(m))}</span></td>
    <td class="note-text">${esc(m.notes.trim())}</td>
  </tr>`;
}

function groupHtml(g) {
  const n = g.matches.length;
  return `<section class="note-group">
    <div class="note-group-head">
      <span class="note-champ">vs ${esc(g.champion)}</span>
      <span class="note-meta">${n} note${n === 1 ? "" : "s"} · ${g.wins}–${g.losses} in these games</span>
    </div>
    <table class="note-table">
      <thead><tr><th>When</th><th>You played</th><th>Result</th><th>Note</th></tr></thead>
      <tbody>${g.matches.map(noteRow).join("")}</tbody>
    </table>
  </section>`;
}

/**
 * Paint the view.
 *
 * `all` is the same match array every other view is drawn from, handed in by
 * main.js rather than read here - one array per render, so this view cannot
 * describe a history the tables beside it have already moved on from.
 */
export function renderNotes(container, all) {
  if (!container) return;

  const range = state.notes.range;
  const rows = notedMatches(all, range);
  const groups = groupNotes(rows);

  /* Two empty states, because they are two different situations and only one
   * of them is fixed by widening the window. */
  const empty = (all || []).some(hasNote)
    ? `<p class="empty-view">No notes in ${esc(rangeOf(range).words)}. Try a wider window.</p>`
    : `<p class="empty-view">No notes yet. Open a match in Matches and write in its Notes box —
       whatever you write there is collected here.</p>`;

  container.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Note summary</h2>
        <span class="card-actions note-ranges" role="group" aria-label="Note date range">${rangeChips(range)}</span>
      </div>
      <p class="card-band">
        Every note you have written, grouped by the champion you faced when you wrote it, with the
        game it came from beside it. The champions you have written most about come first. This
        section carries its own date range &mdash; the filter row above the other views does not
        narrow it.
      </p>
      <div class="note-body">
        ${rows.length ? `<p class="note-lead">${esc(summaryText(rows, range))}</p>` : ""}
        ${groups.length ? groups.map(groupHtml).join("") : empty}
      </div>
    </div>`;
}

/**
 * One delegated listener on the container, so the chips it draws keep working
 * across a re-render without being rewired.
 */
export function mountNotes(container) {
  if (!container) return;
  container.addEventListener("click", (e) => {
    const chip = e.target.closest?.("[data-noterange]");
    if (!chip) return;
    const next = chip.dataset.noterange;
    if (next === state.notes.range) return;
    state.notes.range = next;
    emit();
  });
}
