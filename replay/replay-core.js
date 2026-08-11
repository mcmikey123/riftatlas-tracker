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
 *
 * Seeking moves the position and leaves the play state alone: scrubbing or
 * jumping to a turn mid-playback keeps playing. Which seeks are exempt from
 * that, what a drag leaves latched behind it, and whether autoplay survives
 * `prefers-reduced-motion`, are decided by `seekOutcome`, `resumesAfterSeek`
 * and `shouldAutoplay` in replay-timeline.js, where they are pure and unit
 * tested rather than tangled up in rrweb.
 */
(function (root) {
  "use strict";

  const DEFAULT_VIEWPORT = { w: 1280, h: 800 };

  /**
   * The events a surface hands to `endDrag`, in one place so the two surfaces
   * cannot drift apart on it. All of them are no-ops unless a drag is actually
   * being held, so the transport hears one release however many of them fire.
   * `blur` and `keyup` are the backstops: a pointer release the slider itself
   * never sees, and the keys that move a range natively (Page Up / Page Down).
   * `change` is deliberately absent — see `endDrag`.
   */
  const DRAG_END_EVENTS = Object.freeze(["pointerup", "pointercancel", "blur", "keyup"]);

  /** True when the vendored replay engine loaded and can be constructed. */
  function available() {
    return !!(root.rrwebReplay && typeof root.rrwebReplay.Replayer === "function");
  }

  /**
   * True when the viewer has asked the platform for less motion. Guarded, and
   * the guard answers "yes": an embedder without matchMedia, or one that throws
   * on the query, leaves us unable to read the preference, and the two ways of
   * being wrong are not equal. Guessing "no motion wanted" costs a viewer one
   * click on the play button; guessing the other way starts motion at someone
   * who asked their whole system never to do that. The replay itself works
   * either way — only autoplay is at stake.
   */
  function reducedMotion() {
    try {
      if (!root.matchMedia) return true;
      return !!root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return true;
    }
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
   *   create({ stage, scaleEl, events, meta, marks, autoplay, startAtMs, onTime, onPlayState })
   *
   * `onTime(ms, totalMs)` fires while playing, on seek and at the end; the
   * total is passed alongside because the first fire happens during this call,
   * before the caller holds a controller to read it from. `onPlayState` fires
   * during this call too whenever autoplay wins, so neither callback may reach
   * for the controller create() has not returned yet.
   *
   * `autoplay` is off unless a surface asks for it: a core that started playing
   * on its own would be a surprise to any caller that mounts a replay somewhere
   * it is not the thing the viewer just opened.
   *
   * `startAtMs` opens somewhere other than the beginning — a share link that
   * names a moment is the reason it exists. It is clamped to the recording, and
   * it suppresses autoplay: someone sent that link to say "look at this", and
   * playing on from it walks off the thing being pointed at. Passing `0` still
   * counts as naming a moment; pass `null` or omit `startAtMs` entirely to mean
   * "no moment given" — the share viewer passes an explicit `null` for a link
   * without a timestamp, and the dashboard omits it. It can only ever suppress
   * autoplay, never grant it, so a timestamped
   * link is still no way around `prefers-reduced-motion`.
   */
  function create(options) {
    const { quantise, timeline, SEEK, seekOutcome, startPosition, shouldAutoplay } = root.RAReplayTimeline;

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
    // The play state the caller has been told about, so a seek that pauses the
    // engine for a few milliseconds and resumes it does not flicker the glyph.
    let announced = false;
    // A drag fires `input` continuously. Each one holds playback; this remembers
    // that it was running so `endDrag` can put it back, since by then `playing`
    // is long since false. Only ever assigned from `seekOutcome`, so there is no
    // path that moves the transport and forgets the latch.
    let heldForDrag = false;
    // The transport ran to the end on its own. Distinct from being paused there:
    // seeking back into the replay resumes, where seeking after a deliberate
    // pause does not.
    let finished = false;

    /** Refit, but never after teardown — deferred fits outlive the modal. */
    function refit() {
      if (dead) return;
      fit();
    }

    function emit() {
      onTime(at, total);
    }

    function announce(next) {
      if (next === announced) return;
      announced = next;
      onPlayState(next);
    }

    function track() {
      if (!playing) return;
      at = Math.min(total, replayer.getCurrentTime());
      emit();
      raf = root.requestAnimationFrame(track);
    }

    /**
     * Stop the engine. `quiet` withholds the play-state notification, for the
     * one case where the transport is about to be started again in the same
     * turn and the caller would otherwise flicker its play glyph.
     */
    function halt(quiet) {
      // Any stop settles the drag: a viewer who hits pause mid-drag meant it,
      // and releasing the slider must not undo that.
      heldForDrag = false;
      if (playing) {
        playing = false;
        if (raf) root.cancelAnimationFrame(raf);
        raf = null;
        replayer.pause();
      }
      // Announced even when the engine was already stopped: a held drag shows
      // the playing glyph, and dropping the latch has to take it back down.
      // `announce` dedupes, so the ordinary already-paused stop says nothing.
      if (!quiet) announce(false);
    }

    function stop() {
      halt(false);
    }

    /** Run from wherever `at` is. Never restarts; togglePlay owns that. */
    function start() {
      if (playing) return;
      playing = true;
      finished = false;
      announce(true);
      replayer.play(at);
      raf = root.requestAnimationFrame(track);
    }

    /**
     * Move to `ms`, for the stated reason. The engine is always stopped first —
     * rrweb is told a position by being (re)started at it, never mid-run — and
     * then either left paused there or started again from it, which is the
     * resume policy's call rather than the caller's.
     */
    function seek(ms, reason) {
      const target = Math.max(0, Math.min(total, ms));
      const next = seekOutcome({ playing, held: heldForDrag, finished, reason, ms: target, total });
      // Quiet whenever the transport is coming back, either now or when the drag
      // holding it ends: a click on the slider track is an `input` and a release
      // a few milliseconds apart, and the play glyph must not blink in between.
      halt(next.resume || next.held);
      at = target;
      finished = false;
      // After halt(), which settles any drag in flight.
      heldForDrag = next.held;
      if (next.resume) {
        start();
      } else {
        replayer.pause(at);
      }
      emit();
    }

    /**
     * The drag is over, wherever the last `input` left the position.
     *
     * Surfaces call this from every event in DRAG_END_EVENTS, all of which
     * always fire. `change` does not: Gecko fires it only when the value differs
     * from the one the interaction started on, so dragging away and back, or
     * cancelling with Escape, used to leave the latch set for some later seek to
     * act on. A no-op unless a drag is actually pending, which is what lets it
     * be wired to all of those events at once.
     */
    function endDrag() {
      if (!heldForDrag) return;
      const next = seekOutcome({ playing, held: true, finished, reason: SEEK.SCRUB, ms: at, total });
      heldForDrag = next.held;
      if (next.resume) start();
      else announce(false); // released at the very end: the glyph goes back to ▶
    }

    function togglePlay() {
      // The latch counts as playing: while a drag holds the transport the glyph
      // reads ❚❚, so space has to mean pause.
      if (playing || heldForDrag) return stop();
      if (at >= total) at = 0;
      start();
    }

    /** Stepping is "hold still and look at this one", so it always pauses. */
    function stepTo(dir) {
      const next = dir > 0 ? stops.find((ms) => ms > at + 1) : [...stops].reverse().find((ms) => ms < at - 1);
      seek(next == null ? (dir > 0 ? total : 0) : next, SEEK.STEP);
    }

    replayer.on("resize", () => {
      pin();
      refit();
    });
    replayer.on("finish", () => {
      at = total;
      // Stopped because it ran out, not because the viewer asked it to.
      finished = true;
      stop();
      emit();
    });

    const onResize = () => refit();
    root.addEventListener("resize", onResize);

    pin();
    fit();
    at = startPosition(options.startAtMs, total);
    // Branched rather than "seek to the start, then maybe play": pausing at a
    // position and then playing from it makes rrweb build the full snapshot
    // twice, and each build is a visible flash of the board.
    if (shouldAutoplay(options.autoplay, reducedMotion(), options.startAtMs != null)) start();
    else replayer.pause(at);
    emit();

    return {
      totalTime: total,
      marks,
      getTime: () => at,
      isPlaying: () => playing,
      seek,
      endDrag,
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
  // rrweb and the DOM all the way down; the transport's decisions live in
  // replay-timeline.js, where they are pure and covered.
  // viewportOf and DEFAULT_VIEWPORT stay internal: pinning is create()'s own
  // business, and nothing outside this file has ever needed to ask.
  const api = { available, create, DRAG_END_EVENTS };

  root.RAReplayCore = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
