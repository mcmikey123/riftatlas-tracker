/* Rift Atlas Stats Tracker - overview statistics
 *
 * The arithmetic behind the Overview additions and the Matchup matrix view:
 * recent form, win rate bucketed by local week, and the champion-by-champion
 * matchup grid. Pure by construction - no DOM, no chrome APIs, `now` always
 * injectable - so the fiddly parts (week boundaries, DST, the ordering rules)
 * are tested rather than discovered.
 *
 * All three consume the SAME already-filtered rows the Overview tiles are
 * painted from. Nothing here filters by champion, deck, mode or date; that
 * decision belongs to the page, and making it twice is how two numbers on one
 * screen come to disagree.
 *
 * Only decided games - win or loss - move a rate, everywhere in this file.
 * Draws and unknowns are counted where a total is shown, never in a rate: a
 * rate over undecided games is not a claim anyone means to make.
 */
(function (root) {
  "use strict";

  const { champ } = root.RATrackerFormat || require("./format.js");

  const startedMs = (m) => {
    const t = Date.parse((m && m.startedAt) || "");
    return Number.isFinite(t) ? t : null;
  };

  /**
   * Your record over the most recent `n` DECIDED games of `rows`, whatever
   * order the rows arrived in.
   *
   * Decided games, not recent rows: the last ten rows of a history with three
   * unknown results carry seven results, and "7-0 of your last 10" would be
   * claiming three games that were never scored. The denominator is stated
   * back in `decided`, which is min(n, what there is) - the tile it feeds
   * writes "of last N" from it rather than from what it asked for.
   */
  function recentForm(rows, n) {
    const decided = (rows || [])
      .filter((m) => m && (m.result === "win" || m.result === "loss"))
      .map((m) => ({ t: startedMs(m) || 0, result: m.result }))
      .sort((a, b) => b.t - a.t)
      .slice(0, Math.max(0, n));
    const wins = decided.filter((m) => m.result === "win").length;
    return {
      wins,
      losses: decided.length - wins,
      decided: decided.length,
      rate: decided.length ? wins / decided.length : null,
    };
  }

  /** Local midnight on the Monday of the week `t` falls in. */
  function weekStart(t) {
    const d = new Date(t);
    // getDay counts from Sunday; matches are grouped Monday-first because a
    // weekend of games is one stretch of play, not the seam between two weeks.
    const back = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  }

  /** The Monday after `start`, stepped in calendar days so DST cannot skew it. */
  function nextWeek(start) {
    const d = new Date(start);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
  }

  /**
   * Win rate per local week, oldest first, every week between the first and
   * last dated row present - a quiet week is a real gap in the record, and
   * skipping it would draw two months as if they touched.
   *
   * At most `maxWeeks` buckets, newest kept, and the number dropped is
   * reported in `omitted` so the chart can say what it is not showing.
   * Undated rows cannot be placed and are counted in `undated` instead.
   */
  function weeklyWinRate(rows, maxWeeks) {
    const cap = Number.isFinite(maxWeeks) && maxWeeks > 0 ? maxWeeks : 52;
    const dated = [];
    let undated = 0;
    for (const m of rows || []) {
      const t = startedMs(m);
      if (t === null) undated++;
      else dated.push({ t, result: m.result });
    }
    if (!dated.length) return { weeks: [], omitted: 0, undated };

    const byWeek = new Map();
    let first = Infinity;
    let last = -Infinity;
    for (const m of dated) {
      const wk = weekStart(m.t);
      first = Math.min(first, wk);
      last = Math.max(last, wk);
      const b = byWeek.get(wk) || { games: 0, wins: 0, losses: 0 };
      b.games++;
      if (m.result === "win") b.wins++;
      if (m.result === "loss") b.losses++;
      byWeek.set(wk, b);
    }

    const weeks = [];
    for (let wk = first; wk <= last; wk = nextWeek(wk)) {
      const b = byWeek.get(wk) || { games: 0, wins: 0, losses: 0 };
      const decided = b.wins + b.losses;
      weeks.push({
        start: wk,
        games: b.games,
        wins: b.wins,
        losses: b.losses,
        decided,
        rate: decided ? b.wins / decided : null,
      });
    }

    const omitted = Math.max(0, weeks.length - cap);
    return { weeks: weeks.slice(omitted), omitted, undated };
  }

  /**
   * The champion-by-champion grid: one row per champion you played, one
   * column per champion you faced, and in each cell every game between the
   * two, with its rate over the decided ones.
   *
   * Rows and columns are ordered by how much evidence they carry - games
   * played, then name for the ties - because the corner where both orderings
   * start is then the part of the grid the numbers mean something in, and the
   * one-game curiosities pool at the far edges together.
   *
   * `cells` is keyed `mine\u0000theirs`: champions are site-supplied strings,
   * so the joiner must be something no champion name can contain.
   */
  function matchupMatrix(rows) {
    const mineCount = new Map();
    const theirsCount = new Map();
    const cells = new Map();
    for (const m of rows || []) {
      const mine = champ(m.myChampion || m.myLegend);
      const theirs = champ(m.opponentChampion || m.opponentLegend);
      mineCount.set(mine, (mineCount.get(mine) || 0) + 1);
      theirsCount.set(theirs, (theirsCount.get(theirs) || 0) + 1);
      const key = mine + "\u0000" + theirs;
      const c = cells.get(key) || { games: 0, wins: 0, losses: 0 };
      c.games++;
      if (m.result === "win") c.wins++;
      if (m.result === "loss") c.losses++;
      cells.set(key, c);
    }
    for (const c of cells.values()) {
      const decided = c.wins + c.losses;
      c.decided = decided;
      c.rate = decided ? c.wins / decided : null;
    }
    const order = (counts) =>
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name);
    return {
      mine: order(mineCount),
      theirs: order(theirsCount),
      cell: (mine, theirs) => cells.get(mine + "\u0000" + theirs) || null,
      size: cells.size,
    };
  }

  // Same dual export as table.js: a global for the browser, CommonJS for
  // `node --test`.
  const api = { recentForm, weekStart, weeklyWinRate, matchupMatrix };

  root.RATrackerStats = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
