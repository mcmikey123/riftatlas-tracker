/* Rift Atlas Stats Tracker - the Goals view
 *
 * Things you are working on: "mulligan for early units", "don't overcommit
 * into Corin". A goal is either generic - it applies to every game - or named
 * after one opponent champion, and the difference is the whole point: when a
 * match starts, capture/goal-notes.js draws the applicable goals on the game
 * page, and the matchup-specific ones surface the moment that champion is
 * read off the board. The toolbar popup shows the same list beside its
 * scouting line. This view is where the list is written.
 *
 * Goals live under their own `goals` key and are read and written through
 * storage.js like everything else. They are a property of this browser, not
 * of the match data - an archive file carries no goals, and viewing one says
 * nothing about what you are practising - so the controls here deliberately
 * stay live in archive mode, the same way Settings does.
 *
 * The handlers never hold a copy of the list: every edit is a fresh
 * read-modify-write, so two dashboard tabs cannot clobber each other with
 * stale arrays. The render draws from the array main.js mirrors out of
 * storage, which the storage-change listener keeps current.
 *
 * The grouping arithmetic is pure and exported, same policy as view-notes.js.
 */
import { emit } from "./state.js";

const STORE = window.RATrackerStorage;
const { esc, champ } = window.RATrackerFormat;

const uid = () =>
  "g_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

/* Whitespace is not a goal, and a corrupted entry with no id could never be
 * edited or deleted again - both are dropped rather than drawn. */
export const realGoals = (goals) =>
  (goals || []).filter((g) => g && g.id && String(g.text || "").trim());

/** The goals still being worked on - what the nav count and the game page show. */
export const activeGoals = (goals) => realGoals(goals).filter((g) => !g.done);

/** A goal's matchup as the champion name every surface compares on, or "". */
export const opponentOf = (g) => {
  const raw = String((g && g.opponent) || "").trim();
  return raw ? champ(raw) : "";
};

/**
 * The shape the view draws: generic goals, one group per named champion, and
 * the finished ones last. Champions sort by name; goals keep the order they
 * were written in, because a practice list reads top-down.
 */
export function groupGoals(goals) {
  const active = activeGoals(goals);
  const generic = active.filter((g) => !opponentOf(g));
  const byChamp = new Map();
  for (const g of active) {
    const name = opponentOf(g);
    if (!name) continue;
    if (!byChamp.has(name)) byChamp.set(name, { champion: name, goals: [] });
    byChamp.get(name).goals.push(g);
  }
  return {
    generic,
    matchups: [...byChamp.values()].sort((a, b) => a.champion.localeCompare(b.champion)),
    done: realGoals(goals).filter((g) => !!g.done),
  };
}

/**
 * What the matchup field offers: every champion you have faced, plus every
 * champion a goal already names - so a goal written before the first meeting
 * keeps its champion in the list.
 */
