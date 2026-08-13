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
    // Deck picker (site pages, not the board): the tab strip we walk up from.
    deckTab: "#deck-list-tab",
  };

  // First to 8 points. The same constant decides whether a lingering "in_game"
  // board is a finished match, which is capture/match-start.js's job, so it is
  // declared there too; test/content-wiring.test.js pins the pair.
  const WIN_SCORE = 8;
  const DECK_POLL_MS = 2000; // how often to re-read the deck picker
  const DECK_READ_MIN_MS = 250; // floor between reads when mutations drive them
  const DECK_STAMP_MS = 30000; // how often to refresh the stored "last seen"
  // How long a deck seen in the picker stays usable. Long enough to cover a
  // session (pick a deck, play several games), short enough that the deck you
  // browsed last week never labels today's match.
  const DECK_MEMORY_MS = 2 * 60 * 60 * 1000;
  const MAX_DECK_NAME = 60; // longer than this and it isn't a deck name
  // The lobby format runs on the deck picker's clock: it is chosen on the same
  // screen, in the same breath, and cannot change faster than a click either.
  const FORMAT_READ_MIN_MS = DECK_READ_MIN_MS;
  const FORMAT_STAMP_MS = DECK_STAMP_MS;
  const FORMAT_MEMORY_MS = DECK_MEMORY_MS;
  const MAX_LOG = 500; // cap stored log lines per match
  const CARDS_SAVE_MS = 5000; // how often to flush the card-code accumulator
  const MAX_PENDING_MUTATIONS = 2000; // ceiling on the coalesced observer queue
  // Match-log actor colours (left bar on each log row).
  const ACTOR_SELF = "120,221,183"; // green
  const ACTOR_OPP = "255,187,110"; // amber

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

  // ---------- deck-card capture ----------
  //
  // Deck fingerprinting only ever needed one thing out of a match: the set of
  // YOUR OWN card codes (e.g. "UNL-199") that became visible while playing it.
  // So that set is what we accumulate, live, instead of storing a board
  // snapshot per game action and reducing it later.
  //
  // Rift Atlas bumps data-authoritative-sequence on every authoritative game
  // action, which is still the trigger: one scrape per real game event.

  // The zones that reflect deck contents. Mirrors DECK_ZONES in
  // dashboard/fingerprint.js - legend and champion are excluded there because
  // they're identical across variants of the same champion, so harvesting them
  // here would only blur the distinction fingerprinting is drawing.
  const DECK_ZONES = ["battlefieldA", "battlefieldB", "base", "hand", "trash", "runeArea"];

  let deckCards = { id: null, codes: new Set() };
  let lastSeq = null;
  let cardsDirty = false;
  let cardsSavedAt = 0;
  // Deck name/legend pairs spotted on the lobby & deck-select screens, kept
  // so the deck can still be identified once the board reveals our legend.
  let pendingDeckCands = [];

  const codeFromSrc = (src) => {
    const m = /\/cards\/[^/]+\/([A-Za-z0-9]+-[A-Za-z0-9]+)\.webp/.exec(src || "");
    return m ? m[1] : null;
  };

  /** Your own card codes currently visible in one deck zone. */
  function zoneCards(owner, zoneRoot) {
    const out = [];
    let roots;
    try {
      roots = document.querySelectorAll(
        `[data-drop-zone-root="${zoneRoot}"][data-zone-owner="${owner}"]`
      );
    } catch (_) {
      return out;
    }
    for (const r of roots) {
      for (const el of r.querySelectorAll("[data-card-id]")) {
        const img = el.querySelector("img[alt]");
        if (!img) continue;
        // Face-down cards say nothing about the deck.
        if (/hidden card|card back|rune back/i.test(img.alt || "")) continue;
        // Tokens are served from a different path, so they have no card code
        // and drop out here - which is right: they were never in the deck.
        const code = codeFromSrc(img.currentSrc || img.src);
        if (code) out.push(code);
      }
    }
    return out;
  }

  /**
   * Fold whatever is on the board right now into this match's card set. Only
   * new codes make the set dirty, so a board that reveals nothing new costs a
   * scrape and no write.
   */
  function collectDeckCards(root) {
    const m = currentMatch;
    if (!m || !root) return;
    const seq = root.dataset.authoritativeSequence || null;
    if (seq !== null && seq === lastSeq) return; // nothing authoritative changed
    lastSeq = seq;

    if (deckCards.id !== m.id) deckCards = { id: m.id, codes: new Set() };
    for (const zone of DECK_ZONES) {
      for (const code of zoneCards("self", zone)) {
        if (deckCards.codes.has(code)) continue;
        deckCards.codes.add(code);
        cardsDirty = true;
      }
    }
  }

  /** Deck names shown on the setup screens vanish once the board is dealt. */
  function rememberPregameDecks() {
    for (const c of deckCandidates()) {
      if (!pendingDeckCands.some((x) => x.name === c.name && x.legend === c.legend)) {
        pendingDeckCands.push(c);
        if (pendingDeckCands.length > 12) pendingDeckCands.shift();
      }
    }
  }

  function persistDeckCards(force) {
    if (!cardsDirty || !deckCards.id) return;
    if (!force && Date.now() - cardsSavedAt < CARDS_SAVE_MS) return;
    cardsSavedAt = Date.now();
    cardsDirty = false;
    try {
      chrome.storage.local.set({
        ["deckcards_" + deckCards.id]: { id: deckCards.id, codes: [...deckCards.codes] },
      });
    } catch (err) {
      console.error("[RA-Tracker] deck cards not saved", err);
      // The banner blames an extension update, so it is only honest once the
      // context really is gone. Any other throw gets the log and nothing else.
      if (isOrphaned()) showOrphanBanner();
    }
  }

  // ---------- match log capture ----------

  // A log row looks like:
  //   <li><span aria-hidden bar-colour></span>
  //       <p><span><span>16:11</span><span>Conquered <b>X</b> and scored 1.</span></span>…</p></li>
  //
  // Chat rows are the same shape but render their own header and repeat the
  // time after the message; capture/match-log.js takes those repeats back out.
  function parseLogLi(li) {
    const p = li.querySelector("p");
    if (!p) return null;
    const spans = [...p.querySelectorAll("span")];
    // This shape check is load-bearing beyond finding the time: `t` reaches
    // match-log.js's RegExps unescaped, and digits-and-a-colon is what keeps
    // that safe.
    const timeIdx = spans.findIndex((s) =>
      /^\d{1,2}:\d{2}$/.test((s.textContent || "").trim())
    );
    if (timeIdx < 0) return null;
    const t = spans[timeIdx].textContent.trim();
    // Use the wrapper span so nested <b>/<span> formatting is included.
    const holder = spans[timeIdx].parentElement || p;
    const text = globalThis.RATMatchLog.stripRepeatedTime(
      (holder.textContent || "").trim(),
      t
    );
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
    // Count-based merge: append only the occurrences we haven't stored yet.
    // Survives React re-rendering the whole list (node identity is useless).
    m.log = globalThis.RATMatchLog.mergeLog(m.log, entries, MAX_LOG);
  }

  // ---------- deck name ----------
  // Matches used to be labelled by hand in the dashboard. The deck picker on
  // play.riftatlas.com names the deck you are about to take into a game, so we
  // watch it continuously and remember what was open; a hand-typed name in the
  // dashboard still overrides whatever we detect.
  //
  // The picker's header sits directly above the deck/tab strip:
  //   <div>                          <- header
  //     <div>…<p>Bandle Bomb</p></div>       <- the name you gave the deck
  //     <div>…<p>Diana, Scorn of the Moon</p></div>  <- its champion
  //     <div role="tablist"><button id="deck-list-tab">…      <- anchor
  // The tab id is the only stable hook on it, so we find the header by walking
  // up from there rather than by matching class names that change every deploy.

  const cleanText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  /**
   * The deck currently open in the picker, or null if it isn't on screen.
   * `:scope > div p` follows the header's own layout: the name and champion
   * divs come before the tab strip, so the first two <p>s in document order
   * are the ones we want. If the champion div ever loses its <p> we pick up a
   * tab label instead - which fails safe, because it then won't match the
   * legend on the board and the read is discarded rather than trusted.
   */
  function readDeckPicker() {
    const header = document
      .querySelector(SEL.deckTab)
      ?.closest('[role="tablist"]')?.parentElement;
    if (!header) return null;
    const ps = header.querySelectorAll(":scope > div p");
    const name = cleanText(ps[0]);
    if (!name || name.length > MAX_DECK_NAME) return null;
    return { name, champion: cleanText(ps[1]) || null };
  }

  // Last deck seen in the picker, with the last time we saw it. Mirrored into
  // its own storage key because the picker unmounts the moment the board
  // mounts, and because the game may be opened in a fresh tab (or the page
  // reloaded) between choosing a deck and playing it. Its own key rather than
  // a field on `settings`, so a write here can't clobber a settings write
  // happening in the dashboard at the same moment.
  let activeDeck = null;
  let deckReadAt = 0;
  let deckSavedAt = 0;

  const deckIsUsable = () =>
    !!activeDeck && Date.now() - (activeDeck.at || 0) < DECK_MEMORY_MS;

  /** Poll the picker. Cheap enough to run on a timer whatever page we're on. */
  function watchDeckPicker() {
    // Mutation-driven calls can arrive every frame on this site; the picker
    // cannot change faster than a click, so a floor costs us nothing.
    const now = Date.now();
    if (now - deckReadAt < DECK_READ_MIN_MS) return;
    deckReadAt = now;

    const found = readDeckPicker();
    if (!found) return;
    const changed =
      !activeDeck ||
      activeDeck.name !== found.name ||
      activeDeck.champion !== found.champion;
    // Always restamp: `at` means "last seen on screen", so a deck left open
    // for an hour doesn't age out from under the player.
    activeDeck = { name: found.name, champion: found.champion, at: now };
    if (changed) {
      console.info(
        "[RA-Tracker] deck picker:",
        activeDeck.name,
        activeDeck.champion ? "(" + activeDeck.champion + ")" : ""
      );
    }
    // Persist on change, and refresh the stored stamp now and then while the
    // picker sits on screen - otherwise storage would record when the deck
    // last CHANGED, and a deck left open all session would look stale to the
    // next page load.
    if (!changed && now - deckSavedAt < DECK_STAMP_MS) return;
    deckSavedAt = now;
    try {
      chrome.storage.local.set({ activeDeck });
    } catch (_) {}
  }

  /** Restore the picked deck across reloads / a newly opened game tab. */
  function loadActiveDeck() {
    try {
      chrome.storage.local.get({ activeDeck: null }, (d) => {
        // Anything read live from the page beats what storage remembers.
        if (d && d.activeDeck && d.activeDeck.name && !activeDeck) {
          activeDeck = d.activeDeck;
        }
      });
    } catch (_) {}
  }

  // "Diana, Scorn of the Moon" -> "diana". The picker names the champion the
  // deck is built around; the board exposes legend and champion CARDS, whose
  // titles differ ("Diana, Scorn of the Moon" vs "Diana, Aspect of the Moon").
  // Comparing the character alone is what makes the check work across both.
  const championKey = (s) =>
    String(s || "").split(",")[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

  /**
   * Does the picked deck agree with the cards on the board?
   * true = agrees, false = contradicted, null = not enough to tell.
   */
  function deckMatchesBoard(deck, m) {
    const want = championKey(deck && deck.champion);
    if (!want) return null;
    const mine = [championKey(m.myLegend), championKey(m.myChampion)].filter(Boolean);
    if (!mine.length) return null;
    return mine.includes(want);
  }

  /**
   * Decide which deck a match was played with, best source first, and say
   * where the answer came from so the dashboard can be honest about it.
   *
   * The champion check is a guard, not a proof: it rules the picked deck OUT
   * when the board shows a different champion, but it cannot tell two decks on
   * the SAME champion apart ("Diana Aggro" vs "Diana Control"). The picker is
   * still the best evidence there is - it names the deck the player last had
   * open - which is why an override always stays one keystroke away.
   */
  function pickDeckName(m) {
    const usable = deckIsUsable();
    const agrees = usable ? deckMatchesBoard(activeDeck, m) : null;
    if (usable && agrees === true) {
      return { name: activeDeck.name, source: "picker" };
    }
    const fromBoard = resolveDeckName(m.myLegend, pendingDeckCands);
    if (fromBoard) return { name: fromBoard, source: "board" };
    if (usable && agrees === null) {
      // Couldn't check either way (no champion text, or the board hasn't
      // revealed our cards yet) - the picker is still the best thing we have.
      return { name: activeDeck.name, source: "picker-unverified" };
    }
    if (usable && agrees === false) {
      console.info(
        "[RA-Tracker] ignoring picked deck “%s” (%s): board shows %s",
        activeDeck.name,
        activeDeck.champion,
        m.myLegend || m.myChampion || "nothing yet"
      );
    }
    const fromUrl = detectDeckName();
    return fromUrl ? { name: fromUrl, source: "url" } : null;
  }

  /** New matches fall back to this when nothing can be detected. */
  function rememberLastDeck(name) {
    try {
      chrome.storage.local.get({ settings: {} }, (d) => {
        const s = Object.assign({}, d && d.settings, { lastDeck: name });
        chrome.storage.local.set({ settings: s });
      });
    } catch (_) {}
  }

  // Fallback for games we never saw the picker for. Rift Atlas renders the
  // chosen deck as a pair of sibling <p> elements:
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
      const name = cleanText(p);
      const legend = cleanText(next);
      if (!name || name.length > MAX_DECK_NAME) continue;
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
        if (v && v.length <= MAX_DECK_NAME) return v;
      }
      const el = document.querySelector("[data-deck-name]");
      if (el) return el.getAttribute("data-deck-name");
    } catch (_) {}
    return null;
  }

  // ---------- match format ----------
  // Bo1 or Bo3 is stated in the lobby and gone by the time the board mounts -
  // the same problem the deck picker has, solved the same way: read it while
  // it is on screen, remember it, and use the memory when the match begins.
  //
  // Two selectors because there are two lobbies. Whoever HOSTS picks the
  // format on a two-button group, where the chosen button carries
  // aria-pressed="true". Whoever JOINS a hosted Bo3 never sees those buttons -
  // they get a one-line summary whose title spells the format out
  // ("1v1 · Constructed · Best of 3 · Standard").
  //
  // Neither path matches on class names. This site's classes are generated
  // utilities with literal colour values baked in ("border-[rgba(116,239,255,
  // 0.42)]") and are rewritten every restyle; aria-pressed and title describe
  // behaviour rather than styling, so they survive one.
  const FORMAT_RE = /Best of\s+(\d+)/i;

  /**
   * The format the lobby is showing, or null if it isn't saying.
   * Only Bo1 and Bo3 exist. A number we don't recognise means the read went
   * somewhere unexpected, and null is safer than inventing a format for it.
   */
  function readMatchFormat(root) {
    const scope = root || document;
    let hit = null;
    // Host path: the pressed button of the format toggle.
    for (const btn of scope.querySelectorAll('button[aria-pressed="true"]')) {
      hit = FORMAT_RE.exec(cleanText(btn));
      if (hit) break;
    }
    // Join path. Sweeping every [title] in the document is safe here: this
    // summary line only ever describes the one game being hosted or joined,
    // never a row of a browsable list, so there is nothing else to hit.
    if (!hit) {
      for (const el of scope.querySelectorAll("[title]")) {
        hit = FORMAT_RE.exec(el.getAttribute("title") || "");
        if (hit) break;
      }
    }
    if (!hit) return null;
    if (hit[1] === "1") return "bo1";
    if (hit[1] === "3") return "bo3";
    return null;
  }

  // Last format seen in the lobby, with the last time we saw it. Mirrored into
  // its own storage key for the same reasons `activeDeck` has one: the lobby
  // unmounts the moment the board mounts, the game may be opened in a fresh
  // tab between hosting and playing, and a write here must not clobber a
  // settings write happening in the dashboard at the same moment.
  let activeFormat = null;
  let formatReadAt = 0;
  let formatSavedAt = 0;

  const formatIsUsable = () =>
    !!activeFormat && Date.now() - (activeFormat.at || 0) < FORMAT_MEMORY_MS;

  /** Poll the lobby. Cheap enough to run on a timer whatever page we're on. */
  function watchMatchFormat() {
    // Mutation-driven calls can arrive every frame on this site; the format
    // cannot change faster than a click, so a floor costs us nothing.
    const now = Date.now();
    if (now - formatReadAt < FORMAT_READ_MIN_MS) return;
    formatReadAt = now;

    const found = readMatchFormat();
    if (!found) return;
    const changed = !activeFormat || activeFormat.format !== found;
    // Always restamp: `at` means "last seen on screen", so a lobby sat in
    // while waiting for an opponent doesn't age out from under the player.
    activeFormat = { format: found, at: now };
    if (changed) console.info("[RA-Tracker] lobby format:", found);
    // Persist on change, and refresh the stored stamp now and then while the
    // lobby sits on screen - otherwise storage would record when the format
    // last CHANGED, and a long wait in the lobby would look stale to the next
    // page load.
    if (!changed && now - formatSavedAt < FORMAT_STAMP_MS) return;
    formatSavedAt = now;
    try {
      chrome.storage.local.set({ activeFormat });
    } catch (_) {}
  }

  /** Restore the lobby format across reloads / a newly opened game tab. */
  function loadActiveFormat() {
    try {
      chrome.storage.local.get({ activeFormat: null }, (d) => {
        // Anything read live from the page beats what storage remembers.
        if (d && d.activeFormat && d.activeFormat.format && !activeFormat) {
          activeFormat = d.activeFormat;
        }
      });
    } catch (_) {}
  }

  // ---------- match lifecycle ----------

  function startMatch(root) {
    const code =
      document.querySelector(SEL.roomCode)?.dataset.roomCode || null;
    // ONE ENTRY PER GAME: after a match ends, the site keeps the board in
    // "in_game" under the end overlay. Whether that board is a finished game
    // lingering, a false end to reopen, or a genuine rematch is decided in
    // capture/match-start.js; the mutations each verdict implies are here.
    const latched = lastEnded && lastEnded.record;
    const { verdict, clearLatch } = globalThis.RATMatchStart.decideStart(lastEnded, {
      roomCode: code,
      turnNow: parseInt(root?.dataset.turnNumber ?? "", 10) || 0,
      myScore: readMyScore(),
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
      removeToast();
      saveMatch(latched);
      console.info("[RA-Tracker] false end detected - resumed match", code);
      return;
    }
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
      deckSource: null, // 'picker' | 'board' | 'url' | 'last' | 'manual' | …
      matchFormat: null, // 'bo1' | 'bo3' | null when the lobby never said
      log: [], // [{t, actor: self|opponent|system, text}]
      schemaVersion: 3,
    };
    globalThis.RATRec && RATRec.start(currentMatch.id);
    refreshMatchFacts(root); // fills in myLegend, needed to pick the right deck

    // Deck: the name from the picker (checked against the legend on the
    // board), else the in-game DOM, else the URL, else the deck you used last.
    const found = pickDeckName(currentMatch);
    if (found) {
      currentMatch.deckName = found.name;
      currentMatch.deckSource = found.source;
      console.info("[RA-Tracker] deck detected:", found.name, "(" + found.source + ")");
      rememberLastDeck(found.name);
    } else {
      const fresh0 = currentMatch;
      try {
        chrome.storage.local.get({ settings: {} }, (d) => {
          const last = d && d.settings && d.settings.lastDeck;
          if (last && currentMatch === fresh0 && !fresh0.deckName) {
            fresh0.deckName = last; // assume same deck as last time
            fresh0.deckSource = "last";
            saveMatch(fresh0);
          }
        });
      } catch (_) {}
    }
    pendingDeckCands = [];

    // Format: the lobby is normally already gone by the time the board mounts,
    // so the live read is the bonus case and the remembered one does the real
    // work. Left null when neither can answer - the dashboard would rather be
    // told nothing than be told a format that was never on screen.
    const fmt =
      readMatchFormat() || (formatIsUsable() ? activeFormat.format : null);
    currentMatch.matchFormat = fmt;
    if (fmt) console.info("[RA-Tracker] match format:", fmt);

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
            deckCards = { id: fresh.id, codes: new Set(prev.codes) };
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
    collectDeckCards(root);
    globalThis.RATRec && RATRec.mark(Number.isFinite(turn) ? turn : m.turns);

    // Score-based end detection (first to WIN_SCORE).
    if (m.myScore >= WIN_SCORE) endMatch("win", "score");
    else if (m.opponentScore >= WIN_SCORE) endMatch("loss", "score");
  }

  function endMatch(result, reason) {
    if (!currentMatch) return;
    const m = currentMatch;
    captureLog(); // grab any final lines before we let go
    // "end" is the capture's own reason: `reason` here is the match result.
    globalThis.RATRec && RATRec.stop("end");
    persistDeckCards(true);
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
    // Deck, one last time. A game can begin before we ever saw the picker (a
    // room link opened straight into a match, or a tab loaded mid-game), and
    // by now the board has long since revealed our legend - so a name we
    // couldn't check at the start can be improved or contradicted here. Names
    // we already trust, and anything hand-typed, are left alone.
    if (m.deckSource !== "manual" && m.deckSource !== "picker" && m.deckSource !== "board") {
      const late = pickDeckName(m);
      if (late && (late.name !== m.deckName || late.source !== m.deckSource)) {
        m.deckName = late.name;
        m.deckSource = late.source;
        rememberLastDeck(late.name);
        console.info("[RA-Tracker] deck resolved at match end:", late.name, "(" + late.source + ")");
      } else if (
        m.deckSource === "picker-unverified" &&
        deckMatchesBoard(activeDeck, m) === false
      ) {
        // Only an explicit contradiction clears a name - never the mere
        // absence of evidence, which would throw away the reading taken at
        // the start of the game. A guess we now know is wrong is worse than
        // no label at all: it silently skews that deck's stats.
        m.deckName = "";
        m.deckSource = null;
        console.info("[RA-Tracker] dropped unverified deck name - the board disagrees");
      }
    }
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
      console.error("[RA-Tracker] match log not saved", err);
      if (isOrphaned()) showOrphanBanner(); // see persistDeckCards
    }
  }

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
    lastSavedId = record.id;
    const lean = leanRecord(record);
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
      // Nearly always a reloaded/updated extension: this tab's script is
      // orphaned and cannot reach storage anymore. "Nearly" is why the banner
      // is gated - it names that cause, and a throw from anything else would
      // send the user to refresh a tab that is fine.
      console.error("[RA-Tracker] storage unavailable", err);
      if (isOrphaned()) showOrphanBanner();
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
    el.className = "ra-tracker-block"; // keeps our own UI out of the visual replay
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

  /* The dashboard deleted the game we are still recording. Storage is already
   * clean, so there is nothing to remove here - the job is to stop writing it
   * back, which the next three-second save would otherwise do unconditionally.
   *
   * Letting go of `currentMatch` is not enough on its own: the board is still
   * mounted in "in_game", so the very next tick would call `startMatch` and
   * record the rest of the game as a new entry. `lastEnded` marked as
   * human-decided is the same latch `discardMatch` relies on, and it makes that
   * suppression path fire. The card accumulator is dropped too, or the next
   * flush would rewrite the deckcards_<id> key the delete just took away. */
  function dropLiveMatch() {
    const m = currentMatch;
    if (!m) return;
    currentMatch = null;
    globalThis.RATRec && RATRec.stop("deleted");
    m.resultSource = "manual";
    lastEnded = { roomCode: m.roomCode, at: Date.now(), record: m };
    deckCards = { id: null, codes: new Set() };
    cardsDirty = false;
    console.info("[RA-Tracker] live match deleted from the dashboard - no longer recording it");
  }

  // ---------- end-of-match confirmation toast (manual override) ----------

  function showConfirmToast(record) {
    removeToast();
    const el = document.createElement("div");
    el.id = "ra-tracker-toast";
    el.className = "ra-tracker-block"; // keeps our own UI out of the visual replay
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

  function scanAddedText(node) {
    if (!currentMatch || !node || !node.textContent) return;
    // Never react to our own toast: it prints the detected result in words, so
    // reading it back would end the match the toast is asking about.
    const host = node.nodeType === 3 ? node.parentElement : node;
    if (host && host.closest && host.closest("#ra-tracker-toast")) return;
    // The record carries exactly the four facts the decision needs.
    const end = globalThis.RATMatchEnd.decideResult(node.textContent, currentMatch);
    if (end) endMatch(end.result, end.reason);
  }

  // ---------- main loop ----------

  function tick(mutations) {
    const root = getRoot();
    const phase = root?.dataset.roomPhase || null;

    // Catch a deck or format change as it renders rather than on the next poll
    // tick. Both are self-throttled, so the mutation firehose costs nothing.
    if (!currentMatch) {
      watchDeckPicker();
      watchMatchFormat();
    }

    if (root && phase === "in_game") {
      if (!currentMatch) startMatch(root);
      refreshMatchFacts(root);
    } else if (!currentMatch && root && phase) {
      rememberPregameDecks(); // battlefield pick / roll / mulligan screens
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
    /* One scan per frame, but every record still gets scanned.
     *
     * The observer can deliver several batches inside one frame, and only the
     * first of them schedules the frame - so the batches have to be kept here
     * rather than read off the callback argument, which holds the first one
     * alone. `tick` scanning added nodes is the ONLY place a victory / concede
     * / "PLAYER LEFT" modal is ever read (the three-second poll calls
     * `tick(null)` and skips the text scan entirely), so a batch dropped here
     * is a match that ends as "unknown"/"board-unmounted" minutes later.
     *
     * Bounded because rAF does not run in a hidden tab while mutations keep
     * arriving: the oldest go, since the end modal is always the newest thing
     * on screen. */
    let pending = [];
    observer = new MutationObserver((mutations) => {
      for (const record of mutations) pending.push(record);
      if (pending.length > MAX_PENDING_MUTATIONS) {
        pending.splice(0, pending.length - MAX_PENDING_MUTATIONS);
      }
      if (boot._raf) return;
      boot._raf = requestAnimationFrame(() => {
        boot._raf = null;
        if (isOrphaned()) {
          showOrphanBanner();
          return;
        }
        // takeRecords() drains anything queued but not yet delivered, so the
        // scan covers the whole frame and nothing is left for a callback that
        // may never come.
        const batch = pending.concat(observer.takeRecords());
        pending = [];
        try {
          tick(batch);
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
          const snap = JSON.stringify(leanRecord(currentMatch));
          if (snap !== lastPersistSnap) {
            lastPersistSnap = snap;
            saveMatch(currentMatch);
          }
        }
        persistDeckCards(false);
        persistLogFor(currentMatch, false);
      } catch (err) {
        // This is the path that persists, so a swallowed throw here loses
        // matches silently.
        console.warn("[RA-Tracker] error", err);
      }
    }, 3000);
    /* Flush an unfinished match if the tab closes mid-game.
     *
     * "pagehide", not "beforeunload": the recorder listens on the same event,
     * and beforeunload is the one that gets skipped on mobile and when the page
     * is frozen into the bfcache.
     *
     * Only when a match is still live. The recorder's own pagehide handler
     * exists solely during the settle window after an "end" stop - the window
     * where it is waiting to catch the victory modal - and stopping it from
     * here would file a finished recording as "stopped" and cost it that last
     * frame. While a match IS live there is no such handler at all, so without
     * this call the tab closes with the batch unflushed and the replay stays
     * "recording", incomplete, forever. */
    window.addEventListener("pagehide", () => {
      if (currentMatch) {
        const m = currentMatch;
        globalThis.RATRec && RATRec.stop("tab-closed");
        currentMatch = null;
        m.endedAt = new Date().toISOString();
        const st = Date.parse(m.startedAt);
        if (Number.isFinite(st)) m.durationMs = Math.max(0, Date.parse(m.endedAt) - st);
        m.result = "unknown";
        m.endReason = "tab-closed";
        // A pagehide is not always a goodbye: a page frozen into the bfcache can
        // come back with the same game still on screen. Handing the record to
        // the false-end latch means `startMatch` reopens THIS one instead of
        // writing a second record for a game already half-recorded.
        lastEnded = { roomCode: m.roomCode, at: Date.now(), record: m };
        saveMatch(m);
        persistDeckCards(true);
        persistLogFor(m, true);
      }
    });
    // The deck picker and the lobby live on the site's own pages, which produce
    // none of the board mutations we filter for, so they get a standing poll of
    // their own rather than riding on the observer. A couple of selector
    // lookups per tick when neither is on screen, which is most of the time.
    loadActiveDeck();
    loadActiveFormat();
    watchDeckPicker();
    watchMatchFormat();
    setInterval(() => {
      // Not while a match is live: the deck and format for this game are
      // already decided, and letting either drift now would only let something
      // the player glanced at overwrite what they actually played.
      if (isOrphaned() || currentMatch) return;
      try {
        watchDeckPicker();
        watchMatchFormat();
      } catch (_) {}
    }, DECK_POLL_MS);
    // A deck name typed in the dashboard while the game is still running would
    // otherwise be undone by the next periodic save of the in-memory record.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes.matches || !currentMatch) return;
        const saved = (changes.matches.newValue || []).find(
          (x) => x && x.id === currentMatch.id
        );
        if (!saved) {
          // Gone from storage - the dashboard deleted it. Only when it was
          // there an instant ago: a writer that read `matches` before this
          // match was first saved writes the array back without it too, and
          // taking that for a delete would abandon a game in progress.
          const wasStored = (changes.matches.oldValue || []).some(
            (x) => x && x.id === currentMatch.id
          );
          if (wasStored) dropLiveMatch();
          return;
        }
        if (saved.deckSource !== "manual") return; // only we write the rest
        if (saved.deckName === currentMatch.deckName) return;
        currentMatch.deckName = saved.deckName || "";
        currentMatch.deckSource = "manual";
        console.info("[RA-Tracker] deck renamed from the dashboard:", currentMatch.deckName);
      });
    } catch (_) {}
    console.info("[RA-Tracker] active");
  }

  boot();
})();
