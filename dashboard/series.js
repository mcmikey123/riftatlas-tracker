/* Rift Atlas Stats Tracker - best-of-N series
 *
 * A series is not a record. It is the set of matches sharing a `seriesId`,
 * grouped at render time exactly the way the aggregate tables group by deck.
 * That is the whole design: no new storage key, no second object to keep in
 * step with `matches`, and a deleted match simply leaves its series shorter.
 *
 * Four fields go on the match record:
 *
 *   seriesId      string | null
 *   seriesGame    1..n   | null
 *   seriesFormat  'bo3' | null   (a bo1 match is never in a series)
 *   seriesSource  'auto' | 'manual' | null
 *
 * `seriesSource` follows the convention `deckSource` and `resultSource` already
 * set: AUTO IS A GUESS THE UI WILL REVISE, MANUAL IS A FACT IT WILL NOT TOUCH.
 * Everything here honours that in one direction only - `detect` rebuilds every
 * auto grouping from scratch on each run and never reads or writes a manual one.
 *
 * Rebuilding rather than appending is what makes this safe to run on every
 * dashboard load: it is idempotent, so `Re-scan history` and the automatic pass
 * are the same call, and a series id is derived from its first game's id rather
 * than minted randomly, so two runs over the same data produce byte-identical
 * records and no spurious storage write.
 *
 * Pure: no DOM, no chrome.*, no clock except what is passed in. Tested in
 * test/series.test.js.
 */
