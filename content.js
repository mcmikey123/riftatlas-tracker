/**
 * Rift Atlas Stats Tracker - content script
 *
 * Passively observes the play.riftatlas.com game DOM and records match data:
 *  - your champion/legend and the opponent's champion/legend (from card alt text)
 *  - room code, mode, player names, scores
 *  - result (auto-detected on win / concede, with a manual override toast)
 *
 * It never clicks anything or sends anything on your behalf.
 *
 * What is left in this file is the clock: what wakes the capture up, how often,
 * and in what order. Everything it wakes lives in capture/ - the board scrapes,
 * the match record, the decisions made about it, and the two things we draw on
 * the page. The manifest's content-script array is the dependency graph (there
 * is no bundler and must not be one), and test/content-wiring.test.js pins it.
 */
(() => {
  "use strict";

  const DECK_POLL_MS = 2000; // how often to re-read the deck picker and lobby
  const MAX_PENDING_MUTATIONS = 2000; // ceiling on the coalesced observer queue

  let observer = null;

  const capture = () => globalThis.RATLifecycle;

  function tick(mutations) {
    const board = globalThis.RATBoard.gameRoot();
    const phase = globalThis.RATBoard.phase(board);
    const live = capture().current();

    // Catch a deck or format change as it renders rather than on the next poll
    // tick. Both are self-throttled, so the mutation firehose costs nothing.
    if (!live) {
      globalThis.RATDeckScan.watch();
      globalThis.RATMatchFormat.watch();
    }
    // Unlike those two, the opponent stays worth watching during the game -
    // their champion card can appear late - so this one is not gated on `live`.
    // Self-throttled the same way.
    globalThis.RATScout.watch();

    if (board && phase === "in_game") {
      if (!live) capture().start(board);
      capture().refresh(board);
    } else if (!live && board && phase) {
      globalThis.RATDeckScan.rememberPregame(); // battlefield pick / roll / mulligan
    } else if (live) {
      capture().endOnPhaseChange(board, phase);
    }

    if (mutations && capture().current()) {
      for (const mu of mutations) {
        for (const added of mu.addedNodes) {
          if (added.nodeType === 1 || added.nodeType === 3) capture().scanText(added);
        }
      }
    }

    // The goals panel follows what this tick decided - after the text scan,
    // so a match that just ended takes the panel down on the same frame. A
    // pregame board (battlefield pick, roll, mulligan) pops the applicable
    // goals up, a live match adds the note input, anything else removes it.
    globalThis.RATGoalNotes.observe(phase, capture().current());
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
        if (globalThis.RATPageUI.isOrphaned()) {
          globalThis.RATPageUI.showOrphanBanner();
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
        // Both scores live on the board root now, so a point scored is an
        // attribute change here and nowhere else. Without these the only thing
        // that would notice a win is the three-second poll.
        "data-viewer-score",
        "data-opponent-score",
        // The track fallback's markers, for the day the root stops carrying
        // the scores: data-active is the one both tracks write, aria-pressed
        // only ever appears on the track you can click.
        "data-active",
        "aria-pressed",
        "class",
      ],
    });
    // Safety net: periodic scan in case mutations are missed, plus a
    // dirty-save so the in-progress match is always persisted.
    setInterval(() => {
      if (globalThis.RATPageUI.isOrphaned()) {
        globalThis.RATPageUI.showOrphanBanner();
        return;
      }
      try {
        tick(null);
        capture().saveIfDirty();
        globalThis.RATDeckCards.persist(false);
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
     * Only when a match is still live - which `flushOnUnload` decides. The
     * recorder's own pagehide handler exists solely during the settle window
     * after an "end" stop, the window where it is waiting to catch the victory
     * modal, and stopping it from here would file a finished recording as
     * "stopped" and cost it that last frame. While a match IS live there is no
     * such handler at all, so without this call the tab closes with the batch
     * unflushed and the replay stays "recording", incomplete, forever. */
    window.addEventListener("pagehide", () => capture().flushOnUnload());
    // The deck picker and the lobby live on the site's own pages, which produce
    // none of the board mutations we filter for, so they get a standing poll of
    // their own rather than riding on the observer. A couple of selector
    // lookups per tick when neither is on screen, which is most of the time.
    globalThis.RATDeckScan.load();
    globalThis.RATMatchFormat.load();
    globalThis.RATDeckScan.watch();
    globalThis.RATMatchFormat.watch();
    setInterval(() => {
      // Not while a match is live: the deck and format for this game are
      // already decided, and letting either drift now would only let something
      // the player glanced at overwrite what they actually played.
      if (globalThis.RATPageUI.isOrphaned() || capture().current()) return;
      try {
        globalThis.RATDeckScan.watch();
        globalThis.RATMatchFormat.watch();
      } catch (_) {}
    }, DECK_POLL_MS);
    // A deck name typed in the dashboard while the game is still running would
    // otherwise be undone by the next periodic save of the in-memory record.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes.matches) return;
        capture().onMatchesChanged(changes.matches.newValue, changes.matches.oldValue);
      });
    } catch (_) {}
    console.info("[RA-Tracker] active");
  }

  boot();
})();
