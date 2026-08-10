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

  const analyse = (m) => window.RATrackerAnalysis.analyse(m);
  const $ = (s) => document.querySelector(s);
  const readOnly = () => archive !== null;

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
        chrome.storage.local.set(writes);
        console.info("[RA-Tracker] migrated %d inline logs to separate keys", inline.length);
      } else if (clean.length !== raw.length) {
        chrome.storage.local.set({ matches: clean });
      }
      clean.forEach((m) => delete m.log);
      all = clean.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
      buildFilterOptions();
      render();
      refreshBackupUI();
      refreshVisualSettingsUI();
      refreshShareSettingsUI();
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
      chrome.storage.local.remove(keys, () =>
        console.info("[RA-Tracker] removed %d obsolete snapshot replays", keys.length)
      );
    });
  }

  function persist(matches, then) {
    if (readOnly()) return;
    chrome.storage.local.set({ matches }, then || render);
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
      const matches = all.map((m) =>
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
  function deckSelect(m, cls) {
    const current = (m.deckName || "").trim();
    const opts = deckNames()
      .map(
        (d) =>
          `<option value="${esc(d)}" ${d === current ? "selected" : ""}>${esc(d)}</option>`
      )
      .join("");
    return `<select class="deck-select ${cls}" data-deck="${m.id}" title="${esc(deckTitle(m))}"
              ${readOnly() ? "disabled" : ""}>
        <option value="" ${current ? "" : "selected"}>— unlabelled —</option>
        ${opts}
        <option value="${NEW_DECK}">＋ New deck name…</option>
      </select>`;
  }

  function fillSelect(sel, values) {
    const current = sel.value;
    sel.length = 1;
    values.sort().forEach((v) => sel.add(new Option(v, v)));
    sel.value = current;
  }

  function filtered(includeUnknownAnyway) {
    const mc = $("#fMyChampion").value;
    const mode = $("#fMode").value;
    const deck = $("#fDeck").value;
    const inclUnknown = includeUnknownAnyway || $("#fUnknown").checked;
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
    $("#tGames").textContent = rows.length;
    $("#tWins").textContent = wins;
    $("#tLosses").textContent = losses;
    $("#tWinrate").textContent = decided ? Math.round((wins / decided) * 100) + "%" : "–";

    const durations = rows.map((m) => m.durationMs).filter((d) => Number.isFinite(d) && d > 0);
    $("#tDuration").textContent = durations.length
      ? fmtDuration(durations.reduce((a, b) => a + b, 0) / durations.length)
      : "–";

    renderAgg($("#vsTable tbody"), rows, (m) => champ(m.opponentChampion || m.opponentLegend));
    renderAgg($("#deckTable tbody"), rows, deckOf);
    renderAgg($("#myTable tbody"), rows, (m) => champ(m.myChampion || m.myLegend));
    renderHistory(filtered(true));
    renderVisualPanel();
    renderSharesPanel();
    renderArchiveBanner();
  }

  function renderArchiveBanner() {
    const b = $("#archiveBanner");
    if (!b) return;
    b.hidden = !archive;
    if (archive) {
      $("#archiveBannerText").textContent = `Viewing archive “${archive.name}” — ${archive.matches.length} matches, read-only. Your live data is untouched.`;
      $("#backupBanner").hidden = true; // not about the archive you're viewing
    }
    document.body.classList.toggle("read-only", readOnly());
  }

  function renderAgg(tbody, rows, keyFn) {
    const agg = new Map();
    for (const m of rows) {
      const k = keyFn(m);
      const a = agg.get(k) || { games: 0, w: 0, l: 0 };
      a.games++;
      if (m.result === "win") a.w++;
      if (m.result === "loss") a.l++;
      agg.set(k, a);
    }
    tbody.innerHTML = "";
    if (!agg.size) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No matches recorded yet.</td></tr>';
      return;
    }
    [...agg.entries()]
      .sort((a, b) => b[1].games - a[1].games)
      .forEach(([name, a]) => {
        const decided = a.w + a.l;
        const rate = decided ? a.w / decided : null;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${esc(name)}</td><td>${a.games}</td><td>${a.w}</td><td>${a.l}</td>
          <td><div class="bar-wrap"><div class="bar-track"><div class="bar" style="width:${
            rate === null ? 0 : Math.round(rate * 100)
          }%"></div></div><span class="pct">${rate === null ? "–" : Math.round(rate * 100) + "%"}</span></div></td>
          <td></td>`;
        tbody.appendChild(tr);
      });
  }

  const COLSPAN = 13;

  function renderHistory(rows) {
    ensureVisualIds();
    const tbody = $("#historyTable tbody");
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="${COLSPAN}" class="empty">No matches recorded yet. Play a match on play.riftatlas.com with the extension installed.</td></tr>`;
      return;
    }
    for (const m of rows) {
      const tr = document.createElement("tr");
      tr.className = "match-row";
      const d = m.startedAt ? new Date(m.startedAt) : null;
      const open = expanded.has(m.id);
      tr.innerHTML = `
        <td class="expander" data-toggle="${m.id}" title="Show game summary">${open ? "▾" : "▸"}</td>
        <td>${d ? d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–"}</td>
        <td>${esc(m.mode || "–")}</td>
        <td>${esc(m.roomCode || "–")}</td>
        <td>${esc(m.myChampion || m.myLegend || "–")}</td>
        <td class="deck-cell">${deckSelect(m, "deck-inline")}</td>
        <td>${esc(m.opponentName || "–")}</td>
        <td>${esc(m.opponentChampion || m.opponentLegend || "–")}</td>
        <td>${
          m.myScore == null && m.opponentScore == null
            ? "–"
            : `${m.myScore ?? 0}–${m.opponentScore ?? 0}`
        }</td>
        <td>${fmtDuration(m.durationMs)}</td>
        <td>
          <select data-id="${m.id}" class="result-edit result-${m.result || "unknown"}" ${readOnly() ? "disabled" : ""}>
            ${["win", "loss", "draw", "unknown"]
              .map((r) => `<option value="${r}" ${(m.result || "unknown") === r ? "selected" : ""}>${r}</option>`)
              .join("")}
          </select>
        </td>
        <td class="src-manual">${m.endedAt ? esc(m.resultSource || "") : "in game"}${
          m.notes ? ' <span class="note-dot" title="Has notes">•</span>' : ""
        }</td>
        <td>${readOnly() ? "" : `<button class="row-del" data-del="${m.id}" title="Delete match">✕</button>`}</td>`;
      tbody.appendChild(tr);
      if (open) tbody.appendChild(detailRow(m));
    }
  }

  function detailRow(m) {
    const tr = document.createElement("tr");
    tr.className = "detail-row";
    const td = document.createElement("td");
    td.colSpan = COLSPAN;

    if (!logCache.has(m.id)) {
      td.innerHTML = '<p class="coverage">Loading game log…</p>';
      tr.appendChild(td);
      getLog(m.id, () => render());
      return tr;
    }

    const withLog = Object.assign({}, m, { log: logCache.get(m.id) });
    const a = analyse(withLog);
    const metrics = a.hasLog
      ? `
      <table class="metrics">
        <thead><tr><th></th><th>You</th><th>Opponent</th></tr></thead>
        <tbody>
          <tr><td>Units committed to battlefields</td><td>${a.self.commit}</td><td>${a.opponent.commit}</td></tr>
          <tr><td>Battlefields conquered</td><td>${a.self.conquer}</td><td>${a.opponent.conquer}</td></tr>
          <tr><td>Points scored (from log)</td><td>${a.self.points}</td><td>${a.opponent.points}</td></tr>
          <tr><td>Cards sent to trash</td><td>${a.self.trash}</td><td>${a.opponent.trash}</td></tr>
          <tr><td>Showdown actions</td><td>${a.self.showdown}</td><td>${a.opponent.showdown}</td></tr>
          <tr><td>Focus passed</td><td>${a.self.passFocus}</td><td>${a.opponent.passFocus}</td></tr>
          <tr><td>Total logged actions</td><td>${a.self.total}</td><td>${a.opponent.total}</td></tr>
        </tbody>
      </table>
      <p class="coverage">Based on ${a.lines} log line${a.lines === 1 ? "" : "s"}${
          a.unmatched ? ` &middot; ${a.unmatched} line${a.unmatched === 1 ? "" : "s"} not recognised by the parser` : ""
        }. Turns: ${m.turns || "?"}.</p>`
      : `<p class="coverage">No game log was captured for this match.</p>`;

    td.innerHTML = `
      <div class="detail-grid">
        <div class="detail-col">
          <h3>Game summary</h3>
          <p class="verdict verdict-${a.verdict.toLowerCase().replace(/\s+/g, "-")}">${esc(a.verdict)}</p>
          <p class="verdict-detail">${esc(a.detail)}</p>
          ${metrics}
        </div>
        <div class="detail-col">
          <h3>Deck</h3>
          <div class="deck-row">
            ${deckSelect(m, "deck-wide")}
            ${readOnly() ? "" : `<button class="deck-apply" data-deckapply="${m.id}" title="Give every unlabelled match with this champion the same deck name">Apply to unlabelled ${esc(champ(m.myChampion || m.myLegend))} games</button>`}
          </div>
          <h3>Notes</h3>
          <textarea class="notes" data-notes="${m.id}" rows="6" ${readOnly() ? "readonly" : ""} placeholder="What happened? What would you do differently?">${esc(m.notes || "")}</textarea>
          <span class="save-state" data-savestate="${m.id}"></span>
          ${
            hasVisual(m.id)
              ? `<h3 class="log-head">Replay <button class="log-toggle" data-visual="${m.id}" title="Play the match back exactly as the site rendered it">open full screen</button>
                   <button class="log-toggle" data-share="${m.id}" title="Turn this replay into an encrypted link anyone can open">${shareOpen.has(m.id) ? "hide" : "share a link"}</button></h3>
                 <div class="share-box" data-sharebox="${m.id}" ${shareOpen.has(m.id) ? "" : "hidden"}>${shareBoxInner(m.id)}</div>`
              : ""
          }
          <h3 class="log-head">Game log <button class="log-toggle" data-log="${m.id}">show</button></h3>
          <div class="log-box" data-logbox="${m.id}" hidden>${
            (logCache.get(m.id) || [])
              .map(
                (e) =>
                  `<div class="log-line log-${e.actor}"><span class="log-t">${esc(e.t)}</span>${esc(e.text)}</div>`
              )
              .join("") || '<div class="log-line">No log captured.</div>'
          }</div>
        </div>
      </div>`;
    tr.appendChild(td);
    return tr;
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
    $("#visualTable tbody").innerHTML = records.map(visualRow).join("");

    const bytes = records.reduce((n, r) => n + (Number(r.compressedBytes) || 0), 0);
    const chunks = records.reduce((n, r) => n + (Number(r.chunkCount) || 0), 0);
    // What retention actually costs: every replay is captured at full fidelity,
    // so the mean is the only figure needed to price a different keep count.
    const mean = records.length ? bytes / records.length : 0;
    $("#visualTable tfoot").innerHTML = `
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
      </tr>`;
  }

  // ---- replay sharing --------------------------------------------------

  /* Turning a replay into a link is a one-way door. The link is a bearer token,
   * there is no revocation, and the object only goes away when the endpoint's
   * 7-day lifecycle rule removes it. So the Share button opens a panel that says
   * all of that first, and the upload is a second, deliberate click.
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
      body = `
        ${shareLinkRowHtml(s.link, matchId, {
          label: "this match",
          field: "sharelink",
          copy: "sharecopy",
          copyText: "Copy link",
        })}
        <p class="share-note">Uploaded and verified. Expires ${esc(expires.toLocaleDateString())}.</p>`;
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
  }

  function setShare(matchId, patch) {
    shareState.set(matchId, Object.assign({}, shareState.get(matchId), patch));
    paintShare(matchId);
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
    return {
      link: window.RAShareHosts.buildLink({ endpoint, objectId, keyBytes }),
      createdAt: record.createdAt,
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
        chrome.storage.local.set({ shares }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      })
    );
  }

  function beginShare(matchId) {
    // Every message this raises is shown inside the panel, so the panel has to
    // be open for any of them to be read. It always is - the button that gets
    // here lives in it - but nothing else guarantees that.
    shareOpen.add(matchId);
    if (shareBusy) {
      if (shareBusy !== matchId) {
        setShare(matchId, {
          phase: "idle",
          error: "Another replay is being shared right now. Wait for that one to finish.",
          retry: true,
        });
      }
      return;
    }
    const endpoint = shareEndpoint;
    const problem = endpointProblem(endpoint);
    if (problem) {
      setShare(matchId, { phase: "idle", error: problem, retry: true });
      return;
    }
    shareBusy = matchId;
    setShare(matchId, { phase: "preparing", link: null, error: null, retry: false });
    runShare(matchId, endpoint)
      .then(
        ({ link, createdAt }) => setShare(matchId, { phase: "done", link, createdAt, error: null }),
        (err) => {
          console.warn("[RA-Tracker] sharing failed:", err);
          setShare(matchId, Object.assign({ phase: "idle", link: null }, shareFailure(err)));
        }
      )
      // finally, not then: a throw inside either settle handler above would
      // otherwise leave shareBusy set for good, disabling sharing for every
      // match until the page is reloaded.
      .finally(() => {
        shareBusy = null;
      });
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

  /* The field is selected either way, so a blocked clipboard still leaves the
   * link ready for a manual copy rather than leaving the user with nothing.
   * The button says what happened and then goes back to whatever it said. */
  function copyLink(link, field, button) {
    if (field) {
      field.focus();
      field.select();
    }
    const label = button.textContent;
    const settle = (text) => {
      button.textContent = text;
      setTimeout(() => {
        if (button.isConnected) button.textContent = label;
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(() => settle("Copied"), () => settle("Press Ctrl+C"));
      return;
    }
    settle("Press Ctrl+C");
  }

  function copyShareLink(matchId, button) {
    const s = shareState.get(matchId);
    if (!s || !s.link) return;
    copyLink(s.link, document.querySelector(`[data-sharelink="${CSS.escape(matchId)}"]`), button);
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

  function shareLinkOf(record) {
    return window.RAShareHosts.buildLink({
      endpoint: record.endpoint,
      objectId: record.objectId,
      keyBytes: window.RAShareHosts.fromBase64Url(record.key),
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
    $("#sharesTable tbody").innerHTML = shares.length
      ? shares.map((r) => shareListRow(r, now)).join("")
      : `<tr><td colspan="5" class="empty">No share links have been created from this browser.
           Open a match with a replay and choose “share a link”.</td></tr>`;
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
    const ok = confirm(
      "Remove this expired share from the list?\n\n" +
        "This forgets the local record only. It cannot delete the copy on the endpoint — that " +
        "expired on its own, and the endpoint deletes it within about a day of expiring.\n\n" +
        "The record is the only place this share's decryption key is kept, so the link can't be " +
        "rebuilt afterwards."
    );
    if (!ok) return;
    chrome.storage.local.get({ shares: [] }, (data) => {
      // Pruned on this write like any other. Everything it removes alongside
      // the chosen record is a share whose object the endpoint deleted days
      // ago, so no row disappears that could still have been opened.
      //
      // Same non-atomic get-then-set as rememberShare, and the same race with a
      // second dashboard tab. See the note there.
      const kept = SHARE.pruneShares(data.shares, Date.now()).filter(
        (s) => !(s && s.objectId === objectId)
      );
      chrome.storage.local.set({ shares: kept }, () => {
        void chrome.runtime.lastError;
        recheckState.delete(objectId);
        refreshShares();
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

  function refreshShareSettingsUI() {
    getSettings((s) => {
      shareEndpoint = cleanEndpoint(s.shareEndpoint);
      $("#shareEndpoint").value = shareEndpoint;
    });
  }

  $("#shareEndpoint").addEventListener("change", (e) => {
    const next = cleanEndpoint(e.target.value);
    e.target.value = next; // show what was actually stored
    getSettings((s) => {
      s.shareEndpoint = next;
      setSettings(s, refreshShareSettingsUI);
    });
  });

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
      const typed = prompt("Name this deck:", m.deckName || "");
      // Cancelled: put the picker back where it was rather than leaving it
      // showing the "new name" entry.
      if (typed === null || !typed.trim()) return render();
      return setDeckName(m, typed);
    }
    if (["fMyChampion", "fMode", "fDeck", "fUnknown"].includes(t.id)) render();
  });

  /** Name a match's deck by hand, from either deck picker. */
  function setDeckName(m, name) {
    m.deckName = name.trim();
    // Marked manual either way: clearing it is a decision too, and it stops the
    // tracker re-detecting a name onto a match that is still running.
    m.deckSource = "manual";
    chrome.storage.local.set({ matches: all }, () => {
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
        chrome.storage.local.set({ matches: all }, () => {
          if (state) {
            state.textContent = "saved";
            setTimeout(() => (state.textContent = ""), 1500);
          }
        });
      }, 500)
    );
  });

  document.addEventListener("click", (e) => {
    const toggle = e.target?.dataset?.toggle;
    if (toggle) {
      if (expanded.has(toggle)) expanded.delete(toggle);
      else expanded.add(toggle);
      render();
      return;
    }
    const visualId = e.target?.dataset?.visual;
    if (visualId) {
      const m = all.find((x) => x.id === visualId) || { id: visualId };
      chrome.runtime.sendMessage({ type: "ra:visual:get", matchId: visualId }, (reply) => {
        const payload = chrome.runtime.lastError || !reply || !reply.ok ? null : reply.replay;
        if (!payload || !payload.events || !payload.events.length) {
          alert("The replay for this match could not be read.");
          return;
        }
        window.RATrackerVisualReplay.openModal(m, payload);
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
      beginShare(shareGoId);
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
        copyLink(
          shareLinkOf(record),
          document.querySelector(`[data-sharelistlink="${CSS.escape(listCopyId)}"]`),
          e.target
        );
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
    const logId = e.target?.dataset?.log;
    if (logId) {
      const box = document.querySelector(`[data-logbox="${CSS.escape(logId)}"]`);
      if (box) {
        box.hidden = !box.hidden;
        e.target.textContent = box.hidden ? "show" : "hide";
      }
      return;
    }
    const applyId = e.target?.dataset?.deckapply;
    if (applyId && !readOnly()) {
      const src = all.find((x) => x.id === applyId);
      // The picker commits on change, so the record is already the truth.
      const name = (src?.deckName || "").trim();
      if (!name) return alert("Give this match a deck name first.");
      const champion = champ(src.myChampion || src.myLegend);
      const targets = all.filter(
        (m) => champ(m.myChampion || m.myLegend) === champion && !(m.deckName || "").trim()
      );
      if (!targets.length) return alert(`No unlabelled ${champion} matches to update.`);
      if (!confirm(`Label ${targets.length} unlabelled ${champion} match${targets.length === 1 ? "" : "es"} as “${name}”?`)) return;
      targets.forEach((m) => { m.deckName = name; m.deckSource = "manual"; });
      chrome.storage.local.set({ matches: all }, () => { buildFilterOptions(); render(); });
      return;
    }
    const del = e.target?.dataset?.del;
    if (del && !readOnly() && confirm("Delete this match record?")) {
      all = all.filter((x) => x.id !== del);
      expanded.delete(del);
      logCache.delete(del);
      chrome.storage.local.remove(["deckcards_" + del, "log_" + del]);
      forgetVisual(del);
      persist(all, () => { buildFilterOptions(); render(); });
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
  $("#bulkLabel").addEventListener("click", () => {
    if (readOnly()) return;
    const champFilter = $("#fMyChampion").value;
    const targets = all.filter(
      (m) =>
        !(m.deckName || "").trim() &&
        (!champFilter || champ(m.myChampion || m.myLegend) === champFilter)
    );
    if (!targets.length) return alert("Every match already has a deck name.");
    const scope = champFilter ? `${targets.length} unlabelled ${champFilter} match` : `${targets.length} unlabelled match`;
    const name = prompt(
      `Deck name for ${scope}${targets.length === 1 ? "" : "es"}?\n\n` +
        `Tip: set the "My champion" filter first to label one champion at a time.`,
      ""
    );
    if (name === null) return;
    const clean = name.trim();
    if (!clean) return;
    targets.forEach((m) => { m.deckName = clean; m.deckSource = "manual"; });
    chrome.storage.local.set({ matches: all }, () => {
      buildFilterOptions();
      render();
      alert(`Labelled ${targets.length} match${targets.length === 1 ? "" : "es"} as “${clean}”.`);
    });
  });

  // Recognise decks from the cards actually played.
  $("#autoDeck").addEventListener("click", () => {
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
        return alert(
          "No usable card data yet.\n\nDeck recognition compares the cards you actually played, " +
            `so it needs matches where at least ${FP.MIN_CARDS} of your own cards were seen on the board.`
        );
      }
      const { proposals, undecided, labelledCount } = FP.suggestLabels(all, prints);

      if (!labelledCount) {
        // Nothing labelled yet: group them instead and let the user name each.
        const clusters = FP.clusterDecks(all, prints);
        if (!clusters.length) return alert("Not enough card data to group these matches yet.");
        const lines = clusters
          .map((c, i) => `  Group ${i + 1}: ${c.size} match${c.size === 1 ? "" : "es"} (${c.cards} distinct cards)`)
          .join("\n");
        const ok = confirm(
          `Found ${clusters.length} distinct deck${clusters.length === 1 ? "" : "s"} by card overlap:\n\n${lines}\n\n` +
            `Name them now? You'll be asked for each group in turn.`
        );
        if (!ok) return;
        let named = 0;
        clusters.forEach((c, i) => {
          const name = prompt(
            `Name for group ${i + 1} — ${c.size} match${c.size === 1 ? "" : "es"}, ${c.cards} distinct cards:`,
            ""
          );
          const clean = (name || "").trim();
          if (!clean) return;
          const ids = new Set(c.ids);
          all.forEach((m) => { if (ids.has(m.id)) { m.deckName = clean; m.deckSource = "fingerprint"; } });
          named += c.size;
        });
        if (!named) return;
        chrome.storage.local.set({ matches: all }, () => {
          buildFilterOptions();
          render();
          alert(`Labelled ${named} matches.`);
        });
        return;
      }

      if (!proposals.length) {
        return alert(
          `No confident matches found.\n\n${undecided.length} match${undecided.length === 1 ? "" : "es"} couldn't be placed:\n` +
            undecided.slice(0, 6).map((u) => `  • ${u.reason}`).join("\n")
        );
      }
      const byDeck = {};
      proposals.forEach((p) => { byDeck[p.deck] = (byDeck[p.deck] || 0) + 1; });
      const summary = Object.entries(byDeck)
        .map(([d, n]) => `  ${n} × “${d}”`)
        .join("\n");
      const avg = Math.round((proposals.reduce((a, p) => a + p.score, 0) / proposals.length) * 100);
      const ok = confirm(
        `Matched ${proposals.length} unlabelled game${proposals.length === 1 ? "" : "s"} to your named decks ` +
          `(avg ${avg}% card overlap):\n\n${summary}\n\n` +
          (undecided.length ? `${undecided.length} left unlabelled (too little data or no clear match).\n\n` : "") +
          `Apply these labels?`
      );
      if (!ok) return;
      const byId = new Map(proposals.map((p) => [p.match.id, p.deck]));
      all.forEach((m) => { if (byId.has(m.id)) { m.deckName = byId.get(m.id); m.deckSource = "fingerprint"; } });
      chrome.storage.local.set({ matches: all }, () => {
        buildFilterOptions();
        render();
      });
    });
  });

  $("#exportJson").addEventListener("click", () => {
    buildBundle(true, (bundle) =>
      download(`riftatlas-matches-${stamp()}.json`, JSON.stringify(bundle, null, 2), "application/json")
    );
  });

  $("#exportCsv").addEventListener("click", () => {
    buildBundle(false, (bundle) => {
      const cols = ["startedAt","endedAt","durationMs","mode","roomCode","myName","opponentName","myLegend","myChampion","opponentLegend","opponentChampion","myScore","opponentScore","turns","result","resultSource","endReason","deckName","deckSource","notes"];
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
      chrome.storage.local.set(writes, cb);
    });
  }

  $("#importJson").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        const bundle = parseBundle(text);
        writeBundleToStorage(bundle, () => {
          archive = null;
          logCache.clear();
          load();
          alert(`Imported ${bundle.matches.length} matches into your live data.`);
        });
      } catch (err) {
        alert("Import failed: " + err.message);
      }
    });
    e.target.value = "";
  });

  // Archive & clear: download everything, then wipe local storage.
  $("#archiveClear").addEventListener("click", () => {
    if (readOnly()) return;
    if (!all.length) return alert("There are no matches to archive.");
    buildBundle(true, (bundle) => {
      const json = JSON.stringify(bundle, null, 2);
      const sizeMb = (new Blob([json]).size / 1048576).toFixed(1);
      download(`riftatlas-archive-${stamp()}.json`, json, "application/json");
      setTimeout(() => {
        const ok = confirm(
          `Archive downloaded (${bundle.matches.length} matches, ${sizeMb} MB).\n\n` +
            `Check it's in your Downloads folder, then press OK to CLEAR all matches, logs, card data and share links from the extension.\n\n` +
            `You can view it again any time with "View archive", or restore it with Import JSON.\n\n` +
            `The archive does not carry share links: any share still on the endpoint keeps being served until it expires, but the record here is the only copy of the key that opens it.\n\n` +
            `Press Cancel to keep everything.`
        );
        if (!ok) return;
        chrome.storage.local.get(null, (data) => {
          // "shares" goes with the rest: each record holds a decryption key,
          // and a wipe that leaves every key a browser ever made behind is not
          // the clean slate the button offers.
          const keys = Object.keys(data || {}).filter(
            (k) => k === "shares" || k.startsWith("deckcards_") || k.startsWith("log_")
          );
          chrome.storage.local.remove(keys, () => {
            all = [];
            expanded.clear();
            logCache.clear();
            forgetAllVisual();
            chrome.storage.local.set({ matches: [] }, () => {
              buildFilterOptions();
              render();
              alert("Local data cleared. The archive file has everything.");
            });
          });
        });
      }, 800);
    });
  });

  // View archive: render a file read-only without touching stored data.
  $("#viewArchive").addEventListener("click", () => {
    if (archive) {
      archive = null;
      logCache.clear();
      $("#viewArchive").textContent = "View archive";
      load();
      return;
    }
    $("#archiveFile").click();
  });
  $("#archiveFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        const bundle = parseBundle(text);
        archive = { name: file.name, matches: bundle.matches, deckCards: bundle.deckCards };
        logCache.clear();
        expanded.clear();
        $("#viewArchive").textContent = "Exit archive";
        load();
      } catch (err) {
        alert("Could not read archive: " + err.message);
      }
    });
    e.target.value = "";
  });
  $("#archiveExit").addEventListener("click", () => {
    archive = null;
    logCache.clear();
    $("#viewArchive").textContent = "View archive";
    load();
  });

  $("#clearAll").addEventListener("click", () => {
    if (readOnly()) return;
    if (confirm(
      "Delete ALL recorded matches, logs, replays and share links? " +
        "Any share already uploaded keeps being served until it expires, but the key that opens it is kept only here. " +
        "Consider using Archive & clear instead, which saves a copy first."
    )) {
      all = [];
      expanded.clear();
      logCache.clear();
      forgetAllVisual();
      chrome.storage.local.get(null, (data) => {
        const keys = Object.keys(data || {}).filter(
          (k) => k === "shares" || k.startsWith("deckcards_") || k.startsWith("log_")
        );
        if (keys.length) chrome.storage.local.remove(keys);
      });
      persist(all, () => { buildFilterOptions(); render(); });
    }
  });

  // ---- backups ---------------------------------------------------------

  const DAY_MS = 86400000;
  // The recorder reads visualReplay* out of this same object at match start,
  // and the service worker reads the retention count out of it at every gc.
  // shareEndpoint is a public URL, not a secret - see share/config.js. It is a
  // setting so a self-hoster can point the extension at their own instance
  // without editing code. There is deliberately no TTL setting: expiry is a
  // bucket-wide lifecycle rule, not a property of a share.
  const defaultSettings = {
    autoBackup: false, lastBackup: 0, bannerDismissed: 0,
    visualReplayEnabled: true, visualReplayKeepMatches: 25, visualReplayMaxMatchMb: 512,
    shareEndpoint: window.RAShareConfig.DEFAULT_SHARE_ENDPOINT,
  };

  const getSettings = (cb) =>
    chrome.storage.local.get({ settings: defaultSettings }, (d) =>
      cb(Object.assign({}, defaultSettings, d.settings || {}))
    );
  const setSettings = (s, cb) => chrome.storage.local.set({ settings: s }, cb || (() => {}));

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
        $("#autoBackup").checked = !!(s.autoBackup && granted);
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
      $("#backupBannerText").textContent = never
        ? `You have ${all.length} matches stored only inside this extension. Removing it — or loading it from a different folder — wipes them. Save a backup.`
        : `Your last backup was ${new Date(s.lastBackup).toLocaleDateString()}. Matches since then exist only inside this extension.`;
    }
  }

  const requestBackupPermission = (cb) =>
    chrome.permissions.request({ permissions: ["downloads"] }, cb);

  $("#autoBackup").addEventListener("change", (e) => {
    const on = e.target.checked;
    if (!on) {
      getSettings((s) => { s.autoBackup = false; setSettings(s, refreshBackupUI); });
      return;
    }
    requestBackupPermission((granted) => {
      if (!granted) {
        e.target.checked = false;
        alert("Downloads permission is needed to save backup files automatically.");
        return;
      }
      getSettings((s) => {
        s.autoBackup = true;
        setSettings(s, () => writeBackup(() => refreshBackupUI()));
      });
    });
  });

  $("#bannerBackup").addEventListener("click", () => {
    chrome.permissions.contains({ permissions: ["downloads"] }, (granted) => {
      const go = () =>
        writeBackup((err) => {
          if (err) buildBundle(false, (b) =>
            download(`riftatlas-matches-${stamp()}.json`, JSON.stringify(b, null, 2), "application/json")
          );
          $("#backupBanner").hidden = true;
        });
      if (granted) return go();
      requestBackupPermission((ok) => {
        if (ok) return go();
        buildBundle(false, (b) =>
          download(`riftatlas-matches-${stamp()}.json`, JSON.stringify(b, null, 2), "application/json")
        );
        $("#backupBanner").hidden = true;
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
    keep.min = String(KEEP_MIN);
    keep.max = String(KEEP_MAX);
    ceiling.min = String(CEILING_MIN_MB);
    ceiling.max = String(CEILING_MAX_MB);
    getSettings((s) => {
      $("#visualEnabled").checked = s.visualReplayEnabled !== false;
      keepMatches = clampKeep(s.visualReplayKeepMatches);
      keep.value = keepMatches;
      const mb = clampCeiling(s.visualReplayMaxMatchMb);
      ceiling.value = mb > 0 ? mb : ""; // blank, not 0, is what "no limit" looks like
      // The panel projects disk use from the retention count, so it has to be
      // redrawn whenever that number changes.
      renderVisualPanel();
    });
  }

  $("#visualEnabled").addEventListener("change", (e) => {
    const on = e.target.checked;
    getSettings((s) => {
      s.visualReplayEnabled = on;
      setSettings(s);
    });
  });

  $("#visualKeep").addEventListener("change", (e) => {
    const n = clampKeep(e.target.value);
    e.target.value = n; // show what was actually stored, clamp included
    getSettings((s) => {
      s.visualReplayKeepMatches = n;
      setSettings(s, refreshVisualSettingsUI);
    });
  });

  $("#visualCeiling").addEventListener("change", (e) => {
    const mb = clampCeiling(e.target.value);
    e.target.value = mb > 0 ? mb : "";
    getSettings((s) => {
      s.visualReplayMaxMatchMb = mb;
      setSettings(s);
    });
  });

  $("#bannerDismiss").addEventListener("click", () => {
    getSettings((s) => {
      s.bannerDismissed = Date.now();
      setSettings(s, () => { $("#backupBanner").hidden = true; });
    });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (archive) return; // never let live writes disturb an archive view
    const busy = document.activeElement?.dataset;
    if (changes.matches && !busy?.notes && !busy?.deck) load();
    // A share created in the row above writes this key, so the list picks the
    // new link up without a reload.
    if (changes.shares) refreshShares();
  });

  load();
})();
