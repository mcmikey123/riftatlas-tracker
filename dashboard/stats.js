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
      const c =
        cells.get(key) ||
        { games: 0, wins: 0, losses: 0, first: { wins: 0, losses: 0 }, second: { wins: 0, losses: 0 } };
      c.games++;
      if (m.result === "win") c.wins++;
      if (m.result === "loss") c.losses++;
      // The going-first split, kept per cell so a matchup that only looks even
      // can show it is really "fine on the play, poor on the draw". Rows with
      // no answer are simply absent from both halves.
      const half = m.wentFirst === true ? c.first : m.wentFirst === false ? c.second : null;
      if (half) {
        if (m.result === "win") half.wins++;
        if (m.result === "loss") half.losses++;
      }
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

  /**
   * The going-first split over `rows`: one record for games you opened, one
   * for games you didn't, and how many rows carry no answer at all.
   *
   * `unknown` is reported, never hidden: most histories predate the field, and
   * a split shown without its denominator would read as if it covered them.
   */
  function goingFirstSplit(rows) {
    const side = () => ({ games: 0, wins: 0, losses: 0 });
    const first = side();
    const second = side();
    let unknown = 0;
    for (const m of rows || []) {
      const s = m && m.wentFirst === true ? first : m && m.wentFirst === false ? second : null;
      if (!s) {
        unknown++;
        continue;
      }
      s.games++;
      if (m.result === "win") s.wins++;
      if (m.result === "loss") s.losses++;
    }
    for (const s of [first, second]) {
      s.decided = s.wins + s.losses;
      s.rate = s.decided ? s.wins / s.decided : null;
    }
    return { first, second, unknown };
  }

  /**
   * Per-battlefield performance over games whose logs were read.
   *
   * `games` is [{ result, conquests: [{name, actor}] }] - the caller runs
   * RATrackerAnalysis.conquests over each log, because loading logs is the
   * page's business and this file has no storage.
   *
   * A battlefield's row counts the games it APPEARED in (someone conquered it
   * at least once that game), your match record in those games, and the
   * conquest count for each side. Ordered by games seen, names breaking ties,
   * same rule as the matchup grid.
   */
  function battlefieldStats(games) {
    const rows = new Map();
    for (const g of games || []) {
      const seen = new Set();
      for (const c of g.conquests || []) {
        const r = rows.get(c.name) || {
          name: c.name, games: 0, wins: 0, losses: 0, myTakes: 0, oppTakes: 0,
        };
        if (c.actor === "self") r.myTakes++;
        else if (c.actor === "opponent") r.oppTakes++;
        if (!seen.has(c.name)) {
          seen.add(c.name);
          r.games++;
          if (g.result === "win") r.wins++;
          if (g.result === "loss") r.losses++;
        }
        rows.set(c.name, r);
      }
    }
    const out = [...rows.values()];
    for (const r of out) {
      const decided = r.wins + r.losses;
      r.decided = decided;
      r.rate = decided ? r.wins / decided : null;
    }
    return out.sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
  }

  // Same dual export as table.js: a global for the browser, CommonJS for
  // `node --test`.
  const api = {
    recentForm, weekStart, weeklyWinRate, matchupMatrix, goingFirstSplit, battlefieldStats,
  };

  root.RATrackerStats = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
