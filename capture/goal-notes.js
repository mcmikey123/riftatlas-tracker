/* Rift Atlas Stats Tracker - goals on the game page, and timestamped mid-game notes.
 *
 * Two things live here, and they share one panel because they share a moment:
 * the start of a game is when a reminder is worth reading, and mid-game is
 * when "review this later" is worth writing down.
 *
 * GOALS are written in the dashboard's Goals view and stored under the `goals`
 * key: things to work on, in every game or against one champion. When a match
 * starts, the ones that apply are drawn on the page. The opponent's champion
 * can be read off the board late, so when it first appears the matchup goals
 * do too - and the panel re-opens to say so, because a goal about exactly this
 * opponent is the reminder most worth interrupting for.
 *
 * NOTES are typed here mid-game and filed by RATLifecycle.addFlag as
 * timestamped flags on the match record - the same {ms, text} bookmarks the
 * replay viewer draws on its timeline - so after the game each note is one
 * click from the board state it was written about.
 *
 * Everything drawn here carries the `ra-tracker-block` class, which keeps our
 * own UI out of the visual replay (capture/dom-recorder.js), and the
 * lifecycle's end-of-match text scan skips it via `isOwnPanel`, so a goal
 * reading "win the last battlefield" can never be mistaken for a victory
 * banner.
 *
 * DOM work sticks to the surface test/content-boot.test.js's fake page
 * offers - createElement, property writes, appendChild, addEventListener,
 * remove. No querySelector: element references are kept instead, which is
 * also what lets the note input survive every repaint of the goal list.
 */
