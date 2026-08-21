/* Rift Atlas Stats Tracker - toolbar popup
 *
 * A read-only glance at the live data: whether a match is being recorded right
 * now, how today has gone, who you are about to play and how that has gone
 * before, and the way to the dashboard.
 *
 * It writes nothing about your matches - not a setting, not a series
 * regrouping, not a backup - so opening the icon can never change what the
 * dashboard will show. The ONE thing it saves is the matchup note you type
 * into it, under its own `matchupNotes` key: notes exist to be read right
 * before a game, so right before a game is where they are written too.
 *
 * Archive mode is deliberately absent. Viewing an archive file is a state of one
 * dashboard tab, held in that page's memory and never written to storage, so the
 * popup always reads live records and has nothing to opt out of.
 *
 * Formatting is shared with the dashboard via dashboard/format.js, loaded first
 * in popup.html. Nothing here reimplements an escaper or a clock.
 */
(function () {
  "use strict";

  const F = window.RATrackerFormat;
  const { esc, champ, fmtBytes, fmtDuration, fmtPercent, fmtScore } = F;

  /* How long an unfinished match stays believable as "in game now".
   *
   * content.js only stamps `endedAt` on beforeunload. A tab that is force-
   * killed, crashes, or is closed while the machine is suspending never runs
   * that handler, so its match keeps `endedAt: null` FOREVER. Without a cutoff
   * the popup would show a match from last Tuesday as live for the rest of the
   * install's life. Three hours is longer than any real match and short enough
   * that a dead one is gone by the next sitting; past it we fall through to the
   * idle state and show the last finished match instead. */
  const LIVE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

  const DEFAULT_SETTINGS = { visualReplayEnabled: true, visualReplayKeepMatches: 25 };

  /* How long a champion seen in a lobby or mulligan stays worth scouting.
   * content.js restamps `pendingOpponent` every half minute while they are on
   * screen, so anything older than this is a game that never happened or one
   * that is long over - not tonight's opponent. */
  const PENDING_MAX_AGE_MS = 45 * 60 * 1000;

  const $ = (id) => document.getElementById(id);

  const ms = (iso) => {
    const t = Date.parse(iso || "");
    return Number.isFinite(t) ? t : null;
  };

  // Newest first. Everything below reads in this order, so it is done once.
  function byNewest(matches) {
    return (matches || [])
      .filter((m) => m && m.id)
      .slice()
      .sort((a, b) => {
        const at = ms(a.startedAt);
        const bt = ms(b.startedAt);
        if (at !== null && bt !== null && at !== bt) return bt - at;
        if (at === null) return 1;
        if (bt === null) return -1;
        return String(b.id).localeCompare(String(a.id));
      });
  }

  /* Only a win or a loss is a decided match. A draw, an "unknown" and a match
   * the result reader never managed to call are all "no verdict", and the
   * difference between them matters to the dashboard, not here. */
  const isDecided = (m) => m && (m.result === "win" || m.result === "loss");

  const sameLocalDay = (t, now) => {
    const a = new Date(t);
    const b = new Date(now);
    return (
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    );
  };

  /** Wins and losses among matches started on the current local calendar day. */
  function today(ordered, now) {
    let wins = 0;
    let losses = 0;
    for (const m of ordered) {
      const t = ms(m.startedAt);
      if (t === null || !sameLocalDay(t, now)) continue;
      if (m.result === "win") wins++;
      else if (m.result === "loss") losses++;
    }
    return { wins, losses };
  }

  /* Null rather than 0 when nothing is decided, so the tile renders "–" instead
   * of claiming a 0% win rate nobody earned. Same rule the dashboard's tiles
   * follow. */
  function allTimeRate(ordered) {
    let wins = 0;
    let losses = 0;
    for (const m of ordered) {
      if (m.result === "win") wins++;
      else if (m.result === "loss") losses++;
    }
    return wins + losses ? wins / (wins + losses) : null;
  }

  /**
   * The current run of consecutive same results, counting back from the most
   * recent decided match.
   *
   * Undecided matches are skipped rather than counted as a break: a drawn game
   * or one whose result was never read is not evidence that a winning run
   * ended, and letting it zero the streak would make the number depend on how
   * well the result reader happened to be doing that evening.
   *
   * Returns null when nothing has been decided at all.
   */
  function streak(ordered) {
    let result = null;
    let count = 0;
    for (const m of ordered) {
      if (!isDecided(m)) continue;
      if (result === null) result = m.result;
      else if (m.result !== result) break;
      count++;
    }
    return result === null ? null : { result, count };
  }

  /**
   * The match being played right now, or null.
   *
   * An unfinished match older than the staleness cutoff is treated as never
   * having ended properly and is not offered as live - see LIVE_MAX_AGE_MS.
   */
  function liveMatch(ordered, now) {
    for (const m of ordered) {
      if (m.endedAt) continue;
      const t = ms(m.startedAt);
      if (t === null || now - t > LIVE_MAX_AGE_MS) continue;
      return m;
    }
    return null;
  }

  const lastFinished = (ordered) => ordered.find((m) => m.endedAt) || null;

  const who = (m) => esc(champ(m.myChampion || m.myLegend)) + " vs " + esc(champ(m.opponentChampion || m.opponentLegend));

  /** `Ranked · 4–3 · 8:12`, with anything unrecorded left out rather than dashed. */
  function meta(parts) {
    return parts.filter(Boolean).join(" · ");
  }

  function renderNow(m, now, live) {
    // fmtDuration, not a bespoke m:ss: it is already the shared clock, and past
    // the hour it widens to h:mm:ss rather than reporting a 190-minute match as
    // "190:04". The staleness cutoff keeps that to at most three hours.
    const elapsed = live ? fmtDuration(now - ms(m.startedAt), "") : fmtDuration(m.durationMs, "");
    const clock = elapsed ? (live ? elapsed + " elapsed" : elapsed) : "";
    return `
      <div class="now">
        <div class="label">${live ? "In game now" : "Last match"}</div>
        <div class="now-who">${who(m)}</div>
        <div class="now-meta">${esc(meta([m.mode, fmtScore(m), clock]))}</div>
      </div>`;
  }

  function renderTiles(ordered, now) {
    const t = today(ordered, now);
    const s = streak(ordered);
    const streakText = s ? s.count + " " + (s.result === "win" ? "W" : "L") : "–";
    return `
      <div class="tiles">
        <div class="tile">
          <div class="label">Today</div>
          <div class="tile-value"><span class="win">${t.wins}</span> – <span class="loss">${t.losses}</span></div>
        </div>
        <div class="tile">
          <div class="label">All time</div>
          <div class="tile-value">${fmtPercent(allTimeRate(ordered))}</div>
        </div>
        <div class="tile">
          <div class="label">Streak</div>
          <div class="tile-value">${streakText}</div>
        </div>
      </div>`;
  }

  // ---- scouting ---------------------------------------------------------

  /**
   * Which champion to scout: the live match's opponent, else whoever the
   * content script recently saw across the table on a pregame screen. Null
   * when there is nobody current - a scout line about last week's opponent
   * would be noise wearing the clothes of a warning.
   */
  function scoutTarget(live, pending, now) {
    if (live) {
      const name = champ(live.opponentChampion || live.opponentLegend);
      return name === "Unknown" ? null : { name, live: true };
    }
    if (pending && Number.isFinite(pending.at) && now - pending.at < PENDING_MAX_AGE_MS) {
      const name = champ(pending.champion || pending.legend);
      return name === "Unknown" ? null : { name, live: false };
    }
    return null;
  }

  /** Your history against one champion: record, rate, and the last few results. */
  function scoutRecord(ordered, name) {
    const vs = ordered.filter((m) => champ(m.opponentChampion || m.opponentLegend) === name);
    let wins = 0;
    let losses = 0;
    const lastFive = [];
    for (const m of vs) {
      if (m.result === "win") wins++;
      else if (m.result === "loss") losses++;
      else continue;
      if (lastFive.length < 5) lastFive.push(m.result);
    }
    return { games: vs.length, wins, losses, rate: wins + losses ? wins / (wins + losses) : null, lastFive };
  }

  function renderScout(ordered, target, note) {
    const r = scoutRecord(ordered, target.name);
    const dots = r.lastFive.length
      ? `<span class="scout-dots" title="Your last ${r.lastFive.length} decided against ${esc(target.name)}, newest first">${r.lastFive
          .map((x) => `<span class="recent-dot dot-${x}"></span>`)
          .join("")}</span>`
      : "";
    const record = r.wins + r.losses
      ? `<span class="win">${r.wins}</span>–<span class="loss">${r.losses}</span> · ${fmtPercent(r.rate)}`
      : "first meeting";
    return `
      <div class="scout">
        <div class="label">${target.live ? "Scouting · in game" : "Scouting · up next"}</div>
        <div class="scout-line"><span class="scout-who">vs ${esc(target.name)}</span>
          <span class="scout-record">${record}</span>${dots}</div>
        <textarea class="scout-note" data-scout-note="${esc(target.name)}" rows="2"
          placeholder="Matchup note — shows here whenever you face ${esc(target.name)}">${esc(note || "")}</textarea>
      </div>`;
  }

  /* The three most recent matches other than the one already shown above, so a
   * live match is not reported twice with two different faces. */
  function renderRecent(ordered, live) {
    const rows = ordered.filter((m) => m !== live).slice(0, 3);
    if (!rows.length) return "";
    const kinds = { win: "win", loss: "loss", draw: "draw" };
    return `
      <div class="recent">
        <div class="label">Last three</div>
        ${rows
          .map(
            (m) => `<div class="recent-row">
          <span class="recent-dot dot-${kinds[m.result] || "unknown"}"></span>
          <span class="recent-who">vs ${esc(champ(m.opponentChampion || m.opponentLegend))}</span>
          <span class="recent-score">${esc(fmtScore(m))}</span>
        </div>`
          )
          .join("")}
      </div>`;
  }

  function render(matches, now, pending, notes) {
    const ordered = byNewest(matches);
    const live = liveMatch(ordered, now);
    const target = scoutTarget(live, pending, now);
    const scout = target ? renderScout(ordered, target, (notes || {})[target.name]) : "";
    if (!ordered.length) {
      $("state").innerHTML =
        scout +
        '<p class="empty">Play a match on play.riftatlas.com with the extension installed.</p>';
      return;
    }
    // A history made up entirely of matches that never ended and have since gone
    // stale has no live match and no finished one; the head block is dropped
    // rather than invented, and the figures below still stand.
    const head = live || lastFinished(ordered);
    $("state").innerHTML =
      (head ? renderNow(head, now, head === live) + '<div class="divider"></div>' : "") +
      scout +
      renderTiles(ordered, now) +
      renderRecent(ordered, live);
  }

  /* "Recording" is the visual replay setting, not whether a match happens to be
   * open: it answers "will the next match be captured", which is the thing
   * someone opens the popup to check after turning it off. */
  function renderStatus(settings) {
    const on = settings.visualReplayEnabled !== false;
    const status = $("status");
    status.className = "status " + (on ? "on" : "off");
    $("statusText").textContent = on ? "recording" : "not recording";
    status.hidden = false;
  }

  /* Disk cost is the compressed replays plus the shared stylesheet assets - the
   * same two halves the dashboard's diagnostics panel adds up. The service
   * worker may be asleep, the database may be unreadable, and neither is worth
   * an error in a popup: the sentence is simply left off. */
  function renderFootprint() {
    try {
      chrome.runtime.sendMessage({ type: "ra:visual:list" }, (reply) => {
        void chrome.runtime.lastError;
        if (!reply || !reply.ok) return;
        let bytes = ((reply.assets || {}).bytes) || 0;
        for (const r of reply.replays || []) bytes += Number(r.compressedBytes) || 0;
        if (!bytes) return;
        $("foot").textContent = "Local to this browser. " + fmtBytes(bytes) + " of replays kept.";
      });
    } catch (_) {
      /* no service worker to answer; the footer keeps its shorter form */
    }
  }

  $("open").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
    // The tab has the focus now; leaving the popup up behind it just makes the
    // user dismiss it.
    window.close();
  });

  chrome.storage.local.get(
    { matches: [], settings: DEFAULT_SETTINGS, pendingOpponent: null, matchupNotes: {} },
    (data) => {
      void chrome.runtime.lastError;
      renderStatus(Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {}));
      render(
        (data && data.matches) || [],
        Date.now(),
        (data && data.pendingOpponent) || null,
        (data && data.matchupNotes) || {}
      );
    }
  );

  /* The matchup note, saved as it is typed. Debounced on input and flushed on
   * blur, because a popup closes the instant the pointer leaves it and a note
   * that only saved on blur would lose its last edit to that. Read-merge-write
   * against the stored object, so a note typed here can never clobber one
   * typed for a different champion in another window. */
  let noteTimer = null;
  function saveNote(el) {
    const name = el.dataset.scoutNote;
    const text = el.value.slice(0, 500);
    chrome.storage.local.get({ matchupNotes: {} }, (data) => {
      void chrome.runtime.lastError;
      const notes = Object.assign({}, (data && data.matchupNotes) || {});
      if (text.trim()) notes[name] = text;
      else delete notes[name];
      chrome.storage.local.set({ matchupNotes: notes });
    });
  }
  $("state").addEventListener("input", (e) => {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.scoutNote) return;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveNote(el), 400);
  });
  $("state").addEventListener(
    "blur",
    (e) => {
      const el = e.target;
      if (!el || !el.dataset || !el.dataset.scoutNote) return;
      clearTimeout(noteTimer);
      saveNote(el);
    },
    true
  );

  renderFootprint();
})();
