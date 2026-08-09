/* Rift Atlas Stats Tracker - visual replay viewer
 *
 * Plays back the rrweb event stream captured during a match, so the board is
 * the site's own DOM rather than a redrawn approximation. The structured
 * viewer in replay.js is untouched and stays the fallback for matches with no
 * visual track, and for the tail of a match whose capture ran out of budget.
 *
 * The replayer is mounted at exactly the viewport it was recorded at and
 * scaled to fit with a CSS transform: replaying at a different width fires
 * different media queries, which is the drift this whole feature removes.
 * rrweb builds its own sandbox="allow-same-origin" iframe with scripting off,
 * so opponent-controlled strings stay inert; nothing here re-enables scripts.
 */
(function (root) {
  "use strict";

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const FULL_SNAPSHOT = 2; // rrweb EventType.FullSnapshot
  const CUSTOM = 5; // rrweb EventType.Custom
  const MAX_CHIPS = 30; // more than this and the chip row stops being scannable
  const STEP_MS = 1000; // step size when the recording holds no keyframes at all
  const MIN_STAGE_H = 240;
  const STAGE_MARGIN = 108; // room the controls and hint line need below the stage
  const DEFAULT_VIEWPORT = { w: 1280, h: 800 };

  function fmtClock(ms) {
    if (!Number.isFinite(ms)) return "0:00";
    const t = Math.max(0, Math.round(ms / 1000));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  }

  /** Turn number carried by an rrweb custom event, or null if it isn't one. */
  function turnOf(event) {
    if (!event || event.type !== CUSTOM || !event.data) return null;
    if (!/turn/i.test(String(event.data.tag || ""))) return null;
    const p = event.data.payload || {};
    const n = p.turnNumber != null ? p.turnNumber : p.turn;
    return Number.isFinite(Number(n)) ? Number(n) : null;
  }

  /**
   * Settled board states, as ms from the first event. Recorder-supplied turn
   * markers win; otherwise every full snapshot is one, which is what the
   * recorder takes on each turn change.
   */
  function timeline(events) {
    const t0 = events[0].timestamp || 0;
    const marked = [];
    for (const e of events) {
      const turn = turnOf(e);
      if (turn !== null) marked.push({ ms: (e.timestamp || t0) - t0, turn });
    }
    if (marked.length) return marked;
    const frames = [];
    for (const e of events) {
      if (e && e.type === FULL_SNAPSHOT) {
        frames.push({ ms: (e.timestamp || t0) - t0, turn: frames.length + 1 });
      }
    }
    return frames;
  }

  /** At most `max` entries, evenly spaced, first and last always kept. */
  function evenly(marks, max) {
    if (marks.length <= max) return marks;
    const step = (marks.length - 1) / (max - 1);
    const out = [];
    for (let n = 0; n < max; n++) out.push(marks[Math.round(n * step)]);
    return out;
  }

  /** Banner copy for a capture that stopped before the match did. */
  function truncationText(meta, match, marks) {
    const last = marks.length ? marks[marks.length - 1].turn : null;
    const coveredTo = Number.isFinite(Number(meta.truncatedAtTurn)) ? Number(meta.truncatedAtTurn) : last;
    const turns = Number(match && match.turns);
    if (coveredTo == null) return "Visual replay stops before the end of this match.";
    const covered = `Visual replay covers turns 1–${coveredTo}`;
    return Number.isFinite(turns) && turns > coveredTo
      ? `${covered}; step-through continues to turn ${turns}`
      : `${covered} of this match`;
  }

  /** Mount a visual replay into `container`. Returns a controller, or null. */
  function mount(container, match, payload, opts) {
    opts = opts || {};
    const meta = (payload && payload.meta) || {};
    const events = (payload && payload.events) || [];
    if (events.length < 2) {
      container.innerHTML =
        '<p class="rp-empty">No visual recording was captured for this match. Use the step-through replay instead.</p>';
      return null;
    }
    if (!root.rrwebReplay || typeof root.rrwebReplay.Replayer !== "function") {
      container.innerHTML = '<p class="rp-empty">The replay engine failed to load.</p>';
      return null;
    }

    const vp = meta.viewport || DEFAULT_VIEWPORT;
    const vw = Math.max(1, Math.round(Number(vp.w) || DEFAULT_VIEWPORT.w));
    const vh = Math.max(1, Math.round(Number(vp.h) || DEFAULT_VIEWPORT.h));

    const marks = timeline(events);
    const chips = evenly(marks, MAX_CHIPS);
    const truncated = meta.state === "truncated";
    const lostTail = !!meta.incomplete || meta.truncatedAtChunk != null;

    const banner = truncated
      ? `<div class="vr-banner">
           <span>${esc(truncationText(meta, match, marks))}.</span>
           ${opts.openStructured ? '<button class="rp-btn vr-structured">Open step-through replay</button>' : ""}
         </div>`
      : "";
    const note = lostTail
      ? '<p class="vr-note">The tail of this recording was lost, so the replay ends before the match did.</p>'
      : "";

    container.innerHTML = `
      ${banner}
      ${note}
      <div class="rp-controls">
        <button class="rp-btn vr-play" title="Play / pause (space)">▶</button>
        <button class="rp-btn vr-prev" title="Previous board state (←)">◀</button>
        <button class="rp-btn vr-next" title="Next board state (→)">▶|</button>
        <input class="rp-slider vr-slider" type="range" min="0" max="1000" value="0" step="1">
        <span class="rp-meta vr-time"></span>
      </div>
      ${
        chips.length > 1
          ? `<div class="rp-chapters">${chips
              .map(
                (c) =>
                  `<button class="rp-btn rp-chapter vr-chapter" data-ms="${c.ms}" title="Jump to turn ${esc(
                    c.turn
                  )}">T${esc(c.turn)}</button>`
              )
              .join("")}</div>`
          : ""
      }
      <div class="vr-stage"><div class="vr-scale"></div></div>`;

    const stage = container.querySelector(".vr-stage");
    const scaleEl = container.querySelector(".vr-scale");
    const slider = container.querySelector(".vr-slider");
    const timeEl = container.querySelector(".vr-time");
    const playBtn = container.querySelector(".vr-play");

    let replayer;
    try {
      replayer = new root.rrwebReplay.Replayer(events, {
        root: scaleEl,
        events,
        mouseTail: false,
        speedOption: [1],
        showWarning: false,
        showDebug: false,
      });
    } catch (err) {
      console.warn("[RA-Tracker] visual replay failed to start:", err);
      container.innerHTML = '<p class="rp-empty">This visual recording could not be played back.</p>';
      return null;
    }

    const total = Math.max(1, replayer.getMetaData().totalTime || 0);
    slider.max = String(total);

    // Board states we step between: every keyframe, bounded by both ends.
    const stops = [...new Set([0, ...marks.map((m) => m.ms), total])]
      .filter((ms) => ms >= 0 && ms <= total)
      .sort((a, b) => a - b);

    let playing = false;
    let raf = null;
    let at = 0;

    // rrweb sizes its iframe from the recorded meta event and re-sizes it on
    // any viewport-resize event in the stream; both are overridden here so the
    // replay always renders at the width its media queries were captured at.
    function pin() {
      for (const el of [replayer.wrapper, replayer.iframe]) {
        if (!el) continue;
        el.style.width = vw + "px";
        el.style.height = vh + "px";
      }
      if (replayer.iframe) {
        replayer.iframe.setAttribute("width", String(vw));
        replayer.iframe.setAttribute("height", String(vh));
      }
    }

    function fit() {
      const room = stage.clientWidth || vw;
      const top = stage.getBoundingClientRect().top;
      const tall = Math.max(MIN_STAGE_H, root.innerHeight - top - STAGE_MARGIN);
      const scale = Math.min(room / vw, tall / vh, 1);
      scaleEl.style.transform = `scale(${scale})`;
      stage.style.height = Math.ceil(vh * scale) + "px";
    }

    function paint() {
      slider.value = String(Math.round(at));
      timeEl.textContent = `${fmtClock(at)} / ${fmtClock(total)}`;
      let active = -1;
      chips.forEach((c, n) => {
        if (c.ms <= at + 1) active = n;
      });
      container.querySelectorAll(".vr-chapter").forEach((el, n) => el.classList.toggle("on", n === active));
    }

    function track() {
      if (!playing) return;
      at = Math.min(total, replayer.getCurrentTime());
      paint();
      raf = root.requestAnimationFrame(track);
    }

    function stop() {
      if (!playing) return;
      playing = false;
      if (raf) root.cancelAnimationFrame(raf);
      raf = null;
      replayer.pause();
      playBtn.textContent = "▶";
    }

    function seek(ms) {
      stop();
      at = Math.max(0, Math.min(total, ms));
      replayer.pause(at);
      paint();
    }

    function togglePlay() {
      if (playing) return stop();
      if (at >= total) at = 0;
      playing = true;
      playBtn.textContent = "❚❚";
      replayer.play(at);
      raf = root.requestAnimationFrame(track);
    }

    function stepTo(dir) {
      const next = dir > 0 ? stops.find((ms) => ms > at + 1) : [...stops].reverse().find((ms) => ms < at - 1);
      seek(next == null ? (dir > 0 ? total : 0) : next);
    }

    replayer.on("resize", () => {
      pin();
      fit();
    });
    replayer.on("finish", () => {
      at = total;
      stop();
      paint();
    });

    playBtn.addEventListener("click", togglePlay);
    container.querySelector(".vr-prev").addEventListener("click", () => stepTo(-1));
    container.querySelector(".vr-next").addEventListener("click", () => stepTo(1));
    slider.addEventListener("input", () => seek(parseInt(slider.value, 10) || 0));
    container.addEventListener("click", (e) => {
      const ms = e.target?.dataset?.ms;
      if (ms !== undefined) seek(parseInt(ms, 10) || 0);
    });
    const structuredBtn = container.querySelector(".vr-structured");
    if (structuredBtn) {
      structuredBtn.addEventListener("click", () => {
        if (opts.onLeave) opts.onLeave();
        opts.openStructured(match);
      });
    }

    const onResize = () => fit();
    root.addEventListener("resize", onResize);

    pin();
    fit();
    seek(0);

    return {
      next: () => stepTo(1),
      prev: () => stepTo(-1),
      first: () => seek(0),
      last: () => seek(total),
      togglePlay,
      stop,
      destroy() {
        stop();
        root.removeEventListener("resize", onResize);
        try {
          replayer.destroy();
        } catch (_) { /* already torn down with the modal */ }
      },
    };
  }

  /** Open the visual replay full-screen. Mirrors replay.js's modal. */
  function openModal(match, payload, opts) {
    opts = opts || {};
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
      <div class="rp-modal vr-modal" role="dialog" aria-label="Visual match replay">
        <div class="rp-modal-head">
          <div>
            <h2>${title}</h2>
            <p class="rp-modal-sub">Visual replay · ${sub}</p>
          </div>
          <button class="rp-btn rp-close" title="Close (Esc)">✕ Close</button>
        </div>
        <div class="rp-modal-body"></div>
        <p class="rp-hint">← → step between board states · space play/pause · the board is the site's own, replayed at its recorded size</p>
      </div>`;
    document.body.appendChild(back);
    document.body.classList.add("rp-modal-open");

    const ctl = mount(back.querySelector(".rp-modal-body"), match, payload, {
      openStructured: opts.openStructured,
      onLeave: () => close(),
    });

    function close() {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("rp-modal-open");
      if (ctl) ctl.destroy();
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

  root.RATrackerVisualReplay = { mount, openModal, timeline };
})(typeof window !== "undefined" ? window : globalThis);
