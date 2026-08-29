/* Rift Atlas Stats Tracker - the match record, from first board to last write.
 *
 * This module owns `currentMatch`. Nothing else may hold it: a record handed
 * out and handed back would be one more place a half-finished game could be
 * abandoned, and there are already enough ways for that to happen - a false
 * end, a mid-game reload, a tab frozen into the bfcache, a dashboard delete
 * arriving while the game is still being played. Callers get `current()` to ask
 * whether a game is live, and operations for everything else.
 *
 * Two rules run through all of it:
 *
 *   A MATCH MUST NEVER EXIST ONLY IN MEMORY. The record is written the moment
 *   it is created, and again on every change the three-second sweep notices,
 *   so a tab that dies mid-game leaves a match rather than nothing.
 *
 *   ONE ENTRY PER GAME. The site does not unmount the board when a match ends,
 *   so `start` is called on a finished game several times a second;
 *   capture/match-start.js reads the three cases apart and the mutations each
 *   verdict implies are here.
 *
 * The scrapes are capture/board-read.js's, the decisions are match-start.js's,
 * match-end.js's and deck-name.js's, and the sentence printed for a player is
 * page-ui.js's. What is left here - and it is the whole of what is left - is
 * the record itself, when it is written, and what happens to it in between.
 */
(function (root) {
  "use strict";

  // First to 8 points. The same constant decides whether a lingering "in_game"
  // board is a finished match, which is capture/match-start.js's job, so it is
  // declared there too; test/content-wiring.test.js pins the pair.
  const WIN_SCORE = 8;
  const MAX_LOG = 500; // cap stored log lines per match
  const LOG_SAVE_MS = 5000; // how often to flush the game log mid-match
  const SCHEMA_VERSION = 3;
  // The toast stops appearing at the same count that latches the record shut in
  // capture/match-start.js: a game ended this often is one whose end we cannot
  // read, and asking the player a third time is asking them to close a popup.
  const MAX_TOASTS = 2;
  // Flags per match and label length, the same bounds the replay viewer
  // applies when it edits the list (dashboard/replay-html.js): 50 and 80.
  const MAX_FLAGS = 50;
  const MAX_FLAG_CHARS = 80;

  let currentMatch = null; // in-progress match record
  let lastEnded = null; // { roomCode, at, record } - guards against false ends
  let logSavedAt = 0;
  let lastPersistSnap = null; // lean JSON of the record as last written

  const uid = () =>
    "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

  // ---------- writing ----------

  // Exactly what goes into the `matches` array. The periodic dirty-check
  // compares this too: comparing `currentMatch` instead sees `log` grow on
  // every captured line and rewrites the whole array to store bytes that never
  // changed.
  function leanRecord(record) {
    const lean = Object.assign({}, record);
    delete lean.log; // stored separately under log_<id>
    return lean;
  }

  function saveMatch(record) {
    const lean = leanRecord(record);
    try {
      chrome.storage.local.get({ matches: [] }, (data) => {
        // Drop any corrupted (null / id-less) entries - they poison every
        // subsequent read and silently break all saves.
        const matches = (data.matches || []).filter((x) => x && x.id);
        const idx = matches.findIndex((x) => x.id === record.id);
        if (idx >= 0) {
          // The dashboard writes two fields this side never sets on a live
          // match - replay flags, and a backfilled wentFirst - and this save
          // replaces the record wholesale. Carry them over rather than letting
          // a periodic save quietly undo a bookmark made mid-game.
          const kept = matches[idx];
          if (lean.replayFlags == null && kept.replayFlags != null) lean.replayFlags = kept.replayFlags;
          if (lean.wentFirst == null && kept.wentFirst != null) lean.wentFirst = kept.wentFirst;
          matches[idx] = lean;
        } else {
          matches.push(lean);
        }
        chrome.storage.local.set({ matches });
      });
    } catch (err) {
      // Nearly always a reloaded/updated extension: this tab's script is
      // orphaned and cannot reach storage anymore.
      root.RATPageUI.reportStorageFailure("storage unavailable", err);
    }
  }

  // The matches array is rewritten every few seconds during a live game, so it
  // must stay small: game logs live in their own log_<id> key instead of
  // inside the record (~21 KB -> ~0.5 KB per match).
  function persistLogFor(m, force) {
    if (!m || !m.id || !Array.isArray(m.log) || !m.log.length) return;
    if (!force && Date.now() - logSavedAt < LOG_SAVE_MS) return;
    logSavedAt = Date.now();
    try {
      chrome.storage.local.set({ ["log_" + m.id]: { id: m.id, log: m.log } });
    } catch (err) {
      root.RATPageUI.reportStorageFailure("match log not saved", err);
    }
  }

  // ---------- starting ----------

  function newRecord(board, roomCode, names) {
    return {
      id: uid(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      mode: root.RATBoard.mode(board),
      roomCode,
      myName: names.mine,
      opponentName: names.opponent,
      myLegend: null,
      myChampion: null,
      opponentLegend: null,
      opponentChampion: null,
      myScore: 0,
      opponentScore: 0,
      turns: 1,
      result: null, // 'win' | 'loss' | 'draw' | 'unknown'
      resultSource: null, // 'auto' | 'manual'
      endReason: null,
      durationMs: null,
      notes: "",
      deckName: "",
      deckSource: null, // 'picker' | 'board' | 'url' | 'last' | 'manual' | …
      matchFormat: null, // 'bo1' | 'bo3' | null when the lobby never said
      // 'live' = the lobby was on screen when this match began; 'memory' = it
      // was not, and this is the last format seen. dashboard/series.js will
      // not raise a series around a single game on a remembered one.
      matchFormatSource: null,
      wentFirst: null, // true = you opened, false = they did, null = never read
      log: [], // [{t, actor: self|opponent|system, text}]
      schemaVersion: SCHEMA_VERSION,
    };
  }

  /** Name the deck this game is being played with, and file it on the record. */
  function attributeDeck(m) {
    // The name from the picker (checked against the legend on the board), else
    // the in-game DOM, else the URL, else the deck you used last.
    const sources = root.RATDeckScan.sources();
    const found = root.RATDeckName.pickDeckName(m, sources, Date.now());
    root.RATDeckScan.noteVerdict(found, m, sources);
    if (found.source) {
      m.deckName = found.name;
      m.deckSource = found.source;
      console.info("[RA-Tracker] deck detected:", found.name, "(" + found.source + ")");
      root.RATDeckScan.rememberLast(found.name);
    } else {
      root.RATDeckScan.lastUsed((last) => {
        // Only if this is still the game we were asked about, and only if
        // nothing better landed on it while storage was answering.
        if (last && currentMatch === m && !m.deckName) {
          m.deckName = last; // assume same deck as last time
          m.deckSource = "last";
          saveMatch(m);
        }
      });
    }
    root.RATDeckScan.clearPending();
  }

  /* Persist immediately - and if the page was reloaded mid-game, adopt the
   * earlier open record for this room instead of creating a duplicate. */
  function adoptOrSave(fresh) {
    chrome.storage.local.get({ matches: [] }, (data) => {
      if (currentMatch !== fresh) return;
      const open = (data.matches || []).find(
        (x) => x && x.roomCode && x.roomCode === fresh.roomCode && !x.endedAt
      );
      if (open) {
        fresh.id = open.id;
        fresh.startedAt = open.startedAt;
        fresh.myScore = Math.max(fresh.myScore, open.myScore || 0);
        fresh.opponentScore = Math.max(fresh.opponentScore, open.opponentScore || 0);
        fresh.notes = open.notes || "";
        // Deck: the name already on the record was read when the game began -
        // closer to the moment the deck was actually chosen than anything we
        // can see after a mid-game reload - so it wins, unless it was only the
        // "same deck as last time" guess. Records written before deck sources
        // existed carry no source and were typed by hand, so they win too.
        const openDeck = (open.deckName || "").trim();
        if (openDeck && (open.deckSource !== "last" || !fresh.deckName)) {
          fresh.deckName = openDeck;
          fresh.deckSource = open.deckSource || null;
        }
        if (Array.isArray(open.log) && open.log.length) fresh.log = open.log; // legacy inline log
        // Resume the existing card set and log instead of starting new ones.
        const cKey = "deckcards_" + fresh.id;
        const lKey = "log_" + fresh.id;
        chrome.storage.local.get([cKey, lKey], (r) => {
          const prev = r && r[cKey];
          if (prev && Array.isArray(prev.codes)) {
            root.RATDeckCards.resume(fresh.id, prev.codes);
          }
          const prevLog = r && r[lKey];
          if (prevLog && Array.isArray(prevLog.log) && prevLog.log.length > (fresh.log || []).length) {
            fresh.log = prevLog.log;
          }
        });
      }
      saveMatch(fresh);
    });
  }

  function start(board) {
    const code = root.RATBoard.roomCode();
    const latched = lastEnded && lastEnded.record;
    const { verdict, clearLatch } = root.RATMatchStart.decideStart(lastEnded, {
      roomCode: code,
      turnNow: root.RATBoard.turnNumber(board) || 0,
      myScore: root.RATBoard.myScore(board),
    });
    if (clearLatch) lastEnded = null;
    if (verdict === "suppress") return;
    if (verdict === "reopen") {
      latched.endedAt = null;
      latched.result = null;
      latched.resultSource = null;
      latched.endReason = null;
      currentMatch = latched;
      lastEnded = null;
      root.RATPageUI.removeToast();
      saveMatch(latched);
      // The end took the goals panel down with it; a resumed game gets it back.
      root.RATGoalNotes && root.RATGoalNotes.matchStarted(latched);
      console.info("[RA-Tracker] false end detected - resumed match", code);
      return;
    }
    currentMatch = newRecord(board, code, root.RATBoard.playerNames());
    root.RATRec && root.RATRec.start(currentMatch.id);
    refresh(board); // fills in myLegend, needed to pick the right deck

    attributeDeck(currentMatch);

    // Format: left null when nothing can say - the dashboard would rather be
    // told nothing than be told a format that was never on screen. Where it
    // came from is filed with it, because a remembered format is a guess about
    // a screen that has gone and the dashboard weighs the two differently.
    const fmt = root.RATMatchFormat.current();
    currentMatch.matchFormat = fmt ? fmt.format : null;
    currentMatch.matchFormatSource = fmt ? fmt.source : null;
    if (fmt) console.info("[RA-Tracker] match format:", fmt.format, "(" + fmt.source + ")");

    adoptOrSave(currentMatch);
    // The goals panel: a reminder of what you are working on, and the way a
    // timestamped note is typed mid-game. Guarded like RATRec - the tests
    // drive this file without it, and the panel is not the match record.
    root.RATGoalNotes && root.RATGoalNotes.matchStarted(currentMatch);
    console.info("[RA-Tracker] match started", currentMatch.roomCode);
  }

  // ---------- running ----------

  function captureLog() {
    const m = currentMatch;
    if (!m) return;
    const entries = root.RATBoard.logEntries();
    if (!entries.length) return;
    // Count-based merge: append only the occurrences we haven't stored yet.
    // Survives React re-rendering the whole list (node identity is useless).
    m.log = root.RATMatchLog.mergeLog(m.log, entries, MAX_LOG);
    // Who opened the game, read off the log's first turn end. Decided once,
    // early - the first turn ends within the log's first few dozen lines, long
    // before the cap could trim the opening out from under the read.
    if (m.wentFirst == null) {
      const w = root.RATMatchLog.whoWentFirst(m.log, MAX_LOG);
      if (w !== null) {
        m.wentFirst = w;
        console.info("[RA-Tracker] first turn:", w ? "you" : "opponent");
      }
    }
  }

  function refresh(board) {
    if (!currentMatch) return;
    const m = currentMatch;
    const read = root.RATBoard;
    m.myLegend = read.cardAlt("self", "legend") || m.myLegend;
    m.myChampion = read.cardAlt("self", "champion") || m.myChampion;
    m.opponentLegend = read.cardAlt("opponent", "legend") || m.opponentLegend;
    m.opponentChampion = read.cardAlt("opponent", "champion") || m.opponentChampion;
    if (!m.myName || !m.opponentName) {
      const names = read.playerNames();
      m.myName = m.myName || names.mine;
      m.opponentName = m.opponentName || names.opponent;
    }
    const myScore = read.myScore(board);
    const oppScore = read.opponentScore(board);
    if (myScore !== null && myScore > m.myScore) m.myScore = myScore;
    if (oppScore !== null && oppScore > m.opponentScore) m.opponentScore = oppScore;
    const turn = read.turnNumber(board);
    if (Number.isFinite(turn) && turn > m.turns) m.turns = turn;
    /* The log gets first refusal on who went first: it reads the turn end
     * itself, where the board only names whoever is on turn now. If this
     * site's turn number ever counts rounds rather than player-turns, turn 1
     * is still showing after the opener has ended theirs and the board would
     * name the SECOND player as the opener - so where both can answer, the
     * one that is not inferring wins. */
    captureLog();
    /* Who went first, off the board while turn 1 is still live. The log can
     * only answer while the opening is still inside the capped log, so a game
     * we watch from turn 1 should never have to go looking for it there. */
    if (m.wentFirst == null && turn === 1) {
      const side = read.activeSide(board);
      if (side) {
        m.wentFirst = side === "self";
        console.info("[RA-Tracker] first turn:", m.wentFirst ? "you" : "opponent");
      }
    }
    root.RATDeckCards.collect(board, m.id);
    root.RATRec && root.RATRec.mark(Number.isFinite(turn) ? turn : m.turns);
    // Cheap until the opponent's champion changes - which is the moment the
    // goals panel has been waiting for, if a goal names them.
    root.RATGoalNotes && root.RATGoalNotes.matchTick(m);

    // Score-based end detection (first to WIN_SCORE).
    if (m.myScore >= WIN_SCORE) end("win", "score");
    else if (m.opponentScore >= WIN_SCORE) end("loss", "score");
  }

  /* What a piece of page text that just appeared says about the match ending.
   * The extension's own toast is never read: it prints the detected result in
   * words, so reading it back would end the match the toast is asking about. */
  function scanText(node) {
    if (!currentMatch || !node || !node.textContent) return;
    if (root.RATPageUI.isOwnToast(node)) return;
    // The goals panel is the player's own words - a goal reading "win the
    // last battlefield" must never be read back as a victory banner.
    if (root.RATGoalNotes && root.RATGoalNotes.isOwnPanel(node)) return;
    // The record carries exactly the four facts the decision needs.
    const verdict = root.RATMatchEnd.decideResult(node.textContent, currentMatch);
    if (verdict) end(verdict.result, verdict.reason);
  }

  /**
   * File a timestamped note on the live match, typed in the goals panel
   * mid-game. It is stored as a replay flag - the same {ms, text} bookmark the
   * replay viewer draws on its timeline and a share carries in its meta - so
   * after the game the note is one click from the board state it was written
   * about.
   *
   * `ms` is milliseconds into the visual recording when one is running, which
   * is the clock the replay timeline is in; when capture is off or already
   * stopped it falls back to time since the match record began, the same
   * moment to within the settings read that starts rrweb.
   *
   * Returns the ms filed, or null when there is no live match or no text -
   * the panel uses the difference to say whether anything was saved.
   */
  function addFlag(text) {
    const m = currentMatch;
    const t = String(text == null ? "" : text).trim().slice(0, MAX_FLAG_CHARS);
    if (!m || !t) return null;
    let ms =
      root.RATRec && typeof root.RATRec.elapsedMs === "function"
        ? root.RATRec.elapsedMs()
        : null;
    if (ms === null || ms === undefined) {
      const started = Date.parse(m.startedAt);
      ms = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
    }
    ms = Math.round(ms);
    m.replayFlags = (Array.isArray(m.replayFlags) ? m.replayFlags : [])
      .concat([{ ms, text: t }])
      .sort((a, b) => a.ms - b.ms)
      .slice(0, MAX_FLAGS);
    saveMatch(m);
    return ms;
  }

  // ---------- ending ----------

  /** Revisit the deck now the board has shown us everything it is going to. */
  function reviseDeck(m) {
    // By now the board has long since revealed our legend, so a name we
    // couldn't check at the start can be improved - or, if it is contradicted
    // outright, dropped. capture/deck-name.js decides which; see the rule
    // spelled out on `reviseDeckAtEnd` for why silence never counts as a
    // contradiction.
    const sources = root.RATDeckScan.sources();
    const late = root.RATDeckName.reviseDeckAtEnd(m, sources, Date.now());
    root.RATDeckScan.noteVerdict(late, m, sources);
    if (late.verdict !== "keep") {
      m.deckName = late.name;
      m.deckSource = late.source;
    }
    if (late.verdict === "revise") {
      root.RATDeckScan.rememberLast(late.name);
      console.info("[RA-Tracker] deck resolved at match end:", late.name, "(" + late.source + ")");
    } else if (late.verdict === "clear") {
      console.info("[RA-Tracker] dropped unverified deck name - the board disagrees");
    }
  }

  function end(result, reason) {
    if (!currentMatch) return;
    const m = currentMatch;
    captureLog(); // grab any final lines before we let go
    // "end" is the capture's own reason: `reason` here is the match result.
    root.RATRec && root.RATRec.stop("end");
    root.RATDeckCards.persist(true);
    persistLogFor(m, true);
    currentMatch = null;
    root.RATGoalNotes && root.RATGoalNotes.matchEnded();
    m.endedAt = new Date().toISOString();
    const started = Date.parse(m.startedAt);
    if (Number.isFinite(started)) {
      m.durationMs = Math.max(0, Date.parse(m.endedAt) - started);
    }
    m.result = result || "unknown";
    m.resultSource = result && result !== "unknown" ? "auto" : null;
    m.endReason = reason;
    m.endCount = (m.endCount || 0) + 1;
    reviseDeck(m);
    lastEnded = { roomCode: m.roomCode, at: Date.now(), record: m };
    saveMatch(m);
    if (m.endCount <= MAX_TOASTS) {
      root.RATPageUI.showConfirmToast(m, { onResult: overrideResult, onDiscard: discard });
    }
    console.info("[RA-Tracker] match ended:", m.result, "(" + reason + ")");
  }

  /* We were in a game and now we're not: the phase changed or the board
   * unmounted. Nothing said who won, so the scores are the only evidence. */
  function endOnPhaseChange(board, phase) {
    if (!currentMatch) return;
    let guess = "unknown";
    if (currentMatch.myScore >= WIN_SCORE) guess = "win";
    else if (currentMatch.opponentScore >= WIN_SCORE) guess = "loss";
    end(guess, board ? "phase:" + phase : "board-unmounted");
  }

  function overrideResult(id, result) {
    // Keep the in-memory end record in sync so the duplicate-suppression
    // latch knows this game was human-confirmed.
    if (lastEnded && lastEnded.record && lastEnded.record.id === id) {
      lastEnded.record.result = result;
      lastEnded.record.resultSource = "manual";
    }
    chrome.storage.local.get({ matches: [] }, (data) => {
      const matches = (data.matches || []).filter((x) => x && x.id);
      const idx = matches.findIndex((x) => x.id === id);
      if (idx < 0) return;
      matches[idx].result = result;
      matches[idx].resultSource = "manual";
      chrome.storage.local.set({ matches });
    });
  }

  function discard(id) {
    // Mark as human-decided so the suppression latch doesn't resurrect it.
    if (lastEnded && lastEnded.record && lastEnded.record.id === id) {
      lastEnded.record.resultSource = "manual";
    }
    chrome.storage.local.get({ matches: [] }, (data) => {
      chrome.storage.local.set({
        matches: (data.matches || []).filter((x) => x && x.id && x.id !== id),
      });
    });
  }

  /* The dashboard deleted the game we are still recording. Storage is already
   * clean, so there is nothing to remove here - the job is to stop writing it
   * back, which the next three-second save would otherwise do unconditionally.
   *
   * Letting go of `currentMatch` is not enough on its own: the board is still
   * mounted in "in_game", so the very next tick would call `start` and record
   * the rest of the game as a new entry. `lastEnded` marked as human-decided is
   * the same latch `discard` relies on, and it makes that suppression path
   * fire. The card accumulator is dropped too, or the next flush would rewrite
   * the deckcards_<id> key the delete just took away. */
  function dropLive() {
    const m = currentMatch;
    if (!m) return;
    currentMatch = null;
    root.RATRec && root.RATRec.stop("deleted");
    root.RATGoalNotes && root.RATGoalNotes.matchEnded();
    m.resultSource = "manual";
    lastEnded = { roomCode: m.roomCode, at: Date.now(), record: m };
    root.RATDeckCards.forget();
    console.info("[RA-Tracker] live match deleted from the dashboard - no longer recording it");
  }

  // ---------- the sweeps content.js drives ----------

  /* The safety net that makes the "never only in memory" rule true: whatever
   * changed since the last write is written now. Compared as the lean record
   * for the reason leanRecord gives. */
  function saveIfDirty() {
    if (currentMatch) {
      const snap = JSON.stringify(leanRecord(currentMatch));
      if (snap !== lastPersistSnap) {
        lastPersistSnap = snap;
        saveMatch(currentMatch);
      }
    }
    persistLogFor(currentMatch, false);
  }

  /* The tab is going away mid-game. Not `end`: nothing has said how the match
   * finished, the recorder is stopped for a different reason, and the record
   * has to stay reopenable.
   *
   * A pagehide is not always a goodbye: a page frozen into the bfcache can come
   * back with the same game still on screen. Handing the record to the
   * false-end latch means `start` reopens THIS one instead of writing a second
   * record for a game already half-recorded.
   *
   * The MATCH resumes; the REPLAY does not. Nothing restarts the recorder on
   * that path, and it must not: replayStore.start overwrites the replays row
   * while chunks are keyed [matchId, seq] and are not cleared, so a second
   * session renumbers from 0 and the first session's tail splices onto the end
   * of the second. A truncated replay is bad; that one is corrupt. So a
   * restored page finishes the match with a replay ending at the freeze, filed
   * "stopped" and incomplete.
   *
   * Worth knowing this is a trade rather than a free win: beforeunload, which
   * this replaced, never fired on a freeze at all, so restore used to be
   * transparent - at the cost of losing the whole buffered batch on every real
   * close. Resuming properly needs a flush that does not stop the session, or
   * an event.persisted branch that gives up the flush on mobile
   * freeze-then-discard. Both belong with the store, not here. */
  function flushOnUnload() {
    const m = currentMatch;
    if (!m) return;
    root.RATRec && root.RATRec.stop("tab-closed");
    currentMatch = null;
    root.RATGoalNotes && root.RATGoalNotes.matchEnded();
    m.endedAt = new Date().toISOString();
    const started = Date.parse(m.startedAt);
    if (Number.isFinite(started)) m.durationMs = Math.max(0, Date.parse(m.endedAt) - started);
    m.result = "unknown";
    m.endReason = "tab-closed";
    lastEnded = { roomCode: m.roomCode, at: Date.now(), record: m };
    saveMatch(m);
    root.RATDeckCards.persist(true);
    persistLogFor(m, true);
  }

  /**
   * The `matches` array changed underneath us. Two things can have happened to
   * the game we are recording, and neither is something we did:
   *
   * a delete from the dashboard, which must stop us writing it back - but only
   * when it was there an instant ago, since a writer that read `matches` before
   * this match was first saved writes the array back without it too, and taking
   * that for a delete would abandon a game in progress;
   *
   * a deck name typed by hand, which the next periodic save of the in-memory
   * record would otherwise undo.
   */
  function onMatchesChanged(newValue, oldValue) {
    if (!currentMatch) return;
    const saved = (newValue || []).find((x) => x && x.id === currentMatch.id);
    if (!saved) {
      const wasStored = (oldValue || []).some((x) => x && x.id === currentMatch.id);
      if (wasStored) dropLive();
      return;
    }
    // Flags the dashboard wrote on the live match - the replay modal can add
    // one mid-game - are adopted before this side's next save replaces the
    // record wholesale. Only when this side has none of its own: once a note
    // is typed in-game the in-memory list is the fuller one.
    if (Array.isArray(saved.replayFlags) && currentMatch.replayFlags == null) {
      currentMatch.replayFlags = saved.replayFlags;
    }
    if (saved.deckSource !== "manual") return; // only we write the rest
    if (saved.deckName === currentMatch.deckName) return;
    currentMatch.deckName = saved.deckName || "";
    currentMatch.deckSource = "manual";
    console.info("[RA-Tracker] deck renamed from the dashboard:", currentMatch.deckName);
  }

  root.RATLifecycle = {
    current: () => currentMatch,
    start,
    refresh,
    scanText,
    end,
    endOnPhaseChange,
    saveIfDirty,
    flushOnUnload,
    onMatchesChanged,
    // Reached by the goals panel's note input.
    addFlag,
    // Reached by the toast's buttons and by tests.
    overrideResult,
    discard,
    dropLive,
    WIN_SCORE,
    MAX_LOG,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATLifecycle;
}
