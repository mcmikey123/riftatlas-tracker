/* Rift Atlas Stats Tracker - dashboard */
(() => {
  "use strict";

  // `all` holds LEAN match records: game logs live in log_<id> keys and
  // replays in replay_<id> keys, so the array rewritten during live games
  // stays ~0.5 KB per match instead of ~21 KB.
  let all = [];
  const logCache = new Map(); // id -> log[]
  const expanded = new Set();
  // When viewing an archive file we render from memory and never write.
  let archive = null; // { name, matches, replays, logs }

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

  function getReplay(id, cb) {
    if (archive) return cb((archive.replays && archive.replays[id]) || null);
    const key = "replay_" + id;
    chrome.storage.local.get(key, (r) => cb((r && r[key] && r[key].snaps) || null));
  }

  /** Full portable bundle: matches with logs inline, optionally replays. */
  function buildBundle(includeReplays, cb) {
    if (archive) {
      return cb({
        format: "riftatlas-tracker-archive",
        version: 1,
        exportedAt: new Date().toISOString(),
        matches: archive.matches,
        replays: includeReplays ? archive.replays || {} : {},
      });
    }
    chrome.storage.local.get(null, (data) => {
      const matches = all.map((m) =>
        Object.assign({}, m, { log: ((data["log_" + m.id] || {}).log) || [] })
      );
      const replays = {};
      if (includeReplays) {
        for (const m of all) {
          const r = data["replay_" + m.id];
          if (r && r.snaps) replays[m.id] = r.snaps;
        }
      }
      cb({
        format: "riftatlas-tracker-archive",
        version: 1,
        exportedAt: new Date().toISOString(),
        matches,
        replays,
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
          <h3 class="log-head">Replay <button class="log-toggle" data-replay="${m.id}">open full screen</button></h3>
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

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
    const replayId = e.target?.dataset?.replay;
    if (replayId) {
      const m = all.find((x) => x.id === replayId) || {};
      getReplay(replayId, (snaps) => {
        if (!snaps || !snaps.length) {
          alert("No replay was captured for this match.\n\nReplays are recorded for games played with v0.3.0 or later.");
          return;
        }
        window.RATrackerReplay.openModal(m, snaps);
      });
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
      chrome.storage.local.remove(["replay_" + del, "log_" + del]);
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

  // Recognise decks from the cards actually played, using the replays.
  $("#autoDeck").addEventListener("click", () => {
    if (readOnly()) return;
    const FP = window.RATrackerFingerprint;
    chrome.storage.local.get(null, (data) => {
      const prints = new Map();
      for (const m of all) {
        const r = data["replay_" + m.id];
        prints.set(m.id, FP.fingerprint(r && r.snaps));
      }
      const withReplay = [...prints.values()].filter((s) => s.size >= FP.MIN_CARDS).length;
      if (!withReplay) {
        return alert(
          "No usable replays yet.\n\nDeck recognition compares the cards you actually played, " +
            "so it needs matches recorded with replays (v0.3.0 or later)."
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
    if (Array.isArray(data)) return { matches: data, replays: {} };
    if (data && Array.isArray(data.matches)) {
      return { matches: data.matches, replays: data.replays || {} };
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
      for (const [id, snaps] of Object.entries(bundle.replays || {})) {
        if (snaps && snaps.length) writes["replay_" + id] = { id, snaps };
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
            `Check it's in your Downloads folder, then press OK to CLEAR all matches, logs and replays from the extension.\n\n` +
            `You can view it again any time with "View archive", or restore it with Import JSON.\n\n` +
            `Press Cancel to keep everything.`
        );
        if (!ok) return;
        chrome.storage.local.get(null, (data) => {
          const keys = Object.keys(data || {}).filter(
            (k) => k.startsWith("replay_") || k.startsWith("log_")
          );
          chrome.storage.local.remove(keys, () => {
            all = [];
            expanded.clear();
            logCache.clear();
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
        archive = { name: file.name, matches: bundle.matches, replays: bundle.replays };
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
    if (confirm("Delete ALL recorded matches, logs and replays? Consider using Archive & clear instead, which saves a copy first.")) {
      all = [];
      expanded.clear();
      logCache.clear();
      chrome.storage.local.get(null, (data) => {
        const keys = Object.keys(data || {}).filter(
          (k) => k.startsWith("replay_") || k.startsWith("log_")
        );
        if (keys.length) chrome.storage.local.remove(keys);
      });
      persist(all, () => { buildFilterOptions(); render(); });
    }
  });

  // ---- backups ---------------------------------------------------------

  const DAY_MS = 86400000;
  const defaultSettings = { autoBackup: false, lastBackup: 0, bannerDismissed: 0 };

  const getSettings = (cb) =>
    chrome.storage.local.get({ settings: defaultSettings }, (d) =>
      cb(Object.assign({}, defaultSettings, d.settings || {}))
    );
  const setSettings = (s, cb) => chrome.storage.local.set({ settings: s }, cb || (() => {}));

  function writeBackup(cb) {
    if (!all.length) return cb && cb(new Error("nothing to back up"));
    // Backups carry matches + logs (small); replays are excluded to keep the
    // daily file sane - use Archive & clear if you want replays too.
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
  });

  load();
})();
