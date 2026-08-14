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
   * the render that puts a panel where it was asked for. */
  const SHARE_PANEL = window.RATrackerSharePanel;
  const SHARE_PIPELINE = window.RATrackerSharePipeline;
  const SHARE_MOMENT = window.RATrackerShareMoment;
  const SHARES_VIEW = window.RATrackerSharesView;
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

  /* THIS FILE IS BEING DRAINED. The redesign replaces its markup one view at a
   * time, so from here on every element this file reaches for may already be
   * gone - and a bare `$("#x").addEventListener(...)` on a missing element
   * throws during the initial run, which aborts the whole IIFE and takes
   * `load()` and the storage listener at the bottom with it. Not degraded:
   * dead, silently, for every feature still living here.
   *
   * So nothing below dereferences a query result directly. Each helper is a
   * no-op when its element has already been ported, which is what lets each
   * phase of the port ship on its own. */
  const on = (sel, type, fn) => {
    const el = $(sel);
    if (el) el.addEventListener(type, fn);
    return el;
  };
  const val = (sel) => {
    const el = $(sel);
    return el ? el.value : "";
  };
  const isChecked = (sel) => {
    const el = $(sel);
    return !!(el && el.checked);
  };
  const setText = (sel, s) => {
    const el = $(sel);
    if (el) el.textContent = s;
  };
  const setHtml = (sel, s) => {
    const el = $(sel);
    if (el) el.innerHTML = s;
  };
  /* The dialog and toast components are ES modules, published on window by
   * main.js because a classic script cannot import one. Every call below runs
   * from an event handler, so they are always present by then - but the
   * fallbacks keep this file honest if it is ever loaded on its own. */
  const DIALOG = () => window.RATrackerDialog;
  const say = (message, kind) => {
    const t = window.RATrackerToast;
    if (t) t(message, { kind });
    else console.info("[RA-Tracker]", message);
  };
  const ask = (opts) => DIALOG().confirm(opts);

  const hideBackupBanner = () => {
    const el = $("#backupBanner");
    if (el) el.hidden = true;
  };

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
      buildFilterOptions();
      render();
      return;
    }
    chrome.storage.local.get({ matches: [] }, (data) => {
      const raw = data.matches || [];
      const clean = raw.filter((m) => m && m.id);
      // Migrate any legacy inline logs out into their own keys, once.
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
      buildFilterOptions();
      render();
      refreshBackupUI();
      refreshVisualSettingsUI();
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

  // Which matches have a visual recording, and what each one cost. Asked once
  // for the whole history - never per row - and null until the service worker
  // has answered. The same reply feeds the Visual buttons and the diagnostics
  // panel, so opening the dashboard costs one query, not two.
  let visualIds = null;
  let visualRecords = [];
  let visualAssets = { count: 0, bytes: 0 };
  // Mirrors the retention setting, so the panel can project what keeping that
  // many matches costs. Refreshed by refreshVisualSettingsUI.
  let keepMatches = 25;

  function ensureVisualIds() {
    // Set before the reply lands, so a re-render can't fire a second query.
    if (visualIds !== null || archive) return;
    visualIds = new Set();
    chrome.runtime.sendMessage({ type: "ra:visual:list" }, (reply) => {
      if (chrome.runtime.lastError || !reply || !reply.ok) return;
      visualRecords = (reply.replays || []).filter((r) => r && r.matchId);
      visualAssets = reply.assets || visualAssets;
      renderVisualPanel();
      const ids = visualRecords.filter((r) => r.chunkCount > 0).map((r) => r.matchId);
      if (!ids.length) return;
      visualIds = new Set(ids);
      render();
    });
  }

  const hasVisual = (id) => !readOnly() && visualIds !== null && visualIds.has(id);

  /* Deleting a match here has to reach the service worker's IndexedDB too: the
   * visual recording is the match's own markup, opponent name and chat included,
   * and once the match record is gone nothing in the dashboard can reach or show
   * it again. The local state is dropped immediately so the panel and the Visual
   * buttons match what was just deleted, without waiting for a re-list. */
  function forgetVisual(matchId) {
    chrome.runtime.sendMessage({ type: "ra:visual:delete", matchId }, () => {
      void chrome.runtime.lastError; // the tracker carries on either way
    });
    if (visualIds) visualIds.delete(matchId);
    visualRecords = visualRecords.filter((r) => r.matchId !== matchId);
    renderVisualPanel();
  }

  /** Wipe every visual recording, for the two clear-everything paths. */
  function forgetAllVisual() {
    chrome.runtime.sendMessage({ type: "ra:visual:clear" }, () => {
      void chrome.runtime.lastError;
    });
    visualIds = new Set();
    visualRecords = [];
    visualAssets = { count: 0, bytes: 0 };
    renderVisualPanel();
  }

  // The file format, both halves of it: the envelope an export is written into
  // and the reader an import comes back through. Pure, so it is tested.
  const BUNDLE = window.RATrackerBundle;
  const { csvCell, parseBundle } = BUNDLE;

  /** Full portable bundle: matches with logs inline, optionally card codes. */
  /* The match array with its series fields filled in. Reads the same settings
   * the dashboard renders with, so an export describes the series the user was
   * actually looking at. */
  function withSeries(matches) {
    const SERIES = window.RATrackerSeries;
    if (!SERIES) return matches;
    return SERIES.detect(matches, {
      enabled: seriesSettings.seriesDetect !== false,
      format: seriesSettings.seriesFormatDefault,
    }).matches;
  }

  function buildBundle(includeCards, cb) {
    if (archive) {
      return cb(
        BUNDLE.bundleFrom({
          exportedAt: new Date().toISOString(),
          matches: archive.matches,
          deckCards: includeCards ? archive.deckCards || {} : {},
        })
      );
    }
    chrome.storage.local.get(null, (data) => {
      /* Automatic series are worked out at render time and never written, so
       * an export has to compute them too - otherwise a backup carries only
       * the groupings made by hand and every detected series is lost on
       * import. The manual ones are already on the records and pass through
       * detect() untouched. */
      cb(
        BUNDLE.bundleFrom({
          exportedAt: new Date().toISOString(),
          matches: BUNDLE.inlineLogs(withSeries(all), data),
          deckCards: includeCards ? BUNDLE.deckCardsFrom(all, data) : {},
        })
      );
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

  /* The filter row sits above every view and says so: "Filters apply to every
   * view". The date range was the one control this side never read, so picking
   * "Last 7 days" narrowed the Matches table and left every Overview tile and
   * all three aggregate tables showing all-time numbers - under that note.
   *
   * The controls are read here rather than from the module half's `state`,
   * because state.js is an ES module and this is a classic script: there is no
   * global to reach it through. RATrackerTable is on the global, and owns the
   * same range arithmetic the Matches table uses, so both sides answer the
   * question the same way. */
  function filtered(includeUnknownAnyway) {
    const mc = val("#fMyChampion");
    const mode = val("#fMode");
    const deck = val("#fDeck");
    const inclUnknown = includeUnknownAnyway || isChecked("#fUnknown");
    const rows = all.filter((m) => {
      if (mc && champ(m.myChampion || m.myLegend) !== mc) return false;
      if (deck && deckOf(m) !== deck) return false;
      if (mode && m.mode !== mode) return false;
      if (!inclUnknown && (m.result === "unknown" || !m.result)) return false;
      return true;
    });
    const T = window.RATrackerTable;
    if (!T) return rows;
    return T.inRange(
      rows,
      { preset: val("#fDates") || "all", from: val("#fFrom"), to: val("#fTo") },
      "startedAt"
    );
  }

  function render() {
    const rows = filtered(false);
    const wins = rows.filter((m) => m.result === "win").length;
    const losses = rows.filter((m) => m.result === "loss").length;
    const decided = wins + losses;
    setText("#tGames", rows.length);
    setText("#tWins", wins);
    setText("#tLosses", losses);
    setText("#tWinrate", decided ? Math.round((wins / decided) * 100) + "%" : "–");
    // 57% of 207 and 57% of 7 are not the same claim, so the tile carries its
    // own denominator.
    setText("#tDecided", decided ? `of ${decided} decided` : "");

    const durations = rows.map((m) => m.durationMs).filter((d) => Number.isFinite(d) && d > 0);
    setText(
      "#tDuration",
      durations.length ? fmtDuration(durations.reduce((a, b) => a + b, 0) / durations.length) : "–"
    );

    renderAgg($("#vsTable tbody"), rows, (m) => champ(m.opponentChampion || m.opponentLegend));
    renderAgg($("#deckTable tbody"), rows, deckOf);
    renderAgg($("#myTable tbody"), rows, (m) => champ(m.myChampion || m.myLegend));
    ensureVisualIds();
    renderVisualPanel();
    SHARES_VIEW.renderPanel();
    renderArchiveBanner();
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
    visualRecords: () => visualRecords,
    visualAssets: () => visualAssets,
    keepMatches: () => keepMatches,
    shares: () => SHARES_VIEW.list(),
    readOnly,
    onRender: null, // main.js sets this

    /* What the ported views still need from this file. Each of these goes when
     * the subsystem behind it is ported: hasVisual belongs to the replay
     * diagnostics, which is the largest thing still living here.
     *
     * The two share entries are forwarded rather than dropped: the views ask
     * this bridge for everything, and pointing them at a second global would
     * spread the seam rather than move it. They go when the Matches view stops
     * needing a panel drawn by someone else.
     *
     * The views render markup carrying the SAME data-* attributes this file
     * and share-pipeline.js already listen for, and the listeners are
     * document-level - so a row drawn by a module is driven by those handlers
     * without either side knowing about the other. */
    hasVisual: (id) => hasVisual(id),
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

  function renderArchiveBanner() {
    const b = $("#archiveBanner");
    if (!b) return;
    b.hidden = !archive;
    if (archive) {
      setText(
        "#archiveBannerText",
        `Viewing archive “${archive.name}” — ${archive.matches.length} matches, read-only. Your live data is untouched.`
      );
      const nag = $("#backupBanner");
      if (nag) nag.hidden = true; // not about the archive you're viewing
    }
    document.body.classList.toggle("read-only", readOnly());
  }

  /* How many rows an aggregate table shows before it offers "see all".
   *
   * Nothing is hidden silently: the footer states the true total and expanding
   * is one click, in place. The cap exists because a long tail of one-game
   * opponents pushes the rows that carry weight off the screen. */
  const AGG_LIMIT = 8;
  const aggExpanded = new Set();

  /* Four steps of one hue. The break points are quarters of the range rather
   * than anything about good or bad: this encodes magnitude, not judgement. */
  const rateStep = (rate) => (rate >= 0.75 ? 4 : rate >= 0.5 ? 3 : rate >= 0.25 ? 2 : 1);

  function renderAgg(tbody, rows, keyFn) {
    if (!tbody) return;
    const table = tbody.closest("table");
    const key = table ? table.id : "";
    const agg = new Map();
    for (const m of rows) {
      const k = keyFn(m);
      const a = agg.get(k) || { games: 0, w: 0, l: 0 };
      a.games++;
      if (m.result === "win") a.w++;
      if (m.result === "loss") a.l++;
      agg.set(k, a);
    }
    if (!agg.size) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No matches recorded yet.</td></tr>';
      return;
    }

    const all = [...agg.entries()].sort((a, b) => b[1].games - a[1].games);
    const open = aggExpanded.has(key);
    const shown = open ? all : all.slice(0, AGG_LIMIT);

    tbody.innerHTML =
      shown
        .map(([name, a]) => {
          const decided = a.w + a.l;
          const rate = decided ? a.w / decided : null;
          const pct = rate === null ? 0 : Math.round(rate * 100);
          // An unnamed deck is a hint, not a deck whose name is "Unlabelled".
          const unlabelled = name === "Unlabelled";
          const label = unlabelled ? "— unlabelled —" : esc(name);
          return `<tr>
          <td class="${unlabelled ? "unlabelled" : ""}">${label}</td>
          <td>${a.games}</td><td>${a.w}</td><td>${a.l}</td>
          <td><div class="bar-wrap"><div class="bar-track">${
            // No decided results: an empty track and a dash. A zero-width bar
            // at 0% would read as "lost them all".
            rate === null ? "" : `<div class="bar rate-${rateStep(rate)}" style="width:${pct}%"></div>`
          }</div><span class="pct">${rate === null ? "–" : pct + "%"}</span></div></td>
        </tr>`;
        })
        .join("") +
      (all.length > AGG_LIMIT
        ? `<tr><td colspan="5" class="agg-more">Showing ${shown.length} of ${all.length}
             <button data-aggmore="${esc(key)}">${open ? "show fewer" : "see all"}</button></td></tr>`
        : "");
  }


  // Every "not recorded" in this file goes through fmtCount/fmtMs, which carry
  // the dash themselves.
  const { esc, champ, fmtDuration, deckOf, fmtBytes, fmtCount, fmtMs } =
    window.RATrackerFormat;

  // ---- visual replay diagnostics ---------------------------------------

  /* What each record says about itself - which counters were measured, what
   * its state means in words, and whether it can be played at all. Pure over
   * one record, so it is tested rather than trusted; the markup around it is
   * what stays here. `visualLabel` takes the match rather than finding it,
   * because `all` is this file's state and not the decision's input. */
  const PANEL = window.RATrackerReplayPanel;
  const { statOf, sumStat, visualStateCell, playable } = PANEL;
  const visualLabel = (record) =>
    PANEL.visualLabel(record, all.find((x) => x.id === record.matchId) || null);

  /* The match label opens the replay. It is the thing on the row that names a
   * match, so it is what a reader reaches for - and the modal is already one
   * click away from Matches, so this is a shortcut rather than a new power. */
  /* No approved glyph exists for "share", and an emoji renders differently on
   * every platform - so an inline SVG, shipped in the repo, which is what the
   * design asks for when a character will not do. currentColor so it follows
   * the button's own hover state. */
  const SHARE_MARK =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'd="M6.5 9.5a3 3 0 0 0 4.2 0l2.1-2.1a3 3 0 0 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2 0l-2.1 2.1' +
    'a3 3 0 0 0 4.2 4.2l1-1"/></svg>';

  function visualRow(record) {
    const label = esc(visualLabel(record));
    const id = esc(record.matchId);
    const open = SHARE_PANEL.isOpen(record.matchId);
    return `<tr>
        <td>${
          playable(record)
            ? `<button class="vd-open" data-visual="${id}"
                       title="Play this replay">${label}</button>
               <button class="vd-icon ${open ? "on" : ""}" data-share="${id}"
                       aria-label="Share a link to this replay"
                       title="Turn this replay into an encrypted link anyone can open">${SHARE_MARK}</button>`
            : label
        }</td>
        <td>${fmtBytes(record.compressedBytes)}</td>
        <td>${fmtCount(record.chunkCount)}</td>
        <td>${fmtCount(statOf(record, "keyframes"))}</td>
        <td>${fmtBytes(statOf(record, "meanDeltaBytes"))}</td>
        <td>${fmtMs(statOf(record, "captureP50Ms"))}</td>
        <td>${fmtMs(statOf(record, "captureMaxMs"))}</td>
        ${visualStateCell(record)}
        <td class="vd-actions"><button class="vd-icon vd-del" data-visualdel="${id}"
              aria-label="Delete this recording"
              title="Delete this recording. The match itself is kept.">✕</button></td>
      </tr>${
        // The share panel is one component with one state per match id, so the
        // copy here and the copy in the expanded match row show the same phase.
        // It sits in its own full-width row rather than in the first cell,
        // which would drag the numeric columns out of line.
        open
          ? `<tr class="vd-share-row"><td colspan="9">
               <div class="share-box" data-sharebox="${id}">${SHARE_PANEL.shareBoxInner(record.matchId)}</div>
             </td></tr>`
          : ""
      }`;
  }

  function renderVisualPanel() {
    const panel = $("#visualPanel");
    if (!panel) return;
    const records = visualRecords.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    // An archive file holds no visual replays, so the panel would be lying.
    panel.hidden = readOnly() || !records.length;

    /* Say so, rather than rendering nothing at all. The markup for this has
     * been in the page from the start and nothing ever showed it, so with no
     * recordings the whole view was blank - no table, no message, nothing to
     * distinguish "you have none" from "this is broken". The Shared links view
     * next door has always written its own empty row; this is the same idea. */
    const empty = $("[data-empty='replays']");
    if (empty) empty.hidden = readOnly() || records.length > 0;

    if (panel.hidden) return;

    // Every record gets a row: retention is the store's job, and it never hands
    // back more than the retention setting allows.
    setHtml("#visualTable tbody", records.map(visualRow).join(""));

    const bytes = records.reduce((n, r) => n + (Number(r.compressedBytes) || 0), 0);
    const chunks = records.reduce((n, r) => n + (Number(r.chunkCount) || 0), 0);
    // What retention actually costs: every replay is captured at full fidelity,
    // so the mean is the only figure needed to price a different keep count.
    const mean = records.length ? bytes / records.length : 0;
    setHtml(
      "#visualTable tfoot",
      `
      <tr class="vd-total">
        <td>Total · ${records.length} match${records.length === 1 ? "" : "es"}</td>
        <td>${fmtBytes(bytes)}</td>
        <td>${chunks}</td>
        <td>${fmtCount(sumStat(records, "keyframes"))}</td>
        <td colspan="5"></td>
      </tr>
      <tr class="vd-total">
        <td>+ shared stylesheets · ${fmtCount(visualAssets.count)}</td>
        <td>${fmtBytes(visualAssets.bytes)}</td>
        <td colspan="7" class="vd-note">stored once by content hash, uncompressed, and shared by every match that used them</td>
      </tr>
      <tr class="vd-total">
        <td>On disk now · retained replays + shared stylesheets</td>
        <td>${fmtBytes(bytes + (Number(visualAssets.bytes) || 0))}</td>
        <td colspan="7" class="vd-note">
          ${fmtBytes(mean)} per match on average &mdash; keeping the newest ${keepMatches}
          works out at roughly ${fmtBytes(mean * keepMatches)} once that many have been played
        </td>
      </tr>`
    );
  }

  // ---- reading a replay -------------------------------------------------

  /* Why a stored replay could not be played. Decidable from the payload alone,
   * so it lives and is tested with the rest of the share taxonomy - the share
   * pipeline raises the same message from the same function when an upload
   * finds nothing to upload. */
  const { unreadableReason } = window.RAShareUI;

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
    STORE.writeMatches(all, () => {
      buildFilterOptions();
      render(); // a new name has to reach every other row's picker
    });
    // Remember it so new matches default to this deck.
    if (m.deckName) {
      getSettings((s) => {
        s.lastDeck = m.deckName;
        setSettings(s);
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
    const aggMore = e.target?.dataset?.aggmore;
    if (aggMore) {
      if (aggExpanded.has(aggMore)) aggExpanded.delete(aggMore);
      else aggExpanded.add(aggMore);
      render();
      return;
    }
    /* The expander moved to view-matches.js with the row it opens, and the open
     * set with it, so a branch here would only fire a second render for the
     * same click. */
    const visualBtn = e.target?.closest?.("[data-visual]");
    const visualId = visualBtn && visualBtn.dataset.visual;
    if (visualId) {
      const m = all.find((x) => x.id === visualId) || { id: visualId };
      readReplay(visualId).then(
        (payload) => {
          if (!payload || !payload.events || !payload.events.length) {
            say(unreadableReason(payload), "error");
            return;
          }
          window.RATrackerVisualReplay.openModal(m, payload, {
            shareMoment: (request) => SHARE_MOMENT.shareMoment(request, m),
          });
        },
        (err) => {
          // A storage fault, not an empty recording: say so, and leave the real
          // error somewhere a bug report can reach it.
          console.warn("[Rift Atlas] replay read failed:", err);
          say("The replay for this match could not be read: " + String((err && err.message) || err), "error");
        }
      );
      return;
    }
    const delReplay = e.target?.closest?.("[data-visualdel]");
    if (delReplay) {
      const matchId = delReplay.dataset.visualdel;
      // A recording being uploaded right now is the one thing that must not be
      // pulled out from under the pipeline reading it.
      if (SHARE_PIPELINE.busyWith() === matchId) {
        say("This replay is being shared right now. Wait for that to finish.", "error");
        return;
      }
      const record = visualRecords.find((r) => r.matchId === matchId);
      const size = record ? fmtBytes(record.compressedBytes) : null;
      /* Deleting a RECORDING is not deleting a match, and the wording has to
       * carry that: the match record, its game log, its result and its card
       * list all survive, which is exactly what the retention setting already
       * promises when it drops the oldest replay. */
      const shared = SHARES_VIEW.list().some((r) => r && r.matchId === matchId);
      ask({
        title: "Delete this recording?",
        sub: size ? `Frees ${size}` : undefined,
        body:
          "<p>The match itself is kept &mdash; its record, its game log, its result and its card " +
          "list are all untouched. Only the video-like replay goes.</p>" +
          "<p>It cannot be recovered. A replay is never in an export or an archive, so there is " +
          "nothing to restore it from.</p>" +
          (shared
            ? "<p>You have shared this replay. <b>Deleting your copy does not delete the share</b> " +
              "&mdash; the encrypted copy on the endpoint is served until it expires, and clearing " +
              "it here would only lose the key that opens it.</p>"
            : ""),
        confirmLabel: "Delete recording",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        forgetVisual(matchId);
        SHARE_PANEL.close(matchId);
        // The Matches view keys its replay buttons off hasVisual(), so it has
        // to be told as well as the panel this row lives in.
        render();
        say("Recording deleted. The match is still here.", "success");
      });
      return;
    }

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
    const applyId = e.target?.dataset?.deckapply;
    if (applyId && !readOnly()) {
      const src = all.find((x) => x.id === applyId);
      // The picker commits on change, so the record is already the truth.
      const name = (src?.deckName || "").trim();
      if (!name) return say("Give this match a deck name first.", "error");
      const champion = champ(src.myChampion || src.myLegend);
      const targets = all.filter(
        (m) => champ(m.myChampion || m.myLegend) === champion && !(m.deckName || "").trim()
      );
      if (!targets.length) return say(`No unlabelled ${champion} matches to update.`);
      ask({
        title: `Label ${targets.length} match${targets.length === 1 ? "" : "es"} as “${name}”?`,
        body: `<p>Every unlabelled ${esc(champion)} match takes this name, and a name applied
               here is marked manual, so detection will not overwrite it.</p>`,
        confirmLabel: `Label ${targets.length}`,
      }).then((ok) => {
        if (!ok) return;
        /* Re-resolved AFTER the dialog, by id. A dialog does not block the
         * event loop the way confirm() did, so the array captured above may
         * have been replaced by a reload while it was open - and mutating
         * those orphans would report success having written nothing. */
        const now = all.filter(
          (m) => champ(m.myChampion || m.myLegend) === champion && !(m.deckName || "").trim()
        );
        if (!now.length) return say("Those matches have already been labelled.");
        now.forEach((m) => { m.deckName = name; m.deckSource = "manual"; });
        STORE.writeMatches(all, () => {
          buildFilterOptions();
          render();
          say(`Labelled ${now.length} match${now.length === 1 ? "" : "es"} as “${name}”.`, "success");
        });
      });
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
        forgetVisual(del);
        persist(all, () => { buildFilterOptions(); render(); });
      });
    }
  });

  // ---- export / import / archive ---------------------------------------

  function download(name, content, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  // Bulk-label every unlabelled match (respecting the champion filter, so you
  // can do one champion at a time when you play several).
  on("#bulkLabel", "click", () => {
    if (readOnly()) return;
    const champFilter = val("#fMyChampion");
    const targets = all.filter(
      (m) =>
        !(m.deckName || "").trim() &&
        (!champFilter || champ(m.myChampion || m.myLegend) === champFilter)
    );
    if (!targets.length) return say("Every match already has a deck name.");
    const scope = champFilter ? `${targets.length} unlabelled ${champFilter} match` : `${targets.length} unlabelled match`;
    DIALOG()
      .textPrompt({
        title: `Name ${scope}${targets.length === 1 ? "" : "es"}`,
        sub: champFilter
          ? `Only ${champFilter} matches, because that is the champion filter you have set.`
          : "Set the My champion filter first to label one champion at a time.",
        label: "Deck name",
        confirmLabel: "Label them",
        validate: (v) => (v.trim() ? null : "Give the deck a name, or cancel."),
      })
      .then((name) => {
        const clean = (name || "").trim();
        if (!clean) return;
        // Re-resolved after the dialog: see the note on the deck-apply path.
        const now = all.filter(
          (m) =>
            !(m.deckName || "").trim() &&
            (!champFilter || champ(m.myChampion || m.myLegend) === champFilter)
        );
        if (!now.length) return say("Those matches have already been labelled.");
        now.forEach((m) => { m.deckName = clean; m.deckSource = "manual"; });
        STORE.writeMatches(all, () => {
          buildFilterOptions();
          render();
          say(`Labelled ${now.length} match${now.length === 1 ? "" : "es"} as “${clean}”.`, "success");
        });
      });
  });

  /* Name each detected group, one dialog at a time.
   *
   * This was `clusters.forEach(...)` around a native prompt, which worked only
   * because prompt() blocks. An async callback inside forEach would open every
   * dialog at once and reach the write with nothing named, so the loop has to
   * be a real `for ... of` with an await in it.
   *
   * An unnamed group is simply left unlabelled - nothing is guessed, which is
   * the same promise the undecided matches get. */
  async function nameClusters(clusters, lines) {
    const ok = await ask({
      title: `Found ${clusters.length} distinct deck${clusters.length === 1 ? "" : "s"}`,
      sub: "Grouped by the cards each game actually showed",
      body:
        "<p>You will be asked to name each group in turn. Leave one blank to skip it — " +
        "an unnamed group keeps <em>— unlabelled —</em> rather than being guessed at.</p>" +
        `<pre class="ra-dialog-summary">${esc(lines)}</pre>`,
      confirmLabel: "Name them",
    });
    if (!ok) return;

    const named = new Map();
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const name = await DIALOG().textPrompt({
        title: `Group ${i + 1} of ${clusters.length}`,
        sub: `${c.size} match${c.size === 1 ? "" : "es"} · ${c.cards} distinct cards`,
        label: "Deck name",
        placeholder: "Leave blank to skip",
        confirmLabel: i + 1 === clusters.length ? "Finish" : "Next",
      });
      const clean = (name || "").trim();
      if (clean) named.set(c, clean);
    }
    if (!named.size) return;

    let count = 0;
    for (const [c, clean] of named) {
      const ids = new Set(c.ids);
      all.forEach((m) => {
        if (!ids.has(m.id)) return;
        m.deckName = clean;
        m.deckSource = "fingerprint";
        count++;
      });
    }
    if (!count) return say("Those matches have already been labelled.");
    STORE.writeMatches(all, () => {
      buildFilterOptions();
      render();
      say(`Labelled ${count} match${count === 1 ? "" : "es"}.`, "success");
    });
  }

  // Recognise decks from the cards actually played.
  on("#autoDeck", "click", () => {
    if (readOnly()) return;
    const FP = window.RATrackerFingerprint;
    chrome.storage.local.get(null, (data) => {
      const prints = new Map();
      for (const m of all) {
        const r = data["deckcards_" + m.id];
        prints.set(m.id, FP.fingerprint(r && r.codes));
      }
      const withCards = [...prints.values()].filter((s) => s.size >= FP.MIN_CARDS).length;
      if (!withCards) {
        return DIALOG().alert({
          title: "No usable card data yet",
          body:
            "<p>Deck recognition compares the cards you actually played, so it needs matches " +
            `where at least ${FP.MIN_CARDS} of your own cards were seen on the board.</p>` +
            "<p>Play a few more matches with the extension running and try again.</p>",
        });
      }
      const { proposals, undecided, labelledCount } = FP.suggestLabels(all, prints);

      if (!labelledCount) {
        // Nothing labelled yet: group them instead and let the user name each.
        const clusters = FP.clusterDecks(all, prints);
        if (!clusters.length) return say("Not enough card data to group these matches yet.");
        const lines = clusters
          .map((c, i) => `  Group ${i + 1}: ${c.size} match${c.size === 1 ? "" : "es"} (${c.cards} distinct cards)`)
          .join("\n");
        nameClusters(clusters, lines);
        return;
      }

      if (!proposals.length) {
        return DIALOG().alert({
          title: "No confident matches found",
          sub: `${undecided.length} match${undecided.length === 1 ? "" : "es"} could not be placed`,
          body:
            "<p>Nothing is guessed: a match that sits between two decks keeps " +
            "<em>— unlabelled —</em> and can be labelled by hand in Matches.</p>" +
            "<ul>" +
            undecided.slice(0, 6).map((u) => `<li>${esc(u.reason)}</li>`).join("") +
            "</ul>",
        });
      }
      const byDeck = {};
      proposals.forEach((p) => { byDeck[p.deck] = (byDeck[p.deck] || 0) + 1; });
      const summary = Object.entries(byDeck)
        .map(([d, n]) => `  ${n} × “${d}”`)
        .join("\n");
      const avg = Math.round((proposals.reduce((a, p) => a + p.score, 0) / proposals.length) * 100);
      ask({
        title: "Decks detected from cards played",
        sub: `${proposals.length} unlabelled game${proposals.length === 1 ? "" : "s"} matched, average ${avg}% card overlap`,
        body:
          "<p>Matched against decks you have already named:</p>" +
          `<pre class="ra-dialog-summary">${esc(summary)}</pre>` +
          (undecided.length
            ? `<p>${undecided.length} left alone — too little card data, or no clear winner. ` +
              "Nothing is guessed: those keep <em>— unlabelled —</em>.</p>"
            : ""),
        summary: "Names you typed yourself are never touched.",
        confirmLabel: `Apply ${proposals.length} label${proposals.length === 1 ? "" : "s"}`,
      }).then((ok) => {
        if (!ok) return;
        const byId = new Map(proposals.map((p) => [p.match.id, p.deck]));
        // By id, so a reload during the dialog cannot leave this writing to
        // objects that are no longer in the array being saved.
        let applied = 0;
        all.forEach((m) => {
          if (!byId.has(m.id) || (m.deckName || "").trim()) return;
          m.deckName = byId.get(m.id);
          m.deckSource = "fingerprint";
          applied++;
        });
        if (!applied) return say("Those matches have already been labelled.");
        STORE.writeMatches(all, () => {
          buildFilterOptions();
          render();
          say(`Labelled ${applied} match${applied === 1 ? "" : "es"}.`, "success");
        });
      });
    });
  });

  on("#exportJson", "click", () => {
    buildBundle(true, (bundle) =>
      download(`riftatlas-matches-${stamp()}.json`, JSON.stringify(bundle, null, 2), "application/json")
    );
  });

  on("#exportCsv", "click", () => {
    buildBundle(false, (bundle) => {
      const cols = ["startedAt","endedAt","durationMs","mode","roomCode","myName","opponentName","myLegend","myChampion","opponentLegend","opponentChampion","myScore","opponentScore","turns","result","resultSource","endReason","deckName","deckSource","seriesId","seriesGame","seriesFormat","seriesSource","notes"];
      const extra = ["duration","verdict","myCommits","oppCommits","myConquers","oppConquers","myTrashed","oppTrashed","logLines"];
      const lines = [cols.concat(extra).join(",")].concat(
        bundle.matches.map((m) => {
          const a = analyse(m);
          const vals = cols.map((c) => csvCell(m[c]));
          vals.push(
            csvCell(fmtDuration(m.durationMs)), csvCell(a.verdict),
            csvCell(a.self.commit), csvCell(a.opponent.commit),
            csvCell(a.self.conquer), csvCell(a.opponent.conquer),
            csvCell(a.self.trash), csvCell(a.opponent.trash), csvCell(a.lines)
          );
          return vals.join(",");
        })
      );
      download(`riftatlas-matches-${stamp()}.csv`, lines.join("\n"), "text/csv");
    });
  });

  function writeBundleToStorage(bundle, cb) {
    chrome.storage.local.get({ matches: [] }, (data) => {
      const byId = new Map((data.matches || []).filter((m) => m && m.id).map((m) => [m.id, m]));
      const writes = {};
      for (const m of bundle.matches) {
        if (!m || !m.id) continue;
        const lean = Object.assign({}, m);
        delete lean.log;
        byId.set(m.id, lean);
        if (Array.isArray(m.log) && m.log.length) {
          writes["log_" + m.id] = { id: m.id, log: m.log };
          logCache.set(m.id, m.log);
        }
      }
      for (const [id, codes] of Object.entries(bundle.deckCards || {})) {
        if (Array.isArray(codes) && codes.length) writes["deckcards_" + id] = { id, codes };
      }
      writes.matches = [...byId.values()];
      STORE.writeKeys(writes, cb);
    });
  }

  on("#importJson", "click", () => { const f = $("#importFile"); if (f) f.click(); });
  on("#importFile", "change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        const bundle = parseBundle(text);
        writeBundleToStorage(bundle, () => {
          setArchive(null);
          logCache.clear();
          load();
          say(`Imported ${bundle.matches.length} matches into your live data.`, "success");
        });
      } catch (err) {
        say("Import failed: " + err.message, "error");
      }
    });
    e.target.value = "";
  });

  // Archive & clear: download everything, then wipe local storage.
  on("#archiveClear", "click", () => {
    if (readOnly()) return;
    if (!all.length) return say("There are no matches to archive.");
    buildBundle(true, (bundle) => {
      const json = JSON.stringify(bundle, null, 2);
      const sizeMb = (new Blob([json]).size / 1048576).toFixed(1);
      const archivedIds = new Set(bundle.matches.map((m) => m.id));
      download(`riftatlas-archive-${stamp()}.json`, json, "application/json");
      /* The 800ms wait existed because a synchronous modal fired straight after
       * a programmatic click on a blob URL could suppress the download. The
       * dialog does not block, so the reason is gone with the modal that
       * needed it. */
      ask({
        title: "Clear everything from the extension?",
        sub: `Archive downloaded — ${bundle.matches.length} matches, ${sizeMb} MB`,
        body:
          "<p>Check it is in your Downloads folder first. This then wipes every match, game " +
          "log, card list, share record and replay from the extension.</p>" +
          "<p>You can open the file again any time with <b>View archive</b>, or merge it back " +
          "with <b>Import JSON</b>.</p>" +
          "<p>The archive does not carry share links. Any share already uploaded keeps being " +
          "served until it expires, but the record here is the only copy of the key that " +
          "opens it.</p>",
        confirmLabel: "Clear everything",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        /* Anything that finished while the dialog was open is NOT in the file
         * that was just written, so clearing it would destroy the only copy.
         * The wipe is therefore limited to what the archive actually holds. */
        const stragglers = all.filter((m) => !archivedIds.has(m.id));
        chrome.storage.local.get(null, (data) => {
          // "shares" goes with the rest: each record holds a decryption key,
          // and a wipe that leaves every key a browser ever made behind is not
          // the clean slate the button offers.
          const keys = Object.keys(data || {}).filter(
            (k) =>
              k === "shares" ||
              ((k.startsWith("deckcards_") || k.startsWith("log_")) &&
                archivedIds.has(k.slice(k.indexOf("_") + 1)))
          );
          STORE.removeKeys(keys, () => {
            all = stragglers;
            logCache.clear();
            forgetAllVisual();
            STORE.writeMatches(stragglers, () => {
              buildFilterOptions();
              render();
              say(
                stragglers.length
                  ? `Cleared. ${stragglers.length} match${stragglers.length === 1 ? "" : "es"} finished after the archive was written and ${stragglers.length === 1 ? "was" : "were"} kept.`
                  : "Local data cleared. The archive file has everything.",
                "success"
              );
            });
          });
        });
      });
    });
  });

  // View archive: render a file read-only without touching stored data.
  on("#viewArchive", "click", () => {
    if (archive) {
      setArchive(null);
      logCache.clear();
      setText("#viewArchive", "View archive");
      load();
      return;
    }
    const picker = $("#archiveFile");
    if (picker) picker.click();
  });
  on("#archiveFile", "change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        const bundle = parseBundle(text);
        setArchive({ name: file.name, matches: bundle.matches, deckCards: bundle.deckCards });
        logCache.clear();
        setText("#viewArchive", "Exit archive");
        load();
      } catch (err) {
        say("Could not read archive: " + err.message, "error");
      }
    });
    e.target.value = "";
  });
  on("#archiveExit", "click", () => {
    setArchive(null);
    logCache.clear();
    setText("#viewArchive", "View archive");
    load();
  });

  on("#clearAll", "click", () => {
    if (readOnly()) return;
    ask({
      title: "Delete everything in this browser?",
      body:
        "<p>Every match, game log, card list, share record and replay, with no copy taken.</p>" +
        "<p>Any share already uploaded keeps being served until it expires, but the key that " +
        "opens it is kept only here, so clearing this leaves it unopenable rather than " +
        "deleted.</p>" +
        "<p>If you might want the data later, use <b>Archive &amp; clear</b> instead, which " +
        "saves a copy first.</p>",
      confirmLabel: "Delete everything",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      all = [];
      logCache.clear();
      forgetAllVisual();
      chrome.storage.local.get(null, (data) => {
        const keys = Object.keys(data || {}).filter(
          (k) => k === "shares" || k.startsWith("deckcards_") || k.startsWith("log_")
        );
        if (keys.length) STORE.removeKeys(keys);
      });
      persist(all, () => { buildFilterOptions(); render(); });
    });
  });

  // ---- backups ---------------------------------------------------------

  const DAY_MS = 86400000;

  // The settings shape lives in storage.js now - a second copy here would drop
  // whichever keys it had not heard about on every write it made.
  const defaultSettings = STORE.defaultSettings;
  // Mirrored so buildBundle can decorate an export without waiting on storage.
  let seriesSettings = STORE.defaultSettings;
  STORE.getSettings((s) => { seriesSettings = s; });
  const getSettings = STORE.getSettings;
  const setSettings = STORE.setSettings;

  function writeBackup(cb) {
    if (!all.length) return cb && cb(new Error("nothing to back up"));
    // Backups carry matches + logs (small); the per-match card codes are
    // excluded to keep the daily file sane - Archive & clear includes them.
    buildBundle(false, (bundle) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" })
      );
      try {
        chrome.downloads.download(
          {
            url,
            filename: `riftatlas-backups/matches-${stamp()}.json`,
            conflictAction: "overwrite",
            saveAs: false,
          },
          () => {
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            getSettings((s) => {
              s.lastBackup = Date.now();
              setSettings(s, () => { showBackupState(s); cb && cb(null); });
            });
          }
        );
      } catch (err) {
        URL.revokeObjectURL(url);
        cb && cb(err);
      }
    });
  }

  function showBackupState(s) {
    const el = $("#backupState");
    if (!el) return;
    el.textContent = s.lastBackup ? "last backup " + new Date(s.lastBackup).toLocaleDateString() : "";
  }

  function refreshBackupUI() {
    getSettings((s) => {
      chrome.permissions.contains({ permissions: ["downloads"] }, (granted) => {
        const box = $("#autoBackup");
        if (box) box.checked = !!(s.autoBackup && granted);
        showBackupState(s);
        if (s.autoBackup && granted && Date.now() - (s.lastBackup || 0) > DAY_MS) writeBackup();
        maybeShowBanner(s, granted);
      });
    });
  }

  function maybeShowBanner(s, granted) {
    const banner = $("#backupBanner");
    if (!banner) return;
    const never = !s.lastBackup;
    const stale = s.lastBackup && Date.now() - s.lastBackup > 14 * DAY_MS;
    const dismissedRecently = Date.now() - (s.bannerDismissed || 0) < 7 * DAY_MS;
    const show =
      !archive && all.length >= 3 && (never || stale) && !(s.autoBackup && granted) && !dismissedRecently;
    banner.hidden = !show;
    if (show) {
      setText(
        "#backupBannerText",
        never
        ? `You have ${all.length} matches stored only inside this extension. Removing it — or loading it from a different folder — wipes them. Save a backup.`
          : `Your last backup was ${new Date(s.lastBackup).toLocaleDateString()}. Matches since then exist only inside this extension.`
      );
    }
  }

  const requestBackupPermission = (cb) =>
    chrome.permissions.request({ permissions: ["downloads"] }, cb);

  on("#autoBackup", "change", (e) => {
    const on = e.target.checked;
    if (!on) {
      getSettings((s) => { s.autoBackup = false; setSettings(s, refreshBackupUI); });
      return;
    }
    requestBackupPermission((granted) => {
      if (!granted) {
        e.target.checked = false;
        say("Downloads permission is needed to save backup files automatically.", "error");
        return;
      }
      getSettings((s) => {
        s.autoBackup = true;
        setSettings(s, () => writeBackup(() => refreshBackupUI()));
      });
    });
  });

  on("#bannerBackup", "click", () => {
    chrome.permissions.contains({ permissions: ["downloads"] }, (granted) => {
      const go = () =>
        writeBackup((err) => {
          if (err) buildBundle(false, (b) =>
            download(`riftatlas-matches-${stamp()}.json`, JSON.stringify(b, null, 2), "application/json")
          );
          hideBackupBanner();
        });
      if (granted) return go();
      requestBackupPermission((ok) => {
        if (ok) return go();
        buildBundle(false, (b) =>
          download(`riftatlas-matches-${stamp()}.json`, JSON.stringify(b, null, 2), "application/json")
        );
        hideBackupBanner();
      });
    });
  });

  // ---- visual replay settings ------------------------------------------

  /* What each of these fields is allowed to become. Pure given the default it
   * falls back to, so the bounds and the fallbacks are tested; the shipped
   * defaults are this file's to supply. */
  const CLAMP = window.RATrackerSettingsClamps;
  const { KEEP_MIN, KEEP_MAX, CEILING_MIN_MB, CEILING_MAX_MB } = CLAMP;
  const clampKeep = (v) => CLAMP.clampKeep(v, defaultSettings.visualReplayKeepMatches);
  const clampCeiling = (v) => CLAMP.clampCeiling(v, defaultSettings.visualReplayMaxMatchMb);

  function refreshVisualSettingsUI() {
    // The spinners' bounds come from the constants above so the two can't drift.
    const keep = $("#visualKeep");
    const ceiling = $("#visualCeiling");
    if (keep) {
      keep.min = String(KEEP_MIN);
      keep.max = String(KEEP_MAX);
    }
    if (ceiling) {
      ceiling.min = String(CEILING_MIN_MB);
      ceiling.max = String(CEILING_MAX_MB);
    }
    getSettings((s) => {
      const enabled = $("#visualEnabled");
      if (enabled) enabled.checked = s.visualReplayEnabled !== false;
      // Read whether or not the field exists: the diagnostics panel projects
      // disk use from it, and that projection outlives this file's own markup.
      keepMatches = clampKeep(s.visualReplayKeepMatches);
      if (keep) keep.value = keepMatches;
      const mb = clampCeiling(s.visualReplayMaxMatchMb);
      // blank, not 0, is what "no limit" looks like
      if (ceiling) ceiling.value = mb > 0 ? mb : "";
      // The panel projects disk use from the retention count, so it has to be
      // redrawn whenever that number changes.
      renderVisualPanel();
    });
  }

  on("#visualEnabled", "change", (e) => {
    const on = e.target.checked;
    getSettings((s) => {
      s.visualReplayEnabled = on;
      setSettings(s);
    });
  });

  on("#visualKeep", "change", (e) => {
    const n = clampKeep(e.target.value);
    e.target.value = n; // show what was actually stored, clamp included
    getSettings((s) => {
      s.visualReplayKeepMatches = n;
      setSettings(s, refreshVisualSettingsUI);
    });
  });

  on("#visualCeiling", "change", (e) => {
    const mb = clampCeiling(e.target.value);
    e.target.value = mb > 0 ? mb : "";
    getSettings((s) => {
      s.visualReplayMaxMatchMb = mb;
      setSettings(s);
    });
  });

  on("#bannerDismiss", "click", () => {
    getSettings((s) => {
      s.bannerDismissed = Date.now();
      setSettings(s, () => { hideBackupBanner(); });
    });
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
    /* Settings were read once, at load, and never again - so toggling
     * "Group best-of-three games into a series" left this side still holding
     * the old value. Every export, archive and daily backup is decorated from
     * it (withSeries -> buildBundle), so the file written after that toggle
     * described the setting the user had just changed away from, and stayed
     * wrong until the page was reloaded. The module half already re-reads on
     * this same event; this side simply never did. */
    if (changes.settings) STORE.getSettings((s) => { seriesSettings = s; });
  });

  load();
})();