(function (root) {
  "use strict";

  /* The site offers Best of 1 and Best of 3, and nothing else. Bo5 does not
   * exist here - the earlier draft had it because the design handoff described
   * a game rather than this one.
   *
   * bo1 is a format but never a series: one game cannot be a best-of-three, and
   * two Bo1 games against the same opponent are a rematch, not a series. It is
   * carried as a value precisely so it can say that, because a Bo1 rematch
   * inside the window is otherwise exactly what the timing rule would group. */
  const FORMATS = ["bo1", "bo3"];
  // How many games a format runs to, and how many wins takes it. A series stops
  // growing at either bound - a 2-0 Bo3 is over, and so is a 1-1-1 one.
  const FORMAT_LENGTH = { bo1: 1, bo3: 3 };
  const WINS_NEEDED = { bo1: 1, bo3: 2 };

  const DEFAULT_WINDOW_MINUTES = 45;
  const WINDOW_MIN = 5;
  const WINDOW_MAX = 240;
  const MINUTE_MS = 60000;

  /* How far outside the window a pair is still worth proposing. Four times the
   * window rather than a fixed span so it tracks the setting: someone who has
   * widened the window to three hours is telling us their sessions are long,
   * and a fixed cap would stop suggesting anything for them. */
  const SUGGEST_FACTOR = 4;

  const isFormat = (v) => FORMATS.indexOf(v) !== -1;
  const normFormat = (v) => (isFormat(v) ? v : "bo3");

  function clampWindow(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return DEFAULT_WINDOW_MINUTES;
    return Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, n));
  }

  const winsNeeded = (format) => WINS_NEEDED[normFormat(format)];
  const formatLength = (format) => FORMAT_LENGTH[normFormat(format)];

  const ms = (iso) => {
    const t = Date.parse(iso || "");
    return Number.isFinite(t) ? t : null;
  };

  // Sorting by startedAt has to be total, or two games stamped the same
  // millisecond swap places between runs and the series renumbers itself for no
  // reason. Ties break on id, which is unique and stable.
  function byStartedAt(a, b) {
    const at = ms(a.startedAt);
    const bt = ms(b.startedAt);
    if (at !== null && bt !== null && at !== bt) return at - bt;
    if (at === null && bt !== null) return 1;
    if (bt === null && at !== null) return -1;
    return String(a.id || "").localeCompare(String(b.id || ""));
  }

  const text = (v) => String(v == null ? "" : v).trim();

  /**
   * Does `cur` continue the series `prev` belongs to?
   *
   * "No other match sits between them" is not tested here: callers walk the
   * whole history in startedAt order and only ever ask about adjacent entries,
   * which makes the condition structural rather than something to re-check.
   */
  function joins(prev, cur, windowMs) {
    /* The lobby said one game. That is a fact from the site and it settles the
     * question outright: two Bo1 games against the same opponent are a
     * rematch, never a series. */
    if (prev.matchFormat === "bo1" || cur.matchFormat === "bo1") return false;

    /* A Bo3 is played against one person, so a change of opponent is not a
     * proximity guess - it is proof the previous series ended. Two matches
     * against nobody-in-particular are not evidence of anything, so an unnamed
     * opponent groups with nothing. */
    const who = text(prev.opponentName);
    if (!who || who !== text(cur.opponentName)) return false;
    if (text(prev.mode) !== text(cur.mode)) return false;

    /* THE CLOCK IS ONLY CONSULTED WHEN THE FORMAT IS UNKNOWN.
     *
     * Once both matches say bo3, the site has already told us they are games
     * of a best-of-three against the same opponent, and completion decides
     * where one series ends and the next begins. Timing adds nothing and takes
     * something away: a series played over a long session, or resumed after a
     * break, is exactly the case a window gets wrong.
     *
     * Records written before content.js began reading the lobby have no format
     * to go on, so for those the old gap rule still applies - the clock stands
     * in for the fact only where the fact is missing. */
    if (prev.matchFormat === "bo3" && cur.matchFormat === "bo3") return true;

    const ended = ms(prev.endedAt);
    const started = ms(cur.startedAt);
    // A previous match with no end is still being played; there is no gap to
    // measure yet, and guessing one would group a live match into a series it
    // may turn out to have nothing to do with.
    if (ended === null || started === null) return false;
    const gap = started - ended;
    return gap >= 0 && gap <= windowMs;
  }

  /** Wins and losses from the series' owner's point of view. */
  function tally(games) {
    let mine = 0;
    let theirs = 0;
    for (const g of games) {
      if (g.result === "win") mine++;
      else if (g.result === "loss") theirs++;
    }
    return { mine, theirs };
  }

  /** A series stops growing at the format length, or once one side has taken it. */
  function isComplete(games, format) {
    if (games.length >= formatLength(format)) return true;
    const need = winsNeeded(format);
    const t = tally(games);
    return t.mine >= need || t.theirs >= need;
  }

  const clearSeries = (m) => {
    m.seriesId = null;
    m.seriesGame = null;
    m.seriesFormat = null;
    m.seriesSource = null;
  };

  /* Derived from the first game rather than randomly generated, so a re-scan
   * produces the identical id and the write that follows is a no-op. A random
   * id would make every dashboard load rewrite every series. */
  const mintId = (firstGame) => "s_" + String(firstGame.id);

  function assign(games, format, source) {
    const id = mintId(games[0]);
    games.forEach((g, i) => {
      g.seriesId = id;
      g.seriesGame = i + 1;
      g.seriesFormat = format;
      g.seriesSource = source;
    });
    return id;
  }

  /**
   * Rebuild every automatic series over the whole history.
   *
   * Returns `{ matches, changed }` where `matches` is a new array of new objects
   * - callers persist it only when `changed` is non-zero, which is what keeps an
   * idle dashboard from writing to storage on every load.
   *
   * Manual records are copied through untouched and also act as walls: a hand-
   * grouped match neither joins an automatic series nor lets one span it.
   */
  function detect(matches, opts) {
    const options = opts || {};
    const windowMs = clampWindow(options.windowMinutes) * MINUTE_MS;
    /* Only ever the fallback now. content.js reads the real format off the
     * lobby and stores it on the match, so this applies to records written
     * before that existed - and since bo1 never forms a series, every series
     * that does form is a Bo3. */
    const fallback = normFormat(options.format);
    const enabled = options.enabled !== false;

    const ordered = (matches || [])
      .filter((m) => m && m.id)
      .map((m) => Object.assign({}, m))
      .sort(byStartedAt);

    const before = ordered.map(snapshot);

    for (const m of ordered) {
      if (m.seriesSource !== "manual") clearSeries(m);
    }

    if (enabled) {
      // Runs of adjacent matches that each continue the one before. Splitting on
      // the join test first, then on completion, keeps the two rules separate:
      // one is about whether these are the same sitting, the other about whether
      // the series is already over.
      let run = [];
      const runs = [];
      const flush = () => {
        if (run.length > 1) runs.push(run);
        run = [];
      };
      for (let i = 0; i < ordered.length; i++) {
        const m = ordered[i];
        if (m.seriesSource === "manual") {
          flush();
          continue;
        }
        const prev = i > 0 ? ordered[i - 1] : null;
        if (!prev || prev.seriesSource === "manual" || !joins(prev, m, windowMs)) {
          flush();
          run = [m];
        } else {
          run.push(m);
        }
      }
      flush();

      for (const games of runs) {
        // One sitting can hold more than one series: a completed Bo3 followed by
        // another game against the same opponent inside the window starts a
        // second series rather than becoming a four-game first one.
        // The format the games themselves report, falling back only for
        // records written before content.js captured it.
        const fmt = normFormat(games[0].matchFormat || fallback);
        let segment = [];
        for (const g of games) {
          segment.push(g);
          if (isComplete(segment, fmt)) {
            if (segment.length > 1) assign(segment, fmt, "auto");
            segment = [];
          }
        }
        if (segment.length > 1) assign(segment, fmt, "auto");
      }
    }

    let changed = 0;
    ordered.forEach((m, i) => {
      if (snapshot(m) !== before[i]) changed++;
    });
    return { matches: ordered, changed };
  }

  const snapshot = (m) =>
    [m.seriesId || "", m.seriesGame == null ? "" : m.seriesGame, m.seriesFormat || "", m.seriesSource || ""].join("|");

  /**
   * The series present in a set of matches, newest first.
   *
   * Every field the Series view shows is derived here rather than in the view,
   * so the same numbers back the table, the tiles and the badge.
   */
  function group(matches) {
    const bySeries = new Map();
    for (const m of matches || []) {
      if (!m || !m.seriesId) continue;
      if (!bySeries.has(m.seriesId)) bySeries.set(m.seriesId, []);
      bySeries.get(m.seriesId).push(m);
    }
    const out = [];
    for (const [id, raw] of bySeries) {
      const games = raw.slice().sort((a, b) => {
        const ag = Number(a.seriesGame);
        const bg = Number(b.seriesGame);
        if (Number.isFinite(ag) && Number.isFinite(bg) && ag !== bg) return ag - bg;
        return byStartedAt(a, b);
      });
      out.push(seriesRecord(id, games));
    }
    return out.sort((a, b) => {
      const at = ms(a.startedAt);
      const bt = ms(b.startedAt);
      if (at !== null && bt !== null && at !== bt) return bt - at;
      return String(b.id).localeCompare(String(a.id));
    });
  }

  function seriesRecord(id, games) {
    const format = normFormat(games[0] && games[0].seriesFormat);
    const t = tally(games);
    const need = winsNeeded(format);
    // A live game anywhere in the series makes the whole series live: its result
    // is not knowable yet, and its total length is not a number.
    const live = games.some((g) => !g.endedAt);
    let result;
    if (live) result = "live";
    else if (t.mine >= need) result = "win";
    else if (t.theirs >= need) result = "loss";
    else result = "unfinished";

    // The deciding game is the one that took the series - the game at which a
    // side first reached the wins it needed. Unfinished series have none.
    let decider = null;
    if (result === "win" || result === "loss") {
      let mine = 0;
      let theirs = 0;
      for (const g of games) {
        if (g.result === "win") mine++;
        else if (g.result === "loss") theirs++;
        if (mine >= need || theirs >= need) {
          decider = g.id;
          break;
        }
      }
    }

    const durations = games.map((g) => g.durationMs).filter((d) => Number.isFinite(d) && d > 0);
    const decks = [];
    for (const g of games) {
      const d = text(g.deckName);
      const name = d || "— unlabelled —";
      if (decks.indexOf(name) === -1) decks.push(name);
    }

    return {
      id,
      games,
      format,
      source: games[0] && games[0].seriesSource === "manual" ? "manual" : "auto",
      opponentName: text(games[0] && games[0].opponentName),
      mode: text(games[0] && games[0].mode),
      startedAt: games[0] && games[0].startedAt,
      endedAt: games[games.length - 1] && games[games.length - 1].endedAt,
      wins: t.mine,
      losses: t.theirs,
      result,
      live,
      decider,
      decks,
      // Null, not zero, when nothing was timed: a series of untimed games has no
      // total, and rendering 0:00 would claim it was instant.
      totalMs: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
      complete: isComplete(games, format),
    };
  }

  /**
   * The figures the Series view's tiles show.
   *
   * Unfinished series are counted in the games figures but excluded from the
   * series win rate, because a series still in progress has not been won or lost
   * and averaging it in either direction would be an invention.
   */
  function stats(seriesList) {
    const list = seriesList || [];
    let wins = 0;
    let losses = 0;
    let gameWins = 0;
    let gameLosses = 0;
    let lostFirst = 0;
    let lostFirstRecovered = 0;
    let deciders = 0;

    for (const s of list) {
      if (s.result === "win") wins++;
      else if (s.result === "loss") losses++;
      gameWins += s.wins;
      gameLosses += s.losses;
      if (s.games.length === formatLength(s.format)) deciders++;
      const first = s.games[0];
      if (first && first.result === "loss" && (s.result === "win" || s.result === "loss")) {
        lostFirst++;
        if (s.result === "win") lostFirstRecovered++;
      }
    }

    const decided = wins + losses;
    const gamesDecided = gameWins + gameLosses;
    return {
      series: list.length,
      wins,
      losses,
      decided,
      // Null rather than 0 when nothing is decided, so the tile can render "–"
      // instead of claiming a 0% win rate nobody earned.
      winRate: decided ? wins / decided : null,
      gameWins,
      gameLosses,
      gameWinRate: gamesDecided ? gameWins / gamesDecided : null,
      lostFirst,
      lostFirstRecovered,
      lostFirstRate: lostFirst ? lostFirstRecovered / lostFirst : null,
      deciders,
    };
  }

  /**
   * Pairs that look like a series but fell outside the rule, offered rather than
   * applied. The stable `key` is what a dismissal is remembered against, so the
   * same pair is not proposed twice.
   */
  function suggestions(matches, opts) {
    const options = opts || {};
    const windowMinutes = clampWindow(options.windowMinutes);
    const windowMs = windowMinutes * MINUTE_MS;
    const outerMs = windowMs * SUGGEST_FACTOR;
    const dismissed = options.dismissed || new Set();

    const ordered = (matches || [])
      .filter((m) => m && m.id)
      .slice()
      .sort(byStartedAt);

    const out = [];
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      // Anything already grouped, by hand or otherwise, is not a suggestion.
      if (prev.seriesId || cur.seriesId) continue;
      if (prev.seriesSource === "manual" || cur.seriesSource === "manual") continue;
      const who = text(prev.opponentName);
      if (!who || who !== text(cur.opponentName)) continue;
      if (text(prev.mode) !== text(cur.mode)) continue;
      const ended = ms(prev.endedAt);
      const started = ms(cur.startedAt);
      if (ended === null || started === null) continue;
      const gap = started - ended;
      // Inside the window it is not a suggestion, it is a bug in detection.
      if (gap <= windowMs || gap > outerMs) continue;
      const key = prev.id + "|" + cur.id;
      if (dismissed.has && dismissed.has(key)) continue;
      out.push({
        key,
        ids: [prev.id, cur.id],
        opponentName: who,
        gapMinutes: Math.round(gap / MINUTE_MS),
        windowMinutes,
        startedAt: cur.startedAt,
      });
    }
    return out;
  }

  /**
   * Group chosen matches by hand. Game order comes from `startedAt` - the user
   * never numbers anything themselves - and the result is `manual`, so no later
   * detection pass will revise it.
   */
  function groupManually(matches, ids, format) {
    const wanted = new Set(ids || []);
    const out = (matches || []).map((m) => Object.assign({}, m));
    const chosen = out.filter((m) => wanted.has(m.id)).sort(byStartedAt);
    if (chosen.length < 2) return { matches: out, seriesId: null };
    const seriesId = assign(chosen, normFormat(format), "manual");
    return { matches: out, seriesId };
  }

  /**
   * Take one match out of its series and renumber what is left. Also the delete
   * path: a series whose match has gone is simply shorter, and the games that
   * remain must not keep numbers with a hole in them.
   *
   * A series of one is not a series, so removing the second-to-last game
   * dissolves it rather than leaving a lone match wearing a `G1` badge.
   */
  function removeFromSeries(matches, matchId) {
    const out = (matches || []).map((m) => Object.assign({}, m));
    const target = out.find((m) => m.id === matchId);
    if (!target || !target.seriesId) return out;
    const seriesId = target.seriesId;
    clearSeries(target);
    /* The removed game is marked manual with no series of its own. 'manual' is
     * the only thing detect() will not revise, and without it the next pass
     * sees a free automatic match sitting beside its old neighbours and groups
     * it straight back. The survivors below are walls that cover the case of a
     * series of three or more - but a series of TWO dissolves entirely, leaving
     * no wall at all and both games free to reform the identical series on the
     * very next render. */
    target.seriesSource = "manual";
    /* The survivors become manual. Without this they keep seriesSource 'auto',
     * detect() clears every non-manual record on its next pass, and the game
     * just removed is regrouped straight back in - the removal would undo
     * itself within one render. */
    for (const m of out) {
      if (m.seriesId === seriesId) m.seriesSource = "manual";
    }
    return renumber(out, seriesId);
  }

  /** Renumber a series' remaining games 1..n in `startedAt` order. */
  function renumber(matches, seriesId) {
    const out = matches || [];
    const games = out.filter((m) => m && m.seriesId === seriesId).sort(byStartedAt);
    if (games.length < 2) {
      games.forEach(clearSeries);
      return out;
    }
    games.forEach((g, i) => {
      g.seriesGame = i + 1;
    });
    return out;
  }

  /**
   * Clear the series fields on everything not grouped by hand.
   *
   * Automatic grouping is derived and must never reach storage. An edit made
   * against a derived series has to materialise those fields to work on them,
   * so this is what runs before the write: whatever the edit marked manual
   * stays, everything else goes back to being recomputed each render.
   */
  function stripAuto(matches) {
    const out = (matches || []).map((m) => Object.assign({}, m));
    for (const m of out) {
      if (m.seriesSource !== "manual") clearSeries(m);
    }
    return out;
  }

  /** Change one series' format without changing the configured default. */
  function setFormat(matches, seriesId, format) {
    const out = (matches || []).map((m) => Object.assign({}, m));
    for (const m of out) {
      if (m.seriesId !== seriesId) continue;
      m.seriesFormat = normFormat(format);
      m.seriesSource = "manual";
    }
    return out;
  }

  root.RATrackerSeries = {
    FORMATS,
    FORMAT_LENGTH,
    WINS_NEEDED,
    DEFAULT_WINDOW_MINUTES,
    WINDOW_MIN,
    WINDOW_MAX,
    clampWindow,
    normFormat,
    winsNeeded,
    formatLength,
    joins,
    isComplete,
    detect,
    group,
    seriesRecord,
    stats,
    suggestions,
    groupManually,
    removeFromSeries,
    renumber,
    stripAuto,
    setFormat,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerSeries;
}
