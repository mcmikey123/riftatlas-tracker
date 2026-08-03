/* Rift Atlas Stats Tracker - replay viewer
 *
 * Renders the board snapshots captured during a match and lets you scrub
 * through them. Card art is pulled from the same CDN the site uses; if an
 * image fails, the tile falls back to the card name so the replay still reads.
 */
(function (root) {
  "use strict";

  const CDN = "https://assets.riftatlas-workers.com/cdn-cgi/image/";
  const thumbUrl = (code) =>
    code ? CDN + "width=192,quality=85,format=auto,fit=scale-down/riftbound/cards/small-v2/" + code + ".webp" : null;
  const bigUrl = (code) =>
    code ? CDN + "width=512,quality=85,format=auto,fit=scale-down/riftbound/cards/original/" + code + ".webp" : null;
  // Tokens live under static/tokens, not cards/. Prefer the full-size art and
  // fall back to the square thumbnail the token picker uses.
  const tokenUrl = (tk, w) =>
    tk
      ? CDN + "width=" + (w || 192) + ",quality=85,format=auto,fit=scale-down,onerror=redirect/riftbound/static/tokens/" + tk + ".webp"
      : null;
  const tokenThumbUrl = (tk, w) =>
    tk
      ? CDN + "width=" + (w || 192) + ",quality=85,format=auto,fit=scale-down,onerror=redirect/riftbound/static/tokens/thumbs/" + tk + ".webp"
      : null;

  const artUrl = (card, big) =>
    card && card.tk ? tokenUrl(card.tk, big ? 512 : 192) : big ? bigUrl(card && card.c) : thumbUrl(card && card.c);

  const SIZES = ["sm", "md", "lg"];

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  function cardTile(card, extraClass) {
    if (!card) return "";
    if (card.h) return `<span class="rp-card rp-hidden ${extraClass || ""}" title="Hidden card"></span>`;
    const url = artUrl(card, false);
    const name = esc(card.n || "");
    // Tokens get a two-step fallback: full art -> square thumbnail -> name tile.
    const onErr = card.tk
      ? `if(!this.dataset.fb){this.dataset.fb=1;this.src='${tokenThumbUrl(card.tk, 192)}';}` +
        `else{this.style.display='none';this.parentNode.classList.add('rp-noart');}`
      : `this.style.display='none';this.parentNode.classList.add('rp-noart')`;
    const img = url
      ? `<img src="${url}" alt="${name}" loading="lazy" onerror="${onErr}">`
      : "";
    // Counters / buffs currently on the card (might modifiers etc).
    const pip = card.k ? `<span class="rp-pip" title="Counters: ${esc(card.k)}">${esc(card.k)}</span>` : "";
    return `<span class="rp-card ${extraClass || ""} ${card.tk ? "rp-token" : ""} ${url ? "" : "rp-noart"}" title="${name}${
      card.k ? " — counters: " + esc(card.k) : ""
    }" data-code="${esc(card.c || "")}" data-token="${esc(card.tk || "")}" data-name="${name}">${img}<span class="rp-name">${name}</span>${pip}</span>`;
  }

  function cardRow(cards) {
    if (!cards || !cards.length) return '<span class="rp-empty">—</span>';
    return cards.map((c) => cardTile(c)).join("");
  }

  const PHASE_NAMES = {
    mulligan: "Mulligan",
    first_player_choice: "First player",
    battlefield_select: "Battlefields",
    sideboard: "Sideboard",
    deck_select: "Deck select",
    lobby: "Lobby",
    setup: "Setup",
  };
  const prettyPhase = (p) =>
    PHASE_NAMES[p] || String(p || "Setup").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  function fmtClock(ms) {
    if (!Number.isFinite(ms)) return "";
    const t = Math.round(ms / 1000);
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  }

  /** Every non-hidden opponent card seen anywhere up to snapshot `upto`. */
  function seenFromOpponent(snaps, upto) {
    const map = new Map();
    for (let k = 0; k <= upto && k < snaps.length; k++) {
      const z = (snaps[k] && snaps[k].z) || {};
      for (const key of Object.keys(z)) {
        if (!key.startsWith("opponent.")) continue;
        if (key === "opponent.legend" || key === "opponent.champion") continue;
        const v = z[key];
        const list = Array.isArray(v) ? v : v ? [v] : [];
        for (const c of list) {
          if (!c || c.h) continue;
          const key = c.c || (c.tk ? "tk:" + c.tk : null);
          if (key) map.set(key, c);
        }
      }
    }
    return [...map.values()];
  }

  /** One horizontal zone lane (hand / base / trash) for a single player. */
  function zoneRow(cards, label, sideClass, note) {
    const list = cards || [];
    const hidden = list.length > 0 && list.every((c) => c && c.h);
    return `
      <div class="rp-zone ${sideClass}">
        <span class="rp-zone-label">${label} <b>${list.length}</b>${
          hidden && note ? ` <em>${note}</em>` : ""
        }</span>
        <span class="rp-zone-cards">${
          list.length ? list.map((c) => cardTile(c)).join("") : '<span class="rp-empty">—</span>'
        }</span>
      </div>`;
  }

  function renderBoard(snap, match, seen) {
    if (!snap) return '<p class="rp-empty">No snapshot.</p>';
    const z = snap.z || {};
    const p = snap.p || {};
    const bf = snap.bf || {};
    const meName = esc(match.myName || "You");
    const oppName = esc(match.opponentName || "Opponent");
    // Battlefields sit in the middle, contested: opponent's committed units
    // above the centre line, yours below - the same way the board reads.
    // Built from whatever the snapshot holds, so a battlefield played during
    // the game (Baron Nashor's Pit and friends) shows up without code changes.
    const bfCell = (zoneKey, label, extraClass) => `
      <div class="rp-bf ${extraClass || ""}">
        <div class="rp-bf-head">${esc(label)}</div>
        <div class="rp-bf-side rp-half-opp">${cardRow(z["opponent." + zoneKey])}</div>
        <div class="rp-bf-divider"></div>
        <div class="rp-bf-side rp-half-self">${cardRow(z["self." + zoneKey])}</div>
        ${z["neutral." + zoneKey] ? `<div class="rp-bf-neutral">${cardRow(z["neutral." + zoneKey])}</div>` : ""}
      </div>`;

    // legacy snapshots keyed battlefields "A"/"B"; current ones use the full
    // zone id, which is also the key its cards are stored under.
    const zoneOf = (k) => (/^battlefield/i.test(k) ? k : "battlefield" + k);
    const isA = (k) => /A$/i.test(zoneOf(k));
    const isB = (k) => /B$/i.test(zoneOf(k));
    const occupied = (k) => {
      const zk = zoneOf(k);
      return (
        bf[k] ||
        (z["self." + zk] || []).length ||
        (z["opponent." + zk] || []).length ||
        (z["neutral." + zk] || []).length
      );
    };

    const allKeys = Object.keys(bf || {});
    // Extra battlefields (Baron Nashor's Pit) sit BETWEEN the two permanent
    // ones, and only appear once they've actually been played.
    const middle = allKeys.filter((k) => !isA(k) && !isB(k) && occupied(k)).sort();
    const ordered = [
      ...allKeys.filter(isA),
      ...middle,
      ...allKeys.filter(isB),
    ];

    const bfCells = ordered
      .map((k) => {
        const zoneKey = zoneOf(k);
        const card = bf[k];
        const label = (card && card.n) || zoneKey.replace(/^battlefield/i, "Battlefield ");
        const extra = !isA(k) && !isB(k) ? "rp-bf-mid" : "";
        return bfCell(zoneKey, label, extra);
      })
      .join("");

    const strip = (owner, name, score, sideClass) => `
      <div class="rp-strip ${sideClass}">
        <span class="rp-player">${name}</span>
        <span class="rp-score" title="Score">${score ?? 0}</span>
        <span class="rp-mini">${cardTile(z[owner + ".legend"], "rp-sm")}${cardTile(z[owner + ".champion"], "rp-sm")}</span>
        <span class="rp-counts">
          deck ${p[owner + ".mainDeck"] ?? "?"} ·
          runes ${(z[owner + ".runeArea"] || []).length} ·
          trash ${(z[owner + ".trash"] || []).length}
        </span>
      </div>`;

    const trashRow = (owner, sideClass) => {
      const cards = z[owner + ".trash"] || [];
      if (!cards.length) return "";
      return zoneRow(cards, "Trash", sideClass + " rp-zone-muted");
    };

    const seenStrip =
      seen && seen.length
        ? `<div class="rp-seen">
             <span class="rp-zone-label">${oppName}&rsquo;s cards seen <b>${seen.length}</b></span>
             <span class="rp-zone-cards">${seen.map((c) => cardTile(c)).join("")}</span>
           </div>`
        : "";

    // Board order mirrors a real game, top to bottom:
    // opponent hand -> opponent base -> battlefields -> your base -> your hand.
    return `
      ${strip("opponent", oppName, snap.sc && snap.sc[1], "rp-half-opp")}
      ${trashRow("opponent", "rp-half-opp")}
      ${zoneRow(z["opponent.hand"], "Hand", "rp-half-opp", "face down")}
      ${zoneRow(z["opponent.base"], "Base", "rp-half-opp")}
      <div class="rp-fields" data-count="${ordered.length}">${bfCells}</div>
      ${zoneRow(z["self.base"], "Base", "rp-half-self")}
      ${zoneRow(z["self.hand"], "Hand", "rp-half-self")}
      ${trashRow("self", "rp-half-self")}
      ${strip("self", meName, snap.sc && snap.sc[0], "rp-half-self")}
      ${seenStrip}`;
  }

  // ---- hover preview (full-size card art) ----

  let hoverEl = null;
  function ensureHover() {
    if (hoverEl) return hoverEl;
    hoverEl = document.createElement("div");
    hoverEl.className = "rp-preview";
    hoverEl.hidden = true;
    document.body.appendChild(hoverEl);
    return hoverEl;
  }
  function wireHover(scope) {
    scope.addEventListener("mouseover", (e) => {
      const tile = e.target.closest?.(".rp-card");
      if (!tile || !scope.contains(tile)) return;
      const tk = tile.dataset.token;
      const url = tk ? tokenUrl(tk, 512) : tile.dataset.code ? bigUrl(tile.dataset.code) : null;
      if (!url) return;
      const el = ensureHover();
      const onErr = tk
        ? `if(!this.dataset.fb){this.dataset.fb=1;this.src='${tokenThumbUrl(tk, 512)}';}else{this.parentNode.hidden=true;}`
        : `this.parentNode.hidden=true`;
      el.innerHTML = `<img src="${url}" alt="${esc(tile.dataset.name)}" onerror="${onErr}"><span>${esc(tile.dataset.name)}</span>`;
      el.hidden = false;
    });
    scope.addEventListener("mousemove", (e) => {
      if (!hoverEl || hoverEl.hidden) return;
      const pad = 16;
      const w = hoverEl.offsetWidth || 240;
      const h = hoverEl.offsetHeight || 340;
      let x = e.clientX + pad;
      let y = e.clientY + pad;
      if (x + w > window.innerWidth) x = e.clientX - w - pad;
      if (y + h > window.innerHeight) y = Math.max(8, window.innerHeight - h - 8);
      hoverEl.style.left = x + "px";
      hoverEl.style.top = y + "px";
    });
    scope.addEventListener("mouseout", (e) => {
      const to = e.relatedTarget;
      if (hoverEl && (!to || !to.closest?.(".rp-card"))) hoverEl.hidden = true;
    });
  }

  /** Mount a replay viewer into `container`. Returns a controller. */
  function mount(container, match, snaps, opts) {
    opts = opts || {};
    if (!snaps || !snaps.length) {
      container.innerHTML =
        '<p class="rp-empty">No replay was captured for this match. Replays are recorded for games played with v0.3.0 or later.</p>';
      return null;
    }
    let i = snaps.length - 1;
    let timer = null;
    let size = opts.size || "sm";

    // Chapter markers: first frame of each turn, plus the setup/mulligan
    // frames captured before turn 1.
    const chapters = [];
    let lastKey = null;
    snaps.forEach((s, idx) => {
      const pre = s.ph && s.ph !== "in_game";
      const key = pre ? "pre:" + s.ph : "turn:" + (s.tn ?? "?");
      if (key === lastKey) return;
      lastKey = key;
      chapters.push({
        idx,
        label: pre ? prettyPhase(s.ph) : "T" + (s.tn ?? "?"),
        pre,
        title: pre ? prettyPhase(s.ph) : "Jump to turn " + (s.tn ?? "?"),
      });
    });

    container.innerHTML = `
      <div class="rp-controls">
        <button class="rp-btn rp-play" title="Play / pause (space)">▶</button>
        <button class="rp-btn rp-prev" title="Previous (←)">◀</button>
        <button class="rp-btn rp-next" title="Next (→)">▶|</button>
        <input class="rp-slider" type="range" min="0" max="${snaps.length - 1}" value="${i}">
        <span class="rp-meta"></span>
        ${opts.sizeControl === false ? "" : `<span class="rp-sizes">${SIZES.map(
          (s) => `<button class="rp-btn rp-size ${s === size ? "on" : ""}" data-size="${s}">${s.toUpperCase()}</button>`
        ).join("")}</span>`}
      </div>
      ${
        chapters.length > 1
          ? `<div class="rp-chapters">${chapters
              .map(
                (c) =>
                  `<button class="rp-btn rp-chapter ${c.pre ? "rp-chapter-pre" : ""}" data-jump="${c.idx}" title="${esc(c.title)}">${esc(c.label)}</button>`
              )
              .join("")}</div>`
          : ""
      }
      <div class="rp-board rp-${size}"></div>`;

    const boardEl = container.querySelector(".rp-board");
    const slider = container.querySelector(".rp-slider");
    const meta = container.querySelector(".rp-meta");
    const playBtn = container.querySelector(".rp-play");

    function draw() {
      const snap = snaps[i];
      boardEl.innerHTML = renderBoard(snap, match, seenFromOpponent(snaps, i));
      slider.value = String(i);
      const pre = snap.ph && snap.ph !== "in_game";
      const where = pre
        ? prettyPhase(snap.ph)
        : `turn ${snap.tn ?? "?"}${snap.st ? " · " + snap.st : ""}`;
      meta.textContent = `${i + 1}/${snaps.length} · ${where} · ${fmtClock(snap.t)}`;
      boardEl.classList.toggle("rp-pregame", !!pre);
      // highlight the chapter we're inside
      const chips = container.querySelectorAll(".rp-chapter");
      let active = -1;
      chapters.forEach((c, n) => { if (c.idx <= i) active = n; });
      chips.forEach((el, n) => el.classList.toggle("on", n === active));
    }
    function go(n) {
      i = Math.max(0, Math.min(snaps.length - 1, n));
      draw();
    }
    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      playBtn.textContent = "▶";
    }
    function togglePlay() {
      if (timer) return stop();
      if (i >= snaps.length - 1) i = 0;
      playBtn.textContent = "❚❚";
      timer = setInterval(() => {
        if (i >= snaps.length - 1) return stop();
        go(i + 1);
      }, 700);
    }
    playBtn.addEventListener("click", togglePlay);
    container.querySelector(".rp-prev").addEventListener("click", () => { stop(); go(i - 1); });
    container.querySelector(".rp-next").addEventListener("click", () => { stop(); go(i + 1); });
    slider.addEventListener("input", () => { stop(); go(parseInt(slider.value, 10)); });
    container.addEventListener("click", (e) => {
      const jump = e.target?.dataset?.jump;
      if (jump !== undefined) {
        stop();
        go(parseInt(jump, 10));
        return;
      }
      const s = e.target?.dataset?.size;
      if (!s) return;
      size = s;
      boardEl.className = "rp-board rp-" + size;
      container.querySelectorAll(".rp-size").forEach((b) =>
        b.classList.toggle("on", b.dataset.size === size)
      );
    });
    wireHover(container);
    draw();

    return {
      next: () => { stop(); go(i + 1); },
      prev: () => { stop(); go(i - 1); },
      first: () => { stop(); go(0); },
      last: () => { stop(); go(snaps.length - 1); },
      togglePlay,
      stop,
    };
  }

  /** Open the replay full-screen. */
  function openModal(match, snaps) {
    const back = document.createElement("div");
    back.className = "rp-modal-backdrop";
    const d = match.startedAt ? new Date(match.startedAt) : null;
    const title = `${esc(match.myChampion || match.myLegend || "You")} vs ${esc(
      match.opponentChampion || match.opponentLegend || "Opponent"
    )}`;
    const sub = `${esc(match.opponentName || "")}${d ? " · " + d.toLocaleString() : ""} · ${
      match.myScore ?? 0
    }–${match.opponentScore ?? 0} · ${esc(match.result || "unknown")}`;
    back.innerHTML = `
      <div class="rp-modal" role="dialog" aria-label="Match replay">
        <div class="rp-modal-head">
          <div>
            <h2>${title}</h2>
            <p class="rp-modal-sub">${sub}</p>
          </div>
          <button class="rp-btn rp-close" title="Close (Esc)">✕ Close</button>
        </div>
        <div class="rp-modal-body"></div>
        <p class="rp-hint">← → step · space play/pause · hover a card for full art</p>
      </div>`;
    document.body.appendChild(back);
    document.body.classList.add("rp-modal-open");

    const ctl = mount(back.querySelector(".rp-modal-body"), match, snaps, { size: "lg" });

    function close() {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("rp-modal-open");
      if (hoverEl) hoverEl.hidden = true;
      if (ctl) ctl.stop();
      back.remove();
    }
    function onKey(e) {
      if (e.key === "Escape") return close();
      if (!ctl) return;
      if (e.key === "ArrowRight") { e.preventDefault(); ctl.next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); ctl.prev(); }
      else if (e.key === " ") { e.preventDefault(); ctl.togglePlay(); }
      else if (e.key === "Home") { e.preventDefault(); ctl.first(); }
      else if (e.key === "End") { e.preventDefault(); ctl.last(); }
    }
    document.addEventListener("keydown", onKey);
    back.querySelector(".rp-close").addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    return close;
  }

  root.RATrackerReplay = { mount, openModal, renderBoard, thumbUrl, bigUrl, seenFromOpponent };
})(typeof window !== "undefined" ? window : globalThis);
