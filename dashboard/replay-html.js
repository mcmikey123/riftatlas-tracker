/* Rift Atlas Stats Tracker - replay viewer chrome
 *
 * The dashboard's wrapper around the portable playback core: the shell markup,
 * the modal, fullscreen, and the keyboard. Everything that actually drives
 * rrweb lives in `replay/replay-core.js`, and the timeline arithmetic in
 * `replay/replay-timeline.js`, so the standalone share viewer can reuse both
 * without dragging the dashboard's markup along with them.
 *
 * This is the only replay there is: matches without a visual track have no
 * replay at all, and a capture that ran out of budget simply stops where it
 * stopped.
 */
(function (root) {
  "use strict";

  const { esc, fmtClock } = root.RATrackerFormat;
  const { MAX_CHIPS, SEEK, timeline, evenly, truncationText, targetOwnsKey } = root.RAReplayTimeline;

  /**
   * Escape is consumed by the browser to leave fullscreen, but not every engine
   * agrees on whether the page also sees the keydown. Any Escape this soon after
   * leaving fullscreen is treated as that one, so a single press never both
   * leaves fullscreen and closes the modal behind it.
   */
  const ESCAPE_GRACE_MS = 300;

  /**
   * Write the viewer's chrome into `container` and hand back every element the
   * transport controls touch. `chips` is the already-thinned chapter list.
   *
   * `withMoment` adds the "copy link to this moment" control and the empty
   * panel it works in. Both are rendered only when a caller supplied a handler:
   * turning a local replay into a link needs chrome.storage, the share
   * pipeline and the endpoint setting, none of which this file has or should
   * have, so a modal opened without one simply has no such button rather than a
   * dead one.
   */
  function renderShell(container, match, meta, marks, chips, withMoment) {
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
        ${
          withMoment
            ? `<button class="rp-btn vr-moment" title="Copy a link that opens this replay at the moment it is showing now">Copy link to this moment</button>`
            : ""
        }
      </div>
      ${withMoment ? '<div class="vr-share" aria-live="polite" hidden></div>' : ""}
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
      momentBtn: container.querySelector(".vr-moment"),
      momentPanel: container.querySelector(".vr-share"),
      chapterEls: container.querySelectorAll(".vr-chapter"),
    };
  }

  /**
   * Start the playback core inside the rendered shell and hook the controls,
   * the chapter chips and fullscreen up to it. Returns the controller the modal
   * drives, or null if the recording will not play; `destroy` is the teardown
   * for everything wired here and for the core underneath.
   */
  function wireControls(handles, meta, events, marks, chips, shareMoment) {
    const { container, slider, timeEl, playBtn, prevBtn, nextBtn, fullBtn, chapterEls } = handles;

    function paint(at, total) {
      slider.value = String(Math.round(at));
      timeEl.textContent = `${fmtClock(at)} / ${fmtClock(total)}`;
      let active = -1;
      chips.forEach((c, n) => {
        if (c.ms <= at + 1) active = n;
      });
      chapterEls.forEach((el, n) => el.classList.toggle("on", n === active));
    }

    const playback = root.RAReplayCore.create({
      stage: handles.stage,
      scaleEl: handles.scaleEl,
      events,
      meta,
      marks,
      autoplay: true,
      onTime: paint,
      onPlayState: (playing) => {
        playBtn.textContent = playing ? "❚❚" : "▶";
      },
    });
    if (!playback) return null;

    const total = playback.totalTime;
    slider.max = String(total);

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

    function isFull() {
      return document.fullscreenElement === shell;
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
      playback.refit();
      root.requestAnimationFrame(playback.refit);
    }

    playBtn.addEventListener("click", playback.togglePlay);
    prevBtn.addEventListener("click", () => playback.stepTo(-1));
    nextBtn.addEventListener("click", () => playback.stepTo(1));
    // `input` fires all the way through a drag, so the drag holds playback and
    // the end of the drag is what puts it back. The end is taken from the events
    // that always fire — never from `change`, which Gecko withholds when the
    // value lands back where the interaction started it.
    slider.addEventListener("input", () => playback.seek(parseInt(slider.value, 10) || 0, SEEK.DRAG));
    for (const type of root.RAReplayCore.DRAG_END_EVENTS) slider.addEventListener(type, playback.endDrag);
    container.addEventListener("click", (e) => {
      const ms = e.target?.dataset?.ms;
      if (ms !== undefined) playback.seek(parseInt(ms, 10) || 0, SEEK.CHAPTER);
    });
    // Wired directly rather than through the dashboard's document-level click
    // delegation: the handler needs the transport's position, which only this
    // closure holds, and a data attribute the document also listens for would
    // give the same click two owners.
    //
    // The position is read at the click, not when the handler finishes. A
    // first share has an upload in the middle of it, and the link is supposed
    // to name the moment the button was pressed, not the moment the network
    // came back.
    if (shareMoment && handles.momentBtn) {
      handles.momentBtn.addEventListener("click", () =>
        shareMoment({
          atMs: playback.getTime(),
          button: handles.momentBtn,
          panel: handles.momentPanel,
        })
      );
    }
    if (canFullscreen) {
      fullBtn.addEventListener("click", toggleFullscreen);
      document.addEventListener("fullscreenchange", onFullscreenChange);
      paintFullscreen();
    } else if (fullBtn) {
      // Nothing to toggle into; the button would only be a dead control.
      fullBtn.hidden = true;
    }

    return {
      next: () => playback.stepTo(1),
      prev: () => playback.stepTo(-1),
      first: () => playback.seek(0, SEEK.JUMP),
      last: () => playback.seek(total, SEEK.JUMP),
      togglePlay: playback.togglePlay,
      toggleFullscreen,
      escapeHandled,
      stop: playback.pause,
      destroy() {
        playback.pause();
        if (canFullscreen) {
          fullBtn.removeEventListener("click", toggleFullscreen);
          document.removeEventListener("fullscreenchange", onFullscreenChange);
          if (document.fullscreenElement === shell) leaveFullscreen();
        }
        shell.classList.remove("rp-full");
        playback.destroy();
      },
    };
  }

  /**
   * Mount a replay into `container`. Returns a controller, or null.
   *
   * `options.shareMoment({ atMs, button, panel })` is the dashboard's hook for
   * turning the current position into a link; see `renderShell`.
   */
  function mount(container, match, payload, options) {
    const shareMoment = (options && options.shareMoment) || null;
    const meta = (payload && payload.meta) || {};
    const events = (payload && payload.events) || [];
    if (events.length < 2) {
      container.innerHTML =
        '<p class="rp-empty">No recording was captured for this match.</p>';
      return null;
    }
    if (!root.RAReplayCore.available()) {
      container.innerHTML = '<p class="rp-empty">The replay engine failed to load.</p>';
      return null;
    }

    const marks = timeline(events);
    const chips = evenly(marks, MAX_CHIPS);

    const handles = renderShell(container, match, meta, marks, chips, !!shareMoment);
    const ctl = wireControls(handles, meta, events, marks, chips, shareMoment);
    if (!ctl) {
      container.innerHTML = '<p class="rp-empty">This recording could not be played back.</p>';
      return null;
    }
    return ctl;
  }

  /** Open the replay full-screen. `options` is passed straight to `mount`. */
  function openModal(match, payload, options) {
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

    const ctl = mount(back.querySelector(".rp-modal-body"), match, payload, options);

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
      // Escape is above this on purpose: it closes the modal from anywhere,
      // including from the share link's field, where it has nothing else to do.
      // Everything below moves the replay, and the moment panel puts a text
      // field and two buttons inside the modal that own those keys themselves.
      if (targetOwnsKey(e.target, e.key)) return;
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
