/**
 * Rift Atlas Stats Tracker - content script
 *
 * Passively observes the play.riftatlas.com game DOM and records match data:
 *  - your champion/legend and the opponent's champion/legend (from card alt text)
 *  - room code, mode, player names, scores
 *  - result (auto-detected on win / concede, with a manual override toast)
 *
 * It never clicks anything or sends anything on your behalf.
 */
(() => {
  "use strict";

  const SEL = {
    root: '[data-testid="game-state"]',
    roomCode: '[data-testid="room-code"]',
    myScoreGroup: '[role="group"][aria-label="Your score track"]',
    oppScoreGroup: '[role="group"][aria-label="Opponent score track"]',
  };

  const WIN_SCORE = 8;
  const MAX_LOG = 500; // cap stored log lines per match
  const MAX_SNAPS = 500; // cap replay snapshots per match
  const REPLAY_SAVE_MS = 5000; // how often to flush the replay buffer
  // Match-log actor colours (left bar on each log row).
  const ACTOR_SELF = "120,221,183"; // green
  const ACTOR_OPP = "255,187,110"; // amber
  // Deliberately strict: card/battlefield names appear in the match log, so
  // loose words ("abandoned", "won", "left") cause false match-ends.
  const END_TEXT_RE = /\b(victory|defeat|you win|you lose|you won|you lost|wins the game|conceded|concedes)\b/i;
  const WIN_TEXT_RE = /\b(victory|you win|you won)\b/i;
  const LOSS_TEXT_RE = /\b(defeat|you lose|you lost)\b/i;

  let currentMatch = null; // in-progress match record
  let lastSavedId = null; // id of last saved record (toast overrides edit it)
  let lastEnded = null; // { roomCode, at, record } - guards against false ends
  let toastEl = null;
  let observer = null;

  // ---------- helpers ----------

  const uid = () =>
    "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

  function getRoot() {
    return document.querySelector(SEL.root);
  }

  function cardAlt(zoneOwner, dropZone) {
    // e.g. section[data-zone-owner="opponent"] ... [data-drop-zone="champion"] img[alt]
    const owners = document.querySelectorAll(`[data-zone-owner="${zoneOwner}"]`);
    for (const owner of owners) {
      const img = owner.querySelector(`[data-drop-zone="${dropZone}"] img[alt]`);
      if (img && img.alt && !/hidden card|card back/i.test(img.alt)) return img.alt;
    }
    return null;
  }

  function readPlayerNames() {
    // Player names are rendered as vertical letter rails next to the score tracks.
    // rotate-90 letters read top-to-bottom in order; -rotate-90 read reversed.
    const names = { mine: null, opponent: null };
    try {
      const rails = document.querySelectorAll(
        ".grid.content-center.justify-items-center"
      );
      for (const rail of rails) {
        const spans = [...rail.querySelectorAll("span")].filter(
          (s) => s.textContent.length === 1
        );
        if (spans.length < 2) continue;
        const reversed = spans[0].className.includes("-rotate-90");
        let letters = spans.map((s) => s.textContent).join("");
        if (reversed) letters = [...letters].reverse().join("");
        // Rail inside the LEFT (your) track area = your name; right = opponent.
        // Heuristic: the left rail container mentions "left-[" positioning.
        const container = rail.closest('div[class*="absolute"]');
        const isLeft = container && /(^|\s|\[)left-/.test(container.className);
        if (isLeft && !names.mine) names.mine = letters;
        else if (!names.opponent) names.opponent = letters;
      }
    } catch (_) {
      /* names are optional */
    }
    return names;
  }

  function readMyScore() {
    const group = document.querySelector(SEL.myScoreGroup);
    if (!group) return null;
    const active = group.querySelector('[aria-pressed="true"] span');
    const n = active ? parseInt(active.textContent, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  function readOppScore() {
    const group = document.querySelector(SEL.oppScoreGroup);
    if (!group) return null;
    // Opponent nodes have no aria-pressed; the current one carries a distinct
    // amber highlight. Fall back to the node with the longest class string.
    const nodes = [...group.children];
    if (!nodes.length) return null;
    let current =
      nodes.find((n) => n.className.includes("108,75,39")) || // amber gradient
      nodes.find((n) => n.className.includes("255,224,181")); // amber ring
    if (!current) {
      current = nodes.reduce((a, b) =>
        a.className.length >= b.className.length ? a : b
      );
    }
    const n = parseInt(current.querySelector("span")?.textContent ?? "", 10);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- replay capture (board snapshots) ----------
  //
  // Rift Atlas bumps data-authoritative-sequence on every authoritative game
  // action, which makes a perfect trigger: one snapshot per real game event.
  // We store card CODES (e.g. "UNL-199"), not images - the viewer rebuilds
  // image URLs from the same CDN the site uses.

  let replay = { id: null, snaps: [] };
  let lastSeq = null;
  let lastSnapJson = null;
  let replayDirty = false;
  let replaySavedAt = 0;
  // Frames captured before the game proper starts (battlefield pick, first
  // player roll, mulligan). Buffered, then prepended when the match begins.
  let pending = { roomCode: null, snaps: [] };
  let pendingLastJson = null;
  const MAX_PREGAME = 60;
  // Deck name/legend pairs spotted on the lobby & deck-select screens, kept
  // so the deck can still be identified once the board reveals our legend.
  let pendingDeckCands = [];

  const codeFromSrc = (src) => {
    const m = /\/cards\/[^/]+\/([A-Za-z0-9]+-[A-Za-z0-9]+)\.webp/.exec(src || "");
    return m ? m[1] : null;
  };

  // Tokens (Recruit, Sand Soldier, Viktor's soldiers…) are served from a
  // different path than cards, so they need their own extractor or they end
  // up with no artwork in the replay.
  const tokenFromSrc = (src) => {
    const m = /\/static\/tokens\/(?:thumbs\/)?([A-Za-z0-9_-]+)\.webp/.exec(src || "");
    return m ? m[1] : null;
  };

  function cardFromImg(img) {
    const name = img.alt || "";
    const src = img.currentSrc || img.src;
    const code = codeFromSrc(src);
    if (code) return { c: code, n: name };
    const token = tokenFromSrc(src);
    if (token) return { tk: token, n: name || token };
    return { n: name };
  }

  /**
   * Counters/buffs are drawn in a separate overlay layer keyed by card id.
   * We read it once per snapshot and attach values to the cards they belong
   * to, so nothing is stored unless a card actually has a counter on it.
   */
  function captureCounters() {
    const overlay = document.querySelector('[data-card-counter-overlay-root="true"]');
    if (!overlay || !overlay.children.length) return null;
    if (!captureCounters._dumped) {
      captureCounters._dumped = true;
      console.info(
        "[RA-Tracker] counter overlay sample (send this to wire counters precisely):\n" +
          overlay.innerHTML.slice(0, 1500)
      );
    }
    const map = {};
    for (const el of overlay.querySelectorAll("[data-card-id]")) {
      const id = el.getAttribute("data-card-id");
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (id && txt) map[id] = txt.slice(0, 12);
    }
    return Object.keys(map).length ? map : null;
  }

  function zoneCards(owner, zoneRoot, counters) {
    const out = [];
    const seen = new Set();
    const sel = owner
      ? `[data-drop-zone-root="${zoneRoot}"][data-zone-owner="${owner}"]`
      : `[data-drop-zone-root="${zoneRoot}"]:not([data-zone-owner])`;
    let roots;
    try {
      roots = document.querySelectorAll(sel);
    } catch (_) {
      return out;
    }
    for (const r of roots) {
      for (const el of r.querySelectorAll("[data-card-id]")) {
        const id = el.getAttribute("data-card-id");
        if (seen.has(id)) continue; // wrapper + button share the id
        const img = el.querySelector("img[alt]");
        if (!img) continue;
        seen.add(id);
        const name = img.alt || "";
        if (/hidden card|card back|rune back/i.test(name)) {
          out.push({ h: 1 });
        } else {
          const card = cardFromImg(img);
          const k = counters && counters[id];
          if (k) card.k = k; // counter / buff text, e.g. "+2"
          out.push(card);
        }
      }
    }
    return out;
  }

  /** Every zone the board currently has, not just the ones we knew about. */
  function discoverZones() {
    const set = new Set(["battlefieldA", "battlefieldB", "base", "runeArea", "hand", "trash"]);
    try {
      for (const el of document.querySelectorAll("[data-drop-zone-root]")) {
        const n = el.getAttribute("data-drop-zone-root");
        if (n) set.add(n);
      }
    } catch (_) {}
    return [...set];
  }

  /** Every battlefield on the board, including ones played mid-game. */
  function discoverBattlefields() {
    const out = {};
    let markers = [];
    try {
      markers = document.querySelectorAll("[data-battlefield-marker]");
    } catch (_) {}
    for (const el of markers) {
      const id = el.getAttribute("data-battlefield-marker");
      if (!id) continue;
      const img = el.querySelector("img[alt]");
      const card = img ? cardFromImg(img) : null;
      // A and B are the two permanent battlefields and always belong on the
      // board. Anything else (Baron Nashor's Pit and the like) is only real
      // once it has actually been played, so an empty slot is not recorded.
      const permanent = id === "battlefieldA" || id === "battlefieldB";
      if (card || permanent) out[id] = card;
    }
    if (!Object.keys(out).length) {
      out.battlefieldA = battlefieldName("battlefieldA");
      out.battlefieldB = battlefieldName("battlefieldB");
    }
    return out;
  }

  function singleCard(owner, dropZone) {
    const owners = document.querySelectorAll(`[data-zone-owner="${owner}"]`);
    for (const o of owners) {
      const img = o.querySelector(`[data-drop-zone="${dropZone}"] img[alt]`);
      if (img && img.alt && !/hidden card|card back/i.test(img.alt)) {
        return { c: codeFromSrc(img.currentSrc || img.src), n: img.alt };
      }
    }
    return null;
  }

  function pileCount(owner, slot) {
    const el = document.querySelector(
      `[data-pile-slot="${slot}"][data-pile-owner="${owner}"]`
    );
    const n = el ? parseInt(el.getAttribute("data-pile-count") ?? "", 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  function battlefieldName(which) {
    const el = document.querySelector(`[data-battlefield-marker="${which}"]`);
    const img = el && el.querySelector("img[alt]");
    return img ? { c: codeFromSrc(img.currentSrc || img.src), n: img.alt } : null;
  }

  function buildSnapshot(root, phase) {
    const counters = captureCounters();
    const step =
      document.querySelector('[data-testid="turn-step"]')?.dataset.turnStep || null;
    const snap = {
      s: root.dataset.authoritativeSequence || null,
      ph: phase || null,
      tn: parseInt(root.dataset.turnNumber ?? "", 10) || null,
      st: step,
      ap: root.dataset.activePlayerSeat || null,
      sc: [readMyScore() ?? 0, readOppScore() ?? 0],
      z: {},
      p: {},
      bf: discoverBattlefields(),
    };
    const zones = discoverZones();
    // Zones that belong to neither player (shared/neutral areas).
    for (const zone of zones) {
      const neutral = zoneCards(null, zone, counters);
      if (neutral.length) snap.z["neutral." + zone] = neutral;
    }
    for (const owner of ["self", "opponent"]) {
      for (const zone of zones) {
        const cards = zoneCards(owner, zone, counters);
        if (cards.length) snap.z[owner + "." + zone] = cards;
      }
      snap.z[owner + ".legend"] = singleCard(owner, "legend");
      snap.z[owner + ".champion"] = singleCard(owner, "champion");
      snap.p[owner + ".mainDeck"] = pileCount(owner, "mainDeck");
      snap.p[owner + ".runeDeck"] = pileCount(owner, "runeDeck");
    }
    return snap;
  }

  function takeSnapshot(root) {
    const m = currentMatch;
    if (!m || !root) return;
    const seq = root.dataset.authoritativeSequence || null;
    if (seq !== null && seq === lastSeq) return; // nothing authoritative changed
    lastSeq = seq;

    const snap = buildSnapshot(root, "in_game");
    const json = JSON.stringify(snap);
    if (json === lastSnapJson) return; // identical board, don't store twice
    lastSnapJson = json;

    snap.t = Date.now() - (Date.parse(m.startedAt) || Date.now());
    if (replay.id !== m.id) replay = { id: m.id, snaps: [] };
    replay.snaps.push(snap);
    if (replay.snaps.length > MAX_SNAPS) replay.snaps.shift();
    replayDirty = true;
  }

  /** Snapshot the setup phases (battlefield pick, roll, mulligan) too. */
  function capturePregame(root, phase) {
    // Remember any deck names visible during setup - they usually disappear
    // once the board is dealt.
    for (const c of deckCandidates()) {
      if (!pendingDeckCands.some((x) => x.name === c.name && x.legend === c.legend)) {
        pendingDeckCands.push(c);
        if (pendingDeckCands.length > 12) pendingDeckCands.shift();
      }
    }
    const code = document.querySelector(SEL.roomCode)?.dataset.roomCode || null;
    if (pending.roomCode !== code) {
      pending = { roomCode: code, snaps: [] };
      pendingLastJson = null;
    }
    let snap;
    try {
      snap = buildSnapshot(root, phase);
    } catch (_) {
      return;
    }
    const json = JSON.stringify(snap);
    if (json === pendingLastJson) return;
    pendingLastJson = json;
    snap.t = 0;
    pending.snaps.push(snap);
    if (pending.snaps.length > MAX_PREGAME) pending.snaps.shift();
  }

  function persistReplay(force) {
    if (!replayDirty || !replay.id) return;
    if (!force && Date.now() - replaySavedAt < REPLAY_SAVE_MS) return;
    replaySavedAt = Date.now();
    replayDirty = false;
    try {
      chrome.storage.local.set({
        ["replay_" + replay.id]: { id: replay.id, snaps: replay.snaps },
      });
    } catch (err) {
      showOrphanBanner();
    }
  }

  // ---------- match log capture ----------

  // A log row looks like:
  //   <li><span aria-hidden bar-colour></span>
  //       <p><span><span>16:11</span><span>Conquered <b>X</b> and scored 1.</span></span>…</p></li>
  function parseLogLi(li) {
    const p = li.querySelector("p");
    if (!p) return null;
    const spans = [...p.querySelectorAll("span")];
    const timeIdx = spans.findIndex((s) =>
      /^\d{1,2}:\d{2}$/.test((s.textContent || "").trim())
    );
    if (timeIdx < 0) return null;
    const t = spans[timeIdx].textContent.trim();
    // Use the wrapper span so nested <b>/<span> formatting is included.
    const holder = spans[timeIdx].parentElement || p;
    let text = (holder.textContent || "").trim();
    if (text.startsWith(t)) text = text.slice(t.length).trim();
    if (!text) return null;
    const bar = li.querySelector('span[aria-hidden="true"]');
    const cls = (bar && bar.className) || "";
    const actor = cls.includes(ACTOR_SELF)
      ? "self"
      : cls.includes(ACTOR_OPP)
      ? "opponent"
      : "system";
    return { t, actor, text };
  }

  const logSig = (e) => e.t + "|" + e.actor + "|" + e.text;

  function captureLog() {
    const m = currentMatch;
    if (!m) return;
    let lis;
    try {
      lis = document.querySelectorAll("ul li");
    } catch (_) {
      return;
    }
    if (!lis.length) return;
    // The panel renders newest-first; reverse for chronological order.
    const entries = [];
    for (const li of lis) {
      const e = parseLogLi(li);
      if (e) entries.push(e);
    }
    if (!entries.length) return;
    entries.reverse();

    m.log = m.log || [];
    // Count-based merge: append only the occurrences we haven't stored yet.
    // Survives React re-rendering the whole list (node identity is useless).
    const stored = new Map();
    for (const e of m.log) {
      const s = logSig(e);
      stored.set(s, (stored.get(s) || 0) + 1);
    }
    const seen = new Map();
    for (const e of entries) {
      const s = logSig(e);
      const n = (seen.get(s) || 0) + 1;
      seen.set(s, n);
      if (n > (stored.get(s) || 0)) {
        m.log.push(e);
        if (m.log.length > MAX_LOG) m.log.shift();
      }
    }
  }

  // ---------- deck name ----------
  // The in-game DOM may not expose a deck name at all; if it doesn't, matches
  // are labelled by hand in the dashboard. This probes the likely sources and
  // reports what it finds once, so auto-detection can be wired if possible.
  // Rift Atlas renders the chosen deck as a pair of sibling <p> elements:
  //   <p>latest</p><p>Diana, Scorn of the Moon</p>
  // i.e. deck name followed by its legend. Matching the second <p> against the
  // legend we independently read off the board is what makes this safe when
  // several decks are listed on screen.
  // "Diana, Scorn of the Moon" / "Rek'Sai, Breacher" - both halves start with
  // a capital and contain no digits or sentence punctuation, which keeps log
  // lines like "Rolled 16, monke rolled 4." from being mistaken for a legend.
  const LEGEND_RE = /^\p{Lu}[\p{L}'’.\- ]{1,28},\s+\p{Lu}[\p{L}'’\- ]{1,38}$/u;

  function deckCandidates() {
    const out = [];
    const seen = new Set();
    let ps;
    try {
      ps = document.querySelectorAll("p");
    } catch (_) {
      return out;
    }
    for (const p of ps) {
      const next = p.nextElementSibling;
      if (!next || next.tagName !== "P") continue;
      const name = (p.textContent || "").replace(/\s+/g, " ").trim();
      const legend = (next.textContent || "").replace(/\s+/g, " ").trim();
      if (!name || name.length > 60) continue;
      if (!LEGEND_RE.test(legend)) continue;
      const key = name + "|" + legend;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, legend });
    }
    return out;
  }

  /** Pick the deck whose legend matches ours; only guess when unambiguous. */
  function resolveDeckName(myLegend, extra) {
    const cands = deckCandidates().concat(extra || []);
    if (!cands.length) return null;
    if (myLegend) {
      const hit = cands.find((c) => c.legend === myLegend);
      if (hit) return hit.name;
    }
    const names = [...new Set(cands.map((c) => c.name))];
    if (names.length === 1) return names[0];
    if (!resolveDeckName._warned) {
      resolveDeckName._warned = true;
      console.info("[RA-Tracker] several decks on screen, can't tell which is active:", cands);
    }
    return null;
  }

  function detectDeckName() {
    try {
      const u = new URLSearchParams(location.search);
      for (const k of ["deck", "deckName", "deckId", "list"]) {
        const v = u.get(k);
        if (v && v.length < 60) return v;
      }
      const el = document.querySelector("[data-deck-name]");
      if (el) return el.getAttribute("data-deck-name");
    } catch (_) {}
    return null;
  }

  function probeDeckSources() {
    if (probeDeckSources._done) return;
    probeDeckSources._done = true;
    try {
      const keys = Object.keys(localStorage).filter((k) => /deck|list/i.test(k));
      if (keys.length) {
        console.info(
          "[RA-Tracker] deck-related localStorage keys (send these to enable auto deck naming):",
          keys.map((k) => k + " = " + String(localStorage.getItem(k)).slice(0, 120))
        );
      } else {
        console.info("[RA-Tracker] no deck name found in the page; label decks in the dashboard.");
      }
    } catch (_) {}
  }

  // ---------- match lifecycle ----------

  function startMatch(root) {
    const code =
      document.querySelector(SEL.roomCode)?.dataset.roomCode || null;
    // ONE ENTRY PER GAME: after a match ends, the site keeps the board in
    // "in_game" under the end overlay. Never start a new record in the same
    // room unless the turn counter has reset (a genuine rematch).
    if (lastEnded && lastEnded.roomCode && lastEnded.roomCode === code) {
      const prev = lastEnded.record;
      const turnNow = parseInt(root?.dataset.turnNumber ?? "", 10) || 0;
      const isNewGame = turnNow <= 1 || turnNow < (prev.turns || 1);
      if (!isNewGame) {
        const decidedByScore =
          prev.myScore >= WIN_SCORE || prev.opponentScore >= WIN_SCORE;
        if (
          decidedByScore ||
          prev.resultSource === "manual" ||
          prev.endReason === "score" || // a score-decided end is never false
          (prev.endCount || 0) >= 3 // hard latch: end/resume loops impossible
        ) {
          return; // game is over, board is lingering - suppress duplicates
        }
        // Otherwise it was a false end while the game continues: reopen it.
        prev.endedAt = null;
        prev.result = null;
        prev.resultSource = null;
        prev.endReason = null;
        currentMatch = prev;
        lastEnded = null;
        removeToast();
        saveMatch(prev);
        console.info("[RA-Tracker] false end detected - resumed match", code);
        return;
      }
      lastEnded = null; // turn counter reset: genuine rematch, record it
    }
    // Extra belt-and-braces: a fresh game never begins at match point.
    const my0 = readMyScore();
    if (my0 !== null && my0 >= WIN_SCORE) return;
    const names = readPlayerNames();
    currentMatch = {
      id: uid(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      mode: root.dataset.roomMode || null,
      roomCode:
        document.querySelector(SEL.roomCode)?.dataset.roomCode || null,
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
      log: [], // [{t, actor: self|opponent|system, text}]
      schemaVersion: 3,
    };
    // Carry the setup/mulligan frames into this match's replay.
    if (pending.roomCode && pending.roomCode === currentMatch.roomCode && pending.snaps.length) {
      replay = { id: currentMatch.id, snaps: pending.snaps.slice() };
      replayDirty = true;
      console.info("[RA-Tracker] attached %d setup/mulligan frames", pending.snaps.length);
    }
    pending = { roomCode: null, snaps: [] };
    pendingLastJson = null;
    refreshMatchFacts(root); // fills in myLegend, needed to pick the right deck

    // Deck: read it off the page (verified against our legend), fall back to
    // the URL, then to the last deck you used.
    const found =
      resolveDeckName(currentMatch.myLegend, pendingDeckCands) || detectDeckName();
    if (found) {
      currentMatch.deckName = found;
      console.info("[RA-Tracker] deck detected:", found);
      try {
        chrome.storage.local.get({ settings: {} }, (d) => {
          const s = Object.assign({}, d && d.settings, { lastDeck: found });
          chrome.storage.local.set({ settings: s });
        });
      } catch (_) {}
    } else {
      const fresh0 = currentMatch;
      try {
        chrome.storage.local.get({ settings: {} }, (d) => {
          const last = d && d.settings && d.settings.lastDeck;
          if (last && currentMatch === fresh0 && !fresh0.deckName) {
            fresh0.deckName = last; // assume same deck as last time
            saveMatch(fresh0);
          }
        });
      } catch (_) {}
    }
    pendingDeckCands = [];
    // Persist immediately - and if the page was reloaded mid-game, adopt the
    // earlier open record for this room instead of creating a duplicate.
    // A match must never exist only in memory.
    const fresh = currentMatch;
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
        if (Array.isArray(open.log) && open.log.length) fresh.log = open.log; // legacy inline log
        // Resume the existing replay and log instead of starting new ones.
        const rKey = "replay_" + fresh.id;
        const lKey = "log_" + fresh.id;
        chrome.storage.local.get([rKey, lKey], (r) => {
          const prev = r && r[rKey];
          if (prev && Array.isArray(prev.snaps)) {
            replay = { id: fresh.id, snaps: prev.snaps };
          }
          const prevLog = r && r[lKey];
          if (prevLog && Array.isArray(prevLog.log) && prevLog.log.length > (fresh.log || []).length) {
            fresh.log = prevLog.log;
          }
        });
      }
      saveMatch(fresh);
    });
    console.info("[RA-Tracker] match started", currentMatch.roomCode);
  }

  function refreshMatchFacts(root) {
    if (!currentMatch) return;
    const m = currentMatch;
    m.myLegend = cardAlt("self", "legend") || m.myLegend;
    m.myChampion = cardAlt("self", "champion") || m.myChampion;
    m.opponentLegend = cardAlt("opponent", "legend") || m.opponentLegend;
    m.opponentChampion = cardAlt("opponent", "champion") || m.opponentChampion;
    if (!m.myName || !m.opponentName) {
      const names = readPlayerNames();
      m.myName = m.myName || names.mine;
      m.opponentName = m.opponentName || names.opponent;
    }
    const myScore = readMyScore();
    const oppScore = readOppScore();
    if (myScore !== null && myScore > m.myScore) m.myScore = myScore;
    if (oppScore !== null && oppScore > m.opponentScore) m.opponentScore = oppScore;
    const turn = parseInt(root?.dataset.turnNumber ?? "", 10);
    if (Number.isFinite(turn) && turn > m.turns) m.turns = turn;
    captureLog();
    takeSnapshot(root);

    // Score-based end detection (first to WIN_SCORE).
    if (m.myScore >= WIN_SCORE) endMatch("win", "score");
    else if (m.opponentScore >= WIN_SCORE) endMatch("loss", "score");
  }

  function endMatch(result, reason) {
    if (!currentMatch) return;
    const m = currentMatch;
    captureLog(); // grab any final lines before we let go
    persistReplay(true);
    persistLogFor(m, true);
    currentMatch = null;
    m.endedAt = new Date().toISOString();
    const started = Date.parse(m.startedAt);
    if (Number.isFinite(started)) {
      m.durationMs = Math.max(0, Date.parse(m.endedAt) - started);
    }
    m.result = result || "unknown";
    m.resultSource = result && result !== "unknown" ? "auto" : null;
    m.endReason = reason;
    m.endCount = (m.endCount || 0) + 1;
    lastEnded = { roomCode: m.roomCode, at: Date.now(), record: m };
    saveMatch(m);
    if (m.endCount <= 2) showConfirmToast(m);
    console.info("[RA-Tracker] match ended:", m.result, "(" + reason + ")");
  }

  // The matches array is rewritten every few seconds during a live game, so it
  // must stay small: game logs live in their own log_<id> key instead of
  // inside the record (~21 KB -> ~0.5 KB per match).
  let logSavedAt = 0;

  function persistLogFor(m, force) {
    if (!m || !m.id || !Array.isArray(m.log) || !m.log.length) return;
    if (!force && Date.now() - logSavedAt < 5000) return;
    logSavedAt = Date.now();
    try {
      chrome.storage.local.set({ ["log_" + m.id]: { id: m.id, log: m.log } });
    } catch (err) {
      showOrphanBanner();
    }
  }

  function saveMatch(record) {
    lastSavedId = record.id;
    const lean = Object.assign({}, record);
    delete lean.log; // stored separately under log_<id>
    try {
      chrome.storage.local.get({ matches: [] }, (data) => {
        // Drop any corrupted (null / id-less) entries - they poison every
        // subsequent read and silently break all saves.
        const matches = (data.matches || []).filter((x) => x && x.id);
        const idx = matches.findIndex((x) => x.id === record.id);
        if (idx >= 0) matches[idx] = lean;
        else matches.push(lean);
        chrome.storage.local.set({ matches });
      });
    } catch (err) {
      // Extension was reloaded/updated: this tab's script is orphaned and
      // cannot reach storage anymore. Tell the user loudly.
      showOrphanBanner();
      console.error("[RA-Tracker] storage unavailable - refresh this tab", err);
    }
  }

  // ---------- orphaned-script detection (extension updated under us) ----------

  let orphanBannerShown = false;
  function isOrphaned() {
    try {
      return !chrome.runtime || !chrome.runtime.id;
    } catch (_) {
      return true;
    }
  }
  function showOrphanBanner() {
    if (orphanBannerShown) return;
    orphanBannerShown = true;
    const el = document.createElement("div");
    el.id = "ra-tracker-orphan";
    el.textContent =
      "Rift Atlas Tracker was updated — REFRESH THIS TAB to resume recording. Matches played before refreshing will NOT be saved.";
    el.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
      "background:#7c2d2d;color:#fff;font:600 13px/1.4 system-ui,sans-serif;" +
      "padding:8px 14px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.5);cursor:pointer;";
    el.title = "Click to dismiss";
    el.addEventListener("click", () => el.remove());
    (document.body || document.documentElement).appendChild(el);
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

  function discardMatch(id) {
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

  // ---------- end-of-match confirmation toast (manual override) ----------

  function showConfirmToast(record) {
    removeToast();
    const el = document.createElement("div");
    el.id = "ra-tracker-toast";
    const detected =
      record.result === "win"
        ? "WIN detected"
        : record.result === "loss"
        ? "LOSS detected"
        : "Result not detected";
    el.innerHTML = `
      <div class="rat-title">Rift Atlas Tracker</div>
      <div class="rat-sub">${escapeHtml(record.myChampion || "You")} vs ${escapeHtml(
      record.opponentChampion || "opponent"
    )} &mdash; <b class="rat-${record.result}">${detected}</b></div>
      <div class="rat-row">
        <button data-r="win">Win</button>
        <button data-r="loss">Loss</button>
        <button data-r="draw">Draw</button>
        <button data-r="__discard" class="rat-discard">Don't record</button>
        <button data-r="__ok" class="rat-ok">OK</button>
      </div>
      <div class="rat-hint">Wrong? Click the correct result to override. Auto-closes in 30s.</div>
    `;
    el.addEventListener("click", (e) => {
      const r = e.target?.dataset?.r;
      if (!r) return;
      if (r === "__discard") discardMatch(record.id);
      else if (r === "__ok") overrideResult(record.id, record.result); // confirm = manual
      else overrideResult(record.id, r);
      removeToast();
    });
    document.body.appendChild(el);
    toastEl = el;
    setTimeout(removeToast, 30000);
  }

  function removeToast() {
    if (toastEl) {
      toastEl.remove();
      toastEl = null;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------- end detection from added text (victory screens, log lines) ----------

  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function scanAddedText(node) {
    if (!currentMatch || !node || !node.textContent) return;
    // Never react to our own toast.
    const host = node.nodeType === 3 ? node.parentElement : node;
    if (host && host.closest && host.closest("#ra-tracker-toast")) return;
    const text = node.textContent;
    const m = currentMatch;
    // "<PLAYER> LEFT" end-modal (appears with a "LEAVE GAME" button).
    const oppLeft =
      m.opponentName &&
      new RegExp("\\b" + escRe(m.opponentName) + "\\s+left\\b", "i").test(text);
    const iLeft =
      m.myName &&
      new RegExp("\\b" + escRe(m.myName) + "\\s+left\\b", "i").test(text);
    const leaveModal = /\bleave game\b/i.test(text);
    if (!END_TEXT_RE.test(text) && !oppLeft && !iLeft && !leaveModal) return;
    let result = "unknown";
    if (WIN_TEXT_RE.test(text) || oppLeft) result = "win";
    else if (LOSS_TEXT_RE.test(text) || iLeft) result = "loss";
    else {
      // No direction in the text: use the score leader as the guess.
      const my = m.myScore, opp = m.opponentScore;
      result = my === opp ? "unknown" : my > opp ? "win" : "loss";
    }
    endMatch(result, "text:" + (text.trim().slice(0, 60)));
  }

  // ---------- main loop ----------

  function tick(mutations) {
    const root = getRoot();
    const phase = root?.dataset.roomPhase || null;

    if (root && phase === "in_game") {
      if (!currentMatch) startMatch(root);
      refreshMatchFacts(root);
    } else if (!currentMatch && root && phase) {
      capturePregame(root, phase); // mulligan / setup frames
    } else if (currentMatch) {
      // We were in a game and now we're not: phase changed or board unmounted.
      const my = currentMatch.myScore, opp = currentMatch.opponentScore;
      let guess = "unknown";
      if (my >= WIN_SCORE) guess = "win";
      else if (opp >= WIN_SCORE) guess = "loss";
      endMatch(guess, root ? "phase:" + phase : "board-unmounted");
    }

    if (mutations && currentMatch) {
      for (const mu of mutations) {
        for (const added of mu.addedNodes) {
          if (added.nodeType === 1 || added.nodeType === 3) scanAddedText(added);
        }
      }
    }
  }

  function boot() {
    observer = new MutationObserver((mutations) => {
      // Throttle: coalesce bursts into one scan per frame.
      if (boot._raf) return;
      boot._raf = requestAnimationFrame(() => {
        boot._raf = null;
        if (isOrphaned()) {
          showOrphanBanner();
          return;
        }
        try {
          tick(mutations);
        } catch (err) {
          console.warn("[RA-Tracker] error", err);
        }
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-room-phase",
        "data-turn-number",
        "aria-pressed",
        "class",
      ],
    });
    // Safety net: periodic scan in case mutations are missed, plus a
    // dirty-save so the in-progress match is always persisted.
    let lastPersistSnap = null;
    setInterval(() => {
      if (isOrphaned()) {
        showOrphanBanner();
        return;
      }
      try {
        tick(null);
        if (currentMatch) {
          const snap = JSON.stringify(currentMatch);
          if (snap !== lastPersistSnap) {
            lastPersistSnap = snap;
            saveMatch(currentMatch);
          }
        }
        persistReplay(false);
        persistLogFor(currentMatch, false);
      } catch (_) {}
    }, 3000);
    // Flush an unfinished match if the tab closes mid-game.
    window.addEventListener("beforeunload", () => {
      if (currentMatch) {
        const m = currentMatch;
        currentMatch = null;
        m.endedAt = new Date().toISOString();
        const st = Date.parse(m.startedAt);
        if (Number.isFinite(st)) m.durationMs = Math.max(0, Date.parse(m.endedAt) - st);
        m.result = "unknown";
        m.endReason = "tab-closed";
        saveMatch(m);
        persistReplay(true);
        persistLogFor(m, true);
      }
    });
    probeDeckSources();
    console.info("[RA-Tracker] active");
  }

  boot();
})();
