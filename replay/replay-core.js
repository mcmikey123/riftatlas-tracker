/* Rift Atlas Stats Tracker - replay playback core
 *
 * Owns the rrweb Replayer: mounting it, keeping it at the size it was recorded
 * at, and driving the transport (play, pause, seek, step). It knows nothing
 * about the chrome around it — no markup, no CSS class names, no clock
 * formatting, no extension APIs — because the dashboard modal and the
 * standalone share viewer both drive it and only the second one is a plain
 * https page.
 *
 * The replayer is mounted at exactly the viewport it was recorded at and
 * scaled to fit with a CSS transform: replaying at a different width fires
 * different media queries, which is the drift this whole feature removes.
 * rrweb builds its own sandbox="allow-same-origin" iframe with scripting off,
 * so opponent-controlled strings stay inert; nothing here re-enables scripts.
 *
 * Position updates are pushed to the caller rather than polled: `onTime` fires
 * on every frame while playing and on every seek, `onPlayState` whenever the
 * transport starts or stops.
 */
(function (root) {
  "use strict";

  const DEFAULT_VIEWPORT = { w: 1280, h: 800 };

  /** True when the vendored replay engine loaded and can be constructed. */
  function available() {
    return !!(root.rrwebReplay && typeof root.rrwebReplay.Replayer === "function");
  }

  /** The viewport a recording must be pinned to, from its stored meta. */
  function viewportOf(meta) {
    const vp = (meta && meta.viewport) || DEFAULT_VIEWPORT;
    return {
      w: Math.max(1, Math.round(Number(vp.w) || DEFAULT_VIEWPORT.w)),
      h: Math.max(1, Math.round(Number(vp.h) || DEFAULT_VIEWPORT.h)),
    };
  }

  /**
   * Mount `events` into `scaleEl` and hand back the transport. `stage` is the
   * box the board is fitted into; `scaleEl` is the child that gets the
   * transform. `marks` are the settled board states to step between, defaulting
   * to the ones the timeline finds. Returns null if the recording will not play
   * at all — the caller owns whatever it wants to say about that.
   *
   *   create({ stage, scaleEl, events, meta, marks, onTime, onPlayState })
   *
   * `onTime(ms, totalMs)` fires while playing, on seek and at the end; the
   * total is passed alongside because the first fire happens during this call,
   * before the caller holds a controller to read it from.
   */
  function create(options) {
    const { quantise, timeline } = root.RAReplayTimeline;

    const stage = options.stage;
    const scaleEl = options.scaleEl;
    const events = options.events;
    const marks = options.marks || timeline(events);
    const onTime = options.onTime || function () {};
    const onPlayState = options.onPlayState || function () {};
    const viewport = viewportOf(options.meta);
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

    const total = Math.max(1, replayer.getMetaData().totalTime || 0);

    // Board states we step between: every keyframe, bounded by both ends.
    const stops = [...new Set([0, ...marks.map((m) => m.ms), total])]
      .filter((ms) => ms >= 0 && ms <= total)
      .sort((a, b) => a - b);

    let playing = false;
    let raf = null;
    let at = 0;
    let dead = false;

    /** Refit, but never after teardown — deferred fits outlive the modal. */
    function refit() {
      if (dead) return;
      fit();
    }

    function emit() {
      onTime(at, total);
    }

    function track() {
      if (!playing) return;
      at = Math.min(total, replayer.getCurrentTime());
      emit();
      raf = root.requestAnimationFrame(track);
    }

    function stop() {
      if (!playing) return;
      playing = false;
      if (raf) root.cancelAnimationFrame(raf);
      raf = null;
      replayer.pause();
      onPlayState(false);
    }

    function seek(ms) {
      stop();
      at = Math.max(0, Math.min(total, ms));
      replayer.pause(at);
      emit();
    }

    function togglePlay() {
      if (playing) return stop();
      if (at >= total) at = 0;
      playing = true;
      onPlayState(true);
      replayer.play(at);
      raf = root.requestAnimationFrame(track);
    }

    function stepTo(dir) {
      const next = dir > 0 ? stops.find((ms) => ms > at + 1) : [...stops].reverse().find((ms) => ms < at - 1);
      seek(next == null ? (dir > 0 ? total : 0) : next);
    }

    replayer.on("resize", () => {
      pin();
      refit();
    });
    replayer.on("finish", () => {
      at = total;
      stop();
      emit();
    });

    const onResize = () => refit();
    root.addEventListener("resize", onResize);

    pin();
    fit();
    seek(0);

    return {
      totalTime: total,
      marks,
      getTime: () => at,
      isPlaying: () => playing,
      seek,
      play() {
        if (!playing) togglePlay();
      },
      pause: stop,
      togglePlay,
      stepTo,
      refit,
      destroy() {
        dead = true;
        stop();
        root.removeEventListener("resize", onResize);
        try {
          replayer.destroy();
        } catch (_) { /* already torn down with the page around it */ }
      },
    };
  }

  // Same dual export as store/css-assets.js: a global for the browser, CommonJS
  // so tooling can load the file. There is nothing here to unit test — it is
  // rrweb and the DOM all the way down.
  // viewportOf and DEFAULT_VIEWPORT stay internal: pinning is create()'s own
  // business, and nothing outside this file has ever needed to ask.
  const api = { available, create };

  root.RAReplayCore = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
