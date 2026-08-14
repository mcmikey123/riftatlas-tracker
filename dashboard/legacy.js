/* Rift Atlas Stats Tracker - dashboard */
(() => {
  "use strict";

  // `all` holds LEAN match records: game logs live in log_<id> keys and the
  // cards you played in deckcards_<id> keys, so the array rewritten during
  // live games stays ~0.5 KB per match instead of ~21 KB.
  let all = [];
  const logCache = new Map(); // id -> log[]
  // When viewing an archive file we render from memory and never write.
  let archive = null; // { name, matches, deckCards }

  const STORE = window.RATrackerStorage;
  const SERIES = window.RATrackerSeries;
  /* Sharing, in four files loaded before this one. This side keeps what they
   * cannot see: the match array behind a share's label, the replay reader, and
   * the render that puts a panel where it was asked for. The fourth,
   * share-moment.js, is now reached only by the Replays view. */
  const SHARE_PANEL = window.RATrackerSharePanel;
  const SHARE_PIPELINE = window.RATrackerSharePipeline;
  const SHARES_VIEW = window.RATrackerSharesView;
  /* The views drained out of this file, each loaded before it. They render
   * their own markup and listen for their own attributes; what they cannot see
   * is the match array, the archive, and when a paint is due, so those are
   * handed to them by the mount calls further down. */
  const OVERVIEW = window.RATrackerViewOverview;
  const REPLAYS = window.RATrackerViewReplays;
  const DECKS = window.RATrackerDeckLabelling;
  const DATA_IO = window.RATrackerDataIo;
  const BACKUPS = window.RATrackerBackups;
  const CAPTURE_SETTINGS = window.RATrackerSettingsCapture;
  const analyse = (m) => window.RATrackerAnalysis.analyse(m);
  const $ = (s) => document.querySelector(s);
  const readOnly = () => archive !== null;

  /* Opening or closing an archive is the one thing that decides whether the
   * array in memory is this browser's history or a file's. The writer refuses
   * every match write while it is a file's, so the two must never disagree -
   * hence one setter rather than four assignments. */
  function setArchive(next) {
    archive = next;
    STORE.setReadOnly(next !== null);
  }

  /* The match store, as it stands: the array, the archive, the log cache and
   * the one write, handed over whole rather than as eight separate callbacks.
   * Data goes in and out of it from another file now, and this is the seam a
   * matches-store.js would be cut along - so it is named once here instead of
   * being spelled out at each mount. */
  const store = {
    matches: () => all,
    setMatches: (next) => {
      all = next;
    },
    readOnly,
    archive: () => archive,
    setArchive,
    clearLogs: () => logCache.clear(),
    cacheLog: (id, log) => logCache.set(id, log),
    persist: (matches, then) => persist(matches, then),
  };

  /* THIS FILE IS BEING DRAINED. The redesign replaces its markup one view at a
   * time, so every element this file reaches for may already be gone - and a
   * bare `$("#x").addEventListener(...)` on a missing element throws during the
   * initial run, which aborts the whole IIFE and takes `load()` and the storage
   * listener at the bottom with it. Not degraded: dead, silently, for every
   * feature still living here.
   *
   * So nothing below dereferences a query result directly. What is left of that
   * idiom is the filter row's three <select>s; the accessors it needed went out
   * with the views that used them, and each drained file carries its own. */

  /* The dialog and the toast are ES modules, published on window by main.js
   * because a classic script cannot import one - notify.js is how the drained
   * views reach them, and how this file does. */
  const { ask, dialog: DIALOG } = window.RATrackerNotify;

  // ---- data access -----------------------------------------------------

  function load() {
    if (archive) {
      all = archive.matches.map((m) => {
        const lean = Object.assign({}, m);
        delete lean.log;
        return lean;
      });
      archive.matches.forEach((m) => logCache.set(m.id, m.log || []));
      all.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
      repaint();
      return;
    }
    chrome.storage.local.get({ matches: [] }, (data) => {
      const raw = data.matches || [];
      const clean = raw.filter((m) => m && m.id);
      /* MIGRATION (inline logs -> log_<id> keys). Runs automatically; nobody is
       * ever asked to move their own data. It is deliberately NOT gated on a
       * "done" flag, and the scan below is what makes it self-healing: a record
       * that still carries a log gets one written out, whenever it turns up and
       * however it got there.
       *
       * A flag would save one filter over an array this same function already
       * sorts and re-renders, and would buy a silent data-loss path with it -
       * `delete m.log` a few lines down runs either way, so any record the flag
       * caused to be skipped would lose its log in memory and then on the next
       * write of the array.
       *
       * Removable once no installation can still hold an inline log - it
       * predates this repo's history, so the cutoff is a release that declines
       * to upgrade from before the split rather than a date. Dropping it means
       * dropping this block and the `delete` below together. */
      const inline = clean.filter((m) => Array.isArray(m.log) && m.log.length);
      if (inline.length) {
        const writes = {};
        inline.forEach((m) => {
          writes["log_" + m.id] = { id: m.id, log: m.log };
          logCache.set(m.id, m.log);
        });
        clean.forEach((m) => delete m.log);
        writes.matches = clean;
        STORE.writeKeys(writes);
        console.info("[RA-Tracker] migrated %d inline logs to separate keys", inline.length);
      } else if (clean.length !== raw.length) {
        STORE.writeMatches(clean);
      }
      clean.forEach((m) => delete m.log);
      all = clean.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
      repaint();
      BACKUPS.refresh();
      CAPTURE_SETTINGS.refresh();
      SHARE_PIPELINE.loadEndpoint();
      SHARES_VIEW.refresh();
      dropLegacyReplays();
    });
  }

  // Board snapshots (replay_<id>) fed the step-through replay, which no longer
  // exists, and deck fingerprinting now reads deckcards_<id> instead. Nothing
  // can read the old keys any more, so the first dashboard open after the
  // upgrade reclaims the ~430 KB per match they were holding.
  let legacyReplaysDropped = false;
  function dropLegacyReplays() {
    if (legacyReplaysDropped || readOnly()) return;
    legacyReplaysDropped = true;
    chrome.storage.local.get(null, (data) => {
      const keys = Object.keys(data || {}).filter((k) => k.startsWith("replay_"));
      if (!keys.length) return;
      STORE.removeKeys(keys, () =>
        console.info("[RA-Tracker] removed %d obsolete snapshot replays", keys.length)
      );
    });
  }

  function persist(matches, then) {
    if (readOnly()) return;
    STORE.writeMatches(matches, then || render);
  }

  function getLog(id, cb) {
    if (logCache.has(id)) return cb(logCache.get(id));
    if (archive) {
      logCache.set(id, []);
      return cb([]);
    }
    const key = "log_" + id;
    chrome.storage.local.get(key, (r) => {
      const log = (r && r[key] && r[key].log) || [];
      logCache.set(id, log);
      cb(log);
    });
  }

  // ---- rendering -------------------------------------------------------

  function buildFilterOptions() {
    fillSelect($("#fMyChampion"), [...new Set(all.map((m) => champ(m.myChampion || m.myLegend)))]);
    fillSelect($("#fMode"), [...new Set(all.map((m) => m.mode).filter(Boolean))]);
    fillSelect($("#fDeck"), [...new Set(all.map(deckOf))]);
  }

  // Every deck name in use, which is what the per-match picker offers.
  const deckNames = () =>
    [...new Set(all.map((m) => (m.deckName || "").trim()).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b)
    );

  // Sentinel option value: picking it asks for a name instead of setting one.
  // The leading space keeps it distinct: stored names are always trimmed, so
  // no real deck can collide with it.
  const NEW_DECK = " new";

  /**
   * The per-match deck picker. A plain <select> of the decks you already have
   * - the common case is "one of these again" - with one entry that prompts
   * for a new name, so a custom name is always one click away.
   */

  function fillSelect(sel, values) {
    if (!sel) return;
    const current = sel.value;
    sel.length = 1;
    values.sort().forEach((v) => sel.add(new Option(v, v)));
    sel.value = current;
  }

  /* What every write of the match array ends with. A new or changed deck name
   * has to reach the filter row's picker as well as the tables, and the two
   * were spelled out side by side at seven call sites - one of which is now in
   * another file and takes this as its `repaint`. */
  const repaint = () => {
    buildFilterOptions();
    render();
  };

  /* One paint of the whole page, in the order the views sit in it. Each view
   * owns its own markup; what is left here is the order and the array they are
   * all drawn from. */
  function render() {
    OVERVIEW.renderOverview();
    REPLAYS.ensureVisualIds();
    REPLAYS.renderPanel();
    SHARES_VIEW.renderPanel();
    OVERVIEW.renderArchiveBanner();
    if (bridge.onRender) bridge.onRender();
  }

  /* The bridge to the module half, for as long as this file still owns data the
   * shell needs to describe: the match array behind the nav counts, the replay
   * figures behind the capture card, and whether an archive is open.
   *
   * Deliberately getters rather than a snapshot - `all` is reassigned wholesale
   * by load(), so anything holding the array itself would be reading a
   * discarded one within a second of an archive being opened. Every entry here
   * disappears as its view is ported. */
  const bridge = {
    matches: () => all,
    visualRecords: REPLAYS.records,
    visualAssets: REPLAYS.assets,
    keepMatches: REPLAYS.keepCount,
    shares: () => SHARES_VIEW.list(),
    readOnly,
    onRender: null, // main.js sets this

    /* What the ported views still need from this file. Each of these goes when
     * the subsystem behind it is ported.
     *
     * These are forwarded rather than dropped: the views ask
     * this bridge for everything, and pointing them at a second global would
     * spread the seam rather than move it. They go when the Matches view stops
     * needing a panel drawn by someone else.
     *
     * The views render markup carrying the SAME data-* attributes this file
     * and share-pipeline.js already listen for, and the listeners are
     * document-level - so a row drawn by a module is driven by those handlers
     * without either side knowing about the other. */
    hasVisual: (id) => REPLAYS.hasVisual(id),
    shareOpenHas: (id) => SHARE_PANEL.isOpen(id),
    shareBoxInner: (id) => SHARE_PANEL.shareBoxInner(id),
    deckNames,
    // The log is loaded lazily and cached. Returns null when it has not been
    // fetched yet, and starts fetching - the caller re-renders when it lands.
    logFor: (id) => {
      if (logCache.has(id)) return logCache.get(id);
      getLog(id, () => render());
      return null;
    },
    analyse: (m) => analyse(m),
    render: () => render(),
  };
  window.RATrackerLegacy = bridge;

  // What the filter row's two grouped <select>s are filled from.
  const { champ, deckOf } = window.RATrackerFormat;

  // ---- reading a replay -------------------------------------------------

  /* Reading a replay does not go through the service worker.
   *
   * get() rehydrates every stored stylesheet back into every keyframe, so a
   * 3.72 MB record became a >64 MiB reply - past the hard ceiling on a
   * chrome.runtime.sendMessage payload - and the match would not open at all.
   * The snapshot cadence has since cut keyframe counts by roughly an order of
   * magnitude, which lowers the multiplier without moving the ceiling: match
   * length is unbounded and nothing warns before it is crossed again.
   * The dashboard is the same origin as the worker, so it opens the same
   * IndexedDB directly and nothing large has to cross a message boundary at
   * all. Writes stay with the worker: the recorder lives in a content script
   * and the worker is the only thing it can talk to.
   *
   * Only `decompress` is supplied. The write-side dependencies are missing on
   * purpose - start/append/stop would throw here rather than quietly write
   * behind the back of the worker that believes it owns the recording. */
  const replayReader = window.RATrackerReplayStore.createReplayStore({
    idb: window.RATrackerIdb,
    decompress: async (data) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const piped = new Response(bytes).body.pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(piped).arrayBuffer());
    },
  });

  const readReplay = (matchId) => replayReader.get(matchId);

  // ---- events ----------------------------------------------------------

  /* Sharing registers two document-level click listeners of its own, for the
   * seven attributes that used to be branches of the one below. They are
   * mounted HERE rather than at each module's load, because both need something
   * only this file has - a replay reader, a render, the match array - and
   * because where they sit among the page's listeners matters:
   *
   *   ahead of view-matches.js's `[data-share]` branch, which expands a
   *   collapsed row so the panel the toggle opens has somewhere to be drawn.
   *   That holds because these are classic scripts and that one is a deferred
   *   module, and it keeps holding as long as they are mounted from one.
   *
   * Their order against the listener below is immaterial: no click carries an
   * attribute from both sides, and every branch returns. */
  SHARE_PIPELINE.mount({ readReplay, render: () => render() });
  SHARES_VIEW.mount({
    matchById: (id) => all.find((m) => m.id === id) || null,
    readOnly,
  });

  /* The drained views, mounted from here for the same two reasons: each needs
   * something only this file has, and each of their branches used to be a
   * branch of the listener below - mounting them here keeps them ahead of it,
   * and ahead of view-matches.js's deferred module, exactly where they were. */
  OVERVIEW.mount({
    matches: () => all,
    readOnly,
    archive: () => archive,
    render: () => render(),
  });
  REPLAYS.mount({
    matches: () => all,
    readOnly,
    render: () => render(),
    readReplay,
  });
  DECKS.mount({ matches: () => all, readOnly, repaint });
  DATA_IO.mount({ store, repaint, reload: () => load() });
  BACKUPS.mount({ matches: () => all, readOnly });
  CAPTURE_SETTINGS.mount();

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.classList?.contains("result-edit")) {
      if (readOnly()) return;
      const id = t.dataset.id;
      const m = all.find((x) => x.id === id);
      if (m) {
        m.result = t.value;
        m.resultSource = "manual";
        persist(all);
      }
      return;
    }
    const deckId = t.dataset?.deck;
    if (deckId) {
      if (readOnly()) return;
      const m = all.find((x) => x.id === deckId);
      if (!m) return;
      if (t.value !== NEW_DECK) return setDeckName(m, t.value);
      DIALOG()
        .textPrompt({
          title: "Name this deck",
          body: "<p>A name you type is yours: nothing will overwrite it, even mid-game.</p>",
          label: "Deck name",
          value: m.deckName || "",
          placeholder: "e.g. Hollowmark Aggro",
          confirmLabel: "Save name",
          validate: (v) => (v.trim() ? null : "Give the deck a name, or cancel."),
        })
        .then((typed) => {
          // Cancelled: put the picker back where it was rather than leaving it
          // showing the "new name" entry.
          if (typed === null || !typed.trim()) return render();
          // Re-resolved by id: the array may have been replaced while the
          // dialog was open, and mutating the old object would write nothing.
          const fresh = all.find((x) => x.id === deckId);
          if (fresh) setDeckName(fresh, typed);
        });
      return;
    }
    /* The date controls repaint this side too. The module half wires them to
     * its own emit(), which redraws Matches and Series but never calls back in
     * here - so before this, changing the range moved those two tables and left
     * the Overview showing all-time numbers. */
    if (
      ["fMyChampion", "fMode", "fDeck", "fUnknown", "fDates", "fFrom", "fTo"].includes(t.id)
    ) {
      render();
    }
  });

  /** Name a match's deck by hand, from either deck picker. */
  function setDeckName(m, name) {
    m.deckName = name.trim();
    // Marked manual either way: clearing it is a decision too, and it stops the
    // tracker re-detecting a name onto a match that is still running.
    m.deckSource = "manual";
    // A new name has to reach every other row's picker, not just the tables.
    STORE.writeMatches(all, repaint);
    // Remember it so new matches default to this deck.
    if (m.deckName) {
      STORE.getSettings((s) => {
        s.lastDeck = m.deckName;
        STORE.setSettings(s);
      });
    }
  }

  const noteTimers = new Map();
  document.addEventListener("input", (e) => {
    const id = e.target?.dataset?.notes;
    if (!id || readOnly()) return;
    const value = e.target.value;
    const state = document.querySelector(`[data-savestate="${CSS.escape(id)}"]`);
    if (state) state.textContent = "saving…";
    clearTimeout(noteTimers.get(id));
    noteTimers.set(
      id,
      setTimeout(() => {
        const m = all.find((x) => x.id === id);
        if (!m) return;
        m.notes = value;
        STORE.writeMatches(all, () => {
          if (state) {
            state.textContent = "saved";
            setTimeout(() => (state.textContent = ""), 1500);
          }
        });
      }, 500)
    );
  });

  document.addEventListener("click", (e) => {
    /* The expander moved to view-matches.js with the row it opens, and the open
     * set with it, so a branch here would only fire a second render for the
     * same click. */

    /* The share panel, the shares list and "copy a link to this moment" have
     * moved out - share-pipeline.js and shares-view.js listen for their own
     * seven attributes, mounted above. */
    const logBtn = e.target?.closest?.("[data-log]");
    if (logBtn) {
      const box = document.querySelector(`[data-logbox="${CSS.escape(logBtn.dataset.log)}"]`);
      if (box) {
        box.hidden = !box.hidden;
        // Only the caret, never the button's whole contents: the label beside
        // it is part of the same button.
        const caret = logBtn.querySelector("span");
        if (caret) caret.textContent = box.hidden ? "▸" : "▾";
      }
      return;
    }
    const del = e.target?.dataset?.del;
    if (del && !readOnly()) {
      ask({
        title: "Delete this match?",
        body:
          "<p>The match record, its game log, its card list and its replay all go. " +
          "This cannot be undone, and an export taken earlier is the only way back.</p>",
        confirmLabel: "Delete",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        const gone = all.find((x) => x.id === del);
        all = all.filter((x) => x.id !== del);
        /* A HAND-MADE series is stored, so deleting one of its games leaves a
         * hole no later pass closes - detection rebuilds automatic groupings
         * only and steps around manual ones by design. Renumbering here is what
         * stops a surviving pair reading G1 and G3, and dissolves a series left
         * with a single game rather than leaving it wearing a G1 badge. */
        if (gone && gone.seriesId) all = SERIES.renumber(all, gone.seriesId);
        logCache.delete(del);
        STORE.removeKeys(["deckcards_" + del, "log_" + del]);
        REPLAYS.forgetVisual(del);
        persist(all, repaint);
      });
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (archive) return; // never let live writes disturb an archive view
    const busy = document.activeElement?.dataset;
    if (changes.matches && !busy?.notes && !busy?.deck) {
      /* A dialog no longer blocks the event loop the way confirm() did, so a
       * reload arriving mid-decision would replace `all` with fresh objects -
       * and any target list captured before the dialog would then be mutating
       * records that are no longer in the array being saved. The reload is
       * parked until the dialog closes, which restores what the native modals
       * gave for free.
       *
       * The activeElement check above cannot cover this: with a modal open the
       * active element is the dialog's own button, not a notes or deck field. */
      const dlg = window.RATrackerDialog;
      if (dlg && dlg.isOpen()) dlg.defer(load);
      else load();
    }
    // A share created in the row above writes this key, so the list picks the
    // new link up without a reload.
    if (changes.shares) SHARES_VIEW.refresh();
    /* Settings are re-read by the files that hold a mirror of them - data-io.js
     * decorates every export from one - each on this same event, and none of
     * them from here. */
  });

  load();
})();
