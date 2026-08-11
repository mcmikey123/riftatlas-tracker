/* Rift Atlas Stats Tracker - dashboard */
(() => {
  "use strict";

  // `all` holds LEAN match records: game logs live in log_<id> keys and the
  // cards you played in deckcards_<id> keys, so the array rewritten during
  // live games stays ~0.5 KB per match instead of ~21 KB.
  let all = [];
  const logCache = new Map(); // id -> log[]
  const expanded = new Set();
  // When viewing an archive file we render from memory and never write.
  let archive = null; // { name, matches, deckCards }

  const STORE = window.RATrackerStorage;
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
      loadShareEndpoint();
      refreshShares();
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

  // v1 bundles carried `replays` (board snapshots); v2 carries `deckCards`.
  // v1 files still import - their replays are simply dropped, because nothing
  // reads snapshots any more.
  const BUNDLE_VERSION = 2;

  /** Full portable bundle: matches with logs inline, optionally card codes. */
  /* The match array with its series fields filled in. Reads the same settings
   * the dashboard renders with, so an export describes the series the user was
   * actually looking at. */
  function withSeries(matches) {
    const SERIES = window.RATrackerSeries;
    if (!SERIES) return matches;
    return SERIES.detect(matches, {
      enabled: seriesSettings.seriesDetect !== false,
      windowMinutes: seriesSettings.seriesWindowMinutes,
      format: seriesSettings.seriesFormatDefault,
    }).matches;
  }

  function buildBundle(includeCards, cb) {
    if (archive) {
      return cb({
        format: "riftatlas-tracker-archive",
        version: BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        matches: archive.matches,
        deckCards: includeCards ? archive.deckCards || {} : {},
      });
    }
    chrome.storage.local.get(null, (data) => {
      /* Automatic series are worked out at render time and never written, so
       * an export has to compute them too - otherwise a backup carries only
       * the groupings made by hand and every detected series is lost on
       * import. The manual ones are already on the records and pass through
       * detect() untouched. */
      const decorated = withSeries(all);
      const matches = decorated.map((m) =>
        Object.assign({}, m, { log: ((data["log_" + m.id] || {}).log) || [] })
      );
      const deckCards = {};
      if (includeCards) {
        for (const m of all) {
          const r = data["deckcards_" + m.id];
          if (r && Array.isArray(r.codes) && r.codes.length) deckCards[m.id] = r.codes;
        }
      }
      cb({
        format: "riftatlas-tracker-archive",
        version: BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        matches,
        deckCards,
      });
    });
  }

  // ---- rendering -------------------------------------------------------

  const champ = (name) => (name ? String(name).split(",")[0].trim() : "Unknown");

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "–";
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  const deckOf = (m) => (m.deckName || "").trim() || "Unlabelled";

  // Where a deck name came from, so a detected name can be told apart from one
  // you typed before you decide whether to trust it.
  const DECK_SOURCE_LABEL = {
    picker: "the deck you had open in the picker (its champion matches the board)",
    "picker-unverified": "the deck you had open in the picker, unchecked against the board",
    board: "read off the game board",
    url: "read from the room URL",
    last: "assumed — the same deck as your previous match",
    fingerprint: "matched by the cards you played",
    manual: "typed by you",
  };
  const deckTitle = (m) =>
    (m.deckName || "").trim()
      ? `${DECK_SOURCE_LABEL[m.deckSource] || "source not recorded"} — pick another to override`
      : "Pick or add a deck name to override detection";

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

  function filtered(includeUnknownAnyway) {
    const mc = val("#fMyChampion");
    const mode = val("#fMode");
    const deck = val("#fDeck");
    const inclUnknown = includeUnknownAnyway || isChecked("#fUnknown");
    return all.filter((m) => {
      if (mc && champ(m.myChampion || m.myLegend) !== mc) return false;
      if (deck && deckOf(m) !== deck) return false;
      if (mode && m.mode !== mode) return false;
      if (!inclUnknown && (m.result === "unknown" || !m.result)) return false;
      return true;
    });
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
    renderSharesPanel();
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
    shares: () => shares,
    archiveName: () => (archive ? archive.name : ""),
    readOnly,
    onRender: null, // main.js sets this

    /* What the ported views still need from this file. Each of these goes when
     * the subsystem behind it is ported: hasVisual and shareBoxInner belong to
     * the share flow, which is the largest thing still living here.
     *
     * The views render markup carrying the SAME data-* attributes this file
     * already listens for, and the listeners are document-level - so a row
     * drawn by a module is driven by the handlers below without either side
     * knowing about the other. */
    hasVisual: (id) => hasVisual(id),
    shareOpenHas: (id) => shareOpen.has(id),
    shareBoxInner: (id) => shareBoxInner(id),
    deckNames,
    deckTitle,
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


  const esc = window.RATrackerFormat.esc;

  // ---- visual replay diagnostics ---------------------------------------

  const DASH = "—"; // stands in wherever a number was never recorded

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return DASH;
    if (n < 1024) return Math.round(n) + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  // In-flight matches, and any recorded before a counter existed, simply have
  // no value here - which must read as "not recorded", never as NaN.
  function statOf(record, key) {
    const v = record.stats ? record.stats[key] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  const fmtCount = (v) => (v === null || !Number.isFinite(v) ? DASH : String(v));
  const fmtMs = (v) => (v === null ? DASH : v + " ms");

  // Null - not zero - when no record carried the counter at all, so an empty
  // column can't masquerade as a measured zero.
  function sumStat(records, key) {
    const vals = records.map((r) => statOf(r, key)).filter((v) => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }

  function visualLabel(record) {
    const at = record.startedAt ? new Date(record.startedAt) : null;
    const when = at
      ? at.toLocaleDateString() + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : DASH;
    const m = all.find((x) => x.id === record.matchId);
    if (!m) return when;
    return `${when} · ${champ(m.myChampion || m.myLegend)} vs ${champ(m.opponentChampion || m.opponentLegend)}`;
  }

  function visualStateCell(record) {
    const state = record.state || "unknown";
    const why =
      state === "truncated" && record.truncatedAtTurn != null
        ? `capture stopped at turn ${record.truncatedAtTurn} - the replay covers everything up to there`
        : state === "error"
        ? record.error || "capture failed"
        : state;
    return `<td><span class="vd-state vd-${esc(state)}" title="${esc(why)}">${esc(state)}</span></td>`;
  }

  function visualRow(record) {
    return `<tr>
        <td>${esc(visualLabel(record))}</td>
        <td>${fmtBytes(record.compressedBytes)}</td>
        <td>${fmtCount(record.chunkCount)}</td>
        <td>${fmtCount(statOf(record, "keyframes"))}</td>
        <td>${fmtBytes(statOf(record, "meanDeltaBytes"))}</td>
        <td>${fmtMs(statOf(record, "captureP50Ms"))}</td>
        <td>${fmtMs(statOf(record, "captureMaxMs"))}</td>
        ${visualStateCell(record)}
      </tr>`;
  }

  function renderVisualPanel() {
    const panel = $("#visualPanel");
    if (!panel) return;
    const records = visualRecords.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    // An archive file holds no visual replays, so the panel would be lying.
    panel.hidden = readOnly() || !records.length;
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
        <td colspan="4"></td>
      </tr>
      <tr class="vd-total">
        <td>+ shared stylesheets · ${fmtCount(visualAssets.count)}</td>
        <td>${fmtBytes(visualAssets.bytes)}</td>
        <td colspan="6" class="vd-note">stored once by content hash, uncompressed, and shared by every match that used them</td>
      </tr>
      <tr class="vd-total">
        <td>On disk now · retained replays + shared stylesheets</td>
        <td>${fmtBytes(bytes + (Number(visualAssets.bytes) || 0))}</td>
        <td colspan="6" class="vd-note">
          ${fmtBytes(mean)} per match on average &mdash; keeping the newest ${keepMatches}
          works out at roughly ${fmtBytes(mean * keepMatches)} once that many have been played
        </td>
      </tr>`
    );
  }

  // ---- replay sharing --------------------------------------------------

  /* Turning a replay into a link is a one-way door. The link is a bearer token,
   * there is no revocation, and the object only goes away when the endpoint's
   * 7-day lifecycle rule removes it. So the Share button opens a panel that says
   * all of that first, and the upload is a second, deliberate click.
   *
   * That second click does not always upload. A live share for this match is
   * handed back instead - see `startRowShare` - because a second upload leaves a
   * second undeletable copy of the same replay on the endpoint for the same
   * seven days. The panel says when a link is reused and offers a forced upload
   * for someone who wants a full week rather than what is left of one.
   *
   * Building a share blocks the main thread for ~600 ms on the worst replay
   * measured - JSON.stringify 224 ms plus deflate 273 ms, with crypto at 3 ms -
   * and peaks near 380 MB. Every phase therefore paints before it begins, and
   * only one share may be in flight at a time.
   *
   * The pure parts - the size check, the failure taxonomy, the magic-byte check
   * and the record shape - live in share/share-ui-support.js and are tested.
   * What is left here is DOM, crypto and network, which by project convention
   * gets no unit tests and must instead stay small and obviously correct. */

  const SHARE = window.RAShareUI;

  // matchId -> {phase, link, error, retry, createdAt}. Held outside the DOM so a
  // re-render, which rebuilds the whole history table, cannot lose a share that
  // is mid-flight or a link that has just been produced. Openness is tracked
  // separately, so collapsing the panel hides a link rather than discarding it.
  const shareState = new Map();
  const shareOpen = new Set();
  let shareBusy = null; // matchId of the share currently running, or null
  // The promise that share settles with, so a second caller asking for the same
  // match waits on the share already running instead of being told nothing.
  let shareRunning = null;

  const SHARE_PHASES = {
    preparing: "Reading the replay…",
    stripping: "Deduplicating stylesheets…",
    encrypting: "Compressing and encrypting…",
    uploading: "Uploading…",
    verifying: "Verifying…",
  };

  /* Reassurance first, because the encryption property is real and is the whole
   * point; the caveats stay present but secondary. Self-hosting is deliberately
   * not mentioned - that is documentation, and it only confuses someone who is
   * standing at the point of sharing.
   *
   * The caveat says "everything on your screen" rather than listing fields
   * because that is literally what a replay is: capture/dom-recorder.js records
   * the DOM with only input values masked, so the sharer's own display name and
   * whatever else was on the page travel with it. Naming two items would read as
   * an exhaustive list and understate what is being handed over. */
  const SHARE_DISCLOSURE = `
    <p class="share-lead">End-to-end encrypted — only people with the link can view this replay.</p>
    <p class="share-caveats">
      The replay shows everything that was on your screen during the match, including your
      opponent's display name and the match chat, and anyone the link reaches can open it. It
      expires after ${SHARE.SHARE_TTL_DAYS} days, and it can't be unshared before then.
    </p>`;

  /** A failure the share flow raised itself, carrying what to show for it. */
  class ShareUiError extends Error {
    constructor(message, retry) {
      super(message);
      this.name = "ShareUiError";
      this.shareMessage = message;
      this.shareRetry = !!retry;
    }
  }

  /* A failure that came out of the upload call, and only out of the upload
   * call. share/share-ui-support.js reads a status off it and maps "no status"
   * to a transport failure, which is only true of a fetch that was actually
   * attempted: a local failure has no status either, and reporting one as
   * "couldn't reach the share endpoint" would offer a retry for something that
   * repeats identically. Wrapped rather than sniffed, so the distinction is
   * made where it is known rather than guessed from shape afterwards. */
  class ShareUploadError extends Error {
    constructor(cause) {
      super(String((cause && cause.message) || cause));
      this.name = "ShareUploadError";
      this.status = cause && cause.status;
      this.cause = cause;
    }
  }

  /* Let the browser paint the phase label before the phase begins. Shared with
   * the standalone viewer rather than reimplemented: waiting on a frame alone
   * never resolves in a backgrounded tab, which would park the pipeline with
   * shareBusy still held and every other match's Share button disabled. */
  const paintYield = () => window.RARepaint.repaint(window);

  const sha256Hex = async (text) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  /* The read-only link field and its Copy button. Both the panel under a match
   * and the shares list render one, and as two copies they drifted - only the
   * list's carried the field's accessible name, leaving the panel's input
   * announced as nothing but "edit text". One builder, so the next change
   * reaches both.
   *
   * `field` and `copy` name the data attributes, because each caller keys its
   * rows differently: the panel by match id, the list by object id, since a
   * match can have been shared more than once. That is all that still differs. */
  function shareLinkRowHtml(link, id, { label, field, copy, copyText }) {
    return `<div class="share-link-row">
          <input class="share-link" type="text" readonly spellcheck="false"
                 aria-label="Share link for ${esc(label)}"
                 data-${field}="${esc(id)}" value="${esc(link)}" />
          <button class="rp-btn" data-${copy}="${esc(id)}">${esc(copyText)}</button>
        </div>`;
  }

  function shareBoxInner(matchId) {
    const s = shareState.get(matchId) || {};
    let body;
    if (s.link) {
      const expires = new Date(s.createdAt + SHARE.SHARE_TTL_MS);
      /* The error has to render here too, not only in the no-link branch below.
       * "Create a new link anyway" is offered while a link is on screen, and the
       * refusals it can hit - another match already uploading, or a broken stored
       * endpoint - set an error without clearing the link, so this branch is the
       * one that paints. Without this the button just re-enables itself and
       * nothing else happens, however many times it is pressed. Clearing the link
       * instead would throw away the very thing the user is looking at. */
      body = `
        ${s.error ? `<p class="share-error">${esc(s.error)}</p>` : ""}
        ${shareLinkRowHtml(s.link, matchId, {
          label: "this match",
          field: "sharelink",
          copy: "sharecopy",
          copyText: "Copy link",
        })}
        ${
          s.reuse
            ? `<p class="share-note">${esc(SHARE.reuseNotice(s.reuse, Date.now()))}</p>
        <button class="rp-btn share-again" data-sharenew="${esc(matchId)}"
                title="Upload this replay again for a full ${SHARE.SHARE_TTL_DAYS} days. The copy already on the endpoint stays there until it expires.">Create a new link anyway</button>`
            : `<p class="share-note">Uploaded and verified. Expires ${esc(
                expires.toLocaleDateString()
              )}.</p>`
        }`;
    } else if (s.phase && s.phase !== "idle") {
      body = `<p class="share-progress">${esc(SHARE_PHASES[s.phase] || "Working…")}</p>`;
    } else {
      body = `${s.error ? `<p class="share-error">${esc(s.error)}</p>` : ""}
        ${
          s.error && !s.retry
            ? ""
            : `<button class="rp-btn" data-sharego="${esc(matchId)}">${
                s.error ? "Try again" : "Create share link"
              }</button>`
        }`;
    }
    return SHARE_DISCLOSURE + body;
  }

  /** Repaint one match's panel in place. A collapsed row simply has none. */
  function paintShare(matchId) {
    const box = document.querySelector(`[data-sharebox="${CSS.escape(matchId)}"]`);
    if (!box) return;
    // Whether the panel is open is the toggle's business and beginShare's, not
    // a repaint's: a paint that forces it open means setShare can never update
    // a collapsed panel without reopening it.
    box.hidden = !shareOpen.has(matchId);
    box.innerHTML = shareBoxInner(matchId);
    // The toggle says what the panel is doing. It used to be enough for the
    // click handler to keep the two in step, because a share could only ever
    // start from inside an already-open panel; a share started from the replay
    // modal opens this one from somewhere the toggle cannot see.
    const toggle = document.querySelector(`[data-share="${CSS.escape(matchId)}"]`);
    if (toggle) toggle.textContent = shareOpen.has(matchId) ? "hide" : "share a link";
  }

  function setShare(matchId, patch) {
    shareState.set(matchId, Object.assign({}, shareState.get(matchId), patch));
    paintShare(matchId);
    paintMomentPanel(matchId);
  }

  // The only endpoints that legitimately cannot offer https, and the only ones
  // http is accepted for. `new URL()` keeps the brackets on an IPv6 hostname.
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

  /* An extension page's fetch obeys CORS like any other page, so uploading needs
   * the endpoint's cooperation. The share Worker grants it: it answers the
   * preflight and echoes Access-Control-Allow-Origin for chrome-extension://
   * origins only. That is deliberately server-side rather than a host permission
   * here, so the extension ships no wildcard origin access and a self-hoster can
   * point Settings at their own instance with no manifest edit and no prompt.
   *
   * The endpoint is still validated, because a malformed one should fail with a
   * clear message rather than an opaque fetch rejection.
   *
   * Returns what to tell the user, or null when there is nothing to say. */
  function endpointProblem(endpoint) {
    let url;
    try {
      url = new URL(endpoint);
    } catch (_) {
      return "The share endpoint in Settings isn't a valid URL.";
    }
    /* The payload is encrypted before it leaves here, so plain http would not
     * expose a replay - but the upload token and the object id are not part of
     * the payload, and both travel in the clear. The one endpoint that
     * legitimately cannot offer https is a `wrangler dev` on this machine, so
     * that is the only place http is allowed. */
    if (url.protocol === "https:") return null;
    if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return null;
    return "The share endpoint in Settings must be an https:// URL (http:// only for localhost).";
  }

  function readReplay(matchId) {
    return new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "ra:visual:get", matchId }, (reply) =>
        resolve(chrome.runtime.lastError ? null : reply)
      )
    );
  }

  /* Read just enough of an object to recognise it: the four magic bytes. Used
   * both to verify a fresh upload and to re-check an old share from the shares
   * list, which is why it reports what happened rather than throwing.
   *
   * No Range header, deliberately. The Worker's /b/ route hands R2's whole body
   * back - `BUCKET.get(id)` takes no range - so a range request would be ignored
   * and answered 200 with the full object anyway, while risking a CORS preflight
   * against a route that answers OPTIONS with 405. Cancelling after the first
   * chunk is what actually keeps this cheap: the head of a 3.5 MB share costs
   * one chunk, not 3.5 MB, and it is the same read the upload verification has
   * been doing against the deployed Worker all along.
   *
   *   reached  the endpoint answered at all
   *   status   its HTTP status, 0 when the fetch itself failed
   *   bytes    the first few bytes of the body, empty unless it answered 2xx */
  async function fetchObjectHead(endpoint, objectId) {
    const base = window.RAShareHosts.normaliseEndpoint(endpoint);
    // Encoded like the viewer's own download does. Ids that reach here are the
    // validated 22-char shape, so this changes nothing today - it is what keeps
    // that still being true if one ever arrives from somewhere else.
    const url = `${base}/b/${encodeURIComponent(objectId)}`;
    const empty = new Uint8Array(0);
    let res;
    try {
      res = await fetch(url, { cache: "no-store" });
    } catch (_) {
      return { reached: false, status: 0, bytes: empty };
    }
    if (!res.ok || !res.body) {
      if (res.body) res.body.cancel().catch(() => {});
      return { reached: true, status: res.status, bytes: empty };
    }

    const reader = res.body.getReader();
    let head = empty;
    try {
      while (head.length < 4) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        const merged = new Uint8Array(head.length + value.length);
        merged.set(head);
        merged.set(value, head.length);
        head = merged;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return { reached: true, status: res.status, bytes: head };
  }

  /* Never show a link that has not been read back. This is the check that would
   * have caught the host found during research which answered a curl probe with
   * the bytes and a browser with an HTML interstitial. */
  async function verifyObject(endpoint, objectId) {
    const head = await fetchObjectHead(endpoint, objectId);
    if (!SHARE.hasShareMagic(head.bytes)) throw new ShareUiError(SHARE.MESSAGES.unverified, true);
  }

  /* Enters already painted as "preparing" by beginShare, which is the caller
   * that owns the busy flag; painting it a second time here would run the whole
   * panel through innerHTML twice for one state. */
  async function runShare(matchId, endpoint) {
    await paintYield();

    const reply = await readReplay(matchId);
    const replay = reply && reply.ok ? reply.replay : null;
    if (!replay || !replay.events || !replay.events.length) {
      throw new ShareUiError(SHARE.MESSAGES.unreadable, false);
    }

    /* get() hands back the stylesheets rehydrated inline into every one of the
     * ~34 keyframes. Re-stripping them with the same pure function storage uses
     * costs one pass and takes the deflated frame from 5.95 MB to 3.48 MB on the
     * worst replay measured. The viewer runs rehydrateCssAssets after decrypting,
     * which is the exact inverse. */
    setShare(matchId, { phase: "stripping" });
    await paintYield();
    const { events, assets } = await window.extractCssAssets(replay.events, { hash: sha256Hex });

    setShare(matchId, { phase: "encrypting" });
    await paintYield();
    const key = await window.RAShare.generateKey({});
    const frame = await window.RAShare.buildSharePayload(
      // assets arrives as a Map; JSON needs a plain object.
      { meta: replay.meta, events, assets: Object.fromEntries(assets) },
      key,
      {}
    );

    /* Measured on the frame that will actually be sent, never predicted from
     * meta.compressedBytes - that is the store's per-chunk total and differs
     * (3,760,696 against 3,644,834 on the measured replay). */
    const size = SHARE.checkPayloadSize(frame.byteLength, SHARE.MAX_UPLOAD_BYTES);
    if (!size.ok) throw new ShareUiError(size.message, false);

    setShare(matchId, { phase: "uploading" });
    await paintYield();
    let objectId;
    try {
      objectId = await window.RAShareHosts.hostFor("w").upload(frame, {
        endpoint,
        token: window.RAShareConfig.SHARE_TOKEN,
        fetch: (url, init) => fetch(url, init),
      });
    } catch (err) {
      throw new ShareUploadError(err);
    }

    setShare(matchId, { phase: "verifying" });
    await paintYield();
    await verifyObject(endpoint, objectId);

    const keyBytes = await window.RAShare.exportKey(key, {});
    const record = SHARE.shareRecord({
      matchId,
      objectId,
      key: window.RAShareHosts.toBase64Url(keyBytes),
      endpoint: window.RAShareHosts.normaliseEndpoint(endpoint),
      createdAt: Date.now(),
    });
    await rememberShare(record);
    // The record comes back as well as the link: the replay modal rebuilds its
    // own link from it with a timestamp attached, rather than splicing one onto
    // the end of a string somebody else assembled.
    return {
      link: window.RAShareHosts.buildLink({ endpoint, objectId, keyBytes }),
      createdAt: record.createdAt,
      record,
    };
  }

  /* chrome.storage.local key "shares": an array of share records in creation
   * order, whose shape share/share-ui-support.js documents and validates. The
   * key is stored because it exists nowhere else - the endpoint never sees it,
   * and without it a link cannot be rebuilt, only lost. The shares list reads
   * this. A write that fails must not lose the link the user is looking at, so
   * the flow carries on either way.
   *
   * Every write drops the records whose objects are certainly gone. Nothing
   * else ever would: there is no expiry job and no server to run one, so
   * without this a browser accumulates every key it has ever generated, long
   * after the only thing they could decrypt stopped existing.
   *
   * KNOWN RACE: get-then-set is not atomic, and chrome.storage.local is shared
   * across every dashboard tab. Two tabs completing a share at the same moment
   * can have the second write back a list read before the first landed, losing
   * a record - and a lost record takes a key that exists nowhere else. Sharing
   * twice within the same few milliseconds from two tabs is the only way to hit
   * it, so it is left as it stands; closing it properly needs the writes
   * serialised through the service worker, which is more machinery than this
   * feature justifies. `forgetShare` writes the same way and has the same race. */
  function rememberShare(record) {
    return new Promise((resolve) =>
      chrome.storage.local.get({ shares: [] }, (data) => {
        const shares = SHARE.pruneShares(data.shares, Date.now());
        shares.push(record);
        STORE.writeShares(shares, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      })
    );
  }

  /* Resolves with what runShare produced, or null if nothing was uploaded -
   * refused or failed. Never rejects: every failure has already been turned into
   * a message in the panel by the time this settles, and a second caller
   * re-reporting it would say the same thing twice. The replay modal awaits it;
   * the row's own button ignores it.
   *
   * Asking for a share of THIS match while that same share is in flight hands
   * back the promise it is already running on, rather than a null the caller
   * would read as a failure: the modal's panel would paint "could not be
   * prepared" over an upload that was seconds from succeeding. That is reachable
   * by starting a share from the row's panel and then opening the modal. */
  function beginShare(matchId) {
    // Every message this raises is shown inside the panel, so the panel has to
    // be open for any of them to be read. It always is - the button that gets
    // here lives in it - but nothing else guarantees that.
    shareOpen.add(matchId);
    if (shareBusy) {
      // The `||` is for the one path where shareBusy is set and the promise is
      // not: a throw between the two assignments below. Unreachable today, and a
      // caller crashing on `null.then` is not the way to find out otherwise.
      if (shareBusy === matchId) return shareRunning || Promise.resolve(null);
      setShare(matchId, {
        phase: "idle",
        error: "Another replay is being shared right now. Wait for that one to finish.",
        retry: true,
      });
      return Promise.resolve(null);
    }
    const endpoint = shareEndpoint;
    const problem = endpointProblem(endpoint);
    if (problem) {
      setShare(matchId, { phase: "idle", error: problem, retry: true });
      return Promise.resolve(null);
    }
    shareBusy = matchId;
    // `reuse` goes with the link it described: what follows is an upload, and a
    // stale reuse notice under a freshly uploaded link would say the opposite of
    // what happened. Cleared here rather than on completion because every share
    // passes through this phase, including a failing one.
    setShare(matchId, { phase: "preparing", link: null, reuse: null, error: null, retry: false });
    shareRunning = runShare(matchId, endpoint)
      .then(
        (made) => {
          setShare(matchId, {
            phase: "done",
            link: made.link,
            createdAt: made.createdAt,
            error: null,
          });
          return made;
        },
        (err) => {
          console.warn("[RA-Tracker] sharing failed:", err);
          setShare(matchId, Object.assign({ phase: "idle", link: null }, shareFailure(err)));
          return null;
        }
      )
      // finally, not then: a throw inside either settle handler above would
      // otherwise leave shareBusy set for good, disabling sharing for every
      // match until the page is reloaded.
      .finally(() => {
        shareBusy = null;
        shareRunning = null;
      });
    return shareRunning;
  }

  /* The match row's "Create share link", and its "Create a new link anyway".
   *
   * The reuse decision lives here rather than inside `beginShare` because
   * `beginShare` is also what the replay modal's moment path calls, and that
   * path has already made the decision itself - it has a timestamp to splice
   * into the link and a panel of its own to paint into, neither of which this
   * side knows about. A check inside `beginShare` would run second, on a
   * question already answered, and would have to be told to keep quiet for one
   * of its two callers. One decision per button, taken by the button.
   *
   * The storage read happens on the click, not when the panel was opened, which
   * is what makes this the check at the moment of upload: the panel can sit open
   * for as long as it likes, and a share landing from the modal in the meantime
   * is found here. `forceNew` is the one case that skips the lookup, because
   * finding a share is exactly what the presser is refusing.
   *
   * Consent is not asked again: the disclosure is rendered above this button
   * every time the panel is painted, so it is on screen for both the reuse and
   * the forced upload. */
  async function startRowShare(matchId, options) {
    const plan = SHARE.planShare(await readStoredShares(), matchId, Date.now(), options);
    if (plan.action === "reuse") {
      // No upload and no record: a second record for the same object would be a
      // duplicate row in the shares panel claiming to be a second share.
      setShare(matchId, {
        phase: "idle",
        link: shareLinkOf(plan.record),
        createdAt: plan.record.createdAt,
        reuse: plan.record,
        error: null,
        retry: false,
      });
      return;
    }
    beginShare(matchId);
  }

  /* What to show for a failed share. Three sources, and only the middle one may
   * be read as a network or endpoint problem:
   *
   *   ShareUiError      raised here, already carrying its own message
   *   ShareUploadError  came out of the PUT, so the status mapping applies
   *   anything else     a local failure - the CSS re-strip, the crypto, a
   *                     script tag that did not load - which nothing about the
   *                     endpoint explains and a retry would repeat exactly */
  function shareFailure(err) {
    if (err instanceof ShareUiError) return { error: err.shareMessage, retry: err.shareRetry };
    if (err instanceof ShareUploadError) {
      const shown = SHARE.describeUploadFailure(err);
      return { error: shown.message, retry: shown.retry };
    }
    return { error: SHARE.MESSAGES.unprepared, retry: false };
  }

  /* share/clipboard.js rather than a local copy: the standalone viewer hands
   * over links from a button too, and the two surfaces have drifted on smaller
   * things than this. Handing it the field selects it either way, so a blocked
   * clipboard leaves the link ready for a manual copy rather than leaving the
   * user with nothing. */
  function copyShareLink(matchId, button) {
    const s = shareState.get(matchId);
    if (!s || !s.link) return;
    window.RAClipboard.copyToButton(s.link, button, {
      field: document.querySelector(`[data-sharelink="${CSS.escape(matchId)}"]`),
    });
  }

  // ---- share a link to this moment --------------------------------------

  /* The replay modal's "Copy link to this moment". The viewer's version of this
   * is a string and a clipboard write, because the replay it is watching is
   * already on the endpoint. A local replay has no URL at all, so the first
   * moment shared from a match may have to run the entire pipeline - re-strip,
   * compress, encrypt, upload, verify - which blocks the main thread for about
   * 600 ms and sends about 3.5 MB.
   *
   * So it must not run every time, and it does not: an unexpired share for this
   * match is reused, and reuse costs a base64 decode. Which record that is, and
   * whether there is one at all, is `reusableShare` in share/share-ui-support.js
   * where it is pure and tested. What is here is the storage read, the
   * disclosure and the paint.
   *
   * Reuse deliberately does NOT re-check the endpoint first. The record says the
   * object has days left, and spending a round trip to confirm that would undo
   * the point of reusing; the shares panel has an explicit Re-check for the
   * question "is it still there". */

  // The modal panel following a share's phases, if one is open. The row's own
  // panel is behind the modal and repaints as usual - the point of this is that
  // the thing covering it says the same thing.
  let momentFollow = null;

  function paintMomentPanel(matchId) {
    if (!momentFollow || momentFollow.matchId !== matchId) return;
    if (!momentFollow.panel.isConnected) {
      momentFollow = null;
      return;
    }
    const s = shareState.get(matchId) || {};
    if (!s.phase || s.phase === "idle") return;
    momentFollow.panel.innerHTML = `<p class="share-progress">${esc(
      SHARE_PHASES[s.phase] || "Working…"
    )}</p>`;
  }

  /* A failed read is an empty list: there is nothing to reuse that we can see,
   * and an upload is the right answer to that. lastError is consumed the way
   * rememberShare consumes it - left unchecked, chrome logs a warning about an
   * error this already handles. */
  function readStoredShares() {
    return new Promise((resolve) =>
      chrome.storage.local.get({ shares: [] }, (data) => {
        void chrome.runtime.lastError;
        resolve((data && data.shares) || []);
      })
    );
  }

  function closeMomentPanel(panel) {
    panel.hidden = true;
    panel.innerHTML = "";
  }

  /* The finished link, offered with its own Copy button rather than only pushed
   * at the clipboard.
   *
   * After an upload the click that started it is seconds past counting as a user
   * gesture and `writeText` would be refused - leaving the link in a fallback
   * dialog, for a share the user did everything right to create. One fresh click
   * on a button beside the link is a better ending, and it is the same read-only
   * field and Copy pairing the row's own panel ends with. The reuse path shows
   * the same thing for the same reason: its clipboard write can be refused too,
   * and a panel that has already closed leaves a prompt over the replay as the
   * only place the link exists. */
  function showMomentLink(panel, link, note) {
    panel.hidden = false;
    panel.innerHTML = `
      <div class="share-link-row">
        <input class="share-link vr-share-link" type="text" readonly spellcheck="false"
               aria-label="Share link opening at this moment" value="${esc(link)}" />
        <button class="rp-btn vr-share-copy">Copy link</button>
      </div>
      <p class="share-note">${esc(note)}</p>`;
    const field = panel.querySelector(".vr-share-link");
    const copy = panel.querySelector(".vr-share-copy");
    copy.addEventListener("click", () => window.RAClipboard.copyToButton(link, copy, { field }));
    field.focus();
    field.select();
    return field;
  }

  /* An existing share, handed over instead of uploading a second copy of the
   * same replay. Nothing is uploaded and no record is written: a second record
   * for the same object would be a duplicate row in the shares panel claiming to
   * be a second share.
   *
   * What it has left is said out loud, in the wording the match row's own reuse
   * uses - `SHARE.reuseNotice`, so the two buttons cannot drift into describing
   * the same decision differently. */
  function offerReusedLink(panel, button, record, atSeconds) {
    const link = shareLinkOf(record, atSeconds);
    const field = showMomentLink(panel, link, SHARE.reuseNotice(record, Date.now()));
    window.RAClipboard.copyToButton(link, button, { field });
  }

  /* Entry point handed to the modal. `atMs` was read at the click, so it names
   * the moment the user meant even when an upload happens in between. */
  async function shareMoment({ atMs, button, panel }, match) {
    const atSeconds = window.RAShareHosts.toLinkSeconds(atMs);
    const record = SHARE.reusableShare(await readStoredShares(), match.id, Date.now());
    if (record) return offerReusedLink(panel, button, record, atSeconds);
    // Nothing live to reuse, so this is a first upload. The disclosure comes
    // first and the upload is a second, deliberate click - the same two steps
    // the row's own share panel takes, because the thing being consented to is
    // the same: a replay carrying an opponent's display name and the match chat
    // leaves this machine, and it cannot be unshared afterwards.
    askThenShareMoment(match.id, atSeconds, button, panel);
  }

  function askThenShareMoment(matchId, atSeconds, button, panel) {
    panel.hidden = false;
    panel.innerHTML = `${SHARE_DISCLOSURE}
      <div class="vr-share-actions">
        <button class="rp-btn vr-share-go">Create share link</button>
        <button class="rp-btn vr-share-cancel">Cancel</button>
      </div>`;
    panel.querySelector(".vr-share-cancel").addEventListener("click", () => closeMomentPanel(panel));
    const go = panel.querySelector(".vr-share-go");
    go.addEventListener("click", async () => {
      // Disabled synchronously: the re-read below is asynchronous, and a second
      // click while it is out would start a second upload of the same replay.
      go.disabled = true;
      /* The reuse decision was made on the first click, which may be minutes
       * back - long enough for a share of this match to have landed from the
       * row's own panel behind the modal. Uploading now would put a second 3.5 MB
       * object on the endpoint and write a second record, both undeletable for
       * seven days, which is exactly what reuse exists to prevent. */
      const landed = SHARE.reusableShare(await readStoredShares(), matchId, Date.now());
      // The panel's own buttons go with its content, so a Cancel or a closed
      // modal during the read detaches this one.
      if (!go.isConnected) return;
      if (landed) return offerReusedLink(panel, button, landed, atSeconds);

      button.disabled = true;
      momentFollow = { matchId, panel };
      panel.innerHTML = `<p class="share-progress">${esc(SHARE_PHASES.preparing)}</p>`;
      beginShare(matchId).then((made) => {
        if (momentFollow && momentFollow.panel === panel) momentFollow = null;
        button.disabled = false;
        if (!panel.isConnected) return; // the modal was closed while it ran
        if (!made) {
          // beginShare has already turned the failure into a message; showing
          // it here as well is what makes the modal a complete surface rather
          // than one that needs the row behind it read too.
          const s = shareState.get(matchId) || {};
          panel.innerHTML = `<p class="share-error">${esc(s.error || SHARE.MESSAGES.unprepared)}</p>`;
          return;
        }
        showMomentLink(
          panel,
          shareLinkOf(made.record, atSeconds),
          "Uploaded and verified. Later moments from this match reuse it — no second upload, " +
            "and no second copy on the endpoint."
        );
      });
    });
  }

  // ---- shares list ------------------------------------------------------

  /* What has been shared from this browser, and what became of it.
   *
   * The panel exists because there is no delete button and cannot be one: a
   * share is served until the endpoint's own 7-day lifecycle rule removes it,
   * and the payload carries an opponent's display name and the match chat. The
   * least this can do is keep an honest register of what is still out there.
   *
   * Re-check reads four bytes back off the endpoint. Clear removes a local
   * record only - it deletes nothing, and the copy underneath an expired record
   * is already gone or going. The pure parts - the record filter, the expiry
   * wording and the outcome-to-message mapping - are in share/share-ui-support.js
   * and are tested; what is here is DOM and network. */

  let shares = [];
  // objectId -> {busy} or a describeRecheck() result. Kept outside the DOM so a
  // re-render cannot lose an answer that was just given.
  const recheckState = new Map();

  function refreshShares() {
    if (archive) return;
    chrome.storage.local.get({ shares: [] }, (data) => {
      shares = SHARE.readShareList(data && data.shares);
      // Records go on their own - pruned on write, or cleared with everything
      // else - so an answer held for one that is no longer listed is an answer
      // about a row that will never be drawn again.
      const listed = new Set(shares.map((r) => r.objectId));
      for (const objectId of [...recheckState.keys()]) {
        if (!listed.has(objectId)) recheckState.delete(objectId);
      }
      renderSharesPanel();
    });
  }

  /* The link a record rebuilds to. `atSeconds` is optional and omitted from the
   * link when absent, so the shares list keeps producing exactly the link it
   * always did; only "copy a link to this moment" passes one. Always the
   * record's own endpoint, never the one in Settings - a share uploaded before
   * that setting changed still lives where it was put. */
  function shareLinkOf(record, atSeconds) {
    return window.RAShareHosts.buildLink({
      endpoint: record.endpoint,
      objectId: record.objectId,
      keyBytes: window.RAShareHosts.fromBase64Url(record.key),
      atSeconds,
    });
  }

  /* Which match this came from. A share outlives the match record - deleting a
   * match cannot reach the copy on the endpoint - so an orphaned row says so
   * rather than showing a bare id nobody can place. */
  function shareMatchLabel(record) {
    const m = all.find((x) => x.id === record.matchId);
    if (!m) return "match no longer in your history";
    const at = m.startedAt ? new Date(m.startedAt) : null;
    const when = at
      ? at.toLocaleDateString() + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : DASH;
    return `${when} · ${champ(m.myChampion || m.myLegend)} vs ${champ(m.opponentChampion || m.opponentLegend)}`;
  }

  function recheckInner(objectId) {
    const state = recheckState.get(objectId);
    if (!state) return "";
    if (state.busy) return '<p class="sh-msg">Asking the endpoint…</p>';
    return `<p class="sh-msg"><span class="sh-state sh-${esc(state.state)}">${esc(state.label)}</span>
      ${esc(state.message)}</p>`;
  }

  function shareListRow(record, now) {
    const expired = SHARE.isExpired(record, now);
    const created = new Date(record.createdAt);
    const oid = esc(record.objectId);
    const label = shareMatchLabel(record);
    return `<tr class="${expired ? "sh-expired-row" : ""}">
        <td>${esc(label)}</td>
        <td class="sh-when">${esc(created.toLocaleDateString())} ${esc(
          created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        )}</td>
        <td class="sh-when">${
          expired
            ? `<span class="sh-state sh-expired">${esc(SHARE.expiryText(record, now))}</span>`
            : esc(SHARE.expiryText(record, now))
        }</td>
        <td class="sh-link-cell">
          ${shareLinkRowHtml(shareLinkOf(record), record.objectId, {
            label,
            field: "sharelistlink",
            copy: "sharelistcopy",
            copyText: "Copy",
          })}
        </td>
        <td class="sh-actions">
          <button class="rp-btn" data-sharerecheck="${oid}" ${
            (recheckState.get(record.objectId) || {}).busy ? "disabled" : ""
          }>Re-check</button>
          ${
            expired
              ? `<button class="rp-btn sh-forget" data-shareforget="${oid}"
                     title="Forget this record. It cannot delete the copy on the endpoint - that expires on its own.">Clear from list</button>`
              : ""
          }
          <div data-sharestatus="${oid}" aria-live="polite">${recheckInner(record.objectId)}</div>
        </td>
      </tr>`;
  }

  function renderSharesPanel() {
    const panel = $("#sharesPanel");
    if (!panel) return;
    // An archive view is a file, not this browser's data; its matches have no
    // relationship to what was shared from here.
    panel.hidden = readOnly();
    if (panel.hidden) return;
    const now = Date.now();
    setHtml(
      "#sharesTable tbody",
      shares.length
        ? shares.map((r) => shareListRow(r, now)).join("")
        : `<tr><td colspan="5" class="empty">No share links have been created from this browser.
           Open a match with a replay and choose “share a link”.</td></tr>`
    );
  }

  /** Repaint one row's outcome in place, so re-checking keeps keyboard focus. */
  function paintRecheck(objectId) {
    const cell = document.querySelector(`[data-sharestatus="${CSS.escape(objectId)}"]`);
    if (cell) cell.innerHTML = recheckInner(objectId);
    const button = document.querySelector(`[data-sharerecheck="${CSS.escape(objectId)}"]`);
    if (button) button.disabled = !!(recheckState.get(objectId) || {}).busy;
  }

  function recheckShare(objectId) {
    const record = shares.find((r) => r.objectId === objectId);
    if (!record || (recheckState.get(objectId) || {}).busy) return;
    recheckState.set(objectId, { busy: true });
    paintRecheck(objectId);
    const settle = (outcome) => {
      // The row can go while the endpoint is answering - cleared from the list,
      // or pruned by a write. refreshShares() drops answers for rows it no
      // longer lists, so an answer stored after that would be an entry nothing
      // paints and nothing removes.
      if (!shares.some((r) => r.objectId === objectId)) return;
      recheckState.set(objectId, SHARE.describeRecheck(outcome));
      paintRecheck(objectId);
    };
    fetchObjectHead(record.endpoint, record.objectId).then(
      (head) =>
        settle({
          reached: head.reached,
          status: head.status,
          magic: SHARE.hasShareMagic(head.bytes),
        }),
      (err) => {
        console.warn("[RA-Tracker] re-checking a share failed:", err);
        settle({ reached: false });
      }
    );
  }

  /* Forgetting a record is the only thing this list can remove. The object on
   * the endpoint is not ours to delete - there is no route for it - so the
   * wording must never suggest this unshares anything. */
  function forgetShare(objectId) {
    if (readOnly()) return;
    const record = shares.find((r) => r.objectId === objectId);
    // Expired only, which is what the row offers - the wording below is about a
    // share whose time is already up and must never be shown for a live one.
    if (!record || !SHARE.isExpired(record, Date.now())) return;
    ask({
      title: "Remove this expired share from the list?",
      body:
        "<p>This forgets the local record only. It cannot delete the copy on the endpoint — that " +
        "expired on its own, and the endpoint deletes it within about a day of expiring.</p>" +
        "<p>The record is the only place this share's decryption key is kept, so the link " +
        "can't be rebuilt afterwards.</p>",
      confirmLabel: "Clear from list",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      chrome.storage.local.get({ shares: [] }, (data) => {
        // Pruned on this write like any other. Everything it removes alongside
        // the chosen record is a share whose object the endpoint deleted days
        // ago, so no row disappears that could still have been opened.
        //
        // Same non-atomic get-then-set as rememberShare, and the same race with
        // a second dashboard tab. See the note there.
        const kept = SHARE.pruneShares(data.shares, Date.now()).filter(
          (s) => !(s && s.objectId === objectId)
        );
        STORE.writeShares(kept, () => {
          recheckState.delete(objectId);
          refreshShares();
        });
      });
    });
  }

  // ---- share settings ---------------------------------------------------

  let shareEndpoint = window.RAShareConfig.DEFAULT_SHARE_ENDPOINT;

  // Blank is the "put it back to the default" affordance, so an endpoint can
  // never be cleared into a state where sharing silently has nowhere to go.
  const cleanEndpoint = (value) => {
    const text = String(value == null ? "" : value).trim();
    return text
      ? window.RAShareHosts.normaliseEndpoint(text)
      : window.RAShareConfig.DEFAULT_SHARE_ENDPOINT;
  };

  /* There is no Settings field for this. The stored value is still honoured, so
   * a self-hoster can point the extension at their own instance without editing
   * code — see share/worker/README.md — but it is set through storage rather
   * than through a box that every other user would have to scroll past and
   * wonder about. */
  function loadShareEndpoint() {
    getSettings((s) => {
      shareEndpoint = cleanEndpoint(s.shareEndpoint);
    });
  }

  // ---- events ----------------------------------------------------------

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
    if (["fMyChampion", "fMode", "fDeck", "fUnknown"].includes(t.id)) render();
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
    /* The expander moved to view-matches.js with the row it opens. This file
     * kept a private `expanded` Set that nothing renders from any more, so a
     * branch here would only fire a second render for the same click. */
    const visualId = e.target?.dataset?.visual;
    if (visualId) {
      const m = all.find((x) => x.id === visualId) || { id: visualId };
      chrome.runtime.sendMessage({ type: "ra:visual:get", matchId: visualId }, (reply) => {
        const payload = chrome.runtime.lastError || !reply || !reply.ok ? null : reply.replay;
        if (!payload || !payload.events || !payload.events.length) {
          say("The replay for this match could not be read.", "error");
          return;
        }
        window.RATrackerVisualReplay.openModal(m, payload, {
          shareMoment: (request) => shareMoment(request, m),
        });
      });
      return;
    }
    // Sharing. The panel is toggled in place rather than through render(), so
    // opening it disturbs nothing else in the row - and a share already running
    // cannot be closed out from under itself.
    const shareId = e.target?.dataset?.share;
    if (shareId) {
      if (shareBusy === shareId) return;
      const box = document.querySelector(`[data-sharebox="${CSS.escape(shareId)}"]`);
      if (!box) return;
      if (shareOpen.has(shareId)) shareOpen.delete(shareId);
      else shareOpen.add(shareId);
      const open = shareOpen.has(shareId);
      box.hidden = !open;
      box.innerHTML = shareBoxInner(shareId);
      e.target.textContent = open ? "hide" : "share a link";
      return;
    }
    const shareGoId = e.target?.dataset?.sharego;
    if (shareGoId) {
      // Disabled synchronously: the shares read below is asynchronous, and the
      // panel does not repaint until it comes back. Every outcome repaints from
      // shareState, which is what puts the button back or replaces it.
      e.target.disabled = true;
      startRowShare(shareGoId, { forceNew: false });
      return;
    }
    const shareNewId = e.target?.dataset?.sharenew;
    if (shareNewId) {
      e.target.disabled = true;
      startRowShare(shareNewId, { forceNew: true });
      return;
    }
    const shareCopyId = e.target?.dataset?.sharecopy;
    if (shareCopyId) {
      copyShareLink(shareCopyId, e.target);
      return;
    }
    // The shares list. Keyed by object id, which is what identifies a share -
    // a match can have been shared more than once.
    const listCopyId = e.target?.dataset?.sharelistcopy;
    if (listCopyId) {
      const record = shares.find((r) => r.objectId === listCopyId);
      if (record) {
        window.RAClipboard.copyToButton(shareLinkOf(record), e.target, {
          field: document.querySelector(`[data-sharelistlink="${CSS.escape(listCopyId)}"]`),
        });
      }
      return;
    }
    const recheckId = e.target?.dataset?.sharerecheck;
    if (recheckId) {
      recheckShare(recheckId);
      return;
    }
    const forgetId = e.target?.dataset?.shareforget;
    if (forgetId) {
      forgetShare(forgetId);
      return;
    }
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
        all = all.filter((x) => x.id !== del);
        expanded.delete(del);
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

  const csvCell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  /** Accepts the bundle format or a bare array of matches. */
  function parseBundle(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error("That file isn't valid JSON (" + err.message + ").");
    }
    if (Array.isArray(data)) return { matches: data, deckCards: {} };
    if (data && Array.isArray(data.matches)) {
      // A v1 bundle's `replays` key is ignored rather than rejected: its board
      // snapshots have no reader left, but its matches and logs are still good.
      return { matches: data.matches, deckCards: data.deckCards || {} };
    }
    // Be specific about what went wrong - "not an array" helps nobody.
    const looksLikeSummary =
      data &&
      (data.totalMatches !== undefined ||
        data.byOpponentChampion !== undefined ||
        data.winRate !== undefined);
    if (looksLikeSummary) {
      throw new Error(
        "This is a stats SUMMARY file — it holds totals like win rate and " +
          "per-champion records, but not the individual matches, so there is " +
          "nothing to import.\n\nYou want the export itself: look in Downloads " +
          "for riftatlas-archive-<date>.json, riftatlas-matches-<date>.json, " +
          "or riftatlas-backups/matches-<date>.json."
      );
    }
    const keys = Object.keys(data || {}).slice(0, 8).join(", ") || "(none)";
    throw new Error(
      'Unrecognised file: expected a Rift Atlas export with a "matches" array.\n\n' +
        "Top-level keys found: " + keys
    );
  }

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
            expanded.clear();
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
        expanded.clear();
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
      expanded.clear();
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

  /* Retention is the storage control. Recordings are never degraded, so what a
   * replay costs is fixed by the match; the only lever over total disk use is
   * how many matches keep one. The MB ceiling below is a runaway guard. */
  const KEEP_MIN = 1;
  const KEEP_MAX = 500;
  // Out-of-range values are clamped rather than rejected: the number input's
  // own min/max only constrain its spinner, not what can be typed or pasted.
  const clampKeep = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return defaultSettings.visualReplayKeepMatches;
    return Math.min(KEEP_MAX, Math.max(KEEP_MIN, n));
  };

  const CEILING_MIN_MB = 16;
  const CEILING_MAX_MB = 4096;
  // A blank field is the explicit "no limit" affordance and is stored as 0,
  // which the capture policy reads as uncapped. Anything else is clamped into
  // range, so the guard can never be set so low that it shapes normal capture.
  const clampCeiling = (v) => {
    if (v === "" || v === null || v === undefined) return 0;
    const mb = Math.round(Number(v));
    if (!Number.isFinite(mb)) return defaultSettings.visualReplayMaxMatchMb;
    if (mb <= 0) return 0;
    return Math.min(CEILING_MAX_MB, Math.max(CEILING_MIN_MB, mb));
  };

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
    if (changes.shares) refreshShares();
  });

  load();
})();
