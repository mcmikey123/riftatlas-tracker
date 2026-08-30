"use strict";

/* The match record, driven for real.
 *
 * capture/match-lifecycle.js owns `currentMatch`, and everything that can go
 * wrong with it is silent: a duplicate half-record for a game already filed, a
 * rematch appended onto the previous game's row, a match that exists only in
 * memory when the tab dies, a deck name typed in the dashboard undone by the
 * next periodic save. None of it throws and none of it is logged.
 *
 * It is an IIFE over `globalThis` like the rest of capture/, so it is loaded
 * into a vm sandbox the way test/dom-recorder.test.js loads the recorder. The
 * DECISIONS are the real modules - match-start.js, match-end.js, match-log.js,
 * deck-name.js - because the wiring between them is most of what is being
 * tested. The DOM is not: `RATBoard` is a stub whose readings each case sets,
 * which is the whole point of the board scrapes living behind one interface.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const readSrc = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const REAL_MODULES = [
  "capture/match-start.js",
  "capture/match-end.js",
  "capture/match-log.js",
  "capture/deck-name.js",
];

/** A board with nothing on it; each case overrides what it cares about. */
function blankBoard() {
  return {
    element: { dataset: {} },
    phase: "in_game",
    mode: "ranked",
    roomCode: "ABC123",
    turn: 1,
    myScore: 0,
    opponentScore: 0,
    names: { mine: "ME", opponent: "OPP" },
    cards: {}, // "self/legend" -> alt text
    log: [],
  };
}

