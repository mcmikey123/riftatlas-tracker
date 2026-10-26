/* Rift Atlas Stats Tracker - the site's own game history, read as plain data
 *
 * Rift Atlas keeps a short-lived official replay of every game: a JSON action
 * log with full information - the opponent's hand included - that its own
 * viewer can open from a file. The server copy expires a few hours after the
 * game, so the extension fetches each one while it can and keeps it locally.
 *
 * Everything decidable without the network or the DOM is here, so it is
 * tested: what a history row says, which rows are worth fetching, which of
 * OUR match records a row is, and whether a session token is still good.
 * The fetching is official/sync.js; the storing is background.js.
 */
(function (root) {
  "use strict";

  // The site's own token endpoint: a POST with the auth cookie returns {token},
  // the short-lived JWT the two calls below are authenticated with.
  const TOKEN_URL = "https://auth.riftatlas.com/api/auth/token";
  const LIST_URL = "https://data.riftatlas-workers.com/rpc/gameHistory:list";
  const REPLAY_URL = "https://realtime.riftatlas-workers.com/api/replays/";
  const REPLAY_ACCEPT = "application/vnd.riftatlas.replay+json;version=2";
  const VIEWER_URL = "https://play.riftatlas.com/?replayFile=1";
  // Ours, in the fragment: the site never sees it, and the content script on
  // the viewer page reads it to know which stored replay to hand over.
  const VIEWER_HASH_KEY = "rat-official";

  /* How far apart the site's start time and ours may be and still be the same
   * game. Theirs is stamped when the room deals; ours when the board first
   * reads in_game, after the battlefield pick and the mulligan - so ours is
   * always the later, by a minute or two. Games of a Bo3 in one room are
   * further apart than this, and nearest-first keeps them apart anyway. */
  const SAME_ROOM_WINDOW_MS = 10 * 60 * 1000;
  // Without a room code a name is all that ties the two, so the window is
  // tighter: a rematch against the same opponent must not be mistaken for it.
  const SAME_NAME_WINDOW_MS = 4 * 60 * 1000;
  // A token this close to expiry is treated as gone: the replay download can
  // take a few seconds, and a 401 halfway through is a wasted fetch.
  const TOKEN_MARGIN_MS = 30 * 1000;
  /* How long after a game a replay that is not ready yet still counts as being
   * prepared. The status names for "being prepared" are not known, so any
   * non-final status counts - and this bound is what stops a status that is
   * really terminal ("failed", say) holding the poll at its fast rate. */
  const PREPARING_WINDOW_MS = 60 * 60 * 1000;

  const str = (v) => (typeof v === "string" && v ? v : null);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const fold = (s) => (s || "").trim().toLowerCase();

  function side(p) {
    if (!p || typeof p !== "object") return null;
    const legend = p.legend && typeof p.legend === "object" ? p.legend : {};
    return {
      playerId: str(p.playerId),
      name: str(p.name),
      score: num(p.score),
      legend: str(legend.name),
      cardCode: str(legend.cardCode),
    };
  }

  /**
   * One row of gameHistory:list, reduced to what the extension keeps, or null
   * when the row is not a two-player game we can place.
   *
   * The game key is "ROOM:roomCreatedAt:gameNumber:gameStartedAt", and its
   * first part is the same room code the board shows - which is what ties a
   * row to a match record.
   */
  function summarise(item) {
    if (!item || typeof item !== "object") return null;
    const replay = item.replay && typeof item.replay === "object" ? item.replay : {};
    const gameKey = str(replay.gameKey);
    const players = Array.isArray(item.players) ? item.players : [];
    const mine = players.find((p) => p && p.isYou === true);
    const theirs = players.find((p) => p && p.isYou !== true);
    if (!gameKey || !mine || !theirs) return null;
    const you = side(mine);
    const winners = Array.isArray(item.winnerPlayerIds) ? item.winnerPlayerIds : [];
    return {
      gameKey,
      gameId: str(item.id),
      roomCode: gameKey.split(":")[0] || null,
      startedAt: num(item.startedAt),
      endedAt: num(item.endedAt),
      status: str(item.status),
      gameNumber: num(item.gameNumber),
      matchFormat: str(item.matchFormat),
      gameVariant: str(item.gameVariant),
      replayStatus: str(replay.status),
      expiresAt: num(replay.expiresAt),
      fullInformation: replay.fullInformation === true,
      won: winners.length ? winners.includes(you.playerId) : null,
      you,
      opponent: side(theirs),
    };
  }

  /** A gameHistory:list reply as summaries, dropping rows that cannot be placed. */
  function parsePage(reply) {
    const page = reply && Array.isArray(reply.page) ? reply.page : [];
    return page.map(summarise).filter(Boolean);
  }

  /**
   * The rows whose replay can be downloaded right now and is not on disk yet.
   *
   * "ready" alone is not enough: a replay past its expiry is gone server-side
   * whatever its status still says, and one without full information is the
   * public view, which is the thing this feature exists to improve on.
   */
  function wanted(summaries, storedKeys, now) {
    const have = storedKeys instanceof Set ? storedKeys : new Set(storedKeys || []);
    return (summaries || []).filter(
      (s) =>
        s &&
        s.status === "completed" &&
        s.replayStatus === "ready" &&
        s.fullInformation &&
        !have.has(s.gameKey) &&
        (s.expiresAt == null || s.expiresAt > now)
    );
  }

  /** Whether some row's replay is still being prepared, so a poll should come back soon. */
  function pending(summaries, now) {
    return (summaries || []).some(
      (s) =>
        s &&
        s.replayStatus !== "ready" &&
        s.replayStatus !== "expired" &&
        (s.expiresAt == null || s.expiresAt > now) &&
        s.endedAt != null &&
        now - s.endedAt < PREPARING_WINDOW_MS
    );
  }

  const startMs = (m) => {
    const t = Date.parse(m && m.startedAt);
    return Number.isFinite(t) ? t : null;
  };

  /**
   * Which official replay belongs to which match record: Map(matchId -> summary).
   *
   * One to one, nearest start first, so the games of a Bo3 played in one room
   * each find their own. A record with a room code is matched on it; one
   * without - the board never showed it - falls back to the opponent's name in
   * a tighter window.
   */
  function linkToMatches(matches, summaries) {
    const pairs = [];
    for (const m of matches || []) {
      const t = startMs(m);
      if (!m || !m.id || t == null) continue;
      for (const s of summaries || []) {
        if (!s || s.startedAt == null) continue;
        const gap = Math.abs(t - s.startedAt);
        const byRoom = m.roomCode && s.roomCode && fold(m.roomCode) === fold(s.roomCode);
        const byName =
          !m.roomCode &&
          m.opponentName &&
          s.opponent &&
          s.opponent.name &&
          fold(m.opponentName) === fold(s.opponent.name);
        if ((byRoom && gap <= SAME_ROOM_WINDOW_MS) || (byName && gap <= SAME_NAME_WINDOW_MS)) {
          pairs.push({ m, s, gap });
        }
      }
    }
    pairs.sort((a, b) => a.gap - b.gap);
    const out = new Map();
    const taken = new Set();
    for (const { m, s } of pairs) {
      if (out.has(m.id) || taken.has(s.gameKey)) continue;
      out.set(m.id, s);
      taken.add(s.gameKey);
    }
    return out;
  }

  /** A JWT's payload, or null. No signature check: it is only read for its expiry. */
  function jwtPayload(token) {
    const part = typeof token === "string" ? token.split(".")[1] : null;
    if (!part) return null;
    try {
      const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    } catch (_) {
      return null;
    }
  }

  /** Whether a session token can still be sent, with a margin for a slow download. */
  function tokenUsable(token, now) {
    const p = jwtPayload(token);
    return !!(p && typeof p.exp === "number" && p.exp * 1000 > now + TOKEN_MARGIN_MS);
  }

  const viewerUrl = (gameKey) => VIEWER_URL + "#" + VIEWER_HASH_KEY + "=" + encodeURIComponent(gameKey);

  /** The game key a viewer URL's fragment asks for, or null. */
  function viewerKeyFrom(hash) {
    const m = new RegExp("[#&]" + VIEWER_HASH_KEY + "=([^&]+)").exec(hash || "");
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return null;
    }
  }

  /* The site's own replay viewer draws a real board, data attributes and all,
   * and the capture would file it as a match being played. Both ways in: the
   * file picker on the home page, and the /replays/... routes it moves to. */
  function isViewerPage(loc) {
    if (!loc) return false;
    if (/(^|\/)replays(\/|$)/.test(loc.pathname || "")) return true;
    return /[?&]replayFile=/.test(loc.search || "");
  }

  /** What the viewer's file input is handed: the name the site's own download uses. */
  const fileName = (gameKey) =>
    "riftatlas-replay-" + String(gameKey).replace(/[^A-Za-z0-9_-]+/g, "-") + ".json";

  /* Whether a downloaded body is a replay at all. Parsing is not enough: an
   * error reply is JSON too, and stored it would be a replay that never opens. */
  const isReplay = (parsed) => !!(parsed && parsed.format === "riftatlas-replay");

  root.RATOfficialHistory = {
    TOKEN_URL,
    LIST_URL,
    REPLAY_URL,
    REPLAY_ACCEPT,
    VIEWER_URL,
    summarise,
    parsePage,
    wanted,
    pending,
    linkToMatches,
    tokenUsable,
    viewerUrl,
    viewerKeyFrom,
    isViewerPage,
    fileName,
    isReplay,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATOfficialHistory;
}
