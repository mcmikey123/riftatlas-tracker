/* Rift Atlas Stats Tracker - goals on the game page, and timestamped mid-game notes.
 *
 * Two things live here, and they share one panel because they share a moment:
 * right before a game is when a reminder is worth reading, and mid-game is
 * when "review this later" is worth writing down.
 *
 * GOALS are written in the dashboard's Goals view and stored under the `goals`
 * key: things to work on, in every game or against one champion. The panel is
 * driven by content.js's tick through `observe`, the same clock that drives
 * the capture itself, and follows what the board says:
 *
 *   a PREGAME board - battlefield pick, roll, mulligan - pops the applicable
 *   goals up, because that is the moment a reminder can still change how you
 *   play; the opponent's champion is often already on screen there, so the
 *   matchup goals usually arrive with it, and re-open the panel when they do;
 *
 *   a LIVE match keeps the panel and adds the note input, folding down to a
 *   small ⚑ pill after half a minute so it never blocks play;
 *
 *   anything else takes it all down.
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

  // How long the reminder stays open DURING A MATCH before folding to the
  // pill; the end-of-match toast stands for the same 30 seconds. On a pregame
  // board there is no timer - those screens are exactly the ones with time to
  // read, and the board moving on takes the panel with it anyway.
  const REMINDER_MS = 30000;
  // The label length the replay viewer renders on a flag chip
  // (dashboard/replay-html.js slices to 80); the input stops at the same
  // point so nothing typed here is silently cut later.
  const MAX_NOTE_CHARS = 80;
  // Pregame boards are re-read for the opponent at most this often. The tick
  // fires on every mutation frame, and cardAlt walks the document.
  const OPP_READ_MS = 1000;

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

  /**
   * The matchup note for this opponent, or "". These are the popup's
   * per-champion notes (its `matchupNotes` key - "shows here whenever you
   * face X") - and a note that exists to be read right before a game belongs
   * on the game page at that moment as much as in the popup. The popup keys
   * them by champion name; keys stored as full alt text are read leniently
   * rather than dropped.
   */
  function noteFor(notes, opponentAlt) {
    const opp = champName(opponentAlt);
    if (!opp || !notes) return "";
    for (const key of Object.keys(notes)) {
      const text = notes[key];
      if (champName(key) === opp && typeof text === "string" && text.trim()) return text.trim();
    }
    return "";
  }

  /**
   * What the panel should be, given what this tick saw: a live match wins, a
   * board in any phase short of "in_game" is a pregame screen, and everything
   * else - no board, or a finished game's board lingering with no record -
   * means no panel. Pure, because content.js calls it via `observe` on every
   * tick and getting it wrong is silent.
   */
  function stateFor(phase, live) {
    if (live) return "live";
    if (phase && phase !== "in_game") return "pregame";
    return "off";
  }

  // ---------- the panel ----------

  let ui = null; // { mode, opponent, goals, notes, noted, hideTimer, panel, list, input, pill }
  let oppReadAt = 0;
  // The one time this page load may open the panel with nothing to show: a
  // pregame board and no goals set. Discoverability, not nagging - once per
  // tab, and the empty state says where goals are written.
  let introShown = false;

  const esc = (s) => root.RATPageUI.escapeHtml(s);

  /** `m:ss` into the match, for the "noted" receipt line. */
  const clock = (ms) => {
    const t = Math.max(0, Math.round(ms / 1000));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  };

  /** Matchup goals, then the matchup note, then the generic goals, then the
   *  receipts for notes already taken this game. */
  function goalRowsHtml() {
    const { matchup, generic } = goalsFor(ui.goals, ui.opponent);
    const note = noteFor(ui.notes, ui.opponent);
    const row = (g, vs) =>
      `<div class="rat-goal${vs ? " rat-goal-vs" : ""}">${
        vs ? `<span class="rat-vstag">vs ${esc(champName(g.opponent))}</span>` : ""
      }${esc(g.text)}</div>`;
    const rows = matchup.map((g) => row(g, true));
    if (note) {
      rows.push(
        `<div class="rat-mnote"><span class="rat-vstag">vs ${esc(ui.opponent)}</span>${esc(note)}</div>`
      );
    }
    rows.push(...generic.map((g) => row(g, false)));
    const noted = ui.noted
      .map((n) => `<div class="rat-noted">⚑ ${esc(clock(n.ms))} · ${esc(n.text)}</div>`)
      .join("");
    if (!rows.length) {
      return (
        '<div class="rat-goal rat-goal-none">No goals set — add some under Goals in the dashboard, or a matchup note in the popup.</div>' +
        noted
      );
    }
    return rows.join("") + noted;
  }

  /** How many things the panel has to say against this opponent right now. */
  function applicableCount() {
    const { matchup, generic } = goalsFor(ui.goals, ui.opponent);
    return matchup.length + generic.length + (noteFor(ui.notes, ui.opponent) ? 1 : 0);
  }

  function paint() {
    if (ui) ui.list.innerHTML = goalRowsHtml();
  }

  /* Opening the panel arms the fold-down timer only during a live match -
   * see REMINDER_MS. Passing 0 keeps it open until something closes it. */
  function expand(autoHideMs) {
    if (!ui) return;
    clearTimeout(ui.hideTimer);
    ui.hideTimer = null;
    paint();
    ui.panel.style.display = "block";
    ui.pill.style.display = "";
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

  function build(mode) {
    const doc = root.document;

    const panel = doc.createElement("div");
    panel.id = "ra-tracker-goals";
    panel.className = "ra-tracker-block"; // keeps our own UI out of the visual replay
    // style.display rather than the hidden attribute: the site's own CSS can
    // outrank the UA's [hidden] rule, and this page is not ours.
    panel.style.display = "none";

    const head = doc.createElement("div");
    head.className = "rat-ghead";
    head.innerHTML =
      '<span class="rat-title">' +
      (mode === "live" ? "Rift Atlas Tracker · this game" : "Rift Atlas Tracker · up next") +
      "</span>";
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

    // Notes need a live match to be filed on; a pregame panel is a reminder
    // and nothing else, so the input does not appear until the game does.
    if (mode !== "live") {
      row.style.display = "none";
      hint.style.display = "none";
    }

    panel.appendChild(head);
    panel.appendChild(list);
    panel.appendChild(row);
    panel.appendChild(hint);

    const pill = doc.createElement("button");
    pill.id = "ra-tracker-goals-pill";
    pill.className = "ra-tracker-block"; // keeps our own UI out of the visual replay
    pill.title = "Goals & mid-game notes (Rift Atlas Tracker)";
    pill.innerHTML = "⚑";
    // On a pregame board with no goals there is nothing behind the pill
    // either; it appears with the panel (expand shows it) or with a match.
    if (mode !== "live") pill.style.display = "none";
    pill.addEventListener("click", () =>
      ui && ui.panel.style.display === "none" ? expand(0) : collapse()
    );

    const host = doc.body || doc.documentElement;
    host.appendChild(panel);
    host.appendChild(pill);
    return { panel, list, input, pill };
  }

  /** Stand the panel up in `mode` and open it if any goal applies. */
  function show(mode) {
    const built = build(mode);
    ui = {
      mode,
      opponent: null,
      goals: [],
      notes: {},
      noted: [],
      hideTimer: null,
      panel: built.panel,
      list: built.list,
      input: built.input,
      pill: built.pill,
    };
    try {
      chrome.storage.local.get({ goals: [], matchupNotes: {} }, (data) => {
        if (!ui || ui.panel !== built.panel) return; // the screen moved on while storage answered
        ui.goals = (data && data.goals) || [];
        ui.notes = (data && data.matchupNotes) || {};
        const n = applicableCount();
        if (n) {
          expand(ui.mode === "live" ? REMINDER_MS : 0);
          console.info("[RA-Tracker] goals: showing " + n + " for this game");
        } else if (ui.mode !== "live" && !introShown) {
          // Nothing configured yet: a pregame board gets the empty state once
          // per page load, so the feature can be found without reading docs.
          introShown = true;
          expand(0);
          console.info("[RA-Tracker] goals: none set - showing where to add them, once");
        } else {
          paint(); // nothing to remind about; a live match still gets the note pill
          console.info("[RA-Tracker] goals: none apply (add some under Goals in the dashboard)");
        }
      });
    } catch (_) {
      /* orphaned mid-read: the pill stays where it applies, the goals are absent */
    }
  }

  function teardown() {
    if (!ui) return;
    clearTimeout(ui.hideTimer);
    ui.panel.remove();
    ui.pill.remove();
    ui = null;
  }

  /** The opponent's champion as read this tick; reopens the panel when a
   *  matchup goal starts to apply - the reminder those goals exist for. */
  function setOpponent(alt) {
    if (!ui) return;
    const opp = champName(alt) || null;
    if (opp === ui.opponent) return;
    ui.opponent = opp;
    const n = goalsFor(ui.goals, opp).matchup.length + (noteFor(ui.notes, opp) ? 1 : 0);
    if (n) {
      expand(ui.mode === "live" ? REMINDER_MS : 0);
      console.info("[RA-Tracker] goals: " + n + " for the matchup vs " + opp);
    } else {
      paint();
    }
  }

  /**
   * Driven by content.js on every tick, after the lifecycle has decided what
   * this frame was. A mode change is a teardown and a fresh build rather than
   * an edit: the pregame panel and the live one differ (the note input, the
   * fold-down timer), and a rebuild re-reads the goals and re-decides whether
   * to open - which is also what makes pregame -> live re-offer the reminder.
   */
  function observe(phase, live) {
    const next = stateFor(phase, live);
    if (next === "off") return teardown();
    if (ui && ui.mode !== next) teardown();
    if (!ui) show(next);
    if (next === "live") {
      setOpponent(live.opponentChampion || live.opponentLegend);
    } else if (Date.now() - oppReadAt >= OPP_READ_MS) {
      // No record exists yet on a pregame board, so the opponent comes off
      // the page the same way capture/scout.js reads it.
      oppReadAt = Date.now();
      setOpponent(
        root.RATBoard.cardAlt("opponent", "champion") ||
          root.RATBoard.cardAlt("opponent", "legend")
      );
    }
  }

  /* Goals edited in the dashboard - or a matchup note typed in the popup -
   * mid-session reach a panel already on screen. Data only; visibility stays
   * observe's. */
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !ui) return;
      if (!changes.goals && !changes.matchupNotes) return;
      if (changes.goals) ui.goals = changes.goals.newValue || [];
      if (changes.matchupNotes) ui.notes = changes.matchupNotes.newValue || {};
      paint();
    });
  } catch (_) {
    /* not an extension context (tests); observe still works when driven */
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
    noteFor,
    stateFor,
    observe,
    isOwnPanel,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATGoalNotes;
}