(function (root) {
  "use strict";

  // How long the reminder stays open before folding down to the pill. The
  // end-of-match toast stands for 30 seconds; the start-of-match reminder
  // matches it.
  const REMINDER_MS = 30000;
  // The label length the replay viewer renders on a flag chip
  // (dashboard/replay-html.js slices to 80); the input stops at the same
  // point so nothing typed here is silently cut later.
  const MAX_NOTE_CHARS = 80;

  /* The champion half of a card's alt text ("Corin, Tidecaller" -> "Corin").
   * The same split dashboard/format.js's champ() makes - format.js is not a
   * content script, so the one line is restated rather than the file dragged
   * onto the game page. */
  const champName = (alt) => (alt ? String(alt).split(",")[0].trim() : "");

  /**
   * Which goals apply to a game against `opponentAlt` (a card's alt text or a
   * bare champion name; null while nobody has been read off the board yet).
   *
   * Matchup goals are separated from the generic ones rather than merged,
   * because every surface that shows them - this panel, the toolbar popup -
   * puts the matchup ones first: they are the reason the reminder exists. A
   * done goal is finished business and is never shown before a game.
   */
  function goalsFor(goals, opponentAlt) {
    const opp = champName(opponentAlt);
    const active = (goals || []).filter((g) => g && !g.done && String(g.text || "").trim());
    return {
      matchup: opp ? active.filter((g) => champName(g.opponent) === opp) : [],
      generic: active.filter((g) => !String(g.opponent || "").trim()),
    };
  }

  // ---------- the panel ----------

  let ui = null; // { record, opponent, goals, noted, hideTimer, panel, list, input, pill }

  const esc = (s) => root.RATPageUI.escapeHtml(s);

  /** `m:ss` into the match, for the "noted" receipt line. */
  const clock = (ms) => {
    const t = Math.max(0, Math.round(ms / 1000));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  };

  function goalRowsHtml() {
    const { matchup, generic } = goalsFor(
      ui.goals,
      ui.record.opponentChampion || ui.record.opponentLegend
    );
    const row = (g, vs) =>
      `<div class="rat-goal${vs ? " rat-goal-vs" : ""}">${
        vs ? `<span class="rat-vstag">vs ${esc(champName(g.opponent))}</span>` : ""
      }${esc(g.text)}</div>`;
    const rows = matchup
      .map((g) => row(g, true))
      .concat(generic.map((g) => row(g, false)));
    const noted = ui.noted
      .map((n) => `<div class="rat-noted">⚑ ${esc(clock(n.ms))} · ${esc(n.text)}</div>`)
      .join("");
    if (!rows.length) {
      return (
        '<div class="rat-goal rat-goal-none">No goals set — add some under Goals in the dashboard.</div>' +
        noted
      );
    }
    return rows.join("") + noted;
  }

  function paint() {
    if (ui) ui.list.innerHTML = goalRowsHtml();
  }

  function expand(autoHideMs) {
    if (!ui) return;
    clearTimeout(ui.hideTimer);
    ui.hideTimer = null;
    paint();
    ui.panel.style.display = "block";
    if (autoHideMs) ui.hideTimer = setTimeout(collapse, autoHideMs);
  }

  function collapse() {
    if (!ui) return;
    clearTimeout(ui.hideTimer);
    ui.hideTimer = null;
    ui.panel.style.display = "none";
  }

  function submitNote() {
    if (!ui) return;
    const text = String(ui.input.value || "").trim().slice(0, MAX_NOTE_CHARS);
    if (!text) return;
    const ms = root.RATLifecycle.addFlag(text);
    if (ms === null) return; // the match ended under the click; nothing to file it on
    ui.noted.push({ ms, text });
    ui.input.value = "";
    paint();
  }

  function build() {
    const doc = root.document;

    const panel = doc.createElement("div");
    panel.id = "ra-tracker-goals";
    panel.className = "ra-tracker-block"; // keeps our own UI out of the visual replay
    // style.display rather than the hidden attribute: the site's own CSS can
    // outrank the UA's [hidden] rule, and this page is not ours.
    panel.style.display = "none";

    const head = doc.createElement("div");
    head.className = "rat-ghead";
    head.innerHTML = '<span class="rat-title">Rift Atlas Tracker · this game</span>';
    const hide = doc.createElement("button");
    hide.className = "rat-fold";
    hide.title = "Collapse — the ⚑ pill brings it back";
    hide.innerHTML = "&ndash;";
    hide.addEventListener("click", collapse);
    head.appendChild(hide);

    const list = doc.createElement("div");
    list.className = "rat-goals";

    const row = doc.createElement("div");
    row.className = "rat-noterow";
    const input = doc.createElement("input");
    input.type = "text";
    input.maxLength = MAX_NOTE_CHARS;
    input.placeholder = "Note this moment — “best play here?”";
    input.addEventListener("keydown", (e) => {
      if (e && e.key === "Enter") submitNote();
    });
    const add = doc.createElement("button");
    add.className = "rat-noteadd";
    add.innerHTML = "⚑ Note";
    add.title = "Save a timestamped note on this match — it jumps the replay here afterwards";
    add.addEventListener("click", submitNote);
    row.appendChild(input);
    row.appendChild(add);

    const hint = doc.createElement("div");
    hint.className = "rat-hint";
    hint.innerHTML = "Notes are timestamped — after the game they jump the replay to the moment.";

    panel.appendChild(head);
    panel.appendChild(list);
    panel.appendChild(row);
    panel.appendChild(hint);

    const pill = doc.createElement("button");
    pill.id = "ra-tracker-goals-pill";
    pill.className = "ra-tracker-block"; // keeps our own UI out of the visual replay
    pill.title = "Goals & mid-game notes (Rift Atlas Tracker)";
    pill.innerHTML = "⚑";
    pill.addEventListener("click", () =>
      ui && ui.panel.style.display === "none" ? expand(0) : collapse()
    );

    const host = doc.body || doc.documentElement;
    host.appendChild(panel);
    host.appendChild(pill);
    return { panel, list, input, pill };
  }

  // ---------- what the lifecycle drives ----------

  /** A match has begun: put the pill up, and open the reminder if any goal applies. */
  function matchStarted(record) {
    matchEnded(); // a new game always starts from a clean panel
    const built = build();
    ui = {
      record,
      opponent: champName(record.opponentChampion || record.opponentLegend) || null,
      goals: [],
      noted: [],
      hideTimer: null,
      panel: built.panel,
      list: built.list,
      input: built.input,
      pill: built.pill,
    };
    try {
      chrome.storage.local.get({ goals: [] }, (data) => {
        if (!ui || ui.record !== record) return; // the game ended while storage answered
        ui.goals = (data && data.goals) || [];
        const { matchup, generic } = goalsFor(
          ui.goals,
          record.opponentChampion || record.opponentLegend
        );
        if (matchup.length || generic.length) expand(REMINDER_MS);
        else paint(); // nothing to remind about; the pill still opens a fresh list
      });
    } catch (_) {
      /* orphaned mid-read: the pill stays, the goals are simply absent */
    }
  }

  /** Called on every board refresh; cheap until the opponent's champion changes. */
  function matchTick(record) {
    if (!ui || ui.record !== record) return;
    const opp = champName(record.opponentChampion || record.opponentLegend) || null;
    if (opp === ui.opponent) return;
    ui.opponent = opp;
    // The opponent's champion has just been read off the board. If a goal
    // names them, the panel re-opens: a matchup goal is the one reminder
    // worth interrupting for, and this is the first moment it can be given.
    if (goalsFor(ui.goals, opp).matchup.length) expand(REMINDER_MS);
    else paint();
  }

  /** The match is over, however it ended: everything drawn here goes. */
  function matchEnded() {
    if (!ui) return;
    clearTimeout(ui.hideTimer);
    ui.panel.remove();
    ui.pill.remove();
    ui = null;
  }

  /* Is this node part of the panel? Goal and note text is the player's own
   * words, so the lifecycle's end-of-match scan must never read it - "win the
   * last battlefield" is a goal, not a victory banner. Same shape as
   * RATPageUI.isOwnToast, for the same reason. */
  function isOwnPanel(node) {
    const host = node && node.nodeType === 3 ? node.parentElement : node;
    return !!(host && host.closest && host.closest("#ra-tracker-goals, #ra-tracker-goals-pill"));
  }

  root.RATGoalNotes = {
    goalsFor,
    matchStarted,
    matchTick,
    matchEnded,
    isOwnPanel,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATGoalNotes;
}
