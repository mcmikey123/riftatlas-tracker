/* Rift Atlas Stats Tracker - the Overview
 *
 * Five tiles and three aggregate tables over one filtered array, plus the
 * banner that says an archive file is open.
 *
 * Two things here are decidable from data alone and are therefore tested rather
 * than trusted: WHICH matches the view is describing (`overviewRows`) and what
 * one aggregate table says about them (`tileText`, `aggHtml`). Both have been
 * wrong in ways nothing throws on - a filter this side never read, and a rate
 * of "0%" printed for a group with no decided games at all, which reads as
 * "lost them all" rather than "nothing to average".
 *
 * The filter row itself is static markup shared by every view, so the controls
 * are READ here rather than owned: `filtered()` samples them and hands their
 * values to the pure half. That is also why this file is a classic script - the
 * module half keeps the same values in state.js, and this side cannot import
 * it. RATrackerTable is on the global and owns the same range arithmetic the
 * Matches table uses, so both sides answer the date question the same way.
 */
(function (root) {
  "use strict";

  // format.js and table.js are loaded first by dashboard.html; the requires are
  // for node.
  const { esc, champ, fmtDuration, deckOf } = root.RATrackerFormat || require("./format.js");
  const TABLE = root.RATrackerTable || require("./table.js");

  /* Nothing below dereferences a query result directly. This view renders into
   * markup that is itself mid-port, so an element it reaches for may already be
   * gone - and one unguarded access during a render takes the rest of the paint
   * with it. Same idiom, and same reason, as legacy.js. */
  const $ = (s) => document.querySelector(s);
  const val = (sel) => {
    const el = $(sel);
    return el ? el.value : "";
  };
  const isChecked = (sel) => {
    const el = $(sel);
    return !!(el && el.checked);
  };
  const setText = (sel, s) => {
    const el = $(sel);
    if (el) el.textContent = s;
  };

  // Supplied by mount(): the match array, whether an archive is open, and what
  // that archive is. All three are the dashboard's state, not this view's.
  let matches = () => [];
  let readOnly = () => false;
  let archiveOf = () => null;
  let render = () => {};

  // ---- which matches the view is describing ------------------------------

  /**
   * The filtered set, from control VALUES rather than from the controls.
   *
   * Deliberately not shared with view-matches.js's `visibleMatches`, which
   * applies the same three field filters and the same range to answer a
   * different question: the history lists a match whose result was never read -
   * it is exactly the one you came here to fix - while the STATS exclude it
   * unless the box is ticked, because a win rate that counts unknowns as losses
   * is a false claim. That clause is the whole difference, and it is the reason
   * the two predicates are not one.
   */
  function overviewRows(all, controls) {
    const c = controls || {};
    const rows = (all || []).filter((m) => {
      if (c.champion && champ(m.myChampion || m.myLegend) !== c.champion) return false;
      if (c.deck && deckOf(m) !== c.deck) return false;
      if (c.mode && m.mode !== c.mode) return false;
      if (!c.unknown && (m.result === "unknown" || !m.result)) return false;
      return true;
    });
    if (!TABLE) return rows;
    return TABLE.inRange(rows, { preset: c.preset || "all", from: c.from, to: c.to }, "startedAt");
  }

  /* The filter row sits above every view and says so: "Filters apply to every
   * view". The date range was the one control this side never read, so picking
   * "Last 7 days" narrowed the Matches table and left every Overview tile and
   * all three aggregate tables showing all-time numbers - under that note. */
  const filtered = () =>
    overviewRows(matches(), {
      champion: val("#fMyChampion"),
      mode: val("#fMode"),
      deck: val("#fDeck"),
      unknown: isChecked("#fUnknown"),
      preset: val("#fDates") || "all",
      from: val("#fFrom"),
      to: val("#fTo"),
    });

  // ---- the tiles ---------------------------------------------------------

  /**
   * What the five tiles say about a set of matches.
   *
   * A win rate with no decided games is a dash rather than 0%, and the rate
   * carries its own denominator: 57% of 207 and 57% of 7 are not the same
   * claim.
   */
  function tileText(rows) {
    const wins = rows.filter((m) => m.result === "win").length;
    const losses = rows.filter((m) => m.result === "loss").length;
    const decided = wins + losses;
    const durations = rows.map((m) => m.durationMs).filter((d) => Number.isFinite(d) && d > 0);
    return {
      games: rows.length,
      wins,
      losses,
      winrate: decided ? Math.round((wins / decided) * 100) + "%" : "–",
      decided: decided ? `of ${decided} decided` : "",
      duration: durations.length
        ? fmtDuration(durations.reduce((a, b) => a + b, 0) / durations.length)
        : "–",
    };
  }

  // ---- the aggregate tables ----------------------------------------------

  /* How many rows an aggregate table shows before it offers "see all".
   *
   * Nothing is hidden silently: the footer states the true total and expanding
   * is one click, in place. The cap exists because a long tail of one-game
   * opponents pushes the rows that carry weight off the screen. */
  const AGG_LIMIT = 8;
  const aggExpanded = new Set();

  /* Four steps of one hue. The break points are quarters of the range rather
   * than anything about good or bad: this encodes magnitude, not judgement. */
  const rateStep = (rate) => (rate >= 0.75 ? 4 : rate >= 0.5 ? 3 : rate >= 0.25 ? 2 : 1);

  /**
   * One aggregate table's body: rows grouped by `keyFn`, most games first.
   *
   * `key` is the table's own id, which is what the "see all" button carries and
   * what `expanded` is keyed by - one open table must not expand the others.
   */
  function aggHtml(rows, keyFn, key, expanded) {
    const agg = new Map();
    for (const m of rows) {
      const k = keyFn(m);
      const a = agg.get(k) || { games: 0, w: 0, l: 0 };
      a.games++;
      if (m.result === "win") a.w++;
      if (m.result === "loss") a.l++;
      agg.set(k, a);
    }
    if (!agg.size) {
      return '<tr><td colspan="5" class="empty">No matches recorded yet.</td></tr>';
    }

    const ranked = [...agg.entries()].sort((a, b) => b[1].games - a[1].games);
    const shown = expanded ? ranked : ranked.slice(0, AGG_LIMIT);

    return (
      shown
        .map(([name, a]) => {
          const decided = a.w + a.l;
          const rate = decided ? a.w / decided : null;
          const pct = rate === null ? 0 : Math.round(rate * 100);
          // An unnamed deck is a hint, not a deck whose name is "Unlabelled".
          const unlabelled = name === "Unlabelled";
          const label = unlabelled ? "— unlabelled —" : esc(name);
          return `<tr>
          <td class="${unlabelled ? "unlabelled" : ""}">${label}</td>
          <td>${a.games}</td><td>${a.w}</td><td>${a.l}</td>
          <td><div class="bar-wrap"><div class="bar-track">${
            // No decided results: an empty track and a dash. A zero-width bar
            // at 0% would read as "lost them all".
            rate === null ? "" : `<div class="bar rate-${rateStep(rate)}" style="width:${pct}%"></div>`
          }</div><span class="pct">${rate === null ? "–" : pct + "%"}</span></div></td>
        </tr>`;
        })
        .join("") +
      (ranked.length > AGG_LIMIT
        ? `<tr><td colspan="5" class="agg-more">Showing ${shown.length} of ${ranked.length}
             <button data-aggmore="${esc(key)}">${expanded ? "show fewer" : "see all"}</button></td></tr>`
        : "")
    );
  }

  function renderAgg(tbody, rows, keyFn) {
    if (!tbody) return;
    const table = tbody.closest("table");
    const key = table ? table.id : "";
    tbody.innerHTML = aggHtml(rows, keyFn, key, aggExpanded.has(key));
  }

  // ---- the paint ---------------------------------------------------------

  function renderOverview() {
    const rows = filtered();
    const t = tileText(rows);
    setText("#tGames", t.games);
    setText("#tWins", t.wins);
    setText("#tLosses", t.losses);
    setText("#tWinrate", t.winrate);
    setText("#tDecided", t.decided);
    setText("#tDuration", t.duration);

    renderAgg($("#vsTable tbody"), rows, (m) => champ(m.opponentChampion || m.opponentLegend));
    renderAgg($("#deckTable tbody"), rows, deckOf);
    renderAgg($("#myTable tbody"), rows, (m) => champ(m.myChampion || m.myLegend));
  }

  function renderArchiveBanner() {
    const b = $("#archiveBanner");
    if (!b) return;
    const archive = archiveOf();
    b.hidden = !archive;
    if (archive) {
      setText(
        "#archiveBannerText",
        `Viewing archive “${archive.name}” — ${archive.matches.length} matches, read-only. Your live data is untouched.`
      );
      const nag = $("#backupBanner");
      if (nag) nag.hidden = true; // not about the archive you're viewing
    }
    document.body.classList.toggle("read-only", readOnly());
  }

  // ---- events this view owns ---------------------------------------------

  /* One attribute, carried only by the footer button this file draws. Nothing
   * else on the page listens for it, so where this listener sits among the
   * others does not matter - the click reaches no other branch. */
  function mount(deps) {
    matches = deps.matches;
    readOnly = deps.readOnly;
    archiveOf = deps.archive;
    render = deps.render;

    document.addEventListener("click", (e) => {
      const aggMore = e.target?.dataset?.aggmore;
      if (!aggMore) return;
      if (aggExpanded.has(aggMore)) aggExpanded.delete(aggMore);
      else aggExpanded.add(aggMore);
      render();
    });
  }

  root.RATrackerViewOverview = {
    overviewRows,
    tileText,
    aggHtml,
    AGG_LIMIT,
    renderOverview,
    renderArchiveBanner,
    mount,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerViewOverview;
}
