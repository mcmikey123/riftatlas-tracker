/* Rift Atlas Stats Tracker - replay viewer
 *
 * Plays back the rrweb event stream captured during a match, so the board is
 * the site's own DOM rather than a redrawn approximation. This is the only
 * replay there is: matches without a visual track have no replay at all, and
 * a capture that ran out of budget simply stops where it stopped.
 *
 * The replayer is mounted at exactly the viewport it was recorded at and
 * scaled to fit with a CSS transform: replaying at a different width fires
 * different media queries, which is the drift this whole feature removes.
 * rrweb builds its own sandbox="allow-same-origin" iframe with scripting off,
 * so opponent-controlled strings stay inert; nothing here re-enables scripts.
 */
(function (root) {
  "use strict";

  const { esc, fmtClock } = root.RATrackerFormat;

  const FULL_SNAPSHOT = 2; // rrweb EventType.FullSnapshot
  const CUSTOM = 5; // rrweb EventType.Custom
  const MAX_CHIPS = 30; // more than this and the chip row stops being scannable
  const DEFAULT_VIEWPORT = { w: 1280, h: 800 };

  /**
   * Captures are ~1280x800, so on anything bigger than a laptop panel a replay
   * that refused to pass 1:1 would sit in one corner of the screen — which is
   * the complaint fullscreen exists to answer. Upscaling is therefore allowed,
   * capped at 2x: the board is DOM text that the compositor re-rasters at the
   * transform's scale, so it stays sharp, but past 2x there is no more detail
   * in the capture to reveal and the card art is only getting blurrier.
   */
  const MAX_SCALE = 2;
  /**
   * Scale is quantised to this step, and snapped to exactly 1 whenever it lands
   * within one step of it. 1:1 is the one ratio where every captured pixel maps
   * onto one device pixel with no resampling at all, so it is worth a percent
   * of unused room; the quantising itself stops a drag-resize from re-rastering
   * the iframe at a new fractional scale on every single frame.
   */
  const SCALE_STEP = 0.01;
  /**
   * Escape is consumed by the browser to leave fullscreen, but not every engine
   * agrees on whether the page also sees the keydown. Any Escape this soon after
   * leaving fullscreen is treated as that one, so a single press never both
   * leaves fullscreen and closes the modal behind it.
   */
  const ESCAPE_GRACE_MS = 300;

  /** The scale to render at, given how much room the raw fit would allow. */
  function quantise(raw) {
    const capped = Math.min(raw, MAX_SCALE);
    if (Math.abs(capped - 1) < SCALE_STEP) return 1;
    // Floored, never rounded: a scale above the raw fit would overflow the stage.
    return Math.max(SCALE_STEP, Math.floor(capped / SCALE_STEP) * SCALE_STEP);
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
    if (coveredTo == null) return "This replay stops before the end of the match.";
    const covered = `This replay covers turns 1–${coveredTo}`;
    return Number.isFinite(turns) && turns > coveredTo
      ? `${covered} of ${turns}; capture ran out of budget after that`
      : `${covered} of this match`;
  }

  /**
   * Write the viewer's chrome into `container` and hand back every element the
   * transport controls touch. `chips` is the already-thinned chapter list.
   */
  function renderShell(container, match, meta, marks, chips) {
    const truncated = meta.state === "truncated";
    const lostTail = !!meta.incomplete || meta.truncatedAtChunk != null;

    const banner = truncated
      ? `<div class="vr-banner"><span>${esc(truncationText(meta, match, marks))}.</span></div>`
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
        <button class="rp-btn vr-full" title="Fullscreen (f)" aria-pressed="false">⛶ Fullscreen</button>
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

    return {
      container,
      stage: container.querySelector(".vr-stage"),
      scaleEl: container.querySelector(".vr-scale"),
      slider: container.querySelector(".vr-slider"),
      timeEl: container.querySelector(".vr-time"),
      playBtn: container.querySelector(".vr-play"),
      prevBtn: container.querySelector(".vr-prev"),
      nextBtn: container.querySelector(".vr-next"),
      fullBtn: container.querySelector(".vr-full"),
      chapterEls: container.querySelectorAll(".vr-chapter"),
    };
  }

  /**
   * Start rrweb inside the stage. Returns the replayer together with the two
   * functions that keep it at its recorded size — `pin` forces the iframe back
   * to the captured viewport, `fit` scales the result to the room we have — or
   * null if the recording will not play at all.
   */
  function mountReplayer(handles, events, viewport) {
    const { stage, scaleEl } = handles;
    const vw = viewport.w;
    const vh = viewport.h;

    let replayer;
    try {
      replayer = new root.rrwebReplay.Replayer(events, {
        root: scaleEl,
        mouseTail: false,
        speedOption: [1],
        showWarning: false,
        showDebug: false,
      });
    } catch (err) {
      console.warn("[RA-Tracker] visual replay failed to start:", err);
      return null;
    }

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

    // The stage is a flex item that has already been given every pixel the
    // chrome did not take, in the window or in fullscreen alike, so the room is
    // simply its own box — no measuring of the viewport, and nothing here to
    // re-tune when the modal's chrome changes. The iframe itself is never
    // resized; only the scale it is drawn at moves.
    function fit() {
      const roomW = stage.clientWidth || vw;
      const roomH = stage.clientHeight || vh;
      const scale = quantise(Math.min(roomW / vw, roomH / vh));
      // Integer offsets: centring on a half pixel would blur the whole board.
      const x = Math.max(0, Math.round((roomW - vw * scale) / 2));
      const y = Math.max(0, Math.round((roomH - vh * scale) / 2));
      scaleEl.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }

    return { replayer, pin, fit };
  }

  /**
   * Hook the transport controls, the chapter chips and the window resize up to
   * a mounted replayer. Returns the controller `mount` hands back; its
   * `destroy` is the teardown for everything wired here.
   */
  function wireControls(handles, mounted, marks, chips) {
    const { container, slider, timeEl, playBtn, prevBtn, nextBtn, fullBtn, chapterEls } = handles;
    const { replayer, pin, fit } = mounted;

    const total = Math.max(1, replayer.getMetaData().totalTime || 0);
    slider.max = String(total);

    // Board states we step between: every keyframe, bounded by both ends.
    const stops = [...new Set([0, ...marks.map((m) => m.ms), total])]
      .filter((ms) => ms >= 0 && ms <= total)
      .sort((a, b) => a - b);

    let playing = false;
    let raf = null;
    let at = 0;
    let dead = false;

    // Fullscreen goes on the modal shell, not the stage, so the transport, the
    // chapter chips and the truncation banner come along with the board. When
    // the viewer is mounted somewhere other than the modal, that element is the
    // container itself.
    const shell = (typeof container.closest === "function" && container.closest(".rp-modal")) || container;
    const canFullscreen =
      !!fullBtn &&
      typeof shell.requestFullscreen === "function" &&
      typeof document.exitFullscreen === "function" &&
      document.fullscreenEnabled !== false;
    let wasFull = false;
    let leftFullAt = 0;

    /** Refit, but never after teardown — deferred fits outlive the modal. */
    function refit() {
      if (dead) return;
      fit();
    }

    function isFull() {
      return document.fullscreenElement === shell;
    }

    function paint() {
      slider.value = String(Math.round(at));
      timeEl.textContent = `${fmtClock(at)} / ${fmtClock(total)}`;
      let active = -1;
      chips.forEach((c, n) => {
        if (c.ms <= at + 1) active = n;
      });
      chapterEls.forEach((el, n) => el.classList.toggle("on", n === active));
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

    function paintFullscreen() {
      const on = isFull();
      shell.classList.toggle("rp-full", on);
      fullBtn.textContent = on ? "⤢ Exit fullscreen" : "⛶ Fullscreen";
      fullBtn.title = on ? "Leave fullscreen (f or Esc)" : "Fullscreen (f)";
      fullBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }

    /** Leave fullscreen if we are in it. Never throws, never rejects outward. */
    function leaveFullscreen() {
      let done;
      try {
        done = document.exitFullscreen();
      } catch (err) {
        console.warn("[RA-Tracker] could not leave fullscreen:", err);
        return;
      }
      if (done && typeof done.catch === "function") {
        done.catch((err) => console.warn("[RA-Tracker] could not leave fullscreen:", err));
      }
    }

    /**
     * requestFullscreen can be refused outright — an iframe without the
     * permission, a user gesture the browser did not credit — and it reports
     * that by rejecting, not throwing. Either way the viewer stays exactly as it
     * was, so all we owe is repainting the button back to its real state.
     */
    function toggleFullscreen() {
      if (!canFullscreen) return;
      if (isFull()) return leaveFullscreen();
      let done;
      try {
        done = shell.requestFullscreen();
      } catch (err) {
        console.warn("[RA-Tracker] fullscreen was refused:", err);
        paintFullscreen();
        return;
      }
      if (done && typeof done.catch === "function") {
        done.catch((err) => {
          console.warn("[RA-Tracker] fullscreen was refused:", err);
          paintFullscreen();
        });
      }
    }

    /**
     * True when this Escape belongs to fullscreen and the modal must stay open:
     * either we are still in fullscreen, or the browser has just taken us out of
     * it with the very keypress now arriving here.
     */
    function escapeHandled() {
      if (isFull()) {
        leaveFullscreen();
        return true;
      }
      return Date.now() - leftFullAt < ESCAPE_GRACE_MS;
    }

    function onFullscreenChange() {
      const on = isFull();
      if (wasFull && !on) leftFullAt = Date.now();
      wasFull = on;
      paintFullscreen();
      // The box the stage lands in is not final on this event in every engine,
      // so fit once now and again once layout has settled.
      refit();
      root.requestAnimationFrame(refit);
    }

    replayer.on("resize", () => {
      pin();
      refit();
    });
    replayer.on("finish", () => {
      at = total;
      stop();
      paint();
    });

    playBtn.addEventListener("click", togglePlay);
    prevBtn.addEventListener("click", () => stepTo(-1));
    nextBtn.addEventListener("click", () => stepTo(1));
    slider.addEventListener("input", () => seek(parseInt(slider.value, 10) || 0));
    container.addEventListener("click", (e) => {
      const ms = e.target?.dataset?.ms;
      if (ms !== undefined) seek(parseInt(ms, 10) || 0);
    });
    const onResize = () => refit();
    root.addEventListener("resize", onResize);
    if (canFullscreen) {
      fullBtn.addEventListener("click", toggleFullscreen);
      document.addEventListener("fullscreenchange", onFullscreenChange);
      paintFullscreen();
    } else if (fullBtn) {
      // Nothing to toggle into; the button would only be a dead control.
      fullBtn.hidden = true;
    }

    pin();
    fit();
    seek(0);

    return {
      next: () => stepTo(1),
      prev: () => stepTo(-1),
      first: () => seek(0),
      last: () => seek(total),
      togglePlay,
      toggleFullscreen,
      escapeHandled,
      stop,
      destroy() {
        dead = true;
        stop();
        root.removeEventListener("resize", onResize);
        if (canFullscreen) {
          fullBtn.removeEventListener("click", toggleFullscreen);
          document.removeEventListener("fullscreenchange", onFullscreenChange);
          if (document.fullscreenElement === shell) leaveFullscreen();
        }
        shell.classList.remove("rp-full");
        try {
          replayer.destroy();
        } catch (_) { /* already torn down with the modal */ }
      },
    };
  }

  /** Mount a replay into `container`. Returns a controller, or null. */
  function mount(container, match, payload) {
    const meta = (payload && payload.meta) || {};
    const events = (payload && payload.events) || [];
    if (events.length < 2) {
      container.innerHTML =
        '<p class="rp-empty">No recording was captured for this match.</p>';
      return null;
    }
    if (!root.rrwebReplay || typeof root.rrwebReplay.Replayer !== "function") {
      container.innerHTML = '<p class="rp-empty">The replay engine failed to load.</p>';
      return null;
    }

    const vp = meta.viewport || DEFAULT_VIEWPORT;
    const viewport = {
      w: Math.max(1, Math.round(Number(vp.w) || DEFAULT_VIEWPORT.w)),
      h: Math.max(1, Math.round(Number(vp.h) || DEFAULT_VIEWPORT.h)),
    };

    const marks = timeline(events);
    const chips = evenly(marks, MAX_CHIPS);

    const handles = renderShell(container, match, meta, marks, chips);
    const mounted = mountReplayer(handles, events, viewport);
    if (!mounted) {
      container.innerHTML = '<p class="rp-empty">This recording could not be played back.</p>';
      return null;
    }
    return wireControls(handles, mounted, marks, chips);
  }

  /** Open the replay full-screen. */
  function openModal(match, payload) {
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
      <div class="rp-modal vr-modal" role="dialog" aria-label="Match replay">
        <div class="rp-modal-head">
          <div>
            <h2>${title}</h2>
            <p class="rp-modal-sub">Replay · ${sub}</p>
          </div>
          <button class="rp-btn rp-close" title="Close (Esc)">✕ Close</button>
        </div>
        <div class="rp-modal-body"></div>
        <p class="rp-hint">← → step between board states · space play/pause · f fullscreen · the board is the site's own, replayed at its recorded size</p>
      </div>`;
    document.body.appendChild(back);
    document.body.classList.add("rp-modal-open");

    const ctl = mount(back.querySelector(".rp-modal-body"), match, payload);

    function close() {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("rp-modal-open");
      if (ctl) ctl.destroy();
      back.remove();
    }
    function onKey(e) {
      if (e.key === "Escape") {
        // One Escape does one thing: it leaves fullscreen, or it closes the
        // modal — never both, which would drop the user back on the dashboard
        // when all they asked for was the window back.
        if (ctl && ctl.escapeHandled()) { e.preventDefault(); return; }
        return close();
      }
      if (!ctl) return;
      if (e.key === "ArrowRight") { e.preventDefault(); ctl.next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); ctl.prev(); }
      else if (e.key === " ") { e.preventDefault(); ctl.togglePlay(); }
      else if (e.key === "Home") { e.preventDefault(); ctl.first(); }
      else if (e.key === "End") { e.preventDefault(); ctl.last(); }
      else if (e.key === "f" || e.key === "F") { e.preventDefault(); ctl.toggleFullscreen(); }
    }
    document.addEventListener("keydown", onKey);
    back.querySelector(".rp-close").addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    return close;
  }

  root.RATrackerVisualReplay = { mount, openModal, timeline };
})(typeof window !== "undefined" ? window : globalThis);