function harness(seed) {
  const board = blankBoard();
  const disk = Object.assign({ matches: [] }, seed);
  const writes = [];
  const logs = [];
  const toasts = [];
  const recorder = [];
  let deckVerdictSources = { activeDeck: null, candidates: [], urlName: null };
  let lastDeckOnDisk = null;
  let format = null;

  const storage = {
    local: {
      get(what, cb) {
        const out = {};
        if (Array.isArray(what)) {
          for (const key of what) if (key in disk) out[key] = disk[key];
        } else {
          for (const key of Object.keys(what)) {
            out[key] = key in disk ? disk[key] : what[key];
          }
        }
        cb(JSON.parse(JSON.stringify(out)));
      },
      set(obj) {
        writes.push(JSON.parse(JSON.stringify(obj)));
        Object.assign(disk, JSON.parse(JSON.stringify(obj)));
      },
    },
  };

  const sandbox = {
    console: {
      info: (...args) => logs.push(args.join(" ")),
      warn: (...args) => logs.push(args.join(" ")),
      error: (...args) => logs.push(args.join(" ")),
      log() {},
    },
    chrome: { runtime: { id: "test" }, storage },
    setTimeout: () => 0,
    RATBoard: {
      gameRoot: () => board.element,
      phase: () => board.phase,
      mode: () => board.mode,
      roomCode: () => board.roomCode,
      turnNumber: () => board.turn,
      cardAlt: (owner, zone) => board.cards[owner + "/" + zone] || null,
      playerNames: () => board.names,
      activeSide: () => board.activeSide || null,
      myScore: () => board.myScore,
      opponentScore: () => board.opponentScore,
      logEntries: () => board.log.slice(),
    },
    RATPageUI: {
      isOrphaned: () => false,
      showOrphanBanner() {},
      reportStorageFailure: (what, err) => logs.push("storage-failure " + what + " " + err),
      showConfirmToast: (record, actions) => toasts.push({ record, actions }),
      removeToast: () => toasts.push("removed"),
      isOwnToast: (node) => !!node.fromToast,
    },
    RATDeckScan: {
      sources: () => deckVerdictSources,
      noteVerdict() {},
      rememberLast: (name) => (lastDeckOnDisk = name),
      lastUsed: (cb) => cb(lastDeckOnDisk),
      clearPending: () => recorder.push("deck-pending-cleared"),
      watch() {},
      load() {},
      rememberPregame() {},
    },
    RATMatchFormat: { current: () => format },
    RATDeckCards: {
      collect: (el, id) => recorder.push("collect:" + id),
      persist: (force) => recorder.push("cards-persist:" + !!force),
      resume: (id, codes) => recorder.push("cards-resume:" + id + ":" + codes.join(",")),
      forget: () => recorder.push("cards-forget"),
    },
    RATRec: {
      start: (id) => recorder.push("rec-start:" + id),
      mark: (turn) => recorder.push("rec-mark:" + turn),
      stop: (why) => recorder.push("rec-stop:" + why),
    },
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  for (const rel of REAL_MODULES) {
    vm.runInContext(readSrc(rel), context, { filename: rel });
  }
  vm.runInContext(readSrc("capture/match-lifecycle.js"), context, {
    filename: "match-lifecycle.js",
  });

  return {
    board,
    disk,
    writes,
    logs,
    toasts,
    recorder,
    life: sandbox.RATLifecycle,
    /** @param {?string} f @param {string} [source] - 'live' | 'memory'. */
    setFormat: (f, source) => (format = f ? { format: f, source: source || "live" } : null),
    setDeckSources: (s) => (deckVerdictSources = s),
    setLastDeck: (name) => (lastDeckOnDisk = name),
    /** The record as it stands in the stored `matches` array. */
    stored: (id) => (disk.matches || []).find((m) => m.id === id) || null,
    matches: () => disk.matches || [],
    /** Start a game and hand back the live record. */
    play() {
      sandbox.RATLifecycle.start(board.element);
      return sandbox.RATLifecycle.current();
    },
  };
}

// ---------------------------------------------------------------------------

test("a new match is on disk before the first turn is played", () => {
  /* A MATCH MUST NEVER EXIST ONLY IN MEMORY: the tab can die at any moment and
   * a game that was never written is a game that never happened. */
  const h = harness();
  h.board.cards["self/legend"] = "Diana, Scorn of the Moon";
  h.board.cards["opponent/champion"] = "Ahri, Nine-Tailed";
  const m = h.play();

  assert.ok(m, "a match must be live");
  const saved = h.stored(m.id);
  assert.ok(saved, "the record must be in the matches array already");
  assert.equal(saved.roomCode, "ABC123");
  assert.equal(saved.mode, "ranked");
  assert.equal(saved.myName, "ME");
  assert.equal(saved.opponentName, "OPP");
  assert.equal(saved.myLegend, "Diana, Scorn of the Moon");
  assert.equal(saved.opponentChampion, "Ahri, Nine-Tailed");
  assert.equal(saved.endedAt, null);
  assert.equal(saved.schemaVersion, 3);
  assert.ok(h.recorder.includes("rec-start:" + m.id), "the replay recorder is started");
});

test("the record stored in the matches array never carries the game log", () => {
  // ~21 KB per match rewritten per captured line if it did.
  const h = harness();
  h.board.log = [{ t: "16:11", actor: "self", text: "Drew a card." }];
  const m = h.play();
  h.life.refresh(h.board.element);

  assert.equal(m.log.length, 1, "the live record carries the log");
  assert.ok(!("log" in h.stored(m.id)), "the stored record does not");
});

test("the periodic save only writes when something other than the log changed", () => {
  /* The dirty-check compares the lean record for the same reason the store
   * does: comparing the live one sees `log` grow on every captured line and
   * rewrites the whole matches array to store bytes that never changed. */
  const h = harness();
  const m = h.play();
  h.life.saveIfDirty();
  const before = h.writes.length;

  h.board.log = [{ t: "16:12", actor: "self", text: "Drew a card." }];
  h.life.refresh(h.board.element);
  h.life.saveIfDirty();
  const afterLogOnly = h.writes.filter((w) => "matches" in w).length;

  h.board.myScore = 3;
  h.life.refresh(h.board.element);
  h.life.saveIfDirty();
  const afterScore = h.writes.filter((w) => "matches" in w).length;

  assert.equal(
    afterLogOnly,
    h.writes.slice(0, before).filter((w) => "matches" in w).length,
    "a log line alone must not rewrite the matches array"
  );
  assert.ok(afterScore > afterLogOnly, "a score change must be written");
  assert.equal(h.stored(m.id).myScore, 3);
});

test("the game log is written to its own key, not into the record", () => {
  const h = harness();
  h.board.log = [{ t: "16:11", actor: "self", text: "Conquered X and scored 1." }];
  const m = h.play();
  h.life.refresh(h.board.element);
  h.life.end("win", "score");

  const logKey = "log_" + m.id;
  assert.ok(h.disk[logKey], "the log must be stored under log_<id>");
  // Compared as JSON: the record was built inside the sandbox, so its objects
  // have that realm's prototypes and are never reference-equal to ours.
  assert.equal(JSON.stringify(h.disk[logKey].log), JSON.stringify(m.log));
});

test("the stored log stops at the cap, keeping the newest lines", () => {
  /* The cap is what the dashboard tells the user about, and it is enforced
   * here; test/shared-constants.test.js pins the two to the same number. */
  const h = harness();
  const cap = h.life.MAX_LOG;
  const m = h.play();
  h.board.log = Array.from({ length: cap + 10 }, (_, i) => ({
    t: "16:11",
    actor: "self",
    text: "line " + i,
  }));
  h.life.refresh(h.board.element);

  assert.equal(m.log.length, cap);
  assert.equal(m.log.at(-1).text, "line " + (cap + 9), "the newest line survives");
  assert.equal(m.log[0].text, "line 10", "the oldest ones go first");
});

test("a lingering finished board does not become a second record", () => {
  /* ONE ENTRY PER GAME. The site leaves the board mounted in "in_game" under
   * the end overlay, so `start` is called on a finished game several times a
   * second for as long as the player looks at the result. */
  const h = harness();
  const m = h.play();
  h.board.myScore = h.life.WIN_SCORE;
  h.life.refresh(h.board.element); // ends it on score

  assert.equal(h.life.current(), null, "the match ended");
  h.board.turn = 14; // the same finished board, still up
  for (let i = 0; i < 5; i++) h.life.start(h.board.element);

  assert.equal(h.life.current(), null, "no new record was started");
  assert.equal(h.matches().length, 1, "still exactly one match on disk");
  assert.equal(h.stored(m.id).result, "win");
});

test("a false end reopens the record it produced rather than writing another", () => {
  const h = harness();
  const m = h.play();
  h.board.turn = 6;
  h.life.refresh(h.board.element);
  // A stray "VICTORY" in card text, with nothing decisive behind it.
  h.life.scanText({ nodeType: 1, textContent: "VICTORY LANE" });
  assert.equal(h.life.current(), null);

  h.board.turn = 7; // the game is plainly still being played
  h.life.start(h.board.element);

  assert.equal(h.life.current().id, m.id, "the same record is live again");
  assert.equal(h.life.current().endedAt, null);
  assert.equal(h.life.current().result, null);
  assert.equal(h.matches().length, 1);
  assert.ok(h.toasts.includes("removed"), "the toast asking about the false end is taken down");
});

test("a rematch in the same room gets its own record", () => {
  const h = harness();
  h.board.turn = 12;
  const first = h.play();
  h.board.myScore = h.life.WIN_SCORE;
  h.life.refresh(h.board.element);

  h.board.turn = 1; // a new game is dealt
  h.board.myScore = 0;
  const second = h.play();

  assert.notEqual(second.id, first.id);
  assert.equal(h.matches().length, 2);
});

test("a page reloaded mid-game adopts the open record instead of duplicating it", () => {
  const open = {
    id: "m_old",
    roomCode: "ABC123",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: null,
    myScore: 5,
    opponentScore: 2,
    notes: "close one",
    deckName: "Bandle Bomb",
    deckSource: "picker",
    turns: 9,
  };
  const h = harness({
    matches: [open],
    deckcards_m_old: { id: "m_old", codes: ["UNL-1", "UNL-2"] },
    log_m_old: { id: "m_old", log: [{ t: "16:00", actor: "self", text: "Drew a card." }] },
  });
  h.board.turn = 9;
  h.board.myScore = 5;
  const m = h.play();

  assert.equal(m.id, "m_old", "the open record for this room is adopted");
  assert.equal(m.startedAt, open.startedAt, "the original start time is kept");
  assert.equal(m.myScore, 5);
  assert.equal(m.notes, "close one");
  assert.equal(m.deckName, "Bandle Bomb", "a deck read when the game began outranks anything now");
  assert.equal(m.log.length, 1, "the stored log is resumed");
  assert.ok(
    h.recorder.includes("cards-resume:m_old:UNL-1,UNL-2"),
    "the card accumulator resumes the stored set"
  );
  assert.equal(h.matches().length, 1, "no duplicate record");
});

test("a match ends on score, with the result, the reason and one toast", () => {
  const h = harness();
  const m = h.play();
  h.board.opponentScore = h.life.WIN_SCORE;
  h.life.refresh(h.board.element);

  const saved = h.stored(m.id);
  assert.equal(saved.result, "loss");
  assert.equal(saved.resultSource, "auto");
  assert.equal(saved.endReason, "score");
  assert.ok(saved.endedAt, "the record is closed");
  assert.equal(typeof saved.durationMs, "number");
  assert.equal(h.toasts.length, 1, "the player is asked to confirm");
  assert.ok(h.recorder.includes("rec-stop:end"));
  assert.ok(h.recorder.includes("cards-persist:true"), "the card set is flushed, not throttled");
});

test("page text ends the match, but the extension's own toast never does", () => {
  const h = harness();
  h.play();
  // The toast prints "WIN detected" in words; reading it back would end the
  // match the toast is asking about.
  h.life.scanText({ nodeType: 1, textContent: "WIN detected", fromToast: true });
  assert.ok(h.life.current(), "the match is still live");

  h.life.scanText({ nodeType: 1, textContent: "VICTORY" });
  assert.equal(h.life.current(), null);
});

test("the toast's buttons override the result and discard the match", () => {
  const h = harness();
  const m = h.play();
  h.board.myScore = h.life.WIN_SCORE;
  h.life.refresh(h.board.element);
  const { record, actions } = h.toasts[0];
  assert.equal(record.id, m.id);

  actions.onResult(m.id, "draw");
  assert.equal(h.stored(m.id).result, "draw");
  assert.equal(h.stored(m.id).resultSource, "manual");

  actions.onDiscard(m.id);
  assert.equal(h.stored(m.id), null, "the record is gone from storage");
  // And a human decision is never revisited by the false-end latch.
  h.board.turn = 14;
  h.life.start(h.board.element);
  assert.equal(h.life.current(), null, "a discarded game is not resurrected");
});

test("the dashboard deleting the live match stops us writing it back", () => {
  const h = harness();
  const m = h.play();
  // The dashboard's own write has already landed: storage is clean, and this
  // is the notification about it.
  const before = h.matches();
  h.disk.matches = before.filter((x) => x.id !== m.id);
  h.life.onMatchesChanged(h.disk.matches, before);

  assert.equal(h.life.current(), null, "we stop recording it");
  assert.ok(h.recorder.includes("cards-forget"), "the card accumulator is dropped too");
  h.life.saveIfDirty();
  assert.equal(h.stored(m.id), null, "and it is not written back");
  // The board is still mounted in "in_game", so the next tick must not record
  // the rest of the game as a new entry.
  h.board.turn = 5;
  h.life.start(h.board.element);
  assert.equal(h.life.current(), null);
});

test("an array written by someone who never saw this match is not a delete", () => {
  /* A writer that read `matches` before this match was first saved writes the
   * array back without it. Taking that for a delete abandons a live game. */
  const h = harness();
  const m = h.play();
  h.life.onMatchesChanged([], []); // it was not in the old value either

  assert.ok(h.life.current(), "the game is still being recorded");
  assert.equal(h.life.current().id, m.id);
});

test("a deck name typed in the dashboard survives the next periodic save", () => {
  const h = harness();
  const m = h.play();
  h.life.onMatchesChanged([{ id: m.id, deckName: "Typed By Hand", deckSource: "manual" }], []);
  assert.equal(h.life.current().deckName, "Typed By Hand");

  h.life.saveIfDirty();
  assert.equal(h.stored(m.id).deckName, "Typed By Hand");

  // Anything not marked manual is ours, and is ignored.
  h.life.onMatchesChanged([{ id: m.id, deckName: "Guessed", deckSource: "last" }], []);
  assert.equal(h.life.current().deckName, "Typed By Hand");
});

test("a tab closing mid-game files the match and leaves it reopenable", () => {
  const h = harness();
  const m = h.play();
  h.board.turn = 6;
  h.life.refresh(h.board.element);
  h.life.flushOnUnload();

  const saved = h.stored(m.id);
  assert.equal(h.life.current(), null);
  assert.equal(saved.result, "unknown");
  assert.equal(saved.endReason, "tab-closed");
  assert.ok(saved.endedAt);
  assert.ok(h.recorder.includes("rec-stop:tab-closed"));
  assert.equal(h.toasts.length, 0, "a closing tab is not asked to confirm anything");

  /* A pagehide is not always a goodbye: a page frozen into the bfcache can come
   * back with the same game on screen, and it must resume this record rather
   * than write a second one for a game already half-recorded. */
  h.board.turn = 7;
  h.life.start(h.board.element);
  assert.equal(h.life.current().id, m.id);
  assert.equal(h.matches().length, 1);
});

test("nothing happens when there is no match", () => {
  // Every entry point is called on a page with no board, several times a
  // second, for as long as the browser is open.
  const h = harness();
  h.life.refresh(null);
  h.life.scanText({ nodeType: 1, textContent: "VICTORY" });
  h.life.end("win", "score");
  h.life.endOnPhaseChange(null, null);
  h.life.saveIfDirty();
  h.life.flushOnUnload();
  h.life.onMatchesChanged([], []);
  h.life.dropLive();

  assert.deepEqual(h.writes, []);
  assert.equal(h.life.current(), null);
});

test("a board that vanishes ends the match on the scores it had", () => {
  const h = harness();
  const m = h.play();
  h.board.myScore = 4;
  h.board.opponentScore = 2;
  h.life.refresh(h.board.element);
  h.life.endOnPhaseChange(null, null);

  const saved = h.stored(m.id);
  assert.equal(saved.result, "unknown", "a lead is not a win");
  assert.equal(saved.endReason, "board-unmounted");
});

test("the deck is named at the start and the format is filed with it", () => {
  const h = harness();
  h.setDeckSources({
    activeDeck: { name: "Bandle Bomb", champion: "Diana, Scorn of the Moon", at: Date.now() },
    candidates: [],
    urlName: null,
  });
  h.setFormat("bo3");
  h.board.cards["self/legend"] = "Diana, Scorn of the Moon";
  const m = h.play();

  assert.equal(m.deckName, "Bandle Bomb");
  assert.equal(m.deckSource, "picker");
  assert.equal(m.matchFormat, "bo3");
  assert.equal(m.matchFormatSource, "live");
  assert.ok(
    h.recorder.includes("deck-pending-cleared"),
    "pre-game deck sightings are dropped once a game has claimed them"
  );
});

test("a remembered format is filed as remembered, not as read", () => {
  /* The difference the record has to carry: dashboard/series.js will not raise
   * a series around a single game on a format nobody was watching be chosen. */
  const h = harness();
  h.setFormat("bo3", "memory");
  const m = h.play();
  assert.equal(m.matchFormat, "bo3");
  assert.equal(m.matchFormatSource, "memory");
});

test("a match nothing can name a format for carries neither", () => {
  const h = harness();
  h.setFormat(null);
  const m = h.play();
  assert.equal(m.matchFormat, null);
  assert.equal(m.matchFormatSource, null);
});

test("a match nothing can name falls back to the deck used last", () => {
  const h = harness();
  h.setLastDeck("Yesterday's Deck");
  const m = h.play();

  assert.equal(m.deckName, "Yesterday's Deck");
  assert.equal(m.deckSource, "last");
  assert.equal(h.stored(m.id).deckName, "Yesterday's Deck", "and the guess is saved");
});

test("the turn count follows the board and is handed to the recorder", () => {
  const h = harness();
  const m = h.play();
  h.board.turn = 7;
  h.life.refresh(h.board.element);
  assert.equal(m.turns, 7);
  assert.ok(h.recorder.includes("rec-mark:7"));

  // The board's counter can be unreadable; the record keeps its high-water mark.
  h.board.turn = null;
  h.life.refresh(h.board.element);
  assert.equal(m.turns, 7);
  assert.ok(h.recorder.includes("rec-mark:7"));
});

test("who went first is taken off the board while turn 1 is live", () => {
  /* The log fallback can only answer while the opening is still inside the
   * capped log, so a game watched from its first turn must never depend on it.
   * The reading is taken once and then left alone - the board goes on naming a
   * different active player every turn after this one. */
  const h = harness();
  h.board.activeSide = "self";
  const m = h.play();
  assert.equal(m.wentFirst, true);

  h.board.turn = 2;
  h.board.activeSide = "opponent";
  h.life.refresh(h.board.element);
  assert.equal(m.wentFirst, true, "turn 2 is not who went first");
});

test("a board that opens on the opponent records them as going first", () => {
  /* The other half of the same read. `false` is an answer and has to survive
   * as one: every guard downstream tests wentFirst for null, so a side that
   * answered must never look like a side that did not. */
  const h = harness();
  h.board.activeSide = "opponent";
  const m = h.play();
  assert.equal(m.wentFirst, false);
  assert.ok(h.logs.some((l) => l.includes("first turn: opponent")));
});

test("the log outranks the board on who went first", () => {
  /* Both can answer on turn 1, and they can disagree: the log reads the turn
   * END, the board only names whoever is on turn right now. Should the site's
   * turn number ever count rounds instead of player-turns, turn 1 is still
   * showing once the opener has passed and the board would name the player
   * who went SECOND. The reading that is not inferring goes first. */
  const h = harness();
  h.board.activeSide = "self";
  h.board.log = [{ t: "16:11", actor: "opponent", text: "Oathion ended their turn." }];
  const m = h.play();
  assert.equal(m.wentFirst, false);
});

test("a match joined after turn 1 leaves who went first to the log", () => {
  // Nothing on the board says who opened once the opening turn has passed, and
  // a guess from whoever happens to be on turn now would be wrong half the time.
  const h = harness();
  h.board.turn = 4;
  h.board.activeSide = "self";
  const m = h.play();
  assert.equal(m.wentFirst, null);
});

test("a board that names nobody on turn 1 leaves who went first unread", () => {
  const h = harness();
  h.board.activeSide = null;
  const m = h.play();
  assert.equal(m.wentFirst, null);
});

test("scores only ever climb", () => {
  // The score track re-renders constantly and a half-drawn read must not walk
  // a match back.
  const h = harness();
  const m = h.play();
  h.board.myScore = 5;
  h.life.refresh(h.board.element);
  h.board.myScore = 0;
  h.board.opponentScore = null;
  h.life.refresh(h.board.element);

  assert.equal(m.myScore, 5);
  assert.equal(m.opponentScore, 0);
});

// ---- mid-game timestamped notes (flags) -----------------------------------

test("a note typed mid-game lands on the stored record as a timestamped flag", () => {
  /* The goals panel files notes through addFlag, and the flag has to be on
   * disk immediately - a note is exactly the kind of thing a tab can die
   * holding. The text is trimmed the way the replay viewer's own flag prompt
   * trims, and the ms falls back to time-since-match-start here because the
   * stubbed recorder has no elapsedMs. */
  const h = harness();
  const m = h.play();
  const ms = h.life.addFlag("  not sure that was the best play, review later  ");

  assert.ok(Number.isFinite(ms) && ms >= 0, "addFlag reports the ms it filed");
  const saved = h.stored(m.id);
  assert.deepEqual(saved.replayFlags, [
    { ms, text: "not sure that was the best play, review later" },
  ]);
});

test("no live match, or nothing but whitespace, files no flag", () => {
  const h = harness();
  assert.equal(h.life.addFlag("before any game"), null);

  const m = h.play();
  assert.equal(h.life.addFlag("   "), null);
  assert.equal(h.life.addFlag(null), null);
  assert.ok(!h.stored(m.id).replayFlags, "nothing was filed");
});

test("flags stay sorted and capped at the viewer's own bounds", () => {
  // dashboard/replay-html.js keeps at most 50 flags and 80 characters of
  // label when the viewer edits the list; a note filed from the game page
  // must not exceed what the viewer would keep.
  const h = harness();
  const m = h.play();
  for (let i = 0; i < 55; i++) h.life.addFlag("note " + i);
  const long = h.life.addFlag("x".repeat(200));
  assert.ok(Number.isFinite(long));

  const flags = h.stored(m.id).replayFlags;
  assert.equal(flags.length, 50, "capped at 50");
  for (const f of flags) assert.ok(f.text.length <= 80, "labels capped at 80 chars");
  for (let i = 1; i < flags.length; i++) assert.ok(flags[i - 1].ms <= flags[i].ms, "sorted by ms");
});

test("a flag the dashboard wrote mid-game survives the next periodic save", () => {
  /* The replay modal can add a flag while the game is still running. The
   * content side saves the record wholesale every few seconds, so the flag
   * has to be adopted into the live record when the matches array changes
   * under it - the same rule deck names typed by hand follow. */
  const h = harness();
  const m = h.play();

  const flagged = h.matches().map((x) =>
    x.id === m.id ? Object.assign({}, x, { replayFlags: [{ ms: 1000, text: "the misplay" }] }) : x
  );
  h.life.onMatchesChanged(flagged, h.matches());
  h.life.saveIfDirty();

  assert.deepEqual(h.stored(m.id).replayFlags, [{ ms: 1000, text: "the misplay" }]);
});