export function championOptions(all, goals) {
  const names = new Set();
  for (const m of all || []) {
    const name = champ(m.opponentChampion || m.opponentLegend);
    if (name !== "Unknown") names.add(name);
  }
  for (const g of realGoals(goals)) {
    const name = opponentOf(g);
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ---- markup ------------------------------------------------------------

function goalRow(g, withTag) {
  return `<div class="goal-row">
    <input type="checkbox" class="goal-done" data-goaldone="${esc(g.id)}" ${g.done ? "checked" : ""}
           aria-label="Mark this goal ${g.done ? "active" : "done"}" title="${g.done ? "Put it back on the list" : "Done working on this"}" />
    <span class="goal-text${g.done ? " goal-text-done" : ""}">${esc(String(g.text || "").trim())}${
      withTag && opponentOf(g) ? ` <span class="goal-tag">vs ${esc(opponentOf(g))}</span>` : ""
    }</span>
    <button class="goal-del" data-goaldel="${esc(g.id)}" aria-label="Delete this goal" title="Delete">✕</button>
  </div>`;
}

function matchupGroup(group) {
  return `<section class="goal-group">
    <div class="goal-group-head"><span class="goal-champ">vs ${esc(group.champion)}</span>
      <span class="goal-meta">shown when ${esc(group.champion)} is across the table</span></div>
    ${group.goals.map((g) => goalRow(g, false)).join("")}
  </section>`;
}

/**
 * Paint the view. `all` is the same match array every other view draws from
 * (for the matchup suggestions); `goals` is main.js's mirror of the stored
 * list. Skipped while the add form has focus - the dashboard re-renders every
 * three seconds during a live match, and a rebuilt form would take the caret
 * and the half-typed goal with it. Same reason the filter row is static DOM.
 */
export function renderGoals(container, all, goals) {
  if (!container) return;
  const busy = document.activeElement;
  if (
    busy &&
    container.contains(busy) &&
    busy.dataset &&
    (busy.dataset.goalText !== undefined || busy.dataset.goalVs !== undefined)
  ) {
    return;
  }

  const groups = groupGoals(goals);
  const options = championOptions(all, goals);
  const none = !groups.generic.length && !groups.matchups.length;

  container.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Goals</h2></div>
      <p class="card-band">
        Things to work on. When a match starts they appear on the game page as a reminder;
        a goal tied to a champion waits until that champion is across the table. The toolbar
        popup shows them too. Ticking one off keeps it below for the record.
      </p>

      <div class="goal-add">
        <input type="text" class="goal-in" data-goal-text maxlength="120"
               placeholder="e.g. Mulligan for early units" aria-label="New goal" />
        <input type="text" class="goal-in goal-in-vs" data-goal-vs list="goalChampList"
               placeholder="Any matchup" aria-label="Only against this champion (optional)" />
        <datalist id="goalChampList">${options.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        <button class="btn btn-sm btn-primary" data-goaladd>Add goal</button>
      </div>

      <div class="goal-body">
        ${none ? '<p class="empty-view">No goals yet. Add one above — generic, or tied to a matchup.</p>' : ""}
        ${
          groups.generic.length
            ? `<section class="goal-group">
                 <div class="goal-group-head"><span class="goal-champ">Every game</span></div>
                 ${groups.generic.map((g) => goalRow(g, false)).join("")}
               </section>`
            : ""
        }
        ${groups.matchups.map(matchupGroup).join("")}
        ${
          groups.done.length
            ? `<section class="goal-group goal-group-done">
                 <div class="goal-group-head"><span class="goal-champ">Done</span>
                   <span class="goal-meta">kept for the record — untick one to work on it again</span></div>
                 ${groups.done.map((g) => goalRow(g, true)).join("")}
               </section>`
            : ""
        }
      </div>
    </div>`;
}

// ---- events this view owns ---------------------------------------------

/* Every edit is a fresh read-modify-write through storage.js; the repaint
 * comes back around through main.js's storage-change listener, so nothing
 * here touches the mirror it was drawn from. */
function editGoals(change) {
  STORE.readGoals().then((stored) => STORE.writeGoals(change(stored)));
}

function addFrom(container) {
  const textEl = container.querySelector("[data-goal-text]");
  const vsEl = container.querySelector("[data-goal-vs]");
  const text = textEl ? textEl.value.trim() : "";
  if (!text) return;
  const opponent = vsEl ? vsEl.value.trim() : "";
  const goal = {
    id: uid(),
    text,
    opponent,
    createdAt: new Date().toISOString(),
    done: false,
  };
  if (textEl) textEl.value = "";
  if (vsEl) vsEl.value = "";
  editGoals((stored) => [...stored, goal]);
}

/** One delegated listener per event type, so the rows survive a re-render. */
export function mountGoals(container) {
  if (!container) return;

  container.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-goaladd]")) {
      addFrom(container);
      return;
    }
    const del = e.target.closest?.("[data-goaldel]");
    if (del) {
      const id = del.dataset.goaldel;
      editGoals((stored) => stored.filter((g) => !g || g.id !== id));
    }
  });

  container.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const field = e.target.closest?.("[data-goal-text],[data-goal-vs]");
    if (!field) return;
    e.preventDefault();
    addFrom(container);
    // The guard in renderGoals skips repaints while the form holds focus, so
    // the field lets go of it here - the freshly written list should appear.
    field.blur();
    emit();
  });

  container.addEventListener("change", (e) => {
    const id = e.target?.dataset?.goaldone;
    if (!id) return;
    const on = !!e.target.checked;
    editGoals((stored) =>
      stored.map((g) =>
        g && g.id === id
          ? Object.assign({}, g, { done: on, doneAt: on ? new Date().toISOString() : null })
          : g
      )
    );
  });
}
